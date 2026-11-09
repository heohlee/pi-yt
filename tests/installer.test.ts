import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { installYtDlp, type Release, releaseAsset, updateYtDlp, YT_DLP } from "../lib/installer.ts";
import { managedBinDir } from "../lib/tools.ts";

const BODY = Buffer.from("#!/bin/sh\necho fake yt-dlp\n");
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The pinned release with a test asset whose hash matches `data`. */
const release = (data: Buffer, size?: number): Release => ({
	...YT_DLP,
	assets: { ...YT_DLP.assets, "linux-x64": { name: "yt-dlp_linux", sha256: sha(data), size } },
});

async function scratch() {
	const home = await mkdtemp(path.join(os.tmpdir(), "gsyt-install-"));
	const dir = managedBinDir({ home, env: {} });
	return { home, dir, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/**
 * Fake fetch answering with `chunks`; `hang` keeps the body open after them.
 * `finalUrl` is the URL after redirects (the requested one by default); `cancelled` counts body releases.
 */
function fakeFetch(
	chunks: Buffer[],
	opts: { status?: number; length?: number; hang?: boolean; finalUrl?: string } = {},
) {
	const urls: string[] = [];
	const inits: (RequestInit | undefined)[] = [];
	const state = { cancelled: 0 };
	const fetch = async (url: string | URL | Request, init?: RequestInit) => {
		urls.push(String(url));
		inits.push(init);
		const signal = init?.signal;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(new Uint8Array(c));
				if (!opts.hang) controller.close();
				signal?.addEventListener("abort", () => controller.error(signal.reason));
			},
			cancel() {
				state.cancelled++;
			},
		});
		const headers: Record<string, string> = {};
		if (opts.length !== undefined) headers["content-length"] = String(opts.length);
		const response = new Response(body, { status: opts.status ?? 200, headers });
		Object.defineProperty(response, "url", { value: opts.finalUrl ?? String(url) });
		return response;
	};
	return {
		fetch: fetch as typeof globalThis.fetch,
		urls,
		inits,
		get cancelled() {
			return state.cancelled;
		},
	};
}

const listing = async (dir: string) => (await readdir(dir).catch(() => [])).sort();

// S17: one pinned official asset per platform, from the GitHub release.
test("S17 releaseAsset maps platform/arch to the exact pinned release URL", () => {
	const url = (name: string) => `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/${name}`;
	assert.equal(YT_DLP.version, "2026.10.26");
	assert.deepEqual(releaseAsset({ platform: "linux", arch: "x64" }), {
		name: "yt-dlp_linux",
		sha256: "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795",
		size: 41166968,
		url: url("yt-dlp_linux"),
	});
	assert.deepEqual(releaseAsset({ platform: "linux", arch: "arm64" }), {
		name: "yt-dlp_linux_aarch64",
		sha256: "e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483",
		url: url("yt-dlp_linux_aarch64"),
	});
	for (const arch of ["arm64", "x64"])
		assert.deepEqual(releaseAsset({ platform: "darwin", arch }), {
			name: "yt-dlp_macos",
			sha256: "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa",
			url: url("yt-dlp_macos"),
		});
	assert.equal(releaseAsset({ platform: "linux", arch: "ia32" }), null);
	assert.equal(releaseAsset({ platform: "win32", arch: "x64" }), null);
});

// S17: verified download lands as <dir>/yt-dlp, mode 0755, with no temp file left.
test("S17 installYtDlp downloads, verifies and renames into the managed dir", async () => {
	const s = await scratch();
	try {
		const fake = fakeFetch([BODY.subarray(0, 10), BODY.subarray(10)], { length: BODY.length });
		const progress: unknown[] = [];
		const result = await installYtDlp({
			home: s.home,
			env: {},
			platform: "linux",
			arch: "x64",
			fetch: fake.fetch,
			release: release(BODY, 41166968),
			onProgress: (p) => progress.push(p),
		});
		const target = path.join(s.dir, "yt-dlp");
		assert.deepEqual(result, { ok: true, path: target });
		assert.deepEqual(fake.urls, ["https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux"]);
		assert.deepEqual(await readFile(target), BODY);
		assert.equal((await stat(target)).mode & 0o777, 0o755);
		// mkdir's 0o755 is narrowed by the umask, never widened.
		assert.equal((await stat(s.dir)).mode & 0o777 & ~0o755, 0);
		assert.equal((await stat(s.dir)).mode & 0o700, 0o700);
		assert.deepEqual(await listing(s.dir), ["yt-dlp"]);
		assert.deepEqual(progress, [
			{ phase: "download", received: 0, total: BODY.length },
			{ phase: "download", received: 10, total: BODY.length },
			{ phase: "download", received: BODY.length, total: BODY.length },
			{ phase: "verify" },
		]);
	} finally {
		await s.cleanup();
	}
});

