import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { blockedRecently, probeStream, resolveAudio, STRATEGY_COOLDOWN_MS } from "../lib/resolver.ts";
import type { SpawnFn } from "../lib/youtube-source.ts";

type Script = { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException; hang?: boolean };

/** Fake yt-dlp: one script per spawn, in order; the last script repeats. */
function fakeSpawn(...scripts: Script[]) {
	const calls: { cmd: string; args: string[] }[] = [];
	const killed: string[] = [];
	const spawn: SpawnFn = (cmd, args) => {
		const script = scripts[Math.min(calls.length, scripts.length - 1)] ?? {};
		calls.push({ cmd, args: [...args] });
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			kill: (signal?: string) => boolean;
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
			if (script.hang) return;
			child.stdout.end();
			child.stderr.end();
			setImmediate(() => child.emit("close", script.code ?? 0, null));
		});
		return child;
	};
	return { spawn, calls, killed };
}

const TRACK = {
	id: "abc123",
	title: "Song One",
	artist: "Chan",
	duration: 215,
	url: "https://www.youtube.com/watch?v=abc123",
};
const STREAM = "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1&itag=251";
// S17(2): Pi's node solves YouTube's JS challenge.
const JS = ["--js-runtimes", `node:${process.execPath}`];
// S21: the strategy table, in order: the visionos client, then the full resolve.
const FAST = ["-f", "bestaudio/best", "-g", "--no-warnings", ...JS, "--extractor-args", "youtube:player_client=visionos;skip=hls"];
const SLOW = ["-f", "bestaudio/best", "-g", "--no-warnings", ...JS];
const SECRET = "ERROR: [youtube] abc123: Login required; cookie SID=supersecret";

// S21: the visionos try comes first and a link from it is the only run; the browser spec goes to yt-dlp only when given.
test("S21/S4 a working visionos try is the only run, with exactly its args, with and without the cookie arg", async () => {
	const anon = fakeSpawn({ stdout: `${STREAM}\n` });
	assert.deepEqual(await resolveAudio(TRACK, { spawn: anon.spawn }), { ok: true, url: STREAM });
	assert.deepEqual(anon.calls, [{ cmd: "yt-dlp", args: [...FAST, TRACK.url] }]);

	const signed = fakeSpawn({ stdout: `${STREAM}\n` });
	const result = await resolveAudio(TRACK, { spawn: signed.spawn, cookieArg: "firefox:default-release" });
	assert.deepEqual(result, { ok: true, url: STREAM });
	// yt-dlp's visionos client does not support cookies, so it always runs without them (verify B1).
	assert.deepEqual(signed.calls, [{ cmd: "yt-dlp", args: [...FAST, TRACK.url] }]);
});

// S17: the resolved yt-dlp (system or managed) runs both tries.
test("S17 resolveAudio runs the given ytDlpPath with --js-runtimes node:<execPath>", async () => {
	const fake = fakeSpawn({ code: 1, stderr: "ERROR: something" }, { stdout: `${STREAM}\n` });
	const ytDlpPath = "/h/.local/share/pi-yt/bin/yt-dlp";
	assert.deepEqual(await resolveAudio(TRACK, { spawn: fake.spawn, ytDlpPath }), { ok: true, url: STREAM });
	assert.deepEqual(fake.calls, [
		{ cmd: ytDlpPath, args: ["-f", "bestaudio/best", "-g", "--no-warnings", "--js-runtimes", `node:${process.execPath}`, "--extractor-args", "youtube:player_client=visionos;skip=hls", TRACK.url] },
		{ cmd: ytDlpPath, args: ["-f", "bestaudio/best", "-g", "--no-warnings", "--js-runtimes", `node:${process.execPath}`, TRACK.url] },
	]);
});

