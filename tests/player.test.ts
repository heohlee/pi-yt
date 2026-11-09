import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createPlayer, type PlayerDeps, type Track } from "../lib/player.ts";
import { cookieArg } from "../lib/browsers.ts";

type Command = unknown[];

async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Real timers, but every live handle is tracked so tests can assert none remain. */
function trackedTimers() {
	const live = new Set<NodeJS.Timeout>();
	return {
		live,
		setTimeout: (fn: () => void, ms: number) => {
			const handle = setTimeout(() => {
				live.delete(handle);
				fn();
			}, ms);
			live.add(handle);
			return handle;
		},
		clearTimeout: (handle: unknown) => {
			live.delete(handle as NodeJS.Timeout);
			clearTimeout(handle as NodeJS.Timeout);
		},
	};
}

/** Fake mpv: a real Unix socket server that records commands and answers success. */
function fakeMpv(socketPath: string) {
	const clients: net.Socket[] = [];
	const commands: Command[] = [];
	/** Index of the client (in connection order) that sent each command. */
	const senders: number[] = [];
	/** mpv's playlist as `get_property playlist` reports it; playlist-pos marks the current entry. */
	let playlist: { id: number; filename: string }[] = [];
	/** mpv answers loadfile with the new entry's id; url → ids, in load order. */
	const entryIds = new Map<string, number[]>();
	let nextEntryId = 1;
	let failNext: string | undefined;
	/** What `get_property playlist-pos` answers; follows playlist-pos events unless a test sets it. */
	let position = -1;
	let server: net.Server | undefined;
	const events = new EventEmitter();
	const handle = (socket: net.Socket) => {
		const client = clients.length;
		clients.push(socket);
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as { command: Command; request_id?: number };
				commands.push(msg.command);
				senders.push(client);
				const error = failNext ?? "success";
				failNext = undefined;
				let data: unknown = null;
				const [name, arg, flag, index] = msg.command;
				if (name === "loadfile" && error === "success") {
					const id = nextEntryId++;
					const url = arg as string;
					entryIds.set(url, [...(entryIds.get(url) ?? []), id]);
					data = { playlist_entry_id: id };
					const entry = { id, filename: url };
					if (flag === "replace") playlist = [entry];
					else if (flag === "insert-at") playlist.splice(index as number, 0, entry);
					else playlist.push(entry);
				}
				if (name === "playlist-remove" && error === "success") playlist.splice(arg as number, 1);
				if (name === "stop" && error === "success") playlist = [];
				if (name === "get_property" && arg === "playlist-pos") data = position;
				if (name === "get_property" && arg === "playlist")
					data = playlist.map((e, j) => (j === position ? { ...e, current: true, playing: true } : { ...e }));
				socket.write(`${JSON.stringify({ request_id: msg.request_id, error, data })}\n`);
				if (msg.command[0] === "quit") void api.close().then(() => events.emit("quit"));
			}
		});
	};
	const api = {
		commands,
		events,
		/** Commands other than the initial observe_property batch and get_property queries. */
		actions: () => commands.filter((c) => c[0] !== "observe_property" && c[0] !== "get_property"),
		/** actions() sent by one client, in connection order (0 is the first player). */
		actionsBy: (client: number) =>
			commands.filter((c, i) => senders[i] === client && c[0] !== "observe_property" && c[0] !== "get_property"),
		/** Make mpv's playlist-pos answer change without sending an event, like a track advancing mid-swap. */
		setPosition(pos: number) {
			position = pos;
		},
		failNext(error: string) {
			failNext = error;
		},
		async listen() {
			server = net.createServer(handle);
			await new Promise<void>((resolve, reject) => {
				server!.once("error", reject);
				server!.listen(socketPath, () => resolve());
			});
		},
		send(name: string, data: unknown) {
			if (name === "playlist-pos" && typeof data === "number") position = data;
			for (const c of clients) c.write(`${JSON.stringify({ event: "property-change", id: 1, name, data })}\n`);
		},
		/** Send a plain mpv event such as end-file. */
		event(body: Record<string, unknown>) {
			for (const c of clients) c.write(`${JSON.stringify(body)}\n`);
		},
		/** Id of the last entry loaded with this url. */
		entryId: (url: string) => entryIds.get(url)?.at(-1),
		isListening: () => server?.listening === true,
		async close() {
			for (const c of clients) c.destroy();
			const s = server;
			server = undefined;
			if (s?.listening) await new Promise<void>((r) => s.close(() => r()));
		},
	};
	return api;
}

interface SpawnCall {
	command: string;
	args: string[];
	options: unknown;
}

/** Fake spawn: records the call and starts the fake mpv server, like a real mpv would. */
function fakeSpawn(mpv: ReturnType<typeof fakeMpv>, opts: { error?: NodeJS.ErrnoException; start?: boolean } = {}) {
	const calls: SpawnCall[] = [];
	const kills: unknown[] = [];
	const spawn = (command: string, args: string[], options: unknown) => {
		calls.push({ command, args, options });
		const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
		child.kill = (signal?: string) => {
			kills.push(signal);
			queueMicrotask(() => child.emit("exit", null, signal ?? "SIGTERM"));
			return true;
		};
		mpv.events.once("quit", () => child.emit("exit", 0, null));
		if (opts.error) process.nextTick(() => child.emit("error", opts.error));
		else if (opts.start !== false) void mpv.listen();
		return child;
	};
	return { spawn, calls, kills };
}

async function setup(extra: Partial<PlayerDeps> & { spawnOpts?: Parameters<typeof fakeSpawn>[1]; prelisten?: boolean } = {}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "gsyt-player-"));
	const socketPath = path.join(dir, "pi-yt", "mpv.sock");
	const mpv = fakeMpv(socketPath);
	const spawner = fakeSpawn(mpv, extra.spawnOpts);
	const timers = trackedTimers();
	const { spawnOpts: _s, prelisten: _p, ...rest } = extra;
	const player = createPlayer({
		socketPath,
		spawn: spawner.spawn as PlayerDeps["spawn"],
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		...rest,
	});
	const teardown = async () => {
		player.dispose();
		await mpv.close();
		await rm(dir, { recursive: true, force: true });
	};
	return { dir, socketPath, mpv, spawner, timers, player, teardown };
}

const track = (n: number, artist: string | null = `Artist ${n}`): Track => ({
	id: `id${n}`,
	title: `Title ${n}`,
	artist,
	duration: 100 + n,
	url: `https://www.youtube.com/watch?v=id${n}`,
});

