import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { browserLabel, cookieArg } from "./browsers.ts";
import type { Account } from "./config.ts";
import { findExecutable, jsRuntimeArgs } from "./tools.ts";

// yt-dlp reads the browser cookies itself via --cookies-from-browser; this
// module only passes the browser name and profile and never touches cookies.

export const TIMEOUT_MS = 30_000;
export const PAGE_SIZE = 50;
const DETAIL_MAX = 200;

export interface Track {
	id: string;
	title: string;
	artist: string | null;
	duration: number | null;
	url: string;
}

export interface Playlist {
	id: string;
	title: string;
	count: number | null;
}

export type SourceErrorKind = "signin" | "missing" | "extract" | "network";

export interface SourceError {
	kind: SourceErrorKind;
	message: string;
	hint: string;
	/** Short first stderr line, for diagnostics only; never shown as the message. */
	detail?: string;
}

export type Failure = { ok: false; error: SourceError };
/** `hasMore` is set for paged lists: true when the page came back full. */
export type TracksResult = { ok: true; tracks: Track[]; hasMore?: boolean } | Failure;
export type PlaylistsResult = { ok: true; playlists: Playlist[] } | Failure;
export type VerifyResult = { ok: true } | Failure;

export type SourceKind = "liked" | "later" | "recommended" | "history";

const SOURCE_TARGETS: Record<SourceKind, string> = {
	liked: ":ytfav",
	later: ":ytwatchlater",
	recommended: ":ytrec",
	history: ":ythistory",
};

interface ChildLike {
	stdout: Readable | null;
	stderr: Readable | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type SpawnFn = (command: string, args: string[]) => ChildLike;

export interface SourceOptions {
	account?: Account | null;
	spawn?: SpawnFn;
	ytDlpPath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

export interface PageOptions {
	/** 1-based index of the first entry. */
	start?: number;
	pageSize?: number;
}

const defaultSpawn: SpawnFn = (command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

const fail = (error: SourceError): Failure => ({ ok: false, error });

const CANCELLED: SourceError = { kind: "extract", message: "cancelled", hint: "" };
const MISSING: SourceError = {
	kind: "missing",
	message: "yt-dlp not found",
	hint: "Install it: sudo pacman -S yt-dlp (or pipx install yt-dlp)",
};
const NO_ACCOUNT: SourceError = {
	kind: "signin",
	message: "No YouTube account connected.",
	hint: "Connect a browser session in /yt, then retry.",
};
const NETWORK_MESSAGE = "Could not reach YouTube.";
const EXTRACT_MESSAGE = "yt-dlp could not read YouTube.";
const EXTRACT_HINT = "Update yt-dlp (yt-dlp -U or your package manager) and retry.";

function signinError(account: Account | null | undefined): SourceError {
	if (!account) return { ...NO_ACCOUNT };
	const label = browserLabel(account.browser);
	return {
		kind: "signin",
		message: `YouTube session not found in ${label}.`,
		// yt-dlp -J hides Helium's decrypt warnings, so a missing keyring key also lands here.
		hint:
			account.browser === "helium"
				? "Sign in at youtube.com in Helium, or unlock your system keyring, then retry."
				: `Sign in at youtube.com in ${label}, then retry.`,
	};
}

function firstLine(stderr: string): string | undefined {
	const line = stderr
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find(Boolean);
	return line ? line.slice(0, DETAIL_MAX) : undefined;
}

function classify(stderr: string, account: Account | null | undefined): SourceError {
	let error: SourceError;
	// yt-dlp reads Helium as Chromium; its Linux keyring entry is unverified, so decryption may fail.
	if (account?.browser === "helium" && /could not be decrypted|failed to decrypt|keyring/i.test(stderr)) {
		error = {
			kind: "signin",
			message: "Could not decrypt Helium's cookies.",
			hint: "Unlock your system keyring, or try another browser.",
		};
	} else if (/sign in|login required|cookies|not available for this account|private/i.test(stderr)) {
		error = signinError(account);
	} else if (/unable to download|network|timed out|resolve host/i.test(stderr)) {
		error = { kind: "network", message: NETWORK_MESSAGE, hint: "Check your connection and retry." };
	} else {
		error = { kind: "extract", message: EXTRACT_MESSAGE, hint: EXTRACT_HINT };
	}
	const detail = firstLine(stderr);
	return detail ? { ...error, detail } : error;
}

type RunResult = { ok: true; data: unknown } | Failure;

function runYtDlp(target: string, extra: string[], opts: SourceOptions): Promise<RunResult> {
	const args = ["--flat-playlist", "-J", "--no-warnings", ...jsRuntimeArgs()];
	if (opts.account) args.push("--cookies-from-browser", cookieArg({ id: opts.account.browser, profile: opts.account.profile }));
	args.push(...extra, target);

	if (opts.signal?.aborted) return Promise.resolve(fail({ ...CANCELLED }));

	const spawn = opts.spawn ?? defaultSpawn;
	const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = opts.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let child: ChildLike;
		let timer: unknown;

		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimer(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const kill = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
		};
		const onAbort = () => {
			if (settled) return;
			kill();
			finish(fail({ ...CANCELLED }));
		};

		try {
			child = spawn(opts.ytDlpPath ?? "yt-dlp", args);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			finish(fail(code === "ENOENT" ? { ...MISSING } : classify("", opts.account)));
			return;
		}

		opts.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimer(() => {
			if (settled) return;
			kill();
			finish(
				fail({
					kind: "network",
					message: NETWORK_MESSAGE,
					hint: "yt-dlp took too long; check your connection and retry.",
				}),
			);
		}, opts.timeoutMs ?? TIMEOUT_MS);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			finish(fail(error.code === "ENOENT" ? { ...MISSING } : classify(stderr, opts.account)));
		});
		child.on("close", (code) => {
			if (code !== 0) {
				finish(fail(classify(stderr, opts.account)));
				return;
			}
			try {
				finish({ ok: true, data: JSON.parse(stdout) });
			} catch {
				finish(fail({ kind: "extract", message: EXTRACT_MESSAGE, hint: EXTRACT_HINT }));
			}
		});
	});
}

