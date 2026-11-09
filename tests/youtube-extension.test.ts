import { test } from "node:test";
import assert from "node:assert/strict";
import { createYoutubeExtension, type YoutubeDeps } from "../extensions/youtube.ts";
import type { Player, PlayerDeps, PlayerState } from "../lib/player.ts";
import type { Track, TracksResult } from "../lib/youtube-source.ts";
import { stripAnsi, visibleWidth } from "../lib/text.ts";
import { STRATEGY_COOLDOWN_MS, resolveAudio as realResolveAudio } from "../lib/resolver.ts";
import type { SpawnFn } from "../lib/youtube-source.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const ACCOUNT = { browser: "firefox" as const, profile: "default-release" };
const TRACKS: Track[] = [
	{ id: "a", title: "Aruarian Dance", artist: "Nujabes", duration: 252, url: "https://www.youtube.com/watch?v=a" },
	{ id: "b", title: "Kerala", artist: "Bonobo", duration: 251, url: "https://www.youtube.com/watch?v=b" },
];
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakePlayer() {
	const calls: unknown[][] = [];
	const listeners = new Set<(s: PlayerState) => void>();
	const state: PlayerState = {
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
	};
	const record =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push([name, ...args]);
		};
	const player: Player = {
		ensureRunning: record("ensureRunning"),
		play: record("play"),
		enqueue: record("enqueue"),
		togglePause: record("togglePause"),
		next: record("next"),
		prev: record("prev"),
		setShuffle: record("setShuffle"),
		setVolume: record("setVolume"),
		seek: record("seek"),
		prepare: (track) => {
			calls.push(["prepare", track]);
		},
		forgetStreams: () => {
			calls.push(["forgetStreams"]);
		},
		getState: () => state,
		onChange: (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		stop: async () => {
			calls.push(["stop"]);
		},
		dispose: () => {
			calls.push(["dispose"]);
		},
	};
	return { player, calls, listeners, state };
}

/** Manual clock for the dwell timer and cooldowns: time only moves on advance(). */
function fakeClock() {
	let now = 1_000_000;
	let nextId = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		setTimeout: (fn: () => void, ms: number) => {
			timers.set(++nextId, { at: now + ms, fn });
			return nextId;
		},
		clearTimeout: (handle: unknown) => {
			timers.delete(handle as number);
		},
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
				if (timer.at > now || !timers.has(id)) continue;
				timers.delete(id);
				timer.fn();
			}
		},
	};
}

function harness(over: Partial<YoutubeDeps> = {}) {
	const fake = fakePlayer();
	const clock = fakeClock();
	const playerDeps: PlayerDeps[] = [];
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools: unknown[] = [];
	const writes: unknown[] = [];
	const pi = {
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		registerTool: (tool: unknown) => tools.push(tool),
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
	};
	const deps: YoutubeDeps = {
		createPlayer: (d) => {
			playerDeps.push(d ?? {});
			return fake.player;
		},
		readConfig: async () => ({ version: 1, account: ACCOUNT }),
		writeConfig: async (_location, config) => {
			writes.push(config);
		},
		detectBrowsers: async () => [{ id: "firefox", label: "Firefox", profileName: "default-release", profile: "default-release" }],
		resolveTools: async () => ({ ytDlp: { path: "/usr/bin/yt-dlp", source: "system" }, mpv: { path: "/usr/bin/mpv" } }),
		readOsRelease: async () => "ID=arch\n",
		platform: "linux",
		arch: "x64",
		env: {},
		source: {
			listSource: async () => ({ ok: true, tracks: TRACKS }),
			listPlaylists: async () => ({ ok: true, playlists: [] }),
			listPlaylist: async () => ({ ok: true, tracks: [] }),
			search: async () => ({ ok: true, tracks: [] }),
			verifySession: async () => ({ ok: true }),
		},
		home: "/nonexistent-home",
		// No network in tests: the update check answers nothing unless a test says otherwise.
		checkYtDlpUpdate: async () => null,
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		...over,
	};
	createYoutubeExtension(deps)(pi as never);
	return { fake, playerDeps, commands, handlers, tools, writes, clock };
}

const KEYS: Record<string, string> = {
	"\x1b[A": "tui.select.up",
	"\x1b[B": "tui.select.down",
	"\r": "tui.select.confirm",
	"\x1b": "tui.select.cancel",
};

/** A TUI ctx whose custom() captures the component and resolves when done() is called. */
function tuiCtx() {
	const notes: [string, string][] = [];
	const opened: {
		component?: { render(w: number): string[]; handleInput(d: string): void; handleMouse?(e: unknown): unknown; invalidate(): void; dispose?(): void };
		options?: unknown;
		renders: number;
	} = {
		renders: 0,
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string, type: string) => notes.push([message, type]),
			custom: (factory: (...args: unknown[]) => unknown, options: unknown) =>
				new Promise((resolve) => {
					opened.options = options;
					const tui = { requestRender: () => opened.renders++, terminal: { rows: 40, columns: 120 } };
					const theme = { fg: (_r: string, t: string) => t, bg: (_r: string, t: string) => t, bold: (t: string) => t };
					const keybindings = { matches: (data: string, id: string) => KEYS[data] === id };
					opened.component = factory(tui, theme, keybindings, (value: unknown) => {
						opened.component?.dispose?.();
						resolve(value);
					}) as typeof opened.component;
				}),
		},
	};
	return { ctx, notes, opened };
}

// S1/S9
test("registers exactly one command, yt, and no agent tool", () => {
	const { commands, tools } = harness();
	assert.deepEqual([...commands.keys()], ["yt"]);
	assert.equal(typeof commands.get("yt")?.description, "string");
	assert.deepEqual(tools, []);
});

// S1/S8: never crash headless; no overlay.
test("headless or non-tui modes notify an error and open nothing", async () => {
	const { commands } = harness();
	for (const ctx of [{ hasUI: false, mode: "print" }, { hasUI: true, mode: "rpc" }]) {
		const notes: unknown[][] = [];
		let customCalls = 0;
		await commands.get("yt")!.handler("", {
			...ctx,
			ui: { notify: (...args: unknown[]) => notes.push(args), custom: () => customCalls++ },
		});
		assert.deepEqual(notes, [["/yt needs the interactive terminal.", "error"]]);
		assert.equal(customCalls, 0);
	}
	await commands.get("yt")!.handler("", { hasUI: false, mode: "print" }); // no ui at all: no throw
});

