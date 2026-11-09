import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installYtDlp, releaseAsset, updateYtDlp, YT_DLP, type Release } from "../lib/installer.ts";
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

/** Fake fetch answering with `chunks`; `hang` keeps the body open after them. */
function fakeFetch(chunks: Buffer[], opts: { status?: number; length?: number; hang?: boolean } = {}) {
	const urls: string[] = [];
	const fetch = async (url: string | URL | Request, init?: RequestInit) => {
		urls.push(String(url));
		const signal = init?.signal;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(new Uint8Array(c));
				if (!opts.hang) controller.close();
				signal?.addEventListener("abort", () => controller.error(signal.reason));
			},
		});
		const headers: Record<string, string> = {};
		if (opts.length !== undefined) headers["content-length"] = String(opts.length);
		return new Response(body, { status: opts.status ?? 200, headers });
	};
	return { fetch: fetch as typeof globalThis.fetch, urls };
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
		assert.equal((await stat(s.dir)).mode & 0o777, 0o755);
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
			error: { kind: "size", message: "The download is larger than expected.", hint: "Nothing was installed. Retry later." },
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
		assert.deepEqual(await pending, { ok: false, error: { kind: "cancelled", message: "Install cancelled.", hint: "" } });
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
		const unsupported = await installYtDlp({ home: s.home, env: {}, platform: "freebsd", arch: "x64", fetch: fake.fetch });
		assert.deepEqual(unsupported, {
			ok: false,
			error: { kind: "unsupported", message: "No official yt-dlp build for this system.", hint: "Install yt-dlp with your package manager." },
		});
		assert.deepEqual(fake.urls, []);
	} finally {
		await s.cleanup();
	}
});

function fakeSpawn(script: { code?: number; stderr?: string; error?: NodeJS.ErrnoException; hang?: boolean } = {}) {
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
		error: { kind: "system", message: "yt-dlp comes from your system.", hint: "Update yt-dlp with your package manager." },
	});
	assert.deepEqual(system.calls, []);

	const failed = await updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: fakeSpawn({ code: 1, stderr: "ERROR: SECRET" }).spawn });
	assert.deepEqual(failed, {
		ok: false,
		error: { kind: "update", message: "Could not update yt-dlp.", hint: "Check your connection and retry." },
	});
	assert.ok(!JSON.stringify(failed).includes("SECRET"));

	const enoent = Object.assign(new Error("spawn"), { code: "ENOENT" });
	assert.deepEqual(await updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: fakeSpawn({ error: enoent }).spawn }), {
		ok: false,
		error: { kind: "missing", message: "yt-dlp not found", hint: "Install yt-dlp from /yt." },
	});

	const hang = fakeSpawn({ hang: true });
	assert.deepEqual(await updateYtDlp({ path: "/d/yt-dlp", source: "managed", spawn: hang.spawn, timeoutMs: 10 }), {
		ok: false,
		error: { kind: "timeout", message: "yt-dlp took too long to update.", hint: "Check your connection and retry." },
	});
	assert.deepEqual(hang.killed, ["SIGTERM"]);
});