function entriesOf(data: unknown): Record<string, unknown>[] {
	const entries = (data as { entries?: unknown } | null)?.entries;
	if (!Array.isArray(entries)) return [];
	return entries.filter(
		(e): e is Record<string, unknown> =>
			!!e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string" && !!(e as { id: string }).id,
	);
}

/**
 * Only plain videos play as tracks. YouTube Mixes ("RD…" lists), playlists and channels come back as entries too,
 * flagged by a non-video `ie_key`, `_type: "playlist"` or a `list=` URL; lists skip them (S22).
 */
function isVideo(entry: Record<string, unknown>): boolean {
	if (entry._type === "playlist") return false;
	if (typeof entry.ie_key === "string" && entry.ie_key !== "Youtube") return false;
	return !(typeof entry.url === "string" && /[?&]list=/.test(entry.url));
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function toTrack(entry: Record<string, unknown>): Track {
	const id = entry.id as string;
	return {
		id,
		title: text(entry.title) ?? "Untitled",
		artist: text(entry.channel) ?? text(entry.uploader),
		duration: num(entry.duration),
		url: `https://www.youtube.com/watch?v=${id}`,
	};
}

async function listTracks(target: string, opts: SourceOptions): Promise<TracksResult> {
	const result = await runYtDlp(target, [], opts);
	if (!result.ok) return result;
	return { ok: true, tracks: entriesOf(result.data).filter(isVideo).map(toTrack) };
}

async function listPage(target: string, opts: SourceOptions & PageOptions): Promise<TracksResult> {
	const { start = 1, pageSize = PAGE_SIZE } = opts;
	const page = ["--playlist-start", String(start), "--playlist-end", String(start + pageSize - 1)];
	const result = await runYtDlp(target, page, opts);
	if (!result.ok) return result;
	const entries = entriesOf(result.data);
	// hasMore counts what yt-dlp returned, so skipping Mixes never hides Load more.
	return { ok: true, tracks: entries.filter(isVideo).map(toTrack), hasMore: entries.length === pageSize };
}

export function listSource(kind: SourceKind, opts: SourceOptions & PageOptions = {}): Promise<TracksResult> {
	if (!opts.account) return Promise.resolve(fail(signinError(null)));
	return listPage(SOURCE_TARGETS[kind], opts);
}

export async function listPlaylists(opts: SourceOptions = {}): Promise<PlaylistsResult> {
	if (!opts.account) return fail(signinError(null));
	const result = await runYtDlp("https://www.youtube.com/feed/playlists", [], opts);
	if (!result.ok) return result;
	return {
		ok: true,
		playlists: entriesOf(result.data).map((entry) => ({
			id: entry.id as string,
			title: text(entry.title) ?? "Untitled",
			count: num(entry.playlist_count),
		})),
	};
}

export function listPlaylist(id: string, opts: SourceOptions & PageOptions = {}): Promise<TracksResult> {
	return listPage(`https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`, opts);
}

export function search(query: string, opts: SourceOptions & { limit?: number } = {}): Promise<TracksResult> {
	return listTracks(`ytsearch${opts.limit ?? 20}:${query}`, opts);
}

export async function verifySession(account: Account, opts: SourceOptions = {}): Promise<VerifyResult> {
	const result = await runYtDlp(SOURCE_TARGETS.liked, ["--playlist-end", "1"], { ...opts, account });
	return result.ok ? { ok: true } : result;
}

export async function checkDeps({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<{
	mpv: boolean;
	ytDlp: boolean;
}> {
	const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const [mpv, ytDlp] = await Promise.all([findExecutable("mpv", dirs), findExecutable("yt-dlp", dirs)]);
	return { mpv: mpv !== null, ytDlp: ytDlp !== null };
}
