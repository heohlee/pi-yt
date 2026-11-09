import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACCOUNT_CHOICES,
	type Action,
	connectOptions,
	dependencyOptions,
	type Effect,
	hasLoadMore,
	initOverlay,
	type Key,
	keyFromInput,
	leftRows,
	loadMoreIndex,
	type OverlayInit,
	type OverlayState,
	reduce,
	selectedTrack,
	snapshotOverlay,
	type Target,
} from "../lib/overlay-model.ts";
import type { PlayerState } from "../lib/player.ts";
import type { Track } from "../lib/youtube-source.ts";

const FIREFOX = {
	id: "firefox" as const,
	label: "Firefox",
	profileName: "default-release",
	profile: "default-release",
};
const CHROMIUM = { id: "chromium" as const, label: "Chromium", profileName: "Default", profile: "Default" };
const ACCOUNT = { browser: "firefox" as const, profile: "default-release" };

const track = (n: number): Track => ({
	id: `id${n}`,
	title: `Song ${n}`,
	artist: `Artist ${n}`,
	duration: 200 + n,
	url: `https://www.youtube.com/watch?v=id${n}`,
});
const TRACKS = [track(1), track(2), track(3)];

const playerState = (over: Partial<PlayerState> = {}): PlayerState => ({
	running: true,
	idle: false,
	paused: false,
	title: "Song 1",
	artist: "Artist 1",
	elapsed: 80,
	duration: 252,
	volume: 60,
	shuffle: false,
	position: 0,
	queue: TRACKS,
	resolving: false,
	...over,
});

function init(over: Partial<OverlayInit> = {}) {
	return initOverlay({
		account: null,
		anonymous: false,
		browsers: [FIREFOX, CHROMIUM],
		deps: null,
		player: null,
		...over,
	});
}

/** Apply actions in order, collecting every effect. */
function run(state: OverlayState, ...actions: Action[]) {
	const effects: Effect[] = [];
	for (const action of actions) {
		const out = reduce(state, action);
		state = out.state;
		effects.push(...out.effects);
	}
	return { state, effects };
}
const keys = (...ks: Key[]): Action[] => ks.map((key) => ({ type: "key", key }));
const loadId = (effects: Effect[]) => {
	const load = effects.find((e) => e.type === "load");
	assert.ok(load && load.type === "load");
	return load.id;
};

/** Main screen with an account, Recommended loaded with TRACKS, focus on the right pane. */
function loadedMain() {
	const start = init({ account: ACCOUNT, player: playerState() });
	return run(
		start.state,
		{ type: "loaded", id: loadId(start.effects), result: { ok: true, tracks: TRACKS } },
		...keys("tab"),
	);
}

// S3: connect screen when there is no account and anonymous was not chosen.
test("init without account opens the connect screen; with an account it opens main and loads Recommended", () => {
	const connect = init();
	assert.equal(connect.state.screen, "connect");
	assert.deepEqual(connect.effects, []);

	const main = init({ account: ACCOUNT });
	assert.equal(main.state.screen, "main");
	assert.deepEqual(main.effects, [{ type: "load", id: loadId(main.effects), request: { kind: "recommended" } }]);
	assert.equal(main.state.list.status, "loading");

	assert.equal(init({ anonymous: true }).state.screen, "main");
});

// #46: a saved account that could not be read opens connect with a notice; a missing one stays silent.
const UNREADABLE = {
	message: "Saved account could not be read.",
	hint: "Pick a browser profile to connect again.",
	tone: "error",
};

test("init with an unreadable config opens connect with the unreadable notice", () => {
	const out = init({ configUnreadable: true, deps: { mpv: true, ytDlp: "system" } });
	assert.equal(out.state.screen, "connect");
	assert.deepEqual(out.state.notice, UNREADABLE);
	assert.deepEqual(out.effects, []);
});

test("init with a missing config or after continuing anonymously shows no notice", () => {
	const missing = init({ configUnreadable: false });
	assert.equal(missing.state.screen, "connect");
	assert.equal(missing.state.notice, null);

	const anonymous = init({ configUnreadable: true, anonymous: true });
	assert.equal(anonymous.state.screen, "main");
	assert.equal(anonymous.state.notice, null);
});

test("a missing tool still opens Dependencies over the unreadable notice", () => {
	const out = init({ configUnreadable: true, deps: { mpv: false, ytDlp: "system" } });
	assert.equal(out.state.screen, "dependencies");
	assert.equal(out.state.notice, null);
	assert.deepEqual(out.effects, []);
});

test("the unreadable notice clears on the next key and leaves the cursor move intact", () => {
	const { state, effects } = run(init({ configUnreadable: true }).state, ...keys("down"));
	assert.equal(state.notice, null);
	assert.equal(state.screen, "connect");
	assert.equal(state.connect.cursor, 1);
	assert.deepEqual(effects, []);
});

// S3: enter on a browser verifies; ok writes the config and goes to main.
test("connect: verify ok saves the account and opens main", () => {
	const { state, effects } = run(init().state, ...keys("down", "enter"));
	assert.deepEqual(effects, [
		{ type: "verify", id: (effects[0] as { id: number }).id, account: { browser: "chromium", profile: "Default" } },
	]);
	assert.equal(state.connect.phase, "verifying");

	const id = (effects[0] as { id: number }).id;
	const done = run(state, { type: "verified", id, result: { ok: true } });
	assert.equal(done.state.screen, "main");
	assert.deepEqual(done.state.account, { browser: "chromium", profile: "Default" });
	assert.deepEqual(done.effects[0], { type: "saveAccount", account: { browser: "chromium", profile: "Default" } });
	assert.deepEqual(done.effects[1], { type: "load", id: loadId(done.effects), request: { kind: "recommended" } });
});

// S8: a sign-in failure offers Retry / Use another browser / Continue without an account.
test("connect: signin error offers retry, another browser and anonymous", () => {
	const error = {
		kind: "signin" as const,
		message: "YouTube session not found in Firefox.",
		hint: "Sign in at youtube.com in Firefox, then retry.",
		detail: "ERROR: secret stderr",
	};
	const first = run(init().state, ...keys("enter"));
	const id = (first.effects[0] as { id: number }).id;
	const failed = run(first.state, { type: "verified", id, result: { ok: false, error } });
	assert.equal(failed.state.connect.phase, "error");
	assert.deepEqual(failed.state.connect.error, error);
	assert.deepEqual(failed.effects, []);

	const retry = run(failed.state, ...keys("enter"));
	assert.equal(retry.effects.length, 1);
	assert.equal(retry.effects[0].type, "verify");
	assert.notEqual((retry.effects[0] as { id: number }).id, id);
	assert.equal(retry.state.connect.phase, "verifying");

	const another = run(failed.state, ...keys("down", "enter"));
	assert.equal(another.state.connect.phase, "pick");
	assert.equal(another.state.screen, "connect");

	const anon = run(failed.state, ...keys("down", "down", "enter"));
	assert.equal(anon.state.screen, "main");
	assert.equal(anon.state.anonymous, true);
});

// S3: stale verification results are ignored.
test("connect: a verification result for an older request is ignored", () => {
	const first = run(init().state, ...keys("enter"));
	const id = (first.effects[0] as { id: number }).id;
	const stale = run(first.state, { type: "verified", id: id + 100, result: { ok: true } });
	assert.equal(stale.state.screen, "connect");
	assert.deepEqual(stale.effects, []);
});

// S3: continuing without an account never writes the config and lands on search.
test("connect: continue without an account opens main anonymously on search", () => {
	const { state, effects } = run(init().state, ...keys("down", "down", "enter"));
	assert.deepEqual(effects, []);
	assert.equal(state.screen, "main");
	assert.equal(state.anonymous, true);
	assert.equal(state.account, null);
	assert.equal(state.source?.kind, "search");
	assert.equal(state.focus, "right");

	const none = init({ browsers: [] });
	const anon = run(none.state, ...keys("enter"));
	assert.equal(anon.state.anonymous, true);
});

// S2: selecting a source cancels the previous request and emits a new load.
test("selecting a source cancels the previous load and emits a list effect", () => {
	const start = init({ account: ACCOUNT });
	const firstId = loadId(start.effects);
	const { state, effects } = run(start.state, ...keys("down", "enter"));
	assert.deepEqual(effects, [
		{ type: "cancel", id: firstId },
		{ type: "load", id: loadId(effects), request: { kind: "history" } },
	]);
	assert.notEqual(loadId(effects), firstId);
	assert.equal(state.list.status, "loading");
	assert.equal(state.source?.kind, "history");
	assert.equal(state.focus, "right");
});

// S2: results for the current request are shown; stale results are ignored.
test("loaded results show tracks; results for a previous source are ignored", () => {
	const start = init({ account: ACCOUNT });
	const firstId = loadId(start.effects);
	const switched = run(start.state, ...keys("down", "enter"));
	const stale = run(switched.state, { type: "loaded", id: firstId, result: { ok: true, tracks: TRACKS } });
	assert.equal(stale.state.list.status, "loading");
	assert.deepEqual(stale.state.list.tracks, []);

	const fresh = run(switched.state, {
		type: "loaded",
		id: loadId(switched.effects),
		result: { ok: true, tracks: TRACKS },
	});
	assert.equal(fresh.state.list.status, "ready");
	assert.deepEqual(fresh.state.list.tracks, TRACKS);
	const later = leftRows(fresh.state).find((r) => r.type === "source" && r.key === "history");
	assert.equal(later && later.type === "source" ? later.count : undefined, 3);
});