/** S16: every entry carries its title, so mpv's media-title is never the watch URL. */
const watch = (t: Track, flag: string, index = -1) => ["loadfile", t.url, flag, index, `force-media-title=${t.title}`];

const BASE_ARGS = ["--idle=yes", "--no-video", "--no-terminal", "--force-window=no"];
// S14: mpv prefetches the next track and asks yt-dlp for audio only.
// S16: a fresh YouTube stream link answers 403 for about 2 s; ffmpeg retries it instead of skipping the track.
const SPEED_ARGS = [
	"--prefetch-playlist=yes",
	"--ytdl-format=bestaudio/best",
	"--stream-lavf-o-append=reconnect=1",
	"--stream-lavf-o-append=reconnect_on_http_error=403",
	"--stream-lavf-o-append=reconnect_delay_max=5",
	// S17(2): the ytdl hook's yt-dlp solves YouTube's JS challenge with Pi's node.
	`--ytdl-raw-options-append=js-runtimes=node:${process.execPath}`,
];

test("S5/S14 spawns mpv with exact args (prefetch, audio only), socket dir 0700, no cookie option without cookieArg", async () => {
	const t = await setup();
	try {
		await t.player.ensureRunning();
		assert.equal(t.spawner.calls.length, 1);
		assert.deepEqual(t.spawner.calls[0], {
			command: "mpv",
			args: [...BASE_ARGS, `--input-ipc-server=${t.socketPath}`, ...SPEED_ARGS],
			options: { detached: false, stdio: "ignore" },
		});
		assert.equal(statSync(path.dirname(t.socketPath)).mode & 0o777, 0o700);
		assert.equal(t.player.getState().running, true);
	} finally {
		await t.teardown();
	}
});

test("S4/S5/S14 passes the browser to yt-dlp through mpv when cookieArg returns a value", async () => {
	const t = await setup({ cookieArg: () => "firefox:default-release" });
	try {
		await t.player.ensureRunning();
		assert.deepEqual(t.spawner.calls[0].args, [
			...BASE_ARGS,
			`--input-ipc-server=${t.socketPath}`,
			...SPEED_ARGS,
			"--ytdl-raw-options-append=cookies-from-browser=firefox:default-release",
		]);
	} finally {
		await t.teardown();
	}
});

// S17: mpv's ytdl hook runs the yt-dlp /yt resolved (system or managed).
test("S17 passes the resolved yt-dlp to mpv's ytdl hook when ytDlpPath returns one", async () => {
	const ytDlp = "/h/.local/share/pi-yt/bin/yt-dlp";
	const t = await setup({ ytDlpPath: () => ytDlp, cookieArg: () => "firefox:default-release" });
	try {
		await t.player.ensureRunning();
		assert.deepEqual(t.spawner.calls[0].args, [
			...BASE_ARGS,
			`--input-ipc-server=${t.socketPath}`,
			"--prefetch-playlist=yes",
			"--ytdl-format=bestaudio/best",
			"--stream-lavf-o-append=reconnect=1",
			"--stream-lavf-o-append=reconnect_on_http_error=403",
			"--stream-lavf-o-append=reconnect_delay_max=5",
			`--ytdl-raw-options-append=js-runtimes=node:${process.execPath}`,
			`--script-opts-append=ytdl_hook-ytdl_path=${ytDlp}`,
			"--ytdl-raw-options-append=cookies-from-browser=firefox:default-release",
		]);
	} finally {
		await t.teardown();
	}
});

// S13: mpv passes Helium to yt-dlp as a Chromium profile path.
test("S13 passes a Helium profile path to yt-dlp through mpv", async () => {
	const t = await setup({ cookieArg: () => cookieArg({ id: "helium", profile: "/h/.config/net.imput.helium/Default" }) });
	try {
		await t.player.ensureRunning();
		assert.deepEqual(t.spawner.calls[0].args, [
			...BASE_ARGS,
			`--input-ipc-server=${t.socketPath}`,
			...SPEED_ARGS,
			"--ytdl-raw-options-append=cookies-from-browser=chromium:/h/.config/net.imput.helium/Default",
		]);
	} finally {
		await t.teardown();
	}
});

test("S5 reuses a live mpv on the socket without spawning, and stop() does not quit it", async () => {
	const t = await setup();
	try {
		await rm(path.dirname(t.socketPath), { recursive: true, force: true });
		await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(t.socketPath), { recursive: true }));
		await t.mpv.listen();
		await t.player.ensureRunning();
		await t.player.ensureRunning();
		assert.equal(t.spawner.calls.length, 0);
		await t.player.stop();
		assert.equal(t.mpv.commands.some((c) => c[0] === "quit"), false);
		assert.equal(t.mpv.isListening(), true);
		assert.equal(t.player.getState().running, false);
	} finally {
		await t.teardown();
	}
});

test("S5 removes a stale socket file before spawning", async () => {
	const t = await setup();
	try {
		await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(t.socketPath), { recursive: true }));
		await writeFile(t.socketPath, "stale");
		let existedAtSpawn: boolean | undefined;
		const inner = t.spawner.spawn;
		const player = createPlayer({
			socketPath: t.socketPath,
			spawn: ((c: string, a: string[], o: unknown) => {
				existedAtSpawn = existsSync(t.socketPath);
				return inner(c, a, o);
			}) as PlayerDeps["spawn"],
		});
		await player.ensureRunning();
		assert.equal(existedAtSpawn, false);
		assert.equal(player.getState().running, true);
		player.dispose();
	} finally {
		await t.teardown();
	}
});

test("S8 missing mpv rejects with the exact install hint", async () => {
	const enoent = Object.assign(new Error("spawn mpv ENOENT"), { code: "ENOENT" });
	const t = await setup({ spawnOpts: { error: enoent } });
	try {
		await assert.rejects(t.player.ensureRunning(), (err: unknown) => {
			assert.deepEqual(err, { kind: "missing", message: "mpv not found", hint: "Install it: sudo pacman -S mpv" });
			return true;
		});
		assert.equal(t.timers.live.size, 0);
	} finally {
		await t.teardown();
	}
});

test("S8 mpv that never opens its socket rejects with the start error after the deadline", async () => {
	let clock = 0;
	const t = await setup({ spawnOpts: { start: false }, now: () => (clock += 600) });
	try {
		await assert.rejects(t.player.ensureRunning(), (err: unknown) => {
			assert.deepEqual(err, {
				kind: "start",
				message: "mpv did not start",
				hint: "Run mpv --version to check your install.",
			});
			return true;
		});
		assert.equal(t.timers.live.size, 0);
	} finally {
		await t.teardown();
	}
});