// S21: a failed visionos try runs the full resolve next, with exactly the common args (and the cookie arg).
test("S21/S4 a failed visionos try runs the full resolve with exactly the common args", async () => {
	const fake = fakeSpawn({ code: 1, stderr: "ERROR: something" }, { stdout: `${STREAM}\n` });
	const result = await resolveAudio(TRACK, { spawn: fake.spawn, cookieArg: "firefox:default-release" });
	assert.deepEqual(result, { ok: true, url: STREAM });
	assert.deepEqual(
		fake.calls.map((c) => c.args),
		[
			[...FAST, TRACK.url],
			[...SLOW, "--cookies-from-browser", "firefox:default-release", TRACK.url],
		],
	);

	const twice = fakeSpawn({ code: 1, stderr: "ERROR: unable to extract" });
	const failed = await resolveAudio(TRACK, { spawn: twice.spawn });
	assert.equal(failed.ok, false);
	assert.equal(twice.calls.length, 2);
});

// S15: yt-dlp may print a video and an audio URL; the first https line wins.
test("S15 returns the first stdout line that starts with https://", async () => {
	const fake = fakeSpawn({ stdout: `[info] something\n${STREAM}\nhttps://second.example/audio\n` });
	assert.deepEqual(await resolveAudio(TRACK, { spawn: fake.spawn }), { ok: true, url: STREAM });
	assert.equal(fake.calls.length, 1);
});

// S15: exit 0 without a usable URL is a failure (after the retry), never an empty URL.
test("S15 empty or invalid output is a failure with an update hint", async () => {
	for (const stdout of ["", "\n", "not a url\nhttp://insecure.example/a\n"]) {
		const fake = fakeSpawn({ stdout });
		const result = await resolveAudio(TRACK, { spawn: fake.spawn });
		assert.deepEqual(result, {
			ok: false,
			error: {
				kind: "extract",
				message: "yt-dlp could not read YouTube.",
				hint: "Update yt-dlp (yt-dlp -U or your package manager) and retry.",
			},
		});
		assert.equal(fake.calls.length, 2);
	}
});

// S15: a queue change aborts the resolve and the yt-dlp child goes away, without a retry.
test("S15 abort kills the child and does not retry", async () => {
	const fake = fakeSpawn({ hang: true });
	const controller = new AbortController();
	const pending = resolveAudio(TRACK, { spawn: fake.spawn, signal: controller.signal });
	await new Promise((r) => setImmediate(r));
	controller.abort();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.deepEqual(fake.killed, ["SIGTERM"]);
	assert.equal(fake.calls.length, 1);

	const already = fakeSpawn({ stdout: STREAM });
	const aborted = new AbortController();
	aborted.abort();
	assert.equal((await resolveAudio(TRACK, { spawn: already.spawn, signal: aborted.signal })).ok, false);
	assert.equal(already.calls.length, 0);
});

// S4/S8: stderr can carry cookie names; it is classified, never copied into the message or hint.
test("S4/S8 stderr never reaches the message; sign-in, network and missing yt-dlp are classified", async () => {
	const account = { browser: "firefox" as const, profile: "default-release" };
	const signin = await resolveAudio(TRACK, { spawn: fakeSpawn({ code: 1, stderr: SECRET }).spawn, account, cookieArg: "firefox:default-release" });
	assert.deepEqual(signin, {
		ok: false,
		error: { kind: "signin", message: "YouTube session not found in Firefox.", hint: "Sign in at youtube.com in Firefox, then retry." },
	});
	assert.ok(!JSON.stringify(signin).includes("supersecret"));

	const network = await resolveAudio(TRACK, { spawn: fakeSpawn({ code: 1, stderr: "ERROR: Unable to download webpage: timed out" }).spawn });
	assert.deepEqual(network, {
		ok: false,
		error: { kind: "network", message: "Could not reach YouTube.", hint: "Check your connection and retry." },
	});

	const enoent = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
	const missing = fakeSpawn({ error: enoent });
	assert.deepEqual(await resolveAudio(TRACK, { spawn: missing.spawn }), {
		ok: false,
		error: { kind: "missing", message: "yt-dlp not found", hint: "Install it: sudo pacman -S yt-dlp (or pipx install yt-dlp)" },
	});
	assert.equal(missing.calls.length, 1);
});

