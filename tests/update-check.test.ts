import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	checkYtDlpUpdate,
	newerVersion,
	RELEASES_URL,
	updateStatePath,
	UPDATE_CHECK_INTERVAL_MS,
	ytDlpVersion,
} from "../lib/update-check.ts";

const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

async function scratch() {
	const home = await mkdtemp(path.join(os.tmpdir(), "gsyt-update-"));
	return { home, file: updateStatePath({ home, env: {} }), cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** Fake fetch answering `body` (JSON) with `status`; `fail` rejects; `hang` waits for the abort. */
function fakeFetch(opts: { body?: unknown; status?: number; fail?: boolean; hang?: boolean } = {}) {
	const calls: { url: string; signal: AbortSignal | undefined; headers: unknown }[] = [];
	const fetch = async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), signal: init?.signal ?? undefined, headers: init?.headers });
		if (opts.fail) throw new TypeError("fetch failed");
		if (opts.hang)
			return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
		const text = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? { tag_name: "2026.11.05" });
		return new Response(text, { status: opts.status ?? 200 });
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}

const current = (version: string | null) => async () => version;

// S23: the latest release is asked at most once per 24 h; the answer is kept in a 0600 state file.
test("S23 checkYtDlpUpdate asks GitHub at most once per 24 h and keeps { checkedAt, latest } in a 0600 file", async () => {
	const s = await scratch();
	try {
		const f = fakeFetch();
		const check = (now: number) => checkYtDlpUpdate({ home: s.home, env: {}, fetch: f.fetch, now: () => now, currentVersion: current("2026.10.26") });
		assert.deepEqual(await check(T0), { latest: "2026.11.05", current: "2026.10.26" });
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].url, RELEASES_URL);
		assert.equal(RELEASES_URL, "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest");
		assert.ok(f.calls[0].signal instanceof AbortSignal);
		assert.equal(s.file, path.join(s.home, ".local", "state", "pi-yt", "update.json"));
		assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")), { checkedAt: T0, latest: "2026.11.05" });
		assert.equal((await stat(s.file)).mode & 0o777, 0o600);

		assert.deepEqual(await check(T0 + 23 * HOUR), { latest: "2026.11.05", current: "2026.10.26" });
		assert.equal(f.calls.length, 1, "within 24 h the state file answers");
		assert.equal(UPDATE_CHECK_INTERVAL_MS, 24 * HOUR);
		await check(T0 + 24 * HOUR);
		assert.equal(f.calls.length, 2, "after 24 h GitHub is asked again");
	} finally {
		await s.cleanup();
	}
});

// S23: only a newer release is an update.
test("S23 newerVersion compares yt-dlp dates part by part; equal or older is no update", async () => {
	assert.equal(newerVersion("2026.11.05", "2026.10.26"), true);
	assert.equal(newerVersion("2026.10.26.1", "2026.10.26"), true);
	assert.equal(newerVersion("2027.01.02", "2026.12.31"), true);
	assert.equal(newerVersion("2026.10.26", "2026.10.26"), false);
	assert.equal(newerVersion("2026.10.09", "2026.10.26"), false);
	assert.equal(newerVersion("garbage", "2026.10.26"), false);
	const s = await scratch();
	try {
		const same = await checkYtDlpUpdate({
			home: s.home,
			env: {},
			fetch: fakeFetch({ body: { tag_name: "2026.10.26" } }).fetch,
			now: () => T0,
			currentVersion: current("2026.10.26"),
		});
		assert.equal(same, null);
	} finally {
		await s.cleanup();
	}
});

// S23: a failed check never throws or shows anything, and still counts as the day's check.
test("S23 checkYtDlpUpdate errors are silent: network, status, JSON, tag, version and state file", async () => {
	const s = await scratch();
	try {
		const run = (f: ReturnType<typeof fakeFetch>, now: number, version: string | null = "2026.10.26") =>
			checkYtDlpUpdate({ home: s.home, env: {}, fetch: f.fetch, now: () => now, currentVersion: current(version) });
		const down = fakeFetch({ fail: true });
		assert.equal(await run(down, T0), null);
		assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")), { checkedAt: T0, latest: null });
		assert.equal(await run(down, T0 + HOUR), null);
		assert.equal(down.calls.length, 1, "a failed check is not retried within 24 h");

		let now = T0 + 25 * HOUR;
		for (const f of [fakeFetch({ status: 403 }), fakeFetch({ body: "not json" }), fakeFetch({ body: { tag_name: "v1; rm -rf" } })]) {
			assert.equal(await run(f, now), null);
			assert.equal(f.calls.length, 1);
			now += 25 * HOUR;
		}
		assert.equal(await run(fakeFetch(), now, null), null, "no current version: no notice");

		await writeFile(s.file, "{corrupt");
		const fresh = fakeFetch();
		assert.deepEqual(await run(fresh, now), { latest: "2026.11.05", current: "2026.10.26" });
		assert.equal(fresh.calls.length, 1, "an unreadable state file means ask again");

		// A state folder that cannot be written still answers.
		const blocked = path.join(s.home, "blocked");
		await writeFile(blocked, "");
		const answer = await checkYtDlpUpdate({
			home: s.home,
			env: { XDG_STATE_HOME: blocked },
			fetch: fakeFetch().fetch,
			now: () => now,
			currentVersion: current("2026.10.26"),
		});
		assert.deepEqual(answer, { latest: "2026.11.05", current: "2026.10.26" });
		const throwing = await checkYtDlpUpdate({
			home: s.home,
			env: {},
			fetch: fakeFetch().fetch,
			now: () => now + 100 * HOUR,
			currentVersion: async () => {
				throw new Error("boom");
			},
		});
		assert.equal(throwing, null);
	} finally {
		await s.cleanup();
	}
});