test("S5 observes the player properties on connect", async () => {
	const t = await setup();
	try {
		await t.player.ensureRunning();
		await waitFor(() => t.mpv.commands.length >= 8, "observe commands");
		const observed = t.mpv.commands.filter((c) => c[0] === "observe_property").map((c) => c[2]);
		assert.deepEqual(observed, [
			"pause",
			"time-pos",
			"duration",
			"media-title",
			"playlist-pos",
			"volume",
			"idle-active",
			"playlist",
		]);
	} finally {
		await t.teardown();
	}
});

test("S5 play() replaces the queue in order and jumps to startIndex", async () => {
	const t = await setup();
	try {
		const tracks = [track(1), track(2), track(3)];
		await t.player.play(tracks, 2);
		assert.deepEqual(t.mpv.actions(), [
			watch(tracks[0], "replace"),
			watch(tracks[1], "append"),
			watch(tracks[2], "append"),
			["playlist-play-index", 2],
		]);
		assert.deepEqual(t.player.getState().queue, tracks);

		await t.player.play([track(4)]);
		assert.deepEqual(t.mpv.actions().slice(4), [watch(track(4), "replace")]);
		assert.deepEqual(t.player.getState().queue, [track(4)]);
	} finally {
		await t.teardown();
	}
});

test("S5 enqueue() appends with append-play and extends the mirror", async () => {
	const t = await setup();
	try {
		await t.player.play([track(1)]);
		await t.player.enqueue(track(2));
		assert.deepEqual(t.mpv.actions().at(-1), watch(track(2), "append-play"));
		assert.deepEqual(t.player.getState().queue, [track(1), track(2)]);
	} finally {
		await t.teardown();
	}
});

test("S5 pause, next, prev and volume send exact commands; volume clamps to 0–100", async () => {
	const t = await setup();
	try {
		await t.player.ensureRunning();
		await t.player.togglePause();
		await t.player.next();
		await t.player.prev();
		await t.player.setVolume(150);
		await t.player.setVolume(-5);
		await t.player.setVolume(60);
		assert.deepEqual(t.mpv.actions(), [
			["cycle", "pause"],
			["playlist-next"],
			["playlist-prev"],
			["set_property", "volume", 100],
			["set_property", "volume", 0],
			["set_property", "volume", 60],
		]);
	} finally {
		await t.teardown();
	}
});

// S23: `.`/`,` seek 5 s relative (mpv clamps at 0); a progress-bar click seeks to an absolute second.
test("S23 seek sends mpv seek relative, or absolute for a position", async () => {
	const t = await setup();
	try {
		await t.player.ensureRunning();
		await t.player.seek(5);
		await t.player.seek(-5);
		await t.player.seek(126, true);
		assert.deepEqual(t.mpv.actions(), [
			["seek", 5, "relative"],
			["seek", -5, "relative"],
			["seek", 126, "absolute"],
		]);
	} finally {
		await t.teardown();
	}
});

test("S8 a command mpv rejects comes back as a rejected {kind,message,hint}", async () => {
	const t = await setup();
	try {
		await t.player.ensureRunning();
		await waitFor(() => t.mpv.commands.length >= 8, "observe commands");
		t.mpv.failNext("error running command");
		await assert.rejects(t.player.next(), (err: Record<string, unknown>) => {
			assert.equal(err.kind, "command");
			assert.equal(typeof err.message, "string");
			assert.equal(typeof err.hint, "string");
			return true;
		});
	} finally {
		await t.teardown();
	}
});

test("S8 commands before mpv runs reject instead of throwing", async () => {
	const t = await setup();
	try {
		await assert.rejects(t.player.togglePause(), (err: Record<string, unknown>) => {
			assert.equal(err.kind, "not-running");
			return true;
		});
		assert.equal(t.spawner.calls.length, 0);
	} finally {
		await t.teardown();
	}
});

test("S2/S5 getState takes title/artist from the mirror at playlist-pos, falls back to media-title", async () => {
	const t = await setup();
	try {
		assert.deepEqual(t.player.getState(), {
			running: false,
			idle: true,
			paused: false,
			title: null,
			artist: null,
			elapsed: 0,
			duration: null,
			volume: 100,
			shuffle: false,
			position: -1,
			queue: [],
			resolving: false,
		});
		await t.player.play([track(1), track(2, null)]);
		t.mpv.send("idle-active", false);
		t.mpv.send("media-title", "watch?v=id2");
		t.mpv.send("playlist-pos", 1);
		t.mpv.send("time-pos", 12.5);
		t.mpv.send("duration", 200);
		t.mpv.send("volume", 60);
		t.mpv.send("pause", true);
		await waitFor(() => t.player.getState().paused, "pause");
		const state = t.player.getState();
		assert.equal(state.title, "Title 2");
		assert.equal(state.artist, null);
		assert.equal(state.position, 1);
		assert.equal(state.elapsed, 12.5);
		assert.equal(state.duration, 200);
		assert.equal(state.volume, 60);
		assert.equal(state.idle, false);

		t.mpv.send("playlist-pos", 0);
		await waitFor(() => t.player.getState().position === 0, "pos 0");
		assert.equal(t.player.getState().title, "Title 1");
		assert.equal(t.player.getState().artist, "Artist 1");

		t.mpv.send("playlist-pos", 5);
		await waitFor(() => t.player.getState().position === 5, "pos 5");
		assert.equal(t.player.getState().title, "watch?v=id2");
		assert.equal(t.player.getState().artist, null);
	} finally {
		await t.teardown();
	}
});

test("S5 time-pos changes notify at most once per second; other changes notify immediately", async () => {
	let clock = 10_000;
	const t = await setup({ now: () => clock });
	try {
		await t.player.ensureRunning();
		const seen: number[] = [];
		const unsubscribe = t.player.onChange((s) => seen.push(s.elapsed));
		t.mpv.send("time-pos", 1);
		await waitFor(() => t.player.getState().elapsed === 1, "t1");
		clock += 400;
		t.mpv.send("time-pos", 1.4);
		await waitFor(() => t.player.getState().elapsed === 1.4, "t1.4");
		clock += 400;
		t.mpv.send("time-pos", 1.8);
		await waitFor(() => t.player.getState().elapsed === 1.8, "t1.8");
		assert.deepEqual(seen, [1]);
		clock += 200;
		t.mpv.send("time-pos", 2);
		await waitFor(() => seen.length === 2, "second tick");
		assert.deepEqual(seen, [1, 2]);
		t.mpv.send("pause", true);
		await waitFor(() => seen.length === 3, "pause notifies immediately");

		unsubscribe();
		t.mpv.send("pause", false);
		await waitFor(() => !t.player.getState().paused, "unpause");
		assert.equal(seen.length, 3);
	} finally {
		await t.teardown();
	}
});