// S8: a source error is kept as message + hint for the view.
test("a failed load keeps the error for the right pane", () => {
	const start = init({ account: ACCOUNT });
	const error = {
		kind: "extract" as const,
		message: "yt-dlp could not read YouTube.",
		hint: "Update yt-dlp.",
		detail: "x",
	};
	const { state } = run(start.state, { type: "loaded", id: loadId(start.effects), result: { ok: false, error } });
	assert.equal(state.list.status, "error");
	assert.deepEqual(state.list.error, error);
});

// S2/S5: enter on a track plays the list from there; Play all from 0; Shuffle plays then shuffles.
test("enter on a track, Play all and Shuffle emit exact player effects", () => {
	const { state } = loadedMain();
	assert.equal(state.rightIndex, 0);
	assert.deepEqual(run(state, ...keys("enter")).effects, [{ type: "play", tracks: TRACKS, index: 0 }]);
	assert.deepEqual(run(state, ...keys("down", "enter")).effects, [
		{ type: "play", tracks: TRACKS, index: 0 },
		{ type: "setShuffle", on: true },
	]);
	// S21: moving onto the tracks also emits dwell effects; only the player effects are checked here.
	const played = (...ks: Key[]) => run(state, ...keys(...ks)).effects.filter((e) => e.type !== "dwell");
	assert.deepEqual(played("down", "down", "down", "down", "enter"), [{ type: "play", tracks: TRACKS, index: 2 }]);
	// Bottom of the list clamps.
	assert.deepEqual(played("down", "down", "down", "down", "down", "down", "enter"), [
		{ type: "play", tracks: TRACKS, index: 2 },
	]);
});

// S5: a, space, n, p, +, - map to player commands; volume clamping is the player's job.
test("playback keys emit enqueue, togglePause, next, prev and setVolume", () => {
	const { state } = loadedMain();
	const onTrack = run(state, ...keys("down", "down", "down")).state;
	assert.deepEqual(run(onTrack, ...keys({ text: "a" })).effects, [{ type: "enqueue", track: TRACKS[1] }]);
	assert.deepEqual(run(state, ...keys({ text: "a" })).effects, [], "a on the actions row does nothing");
	assert.deepEqual(run(state, ...keys({ text: " " })).effects, [{ type: "togglePause" }]);
	assert.deepEqual(run(state, ...keys({ text: "n" })).effects, [{ type: "next" }]);
	assert.deepEqual(run(state, ...keys({ text: "p" })).effects, [{ type: "prev" }]);
	assert.deepEqual(run(state, ...keys({ text: "+" })).effects, [{ type: "setVolume", volume: 65 }]);
	assert.deepEqual(run(state, ...keys({ text: "-" })).effects, [{ type: "setVolume", volume: 55 }]);
	const loud = run(state, { type: "player", state: playerState({ volume: 100 }) }).state;
	assert.deepEqual(run(loud, ...keys({ text: "+" })).effects, [{ type: "setVolume", volume: 105 }]);
});

// S2: esc closes; in search with a query the first esc clears it.
test("esc closes, but first clears a search query", () => {
	const { state } = loadedMain();
	assert.deepEqual(run(state, ...keys("esc")).effects, [{ type: "close" }]);

	const typed = run(state, ...keys({ text: "/" }, { text: "nujabes" }));
	assert.equal(typed.state.query, "nujabes");
	const cleared = run(typed.state, ...keys("esc"));
	assert.equal(cleared.state.query, "");
	assert.deepEqual(cleared.effects, []);
	assert.deepEqual(run(cleared.state, ...keys("esc")).effects, [{ type: "close" }]);

	assert.deepEqual(run(init().state, ...keys("esc")).effects, [{ type: "close" }]);
});

// S6: typing in the search pane edits the query; enter searches.
test("search: typing, backspace and enter emit a search load", () => {
	const { state } = loadedMain();
	const typed = run(
		state,
		...keys({ text: "/" }, { text: "nu" }, { text: "j" }, { text: " " }, { text: "x" }, "backspace"),
	);
	assert.equal(typed.state.source?.kind, "search");
	assert.equal(typed.state.query, "nuj ");
	const searched = run(typed.state, ...keys("enter"));
	assert.deepEqual(searched.effects.at(-1), {
		type: "load",
		id: loadId(searched.effects),
		request: { kind: "search", query: "nuj" },
	});

	const results = run(searched.state, {
		type: "loaded",
		id: loadId(searched.effects),
		result: { ok: true, tracks: TRACKS },
	});
	const onResult = run(results.state, ...keys("down"));
	assert.deepEqual(run(onResult.state, ...keys({ text: "a" })).effects, [{ type: "enqueue", track: TRACKS[0] }]);
	assert.deepEqual(run(onResult.state, ...keys("enter")).effects, [{ type: "play", tracks: TRACKS, index: 0 }]);
	const retyped = run(onResult.state, ...keys({ text: "z" }));
	assert.equal(retyped.state.query, "nuj z");
	assert.equal(retyped.state.rightIndex, 0);
});

// S7: tab, left and right switch the focused pane (narrow shows only that pane).
test("tab toggles panes; left and right pick one", () => {
	const start = init({ account: ACCOUNT }).state;
	assert.equal(start.focus, "left");
	const tabbed = run(start, ...keys("tab"));
	assert.equal(tabbed.state.focus, "right");
	assert.equal(run(tabbed.state, ...keys("tab")).state.focus, "left");
	assert.equal(run(start, ...keys("right")).state.focus, "right");
	assert.equal(run(tabbed.state, ...keys("left")).state.focus, "left");
});

// S2: Playlists expand lazily, once; a playlist entry loads its tracks.
test("playlists load on first expand and their entries load tracks", () => {
	const start = init({ account: ACCOUNT }).state;
	const expanded = run(start, ...keys("down", "down", "down", "down", "enter"));
	const effect = expanded.effects[0];
	assert.equal(effect.type, "loadPlaylists");
	assert.equal(expanded.state.playlists.status, "loading");

	const id = (effect as { id: number }).id;
	const playlists = [{ id: "PL1", title: "Lo-fi to code", count: 12 }];
	const ready = run(expanded.state, { type: "playlistsLoaded", id, result: { ok: true, playlists } });
	const entry = leftRows(ready.state).find((r) => r.type === "source" && r.key === "playlist:PL1");
	assert.ok(entry);

	const collapsed = run(ready.state, ...keys("enter"));
	assert.equal(collapsed.state.playlistsOpen, false);
	const reopened = run(collapsed.state, ...keys("enter"));
	assert.deepEqual(reopened.effects, [], "playlists are not reloaded");

	const picked = run(reopened.state, ...keys("down", "enter"));
	assert.deepEqual(picked.effects.at(-1), {
		type: "load",
		id: loadId(picked.effects),
		request: { kind: "playlist", id: "PL1" },
	});
});

// S2: anonymous users see account-only sources; enter on one opens connect.
test("anonymous: enter on an account-only source opens the connect screen", () => {
	const anon = init({ anonymous: true }).state;
	const { state, effects } = run(anon, ...keys("left", "up", "up", "up", "enter"));
	assert.deepEqual(effects, []);
	assert.equal(state.screen, "connect");
	assert.equal(state.anonymous, false);
});

// S2/S8: player errors become one notice; player state updates the queue source.
test("player errors become a notice and player updates refresh the queue", () => {
	const { state } = loadedMain();
	const notice = { message: "mpv not found", hint: "Install it: sudo pacman -S mpv" };
	const errored = run(state, { type: "playerError", error: notice });
	assert.deepEqual(errored.state.notice, notice);
	assert.equal(run(errored.state, ...keys("down")).state.notice, null, "a key clears the notice");

	const queue = run(state, ...keys("left", "down", "down", "down", "down", "down", "enter"));
	assert.equal(queue.state.source?.kind, "queue");
	assert.deepEqual(queue.effects, []);
	assert.deepEqual(queue.state.list.tracks, TRACKS);
	const grown = run(queue.state, { type: "player", state: playerState({ queue: [...TRACKS, track(4)] }) });
	assert.equal(grown.state.list.tracks.length, 4);
});

test("keyFromInput maps keybindings and raw keys", () => {
	const ids: Record<string, string> = {
		"\x1b[A": "tui.select.up",
		"\x1b[B": "tui.select.down",
		"\r": "tui.select.confirm",
		"\x1b": "tui.select.cancel",
	};
	const matches = (data: string, id: string) => ids[data] === id;
	assert.equal(keyFromInput("\x1b[A", matches), "up");
	assert.equal(keyFromInput("\x1b[B", matches), "down");
	assert.equal(keyFromInput("\r", matches), "enter");
	assert.equal(keyFromInput("\x1b", matches), "esc");
	assert.equal(keyFromInput("\t", matches), "tab");
	assert.equal(keyFromInput("\x1b[D", matches), "left");
	assert.equal(keyFromInput("\x1b[C", matches), "right");
	assert.equal(keyFromInput("\x7f", matches), "backspace");
	assert.deepEqual(keyFromInput("a", matches), { text: "a" });
	assert.deepEqual(keyFromInput("héllo", matches), { text: "héllo" });
	assert.equal(keyFromInput("\x1b[1;5A", matches), undefined);
});

/** Main with an account, cursor on the Account row (last left row). */
function onAccountRow() {
	const start = init({ account: ACCOUNT });
	const loaded = { type: "loaded", id: loadId(start.effects), result: { ok: true, tracks: TRACKS } } as const;
	return run(start.state, loaded, ...keys("down", "down", "down", "down", "down", "down", "down")).state;
}