// S15: a hung yt-dlp is killed after timeoutMs, then the slow try runs.
test("S15 a try that exceeds timeoutMs is killed and retried without the extractor args", async () => {
	const fake = fakeSpawn({ hang: true }, { stdout: `${STREAM}\n` });
	const result = await resolveAudio(TRACK, { spawn: fake.spawn, timeoutMs: 10 });
	assert.deepEqual(result, { ok: true, url: STREAM });
	assert.deepEqual(fake.killed, ["SIGTERM"]);
	assert.deepEqual(fake.calls[1].args, [...SLOW, TRACK.url]);
});

// S15: an id that looks like an option stays inside the one URL argument, last, never a flag of its own.
test("S15 a track id starting with '-' stays inside the single URL argument", async () => {
	const id = "-o/tmp/x --exec rm";
	const track = { ...TRACK, id, url: `https://www.youtube.com/watch?v=${id}` };
	const fake = fakeSpawn({ stdout: `${STREAM}\n` });
	assert.deepEqual(await resolveAudio(track, { spawn: fake.spawn, cookieArg: "firefox:default-release" }), { ok: true, url: STREAM });
	assert.deepEqual(fake.calls[0].args, [...FAST, track.url]);
	assert.ok(!fake.calls[0].args.some((arg) => arg.startsWith("-o") || arg === "--exec"));
});

// S15: only https stream URLs reach mpv.
test("S15 non-https outputs are rejected", async () => {
	for (const stdout of [
		"http://rr1.googlevideo.com/a\n",
		"file:///etc/passwd\n",
		"ytdl://abc123\n",
		"HTTPS://rr1.googlevideo.com/a\n",
		"   \n\t\n",
	]) {
		const fake = fakeSpawn({ stdout });
		const result = await resolveAudio(TRACK, { spawn: fake.spawn });
		assert.deepEqual(
			result,
			{
				ok: false,
				error: {
					kind: "extract",
					message: "yt-dlp could not read YouTube.",
					hint: "Update yt-dlp (yt-dlp -U or your package manager) and retry.",
				},
			},
			stdout,
		);
		assert.equal(fake.calls.length, 2);
	}
});

// S4: neither try copies stderr into the result.
test("S4 a secret in stderr never appears in the error on either try", async () => {
	const account = { browser: "firefox" as const, profile: "default-release" };
	for (const scripts of [
		[{ code: 1, stderr: SECRET }, { code: 1, stderr: "ERROR: unable to extract" }],
		[{ code: 1, stderr: "ERROR: unable to extract" }, { code: 1, stderr: SECRET }],
		[{ code: 1, stderr: SECRET }],
	]) {
		const fake = fakeSpawn(...scripts);
		const result = await resolveAudio(TRACK, { spawn: fake.spawn, account, cookieArg: "firefox:default-release" });
		assert.equal(result.ok, false);
		assert.equal(fake.calls.length, 2);
		assert.ok(!JSON.stringify(result).includes("supersecret"), JSON.stringify(result));
		assert.ok(!JSON.stringify(result).includes("SID="), JSON.stringify(result));
	}
});

// S15: cancelling while the slow retry runs kills that child too.
test("S15 cancel during the retry kills the second child", async () => {
	const fake = fakeSpawn({ code: 1, stderr: "ERROR: something" }, { hang: true });
	const controller = new AbortController();
	const pending = resolveAudio(TRACK, { spawn: fake.spawn, signal: controller.signal });
	while (fake.calls.length < 2) await new Promise((r) => setImmediate(r));
	controller.abort();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.deepEqual(fake.killed, ["SIGTERM"]);
	assert.equal(fake.calls.length, 2);
});

// S15: two hung tries are both killed and the result is a network error.
test("S15 a double timeout kills both children", async () => {
	const fake = fakeSpawn({ hang: true });
	const result = await resolveAudio(TRACK, { spawn: fake.spawn, timeoutMs: 10 });
	assert.deepEqual(result, {
		ok: false,
		error: { kind: "network", message: "Could not reach YouTube.", hint: "Check your connection and retry." },
	});
	assert.deepEqual(fake.killed, ["SIGTERM", "SIGTERM"]);
	assert.equal(fake.calls.length, 2);
});