test("S5 a throwing listener does not break other listeners or the player", async () => {
	const t = await setup();
	try {
		await t.player.ensureRunning();
		let calls = 0;
		t.player.onChange(() => {
			throw new Error("boom");
		});
		t.player.onChange(() => calls++);
		t.mpv.send("volume", 42);
		await waitFor(() => calls === 1, "second listener");
		assert.equal(t.player.getState().volume, 42);
	} finally {
		await t.teardown();
	}
});

test("S2/S5 setShuffle sends shuffle/unshuffle and reorders the mirror from mpv's playlist", async () => {
	const t = await setup();
	try {
		const tracks = [track(1), track(2), track(3)];
		await t.player.play(tracks);
		await t.player.setShuffle(true);
		assert.deepEqual(t.mpv.actions().at(-1), ["playlist-shuffle"]);
		assert.equal(t.player.getState().shuffle, true);
		t.mpv.send("playlist", [{ filename: tracks[2].url }, { filename: tracks[0].url, current: true }, { filename: tracks[1].url }]);
		await waitFor(() => t.player.getState().queue[0]?.id === "id3", "reordered");
		assert.deepEqual(t.player.getState().queue, [tracks[2], tracks[0], tracks[1]]);

		await t.player.setShuffle(false);
		assert.deepEqual(t.mpv.actions().at(-1), ["playlist-unshuffle"]);
		assert.equal(t.player.getState().shuffle, false);
		t.mpv.send("playlist", tracks.map((x) => ({ filename: x.url })));
		await waitFor(() => t.player.getState().queue[0]?.id === "id1", "restored");
		assert.deepEqual(t.player.getState().queue, tracks);
	} finally {
		await t.teardown();
	}
});

test("S5 stop() quits the mpv we spawned and leaves no timers", async () => {
	const t = await setup();
	try {
		await t.player.play([track(1)]);
		await t.player.stop();
		assert.deepEqual(t.mpv.commands.at(-1), ["quit"]);
		assert.equal(t.mpv.isListening(), false);
		assert.equal(t.player.getState().running, false);
		assert.equal(t.timers.live.size, 0);
		assert.deepEqual(t.spawner.kills, []);
	} finally {
		await t.teardown();
	}
});

test("S5 stop() kills the child when mpv does not exit within 1 s", async () => {
	const t = await setup();
	try {
		await t.player.ensureRunning();
		t.mpv.events.removeAllListeners("quit");
		await t.player.stop();
		assert.deepEqual(t.spawner.kills, ["SIGTERM"]);
		assert.equal(t.timers.live.size, 0);
	} finally {
		await t.teardown();
	}
});

test("S5 dispose() closes the socket without quitting mpv and leaves no timers", async () => {
	const t = await setup();
	try {
		await t.player.play([track(1)]);
		t.player.dispose();
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(t.mpv.commands.some((c) => c[0] === "quit"), false);
		assert.equal(t.mpv.isListening(), true);
		assert.equal(t.player.getState().running, false);
		assert.equal(t.timers.live.size, 0);
	} finally {
		await t.teardown();
	}
});

// S15: fake yt-dlp resolver. Each track resolves at once unless the test holds it.
const stream = (t: Track) => `https://stream.example/${t.id}`;

function fakeResolver(opts: { hold?: string[]; fail?: string[] } = {}) {
	const calls: string[] = [];
	const signals = new Map<string, AbortSignal>();
	const held = new Map<string, (ok: boolean) => void>();
	const resolver: NonNullable<PlayerDeps["resolver"]> = (t, { signal }) => {
		calls.push(t.id);
		signals.set(t.id, signal);
		const answer = (ok: boolean) =>
			ok
				? { ok: true as const, url: stream(t) }
				: { ok: false as const, error: { kind: "extract", message: "yt-dlp could not read YouTube.", hint: "" } };
		if (opts.hold?.includes(t.id)) return new Promise((resolve) => held.set(t.id, (ok) => resolve(answer(ok))));
		return Promise.resolve(answer(!opts.fail?.includes(t.id)));
	};
	return {
		resolver,
		calls,
		signals,
		release(id: string, ok = true) {
			held.get(id)?.(ok);
			held.delete(id);
		},
	};
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const fast = (t: Track, index: number, flag = "insert-at") => ["loadfile", stream(t), flag, index, `force-media-title=${t.title}`];

test("S15 play() resolves the start track first, loads its stream with the title, appends the rest as watch URLs", async () => {
	const fake = fakeResolver({ hold: ["id1", "id2", "id3"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3)];
		const playing = t.player.play(tracks, 0);
		await waitFor(() => fake.calls.length === 1, "start resolve");
		assert.deepEqual(fake.calls, ["id1"]);
		assert.equal(t.player.getState().resolving, true);
		assert.deepEqual(t.mpv.actions(), []);
		fake.release("id1");
		await playing;
		assert.deepEqual(t.mpv.actions(), [
			fast(tracks[0], -1, "replace"),
			watch(tracks[1], "append"),
			watch(tracks[2], "append"),
		]);
		assert.equal(t.player.getState().resolving, false);
		assert.deepEqual(t.player.getState().queue, tracks);
	} finally {
		await t.teardown();
	}
});

test("S15 play() from a later index plays its stream and inserts the earlier tracks before it; commas in titles are quoted", async () => {
	const fake = fakeResolver({ hold: ["id1", "id2"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), { ...track(3), title: "Love, Death" }];
		await t.player.play(tracks, 2);
		assert.deepEqual(t.mpv.actions(), [
			["loadfile", stream(tracks[2]), "replace", -1, "force-media-title=%11%Love, Death"],
			watch(tracks[0], "insert-at", 0),
			watch(tracks[1], "insert-at", 1),
		]);
		assert.deepEqual(t.player.getState().queue, tracks);
	} finally {
		await t.teardown();
	}
});

test("S15 a failed start resolve falls back to the watch URL through mpv's ytdl hook", async () => {
	const fake = fakeResolver({ fail: ["id1"], hold: ["id2"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2)];
		await t.player.play(tracks);
		assert.deepEqual(t.mpv.actions(), [
			watch(tracks[0], "replace"),
			watch(tracks[1], "append"),
		]);
		assert.equal(t.player.getState().resolving, false);
	} finally {
		await t.teardown();
	}
});

test("S15 pre-resolves the next two tracks and swaps them with insert-at and playlist-remove", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3), track(4)];
		await t.player.play(tracks);
		await waitFor(() => t.mpv.actions().length === 8, "two swaps");
		await settle();
		assert.deepEqual(t.mpv.actions().slice(4), [
			fast(tracks[1], 1),
			["playlist-remove", 2],
			fast(tracks[2], 2),
			["playlist-remove", 3],
		]);
		assert.deepEqual(fake.calls, ["id1", "id2", "id3"]);
	} finally {
		await t.teardown();
	}
});

