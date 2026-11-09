import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
	checkDeps,
	listPlaylist,
	listPlaylists,
	listSource,
	type SpawnFn,
	search,
	verifySession,
} from "../lib/youtube-source.ts";

type Script = { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException; hang?: boolean };

function fakeSpawn(script: Script = {}) {
	const calls: { cmd: string; args: string[] }[] = [];
	const killed: (NodeJS.Signals | number)[] = [];
	const spawn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args: [...args] });
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
			if (script.error) {
				child.emit("error", script.error);
				return;
			}
			if (script.stdout) child.stdout.write(script.stdout);
			if (script.stderr) child.stderr.write(script.stderr);
			child.stdout.end();
			child.stderr.end();
			if (!script.hang) setImmediate(() => child.emit("close", script.code ?? 0, null));
		});
		return child;
	};
	return { spawn, calls, killed };
}

const PAGE_1 = ["--playlist-start", "1", "--playlist-end", "50"];
const firefox = { browser: "firefox" as const, profile: "default-release" };
// S17(2): yt-dlp solves YouTube's JS challenge with Pi's node, so deno is not needed.
const JS = ["--js-runtimes", `node:${process.execPath}`];
const BASE = ["--flat-playlist", "-J", "--no-warnings", ...JS];
const COOKIES = ["--cookies-from-browser", "firefox:default-release"];

const ENTRIES = JSON.stringify({
	entries: [
		{ id: "abc123", title: "Song One", channel: "Chan", uploader: "Up", duration: 215.0 },
		{ id: "def456", title: "Song Two", uploader: "Uploader Only", duration: null },
		{ title: "no id, skipped" },
		{ id: "ghi789" },
	],
});

const TRACKS = [
	{ id: "abc123", title: "Song One", artist: "Chan", duration: 215, url: "https://www.youtube.com/watch?v=abc123" },
	{
		id: "def456",
		title: "Song Two",
		artist: "Uploader Only",
		duration: null,
		url: "https://www.youtube.com/watch?v=def456",
	},
	{ id: "ghi789", title: "Untitled", artist: null, duration: null, url: "https://www.youtube.com/watch?v=ghi789" },
];

// S4: each library source maps to its yt-dlp feed and passes the browser cookies flag.
for (const [kind, target] of [
	["liked", ":ytfav"],
	["later", ":ytwatchlater"],
	["recommended", ":ytrec"],
	["history", ":ythistory"],
] as const) {
	test(`listSource ${kind} runs yt-dlp on ${target} with cookies and parses tracks`, async () => {
		const fake = fakeSpawn({ stdout: ENTRIES });
		const result = await listSource(kind, { account: firefox, spawn: fake.spawn });
		assert.deepEqual(fake.calls, [{ cmd: "yt-dlp", args: [...BASE, ...COOKIES, ...PAGE_1, target] }]);
		assert.deepEqual(result, { ok: true, tracks: TRACKS, hasMore: false });
	});
}

// S8: library sources need an account; nothing is spawned without one.
test("listSource without an account is a signin error and spawns nothing", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	const result = await listSource("liked", { account: null, spawn: fake.spawn });
	assert.deepEqual(fake.calls, []);
	assert.deepEqual(result, {
		ok: false,
		error: {
			kind: "signin",
			message: "No YouTube account connected.",
			hint: "Connect a browser session in /yt, then retry.",
		},
	});
});

test("ytDlpPath overrides the executable", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	await listSource("liked", { account: firefox, spawn: fake.spawn, ytDlpPath: "/opt/yt-dlp" });
	assert.equal(fake.calls[0].cmd, "/opt/yt-dlp");
});

// S17: the resolved yt-dlp runs with Pi's node as its JS runtime, for every call.
test("S17 every yt-dlp call passes --js-runtimes node:<execPath> and the given ytDlpPath", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	const ytDlpPath = "/h/.local/share/pi-yt/bin/yt-dlp";
	await search("lofi", { spawn: fake.spawn, ytDlpPath });
	await listPlaylist("PL1", { spawn: fake.spawn, ytDlpPath });
	await verifySession(firefox, { spawn: fake.spawn, ytDlpPath });
	assert.deepEqual(
		fake.calls.map((c) => [c.cmd, ...c.args.slice(0, 5)]),
		Array.from({ length: 3 }, () => [
			ytDlpPath,
			"--flat-playlist",
			"-J",
			"--no-warnings",
			"--js-runtimes",
			`node:${process.execPath}`,
		]),
	);
});