// S10: anonymous Connect an account row opens the connect screen.
test("account row: Enter on Connect an account opens the connect screen", () => {
	const anon = init({ anonymous: true }).state;
	const onRow = run(anon, ...keys("left", "down")).state;
	assert.equal(onRow.leftKey, "account");
	const { state, effects } = run(onRow, ...keys("enter"));
	assert.equal(state.screen, "connect");
	assert.equal(state.connect.phase, "pick");
	assert.deepEqual(effects, []);
});

// S10: with an account, Enter opens the account choice.
test("account row: Enter on Account · Firefox opens the account choice", () => {
	const onRow = onAccountRow();
	assert.equal(onRow.leftKey, "account");
	const { state, effects } = run(onRow, ...keys("enter"));
	assert.equal(state.screen, "main");
	assert.equal(state.accountMenu, 0);
	assert.deepEqual(effects, []);
});

// S10: Use another browser goes to connect in pick phase; the account stays until a new one verifies.
test("account choice: Use another browser opens connect pick with the account still set", () => {
	const { state, effects } = run(onAccountRow(), ...keys("enter", "enter"));
	assert.equal(state.screen, "connect");
	assert.equal(state.connect.phase, "pick");
	assert.deepEqual(state.account, ACCOUNT);
	assert.deepEqual(
		effects.filter((e) => e.type === "clearAccount" || e.type === "saveAccount"),
		[],
	);
});

// S10: esc from connect with an account still saved returns to main.
test("connect: esc with an account still saved returns to main", () => {
	const connect = run(onAccountRow(), ...keys("enter", "enter")).state;
	const { state, effects } = run(connect, ...keys("esc"));
	assert.equal(state.screen, "main");
	assert.equal(state.accountMenu, null);
	assert.deepEqual(state.account, ACCOUNT);
	assert.ok(!effects.some((e) => e.type === "close"));
});

// S10: Disconnect clears the account and opens the connect screen.
test("account choice: Disconnect emits clearAccount and opens connect without an account", () => {
	const { state, effects } = run(onAccountRow(), ...keys("enter", "down", "enter"));
	assert.deepEqual(effects, [{ type: "clearAccount" }]);
	assert.equal(state.account, null);
	assert.equal(state.screen, "connect");
	assert.equal(state.accountMenu, null);
	assert.deepEqual(run(state, ...keys("esc")).effects, [{ type: "close" }]);
});

// S10: esc in the account choice returns to the main view.
test("account choice: esc returns to main", () => {
	const { state, effects } = run(onAccountRow(), ...keys("enter", "esc"));
	assert.equal(state.screen, "main");
	assert.equal(state.accountMenu, null);
	assert.equal(state.leftKey, "account");
	assert.deepEqual(effects, []);
});

const rowCount = (state: OverlayState, key: string) => {
	const row = leftRows(state).find((r) => r.type === "source" && r.key === key);
	return row && row.type === "source" ? row.count : undefined;
};

/** Recommended loaded with a full first page (hasMore), focus on the right pane, cursor on Load more. */
function onLoadMore() {
	const start = init({ account: ACCOUNT });
	const loaded = run(start.state, {
		type: "loaded",
		id: loadId(start.effects),
		result: { ok: true, tracks: TRACKS, hasMore: true },
	});
	// Play all, Shuffle, 3 tracks, then Load more.
	return run(loaded.state, ...keys("tab", "down", "down", "down", "down", "down"));
}

// S14: a full page offers Load more; Enter asks for the next page.
test("S14 Load more emits a load for the next page starting after the loaded tracks", () => {
	const { state } = onLoadMore();
	assert.equal(state.list.hasMore, true);
	assert.equal(state.rightIndex, 5);
	assert.equal(run(state, ...keys("down")).state.rightIndex, 5, "Load more is the last row");
	const more = run(state, ...keys("enter"));
	assert.deepEqual(more.effects, [
		{ type: "load", id: loadId(more.effects), request: { kind: "recommended", start: 4 } },
	]);
	assert.equal(more.state.list.more, loadId(more.effects), "Loading more… while the page is pending");
	assert.equal(more.state.list.status, "ready");
	assert.deepEqual(more.state.list.tracks, TRACKS);
	assert.deepEqual(run(more.state, ...keys("enter")).effects, [], "a second Enter while loading does nothing");

	const start = init({ account: ACCOUNT });
	const short = run(
		start.state,
		{ type: "loaded", id: loadId(start.effects), result: { ok: true, tracks: TRACKS, hasMore: false } },
		...keys("tab", "down", "down", "down", "down", "down", "down"),
	);
	assert.equal(short.state.rightIndex, 4, "no Load more row without hasMore");
});

// S14: the next page appends to the list; counts follow; the cursor stays.
test("S14 the next page appends tracks and updates hasMore and the count", () => {
	const more = run(onLoadMore().state, ...keys("enter"));
	const page = [track(4), track(5)];
	const { state } = run(more.state, {
		type: "loaded",
		id: loadId(more.effects),
		result: { ok: true, tracks: page, hasMore: false },
	});
	assert.deepEqual(state.list.tracks, [...TRACKS, ...page]);
	assert.equal(state.list.hasMore, false);
	assert.equal(state.list.more, null);
	assert.equal(state.rightIndex, 5);
	assert.equal(rowCount(state, "recommended"), 5);
	assert.deepEqual(run(state, ...keys("enter")).effects, [{ type: "play", tracks: [...TRACKS, ...page], index: 3 }]);
});

// S14: a page for a list the user left, or replaced with r, is ignored.
test("S14 a stale page is ignored after switching source or reloading", () => {
	const more = run(onLoadMore().state, ...keys("enter"));
	const moreId = loadId(more.effects);
	const page: Action = { type: "loaded", id: moreId, result: { ok: true, tracks: [track(9)], hasMore: false } };

	const switched = run(more.state, ...keys("left", "down", "enter"));
	assert.deepEqual(switched.effects[0], { type: "cancel", id: moreId });
	assert.deepEqual(run(switched.state, page).state.list, switched.state.list);

	const reloaded = run(more.state, ...keys({ text: "r" }));
	assert.deepEqual(reloaded.effects[0], { type: "cancel", id: moreId });
	assert.deepEqual(run(reloaded.state, page).state.list, reloaded.state.list);
});

// S14/S8: a failed page keeps the loaded tracks and shows the error as the notice.
test("S14 a failed page keeps the tracks and shows the notice", () => {
	const more = run(onLoadMore().state, ...keys("enter"));
	const error = {
		kind: "network" as const,
		message: "Could not reach YouTube.",
		hint: "Check your connection and retry.",
	};
	const { state } = run(more.state, { type: "loaded", id: loadId(more.effects), result: { ok: false, error } });
	assert.deepEqual(state.list.tracks, TRACKS);
	assert.equal(state.list.status, "ready");
	assert.equal(state.list.more, null);
	assert.equal(state.list.hasMore, true, "Load more stays to retry");
	assert.deepEqual(state.notice, { message: error.message, hint: error.hint });
});

// S14: r in the right pane reloads the current source from page 1.
test("S14 r reloads the current source from page 1; queue, search and source rows ignore it", () => {
	const { state } = loadedMain();
	const reloaded = run(state, ...keys("down", { text: "r" }));
	assert.deepEqual(reloaded.effects, [
		{ type: "load", id: loadId(reloaded.effects), request: { kind: "recommended", refresh: true } },
	]);
	assert.equal(reloaded.state.list.status, "loading");
	assert.equal(reloaded.state.rightIndex, 0);

	const queue = run(state, ...keys("left", "down", "down", "down", "down", "down", "enter"));
	assert.deepEqual(run(queue.state, ...keys({ text: "r" })).effects, []);
	const typed = run(state, ...keys({ text: "/" }, { text: "r" }));
	assert.equal(typed.state.query, "r");
	assert.deepEqual(typed.effects, []);
	assert.deepEqual(run(state, ...keys("left", { text: "r" })).effects, [], "r on a left source row does nothing");
});

// S14: r on the Playlists row reloads the playlists feed.
test("S14 r on the Playlists row reloads the playlists feed", () => {
	const start = init({ account: ACCOUNT }).state;
	const reloaded = run(start, ...keys("down", "down", "down", "down", { text: "r" }));
	assert.deepEqual(reloaded.effects, [{ type: "loadPlaylists", id: reloaded.state.playlists.id, refresh: true }]);
	assert.equal(reloaded.state.playlists.status, "loading");
	assert.equal(reloaded.state.playlistsOpen, true);
	assert.deepEqual(run(init({ anonymous: true }).state, ...keys("left", "up", "up", { text: "r" })).effects, []);
});

// ---- S17 easy dependency install ----

const SETUP = {
	ytDlp: { version: "2026.10.26", size: 41166968, dir: "~/.local/share/pi-yt/bin" },
	mpv: { command: "sudo pacman -S mpv", text: "sudo pacman -S mpv" },
};
const MISSING_BOTH = { mpv: false, ytDlp: null };
const idOf = (effects: Effect[], type: string) => {
	const effect = effects.find((e) => e.type === type);
	assert.ok(effect && "id" in effect, `${type} effect`);
	return effect.id as number;
};
/** Dependencies screen with both tools missing (Install yt-dlp, How to install mpv, Check again), after `ks`. */
const gateMissing = (...ks: Key[]) => run(init({ deps: MISSING_BOTH, setup: SETUP }).state, ...keys(...ks));

// S19: the gate guarantees both tools on the connect screen, so it offers no tool rows.
test("S19 connect options never include tool actions", () => {
	const types = (deps: OverlayInit["deps"]) => connectOptions(init({ deps, setup: SETUP }).state).map((o) => o.type);
	assert.deepEqual(types({ mpv: true, ytDlp: "system" }), ["browser", "browser", "anonymous"]);
	assert.deepEqual(types(null), ["browser", "browser", "anonymous"]);
	assert.deepEqual(
		connectOptions({ ...init().state, deps: MISSING_BOTH }).map((o) => o.type),
		["browser", "browser", "anonymous"],
	);
});