test("S15 never swaps the entry that is playing", async () => {
	const fake = fakeResolver({ hold: ["id2"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3)];
		await t.player.play(tracks);
		await waitFor(() => fake.calls.includes("id3"), "id3 resolve");
		t.mpv.send("playlist-pos", 1);
		await waitFor(() => t.player.getState().position === 1, "pos 1");
		fake.release("id2");
		await settle();
		const swaps = t.mpv.actions().filter((c) => c[2] === "insert-at");
		assert.deepEqual(swaps, [fast(tracks[2], 2)]);
		assert.equal(t.mpv.actions().some((c) => c[0] === "playlist-remove" && c[1] === 2), false);
	} finally {
		await t.teardown();
	}
});

test("S15 a track change pre-resolves the following tracks, skipping ones already resolved", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3), track(4), track(5)];
		await t.player.play(tracks);
		await waitFor(() => t.mpv.actions().length === 9, "first swaps");
		t.mpv.send("playlist-pos", 1);
		await waitFor(() => t.mpv.actions().length === 11, "next swap");
		await settle();
		assert.deepEqual(t.mpv.actions().slice(9), [fast(tracks[3], 3), ["playlist-remove", 4]]);
		assert.deepEqual(fake.calls, ["id1", "id2", "id3", "id4"]);
	} finally {
		await t.teardown();
	}
});

test("S15 enqueue() appends the watch URL and pre-resolves it when it is one of the next two", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.play([track(1)]);
		await t.player.enqueue(track(2));
		await waitFor(() => t.mpv.actions().length === 4, "swap");
		assert.deepEqual(t.mpv.actions(), [
			fast(track(1), -1, "replace"),
			watch(track(2), "append-play"),
			fast(track(2), 1),
			["playlist-remove", 2],
		]);
		assert.deepEqual(t.player.getState().queue, [track(1), track(2)]);
	} finally {
		await t.teardown();
	}
});

test("S15 a new queue cancels pending pre-resolves and never swaps the old tracks", async () => {
	const fake = fakeResolver({ hold: ["id2"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.play([track(1), track(2)]);
		await waitFor(() => fake.signals.has("id2"), "id2 resolve");
		await t.player.play([track(4)]);
		assert.equal(fake.signals.get("id2")!.aborted, true);
		fake.release("id2");
		await settle();
		assert.equal(t.mpv.actions().some((c) => c[1] === stream(track(2))), false);
		assert.deepEqual(t.mpv.actions().at(-1), fast(track(4), -1, "replace"));
	} finally {
		await t.teardown();
	}
});

test("S15 stream URLs older than 2 hours are resolved again", async () => {
	let clock = 0;
	const fake = fakeResolver({ hold: ["id2"] });
	const t = await setup({ resolver: fake.resolver, now: () => clock });
	try {
		await t.player.play([track(1)]);
		clock += 60 * 60 * 1000;
		await t.player.play([track(1)]);
		assert.deepEqual(fake.calls, ["id1"]);
		clock += 60 * 60 * 1000 + 1;
		await t.player.play([track(1)]);
		assert.deepEqual(fake.calls, ["id1", "id1"]);
	} finally {
		await t.teardown();
	}
});

test("S15 an mpv error on a swapped entry reloads its watch URL in place, once", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3)];
		await t.player.play(tracks);
		await waitFor(() => t.mpv.actions().length === 7, "swaps");
		const id = t.mpv.entryId(stream(tracks[1]));
		t.mpv.event({ event: "end-file", reason: "error", playlist_entry_id: id, file_error: "loading failed" });
		await waitFor(() => t.mpv.actions().length === 10, "reload");
		assert.deepEqual(t.mpv.actions().slice(7), [
			watch(tracks[1], "insert-at", 1),
			["playlist-remove", 2],
			["playlist-play-index", 1],
		]);
		t.mpv.event({ event: "end-file", reason: "error", playlist_entry_id: id, file_error: "loading failed" });
		t.mpv.event({ event: "end-file", reason: "error", playlist_entry_id: t.mpv.entryId(tracks[1].url), file_error: "x" });
		t.mpv.event({ event: "end-file", reason: "eof", playlist_entry_id: t.mpv.entryId(stream(tracks[2])) });
		t.mpv.send("playlist-pos", 0);
		await settle();
		assert.equal(t.mpv.actions().length, 10);
		assert.deepEqual(t.player.getState().queue, tracks);
	} finally {
		await t.teardown();
	}
});

// S16 (live run): the picked stream failed in mpv, mpv moved on, and playback ended up at index 4.
test("S16(b) play() from index 1: an mpv error on the picked stream reloads it in place with its title and plays it, order kept", async () => {
	const fake = fakeResolver({ hold: ["id3", "id4", "id5", "id6"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3), track(4), track(5), track(6)];
		await t.player.play(tracks, 1);
		assert.deepEqual(t.mpv.actions(), [
			fast(tracks[1], -1, "replace"),
			watch(tracks[2], "append"),
			watch(tracks[3], "append"),
			watch(tracks[4], "append"),
			watch(tracks[5], "append"),
			watch(tracks[0], "insert-at", 0),
		]);
		t.mpv.send("playlist-pos", 1);
		// mpv: the stream answers 403, the entry ends with an error and the next one starts.
		t.mpv.event({ event: "end-file", reason: "error", playlist_entry_id: t.mpv.entryId(stream(tracks[1])), file_error: "loading failed" });
		t.mpv.send("playlist-pos", 2);
		await waitFor(() => t.mpv.actions().length === 9, "reload");
		assert.deepEqual(t.mpv.actions().slice(6), [
			watch(tracks[1], "insert-at", 1),
			["playlist-remove", 2],
			["playlist-play-index", 1],
		]);
		t.mpv.send("playlist-pos", 1);
		await waitFor(() => t.player.getState().position === 1, "back on the picked track");
		await settle();
		assert.equal(t.player.getState().title, "Title 2");
		assert.deepEqual(t.player.getState().queue, tracks);
		assert.equal(t.mpv.actions().length, 9);
	} finally {
		await t.teardown();
	}
});