// S23: GitHub gets 5 s; a hung request ends with no notice.
test("S23 checkYtDlpUpdate gives up after the timeout and aborts the request", async () => {
	const s = await scratch();
	try {
		const f = fakeFetch({ hang: true });
		const result = await checkYtDlpUpdate({
			home: s.home,
			env: {},
			fetch: f.fetch,
			now: () => T0,
			currentVersion: current("2026.10.26"),
			timeoutMs: 20,
		});
		assert.equal(result, null);
		assert.equal(f.calls[0].signal?.aborted, true);
	} finally {
		await s.cleanup();
	}
});

// S23: the state file follows an absolute XDG_STATE_HOME only.
test("S23 updateStatePath uses an absolute XDG_STATE_HOME and ignores a relative one", async () => {
	assert.equal(updateStatePath({ home: "/h", env: { XDG_STATE_HOME: "/x/state" } }), "/x/state/pi-yt/update.json");
	assert.equal(updateStatePath({ home: "/h", env: { XDG_STATE_HOME: "rel/state" } }), "/h/.local/state/pi-yt/update.json");
	assert.equal(updateStatePath({ home: "/h", env: {} }), "/h/.local/state/pi-yt/update.json");
	const s = await scratch();
	try {
		const xdg = path.join(s.home, "xdg");
		await mkdir(xdg);
		await checkYtDlpUpdate({ home: s.home, env: { XDG_STATE_HOME: xdg }, fetch: fakeFetch().fetch, now: () => T0, currentVersion: current("2026.10.26") });
		assert.deepEqual(JSON.parse(await readFile(path.join(xdg, "pi-yt", "update.json"), "utf8")), { checkedAt: T0, latest: "2026.11.05" });
	} finally {
		await s.cleanup();
	}
});

function fakeSpawn(script: { stdout?: string; code?: number; error?: NodeJS.ErrnoException; hang?: boolean } = {}) {
	const calls: { cmd: string; args: string[] }[] = [];
	const killed: string[] = [];
	const spawn = (cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => boolean };
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = (signal = "SIGTERM") => {
			killed.push(signal);
			setImmediate(() => child.emit("close", null, signal));
			return true;
		};
		setImmediate(() => {
			if (script.error) return void child.emit("error", script.error);
			if (script.stdout) child.stdout.end(script.stdout);
			if (!script.hang) setImmediate(() => child.emit("close", script.code ?? 0, null));
		});
		return child;
	};
	return { spawn, calls, killed };
}

// S23: the managed copy's version comes from `<path> --version`, with a 5 s limit.
test("S23 ytDlpVersion runs --version and returns the version, or null on error, bad output or timeout", async () => {
	const ok = fakeSpawn({ stdout: "2026.10.26\n" });
	assert.equal(await ytDlpVersion({ path: "/d/yt-dlp", spawn: ok.spawn }), "2026.10.26");
	assert.deepEqual(ok.calls, [{ cmd: "/d/yt-dlp", args: ["--version"] }]);
	assert.equal(await ytDlpVersion({ path: "/d/yt-dlp", spawn: fakeSpawn({ stdout: "2026.10.26\n", code: 1 }).spawn }), null);
	assert.equal(await ytDlpVersion({ path: "/d/yt-dlp", spawn: fakeSpawn({ stdout: "\x1b[31mnope\n" }).spawn }), null);
	const enoent = Object.assign(new Error("spawn"), { code: "ENOENT" });
	assert.equal(await ytDlpVersion({ path: "/d/yt-dlp", spawn: fakeSpawn({ error: enoent }).spawn }), null);
	const hang = fakeSpawn({ hang: true });
	assert.equal(await ytDlpVersion({ path: "/d/yt-dlp", spawn: hang.spawn, timeoutMs: 10 }), null);
	assert.deepEqual(hang.killed, ["SIGTERM"]);
});

// S24: the state file lives in pi-yt and GitHub sees the pi-yt User-Agent.
test("S24 update check uses pi-yt/update.json and the pi-yt User-Agent", async () => {
	assert.equal(updateStatePath({ home: "/h", env: {} }), "/h/.local/state/pi-yt/update.json");
	const s = await scratch();
	try {
		const f = fakeFetch();
		await checkYtDlpUpdate({ home: s.home, env: {}, fetch: f.fetch, now: () => T0, currentVersion: current("2026.10.26") });
		assert.equal((f.calls[0].headers as Record<string, string>)["User-Agent"], "pi-yt");
	} finally {
		await s.cleanup();
	}
});