// S17: a checksum mismatch installs nothing and leaves no temp file.
test("S17 installYtDlp rejects a hash mismatch and deletes the temp file", async () => {
	const s = await scratch();
	try {
		const result = await installYtDlp({
			home: s.home,
			env: {},
			platform: "linux",
			arch: "x64",
			fetch: fakeFetch([Buffer.from("tampered")]).fetch,
			release: release(BODY),
		});
		assert.deepEqual(result, {
			ok: false,
			error: {
				kind: "hash",
				message: "The download did not match the official checksum.",
				hint: "Nothing was installed. Retry later.",
			},
		});
		assert.deepEqual(await listing(s.dir), []);
	} finally {
		await s.cleanup();
	}
});

// S17: downloads over the size limit stop, whatever the server announces.
test("S17 installYtDlp enforces the size limit", async () => {
	const s = await scratch();
	try {
		const TOO_LARGE = {
			ok: false,
			error: {
				kind: "size",
				message: "The download is larger than expected.",
				hint: "Nothing was installed. Retry later.",
			},
		};
		const announced = await installYtDlp({
			home: s.home,
			env: {},
			platform: "linux",
			arch: "x64",
			fetch: fakeFetch([BODY], { length: 70 * 1024 * 1024 }).fetch,
			release: release(BODY),
		});
		assert.deepEqual(announced, TOO_LARGE);
		const streamed = await installYtDlp({
			home: s.home,
			env: {},
			platform: "linux",
			arch: "x64",
			fetch: fakeFetch([BODY, BODY, BODY]).fetch,
			release: release(BODY),
			maxBytes: BODY.length * 2,
		});
		assert.deepEqual(streamed, TOO_LARGE);
		assert.deepEqual(await listing(s.dir), []);
	} finally {
		await s.cleanup();
	}
});

// S17: esc cancels the download; the temp file is removed.
test("S17 aborting installYtDlp deletes the temp file", async () => {
	const s = await scratch();
	try {
		const controller = new AbortController();
		const pending = installYtDlp({
			home: s.home,
			env: {},
			platform: "linux",
			arch: "x64",
			fetch: fakeFetch([BODY.subarray(0, 5)], { hang: true }).fetch,
			release: release(BODY),
			signal: controller.signal,
			onProgress: (p) => {
				if (p.phase === "download" && p.received === 5) controller.abort();
			},
		});
		assert.deepEqual(await pending, {
			ok: false,
			error: { kind: "cancelled", message: "Install cancelled.", hint: "" },
		});
		assert.deepEqual(await listing(s.dir), []);

		const slow = await installYtDlp({
			home: s.home,
			env: {},
			platform: "linux",
			arch: "x64",
			fetch: fakeFetch([BODY.subarray(0, 5)], { hang: true }).fetch,
			release: release(BODY),
			timeoutMs: 20,
		});
		assert.deepEqual(slow, {
			ok: false,
			error: { kind: "timeout", message: "The download took too long.", hint: "Check your connection and retry." },
		});
		assert.deepEqual(await listing(s.dir), []);
	} finally {
		await s.cleanup();
	}
});

