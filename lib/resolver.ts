import { spawn as nodeSpawn } from "node:child_process";
import { browserLabel } from "./browsers.ts";
import type { Account } from "./config.ts";
import { jsRuntimeArgs } from "./tools.ts";
import type { SourceError, SpawnFn, Track } from "./youtube-source.ts";

// Asks yt-dlp for a track's audio stream URL so mpv can play it without its
// ytdl hook. yt-dlp reads the browser cookies itself; stderr is only classified.

export const RESOLVE_TIMEOUT_MS = 20_000;
/** A fresh stream link answers 403 for about 2 s; how long to wait for it and how often to ask. */
export const READY_TIMEOUT_MS = 5000;
export const READY_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 2000;
/** After a bot check or a refused client, that strategy is skipped for every track this long (per account). */
export const STRATEGY_COOLDOWN_MS = 10 * 60 * 1000;
/** Video failures in a row that turn a strategy off like a block. */
export const VIDEO_STREAK_LIMIT = 3;

const FORMAT = ["-f", "bestaudio/best", "-g", "--no-warnings"];

/**
 * The ways to ask yt-dlp for a link, fastest first; each runs with FORMAT, the JS runtime and the cookie arg.
 * visionos skips the watch page and HLS, and its links play at once (about 1.7 s instead of 3 s plus a 2 s 403 window).
 * The full resolve is the last one, and when it fails mpv's own ytdl hook gets the watch URL.
 */
export const STRATEGIES: readonly { name: string; args: readonly string[]; cookies: boolean }[] = [
	// yt-dlp's visionos client does not support cookies (it is dropped when signed in), so it always runs without
	// them; public tracks still resolve fast, and private or age-restricted ones fall to the full resolve with cookies.
	{ name: "visionos", args: ["--extractor-args", "youtube:player_client=visionos;skip=hls"], cookies: false },
	{ name: "full", args: [], cookies: true },
];

/** Why a strategy failed: YouTube refused this client (bot check, rate limit), something about this video, or anything else. */
export type FailureClass = "blocked" | "video" | "other";

export type ResolveError = Pick<SourceError, "kind" | "message" | "hint">;
export type ResolveResult = { ok: true; url: string } | { ok: false; error: ResolveError };

export interface ResolveOptions {
	account?: Account | null;
	/** Browser spec for `--cookies-from-browser`, the same value mpv gets. */
	cookieArg?: string;
	spawn?: SpawnFn;
	/** The resolved yt-dlp (system or managed); defaults to `yt-dlp` on PATH. */
	ytDlpPath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** HTTP status of a tiny request for the link; without it the link is returned at once. */
	probe?: (url: string, signal: AbortSignal) => Promise<number>;
	pollMs?: number;
	readyTimeoutMs?: number;
	/**
	 * When each strategy was last blocked, per account (cookieArg, "" without one); shared by every resolve.
	 * A blocked strategy is skipped for STRATEGY_COOLDOWN_MS, except the last one, which nothing replaces.
	 */
	cooldowns?: Map<string, number>;
	now?: () => number;
}