// S16: a fresh YouTube stream link answers 403 for about 2 s; mpv skipped the track when it got the link at once.
test("S16 with a probe, the link is returned only once it stops answering 403", async () => {
	const answers = [403, 403, 206];
	const probed: string[] = [];
	const fake = fakeSpawn({ stdout: `${STREAM}\n` });
	const result = await resolveAudio(TRACK, {
		spawn: fake.spawn,
		pollMs: 1,
		probe: async (url) => {
			probed.push(url);
			return answers.shift() ?? 206;
		},
	});
	assert.deepEqual(result, { ok: true, url: STREAM });
	assert.deepEqual(probed, [STREAM, STREAM, STREAM]);
	assert.equal(fake.calls.length, 1);
});

// S16: the wait is bounded; mpv's own 403 retry covers a link that is still not ready, and other answers end it at once.
test("S16 the readiness wait gives the link to mpv after readyTimeoutMs or on any other answer", async () => {
	let slow = 0;
	const late = await resolveAudio(TRACK, {
		spawn: fakeSpawn({ stdout: `${STREAM}\n` }).spawn,
		pollMs: 1,
		readyTimeoutMs: 20,
		probe: async () => {
			slow++;
			return 403;
		},
	});
	assert.deepEqual(late, { ok: true, url: STREAM });
	assert.ok(slow >= 2, `probed ${slow} times`);

	for (const probe of [async () => 200, async () => 404, async (): Promise<number> => Promise.reject(new Error("offline"))]) {
		let calls = 0;
		const result = await resolveAudio(TRACK, {
			spawn: fakeSpawn({ stdout: `${STREAM}\n` }).spawn,
			pollMs: 1,
			probe: () => {
				calls++;
				return probe();
			},
		});
		assert.deepEqual(result, { ok: true, url: STREAM });
		assert.equal(calls, 1);
	}
});

// S16: a queue change during the wait cancels it like any other resolve.
test("S16 abort during the readiness wait returns cancelled", async () => {
	const controller = new AbortController();
	let seen: AbortSignal | undefined;
	const pending = resolveAudio(TRACK, {
		spawn: fakeSpawn({ stdout: `${STREAM}\n` }).spawn,
		signal: controller.signal,
		pollMs: 1,
		probe: async (_url, signal) => {
			seen = signal;
			return 403;
		},
	});
	while (!seen) await new Promise((r) => setImmediate(r));
	controller.abort();
	assert.deepEqual(await pending, { ok: false, error: { kind: "extract", message: "cancelled", hint: "" } });
});

// S16 (verify advisory): the readiness wait never runs past readyTimeoutMs, even while a probe is slow.
// S12 (#25): proved without a wall-clock margin: the probe never answers, so only the readyTimeoutMs bound ends it.
test("S16 the readiness wait stays within readyTimeoutMs while probes are slow", async () => {
	const reasons: unknown[] = [];
	const result = await resolveAudio(TRACK, {
		spawn: fakeSpawn({ stdout: `${STREAM}\n` }).spawn,
		pollMs: 10,
		readyTimeoutMs: 20,
		probe: (_url, signal) =>
			new Promise<number>((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					reasons.push((signal.reason as Error).name);
					reject(new Error("aborted"));
				});
			}),
	});
	assert.deepEqual(result, { ok: true, url: STREAM });
	assert.deepEqual(reasons, ["TimeoutError"]);
});

// S16 (verify advisory): probeStream only contacts https links and never follows redirects.
test("S16 probeStream skips non-https links and does not follow redirects", async () => {
	const { createServer } = await import("node:http");
	let hits = 0;
	const server = createServer((req, res) => {
		hits++;
		res.writeHead(302, { location: "/elsewhere" }).end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		const port = (server.address() as { port: number }).port;
		assert.equal(await probeStream(`http://127.0.0.1:${port}/x`, new AbortController().signal), 0);
		assert.equal(hits, 0);
	} finally {
		server.close();
	}
	// A redirect answer is reported as is, not followed.
	const seen: RequestInit[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		seen.push(init);
		return new Response(null, { status: 302 });
	}) as typeof fetch;
	try {
		assert.equal(await probeStream("https://example.invalid/x", new AbortController().signal), 302);
		assert.equal(seen[0].redirect, "manual");
	} finally {
		globalThis.fetch = realFetch;
	}
});