// S1/S2/S5: opens a centered overlay, loads Recommended, plays from keys, cancels on close.
test("/yt opens the popover, runs effects and aborts pending loads on close", async () => {
	const signals: AbortSignal[] = [];
	let releaseLater: ((r: TracksResult) => void) | undefined;
	const { commands, fake, playerDeps } = harness({
		source: {
			listSource: (kind, opts) => {
				signals.push(opts!.signal!);
				if (kind === "recommended") return Promise.resolve({ ok: true, tracks: TRACKS });
				return new Promise((resolve) => (releaseLater = resolve));
			},
			listPlaylists: async () => ({ ok: true, playlists: [] }),
			listPlaylist: async () => ({ ok: true, tracks: [] }),
			search: async () => ({ ok: true, tracks: [] }),
			verifySession: async () => ({ ok: true }),
		},
	});
	const { ctx, opened } = tuiCtx();
	const closed = commands.get("yt")!.handler("ignored args", ctx);
	await tick();
	await tick();
	const component = opened.component!;
	assert.deepEqual(opened.options, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%" },
	});
	assert.equal(playerDeps[0].cookieArg?.(), "firefox:default-release");

	const lines = component.render(120).map(stripAnsi);
	assert.ok(lines.some((l) => l.includes("Aruarian Dance")), lines.join("\n"));
	assert.ok(component.render(120).every((l) => visibleWidth(l) <= 120));
	assert.ok(opened.renders > 0);

	component.handleInput("\t");
	component.handleInput("\r");
	component.handleInput(" ");
	await tick();
	assert.deepEqual(fake.calls, [["play", TRACKS, 0], ["togglePause"]]);
	assert.equal(fake.listeners.size, 1);

	component.handleInput("\t");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.ok(component.render(120).map(stripAnsi).some((l) => l.includes("Loading…")));
	component.handleInput("\x1b");
	await closed;
	assert.equal(signals.at(-1)!.aborted, true);
	assert.equal(fake.listeners.size, 0);
	releaseLater?.({ ok: true, tracks: TRACKS }); // late result after close is harmless
	await tick();
});

// S3: connecting verifies the session and stores only browser and profile.
test("connect flow verifies and writes the account", async () => {
	const listed: unknown[] = [];
	const { commands, writes, fake } = harness({
		readConfig: async () => ({ version: 1, account: null }),
		source: {
			listSource: async (_kind, opts) => {
				listed.push(opts?.account);
				return { ok: true, tracks: TRACKS };
			},
			listPlaylists: async () => ({ ok: true, playlists: [] }),
			listPlaylist: async () => ({ ok: true, tracks: [] }),
			search: async () => ({ ok: true, tracks: [] }),
			verifySession: async () => ({ ok: true }),
		},
	});
	const { ctx, opened } = tuiCtx();
	const closed = commands.get("yt")!.handler("", ctx);
	await tick();
	await tick();
	assert.ok(opened.component!.render(100).map(stripAnsi).some((l) => l.includes("not connected")));
	opened.component!.handleInput("\r");
	await tick();
	await tick();
	assert.deepEqual(writes, [{ account: ACCOUNT }]);
	assert.deepEqual(listed, [ACCOUNT]);
	opened.component!.handleInput("\x1b");
	await closed;
	// S4/S15: stream URLs resolved with the previous session are dropped; playback is untouched.
	assert.deepEqual(fake.calls, [["forgetStreams"]]);
});

// S5: Pi quitting stops the mpv we started; reloads keep music playing.
test("session_shutdown quit stops the player; other reasons dispose it", async () => {
	for (const [reason, expected] of [
		["quit", "stop"],
		["reload", "dispose"],
		["new", "dispose"],
	] as const) {
		const { commands, handlers, fake } = harness();
		const { ctx, opened } = tuiCtx();
		const closed = commands.get("yt")!.handler("", ctx);
		await tick();
		await tick();
		opened.component!.handleInput("\x1b");
		await closed;
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason }, ctx);
		assert.deepEqual(fake.calls, [[expected]], reason);
	}
	const { handlers } = harness();
	await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, {}); // no player yet
});

const DOWN = "\x1b[B";
/** Open /yt with an account and press Account · Firefox → Disconnect. */
async function disconnect(over: Partial<YoutubeDeps> = {}) {
	const h = harness(over);
	const { ctx, opened } = tuiCtx();
	const closed = h.commands.get("yt")!.handler("", ctx);
	await tick();
	await tick();
	const component = opened.component!;
	for (let i = 0; i < 7; i++) component.handleInput(DOWN);
	component.handleInput("\r");
	component.handleInput(DOWN);
	component.handleInput("\r");
	await tick();
	await tick();
	return { ...h, component, closed };
}

// S10: Disconnect writes the config without an account and keeps mpv running.
// S4/S15: it also drops stream URLs resolved with the old session.
test("Disconnect writes the config with account null, forgets streams and does not stop the player", async () => {
	const { writes, fake, component, closed, playerDeps } = await disconnect();
	assert.deepEqual(writes, [{ account: null }]);
	const lines = component.render(120).map(stripAnsi);
	assert.ok(lines.some((l) => l.includes("not connected")), lines.join("\n"));
	assert.equal(playerDeps[0].cookieArg?.(), undefined);
	component.handleInput("\x1b");
	await closed;
	assert.deepEqual(fake.calls, [["forgetStreams"]]);
});

// S10: a failing config write becomes the one-line notice, never an exception.
test("a failing Disconnect write shows the notice and does not throw", async () => {
	const { component, closed } = await disconnect({
		writeConfig: async () => {
			throw new Error("EACCES");
		},
	});
	const lines = component.render(120).map(stripAnsi);
	assert.ok(
		lines.some((l) => /Could not update the account settings\.\s+Check ~\/\.config\/pi-yt permissions\./.test(l)),
		lines.join("\n"),
	);
	assert.ok(component.render(120).every((l) => visibleWidth(l) <= 120));
	component.handleInput("\x1b");
	await closed;
});

// S24: a failing account save names the pi-yt folder.
test("S24 a failing account save names ~/.config/pi-yt", async () => {
	const h = harness({
		readConfig: async () => ({ version: 1, account: null }),
		writeConfig: async () => {
			throw new Error("EACCES");
		},
	});
	const ui = await openYt(h);
	await ui.press("\r");
	assert.ok(
		ui.lines().some((l) => /Could not save the account\.\s+Check that ~\/\.config\/pi-yt is writable\./.test(l)),
		ui.lines().join("\n"),
	);
	await ui.close();
});

const page = (from: number, n: number): Track[] =>
	Array.from({ length: n }, (_, i) => ({
		id: `v${from + i}`,
		title: `Video ${from + i}`,
		artist: "Chan",
		duration: 60,
		url: `https://www.youtube.com/watch?v=v${from + i}`,
	}));

/** A source whose calls are recorded; listSource answers from `pages` by start (default TRACKS). */
function recordingSource(pages: Record<number, TracksResult> = {}) {
	const calls: { fn: string; start?: number; account?: unknown; query?: string }[] = [];
	const source: NonNullable<YoutubeDeps["source"]> = {
		listSource: async (_kind, opts) => {
			calls.push({ fn: "listSource", start: opts?.start, account: opts?.account });
			return pages[opts?.start ?? 1] ?? { ok: true, tracks: TRACKS, hasMore: false };
		},
		listPlaylists: async (opts) => {
			calls.push({ fn: "listPlaylists", account: opts?.account });
			return { ok: true, playlists: [{ id: "PL1", title: "Road trip", count: 2 }] };
		},
		listPlaylist: async (_id, opts) => {
			calls.push({ fn: "listPlaylist", start: opts?.start });
			return { ok: true, tracks: TRACKS, hasMore: false };
		},
		search: async (query) => {
			calls.push({ fn: "search", query });
			return { ok: true, tracks: TRACKS };
		},
		verifySession: async () => ({ ok: true }),
	};
	return { source, calls };
}