// S17: HTTP errors and unsupported systems install nothing.
test("S17 installYtDlp reports HTTP errors and unsupported platforms without touching the disk", async () => {
	const s = await scratch();
	try {
		const http = await installYtDlp({
			home: s.home,
			env: {},
			platform: "linux",
			arch: "x64",
			fetch: fakeFetch([], { status: 404 }).fetch,
			release: release(BODY),
		});
		assert.deepEqual(http, {
			ok: false,
			error: { kind: "network", message: "Could not download yt-dlp.", hint: "Check your connection and retry." },
		});
		assert.deepEqual(await listing(s.dir), []);

		const fake = fakeFetch([BODY]);
		const unsupported = await installYtDlp({
			home: s.home,
			env: {},
			platform: "freebsd",
			arch: "x64",
			fetch: fake.fetch,
		});
		assert.deepEqual(unsupported, {
			ok: false,
			error: {
				kind: "unsupported",
				message: "No official yt-dlp build for this system.",
				hint: "Install yt-dlp with your package manager.",
			},
		});
		assert.deepEqual(fake.urls, []);
	} finally {
		await s.cleanup();
	}
});

const NETWORK = {
	ok: false,
	error: { kind: "network", message: "Could not download yt-dlp.", hint: "Check your connection and retry." },
};
const install = (s: { home: string }, fetch: typeof globalThis.fetch, extra: { maxBytes?: number } = {}) =>
	installYtDlp({
		home: s.home,
		env: {},
		platform: "linux",
		arch: "x64",
		fetch,
		release: release(BODY),
		timeoutMs: 1000,
		...extra,
	});

// S4 (#25): redirects are followed, but the final download must still come over https.
test("S4 installYtDlp rejects a download whose final URL after redirects is not https", async () => {
	const s = await scratch();
	try {
		for (const finalUrl of ["http://objects.githubusercontent.com/yt-dlp_linux", ""]) {
			const fake = fakeFetch([BODY], { finalUrl, hang: true });
			assert.deepEqual(await install(s, fake.fetch), NETWORK, finalUrl);
			assert.equal(fake.inits[0]?.redirect, "follow");
			assert.equal(fake.cancelled, 1, finalUrl);
			assert.deepEqual(await listing(s.dir), []);
		}
		// An https redirect target is fine; the pinned SHA-256 still decides.
		const moved = fakeFetch([BODY], { finalUrl: "https://objects.githubusercontent.com/yt-dlp_linux" });
		assert.deepEqual(await install(s, moved.fetch), { ok: true, path: path.join(s.dir, "yt-dlp") });
	} finally {
		await s.cleanup();
	}
});

// S5 (#25): every early exit releases the response body instead of leaving the connection open.
test("S5 installYtDlp releases the response body on an HTTP error, an announced or streamed size overrun", async () => {
	const s = await scratch();
	try {
		const http = fakeFetch([BODY], { status: 500, hang: true });
		assert.deepEqual(await install(s, http.fetch), NETWORK);
		assert.equal(http.cancelled, 1);

		const TOO_LARGE = {
			ok: false,
			error: {
				kind: "size",
				message: "The download is larger than expected.",
				hint: "Nothing was installed. Retry later.",
			},
		};
		const announced = fakeFetch([BODY], { length: 70 * 1024 * 1024, hang: true });
		assert.deepEqual(await install(s, announced.fetch), TOO_LARGE);
		assert.equal(announced.cancelled, 1);

		const streamed = fakeFetch([BODY, BODY, BODY], { hang: true });
		assert.deepEqual(await install(s, streamed.fetch, { maxBytes: BODY.length * 2 }), TOO_LARGE);
		assert.equal(streamed.cancelled, 1);
		assert.deepEqual(await listing(s.dir), []);
	} finally {
		await s.cleanup();
	}
});

// S8 (#25): a folder that cannot be written reports where, installs nothing and releases the body.
test("S8 installYtDlp reports a write failure with the folder to check", async () => {
	const s = await scratch();
	try {
		// A plain file where the managed folder should be: mkdir fails for any user, root included.
		await mkdir(path.dirname(s.dir), { recursive: true });
		await writeFile(s.dir, "not a folder");
		const fake = fakeFetch([BODY], { hang: true });
		assert.deepEqual(await install(s, fake.fetch), {
			ok: false,
			error: {
				kind: "write",
				message: "Could not save yt-dlp.",
				hint: "Check that ~/.local/share/pi-yt/bin is writable.",
			},
		});
		assert.equal(fake.cancelled, 1);
		assert.equal(await readFile(s.dir, "utf8"), "not a folder");
		assert.deepEqual(await readdir(path.dirname(s.dir)), ["bin"]);
	} finally {
		await s.cleanup();
	}
});