// S17: Install yt-dlp asks first; Install starts the download, Cancel and esc go back.
test("S17 Install yt-dlp opens the confirmation; Install emits install, Cancel/esc return", () => {
	const confirm = gateMissing("enter");
	assert.deepEqual(confirm.effects, []);
	assert.deepEqual(confirm.state.dialog, { type: "confirm", cursor: 0, retry: null });

	const started = run(confirm.state, ...keys("enter"));
	const id = idOf(started.effects, "install");
	assert.deepEqual(started.effects, [{ type: "install", id }]);
	assert.deepEqual(started.state.dialog, {
		type: "download",
		id,
		received: 0,
		total: 41166968,
		verifying: false,
		retry: null,
	});

	for (const back of [keys("down", "enter"), keys("esc")]) {
		const out = run(confirm.state, ...back);
		assert.equal(out.state.dialog, null);
		assert.equal(out.state.screen, "dependencies");
		assert.deepEqual(out.effects, []);
	}
});

// S17: progress and verification update the download; esc cancels it.
test("S17 download progress, verifying and esc cancel", () => {
	const started = gateMissing("enter", "enter");
	const id = idOf(started.effects, "install");
	const progressed = run(
		started.state,
		{ type: "installProgress", id, progress: { phase: "download", received: 1000, total: 2000 } },
		{ type: "installProgress", id: id + 50, progress: { phase: "download", received: 5, total: 5 } },
	);
	assert.deepEqual(progressed.state.dialog, {
		type: "download",
		id,
		received: 1000,
		total: 2000,
		verifying: false,
		retry: null,
	});
	const verifying = run(progressed.state, { type: "installProgress", id, progress: { phase: "verify" } });
	assert.equal(verifying.state.dialog?.type === "download" && verifying.state.dialog.verifying, true);

	const cancelled = run(progressed.state, ...keys("esc"));
	assert.deepEqual(cancelled.effects, [{ type: "cancel", id }]);
	assert.equal(cancelled.state.dialog, null);
	assert.deepEqual(
		run(cancelled.state, { type: "installed", id, result: { ok: true } }).effects,
		[],
		"late result ignored",
	);
});

// S17/S19: success closes the dialog, says so and re-resolves the tools; the rows refresh from deps.
test("S17 a finished install shows ✓ yt-dlp installed and re-checks the tools", () => {
	const started = gateMissing("enter", "enter");
	const id = idOf(started.effects, "install");
	const done = run(started.state, { type: "installed", id, result: { ok: true } });
	assert.equal(done.state.dialog, null);
	assert.deepEqual(done.state.notice, { message: "✓ yt-dlp installed", hint: "", tone: "success" });
	assert.deepEqual(done.effects, [{ type: "checkTools" }]);
	const refreshed = run(done.state, { type: "deps", deps: { mpv: false, ytDlp: "managed" } });
	assert.deepEqual(refreshed.state.deps, { mpv: false, ytDlp: "managed" });
	assert.equal(refreshed.state.screen, "dependencies");
	assert.deepEqual(dependencyOptions(refreshed.state), ["mpvHelp", "check"]);
	assert.deepEqual(refreshed.state.notice, { message: "✓ yt-dlp installed", hint: "", tone: "success" });
});

// S17: a failed install shows message and hint with Retry / Back.
test("S17 a failed install offers Retry and Back", () => {
	const started = gateMissing("enter", "enter");
	const id = idOf(started.effects, "install");
	const error = {
		kind: "hash",
		message: "The download did not match the official checksum.",
		hint: "Nothing was installed. Retry later.",
	};
	const failed = run(started.state, { type: "installed", id, result: { ok: false, error } });
	assert.deepEqual(failed.state.dialog, {
		type: "failed",
		error: { message: error.message, hint: error.hint },
		cursor: 0,
		retry: null,
	});
	assert.deepEqual(failed.effects, []);

	const retried = run(failed.state, ...keys("enter"));
	const again = idOf(retried.effects, "install");
	assert.notEqual(again, id);
	assert.equal(retried.state.dialog?.type, "download");
	assert.equal(run(failed.state, ...keys("down", "enter")).state.dialog, null);
	assert.equal(run(failed.state, ...keys("esc")).state.dialog, null);
});

// S17: without an official build for this system, Install yt-dlp explains it instead of asking.
test("S17 Install yt-dlp on an unsupported system shows the package-manager message", () => {
	const out = run(init({ deps: MISSING_BOTH, setup: { ...SETUP, ytDlp: null } }).state, ...keys("enter"));
	assert.deepEqual(out.effects, []);
	assert.deepEqual(out.state.dialog, {
		type: "failed",
		error: { message: "No official yt-dlp build for this system.", hint: "Install yt-dlp with your package manager." },
		cursor: 0,
		retry: null,
	});
});

// S17: How to install mpv; Copy command, its notices, and Check again.
test("S17 How to install mpv offers Copy command and Check again", () => {
	const help = gateMissing("down", "enter");
	assert.deepEqual(help.state.dialog, { type: "mpv", cursor: 0, checking: false });

	const copy = run(help.state, ...keys("enter"));
	assert.deepEqual(copy.effects, [{ type: "copy", text: "sudo pacman -S mpv" }]);
	assert.deepEqual(run(copy.state, { type: "copied", ok: true }).state.notice, {
		message: "Copied.",
		hint: "",
		tone: "success",
	});
	assert.deepEqual(run(copy.state, { type: "copied", ok: false }).state.notice, {
		message: "No clipboard tool found; copy it by hand.",
		hint: "",
	});

	const check = run(help.state, ...keys("down", "enter"));
	assert.deepEqual(check.effects, [{ type: "checkTools" }]);
	const still = run(check.state, { type: "deps", deps: MISSING_BOTH });
	assert.equal(still.state.dialog?.type, "mpv");
	assert.deepEqual(still.state.notice, { message: "mpv still not found.", hint: "Install it, then check again." });
	const found = run(check.state, { type: "deps", deps: { mpv: true, ytDlp: null } });
	assert.equal(found.state.dialog, null);
	assert.deepEqual(found.state.notice, { message: "✓ mpv found", hint: "", tone: "success" });
	assert.equal(run(help.state, ...keys("esc")).state.dialog, null);

	// No known command: only Check again.
	const unknown = run(
		init({
			deps: MISSING_BOTH,
			setup: {
				...SETUP,
				mpv: { command: null, text: "Install mpv with your package manager: https://mpv.io/installation/" },
			},
		}).state,
		...keys("down", "enter", "enter"),
	);
	assert.deepEqual(unknown.effects, [{ type: "checkTools" }]);
});

/** Main with an account and managed/system yt-dlp, showing the update offer for 2026.11.05 (S23). */
const offered = (ytDlp: "managed" | "system" | null) => {
	const start = init({ account: ACCOUNT, deps: { mpv: true, ytDlp }, setup: SETUP });
	const loaded = run(start.state, { type: "loaded", id: loadId(start.effects), result: { ok: true, tracks: TRACKS } });
	return run(loaded.state, { type: "updateAvailable", latest: "2026.11.05" }).state;
};

// S17/S23: Update from the offer updates the managed copy once, then reports the result.
test("S17 Update yt-dlp updates the managed copy once and reports the result", () => {
	const managed = run(offered("managed"), ...keys({ text: "u" }));
	const id = idOf(managed.effects, "update");
	assert.deepEqual(managed.effects, [{ type: "update", id }, { type: "dismissUpdate" }]);
	assert.deepEqual(managed.state.updating, { id, retry: null });
	const again = run(managed.state, { type: "updateAvailable", latest: "2026.11.05" }, ...keys({ text: "u" }));
	assert.deepEqual(
		again.effects.filter((e) => e.type === "update"),
		[],
		"no second update while one runs",
	);
	const done = run(managed.state, { type: "updated", id, result: { ok: true } });
	assert.equal(done.state.updating, null);
	assert.deepEqual(done.state.notice, { message: "yt-dlp is up to date.", hint: "", tone: "success" });
	const failed = run(managed.state, {
		type: "updated",
		id,
		result: {
			ok: false,
			error: { kind: "update", message: "Could not update yt-dlp.", hint: "Check your connection and retry." },
		},
	});
	assert.deepEqual(failed.state.notice, {
		message: "Could not update yt-dlp.",
		hint: "Check your connection and retry.",
	});
});

const EXTRACT = {
	kind: "extract" as const,
	message: "yt-dlp could not read YouTube.",
	hint: "Update yt-dlp (yt-dlp -U or your package manager) and retry.",
};