async function openYt(h: ReturnType<typeof harness>) {
	const { ctx, opened } = tuiCtx();
	const closed = h.commands.get("yt")!.handler("", ctx);
	await tick();
	await tick();
	const component = opened.component!;
	const press = async (...inputs: string[]) => {
		for (const input of inputs) component.handleInput(input);
		await tick();
		await tick();
	};
	const lines = () => component.render(120).map(stripAnsi);
	const close = async () => {
		component.handleInput("\x1b");
		await closed;
	};
	return { component, press, lines, close };
}
const count = (calls: { fn: string }[], fn: string) => calls.filter((c) => c.fn === fn).length;

// S14: a list loaded once in this Pi session opens instantly the next time.
test("S14 reopening a loaded source uses the session cache and does not call yt-dlp", async () => {
	const rec = recordingSource();
	const h = harness({ source: rec.source });
	const first = await openYt(h);
	assert.deepEqual(rec.calls, [{ fn: "listSource", start: 1, account: ACCOUNT }]);
	await first.close();

	const second = await openYt(h);
	assert.equal(count(rec.calls, "listSource"), 1);
	assert.ok(second.lines().some((l) => l.includes("Aruarian Dance")), second.lines().join("\n"));
	await second.close();
});

// S14: r reloads from page 1 and replaces the cached list.
test("S14 r reloads the source from page 1 and replaces the cache", async () => {
	const fresh: Track = { id: "c", title: "Feather", artist: "Nujabes", duration: 200, url: "https://www.youtube.com/watch?v=c" };
	const rec = recordingSource();
	const h = harness({ source: rec.source });
	const ui = await openYt(h);
	rec.source.listSource = async (_kind, opts) => {
		rec.calls.push({ fn: "listSource", start: opts?.start, account: opts?.account });
		return { ok: true, tracks: [fresh], hasMore: false };
	};
	await ui.press("\t", "r");
	assert.deepEqual(rec.calls.at(-1), { fn: "listSource", start: 1, account: ACCOUNT });
	assert.ok(ui.lines().some((l) => l.includes("Feather")));
	assert.ok(!ui.lines().some((l) => l.includes("Aruarian Dance")));
	await ui.close();

	const again = await openYt(h);
	assert.equal(count(rec.calls, "listSource"), 2);
	assert.ok(again.lines().some((l) => l.includes("Feather")));
	await again.close();
});

// S14: Load more asks for the next page and the cache keeps both pages.
test("S14 Load more fetches start 101 and the cache keeps the appended list", async () => {
	const rec = recordingSource({ 1: { ok: true, tracks: page(1, 100), hasMore: true }, 101: { ok: true, tracks: page(101, 3), hasMore: false } });
	const h = harness({ source: rec.source });
	const ui = await openYt(h);
	assert.ok(ui.lines().some((l) => l.includes("Recommended · 100")));
	await ui.press("\t", ...Array.from({ length: 102 }, () => DOWN), "\r");
	assert.deepEqual(rec.calls.at(-1), { fn: "listSource", start: 101, account: ACCOUNT });
	assert.ok(ui.lines().some((l) => l.includes("Recommended · 103")), ui.lines().join("\n"));
	await ui.close();

	const again = await openYt(h);
	assert.equal(count(rec.calls, "listSource"), 2);
	assert.ok(again.lines().some((l) => l.includes("Recommended · 103")));
	assert.ok(!again.lines().some((l) => l.includes("Load more")));
	await again.close();
});

// S14: Disconnect forgets every cached list.
test("S14 Disconnect clears the session cache", async () => {
	const rec = recordingSource();
	const { component, closed, ...h } = await disconnect({ source: rec.source });
	component.handleInput("\x1b");
	await closed;
	assert.equal(count(rec.calls, "listSource"), 1);
	const ui = await openYt({ ...h } as ReturnType<typeof harness>);
	assert.equal(count(rec.calls, "listSource"), 2);
	await ui.close();
});

// S14: each account has its own cache.
test("S14 the cache is keyed by account", async () => {
	const rec = recordingSource();
	const accounts = [ACCOUNT, { browser: "chromium" as const, profile: "Default" }, ACCOUNT];
	const h = harness({ source: rec.source, readConfig: async () => ({ version: 1, account: accounts.shift()! }) });
	for (let i = 0; i < 3; i++) await (await openYt(h)).close();
	assert.deepEqual(
		rec.calls.map((c) => c.account),
		[ACCOUNT, { browser: "chromium", profile: "Default" }],
	);
});

// S14: search results are never cached.
test("S14 search results are not cached", async () => {
	const rec = recordingSource();
	const h = harness({ source: rec.source });
	const ui = await openYt(h);
	await ui.press("/", "n", "u", "\r");
	await ui.press("\r");
	assert.deepEqual(
		rec.calls.filter((c) => c.fn === "search"),
		[
			{ fn: "search", query: "nu" },
			{ fn: "search", query: "nu" },
		],
	);
	await ui.press("\x1b"); // the first esc clears the query
	await ui.close();
});

// S14: the playlists feed is cached too; r on the Playlists row refetches it.
test("S14 the playlists feed is cached and r on its row reloads it", async () => {
	const rec = recordingSource();
	const h = harness({ source: rec.source });
	const toPlaylists = [DOWN, DOWN, DOWN, DOWN];
	const ui = await openYt(h);
	await ui.press(...toPlaylists, "\r");
	assert.ok(ui.lines().some((l) => l.includes("Road trip")));
	await ui.close();

	// S18: /yt reopens on the expanded Playlists row it was left on.
	const again = await openYt(h);
	assert.equal(count(rec.calls, "listPlaylists"), 1);
	assert.ok(again.lines().some((l) => l.includes("Road trip")));
	await again.press("r");
	assert.equal(count(rec.calls, "listPlaylists"), 2);
	await again.close();
});