test("listPlaylists reads the playlists feed", async () => {
	const fake = fakeSpawn({
		stdout: JSON.stringify({
			entries: [
				{ id: "PL1", title: "Road trip", playlist_count: 12 },
				{ id: "PL2", title: "Focus" },
				{ title: "no id" },
				{ id: "PL3" },
			],
		}),
	});
	const result = await listPlaylists({ account: firefox, spawn: fake.spawn });
	assert.deepEqual(fake.calls[0].args, [...BASE, ...COOKIES, "https://www.youtube.com/feed/playlists"]);
	assert.deepEqual(result, {
		ok: true,
		playlists: [
			{ id: "PL1", title: "Road trip", count: 12 },
			{ id: "PL2", title: "Focus", count: null },
			{ id: "PL3", title: "Untitled", count: null },
		],
	});
});

test("listPlaylist reads one playlist by id", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	const result = await listPlaylist("PL1", { account: firefox, spawn: fake.spawn });
	assert.deepEqual(fake.calls[0].args, [...BASE, ...COOKIES, ...PAGE_1, "https://www.youtube.com/playlist?list=PL1"]);
	assert.deepEqual(result, { ok: true, tracks: TRACKS, hasMore: false });
});

// S14: library lists come 50 entries at a time.
test("S14 listSource liked asks yt-dlp for entries 1-50", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	await listSource("liked", { account: firefox, spawn: fake.spawn });
	assert.deepEqual(fake.calls[0].args, [
		...BASE,
		...COOKIES,
		"--playlist-start",
		"1",
		"--playlist-end",
		"50",
		":ytfav",
	]);
});

test("S14 start 51 asks for entries 51-100 for sources and playlists", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	await listSource("later", { account: firefox, spawn: fake.spawn, start: 51 });
	await listPlaylist("PL1", { account: firefox, spawn: fake.spawn, start: 51 });
	const page = ["--playlist-start", "51", "--playlist-end", "100"];
	assert.deepEqual(fake.calls[0].args, [...BASE, ...COOKIES, ...page, ":ytwatchlater"]);
	assert.deepEqual(fake.calls[1].args, [...BASE, ...COOKIES, ...page, "https://www.youtube.com/playlist?list=PL1"]);
});

test("S14 hasMore is true for a full page and false below it", async () => {
	const entries = (n: number) => JSON.stringify({ entries: Array.from({ length: n }, (_, i) => ({ id: `v${i}` })) });
	const full = await listSource("liked", { account: firefox, spawn: fakeSpawn({ stdout: entries(50) }).spawn });
	const short = await listSource("liked", { account: firefox, spawn: fakeSpawn({ stdout: entries(49) }).spawn });
	assert.equal(full.ok && full.tracks.length, 50);
	assert.equal(full.ok && full.hasMore, true);
	assert.equal(short.ok && short.hasMore, false);
	const small = await listPlaylist("PL1", {
		account: firefox,
		spawn: fakeSpawn({ stdout: entries(2) }).spawn,
		pageSize: 2,
	});
	assert.equal(small.ok && small.hasMore, true);
});

test("S14 search and the playlists feed are not paged", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	await search("lofi", { account: firefox, spawn: fake.spawn });
	await listPlaylists({ account: firefox, spawn: fake.spawn });
	for (const call of fake.calls) {
		assert.ok(!call.args.includes("--playlist-start"), call.args.join(" "));
		assert.ok(!call.args.includes("--playlist-end"), call.args.join(" "));
	}
});

// S6: search works without an account (no cookies flag) and still passes cookies with one.
test("search without an account omits the cookies flag", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	const result = await search("lofi beats", { account: null, spawn: fake.spawn });
	assert.deepEqual(fake.calls[0].args, [...BASE, "ytsearch20:lofi beats"]);
	assert.deepEqual(result, { ok: true, tracks: TRACKS });
});

test("search with an account passes cookies and honours limit", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	await search("lofi", { account: firefox, spawn: fake.spawn, limit: 5 });
	assert.deepEqual(fake.calls[0].args, [...BASE, ...COOKIES, "ytsearch5:lofi"]);
});