function fakeSpawn(script: { code?: number; stderr?: string; error?: NodeJS.ErrnoException; hang?: boolean } = {}) {
	const calls: { cmd: string; args: string[] }[] = [];
	const killed: (NodeJS.Signals | number)[] = [];
	const spawn = (cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			kill: (signal?: NodeJS.Signals | number) => boolean;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = (signal = "SIGTERM") => {
			killed.push(signal);
			setImmediate(() => child.emit("close", null, signal));
			return true;
		};
		setImmediate(() => {
			if (script.error) return void child.emit("error", script.error);
			if (script.stderr) child.stderr.write(script.stderr);
			if (!script.hang) setImmediate(() => child.emit("close", script.code ?? 0, null));
		});
		return child;
	};
	return { spawn, calls, killed };
}

// S17: Update yt-dlp runs `<path> -U` on the managed copy only; errors never carry stderr.
test("S17 updateYtDlp runs -U only on the managed copy and maps errors without stderr", async () => {
	const ok = fakeSpawn();
	assert.deepEqual(await updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: ok.spawn }), { ok: true });
	assert.deepEqual(ok.calls, [{ cmd: "/d/yt-dlp", args: ["-U"] }]);

	const system = fakeSpawn();
	assert.deepEqual(await updateYtDlp({ path: "/usr/bin/yt-dlp", source: "system", spawn: system.spawn }), {
		ok: false,
		error: {
			kind: "system",
			message: "yt-dlp comes from your system.",
			hint: "Update yt-dlp with your package manager.",
		},
	});
	assert.deepEqual(system.calls, []);

	const failed = await updateYtDlp({
		path: "/d/yt-dlp",
		source: "managed",
		spawn: fakeSpawn({ code: 1, stderr: "ERROR: SECRET" }).spawn,
	});
	assert.deepEqual(failed, {
		ok: false,
		error: { kind: "update", message: "Could not update yt-dlp.", hint: "Check your connection and retry." },
	});
	assert.ok(!JSON.stringify(failed).includes("SECRET"));

	const enoent = Object.assign(new Error("spawn"), { code: "ENOENT" });
	assert.deepEqual(
		await updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: fakeSpawn({ error: enoent }).spawn }),
		{
			ok: false,
			error: { kind: "missing", message: "yt-dlp not found", hint: "Install yt-dlp from /yt." },
		},
	);

	const hang = fakeSpawn({ hang: true });
	assert.deepEqual(await updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: hang.spawn, timeoutMs: 10 }), {
		ok: false,
		error: { kind: "timeout", message: "yt-dlp took too long to update.", hint: "Check your connection and retry." },
	});
	assert.deepEqual(hang.killed, ["SIGTERM"]);
});

// S9 (#25): esc during Update yt-dlp stops the run; a cancel before it starts spawns nothing.
test("S9 aborting updateYtDlp kills the child and reports the cancel", async () => {
	const CANCELLED = { ok: false, error: { kind: "cancelled", message: "Update cancelled.", hint: "" } };
	const hang = fakeSpawn({ hang: true });
	const controller = new AbortController();
	const pending = updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: hang.spawn, signal: controller.signal });
	controller.abort();
	assert.deepEqual(await pending, CANCELLED);
	assert.deepEqual(hang.calls, [{ cmd: "/d/yt-dlp", args: ["-U"] }]);
	assert.deepEqual(hang.killed, ["SIGTERM"]);

	const early = fakeSpawn();
	assert.deepEqual(
		await updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: early.spawn, signal: AbortSignal.abort() }),
		CANCELLED,
	);
	assert.deepEqual(early.calls, []);
});