// ---- S21 strategy table and failure classes ----

const ok = { stdout: `${STREAM}\n` };
const fails = (stderr: string) => ({ code: 1, stderr });
const usesVisionos = (args: string[]) => args.includes("youtube:player_client=visionos;skip=hls");
const BLOCKED = [
	"ERROR: [youtube] abc123: Sign in to confirm you're not a bot. Use --cookies-from-browser",
	"ERROR: [youtube] abc123: This content isn't available, try again later. not a bot",
	"ERROR: unable to download video data: HTTP Error 429: Too Many Requests",
	"WARNING: [youtube] abc123: visionos client https formats require a GVS PO Token which was not provided.\nERROR: [youtube] abc123: Requested format is not available",
	"ERROR: [youtube] abc123: The page needs to be reloaded.",
];
const VIDEO = [
	"ERROR: [youtube] abc123: Sign in to confirm your age. This video may be inappropriate for some users.",
	"ERROR: [youtube] abc123: Join this channel to get access to members-only content like this video",
	"ERROR: [youtube] abc123: Private video. Sign in if you've been granted access to this video",
	"ERROR: [youtube] abc123: This live event will begin in 3 hours.",
	"ERROR: [youtube] abc123: Requested format is not available. Use --list-formats for a list of available formats",
	"ERROR: [youtube] abc123: Video unavailable. This video has been removed by the uploader",
];

// S21(2): the player_skip=webpage try is gone; no run, whatever fails, passes it.
test("S21 no yt-dlp run ever passes player_skip=webpage", async () => {
	const cooldowns = new Map<string, number>();
	for (const scripts of [[ok], [fails("ERROR: something"), ok], [fails(BLOCKED[0])], [fails(VIDEO[0]), fails(VIDEO[0])]]) {
		for (const cookieArg of [undefined, "firefox:default-release"]) {
			const fake = fakeSpawn(...scripts);
			await resolveAudio(TRACK, { spawn: fake.spawn, cookieArg, cooldowns });
			assert.ok(fake.calls.length > 0);
			for (const call of fake.calls) assert.ok(!call.args.some((arg) => arg.includes("player_skip")), call.args.join(" "));
		}
	}
});

// S21: a video-specific failure (age, members-only, private, live, format, unavailable) only sends that track on.
test("S21 a video failure on visionos runs the full resolve and visionos stays on for the next track", async () => {
	for (const stderr of VIDEO) {
		const cooldowns = new Map<string, number>();
		const fake = fakeSpawn(fails(stderr), ok, ok);
		assert.deepEqual(await resolveAudio(TRACK, { spawn: fake.spawn, cooldowns }), { ok: true, url: STREAM }, stderr);
		assert.deepEqual(fake.calls.map((c) => c.args), [[...FAST, TRACK.url], [...SLOW, TRACK.url]], stderr);
		await resolveAudio({ ...TRACK, url: "https://www.youtube.com/watch?v=next" }, { spawn: fake.spawn, cooldowns });
		assert.equal(fake.calls.length, 3, stderr);
		assert.ok(usesVisionos(fake.calls[2].args), stderr);
		assert.equal(blockedRecently(cooldowns, undefined), false, stderr);
	}
});