// S8: error mapping.
test("missing yt-dlp maps to an install hint", async () => {
	const error = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
	const result = await search("x", { spawn: fakeSpawn({ error }).spawn });
	assert.deepEqual(result, {
		ok: false,
		error: {
			kind: "missing",
			message: "yt-dlp not found",
			hint: "Install it: sudo pacman -S yt-dlp (or pipx install yt-dlp)",
		},
	});
});

test("sign-in stderr maps to a session error naming the browser, without echoing stderr", async () => {
	const stderr = "ERROR: [youtube:tab] someone@example.com: Sign in to confirm your age\nmore\n";
	const result = await listSource("liked", { account: firefox, spawn: fakeSpawn({ stderr, code: 1 }).spawn });
	assert.deepEqual(result, {
		ok: false,
		error: {
			kind: "signin",
			message: "YouTube session not found in Firefox.",
			hint: "Sign in at youtube.com in Firefox, then retry.",
			detail: "ERROR: [youtube:tab] someone@example.com: Sign in to confirm your age",
		},
	});
});

test("sign-in stderr on a chromium account names Chromium", async () => {
	const result = await listSource("later", {
		account: { browser: "chromium", profile: "Default" },
		spawn: fakeSpawn({ stderr: "ERROR: This playlist is private\n", code: 1 }).spawn,
	});
	assert.equal(result.ok, false);
	assert.equal(!result.ok && result.error.message, "YouTube session not found in Chromium.");
	assert.equal(!result.ok && result.error.hint, "Sign in at youtube.com in Chromium, then retry.");
});

test("network stderr maps to a connection hint", async () => {
	const result = await search("x", {
		spawn: fakeSpawn({ stderr: "ERROR: Unable to download webpage: <urlopen error>\n", code: 1 }).spawn,
	});
	assert.deepEqual(result, {
		ok: false,
		error: {
			kind: "network",
			message: "Could not reach YouTube.",
			hint: "Check your connection and retry.",
			detail: "ERROR: Unable to download webpage: <urlopen error>",
		},
	});
});

test("other failures map to an update hint and cap detail at 200 chars", async () => {
	const stderr = `\nERROR: ${"x".repeat(300)}\n`;
	const result = await search("x", { spawn: fakeSpawn({ stderr, code: 1 }).spawn });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.kind, "extract");
	assert.equal(result.error.message, "yt-dlp could not read YouTube.");
	assert.equal(result.error.hint, "Update yt-dlp (yt-dlp -U or your package manager) and retry.");
	assert.equal(result.error.detail?.length, 200);
	assert.ok(result.error.detail?.startsWith("ERROR: xxx"));
});

test("unparseable output is an extract error", async () => {
	const result = await search("x", { spawn: fakeSpawn({ stdout: "not json", code: 0 }).spawn });
	assert.deepEqual(result, {
		ok: false,
		error: {
			kind: "extract",
			message: "yt-dlp could not read YouTube.",
			hint: "Update yt-dlp (yt-dlp -U or your package manager) and retry.",
		},
	});
});

// S3/S8: verifying a session reads one liked entry.
test("verifySession runs :ytfav with --playlist-end 1", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	assert.deepEqual(await verifySession(firefox, { spawn: fake.spawn }), { ok: true });
	assert.deepEqual(fake.calls[0].args, [...BASE, ...COOKIES, "--playlist-end", "1", ":ytfav"]);
});

test("verifySession reports the signin error", async () => {
	const fake = fakeSpawn({ stderr: "ERROR: login required\n", code: 1 });
	const result = await verifySession(firefox, { spawn: fake.spawn });
	assert.deepEqual(result, {
		ok: false,
		error: {
			kind: "signin",
			message: "YouTube session not found in Firefox.",
			hint: "Sign in at youtube.com in Firefox, then retry.",
			detail: "ERROR: login required",
		},
	});
});