// S18(1)/S14: /yt reopens where it was left, from the session cache; after Disconnect that place is forgotten.
test("S18 reopening /yt returns to the source and cursor left, without yt-dlp; Disconnect forgets it", async () => {
	const kinds: string[] = [];
	let config: { version: 1; account: typeof ACCOUNT | null } = { version: 1, account: ACCOUNT };
	const h = harness({
		readConfig: async () => config,
		writeConfig: async (_location, next) => {
			config = { version: 1, account: next.account as typeof ACCOUNT | null };
		},
		source: {
			listSource: async (kind) => (kinds.push(kind), { ok: true, tracks: page(1, 10), hasMore: false }),
			listPlaylists: async () => ({ ok: true, playlists: [] }),
			listPlaylist: async () => ({ ok: true, tracks: [] }),
			search: async () => ({ ok: true, tracks: [] }),
			verifySession: async () => ({ ok: true }),
		},
	});
	const first = await openYt(h);
	assert.ok(first.lines().some((l) => l.includes("Recommended · 10")), first.lines().join("\n"));
	await first.press(DOWN, "\r");
	await first.press(...Array.from({ length: 6 }, () => DOWN));
	assert.ok(first.lines().some((l) => /▸\s+5\s+Video 5/.test(l)), first.lines().join("\n"));
	await first.close();
	assert.deepEqual(kinds, ["recommended", "history"]);

	const second = await openYt(h);
	assert.deepEqual(kinds, ["recommended", "history"], "no new yt-dlp call");
	const lines = second.lines();
	assert.ok(lines.some((l) => l.includes("History · 10")), lines.join("\n"));
	assert.ok(lines.some((l) => /▸\s+5\s+Video 5/.test(l)), lines.join("\n"));

	// Disconnect: tab to the left pane, down to the account row, then Disconnect.
	await second.press("\t", ...Array.from({ length: 6 }, () => DOWN), "\r", DOWN, "\r");
	assert.equal(config.account, null);
	await second.close();

	const third = await openYt(h);
	assert.ok(third.lines().some((l) => l.includes("not connected")), third.lines().join("\n"));
	await third.press("\r");
	assert.ok(third.lines().some((l) => l.includes("Recommended · 10")), third.lines().join("\n"));
	assert.ok(!third.lines().some((l) => l.includes("History ·")));
	await third.close();
});

// S4/S15: the player's resolver asks yt-dlp with the same browser spec mpv gets, and none after Disconnect.
test("S15 the player's resolver passes the connected account's cookieArg to yt-dlp", async () => {
	const seen: unknown[] = [];
	const h = harness({
		resolveAudio: async (track, opts) => {
			seen.push({ id: track.id, account: opts?.account ?? null, cookieArg: opts?.cookieArg, signal: opts?.signal instanceof AbortSignal });
			return { ok: true, url: `https://stream.example/${track.id}` };
		},
	});
	await openYt(h);
	const resolver = h.playerDeps[0].resolver;
	assert.equal(typeof resolver, "function");
	const result = await resolver!(TRACKS[0], { signal: new AbortController().signal });
	assert.deepEqual(result, { ok: true, url: "https://stream.example/a" });
	assert.deepEqual(seen, [{ id: "a", account: ACCOUNT, cookieArg: "firefox:default-release", signal: true }]);
	assert.equal(h.playerDeps[0].cookieArg?.(), "firefox:default-release");

	const { playerDeps } = await disconnect({
		resolveAudio: async (track, opts) => {
			seen.push({ id: track.id, account: opts?.account ?? null, cookieArg: opts?.cookieArg });
			return { ok: true, url: "x" };
		},
	});
	await playerDeps[0].resolver!(TRACKS[1], { signal: new AbortController().signal });
	assert.deepEqual(seen.at(-1), { id: "b", account: null, cookieArg: undefined });
});

// ---- S17 easy dependency install ----

const MANAGED = "/nonexistent-home/.local/share/pi-yt/bin/yt-dlp";
type Tools = Awaited<ReturnType<NonNullable<YoutubeDeps["resolveTools"]>>>;
const NO_TOOLS: Tools = { ytDlp: null, mpv: null };

/** Connect screen (no account) with tools answered in order from `answers` (the last repeats). */
function setupHarness(answers: Tools[], over: Partial<YoutubeDeps> = {}) {
	const resolved: unknown[] = [];
	const h = harness({
		readConfig: async () => ({ version: 1, account: null }),
		resolveTools: async (opts) => {
			resolved.push(opts);
			return answers[Math.min(resolved.length - 1, answers.length - 1)];
		},
		...over,
	});
	return { ...h, resolved };
}

// S17: the resolved yt-dlp reaches the source, the resolver and mpv; tools are re-resolved on each /yt.
test("S17 /yt resolves the tools on open and passes the yt-dlp path to source, resolver and player", async () => {
	const seen: { fn: string; ytDlpPath?: string }[] = [];
	const managed: Tools = { ytDlp: { path: MANAGED, source: "managed" }, mpv: { path: "/usr/bin/mpv" } };
	const { resolved, ...h } = setupHarness([NO_TOOLS, managed], {
		readConfig: async () => ({ version: 1, account: ACCOUNT }),
		source: {
			listSource: async (_k, opts) => (seen.push({ fn: "listSource", ytDlpPath: opts?.ytDlpPath }), { ok: true, tracks: TRACKS }),
			listPlaylists: async () => ({ ok: true, playlists: [] }),
			listPlaylist: async () => ({ ok: true, tracks: [] }),
			search: async () => ({ ok: true, tracks: [] }),
			verifySession: async () => ({ ok: true }),
		},
		resolveAudio: async (track, opts) => (seen.push({ fn: "resolveAudio", ytDlpPath: opts?.ytDlpPath }), { ok: true, url: "https://s/" + track.id }),
	});
	const first = await openYt(h as ReturnType<typeof harness>);
	assert.deepEqual(resolved, [{ home: "/nonexistent-home", env: {} }]);
	assert.equal(h.playerDeps[0].ytDlpPath?.(), undefined);
	await first.close();
	const second = await openYt(h as ReturnType<typeof harness>);
	await second.press("r", "\t", "r");
	assert.equal(resolved.length, 2);
	assert.equal(h.playerDeps[0].ytDlpPath?.(), MANAGED);
	await h.playerDeps[0].resolver!(TRACKS[0], { signal: new AbortController().signal });
	assert.deepEqual(seen.at(-2), { fn: "listSource", ytDlpPath: MANAGED });
	assert.deepEqual(seen.at(-1), { fn: "resolveAudio", ytDlpPath: MANAGED });
	await second.close();
});