test("S15 media-title and stream filenames never change the mirror; shuffle still reorders it", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3)];
		await t.player.play(tracks);
		await waitFor(() => t.mpv.actions().length === 7, "swaps");
		t.mpv.send("media-title", "Forced title");
		t.mpv.send("playlist-pos", 0);
		await waitFor(() => t.player.getState().position === 0, "pos 0");
		assert.equal(t.player.getState().title, "Title 1");
		assert.equal(t.player.getState().artist, "Artist 1");

		t.mpv.send("playlist", [{ filename: stream(tracks[2]) }, { filename: stream(tracks[0]) }, { filename: stream(tracks[1]) }]);
		await waitFor(() => t.player.getState().queue[0]?.id === "id3", "reordered");
		assert.deepEqual(t.player.getState().queue, [tracks[2], tracks[0], tracks[1]]);
	} finally {
		await t.teardown();
	}
});

// S15: mpv may advance to the target entry after the in-memory check; the swap asks mpv again and stands down.
test("S15 skips a swap when mpv already plays the target entry, sending no insert or remove", async () => {
	const fake = fakeResolver({ hold: ["id2"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3)];
		await t.player.play(tracks);
		await waitFor(() => t.mpv.actions().some((c) => c[0] === "playlist-remove" && c[1] === 3), "id3 swap");
		t.mpv.setPosition(1);
		fake.release("id2");
		await settle();
		assert.equal(t.mpv.actions().some((c) => c[1] === stream(tracks[1])), false);
		assert.equal(t.mpv.actions().some((c) => c[0] === "playlist-remove" && c[1] === 2), false);
		assert.deepEqual(t.mpv.commands.filter((c) => c[0] === "get_property").at(-1), ["get_property", "playlist"]);
	} finally {
		await t.teardown();
	}
});

// S4/S15: after Disconnect or an account change no stream URL fetched with the old session is reused.
test("S4/S15 forgetStreams() drops cached stream URLs, so the next play resolves again", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.play([track(1)]);
		await t.player.play([track(1)]);
		assert.deepEqual(fake.calls, ["id1"]);
		t.player.forgetStreams();
		await t.player.play([track(1)]);
		assert.deepEqual(fake.calls, ["id1", "id1"]);
	} finally {
		await t.teardown();
	}
});

test("S4/S15 forgetStreams() cancels pending resolves, never swaps their result and keeps mpv playing", async () => {
	const fake = fakeResolver({ hold: ["id2", "id5"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.play([track(1), track(2)]);
		await waitFor(() => fake.signals.has("id2"), "id2 resolve");
		t.player.forgetStreams();
		assert.equal(fake.signals.get("id2")!.aborted, true);
		fake.release("id2");
		await settle();
		assert.equal(t.mpv.actions().some((c) => c[1] === stream(track(2))), false);
		assert.equal(t.mpv.commands.some((c) => c[0] === "quit" || c[0] === "stop"), false);
		assert.equal(t.player.getState().running, true);

		// A start resolve that finishes after forgetStreams() plays the watch URL, not the old-session stream.
		const playing = t.player.play([track(5)]);
		await waitFor(() => fake.signals.has("id5"), "id5 resolve");
		t.player.forgetStreams();
		assert.equal(fake.signals.get("id5")!.aborted, true);
		fake.release("id5");
		await playing;
		assert.deepEqual(t.mpv.actions().at(-1), watch(track(5), "replace"));
		const again = t.player.play([track(5)]);
		await waitFor(() => fake.calls.filter((id) => id === "id5").length === 2, "id5 resolved again");
		fake.release("id5");
		await again;
		assert.deepEqual(t.mpv.actions().at(-1), fast(track(5), -1, "replace"));
	} finally {
		await t.teardown();
	}
});

// S15: force-media-title values; a comma or leading quote, bracket or % uses mpv's %bytes% form.
test("S15 titles are passed to mpv as exact force-media-title values", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		const cases: [string, string][] = [
			['Café ñ, ✓ "x"', 'force-media-title=%17%Café ñ, ✓ "x"'],
			['"Quoted"', 'force-media-title=%8%"Quoted"'],
			["[x]", "force-media-title=%3%[x]"],
			["%5%abc", "force-media-title=%6%%5%abc"],
			["a=b,start=60", "force-media-title=%12%a=b,start=60"],
			["Café ñ ✓ 日本", "force-media-title=Café ñ ✓ 日本"],
		];
		for (const [i, [title, expected]] of cases.entries()) {
			const item = { ...track(10 + i), title };
			await t.player.play([item]);
			assert.deepEqual(t.mpv.actions().at(-1), ["loadfile", stream(item), "replace", -1, expected], title);
		}
	} finally {
		await t.teardown();
	}
});

// S4/S15 (verify B1): a stream resolved before forgetStreams() is never loaded, even if mpv was still starting.
test("S4/S15 forgetStreams() while mpv is still starting never plays the old-session stream", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver, spawnOpts: { start: false } });
	try {
		const playing = t.player.play([track(1)]);
		await waitFor(() => fake.calls.length === 1 && t.spawner.calls.length === 1, "resolve + spawn");
		await settle();
		t.player.forgetStreams();
		void t.mpv.listen();
		await playing;
		assert.deepEqual(t.mpv.actions().find((c) => c[0] === "loadfile"), watch(track(1), "replace"));
	} finally {
		await t.teardown();
	}
});

// S4 (verify advisory): the running mpv's ytdl hook switches to the current account's cookies.
test("S4 forgetStreams() updates the running mpv's cookie option to the current account", async () => {
	let cookie: string | undefined = "firefox:/h/old";
	const t = await setup({ cookieArg: () => cookie });
	try {
		await t.player.ensureRunning();
		cookie = "chromium:/h/new";
		t.player.forgetStreams();
		await waitFor(() => t.mpv.actions().filter((c) => c[0] === "change-list").length === 2, "switch cookies");
		cookie = undefined;
		t.player.forgetStreams();
		await waitFor(() => t.mpv.actions().filter((c) => c[0] === "change-list").length === 3, "drop cookies");
		assert.deepEqual(t.mpv.actions().filter((c) => c[0] === "change-list"), [
			["change-list", "ytdl-raw-options", "remove", "cookies-from-browser"],
			["change-list", "ytdl-raw-options", "append", "cookies-from-browser=chromium:/h/new"],
			["change-list", "ytdl-raw-options", "remove", "cookies-from-browser"],
		]);
	} finally {
		await t.teardown();
	}
});