// S17/S8: an extraction failure offers Update yt-dlp; Enter updates, then retries the failed load once.
test("S17 an extract error offers Update yt-dlp; Enter updates and retries the load", () => {
	const start = init({ account: ACCOUNT, deps: { mpv: true, ytDlp: "managed" }, setup: SETUP });
	const failed = run(start.state, { type: "loaded", id: loadId(start.effects), result: { ok: false, error: EXTRACT } });
	assert.equal(failed.state.list.status, "error");
	assert.deepEqual(failed.state.notice, {
		message: EXTRACT.message,
		hint: EXTRACT.hint,
		action: "update",
		retry: "list",
	});

	const updating = run(failed.state, ...keys("enter"));
	const id = idOf(updating.effects, "update");
	assert.deepEqual(updating.effects, [{ type: "update", id }]);
	assert.equal(updating.state.notice, null);
	const retried = run(updating.state, { type: "updated", id, result: { ok: true } });
	assert.deepEqual(retried.effects, [{ type: "load", id: loadId(retried.effects), request: { kind: "recommended" } }]);
	assert.equal(retried.state.list.status, "loading");

	// Any other key just dismisses the offer.
	assert.deepEqual(run(failed.state, ...keys("down")).effects, []);
	// Search failures retry the same query.
	const anon = run(
		init({ anonymous: true, deps: { mpv: true, ytDlp: "managed" } }).state,
		...keys({ text: "x" }, "enter"),
	);
	const searchFailed = run(
		anon.state,
		{ type: "loaded", id: loadId(anon.effects), result: { ok: false, error: EXTRACT } },
		...keys("enter"),
	);
	const again = run(searchFailed.state, {
		type: "updated",
		id: idOf(searchFailed.effects, "update"),
		result: { ok: true },
	});
	assert.deepEqual(again.effects, [
		{ type: "load", id: loadId(again.effects), request: { kind: "search", query: "x" } },
	]);
});

// S17/S8: playing without mpv offers How to install mpv.
test("S17 a missing mpv on play offers How to install mpv", () => {
	const { state } = loadedMain();
	const errored = run(state, {
		type: "playerError",
		error: { kind: "missing", message: "mpv not found", hint: "Install it: sudo pacman -S mpv" },
	});
	assert.deepEqual(errored.state.notice, {
		message: "mpv not found",
		hint: "Install it: sudo pacman -S mpv",
		action: "mpv",
	});
	const help = run(errored.state, ...keys("enter"));
	assert.deepEqual(help.effects, []);
	assert.equal(help.state.dialog?.type, "mpv");
	assert.equal(run(help.state, ...keys("esc")).state.screen, "main");
});

// S17/S19: yt-dlp removed after /yt opened: a load offers Install yt-dlp; after installing, the load runs again.
test("S17 a missing yt-dlp on load offers Install yt-dlp and retries after installing", () => {
	const start = init({ account: ACCOUNT, deps: { mpv: true, ytDlp: "system" }, setup: SETUP });
	const missing = { kind: "missing" as const, message: "yt-dlp not found", hint: "Install it." };
	const failed = run(start.state, { type: "loaded", id: loadId(start.effects), result: { ok: false, error: missing } });
	assert.deepEqual(failed.state.notice, {
		message: "yt-dlp not found",
		hint: "Install it.",
		action: "install",
		retry: "list",
	});
	const started = run(failed.state, ...keys("enter", "enter"));
	const id = idOf(started.effects, "install");
	const done = run(started.state, { type: "installed", id, result: { ok: true } });
	assert.deepEqual(done.effects, [
		{ type: "checkTools" },
		{ type: "load", id: loadId(done.effects), request: { kind: "recommended" } },
	]);
});

// ---- S18 remember place and YouTube order ----

const many = (n: number) => Array.from({ length: n }, (_, i) => track(i + 1));
const SCROLL = { left: 0, right: 0 };

// S18(2): with an account and nothing remembered, /yt opens on Recommended, the new top row.
test("S18 init with an account and no snapshot selects Recommended and loads it", () => {
	const { state, effects } = init({ account: ACCOUNT, snapshot: null });
	assert.equal(state.leftKey, "recommended");
	assert.equal(state.focus, "left");
	assert.deepEqual(state.source, { kind: "recommended" });
	assert.deepEqual(effects, [{ type: "load", id: loadId(effects), request: { kind: "recommended" } }]);
	const order = leftRows(state).flatMap((row) => ("key" in row ? [row.key] : []));
	assert.deepEqual(order.slice(0, 4), ["recommended", "history", "later", "liked"]);
});

// S18(1): the snapshot taken on close puts the same source, pane, cursor and scroll back; the cursor is clamped.
test("S18 a snapshot restores source, pane, cursor and scroll, clamping the cursor to the list", () => {
	const start = init({ account: ACCOUNT });
	const opened = run(start.state, ...keys("down", "enter"));
	const loaded = run(opened.state, {
		type: "loaded",
		id: loadId(opened.effects),
		result: { ok: true, tracks: many(10), hasMore: true },
	});
	const moved = run(loaded.state, ...keys("down", "down", "down", "down", "down", "down")).state;
	assert.equal(moved.rightIndex, 6);
	const snapshot = snapshotOverlay(moved, { left: 1, right: 3 });
	assert.ok(snapshot);

	const again = init({ account: ACCOUNT, snapshot });
	assert.equal(again.state.leftKey, "history");
	assert.deepEqual(again.state.source, { kind: "history" });
	assert.equal(again.state.focus, "right");
	assert.deepEqual(again.scroll, { left: 1, right: 3 });
	assert.deepEqual(again.effects, [{ type: "load", id: loadId(again.effects), request: { kind: "history" } }]);
	const back = run(again.state, {
		type: "loaded",
		id: loadId(again.effects),
		result: { ok: true, tracks: many(10), hasMore: true },
	});
	assert.equal(back.state.rightIndex, 6);
	assert.equal(selectedTrack(back.state), 4, "row 5");

	const shorter = run(again.state, {
		type: "loaded",
		id: loadId(again.effects),
		result: { ok: true, tracks: many(2) },
	});
	assert.equal(shorter.state.rightIndex, 3, "clamped to the last track");
	assert.equal(run(shorter.state, ...keys("down")).state.rightIndex, 3);
});

// S18(1): a search view comes back with its query and results and runs no new search.
test("S18 a search snapshot restores the query and results without searching again", () => {
	const anon = init({ anonymous: true });
	const searched = run(anon.state, ...keys({ text: "nujabes" }, "enter"));
	const results = run(
		searched.state,
		{ type: "loaded", id: loadId(searched.effects), result: { ok: true, tracks: TRACKS } },
		...keys("down", "down"),
	);
	const snapshot = snapshotOverlay(results.state, SCROLL);

	const again = init({ anonymous: true, snapshot });
	assert.deepEqual(again.effects, []);
	assert.equal(again.state.leftKey, "search");
	assert.equal(again.state.focus, "right");
	assert.equal(again.state.query, "nujabes");
	assert.equal(again.state.list.status, "ready");
	assert.deepEqual(again.state.list.tracks, TRACKS);
	assert.equal(selectedTrack(again.state), 1);
	assert.deepEqual(run(again.state, ...keys("enter")).effects, [{ type: "play", tracks: TRACKS, index: 1 }]);
});

// S18(1): Playlists expanded with one of them selected come back expanded on that playlist.
test("S18 a snapshot restores expanded Playlists and the selected playlist", () => {
	const start = init({ account: ACCOUNT });
	const expanded = run(start.state, ...keys("down", "down", "down", "down", "enter"));
	const playlists = [{ id: "PL1", title: "Road trip", count: 2 }];
	const ready = run(expanded.state, {
		type: "playlistsLoaded",
		id: idOf(expanded.effects, "loadPlaylists"),
		result: { ok: true, playlists },
	});
	const picked = run(ready.state, ...keys("down", "enter", "left"));
	const snapshot = snapshotOverlay(picked.state, SCROLL);

	const again = init({ account: ACCOUNT, snapshot });
	assert.equal(again.state.playlistsOpen, true);
	assert.equal(again.state.leftKey, "playlist:PL1");
	assert.equal(again.state.focus, "left");
	assert.deepEqual(again.state.source, { kind: "playlist", id: "PL1", title: "Road trip" });
	const pid = idOf(again.effects, "loadPlaylists");
	assert.deepEqual(again.effects, [
		{ type: "loadPlaylists", id: pid },
		{ type: "load", id: loadId(again.effects), request: { kind: "playlist", id: "PL1" } },
	]);
	const shown = run(again.state, { type: "playlistsLoaded", id: pid, result: { ok: true, playlists } });
	assert.ok(leftRows(shown.state).some((row) => row.type === "source" && row.key === "playlist:PL1"));
	assert.equal(run(shown.state, ...keys("up")).state.leftKey, "playlists");
});

// S18(1): a source that needs an account no longer connected (Disconnect, account change) gives the default open.
test("S18 a snapshot for an account source without that account falls back to the default", () => {
	const start = init({ account: ACCOUNT });
	const history = run(start.state, ...keys("down", "enter"));
	const snapshot = snapshotOverlay(history.state, { left: 0, right: 4 });

	const anon = init({ anonymous: true, snapshot });
	assert.equal(anon.state.leftKey, "search");
	assert.equal(anon.state.source?.kind, "search");
	assert.deepEqual(anon.effects, []);
	assert.deepEqual(anon.scroll, SCROLL);

	const other = init({ account: { browser: "chromium", profile: "Default" }, snapshot });
	assert.equal(other.state.leftKey, "recommended");
	assert.deepEqual(other.effects, [{ type: "load", id: loadId(other.effects), request: { kind: "recommended" } }]);

	const connect = init({ snapshot });
	assert.equal(connect.state.screen, "connect");
	assert.deepEqual(connect.effects, []);
	assert.equal(snapshotOverlay(connect.state, SCROLL), null, "the connect screen leaves nothing to remember");
});

// ---- S19 dependencies gate ----

const BOTH: OverlayInit["deps"] = { mpv: true, ytDlp: "system" };
const GATED: [string, OverlayInit["deps"]][] = [
	["yt-dlp missing", { mpv: true, ytDlp: null }],
	["mpv missing", { mpv: false, ytDlp: "managed" }],
	["both missing", MISSING_BOTH],
];
const READY = { message: "✓ Ready", hint: "", tone: "success" };