// S8: timeout kills yt-dlp.
test("yt-dlp is killed after the timeout", async () => {
	const fake = fakeSpawn({ hang: true });
	let scheduled: { fn: () => void; ms: number } | undefined;
	const promise = search("x", {
		spawn: fake.spawn,
		setTimeout: (fn, ms) => {
			scheduled = { fn, ms };
			return 1;
		},
		clearTimeout: () => {},
	});
	await new Promise((r) => setImmediate(r));
	assert.equal(scheduled?.ms, 30_000);
	scheduled?.fn();
	assert.deepEqual(await promise, {
		ok: false,
		error: {
			kind: "network",
			message: "Could not reach YouTube.",
			hint: "yt-dlp took too long; check your connection and retry.",
		},
	});
	assert.deepEqual(fake.killed, ["SIGTERM"]);
});

test("aborting kills yt-dlp and resolves cancelled", async () => {
	const fake = fakeSpawn({ hang: true });
	const controller = new AbortController();
	const promise = search("x", { spawn: fake.spawn, signal: controller.signal });
	await new Promise((r) => setImmediate(r));
	controller.abort();
	assert.deepEqual(await promise, { ok: false, error: { kind: "extract", message: "cancelled", hint: "" } });
	assert.deepEqual(fake.killed, ["SIGTERM"]);
});

test("an already aborted signal spawns nothing", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	const controller = new AbortController();
	controller.abort();
	const result = await search("x", { spawn: fake.spawn, signal: controller.signal });
	assert.deepEqual(result, { ok: false, error: { kind: "extract", message: "cancelled", hint: "" } });
	assert.deepEqual(fake.calls, []);
});

// S3: dependency line, by scanning PATH without spawning.
test("checkDeps scans PATH for executables", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "gsyt-path-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	await mkdir(a);
	await mkdir(b);
	await writeFile(path.join(a, "mpv"), "#!/bin/sh\n");
	await chmod(path.join(a, "mpv"), 0o755);
	await writeFile(path.join(a, "yt-dlp"), "not executable");
	await chmod(path.join(a, "yt-dlp"), 0o644);
	assert.deepEqual(await checkDeps({ home: root, env: { PATH: `${a}:${path.join(root, "nope")}` } }), {
		mpv: true,
		ytDlp: false,
	});
	await writeFile(path.join(b, "yt-dlp"), "#!/bin/sh\n");
	await chmod(path.join(b, "yt-dlp"), 0o755);
	assert.deepEqual(await checkDeps({ home: root, env: { PATH: `${a}:${b}` } }), { mpv: true, ytDlp: true });
	assert.deepEqual(await checkDeps({ home: root, env: {} }), { mpv: false, ytDlp: false });
});

// Advisory S14: checkDeps agrees with resolveTools: relative PATH entries are skipped and the managed yt-dlp counts.
test("checkDeps ignores relative PATH entries and finds the managed yt-dlp", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "gsyt-path-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const name of ["mpv", "yt-dlp"]) {
		await writeFile(path.join(root, name), "#!/bin/sh\n");
		await chmod(path.join(root, name), 0o755);
	}
	const cwd = process.cwd();
	process.chdir(root);
	try {
		assert.deepEqual(await checkDeps({ home: root, env: { PATH: "." } }), { mpv: false, ytDlp: false });
	} finally {
		process.chdir(cwd);
	}
	const managed = path.join(root, "data", "pi-yt", "bin");
	await mkdir(managed, { recursive: true });
	await writeFile(path.join(managed, "yt-dlp"), "#!/bin/sh\n");
	await chmod(path.join(managed, "yt-dlp"), 0o755);
	assert.deepEqual(await checkDeps({ home: root, env: { XDG_DATA_HOME: path.join(root, "data") } }), {
		mpv: false,
		ytDlp: true,
	});
});

const zen = { browser: "zen" as const, profile: "/h/.zen/a.Default (release)" };
const helium = { browser: "helium" as const, profile: "/h/.config/net.imput.helium/Default" };

// S13: yt-dlp reads Zen as a Firefox profile path and Helium as a Chromium profile path.
test("zen and helium accounts pass firefox:/chromium: profile paths to yt-dlp", async () => {
	const fake = fakeSpawn({ stdout: ENTRIES });
	await listSource("liked", { account: zen, spawn: fake.spawn });
	await listSource("liked", { account: helium, spawn: fake.spawn });
	assert.deepEqual(fake.calls[0].args, [
		...BASE,
		"--cookies-from-browser",
		"firefox:/h/.zen/a.Default (release)",
		...PAGE_1,
		":ytfav",
	]);
	assert.deepEqual(fake.calls[1].args, [
		...BASE,
		"--cookies-from-browser",
		"chromium:/h/.config/net.imput.helium/Default",
		...PAGE_1,
		":ytfav",
	]);
});