// S21: a bot check or a refused client turns visionos off for every track for STRATEGY_COOLDOWN_MS, per account.
test("S21 a blocked visionos runs the full resolve and later tracks skip visionos until the cooldown ends", async () => {
	for (const stderr of BLOCKED) {
		const cooldowns = new Map<string, number>();
		let clock = 5_000_000;
		const fake = fakeSpawn(fails(stderr), ok);
		const opts = { spawn: fake.spawn, cooldowns, now: () => clock };
		assert.deepEqual(await resolveAudio(TRACK, opts), { ok: true, url: STREAM }, stderr);
		assert.deepEqual(fake.calls.map((c) => c.args), [[...FAST, TRACK.url], [...SLOW, TRACK.url]], stderr);
		assert.equal(blockedRecently(cooldowns, undefined, () => clock), true, stderr);

		const other = { ...TRACK, url: "https://www.youtube.com/watch?v=other" };
		clock += STRATEGY_COOLDOWN_MS - 1;
		const during = fakeSpawn(ok);
		assert.deepEqual(await resolveAudio(other, { ...opts, spawn: during.spawn }), { ok: true, url: STREAM });
		assert.deepEqual(during.calls.map((c) => c.args), [[...SLOW, other.url]], stderr);

		// Another account has its own cooldown.
		const signed = fakeSpawn(ok);
		await resolveAudio(other, { ...opts, spawn: signed.spawn, cookieArg: "firefox:default-release" });
		assert.ok(usesVisionos(signed.calls[0].args), stderr);

		clock += 1;
		assert.equal(blockedRecently(cooldowns, undefined, () => clock), false, stderr);
		const after = fakeSpawn(ok);
		await resolveAudio(other, { ...opts, spawn: after.spawn });
		assert.deepEqual(after.calls.map((c) => c.args), [[...FAST, other.url]], stderr);
	}
});

// S21: the full resolve is the last strategy, so a bot check there never skips it; it still pauses what can wait.
test("S21 a blocked full resolve is still tried next time and is reported as a recent block", async () => {
	const cooldowns = new Map<string, number>();
	const fake = fakeSpawn(fails(BLOCKED[0]));
	await resolveAudio(TRACK, { spawn: fake.spawn, cooldowns });
	assert.equal(fake.calls.length, 2);
	assert.equal(blockedRecently(cooldowns, undefined), true);
	const again = fakeSpawn(fails(BLOCKED[0]));
	await resolveAudio(TRACK, { spawn: again.spawn, cooldowns });
	assert.deepEqual(again.calls.map((c) => c.args), [[...SLOW, TRACK.url]]);
});

// S21/S4/S8: when every strategy fails the result is the classified error, never stderr.
test("S21 every strategy failing returns the existing error without stderr", async () => {
	const account = { browser: "firefox" as const, profile: "default-release" };
	const cases: [Script[], unknown][] = [
		[[fails("ERROR: unable to extract; SID=supersecret")], { kind: "extract", message: "yt-dlp could not read YouTube.", hint: "Update yt-dlp (yt-dlp -U or your package manager) and retry." }],
		[[fails(VIDEO[0]), fails(`${SECRET} not a bot`)], { kind: "network", message: "YouTube is limiting requests right now.", hint: "Wait a few minutes, then retry." }],
	];
	for (const [scripts, error] of cases) {
		const fake = fakeSpawn(...scripts);
		const result = await resolveAudio(TRACK, { spawn: fake.spawn, account, cookieArg: "firefox:default-release", cooldowns: new Map() });
		assert.deepEqual(result, { ok: false, error });
		assert.equal(fake.calls.length, 2);
		assert.ok(!JSON.stringify(result).includes("supersecret"));
	}
});

// S21: aborting during any strategy kills that run and starts no later strategy.
test("S21 abort during visionos or the full resolve stops without another strategy", async () => {
	for (const scripts of [[{ hang: true }], [fails("ERROR: something"), { hang: true }]]) {
		const fake = fakeSpawn(...scripts);
		const controller = new AbortController();
		const pending = resolveAudio(TRACK, { spawn: fake.spawn, signal: controller.signal, cooldowns: new Map() });
		while (fake.calls.length < scripts.length) await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		controller.abort();
		assert.deepEqual(await pending, { ok: false, error: { kind: "extract", message: "cancelled", hint: "" } });
		assert.deepEqual(fake.killed, ["SIGTERM"]);
		assert.equal(fake.calls.length, scripts.length);
	}
});