/** A snapshot taken on History with an account. */
function historySnapshot() {
	const start = init({ account: ACCOUNT });
	const opened = run(start.state, ...keys("down", "enter"));
	const loaded = run(opened.state, {
		type: "loaded",
		id: loadId(opened.effects),
		result: { ok: true, tracks: many(10) },
	});
	return snapshotOverlay(run(loaded.state, ...keys("down", "down", "down")).state, { left: 1, right: 2 })!;
}

// S19: any missing tool opens Dependencies, whatever the account, the anonymous choice or a remembered place.
test("S19 init with a missing tool opens the dependencies screen with no effects", () => {
	const snapshot = historySnapshot();
	const inits: [string, Partial<OverlayInit>][] = [
		["no account", {}],
		["account", { account: ACCOUNT }],
		["anonymous", { anonymous: true }],
		["account + snapshot", { account: ACCOUNT, snapshot }],
	];
	for (const [label, deps] of GATED) {
		for (const [name, over] of inits) {
			const { state, effects } = init({ ...over, deps, setup: SETUP });
			assert.equal(state.screen, "dependencies", `${label} / ${name}`);
			assert.deepEqual(effects, [], `${label} / ${name}`);
			assert.equal(state.source, null);
			assert.deepEqual(state.account, over.account ?? null, "a saved account stays saved");
		}
	}
	assert.deepEqual(dependencyOptions(init({ deps: MISSING_BOTH }).state), ["install", "mpvHelp", "check"]);
	assert.deepEqual(dependencyOptions(init({ deps: { mpv: true, ytDlp: null } }).state), ["install", "check"]);
	assert.deepEqual(dependencyOptions(init({ deps: { mpv: false, ytDlp: "system" } }).state), ["mpvHelp", "check"]);
});

// S19: with both tools found the screen never appears.
test("S19 init with both tools opens connect or main as before", () => {
	assert.equal(init({ deps: BOTH }).state.screen, "connect");
	const main = init({ account: ACCOUNT, deps: BOTH });
	assert.equal(main.state.screen, "main");
	assert.deepEqual(main.effects, [{ type: "load", id: loadId(main.effects), request: { kind: "recommended" } }]);
	assert.equal(init({ anonymous: true, deps: BOTH }).state.screen, "main");
});

// S19: installing yt-dlp with mpv already there leaves for main (account) with ✓ Ready.
test("S19 after installing yt-dlp, both tools found leaves for main on Recommended with ✓ Ready", () => {
	const started = run(
		init({ account: ACCOUNT, deps: { mpv: true, ytDlp: null }, setup: SETUP }).state,
		...keys("enter", "enter"),
	);
	const installed = run(started.state, {
		type: "installed",
		id: idOf(started.effects, "install"),
		result: { ok: true },
	});
	assert.deepEqual(installed.effects, [{ type: "checkTools" }]);
	assert.equal(installed.state.screen, "dependencies");
	const ready = run(installed.state, { type: "deps", deps: { mpv: true, ytDlp: "managed" } });
	assert.equal(ready.state.screen, "main");
	assert.deepEqual(ready.state.notice, READY);
	assert.equal(ready.state.leftKey, "recommended");
	assert.deepEqual(ready.effects, [{ type: "load", id: loadId(ready.effects), request: { kind: "recommended" } }]);
});

// S19: without an account it leaves for the connect screen with ✓ Ready.
test("S19 after Check again finds mpv, no account leaves for the connect screen with ✓ Ready", () => {
	const checking = run(init({ deps: { mpv: false, ytDlp: "system" }, setup: SETUP }).state, ...keys("down", "enter"));
	assert.deepEqual(checking.effects, [{ type: "checkTools" }]);
	const ready = run(checking.state, { type: "deps", deps: BOTH });
	assert.equal(ready.state.screen, "connect");
	assert.equal(ready.state.connect.phase, "pick");
	assert.deepEqual(ready.state.notice, READY);
	assert.deepEqual(ready.effects, []);

	// From the How to install mpv screen, too.
	const help = run(
		init({ deps: { mpv: false, ytDlp: "system" }, setup: SETUP }).state,
		...keys("enter", "down", "enter"),
	);
	const fromHelp = run(help.state, { type: "deps", deps: BOTH });
	assert.equal(fromHelp.state.dialog, null);
	assert.equal(fromHelp.state.screen, "connect");
	assert.deepEqual(fromHelp.state.notice, READY);
});

// S19/S18: the remembered place is kept while gated and applied once the gate passes.
test("S19 a remembered snapshot is kept while gated and restored after ✓ Ready", () => {
	const snapshot = historySnapshot();
	const gated = init({ account: ACCOUNT, deps: { mpv: false, ytDlp: "system" }, snapshot });
	assert.deepEqual(snapshotOverlay(gated.state, SCROLL), snapshot, "closing on the gate keeps the snapshot");
	const checking = run(gated.state, ...keys("down", "enter"));
	const ready = run(checking.state, { type: "deps", deps: BOTH });
	assert.equal(ready.state.screen, "main");
	assert.equal(ready.state.leftKey, "history");
	assert.equal(ready.state.focus, "right");
	assert.deepEqual(ready.state.notice, READY);
	assert.deepEqual(ready.effects, [
		{ type: "scroll", scroll: { left: 1, right: 2 } },
		{ type: "load", id: loadId(ready.effects), request: { kind: "history" } },
	]);
	const back = run(ready.state, { type: "loaded", id: loadId(ready.effects), result: { ok: true, tracks: many(10) } });
	assert.equal(back.state.rightIndex, 3);
});

// S19: Check again with a tool still missing stays on the screen.
test("S19 Check again with a tool still missing stays on dependencies", () => {
	const checking = gateMissing("down", "down", "enter");
	assert.deepEqual(checking.effects, [{ type: "checkTools" }]);
	const still = run(checking.state, { type: "deps", deps: { mpv: true, ytDlp: null } });
	assert.equal(still.state.screen, "dependencies");
	assert.deepEqual(still.effects, []);
	assert.deepEqual(dependencyOptions(still.state), ["install", "check"]);
	assert.equal(still.state.gate.cursor, 1, "the cursor stays on Check again");
});

// S19: nothing typed on the gate verifies, loads, plays or opens main/connect; esc closes.
test("S19 no key path from the dependencies screen starts a session", () => {
	const all: Key[] = [
		"up",
		"down",
		"enter",
		"esc",
		"tab",
		"left",
		"right",
		"backspace",
		{ text: "a" },
		{ text: " " },
		{ text: "/" },
		{ text: "r" },
	];
	const allowed = new Set(["install", "cancel", "checkTools", "copy", "close"]);
	for (const over of [{}, { account: ACCOUNT }, { anonymous: true }] as Partial<OverlayInit>[]) {
		let frontier = [init({ ...over, deps: MISSING_BOTH, setup: SETUP }).state];
		for (let depth = 0; depth < 4; depth++) {
			const next: OverlayState[] = [];
			for (const state of frontier)
				for (const k of all) {
					const out = reduce(state, { type: "key", key: k });
					for (const e of out.effects) assert.ok(allowed.has(e.type), `${e.type} via ${JSON.stringify(k)}`);
					assert.equal(out.state.screen, "dependencies");
					if (!out.effects.some((e) => e.type === "close")) next.push(out.state);
				}
			frontier = next;
		}
	}
	assert.deepEqual(gateMissing("esc").effects, [{ type: "close" }]);
});

// ---- S21 dwell: the track under the right-pane cursor ----

const dwells = (effects: Effect[]) => effects.filter((e) => e.type === "dwell");

// S21(3): every change of the track under the right-pane cursor emits one dwell effect; null when no track is under it.
test("S21 moving the right-pane cursor emits dwell with the track under it, and null off tracks or panes", () => {
	const { state } = loadedMain();
	const onTrack = run(state, ...keys("down", "down"));
	assert.deepEqual(dwells(onTrack.effects), [{ type: "dwell", track: TRACKS[0] }]);
	const next = run(onTrack.state, ...keys("down"));
	assert.deepEqual(next.effects, [{ type: "dwell", track: TRACKS[1] }]);
	// Staying on the same track (a player update) emits nothing.
	assert.deepEqual(run(next.state, { type: "player", state: playerState({ elapsed: 81 }) }).effects, []);
	assert.deepEqual(run(next.state, ...keys("tab")).effects, [{ type: "dwell", track: null }]);
	assert.deepEqual(run(next.state, ...keys("up", "up")).effects, [
		{ type: "dwell", track: TRACKS[0] },
		{ type: "dwell", track: null },
	]);
	// Closing is the extension's cue to cancel; the cursor itself did not move.
	assert.deepEqual(run(next.state, ...keys("esc")).effects, [{ type: "close" }]);
});

// S21(3): search results and the Queue qualify too.
test("S21 search results and Queue tracks under the cursor emit dwell", () => {
	const anon = init({ anonymous: true, player: playerState() });
	const typed = run(anon.state, ...keys({ text: "n" }, "enter"));
	const results = run(
		typed.state,
		{ type: "loaded", id: loadId(typed.effects), result: { ok: true, tracks: TRACKS } },
		...keys("down"),
	);
	assert.deepEqual(dwells(results.effects), [{ type: "dwell", track: TRACKS[0] }]);

	const { state } = loadedMain();
	const queue = run(state, ...keys("left", "down", "down", "down", "down", "down", "enter", "down", "down", "down"));
	assert.equal(queue.state.source?.kind, "queue");
	assert.deepEqual(dwells(queue.effects).at(-1), { type: "dwell", track: TRACKS[1] });
});

// ---- S23 polish after the full E2E ----

const playingMain = () => run(loadedMain().state, { type: "player", state: playerState() }).state;