const defaultSpawn: SpawnFn = (command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

const CANCELLED: ResolveError = { kind: "extract", message: "cancelled", hint: "" };
const MISSING: ResolveError = {
	kind: "missing",
	message: "yt-dlp not found",
	hint: "Install it: sudo pacman -S yt-dlp (or pipx install yt-dlp)",
};
const EXTRACT: ResolveError = {
	kind: "extract",
	message: "yt-dlp could not read YouTube.",
	hint: "Update yt-dlp (yt-dlp -U or your package manager) and retry.",
};
const NETWORK: ResolveError = {
	kind: "network",
	message: "Could not reach YouTube.",
	hint: "Check your connection and retry.",
};
// A bot check or rate limit: the session and the connection are fine, YouTube refuses this client for a while.
const BLOCKED: ResolveError = {
	kind: "network",
	message: "YouTube is limiting requests right now.",
	hint: "Wait a few minutes, then retry.",
};

function classify(stderr: string, account: Account | null | undefined): ResolveError {
	if (/sign in|login required|cookies|not available for this account|private/i.test(stderr)) {
		if (!account)
			return {
				kind: "signin",
				message: "No YouTube account connected.",
				hint: "Connect a browser session in /yt, then retry.",
			};
		const label = browserLabel(account.browser);
		return {
			kind: "signin",
			message: `YouTube session not found in ${label}.`,
			hint: `Sign in at youtube.com in ${label}, then retry.`,
		};
	}
	if (/unable to download|network|timed out|resolve host/i.test(stderr)) return { ...NETWORK };
	return { ...EXTRACT };
}

// "Sign in to confirm your age" is about the video, while "Sign in to confirm you're not a bot" is about the client.
const VIDEO_FAILURE =
	/confirm your age|age[- ]restricted|inappropriate for some users|members[- ]only|join this channel|private video|live event|is live|premieres? in|requested format is not available|video unavailable|video is unavailable|has been removed|not available in your country/i;
const BLOCKED_FAILURE =
	/sign in to confirm|not a bot|http error 429|too many requests|po token|page needs to be reloaded|not available on this app|precondition check failed|rate-limited|try again later/i;

/** Classify a failed run from its stderr; stderr itself never leaves this module. */
function classifyFailure(stderr: string): FailureClass {
	if (/confirm your age/i.test(stderr)) return "video";
	if (BLOCKED_FAILURE.test(stderr)) return "blocked";
	return VIDEO_FAILURE.test(stderr) ? "video" : "other";
}

function streamUrl(stdout: string): string | undefined {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.startsWith("https://"));
}

type Attempt = { result: ResolveResult; failure?: FailureClass };

function attempt(track: Track, extra: readonly string[], opts: ResolveOptions, cookies = true): Promise<Attempt> {
	const args = [...FORMAT, ...jsRuntimeArgs(), ...extra];
	if (cookies && opts.cookieArg) args.push("--cookies-from-browser", opts.cookieArg);
	args.push(track.url);

	if (opts.signal?.aborted) return Promise.resolve({ result: { ok: false, error: { ...CANCELLED } } });

	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let child: ReturnType<SpawnFn>;
		let timer: NodeJS.Timeout | undefined;

		const finish = (result: ResolveResult, failure?: FailureClass) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ result, failure: result.ok ? undefined : (failure ?? "other") });
		};
		const kill = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
		};
		const onAbort = () => {
			kill();
			finish({ ok: false, error: { ...CANCELLED } });
		};

		try {
			child = (opts.spawn ?? defaultSpawn)(opts.ytDlpPath ?? "yt-dlp", args);
		} catch (error) {
			finish({
				ok: false,
				error: (error as NodeJS.ErrnoException).code === "ENOENT" ? { ...MISSING } : { ...EXTRACT },
			});
			return;
		}

		opts.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			kill();
			finish({ ok: false, error: { ...NETWORK } });
		}, opts.timeoutMs ?? RESOLVE_TIMEOUT_MS);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			finish({ ok: false, error: error.code === "ENOENT" ? { ...MISSING } : classify(stderr, opts.account) });
		});
		child.on("close", (code) => {
			if (code !== 0) {
				const failure = classifyFailure(stderr);
				finish({ ok: false, error: failure === "blocked" ? { ...BLOCKED } : classify(stderr, opts.account) }, failure);
				return;
			}
			const url = streamUrl(stdout);
			finish(url ? { ok: true, url } : { ok: false, error: { ...EXTRACT } });
		});
	});
}

/** Asks for the first byte of a stream link, without cookies, and returns the HTTP status. */
export async function probeStream(url: string, signal: AbortSignal): Promise<number> {
	// Only YouTube's https stream links; a redirect is an answer, never followed.
	if (!url.startsWith("https://")) return 0;
	const response = await fetch(url, {
		headers: { Range: "bytes=0-0" },
		redirect: "manual",
		signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
	});
	await response.body?.cancel();
	return response.status;
}