// S4 (verify B1 on 7517701): a disconnect while mpv is starting still drops its cookies once it is up.
test("S4 forgetStreams() while mpv is starting switches its cookies once it is up", async () => {
	let cookie: string | undefined = "firefox:/h/old";
	const t = await setup({ cookieArg: () => cookie, spawnOpts: { start: false } });
	try {
		const starting = t.player.ensureRunning();
		await waitFor(() => t.spawner.calls.length === 1, "spawn");
		cookie = undefined;
		t.player.forgetStreams();
		void t.mpv.listen();
		await starting;
		await waitFor(() => t.mpv.actions().some((c) => c[0] === "change-list"), "drop cookies");
		await settle();
		assert.deepEqual(t.mpv.actions().filter((c) => c[0] === "change-list"), [
			["change-list", "ytdl-raw-options", "remove", "cookies-from-browser"],
		]);
	} finally {
		await t.teardown();
	}
});

// S4 (verify A1 on 7517701): two quick account changes end with the latest account's cookies.
test("S4 two quick forgetStreams() calls end with the current account's cookies", async () => {
	let cookie: string | undefined = "firefox:/h/old";
	const t = await setup({ cookieArg: () => cookie });
	try {
		await t.player.ensureRunning();
		cookie = "chromium:/h/b";
		t.player.forgetStreams();
		cookie = undefined;
		t.player.forgetStreams();
		await settle();
		await settle();
		const changes = t.mpv.actions().filter((c) => c[0] === "change-list");
		assert.deepEqual(changes.at(-1), ["change-list", "ytdl-raw-options", "remove", "cookies-from-browser"]);
		assert.ok(!changes.some((c) => c[3] === "cookies-from-browser=chromium:/h/b" && changes.indexOf(c) === changes.length - 1));
	} finally {
		await t.teardown();
	}
});

// S17 (verify A1): mpv's ytdl_hook splits ytdl_path on ":", so such a path is never handed to mpv.
test("S17 a yt-dlp path containing ':' is not passed to mpv's ytdl hook", async () => {
	const t = await setup({ ytDlpPath: () => "/h/odd:dir/pi-yt/bin/yt-dlp" });
	try {
		await t.player.ensureRunning();
		assert.ok(!t.spawner.calls[0].args.some((a: string) => a.startsWith("--script-opts-append=ytdl_hook-ytdl_path=")));
	} finally {
		await t.teardown();
	}
});

// S20 (live report): with a song playing, picking another one went back to the previous song.
// A second player on the same mpv (another Pi, or an earlier session) kept acting on its old queue:
// its late links replaced the new queue's entries and an mpv error on its old stream put its old song back.
test("S20 a player never swaps or reloads entries in a playlist another player loaded", async () => {
	const first = fakeResolver({ hold: ["id2", "id3"] });
	const t = await setup({ resolver: first.resolver });
	const second = fakeResolver();
	const other = createPlayer({ socketPath: t.socketPath, resolver: second.resolver });
	try {
		const old = [track(1), track(2), track(3)];
		await t.player.play(old);
		await waitFor(() => first.calls.includes("id3"), "first player's prefetch");
		const oldStream = t.mpv.entryId(stream(old[0]));

		const picked = [track(5), track(6), track(7)];
		await other.play(picked);
		await waitFor(() => t.mpv.actionsBy(1).some((c) => c[0] === "playlist-remove" && c[1] === 3), "second player's swaps");
		const before = t.mpv.actionsBy(0).length;

		// mpv moves on in the new queue; the first player's links arrive late and its old stream reports an error.
		t.mpv.send("playlist-pos", 1);
		first.release("id2");
		first.release("id3");
		t.mpv.event({ event: "end-file", reason: "error", playlist_entry_id: oldStream, file_error: "loading failed" });
		await settle();
		await settle();
		assert.deepEqual(t.mpv.actionsBy(0).slice(before), []);
		assert.deepEqual(other.getState().queue, picked);
	} finally {
		other.dispose();
		await t.teardown();
	}
});

