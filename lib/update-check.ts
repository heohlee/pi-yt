import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpawnFn } from "./youtube-source.ts";

// Is there a newer yt-dlp for the managed copy (S23)? Asks GitHub at most once a day,
// remembers the answer in a tiny state file, and never throws or blocks: any failure means "no".

export const RELEASES_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 5000;
export const VERSION_TIMEOUT_MS = 5000;

const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;

/** `${XDG_STATE_HOME:-~/.local/state}/pi-yt/update.json`; a relative XDG_STATE_HOME is ignored. */
export function updateStatePath({ home, env = process.env }: { home: string; env?: NodeJS.ProcessEnv }): string {
	const xdg = env.XDG_STATE_HOME;
	const state = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "state");
	return path.join(state, "pi-yt", "update.json");
}

/** Whether yt-dlp version `a` is newer than `b` (dates like 2026.10.26, optionally .N). */
export function newerVersion(a: string, b: string): boolean {
	if (!VERSION.test(a) || !VERSION.test(b)) return false;
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}

const defaultSpawn: SpawnFn = (command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });

/** `<path> --version`, or null when it fails, prints something else or takes over 5 s. */
export function ytDlpVersion(opts: { path: string; spawn?: SpawnFn; timeoutMs?: number }): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		let out = "";
		let child: ReturnType<SpawnFn>;
		let timer: NodeJS.Timeout | undefined;
		const finish = (version: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(version);
		};
		try {
			child = (opts.spawn ?? defaultSpawn)(opts.path, ["--version"]);
		} catch {
			finish(null);
			return;
		}
		timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
			finish(null);
		}, opts.timeoutMs ?? VERSION_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (out.length < 256) out += chunk.toString("utf8");
		});
		child.stderr?.resume();
		child.on("error", () => finish(null));
		child.on("close", (code) => {
			const version = out.trim().split(/\r?\n/)[0] ?? "";
			finish(code === 0 && VERSION.test(version) ? version : null);
		});
	});
}

interface UpdateState {
	checkedAt: number;
	latest: string | null;
}

async function readState(file: string): Promise<UpdateState | null> {
	try {
		const data = JSON.parse(await readFile(file, "utf8")) as Partial<UpdateState>;
		if (typeof data.checkedAt !== "number" || !Number.isFinite(data.checkedAt)) return null;
		return {
			checkedAt: data.checkedAt,
			latest: typeof data.latest === "string" && VERSION.test(data.latest) ? data.latest : null,
		};
	} catch {
		return null;
	}
}

async function writeState(file: string, state: UpdateState): Promise<void> {
	try {
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		await chmod(file, 0o600);
	} catch {
		// Not remembered: the next /yt asks again.
	}
}

/** The latest release tag from GitHub, or null on any failure or after `timeoutMs`. */
async function fetchLatest(fetchFn: typeof globalThis.fetch, timeoutMs: number): Promise<string | null> {
	try {
		const response = await fetchFn(RELEASES_URL, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-yt" },
		});
		if (!response.ok) return null;
		const tag = ((await response.json()) as { tag_name?: unknown } | null)?.tag_name;
		return typeof tag === "string" && VERSION.test(tag) ? tag : null;
	} catch {
		return null;
	}
}

export interface UpdateCheckOptions {
	home: string;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	/** The managed copy's version (see ytDlpVersion), asked only when a latest release is known. */
	currentVersion: () => Promise<string | null>;
	timeoutMs?: number;
}

/** `{ latest, current }` when a newer yt-dlp than the managed copy exists, else null. Never throws. */
export async function checkYtDlpUpdate(opts: UpdateCheckOptions): Promise<{ latest: string; current: string } | null> {
	try {
		const now = (opts.now ?? Date.now)();
		const file = updateStatePath({ home: opts.home, env: opts.env });
		const saved = await readState(file);
		let latest: string | null;
		if (saved && now - saved.checkedAt >= 0 && now - saved.checkedAt < UPDATE_CHECK_INTERVAL_MS) latest = saved.latest;
		else {
			latest = await fetchLatest(opts.fetch ?? globalThis.fetch, opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);
			// A failed check counts too, so an offline machine asks once a day at most.
			await writeState(file, { checkedAt: now, latest });
		}
		if (!latest) return null;
		const current = await opts.currentVersion();
		return current && newerVersion(latest, current) ? { latest, current } : null;
	} catch {
		return null;
	}
}