// S17: Install yt-dlp runs the installer with fetch, progress and an abort signal, then re-resolves the tools.
test("S17 the install effect wires fetch, progress and abort, and re-resolves the tools after it", async () => {
	const calls: { home: string; platform: string; arch: string; fetch: unknown; signal: AbortSignal }[] = [];
	let finish: ((r: { ok: true; path: string }) => void) | undefined;
	let progress: ((p: { phase: "download"; received: number; total: number | null } | { phase: "verify" }) => void) | undefined;
	const fetchFn = (async () => new Response("")) as typeof fetch;
	const managed: Tools = { ytDlp: { path: MANAGED, source: "managed" }, mpv: { path: "/usr/bin/mpv" } };
	const h = setupHarness([{ ytDlp: null, mpv: { path: "/usr/bin/mpv" } }, { ytDlp: null, mpv: { path: "/usr/bin/mpv" } }, managed], {
		fetch: fetchFn,
		installYtDlp: (opts) => {
			calls.push({ home: opts.home, platform: opts.platform, arch: opts.arch, fetch: opts.fetch, signal: opts.signal! });
			progress = opts.onProgress;
			return new Promise((resolve) => (finish = resolve));
		},
	});
	const ui = await openYt(h as ReturnType<typeof harness>);
	assert.ok(ui.lines().some((l) => /▸ ✗ yt-dlp   reads YouTube\s+Install yt-dlp/.test(l)), ui.lines().join("\n"));
	await ui.press("\r");
	assert.ok(ui.lines().some((l) => l.includes("Version   2026.10.26 (official release)")));
	assert.ok(ui.lines().some((l) => l.includes("Into      ~/.local/share/pi-yt/bin")), ui.lines().join("\n"));

	// esc cancels: the installer's signal aborts.
	await ui.press("\r", "\x1b");
	assert.equal(calls[0].signal.aborted, true);
	assert.ok(ui.lines().some((l) => l.includes("Install yt-dlp")));

	await ui.press("\r", "\r");
	assert.equal(calls.length, 2);
	assert.deepEqual({ ...calls[1], signal: calls[1].signal.aborted }, { home: "/nonexistent-home", platform: "linux", arch: "x64", fetch: fetchFn, signal: false });
	progress!({ phase: "download", received: 20_583_484, total: 41_166_968 });
	assert.ok(ui.lines().some((l) => /Downloading yt-dlp  ━+  20\.6\/41\.2 MB/.test(l)), ui.lines().join("\n"));
	finish!({ ok: true, path: MANAGED });
	await ui.press();
	await ui.press();
	assert.ok(h.resolved.length >= 2);
	// S19: both tools found now, so Dependencies gives way to the connect screen.
	const lines = ui.lines();
	assert.ok(lines.some((l) => l.includes("✓ Ready")), lines.join("\n"));
	assert.ok(lines.some((l) => l.includes("not connected")), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("mpv and yt-dlp found")), lines.join("\n"));
	await ui.close();
});

// S17: How to install mpv: Copy command uses the clipboard helper; Check again re-resolves the tools.
test("S17 Copy command and Check again", async () => {
	const copied: string[] = [];
	const h = setupHarness([{ ytDlp: { path: "/usr/bin/yt-dlp", source: "system" }, mpv: null }, { ytDlp: { path: "/usr/bin/yt-dlp", source: "system" }, mpv: { path: "/usr/bin/mpv" } }], {
		copyToClipboard: async (text) => (copied.push(text), false),
	});
	const ui = await openYt(h as ReturnType<typeof harness>);
	await ui.press("\r");
	assert.ok(ui.lines().some((l) => l.includes("sudo pacman -S mpv")), ui.lines().join("\n"));
	await ui.press("\r");
	assert.deepEqual(copied, ["sudo pacman -S mpv"]);
	assert.ok(ui.lines().some((l) => l.includes("No clipboard tool found; copy it by hand.")));
	assert.equal(h.resolved.length, 1);
	await ui.press(DOWN, "\r");
	assert.equal(h.resolved.length, 2);
	assert.ok(ui.lines().some((l) => l.includes("✓ Ready")), ui.lines().join("\n"));
	assert.ok(!ui.lines().some((l) => l.includes("mpv and yt-dlp found")));
	await ui.close();
});

// S19: with mpv missing /yt opens Dependencies and reads nothing from YouTube; Check again moves on once mpv is there.
test("S19 a missing mpv opens Dependencies without calling the source; Check again moves on to main", async () => {
	const rec = recordingSource();
	const ytDlp = { path: "/usr/bin/yt-dlp", source: "system" as const };
	const h = setupHarness([{ ytDlp, mpv: null }, { ytDlp, mpv: null }, { ytDlp, mpv: { path: "/usr/bin/mpv" } }], {
		readConfig: async () => ({ version: 1, account: ACCOUNT }),
		source: rec.source,
	});
	const ui = await openYt(h as ReturnType<typeof harness>);
	const gate = ui.lines();
	assert.ok(gate.some((l) => /YouTube\s+Dependencies/.test(l)), gate.join("\n"));
	assert.ok(gate.some((l) => /✗ mpv      plays the audio\s+How to install mpv/.test(l)));
	assert.ok(!gate.some((l) => l.includes("Firefox") || l.includes("Recommended")));
	await ui.press("\t", "r", "/", "\x1b[C");
	assert.deepEqual(rec.calls, []);

	// Check again while mpv is still missing stays.
	await ui.press(DOWN, "\r");
	assert.equal(h.resolved.length, 2);
	assert.ok(ui.lines().some((l) => /YouTube\s+Dependencies/.test(l)));
	assert.deepEqual(rec.calls, []);

	await ui.press("\r");
	assert.equal(h.resolved.length, 3);
	const lines = ui.lines();
	assert.ok(lines.some((l) => l.includes("✓ Ready")), lines.join("\n"));
	assert.ok(lines.some((l) => l.includes("Recommended · 2")), lines.join("\n"));
	assert.deepEqual(rec.calls, [{ fn: "listSource", start: 1, account: ACCOUNT }]);
	await ui.close();
});

// ---- S20 switching tracks while one plays ----

// S20: Enter on another track while the previous pick still resolves starts the new pick at once
// (the player cancels the old resolve); the old pick's Shuffle never runs after it.
test("S20 a new pick does not wait behind the previous pick, and the superseded batch stops", async () => {
	const h = harness();
	const pending: (() => void)[] = [];
	h.fake.player.play = (...args: unknown[]) => {
		h.fake.calls.push(["play", ...args]);
		return new Promise<void>((resolve) => pending.push(resolve));
	};
	const yt = await openYt(h);
	await yt.press("\t", "\x1b[B", "\r");
	assert.deepEqual(h.fake.calls, [["play", TRACKS, 0]]);
	await yt.press("\x1b[B", "\x1b[B", "\r");
	assert.deepEqual(h.fake.calls, [
		["play", TRACKS, 0],
		["play", TRACKS, 1],
	]);
	for (const resolve of pending) resolve();
	await tick();
	await tick();
	assert.deepEqual(h.fake.calls, [
		["play", TRACKS, 0],
		["play", TRACKS, 1],
	]);
	await yt.close();
});

/** Fake yt-dlp for the real resolver: the visionos try gets a bot check, the full resolve prints a link. */
function botCheckYtDlp() {
	const calls: string[][] = [];
	const visionos = (args: string[]) => args.includes("youtube:player_client=visionos;skip=hls");
	const spawn: SpawnFn = (_cmd, args) => {
		calls.push([...args]);
		const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => true;
		const blocked = visionos(args);
		setImmediate(() => {
			if (blocked) child.stderr.write("ERROR: [youtube] x: Sign in to confirm you're not a bot.");
			else child.stdout.write("https://stream.example/link\n");
			child.stdout.end();
			child.stderr.end();
			setImmediate(() => child.emit("close", blocked ? 1 : 0, null));
		});
		return child;
	};
	return { spawn, calls, visionosTries: () => calls.filter(visionos).length };
}