// S21 (worst case never slower): three video failures on visionos in a row, on different tracks, count as a block.
test("S21 three visionos video failures in a row on different tracks turn visionos off; a success resets the count", async () => {
	const cooldowns = new Map<string, number>();
	const t = (id: string) => ({ ...TRACK, url: `https://www.youtube.com/watch?v=${id}` });
	const fake = fakeSpawn(fails(VIDEO[0]), ok, fails(VIDEO[0]), ok, ok, fails(VIDEO[0]), ok, fails(VIDEO[0]), ok, fails(VIDEO[0]), ok, ok);
	const opts = { spawn: fake.spawn, cooldowns };
	await resolveAudio(t("a"), opts); // visionos video-fail, full ok
	await resolveAudio(t("b"), opts); // visionos video-fail, full ok
	await resolveAudio(t("c"), opts); // visionos ok → count resets
	await resolveAudio(t("d"), opts);
	await resolveAudio(t("e"), opts);
	assert.equal(blockedRecently(cooldowns, undefined), false, "only two in a row since the reset");
	await resolveAudio(t("f"), opts); // third in a row → blocked
	assert.equal(blockedRecently(cooldowns, undefined), true);
	await resolveAudio(t("g"), opts); // visionos skipped
	assert.ok(!usesVisionos(fake.calls.at(-1)!.args));
});

// S21 (verify B1): failures of any kind except cancel/missing count toward the streak, so a fast try that never works
// (e.g. timeouts) is turned off after VIDEO_STREAK_LIMIT picks instead of costing time on every pick.
test("S21 three 'other' visionos failures in a row turn visionos off", async () => {
	const cooldowns = new Map<string, number>();
	const t = (id: string) => ({ ...TRACK, url: `https://www.youtube.com/watch?v=${id}` });
	const other = { code: 1, stderr: "ERROR: something odd" };
	const fake = fakeSpawn(other, ok, other, ok, other, ok, ok);
	const opts = { spawn: fake.spawn, cooldowns };
	for (const id of ["a", "b", "c"]) await resolveAudio(t(id), opts);
	assert.equal(blockedRecently(cooldowns, undefined), true);
	await resolveAudio(t("d"), opts);
	assert.ok(!usesVisionos(fake.calls.at(-1)!.args));
	assert.equal(fake.calls.length, 7);
});

// S21 (verify A1/A2): rate limiting counts as a block; "This video is unavailable" as a video failure.
test("S21 rate-limited stderr is blocked and 'This video is unavailable' is a video failure", async () => {
	const limited = new Map<string, number>();
	await resolveAudio(TRACK, { spawn: fakeSpawn({ code: 1, stderr: "ERROR: This content isn't available, try again later. Your account has been rate-limited" }, ok).spawn, cooldowns: limited });
	assert.equal(blockedRecently(limited, undefined), true);
	const unavailable = new Map<string, number>();
	const t = (id: string) => ({ ...TRACK, url: `https://www.youtube.com/watch?v=${id}` });
	const gone = { code: 1, stderr: "ERROR: [youtube] x: This video is unavailable" };
	const fake = fakeSpawn(gone, ok, ok);
	await resolveAudio(t("x"), { spawn: fake.spawn, cooldowns: unavailable });
	await resolveAudio(t("y"), { spawn: fake.spawn, cooldowns: unavailable });
	assert.equal(blockedRecently(unavailable, undefined), false);
	assert.ok(usesVisionos(fake.calls[2].args), "a single video failure leaves visionos on");
});

// S11 (#25): a bot check or rate limit on the last strategy is reported as a block, not as a missing session or network.
test("S11 a block on every strategy is reported as a block, with or without an account", async () => {
	const account = { browser: "firefox" as const, profile: "default-release" };
	const BLOCK = { kind: "network", message: "YouTube is limiting requests right now.", hint: "Wait a few minutes, then retry." };
	for (const stderr of [BLOCKED[0], BLOCKED[2]]) {
		for (const signedIn of [{ account, cookieArg: "firefox:default-release" }, {}]) {
			const fake = fakeSpawn(fails(stderr));
			assert.deepEqual(await resolveAudio(TRACK, { spawn: fake.spawn, ...signedIn }), { ok: false, error: BLOCK }, stderr);
			assert.equal(fake.calls.length, 2);
		}
	}
	// Sign-in failures that are not a block keep their own diagnosis.
	const login = fakeSpawn(fails(SECRET));
	assert.deepEqual(await resolveAudio(TRACK, { spawn: login.spawn, account, cookieArg: "firefox:default-release" }), {
		ok: false,
		error: { kind: "signin", message: "YouTube session not found in Firefox.", hint: "Sign in at youtube.com in Firefox, then retry." },
	});
});