// S23(3) regression: Tab in the Account choice used to keep focus on it, so the left pane was unreachable.
test("S23 Tab, left and right leave the Account choice for the left pane and come back; esc still goes back", () => {
	const menu = run(onAccountRow(), ...keys("enter")).state;
	assert.equal(menu.accountMenu, 0);
	assert.equal(menu.focus, "right");
	for (const k of ["tab", "left"] as const) {
		const left = run(menu, ...keys(k));
		assert.equal(left.state.focus, "left", `${k} reaches the left pane`);
		assert.equal(left.state.accountMenu, 0, "the choice stays open on the right");
		const moved = run(left.state, ...keys("up"));
		assert.equal(moved.state.leftKey, "search", "up moves the left cursor");
		const back = run(moved.state, ...keys(k === "tab" ? "tab" : "right"));
		assert.equal(back.state.focus, "right");
		assert.deepEqual(
			run(back.state, ...keys("down", "enter")).effects,
			[{ type: "clearAccount" }],
			"the choice answers again",
		);
	}
	// Another left row opens its source and closes the choice.
	const opened = run(menu, ...keys("tab", "up", "up", "enter"));
	assert.equal(opened.state.accountMenu, null);
	assert.equal(opened.state.source?.kind, "queue");
	// esc in the choice still goes back to the account row.
	const esc = run(menu, ...keys("esc"));
	assert.equal(esc.state.accountMenu, null);
	assert.equal(esc.state.leftKey, "account");
	assert.deepEqual(esc.effects, []);
});

// S23(2): Update yt-dlp leaves the Account menu.
test("S23 the Account choice offers only Use another browser and Disconnect", () => {
	assert.deepEqual(ACCOUNT_CHOICES, ["another", "disconnect"]);
	const menu = run(onAccountRow(), ...keys("enter")).state;
	const last = run(menu, ...keys("down", "down", "down", "enter"));
	assert.deepEqual(last.effects, [{ type: "clearAccount" }]);
});

// S23(4): `.` +5 s and `,` −5 s in every pane, except typed into the search input.
test("S23 . and , seek 5 s in both panes, are typed in the search input, and do nothing with nothing playing", () => {
	const main = playingMain();
	for (const state of [main, run(main, ...keys("tab")).state]) {
		assert.deepEqual(run(state, ...keys({ text: "." })).effects, [{ type: "seek", seconds: 5 }]);
		assert.deepEqual(run(state, ...keys({ text: "," })).effects, [{ type: "seek", seconds: -5 }]);
	}
	const input = run(main, ...keys({ text: "/" }, { text: "a" }, { text: "." }, { text: "," }));
	assert.equal(input.state.query, "a.,");
	assert.deepEqual(
		input.effects.filter((e) => e.type === "seek"),
		[],
	);
	const searched = run(input.state, ...keys("enter"));
	const results = run(
		searched.state,
		{ type: "loaded", id: loadId(searched.effects), result: { ok: true, tracks: TRACKS } },
		...keys("down"),
	);
	assert.deepEqual(
		run(results.state, ...keys({ text: "." })).effects,
		[{ type: "seek", seconds: 5 }],
		"on results they seek",
	);
	assert.equal(run(results.state, ...keys({ text: "." })).state.query, "a.,");
	const idle = run(main, { type: "player", state: playerState({ idle: true }) }).state;
	assert.deepEqual(run(idle, ...keys({ text: "." })).effects, []);
});

// S23(2)/S25: a newer yt-dlp is offered on its own, apart from the transient notices; never on Dependencies.
test("S23 the update offer is kept apart from the notices and is not offered on Dependencies", () => {
	const offer = offered("managed");
	assert.equal(offer.offer, "2026.11.05");
	assert.equal(offer.notice, null);
	const gate = run(init({ deps: { mpv: false, ytDlp: "managed" } }).state, {
		type: "updateAvailable",
		latest: "2026.11.05",
	});
	assert.equal(gate.state.offer, null);
	const busy = run(offer, { type: "playerError", error: { message: "mpv not found", hint: "x" } });
	assert.equal(busy.state.notice?.message, "mpv not found");
	assert.equal(busy.state.offer, "2026.11.05");
});

// S23(1): clicks map to the same actions as the keys, per element type.
test("S23 clicks select and open left rows, select then play tracks, and activate actions", () => {
	const main = loadedMain().state;
	const click = (state: OverlayState, target: Target, ratio?: number) =>
		run(state, { type: "click", target, ...(ratio === undefined ? {} : { ratio }) });

	const history = click(main, { type: "left", key: "history" });
	assert.equal(history.state.focus, "right");
	assert.equal(history.state.leftKey, "history");
	assert.deepEqual(
		history.effects.filter((e) => e.type === "load").map((e) => e.type === "load" && e.request),
		[{ kind: "history" }],
	);
	assert.equal(click(main, { type: "left", key: "playlists" }).effects[0].type, "loadPlaylists");
	assert.equal(click(main, { type: "left", key: "account" }).state.accountMenu, 0);
	assert.deepEqual(click(main, { type: "left", key: "nope" }).effects, []);

	const left = run(main, ...keys("tab")).state;
	const selected = click(left, { type: "right", index: 3 });
	assert.equal(selected.state.focus, "right");
	assert.equal(selected.state.rightIndex, 3);
	assert.deepEqual(selected.effects, [{ type: "dwell", track: TRACKS[1] }], "a first click only selects");
	assert.deepEqual(click(selected.state, { type: "right", index: 3 }).effects, [
		{ type: "play", tracks: TRACKS, index: 1 },
	]);
	assert.deepEqual(click(main, { type: "right", index: 0 }).effects, [{ type: "play", tracks: TRACKS, index: 0 }]);
	assert.deepEqual(click(main, { type: "right", index: 1 }).effects, [
		{ type: "play", tracks: TRACKS, index: 0 },
		{ type: "setShuffle", on: true },
	]);
	assert.deepEqual(click(main, { type: "right", index: 99 }).effects, []);

	const search = run(main, ...keys({ text: "/" }, { text: "x" }, "tab")).state;
	const focused = click(search, { type: "right", index: 0 });
	assert.equal(focused.state.focus, "right");
	assert.deepEqual(focused.effects, [], "clicking the input focuses it without searching");

	const menu = click(main, { type: "left", key: "account" }).state;
	assert.deepEqual(click(menu, { type: "account", index: 1 }).effects, [{ type: "clearAccount" }]);
	assert.deepEqual(click(main, { type: "account", index: 1 }).effects, [], "no choice open: ignored");
});

test("S23 clicks on Load more, connect options, Dependencies rows, dialog buttons and the notice", () => {
	const more = onLoadMore().state;
	const loadMoreClick = run(more, ...keys("up"), { type: "click", target: { type: "right", index: 5 } });
	assert.deepEqual(
		loadMoreClick.effects.filter((e) => e.type === "load").map((e) => e.type === "load" && e.request),
		[{ kind: "recommended", start: 4 }],
	);

	const connect = init().state;
	const verify = run(connect, { type: "click", target: { type: "connect", index: 1 } });
	assert.deepEqual(verify.effects, [
		{ type: "verify", id: idOf(verify.effects, "verify"), account: { browser: "chromium", profile: "Default" } },
	]);
	assert.equal(
		run(connect, { type: "click", target: { type: "connect", index: 2 } }).state.screen,
		"main",
		"Continue without an account",
	);

	const gate = gateMissing();
	assert.equal(
		run(gate.state, { type: "click", target: { type: "dependency", index: 0 } }).state.dialog?.type,
		"confirm",
	);
	assert.equal(run(gate.state, { type: "click", target: { type: "dependency", index: 1 } }).state.dialog?.type, "mpv");
	assert.deepEqual(run(gate.state, { type: "click", target: { type: "dependency", index: 2 } }).effects, [
		{ type: "checkTools" },
	]);
	assert.deepEqual(
		run(gate.state, { type: "click", target: { type: "left", key: "search" } }).effects,
		[],
		"main targets are ignored here",
	);

	const confirm = run(gate.state, ...keys("enter")).state;
	const install = run(confirm, { type: "click", target: { type: "dialog", index: 0 } });
	assert.deepEqual(install.effects, [{ type: "install", id: idOf(install.effects, "install") }]);
	assert.equal(run(confirm, { type: "click", target: { type: "dialog", index: 1 } }).state.dialog, null, "Cancel");
	assert.deepEqual(
		run(confirm, { type: "click", target: { type: "dependency", index: 2 } }).effects,
		[],
		"rows under a dialog are ignored",
	);
	const mpv = run(gate.state, ...keys("down", "enter")).state;
	assert.deepEqual(run(mpv, { type: "click", target: { type: "dialog", index: 0 } }).effects, [
		{ type: "copy", text: "sudo pacman -S mpv" },
	]);

	const start = init({ account: ACCOUNT, deps: { mpv: true, ytDlp: "managed" }, setup: SETUP });
	const failed = run(start.state, { type: "loaded", id: loadId(start.effects), result: { ok: false, error: EXTRACT } });
	const update = run(failed.state, { type: "click", target: { type: "notice", choice: "action" } });
	assert.deepEqual(update.effects, [{ type: "update", id: idOf(update.effects, "update") }]);
	assert.deepEqual(
		run(init({ account: ACCOUNT }).state, { type: "click", target: { type: "notice", choice: "action" } }).effects,
		[],
		"no notice: ignored",
	);
});