// S21: the player's resolver keeps one cooldown memo for the Pi session, so after a bot check on visionos
// the next picks go straight to the full resolve.
test("S21 the player's resolver skips visionos on the next pick after a bot check", async () => {
	const ytDlp = botCheckYtDlp();
	const h = harness({
		resolveAudio: (track, opts) => realResolveAudio(track, { ...opts, spawn: ytDlp.spawn, probe: undefined }),
	});
	await openYt(h);
	const resolver = h.playerDeps[0].resolver!;
	const signal = new AbortController().signal;
	assert.deepEqual(await resolver(TRACKS[0], { signal }), { ok: true, url: "https://stream.example/link" });
	assert.equal(ytDlp.calls.length, 2);
	assert.deepEqual(await resolver(TRACKS[1], { signal }), { ok: true, url: "https://stream.example/link" });
	assert.equal(ytDlp.calls.length, 3);
	assert.equal(ytDlp.visionosTries(), 1);
});

// ---- S21 dwell pre-resolve ----

/** /yt on Recommended (TRACKS), right pane, cursor on the first track. */
async function onFirstTrack(h: ReturnType<typeof harness>) {
	const ui = await openYt(h);
	await ui.press("\t", DOWN, DOWN);
	return ui;
}
const prepares = (h: ReturnType<typeof harness>) => h.fake.calls.filter((c) => c[0] === "prepare");

// S21(3): resting 400 ms on a track prepares it once.
test("S21 resting the cursor 400 ms on a track calls prepare once with that track", async () => {
	const h = harness();
	const ui = await onFirstTrack(h);
	h.clock.advance(399);
	assert.deepEqual(prepares(h), []);
	h.clock.advance(1);
	assert.deepEqual(prepares(h), [["prepare", TRACKS[0]]]);
	h.clock.advance(5000);
	assert.deepEqual(prepares(h), [["prepare", TRACKS[0]]]);
	await ui.close();
});

// S21(3): a cursor move before 400 ms restarts the wait for the new track.
test("S21 moving the cursor before 400 ms prepares nothing for the track left", async () => {
	const h = harness();
	const ui = await onFirstTrack(h);
	h.clock.advance(300);
	await ui.press(DOWN);
	h.clock.advance(300);
	assert.deepEqual(prepares(h), []);
	h.clock.advance(100);
	assert.deepEqual(prepares(h), [["prepare", TRACKS[1]]]);
	await ui.close();
});

// S21(3): closing the popover cancels the wait.
test("S21 closing the popover cancels a pending dwell prepare", async () => {
	const h = harness();
	const ui = await onFirstTrack(h);
	h.clock.advance(200);
	await ui.close();
	h.clock.advance(1000);
	assert.deepEqual(prepares(h), []);
});

// S21(3): a pick owns yt-dlp while it resolves; Enter also cancels the wait.
test("S21 no dwell prepare while a pick resolves, and a pick cancels the pending one", async () => {
	const h = harness();
	const ui = await onFirstTrack(h);
	await ui.press("\r");
	h.clock.advance(1000);
	assert.deepEqual(prepares(h), []);

	h.fake.state.resolving = true;
	await ui.press(DOWN);
	h.clock.advance(400);
	assert.deepEqual(prepares(h), []);
	h.fake.state.resolving = false;
	await ui.press("\x1b[A");
	h.clock.advance(400);
	assert.deepEqual(prepares(h), [["prepare", TRACKS[0]]]);
	await ui.close();
});

// S21(3): after a bot check dwell prepares wait out STRATEGY_COOLDOWN_MS, so resting never adds to a block.
test("S21 a blocked resolve pauses dwell prepares for the cooldown", async () => {
	const ytDlp = botCheckYtDlp();
	const h = harness({
		resolveAudio: (track, opts) => realResolveAudio(track, { ...opts, spawn: ytDlp.spawn, probe: undefined }),
	});
	const ui = await onFirstTrack(h);
	await h.playerDeps[0].resolver!(TRACKS[0], { signal: new AbortController().signal });
	h.clock.advance(400);
	assert.deepEqual(prepares(h), []);
	h.clock.advance(STRATEGY_COOLDOWN_MS - 400 - 1);
	await ui.press(DOWN);
	h.clock.advance(400);
	assert.deepEqual(prepares(h), [["prepare", TRACKS[1]]]);
	await ui.close();
});

// ---- S23 mouse, update offer, seek ----

/** A mouse event over the 120-column card. */
const mouse = (type: string, x: number, y: number, over: Record<string, unknown> = {}) => ({
	type,
	button: type === "move" ? "none" : "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 120,
	height: 30,
	shift: false,
	alt: false,
	ctrl: false,
	...over,
});
/** Row and column of `text` in the rendered card. */
const find = (lines: string[], text: string) => {
	const y = lines.findIndex((l) => l.includes(text));
	assert.ok(y >= 0, `${text} in\n${lines.join("\n")}`);
	return { x: lines[y].indexOf(text), y };
};
const PLAYING: Partial<PlayerState> = { running: true, idle: false, title: "Aruarian Dance", artist: "Nujabes", elapsed: 80, duration: 252, position: 0, queue: TRACKS };

// S23(1): press captures without acting, click acts; a first click selects a track, a second plays it.
test("S23 mouse: press captures without acting, click selects then plays, stale frames are ignored", async () => {
	const kinds: string[] = [];
	const h = harness({
		source: {
			listSource: async (kind) => {
				kinds.push(kind);
				return { ok: true, tracks: TRACKS };
			},
			listPlaylists: async () => ({ ok: true, playlists: [] }),
			listPlaylist: async () => ({ ok: true, tracks: [] }),
			search: async () => ({ ok: true, tracks: [] }),
			verifySession: async () => ({ ok: true }),
		},
	});
	const ui = await openYt(h);
	const lines = ui.lines();
	const kerala = find(lines, "Kerala");
	const component = ui.component;
	assert.deepEqual(component.handleMouse!(mouse("press", kerala.x, kerala.y)), { handled: true, capture: true, render: false });
	assert.deepEqual(ui.lines(), lines, "press changes nothing");
	assert.deepEqual(component.handleMouse!(mouse("release", kerala.x, kerala.y)), { handled: true });
	component.handleMouse!(mouse("click", kerala.x, kerala.y));
	await ui.press();
	assert.ok(ui.lines()[kerala.y].includes("▸  2  Kerala"), ui.lines().join("\n"));
	assert.deepEqual(h.fake.calls, []);
	component.handleMouse!(mouse("click", kerala.x, kerala.y));
	await ui.press();
	assert.deepEqual(h.fake.calls, [["play", TRACKS, 1]]);

	// A click on a frame of another size (width or terminal rows) is ignored: History neither loads nor takes the cursor.
	const history = find(ui.lines(), "History");
	const before = ui.lines();
	assert.equal(component.handleMouse!(mouse("click", history.x, history.y, { width: 100 })), undefined);
	await ui.press();
	assert.deepEqual(kinds, ["recommended"], "History did not load");
	assert.deepEqual(ui.lines(), before, "nothing changed on screen");
	component.handleMouse!(mouse("click", history.x, history.y));
	await ui.press();
	assert.deepEqual(kinds, ["recommended", "history"]);
	assert.ok(ui.lines().some((l) => l.includes("│ History · 2")), ui.lines().join("\n"));
	assert.equal(h.fake.calls.length, 1);
	await ui.close();
});