// S20: the old song stops at once on a pick, and the player reports the picked track while its link resolves.
test("S20 picking another track stops the old one at once and reports the picked track while it resolves", async () => {
	const fake = fakeResolver({ hold: ["id5"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.play([track(1), track(2)]);
		t.mpv.send("idle-active", false);
		t.mpv.send("playlist-pos", 0);
		t.mpv.send("time-pos", 42);
		await waitFor(() => t.mpv.actions().some((c) => c[0] === "playlist-remove"), "swap");
		await waitFor(() => !t.player.getState().idle && t.player.getState().elapsed === 42, "playing");
		const before = t.mpv.actions().length;

		const picked = [track(4), track(5), track(6)];
		const playing = t.player.play(picked, 1);
		await waitFor(() => fake.calls.includes("id5"), "resolve");
		await settle();
		assert.deepEqual(t.mpv.actions().slice(before), [["stop"]]);
		const loading = t.player.getState();
		assert.deepEqual(
			{
				title: loading.title,
				artist: loading.artist,
				elapsed: loading.elapsed,
				duration: loading.duration,
				position: loading.position,
				resolving: loading.resolving,
				queue: loading.queue,
			},
			{ title: "Title 5", artist: "Artist 5", elapsed: 0, duration: 105, position: -1, resolving: true, queue: picked },
		);

		fake.release("id5");
		await playing;
		assert.deepEqual(t.mpv.actions().slice(before), [
			["stop"],
			fast(picked[1], -1, "replace"),
			watch(picked[2], "append"),
			watch(picked[0], "insert-at", 0),
		]);
		assert.equal(t.player.getState().resolving, false);
		assert.deepEqual(t.player.getState().queue, picked);
	} finally {
		await t.teardown();
	}
});

// S20: picking a track whose link is still being prepared waits for that resolve instead of starting another.
test("S20 picking a track whose link is still being prepared reuses that resolve", async () => {
	const fake = fakeResolver({ hold: ["id2", "id3"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const tracks = [track(1), track(2), track(3)];
		await t.player.play(tracks);
		await waitFor(() => fake.calls.includes("id3"), "prefetch");
		const prepared = fake.signals.get("id2")!;
		const playing = t.player.play(tracks, 1);
		await settle();
		assert.deepEqual(fake.calls, ["id1", "id2", "id3"]);
		assert.equal(prepared.aborted, false);
		assert.equal(fake.signals.get("id3")!.aborted, true);
		fake.release("id2");
		await playing;
		assert.deepEqual(t.mpv.actions().find((c) => c[2] === "replace" && c[1] === stream(tracks[1])), fast(tracks[1], -1, "replace"));
		assert.deepEqual(fake.calls.filter((id) => id === "id2"), ["id2"]);
	} finally {
		await t.teardown();
	}
});

// S20: two quick picks: the second one wins and the first one's resolve is cancelled.
test("S20 a second pick while the first one resolves cancels it and only the second track plays", async () => {
	const fake = fakeResolver({ hold: ["id1", "id4"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		const list = [track(1), track(2), track(3), track(4)];
		const firstPick = t.player.play(list, 0);
		await waitFor(() => fake.calls.includes("id1"), "first resolve");
		const secondPick = t.player.play(list, 3);
		await waitFor(() => fake.calls.includes("id4"), "second resolve");
		assert.equal(fake.signals.get("id1")!.aborted, true);
		assert.equal(t.player.getState().title, "Title 4");
		fake.release("id1");
		fake.release("id4");
		await Promise.all([firstPick, secondPick]);
		const replaces = t.mpv.actions().filter((c) => c[2] === "replace");
		assert.deepEqual(replaces, [fast(list[3], -1, "replace")]);
	} finally {
		await t.teardown();
	}
});

// S20 (verify follow-up): a pick that overtakes one still resolving stops mpv even if mpv still reports idle.
test("S20 a second pick during the first pick's resolve sends stop", async () => {
	const fake = fakeResolver({ hold: ["id1", "id2"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.ensureRunning();
		const first = t.player.play([track(1), track(2)], 0);
		await waitFor(() => fake.calls.includes("id1"), "first resolve");
		const second = t.player.play([track(1), track(2)], 1);
		await waitFor(() => fake.calls.includes("id2"), "second resolve");
		await waitFor(() => t.mpv.actions().some((c) => c[0] === "stop"), "stop on the overtaking pick");
		fake.release("id1");
		fake.release("id2");
		await Promise.allSettled([first, second]);
	} finally {
		await t.teardown();
	}
});

// S20 (R3-001): a track enqueued while a pick resolves is neither played early nor dropped by the pick.
test("R3-001 enqueue during a pending pick is appended after the picked track", async () => {
	const fake = fakeResolver({ hold: ["id4", "id5", "id9"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.ensureRunning();
		const picked = [track(4), track(5)];
		const playing = t.player.play(picked, 0);
		await waitFor(() => fake.calls.includes("id4"), "pick resolve");
		const queued = t.player.enqueue(track(9));
		await settle();
		assert.deepEqual(t.mpv.actions(), []);
		fake.release("id4");
		await Promise.all([playing, queued]);
		assert.deepEqual(t.mpv.actions(), [
			fast(picked[0], -1, "replace"),
			watch(picked[1], "append"),
			watch(track(9), "append"),
		]);
		assert.deepEqual(t.player.getState().queue, [...picked, track(9)]);
	} finally {
		await t.teardown();
	}
});

// ---- S21 dwell pre-resolve ----

// S21(3): a track prepared under the cursor plays from the shared cache, without resolving again.
test("S21 prepare() fills the stream cache and a later play() of that track loads its stream without a new resolve", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		t.player.prepare(track(1));
		await settle();
		assert.deepEqual(fake.calls, ["id1"]);
		await t.player.play([track(1)]);
		assert.deepEqual(fake.calls, ["id1"]);
		assert.deepEqual(t.mpv.actions(), [fast(track(1), -1, "replace")]);
	} finally {
		await t.teardown();
	}
});

// S21(3): one dwell prepare at a time; a newer one cancels it unless a pick shares that resolve.
test("S21 a second prepare() cancels the first, unless a pick is waiting for the first one's link", async () => {
	const fake = fakeResolver({ hold: ["id1", "id2", "id3"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		t.player.prepare(track(1));
		t.player.prepare(track(2));
		assert.deepEqual(fake.calls, ["id1", "id2"]);
		assert.equal(fake.signals.get("id1")!.aborted, true);
		assert.equal(fake.signals.get("id2")!.aborted, false);

		const playing = t.player.play([track(2)]);
		t.player.prepare(track(3));
		assert.equal(fake.signals.get("id2")!.aborted, false);
		assert.equal(fake.signals.get("id3")!.aborted, false);
		fake.release("id2");
		await playing;
		assert.deepEqual(t.mpv.actions().at(-1), fast(track(2), -1, "replace"));
		assert.deepEqual(fake.calls.filter((id) => id === "id2"), ["id2"]);
	} finally {
		await t.teardown();
	}
});

// S21(3): a track whose link is cached and fresh is not resolved again.
test("S21 prepare() of a track with a fresh cached link resolves nothing", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		await t.player.play([track(1)]);
		t.player.prepare(track(1));
		await settle();
		assert.deepEqual(fake.calls, ["id1"]);
	} finally {
		await t.teardown();
	}
});

// S21(3)/S4: an account change cancels a dwell prepare and its link is never used.
test("S21 forgetStreams() cancels a dwell prepare and drops its result", async () => {
	const fake = fakeResolver({ hold: ["id1"] });
	const t = await setup({ resolver: fake.resolver });
	try {
		t.player.prepare(track(1));
		assert.deepEqual(fake.calls, ["id1"]);
		t.player.forgetStreams();
		assert.equal(fake.signals.get("id1")!.aborted, true);
		fake.release("id1");
		await settle();
		const playing = t.player.play([track(1)]);
		await waitFor(() => fake.calls.length === 2, "resolved again");
		fake.release("id1");
		await playing;
		assert.deepEqual(fake.calls, ["id1", "id1"]);
	} finally {
		await t.teardown();
	}
});

// S21(3): preparing only resolves; mpv is neither started nor sent anything.
test("S21 prepare() never starts mpv or sends it a command", async () => {
	const fake = fakeResolver();
	const t = await setup({ resolver: fake.resolver });
	try {
		t.player.prepare(track(1));
		await settle();
		assert.equal(t.spawner.calls.length, 0);
		assert.equal(t.player.getState().running, false);
		await t.player.ensureRunning();
		await settle();
		const before = t.mpv.commands.length;
		t.player.prepare(track(2));
		await settle();
		assert.deepEqual(fake.calls, ["id1", "id2"]);
		assert.equal(t.mpv.commands.length, before);
	} finally {
		await t.teardown();
	}
});