const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});

/**
 * Wait while the link still answers 403, so mpv does not give up on it and skip the track.
 * Any other answer, an error or the time limit hands it to mpv, which retries a 403 itself.
 */
async function untilReady(url: string, opts: ResolveOptions): Promise<ResolveResult> {
	const probe = opts.probe;
	if (!probe) return { ok: true, url };
	const signal = opts.signal ?? new AbortController().signal;
	const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
	while (!signal.aborted) {
		const left = deadline - Date.now();
		if (left <= 0) return { ok: true, url };
		let status: number | undefined;
		try {
			// Each probe only gets the time that is left, so the whole wait stays within the limit.
			status = await probe(url, AbortSignal.any([signal, AbortSignal.timeout(left)]));
		} catch {
			// Unreachable or out of time; mpv may still manage.
		}
		if (signal.aborted) break;
		if (status !== 403 || Date.now() >= deadline) return { ok: true, url };
		await pause(Math.min(opts.pollMs ?? READY_POLL_MS, Math.max(0, deadline - Date.now())), signal);
	}
	return { ok: false, error: { ...CANCELLED } };
}

const cooldownKey = (strategy: string, cookieArg: string | undefined) => JSON.stringify([strategy, cookieArg ?? ""]);

/** Whether any strategy was blocked for this account within STRATEGY_COOLDOWN_MS; background work waits then. */
export function blockedRecently(
	cooldowns: Map<string, number>,
	cookieArg: string | undefined,
	now: () => number = Date.now,
): boolean {
	return STRATEGIES.some(({ name }) => {
		const at = cooldowns.get(cooldownKey(name, cookieArg));
		return at !== undefined && now() - at < STRATEGY_COOLDOWN_MS;
	});
}

/**
 * Resolve a track's audio stream URL, trying each of STRATEGIES in order until one gives a link.
 * A blocked strategy is skipped for every track for STRATEGY_COOLDOWN_MS; a video failure only moves this track on.
 * When all fail, the last strategy's error comes back and the caller leaves the track to mpv's hook.
 */
export async function resolveAudio(track: Track, opts: ResolveOptions = {}): Promise<ResolveResult> {
	const now = opts.now ?? Date.now;
	let result: ResolveResult = { ok: false, error: { ...EXTRACT } };
	for (const [i, strategy] of STRATEGIES.entries()) {
		const key = cooldownKey(strategy.name, opts.cookieArg);
		const blockedAt = opts.cooldowns?.get(key);
		const last = i === STRATEGIES.length - 1;
		if (!last && blockedAt !== undefined && now() - blockedAt < STRATEGY_COOLDOWN_MS) continue;
		const run = await attempt(track, strategy.args, opts, strategy.cookies);
		result = run.result;
		const streak = `${key}#video`;
		if (result.ok) {
			opts.cooldowns?.delete(streak);
			return untilReady(result.url, opts);
		}
		if (run.failure === "blocked") {
			// The block turns the strategy off by itself; the failures before it start over afterwards.
			opts.cooldowns?.set(key, now());
			opts.cooldowns?.delete(streak);
		}
		// A hidden block (e.g. a PO token requirement) can surface as "format not available" on every video:
		// VIDEO_STREAK_LIMIT video or other failures in a row count as a block, so the worst case stays as before.
		if (
			(run.failure === "video" || run.failure === "other") &&
			!last &&
			opts.cooldowns &&
			result.error.kind !== "missing" &&
			!opts.signal?.aborted
		) {
			const count = (opts.cooldowns.get(streak) ?? 0) + 1;
			if (count >= VIDEO_STREAK_LIMIT) {
				opts.cooldowns.set(key, now());
				opts.cooldowns.delete(streak);
			} else opts.cooldowns.set(streak, count);
		}
		// Another strategy cannot help when yt-dlp is missing or the caller gave up.
		if (result.error.kind === "missing" || opts.signal?.aborted) return result;
	}
	return result;
}