// S23(1): hover follows the pointer, repaints only on change, and any key clears it.
test("S23 mouse: hover is set and cleared, and a key press clears it", async () => {
	const h = harness();
	const ui = await openYt(h);
	const history = find(ui.lines(), "History");
	const c = ui.component;
	assert.deepEqual(c.handleMouse!(mouse("move", history.x, history.y)), { handled: true, render: true });
	assert.deepEqual(c.handleMouse!(mouse("move", history.x + 1, history.y)), { handled: true, render: false });
	assert.deepEqual(c.handleMouse!(mouse("move", history.x, 0)), { handled: true, render: true }, "off any hit clears it");
	c.handleMouse!(mouse("move", history.x, history.y));
	await ui.press("\x1b[B");
	assert.deepEqual(c.handleMouse!(mouse("move", history.x, history.y)), { handled: true, render: true }, "the key cleared it");
	assert.deepEqual(c.handleMouse!(mouse("move", history.x, history.y, { width: 90 })), { handled: true, render: true }, "a stale frame clears it");
	await ui.close();
});

// S23(1): the wheel moves the selection of the pane under the pointer.
test("S23 mouse: the wheel moves the selection in the pane under the pointer", async () => {
	const h = harness();
	const ui = await openYt(h);
	const c = ui.component;
	const left = find(ui.lines(), "Watch later");
	assert.deepEqual(c.handleMouse!(mouse("wheel", left.x, left.y, { button: "none", wheelDelta: 3 })), { handled: true, render: true });
	await ui.press();
	assert.ok(ui.lines().some((l) => l.includes("▸ History")), ui.lines().join("\n"));
	const right = find(ui.lines(), "Kerala");
	c.handleMouse!(mouse("wheel", right.x, right.y, { button: "none", wheelDelta: 1 }));
	c.handleMouse!(mouse("wheel", right.x, right.y, { button: "none", wheelDelta: 1 }));
	c.handleMouse!(mouse("wheel", right.x, right.y, { button: "none", wheelDelta: 1 }));
	await ui.press();
	assert.ok(ui.lines()[right.y].includes("▸  2  Kerala"), ui.lines().join("\n"));
	await ui.close();
});

// S23(1): ⏮ ⏸/▶ ⏭ and the progress bar in the player row.
test("S23 mouse: player-row glyphs control playback and the bar seeks to the clicked position", async () => {
	const h = harness();
	Object.assign(h.fake.state, PLAYING);
	const ui = await openYt(h);
	const lines = ui.lines();
	const row = find(lines, "⏮ ▶ ⏭");
	for (const [dx, call] of [[0, "prev"], [2, "togglePause"], [4, "next"]] as const) {
		ui.component.handleMouse!(mouse("click", row.x + dx, row.y));
		await ui.press();
		assert.deepEqual(h.fake.calls.at(-1), [call]);
	}
	const bar = lines[row.y].indexOf("━");
	const barEnd = lines[row.y].lastIndexOf("━");
	ui.component.handleMouse!(mouse("click", bar, row.y));
	ui.component.handleMouse!(mouse("click", barEnd, row.y));
	await ui.press();
	assert.deepEqual(h.fake.calls.slice(-2), [["seek", 0, true], ["seek", 252, true]]);
	await ui.close();
});

// S23(4): `.` and `,` reach the player as seek ±5; typed into the search input they stay text.
test("S23 . and , call seek(5) and seek(-5), and are typed in the search input", async () => {
	const h = harness();
	Object.assign(h.fake.state, PLAYING);
	const ui = await openYt(h);
	await ui.press(".", ",", "\t", ".");
	assert.deepEqual(h.fake.calls, [["seek", 5], ["seek", -5], ["seek", 5]]);
	await ui.press("/", ".", ",");
	assert.deepEqual(h.fake.calls.length, 3);
	assert.ok(ui.lines().some((l) => l.includes("› .,")), ui.lines().join("\n"));
	await ui.press("\x1b"); // the first esc clears the query
	await ui.close();
});

/** Account, managed yt-dlp, and an update check answering `answer`. */
function offerHarness(answer: Promise<{ latest: string; current: string } | null>, over: Partial<YoutubeDeps> = {}) {
	const checks: { home: string; env: unknown; fetch: unknown; now: unknown; currentVersion: () => Promise<string | null> }[] = [];
	const versions: unknown[] = [];
	const updates: unknown[] = [];
	const h = harness({
		resolveTools: async () => ({ ytDlp: { path: MANAGED, source: "managed" }, mpv: { path: "/usr/bin/mpv" } }),
		checkYtDlpUpdate: (opts) => (checks.push(opts as (typeof checks)[number]), answer),
		ytDlpVersion: async (opts) => (versions.push(opts.path), "2026.10.26"),
		updateYtDlp: async (opts) => (updates.push({ path: opts.path, source: opts.source }), { ok: true }),
		...over,
	});
	return { ...h, checks, versions, updates };
}
const OFFER = "yt-dlp 2026.11.05 available  ▸ Update (u) · Later (l)";

// S23(2): a newer release for the managed copy shows the offer; Update runs the updater and reports it.
test("S23 update offer: shown for the managed copy, Update runs updateYtDlp, then not offered again this session", async () => {
	const fetchFn = (async () => new Response("")) as typeof fetch;
	const h = offerHarness(Promise.resolve({ latest: "2026.11.05", current: "2026.10.26" }), { fetch: fetchFn });
	const ui = await openYt(h);
	assert.ok(ui.lines().some((l) => l.includes(OFFER)), ui.lines().join("\n"));
	assert.equal(h.checks.length, 1);
	assert.deepEqual({ home: h.checks[0].home, env: h.checks[0].env, fetch: h.checks[0].fetch, now: typeof h.checks[0].now }, {
		home: "/nonexistent-home",
		env: {},
		fetch: fetchFn,
		now: "function",
	});
	assert.equal(await h.checks[0].currentVersion(), "2026.10.26");
	assert.equal(await h.checks[0].currentVersion(), "2026.10.26");
	assert.deepEqual(h.versions, [MANAGED], "the version is asked once and cached");
	await ui.press("u");
	assert.deepEqual(h.updates, [{ path: MANAGED, source: "managed" }]);
	assert.ok(ui.lines().some((l) => l.includes("yt-dlp is up to date.")), ui.lines().join("\n"));
	await ui.close();
	const again = await openYt(h);
	assert.equal(h.checks.length, 1, "no second check after Update");
	assert.ok(!again.lines().some((l) => l.includes("available")));
	await again.close();
});

// S23(2): Later hides it for the Pi session.
test("S23 update offer: Later hides it for the session without updating", async () => {
	const h = offerHarness(Promise.resolve({ latest: "2026.11.05", current: "2026.10.26" }));
	const ui = await openYt(h);
	const later = find(ui.lines(), "Later");
	ui.component.handleMouse!(mouse("click", later.x, later.y));
	await ui.press();
	assert.ok(!ui.lines().some((l) => l.includes("available")), ui.lines().join("\n"));
	assert.deepEqual(h.updates, []);
	await ui.close();
	await (await openYt(h)).close();
	assert.equal(h.checks.length, 1);
});