// S23(1): the player row's ⏮ ⏸/▶ ⏭ and progress bar.
test("S23 player controls and a progress-bar click seek to that position", () => {
	const main = playingMain();
	const control = (c: "prev" | "toggle" | "next") =>
		run(main, { type: "click", target: { type: "control", control: c } }).effects;
	assert.deepEqual(control("prev"), [{ type: "prev" }]);
	assert.deepEqual(control("toggle"), [{ type: "togglePause" }]);
	assert.deepEqual(control("next"), [{ type: "next" }]);
	assert.deepEqual(run(main, { type: "click", target: { type: "bar" }, ratio: 0.5 }).effects, [
		{ type: "seek", seconds: 126, absolute: true },
	]);
	assert.deepEqual(run(main, { type: "click", target: { type: "bar" }, ratio: 1.4 }).effects, [
		{ type: "seek", seconds: 252, absolute: true },
	]);
	const live = run(main, { type: "player", state: playerState({ duration: null }) }).state;
	assert.deepEqual(
		run(live, { type: "click", target: { type: "bar" }, ratio: 0.5 }).effects,
		[],
		"no duration: no seek",
	);
});

// S23(1): the wheel moves the selection of the pane under the pointer, one step per event.
test("S23 wheel moves the selection in the pane under the pointer and in lists elsewhere", () => {
	const main = loadedMain().state; // focus right, Play all
	const left = run(main, { type: "wheel", pane: "left", delta: 3 });
	assert.equal(left.state.focus, "left");
	assert.equal(left.state.leftKey, "history");
	const right = run(main, { type: "wheel", pane: "right", delta: 3 }, { type: "wheel", pane: "right", delta: 1 });
	assert.equal(right.state.rightIndex, 2);
	assert.equal(run(right.state, { type: "wheel", pane: "right", delta: -2 }).state.rightIndex, 1);
	assert.deepEqual(run(main, { type: "wheel", pane: null, delta: 1 }).state, main, "outside the panes nothing moves");
	const connect = run(init().state, { type: "wheel", pane: null, delta: 1 });
	assert.equal(connect.state.connect.cursor, 1);
});

// ---- S25 sticky update offer ----

const u = { text: "u" };
const l = { text: "l" };
const dismissals = (effects: Effect[]) => effects.filter((e) => e.type === "dismissUpdate");

// S25: moving, panes, search typing, playing, the wheel and clicks elsewhere keep the offer.
test("S25 the update offer stays while moving, switching panes, searching, playing, scrolling and clicking elsewhere", () => {
	const offer = offered("managed");
	const used = run(
		offer,
		...keys("down", "down", "tab", "down", "enter", "left", "right", "up"),
		{ type: "player", state: playerState() },
		{ type: "wheel", pane: "left", delta: 1 },
		{ type: "click", target: { type: "left", key: "history" } },
		{ type: "click", target: { type: "control", control: "toggle" } },
		...keys({ text: "/" }, { text: "n" }, { text: "u" }, "backspace", "enter"),
	);
	assert.equal(used.state.offer, "2026.11.05");
	assert.deepEqual(dismissals(used.effects), []);
	assert.deepEqual(
		used.effects.filter((e) => e.type === "update"),
		[],
	);
});

// S25: `u` runs Update from anywhere outside the search input; the offer goes and is not offered again.
test("S25 u updates yt-dlp and closes the offer for the session", () => {
	const offer = offered("managed");
	for (const state of [offer, run(offer, ...keys("tab")).state]) {
		const out = run(state, ...keys(u));
		const id = idOf(out.effects, "update");
		assert.deepEqual(out.effects, [{ type: "update", id }, { type: "dismissUpdate" }]);
		assert.equal(out.state.offer, null);
		assert.deepEqual(out.state.updating, { id, retry: null });
	}
	const system = run(offered("system"), ...keys(u));
	assert.deepEqual(system.effects, [{ type: "dismissUpdate" }]);
	assert.deepEqual(system.state.notice, {
		message: "yt-dlp comes from your system.",
		hint: "Update yt-dlp with your package manager.",
	});
});

// S25: `l` is Later: the offer goes for the Pi session without updating.
test("S25 l dismisses the offer without updating", () => {
	const out = run(offered("managed"), ...keys(l));
	assert.deepEqual(out.effects, [{ type: "dismissUpdate" }]);
	assert.equal(out.state.offer, null);
	assert.equal(out.state.updating, null);
	assert.deepEqual(run(out.state, ...keys(u)).effects, [], "u does nothing once the offer is gone");
});

// S25: Enter keeps its meaning: on a track it plays it, and the offer stays.
test("S25 Enter on a track plays it while the offer is visible", () => {
	const onTrack = run(offered("managed"), ...keys("tab", "down", "down", "down")).state;
	const out = run(onTrack, ...keys("enter"));
	assert.deepEqual(out.effects, [{ type: "play", tracks: TRACKS, index: 1 }]);
	assert.equal(out.state.offer, "2026.11.05");
});

// S25: in the search input u and l are characters.
test("S25 u and l typed into the search input are characters", () => {
	const input = run(offered("managed"), ...keys({ text: "/" })).state;
	const out = run(input, ...keys(u, l, { text: "x" }));
	assert.equal(out.state.query, "ulx");
	assert.equal(out.state.offer, "2026.11.05");
	assert.deepEqual(
		out.effects.filter((e) => e.type === "update" || e.type === "dismissUpdate"),
		[],
	);
});

// S25: clicks on ▸ Update and Later do what u and l do.
test("S25 clicks on Update and Later update or dismiss the offer", () => {
	const update = run(offered("managed"), { type: "click", target: { type: "notice", choice: "action" } });
	assert.deepEqual(update.effects, [{ type: "update", id: idOf(update.effects, "update") }, { type: "dismissUpdate" }]);
	assert.equal(update.state.offer, null);
	const later = run(offered("managed"), { type: "click", target: { type: "notice", choice: "later" } });
	assert.deepEqual(later.effects, [{ type: "dismissUpdate" }]);
	assert.equal(later.state.offer, null);
});

// ---- Review advisories (S25-S27) ----

// S25: a Load more cut off by the connect screen is asked again when esc goes back to main, never stuck on Loading more….
test("S25 a pending Load more cancelled by the connect screen is asked again on esc back to main", () => {
	const more = run(onLoadMore().state, ...keys("enter"));
	const moreId = loadId(more.effects);
	const connect = run(more.state, ...keys("left", ...Array.from({ length: 7 }, (): Key => "down"), "enter", "enter"));
	assert.equal(connect.state.screen, "connect");
	assert.deepEqual(connect.effects, [{ type: "cancel", id: moreId }]);
	const back = run(connect.state, ...keys("esc"));
	const id = loadId(back.effects);
	assert.notEqual(id, moreId);
	assert.deepEqual(back.effects, [{ type: "load", id, request: { kind: "recommended", start: 4 } }]);
	assert.equal(back.state.screen, "main");
	assert.equal(back.state.list.more, id);
	assert.deepEqual(back.state.list.tracks, TRACKS);
	const landed = run(back.state, { type: "loaded", id, result: { ok: true, tracks: [track(4)], hasMore: false } });
	assert.deepEqual(landed.state.list.tracks, [...TRACKS, track(4)]);
	assert.equal(landed.state.list.more, null);
});

// S25: esc back to main with nothing pending loads nothing.
test("S25 esc back to main with no pending load emits no effect", () => {
	const connect = run(
		onLoadMore().state,
		...keys("left", ...Array.from({ length: 7 }, (): Key => "down"), "enter", "enter"),
	);
	assert.deepEqual(connect.effects, []);
	const back = run(connect.state, ...keys("esc"));
	assert.deepEqual(back.effects, []);
	assert.equal(back.state.list.more, null);
});

// S26: with the tools unknown (the check failed), Update runs and lets the real check answer instead of saying "not found".
test("S26 Update with unknown tools runs the update instead of saying yt-dlp is missing", () => {
	const start = init({ account: ACCOUNT, deps: null, setup: SETUP });
	const loaded = run(start.state, { type: "loaded", id: loadId(start.effects), result: { ok: true, tracks: TRACKS } });
	const offer = run(loaded.state, { type: "updateAvailable", latest: "2026.11.05" }).state;
	const out = run(offer, ...keys(u));
	const id = idOf(out.effects, "update");
	assert.deepEqual(out.effects, [{ type: "update", id }, { type: "dismissUpdate" }]);
	assert.deepEqual(out.state.updating, { id, retry: null });
	assert.equal(out.state.notice, null);
	// A yt-dlp known to be missing still offers Install.
	const missing = run(offered("managed"), { type: "deps", deps: { mpv: true, ytDlp: null } }, ...keys(u));
	assert.deepEqual(missing.effects, [{ type: "dismissUpdate" }]);
	assert.deepEqual(missing.state.notice, { message: "yt-dlp not found", hint: "", action: "install" });
});

// S27: search results are one page; a result that says hasMore never adds a Load more row the cursor cannot reach.
test("S27 search results never offer Load more, even when the result says hasMore", () => {
	const anon = run(init({ anonymous: true }).state, ...keys({ text: "x" }, "enter"));
	const { state } = run(anon.state, {
		type: "loaded",
		id: loadId(anon.effects),
		result: { ok: true, tracks: TRACKS, hasMore: true },
	});
	assert.equal(hasLoadMore(state), false);
	assert.equal(loadMoreIndex(state), -1);
	const last = run(state, ...keys("down", "down", "down", "down", "down"));
	assert.equal(last.state.rightIndex, 3, "the last result is the last row");
	assert.deepEqual(run(last.state, ...keys("enter")).effects, [{ type: "play", tracks: TRACKS, index: 2 }]);
	// Library lists keep Load more.
	assert.equal(hasLoadMore(onLoadMore().state), true);
});