// S10 (#25): a cancel or a missing yt-dlp says nothing about the strategy, so they never count toward the streak.
test("S10 cancelled and missing visionos runs never turn visionos off", async () => {
	const t = (id: string) => ({ ...TRACK, url: `https://www.youtube.com/watch?v=${id}` });
	const cancelled = new Map<string, number>();
	for (const id of ["a", "b", "c"]) {
		const fake = fakeSpawn({ hang: true });
		const controller = new AbortController();
		const pending = resolveAudio(t(id), { spawn: fake.spawn, signal: controller.signal, cooldowns: cancelled });
		while (fake.calls.length < 1) await new Promise((r) => setImmediate(r));
		controller.abort();
		assert.deepEqual(await pending, { ok: false, error: { kind: "extract", message: "cancelled", hint: "" } });
	}
	assert.equal(blockedRecently(cancelled, undefined), false);
	const next = fakeSpawn(ok);
	await resolveAudio(t("d"), { spawn: next.spawn, cooldowns: cancelled });
	assert.deepEqual(next.calls.map((c) => c.args), [[...FAST, t("d").url]]);

	const missing = new Map<string, number>();
	const enoent = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
	for (const id of ["a", "b", "c"]) await resolveAudio(t(id), { spawn: fakeSpawn({ error: enoent }).spawn, cooldowns: missing });
	assert.equal(blockedRecently(missing, undefined), false);
	const found = fakeSpawn(ok);
	await resolveAudio(t("d"), { spawn: found.spawn, cooldowns: missing });
	assert.deepEqual(found.calls.map((c) => c.args), [[...FAST, t("d").url]]);
});

// S10 (#25): the full resolve has no fallback, so its failures never start a cooldown of their own.
test("S10 failures of the full resolve never count as a block", async () => {
	const t = (id: string) => ({ ...TRACK, url: `https://www.youtube.com/watch?v=${id}` });
	const cooldowns = new Map<string, number>();
	let clock = 1_000_000;
	const opts = { cooldowns, now: () => clock };
	// visionos is blocked at the start, then the full resolve fails on four tracks while visionos is skipped.
	await resolveAudio(t("a"), { ...opts, spawn: fakeSpawn(fails(BLOCKED[0]), fails("ERROR: something odd")).spawn });
	for (const id of ["b", "c", "d"]) {
		clock += 1000;
		const fake = fakeSpawn(fails("ERROR: something odd"));
		await resolveAudio(t(id), { ...opts, spawn: fake.spawn });
		assert.deepEqual(fake.calls.map((c) => c.args), [[...SLOW, t(id).url]]);
	}
	clock = 1_000_000 + STRATEGY_COOLDOWN_MS;
	assert.equal(blockedRecently(cooldowns, undefined, () => clock), false);
});

// S12 (#25): a block already turned the strategy off, so the failures before it start over once the cooldown ends.
test("S12 a block resets the failure streak", async () => {
	const t = (id: string) => ({ ...TRACK, url: `https://www.youtube.com/watch?v=${id}` });
	const cooldowns = new Map<string, number>();
	let clock = 1_000_000;
	const fake = fakeSpawn(fails(VIDEO[0]), ok, fails(VIDEO[0]), ok, fails(BLOCKED[0]), ok, fails(VIDEO[0]), ok, ok);
	const opts = { spawn: fake.spawn, cooldowns, now: () => clock };
	for (const id of ["a", "b", "c"]) await resolveAudio(t(id), opts); // two video failures, then a block
	assert.equal(blockedRecently(cooldowns, undefined, () => clock), true);
	clock += STRATEGY_COOLDOWN_MS;
	await resolveAudio(t("d"), opts); // one video failure after the cooldown
	assert.equal(blockedRecently(cooldowns, undefined, () => clock), false);
	await resolveAudio(t("e"), opts);
	assert.ok(usesVisionos(fake.calls.at(-1)!.args));
	assert.equal(fake.calls.length, 9);
});