// S23(2): the check never blocks /yt, and a system copy (package manager) is never checked.
test("S23 update offer: never blocks the popover and is never checked for a system copy or on Dependencies", async () => {
	const pending = offerHarness(new Promise(() => {}));
	const ui = await openYt(pending);
	assert.ok(ui.lines().some((l) => l.includes("Aruarian Dance")), "main renders while the check runs");
	await ui.close();

	const system = offerHarness(Promise.resolve({ latest: "2026.11.05", current: "2026.10.26" }), {
		resolveTools: async () => ({ ytDlp: { path: "/usr/bin/yt-dlp", source: "system" }, mpv: { path: "/usr/bin/mpv" } }),
	});
	const sys = await openYt(system);
	assert.deepEqual(system.checks, []);
	assert.ok(!sys.lines().some((l) => l.includes("available")));
	await sys.close();

	const gate = offerHarness(Promise.resolve({ latest: "2026.11.05", current: "2026.10.26" }), {
		resolveTools: async () => ({ ytDlp: { path: MANAGED, source: "managed" }, mpv: null }),
	});
	await (await openYt(gate)).close();
	assert.deepEqual(gate.checks, []);
});

// ---- S25 sticky update offer ----

const hasOffer = (lines: string[]) => lines.some((l) => l.includes(OFFER));

// S25: keys, playing, the wheel and clicks elsewhere keep the offer; Enter plays; l hides it for the session.
test("S25 update offer: stays while using /yt, Enter plays a track, l hides it for the session", async () => {
	const h = offerHarness(Promise.resolve({ latest: "2026.11.05", current: "2026.10.26" }));
	const ui = await openYt(h);
	assert.ok(hasOffer(ui.lines()), ui.lines().join("\n"));
	await ui.press(DOWN, "\t", DOWN, DOWN, "\r");
	assert.deepEqual(h.fake.calls.filter((c) => c[0] === "play").map((c) => c[2]), [0], "Enter plays the track under the cursor");
	const history = find(ui.lines(), "History");
	ui.component.handleMouse!(mouse("click", history.x, history.y));
	ui.component.handleMouse!(mouse("wheel", history.x, history.y, { wheelDelta: 1 }));
	await ui.press("/", "n", "u", "l");
	assert.ok(hasOffer(ui.lines()), ui.lines().join("\n"));
	assert.ok(ui.lines().some((l) => l.includes("› nul")), "u and l are typed into the search input");
	assert.deepEqual(h.updates, []);
	await ui.press("\t", "l");
	assert.ok(!ui.lines().some((l) => l.includes("available")), ui.lines().join("\n"));
	assert.deepEqual(h.updates, []);
	await ui.close();
	const again = await openYt(h);
	assert.ok(!again.lines().some((l) => l.includes("available")));
	assert.equal(h.checks.length, 1, "not asked again after Later");
	await again.close();
});

// S25: a click on ▸ Update (u) runs the same updater as u.
test("S25 update offer: a click on ▸ Update (u) runs updateYtDlp and shows the result", async () => {
	const h = offerHarness(Promise.resolve({ latest: "2026.11.05", current: "2026.10.26" }));
	const ui = await openYt(h);
	await ui.press(DOWN);
	const update = find(ui.lines(), "▸ Update (u)");
	ui.component.handleMouse!(mouse("click", update.x + 2, update.y));
	await ui.press();
	assert.deepEqual(h.updates, [{ path: MANAGED, source: "managed" }]);
	assert.ok(ui.lines().some((l) => l.includes("yt-dlp is up to date.")), ui.lines().join("\n"));
	await ui.close();
});

// ---- Review advisories (S28, S31) ----

const boom = async (): Promise<never> => {
	throw new Error("boom");
};
const THROWING: NonNullable<YoutubeDeps["source"]> = { listSource: boom, listPlaylists: boom, listPlaylist: boom, search: boom, verifySession: boom };

// S28: a request whose call throws ends in the error state its screen already shows, never Loading… forever.
test("S28 a source, verify or install call that throws shows its error instead of loading forever", async () => {
	const ui = await openYt(harness({ source: THROWING }));
	let lines = ui.lines();
	assert.ok(lines.some((l) => /│ Could not load from YouTube\.\s+│$/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => / Try again\.\s+│$/.test(l)), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("Loading…")), lines.join("\n"));
	await ui.press(DOWN, DOWN, DOWN, DOWN, "\r");
	lines = ui.lines();
	assert.ok(lines.some((l) => /│ Could not load from YouTube\.  Try again\.\s+│$/.test(l)), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("Loading…")), lines.join("\n"));
	await ui.close();

	const connect = await openYt(harness({ source: THROWING, readConfig: async () => ({ version: 1, account: null }) }));
	await connect.press("\r");
	lines = connect.lines();
	assert.ok(lines.some((l) => /│ Could not load from YouTube\.\s+│$/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /│ ▸ Retry\s+│$/.test(l)), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("checking…")), lines.join("\n"));
	await connect.close();

	const install = await openYt(setupHarness([{ ytDlp: null, mpv: { path: "/usr/bin/mpv" } }], { installYtDlp: boom }) as ReturnType<typeof harness>);
	await install.press("\r", "\r");
	lines = install.lines();
	assert.ok(lines.some((l) => /│ Could not install yt-dlp\.\s+│$/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /│ ▸ Retry\s+│$/.test(l)), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("Downloading")), lines.join("\n"));
	await install.press("\x1b"); // Back to Dependencies; the next esc closes /yt
	await install.close();
});

// S31: a load that answers after Disconnect never puts the old account's list back in the session cache.
test("S31 a playlists load still running at Disconnect does not refill the cache", async () => {
	let calls = 0;
	let release: ((result: { ok: true; playlists: { id: string; title: string; count: number | null }[] }) => void) | undefined;
	const h = harness({
		source: {
			listSource: async () => ({ ok: true, tracks: TRACKS }),
			listPlaylists: () => {
				calls++;
				return new Promise((resolve) => (release = resolve));
			},
			listPlaylist: async () => ({ ok: true, tracks: [] }),
			search: async () => ({ ok: true, tracks: [] }),
			verifySession: async () => ({ ok: true }),
		},
	});
	const ui = await openYt(h);
	await ui.press(DOWN, DOWN, DOWN, DOWN, "\r");
	assert.equal(calls, 1);
	await ui.press(DOWN, DOWN, DOWN, "\r", DOWN, "\r");
	assert.deepEqual(h.writes, [{ account: null }]);
	release!({ ok: true, playlists: [{ id: "PL1", title: "Road trip", count: 2 }] });
	await ui.press();
	await ui.close();

	const again = await openYt(h);
	await again.press(DOWN, DOWN, DOWN, DOWN, "\r");
	assert.equal(calls, 2, "the playlists are asked again, not read from the cache");
	await again.close();
});