// S13/S8: sign-in errors name Zen and Helium.
test("sign-in stderr names Zen and Helium", async () => {
	for (const [account, label] of [
		[zen, "Zen"],
		[helium, "Helium"],
	] as const) {
		const result = await listSource("liked", {
			account,
			spawn: fakeSpawn({ stderr: "ERROR: login required\n", code: 1 }).spawn,
		});
		assert.deepEqual(result, {
			ok: false,
			error: {
				kind: "signin",
				message: `YouTube session not found in ${label}.`,
				// yt-dlp -J hides Helium's decrypt warnings, so its sign-in hint also names the keyring.
				hint:
					label === "Helium"
						? "Sign in at youtube.com in Helium, or unlock your system keyring, then retry."
						: `Sign in at youtube.com in ${label}, then retry.`,
				detail: "ERROR: login required",
			},
		});
	}
});

// S13: Helium cookies that cannot be decrypted get their own message; stderr never becomes the message.
test("helium decrypt failures map to a keyring hint", async () => {
	for (const stderr of [
		"WARNING: cookies for secret@example.com could not be decrypted\n",
		"ERROR: Failed to decrypt with DPAPI\n",
		"ERROR: no keyring found for secret\n",
	]) {
		const result = await listSource("liked", { account: helium, spawn: fakeSpawn({ stderr, code: 1 }).spawn });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.error.kind, "signin");
		assert.equal(result.error.message, "Could not decrypt Helium's cookies.");
		assert.equal(result.error.hint, "Unlock your system keyring, or try another browser.");
		assert.ok(!result.error.message.includes("secret"));
		assert.ok(!result.error.hint.includes("secret"));
	}
	// Other browsers keep the session mapping.
	const chromium = await listSource("liked", {
		account: { browser: "chromium", profile: "Default" },
		spawn: fakeSpawn({ stderr: "ERROR: cookies could not be decrypted\n", code: 1 }).spawn,
	});
	assert.equal(!chromium.ok && chromium.error.message, "YouTube session not found in Chromium.");
});

// S22: YouTube Mixes and other non-video entries (playlists, channels) cannot be played as tracks, so lists skip them;
// paging still counts every entry yt-dlp returned.
test("S22 lists skip Mixes, playlists and channels; hasMore counts the raw page", async () => {
	const stdout = JSON.stringify({
		entries: [
			{ id: "vid0000000a", ie_key: "Youtube", title: "Song A", channel: "Artist" },
			{
				id: "RDvid0000000a",
				ie_key: "YoutubeTab",
				title: "Mix - Song A",
				url: "https://www.youtube.com/watch?v=vid0000000a&list=RDvid0000000a",
			},
			{ id: "PLabc", _type: "playlist", title: "A playlist" },
			{ id: "UCxyz", ie_key: "YoutubeTab", title: "A channel", url: "https://www.youtube.com/channel/UCxyz" },
			{ id: "vid0000000b", title: "Song B" },
		],
	});
	const result = await listSource("recommended", { account: firefox, spawn: fakeSpawn({ stdout }).spawn, pageSize: 5 });
	assert.ok(result.ok);
	assert.deepEqual(result.ok && result.tracks.map((t) => t.title), ["Song A", "Song B"]);
	assert.equal(result.ok && result.hasMore, true);
	const searched = await search("mix", { spawn: fakeSpawn({ stdout }).spawn });
	assert.deepEqual(searched.ok && searched.tracks.map((t) => t.title), ["Song A", "Song B"]);
});

// Advisory S16: hasMore follows the raw page, even when some entries are unusable (null or without an id).
test("hasMore counts unusable entries in a full page", async () => {
	const entries = [null, { title: "no id" }, ...Array.from({ length: 48 }, (_, i) => ({ id: `v${i}` }))];
	const result = await listSource("liked", {
		account: firefox,
		spawn: fakeSpawn({ stdout: JSON.stringify({ entries }) }).spawn,
	});
	assert.equal(result.ok && result.tracks.length, 48);
	assert.equal(result.ok && result.hasMore, true);
});
