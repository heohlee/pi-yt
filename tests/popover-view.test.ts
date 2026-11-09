import { test } from "node:test";
import assert from "node:assert/strict";
import { initPopover, reduce, type Action, type Key, type PopoverInit, type PopoverState } from "../lib/popover-model.ts";
import { hitAt, paneAt, renderFrame, renderPopover, type ViewTheme } from "../lib/popover-view.ts";
import { pad, stripAnsi, truncate, visibleWidth, wrap } from "../lib/text.ts";
import type { PlayerState } from "../lib/player.ts";
import type { Track } from "../lib/youtube-source.ts";

const SGR: Record<string, number> = { accent: 36, muted: 37, dim: 90, success: 32, warning: 33, error: 31, text: 39, border: 34 };
const theme: ViewTheme = {
	fg: (role, text) => `\x1b[${SGR[role] ?? 39}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	selected: (text) => `\x1b[48;5;236m${text}\x1b[49m`,
};
const WIDTHS = [60, 80, 100, 140];

const FIREFOX = { id: "firefox" as const, label: "Firefox", profileName: "default-release", profile: "default-release" };
const CHROMIUM = { id: "chromium" as const, label: "Chromium", profileName: "Default", profile: "Default" };
const LONG_NAME = "A very long Chromium profile name for work";
const LONG_PROFILE = { id: "chrome" as const, label: "Chrome", profileName: LONG_NAME.slice(0, 40), profile: "Profile 2" };
const ACCOUNT = { browser: "firefox" as const, profile: "default-release" };
const SETUP = {
	ytDlp: { version: "2026.10.26", size: 41166968, dir: "~/.local/share/pi-yt/bin" },
	mpv: { command: "sudo pacman -S mpv", text: "sudo pacman -S mpv" },
};

const track = (n: number, title = `Song ${n}`): Track => ({
	id: `id${n}`,
	title,
	artist: `Artist ${n}`,
	duration: 252,
	url: `https://www.youtube.com/watch?v=id${n}`,
});
const TRACKS = [track(1, "Aruarian Dance"), track(2, "Time: The Donut of the Heart"), track(3, "South of the River")];

const playing = (over: Partial<PlayerState> = {}): PlayerState => ({
	running: true,
	idle: false,
	paused: false,
	title: "Aruarian Dance",
	artist: "Nujabes",
	elapsed: 80,
	duration: 252,
	volume: 60,
	shuffle: true,
	position: 0,
	queue: TRACKS,
	...over,
});

function apply(state: PopoverState, ...actions: Action[]) {
	for (const action of actions) state = reduce(state, action).state;
	return state;
}
const key = (k: Key): Action => ({ type: "key", key: k });

function connectState(over: Partial<PopoverInit> = {}) {
	return initPopover({ account: null, anonymous: false, browsers: [FIREFOX, CHROMIUM], deps: { mpv: true, ytDlp: "system" }, player: null, ...over }).state;
}
function mainState(over: Partial<PopoverInit> = {}, tracks: Track[] | null = TRACKS) {
	const { state, effects } = initPopover({ account: ACCOUNT, anonymous: false, browsers: [], deps: null, player: null, ...over });
	if (!tracks) return state;
	const load = effects.find((e) => e.type === "load") as { id: number };
	return apply(state, { type: "loaded", id: load.id, result: { ok: true, tracks } });
}
const render = (state: PopoverState, width: number, height = 30) => renderPopover(state, { width, height, theme });
const plain = (state: PopoverState, width: number, height = 30) => render(state, width, height).map(stripAnsi);
const has = (lines: string[], text: string) => lines.some((l) => l.includes(text));

function assertFits(state: PopoverState, label: string) {
	for (const width of WIDTHS) {
		for (const line of render(state, width)) {
			assert.ok(visibleWidth(line) <= width, `${label} @${width}: ${JSON.stringify(stripAnsi(line))} is ${visibleWidth(line)} wide`);
		}
	}
}

test("text helpers measure, truncate, pad and wrap by visible columns", () => {
	assert.equal(visibleWidth("\x1b[36mabc\x1b[39m"), 3);
	assert.equal(visibleWidth("▶ ♪ ⤮ ━ ⏸"), 9);
	assert.equal(visibleWidth("日本"), 4);
	assert.equal(visibleWidth("🎵"), 2);
	assert.equal(truncate("abcdef", 4), "abc…");
	assert.equal(truncate("abc", 4), "abc");
	assert.equal(stripAnsi(truncate("\x1b[31mabcdef\x1b[39m", 3)), "ab…");
	assert.equal(visibleWidth(truncate("日本語", 4)), 3);
	assert.equal(pad("ab", 4), "ab  ");
	assert.equal(pad("abcdef", 4), "abc…");
	assert.deepEqual(wrap("one two three", 7), ["one two", "three"]);
});

// S3
test("connect screen shows the exact copy, browsers, anonymous option, deps and footer", () => {
	const lines = plain(connectState(), 100);
	assert.match(lines.find((l) => l.includes("YouTube"))!, /YouTube\s+not connected/);
	assert.ok(has(lines, "Use the YouTube session already open in your browser."));
	assert.ok(has(lines, "Cookies are read by yt-dlp only, never copied or stored."));
	assert.match(lines.find((l) => l.includes("Firefox"))!, /▸ Firefox\s+default-release/);
	assert.match(lines.find((l) => l.includes("Chromium"))!, /Chromium\s+Default/);
	assert.ok(has(lines, "Continue without an account"));
	assert.ok(!has(lines, "mpv and yt-dlp found"));
	assert.ok(!has(lines, "Install:"));
	assert.ok(has(lines, "enter connect · esc close"));
	assertFits(connectState(), "connect");
});

// S3/S12: browser rows read `<Label>  <profileName>`; a long name truncates with … and keeps checking… visible.
test("connect browser rows truncate long profile names", () => {
	const state = connectState({ browsers: [LONG_PROFILE, FIREFOX] });
	assert.match(plain(state, 140).find((l) => l.includes("Chrome"))!, new RegExp(`▸ Chrome\\s+${LONG_NAME.slice(0, 40)}\\s+│`));
	const row = plain(apply(state, key("enter")), 60).find((l) => l.includes("Chrome"))!;
	assert.match(row, /▸ Chrome\s+A very long.*…\s+checking…\s+│$/);
	assertFits(apply(state, key("enter")), "long profile verifying");
});

/** The body rows between the title rule and the footer rule, trailing spaces and borders removed. */
const bodyRows = (state: PopoverState, width: number) => {
	const lines = plain(state, width).map((l) => l.slice(2, -2).trimEnd());
	return { title: lines[1], body: lines.slice(3, -3), footer: lines.at(-2) };
};

// S19: Dependencies lists one row per tool (a missing one offers its action), Check again, and the footer.
test("S19 the dependencies screen shows the exact title, rows and footer for each combination", () => {
	const YT_MISSING = "✗ yt-dlp   reads YouTube";
	const MPV_MISSING = "✗ mpv      plays the audio";
	const cases: [PopoverInit["deps"], [string, string][]][] = [
		[{ mpv: false, ytDlp: null }, [[`▸ ${YT_MISSING}`, "Install yt-dlp"], [`  ${MPV_MISSING}`, "How to install mpv"]]],
		[{ mpv: true, ytDlp: null }, [[`▸ ${YT_MISSING}`, "Install yt-dlp"], ["  ✓ mpv      plays the audio", ""]]],
		[{ mpv: false, ytDlp: "system" }, [["  ✓ yt-dlp   reads YouTube", "(system)"], [`▸ ${MPV_MISSING}`, "How to install mpv"]]],
		[{ mpv: false, ytDlp: "managed" }, [["  ✓ yt-dlp   reads YouTube", "(managed)"], [`▸ ${MPV_MISSING}`, "How to install mpv"]]],
	];
	for (const [deps, tools] of cases) {
		const state = connectState({ deps, setup: SETUP });
		for (const width of WIDTHS) {
			const inner = width - 4;
			const { title, body, footer } = bodyRows(state, width);
			assert.equal(title, `YouTube${" ".repeat(inner - 7 - 12)}Dependencies`);
			const rows = tools.map(([left, right]) => (right ? `${left}${" ".repeat(inner - left.length - right.length)}${right}` : left));
			assert.deepEqual(body, ["", ...rows, "", "  Check again"], `${JSON.stringify(deps)} @${width}`);
			assert.equal(footer, "enter choose · esc close");
		}
		assertFits(state, `deps ${JSON.stringify(deps)}`);
	}
	const raw = render(connectState({ deps: { mpv: false, ytDlp: "managed" }, setup: SETUP }), 100);
	assert.ok(raw.some((l) => l.includes(`\x1b[${SGR.dim}m(managed)`)), "(managed) is dim");
	assert.ok(raw.some((l) => l.includes(`\x1b[${SGR.error}m✗`)), "✗ in error");
	assert.ok(raw.some((l) => l.includes(`\x1b[${SGR.dim}mDependencies`)));
});

// S19: the cursor moves only over missing tools and Check again; no browser or anonymous row appears.
test("S19 the dependencies cursor reaches only actionable rows", () => {
	const gate = connectState({ deps: { mpv: false, ytDlp: "system" }, setup: SETUP });
	const onCheck = apply(gate, key("down"));
	assert.equal(bodyRows(onCheck, 100).body.at(-1), "▸ Check again");
	assert.ok(!bodyRows(onCheck, 100).body.some((l) => l.startsWith("▸ ✓") || l.startsWith("▸ ✗")));
	assert.equal(bodyRows(apply(onCheck, key("down")), 100).body.at(-1), "▸ Check again", "Check again is the last stop");
	assert.ok(bodyRows(apply(onCheck, key("up"), key("up")), 100).body[2].startsWith("▸ ✗ mpv"));
	const lines = plain(gate, 100);
	for (const text of ["Firefox", "Chromium", "Continue without an account", "Use the YouTube session", "found"]) assert.ok(!has(lines, text), text);
	assertFits(onCheck, "check again");
});

// S3/S19: the connect screen keeps its found line and has no tool rows.
test("S19 the connect screen has no tool rows", () => {
	const lines = plain(connectState(), 100);
	assert.ok(!has(lines, "mpv and yt-dlp found"));
	for (const text of ["✗", "Install yt-dlp", "How to install mpv", "reads YouTube"]) assert.ok(!has(lines, text), text);
});

// S19: ✓ Ready shows as the success notice on the screen the gate leaves for.
test("S19 ✓ Ready shows on the connect screen after the gate passes", () => {
	const gate = apply(connectState({ deps: { mpv: false, ytDlp: "system" }, setup: SETUP }), key("down"), key("enter"));
	const ready = apply(gate, { type: "deps", deps: { mpv: true, ytDlp: "system" } });
	const raw = render(ready, 100);
	assert.ok(raw.some((l) => l.includes(`\x1b[${SGR.success}m✓ Ready`)), raw.map(stripAnsi).join("\n"));
	assert.ok(has(plain(ready, 100), "not connected"));
	assertFits(ready, "ready");
});

// S3
test("connect without browsers offers only anonymous with the explanation", () => {
	const state = connectState({ browsers: [] });
	const lines = plain(state, 100);
	assert.ok(has(lines, "No supported browser found (Firefox, Zen, Chromium, Chrome, Brave, Helium)."));
	assert.ok(has(lines, "▸ Continue without an account"));
	assert.ok(!has(lines, "Firefox  "));
	assertFits(state, "no browsers");
});

// S8: signin error lines and recovery options; detail never shown.
test("connect signin error shows message, hint and the three options, never detail", () => {
	let state = apply(connectState(), key("enter"));
	assert.ok(has(plain(state, 100), "checking…"));
	state = apply(state, {
		type: "verified",
		id: state.connect.verifyId,
		result: {
			ok: false,
			error: {
				kind: "signin",
				message: "YouTube session not found in Firefox.",
				hint: "Sign in at youtube.com in Firefox, then retry.",
				detail: "ERROR: SECRET-STDERR",
			},
		},
	});
	const lines = plain(state, 100);
	assert.ok(has(lines, "YouTube session not found in Firefox."));
	assert.ok(has(lines, "Sign in at youtube.com in Firefox, then retry."));
	assert.ok(has(lines, "▸ Retry"));
	assert.ok(has(lines, "Use another browser"));
	assert.ok(has(lines, "Continue without an account"));
	assert.ok(!has(lines, "SECRET-STDERR"));
	assertFits(state, "connect error");
});

// S2
test("main title row shows the connected browser, or no account", () => {
	assert.match(plain(mainState(), 120).find((l) => l.includes("YouTube"))!, /YouTube\s+Firefox ✓/);
	const anon = initPopover({ account: null, anonymous: true, browsers: [], deps: null, player: null }).state;
	const lines = plain(apply(anon, key("left")), 120);
	assert.match(lines.find((l) => l.includes("YouTube"))!, /YouTube\s+no account/);
	// The Connect an account row replaces the old dim note: it appears once.
	assert.equal(lines.filter((l) => /connect an account/i.test(l)).length, 1);
});

// S2
// S2/S10/S11
test("left pane lists the sources in order with counts, ending with the account row", () => {
	const lines = plain(mainState(), 120);
	const order = ["Recommended", "History", "Watch later", "Liked videos", "▸ Playlists", "  Queue ", "› Search…"];
	const rows = order.map((label) => lines.findIndex((l) => l.includes(label)));
	assert.ok(rows.every((r, i) => r >= 0 && (i === 0 || r > rows[i - 1])), JSON.stringify(rows));
	assert.ok(lines[rows[6] + 1].includes("─────"), "rule right below Search…");
	assert.match(lines[rows[6] + 2], /│ {3}Account · Firefox\s+│/);
	assert.match(lines[rows[0]], /▸ Recommended\s+3 │/);

	const anon = plain(apply(initPopover({ account: null, anonymous: true, browsers: [], deps: null, player: null }).state, key("left")), 120);
	const search = anon.findIndex((l) => l.includes("› Search…"));
	assert.ok(anon[search + 1].includes("─────"));
	assert.match(anon[search + 2], /│ {3}Connect an account\s+│/);
});

/** The left pane rows at 120 columns, spaces collapsed, blank rows dropped. */
const leftColumn = (state: PopoverState) =>
	plain(state, 120)
		.slice(3, -3)
		.map((l) => l.slice(2, 2 + 24).replace(/\s+/g, " ").trim())
		.filter(Boolean);

// S18(2): YouTube's order on top, then Playlists, Queue, Search and the account row.
test("S18 left pane order is exact with an account and without one", () => {
	const rule = "─".repeat(24);
	assert.deepEqual(leftColumn(mainState()), [
		"▸ Recommended 3",
		"History",
		"Watch later",
		"Liked videos",
		rule,
		"▸ Playlists",
		rule,
		"Queue",
		"› Search…",
		rule,
		"Account · Firefox",
	]);
	const anon = apply(initPopover({ account: null, anonymous: true, browsers: [], deps: null, player: null }).state, key("left"));
	assert.deepEqual(leftColumn(anon), [
		"Recommended",
		"History",
		"Watch later",
		"Liked videos",
		rule,
		"▸ Playlists",
		rule,
		"Queue",
		"▸ › Search…",
		rule,
		"Connect an account",
	]);
});

// S11
test("no line uses the old ⌕ or ≡ icons", () => {
	const states = [
		mainState({ player: playing() }),
		apply(mainState(), key({ text: "/" }), key({ text: "x" })),
		initPopover({ account: null, anonymous: true, browsers: [], deps: null, player: null }).state,
	];
	for (const state of states)
		for (const width of WIDTHS) assert.ok(!plain(state, width).some((l) => l.includes("⌕") || l.includes("≡")));
});

// S10
test("account choice shows the title, both options and its hint, and fits", () => {
	const onRow = apply(mainState(), ...Array.from({ length: 7 }, () => key("down")));
	const state = apply(onRow, key("enter"));
	const lines = plain(state, 120);
	assert.ok(lines.some((l) => /│ Account · Firefox\s+│$/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /│ ▸ Use another browser\s+│$/.test(l)));
	assert.ok(lines.some((l) => /│ {3}Disconnect\s+│$/.test(l)));
	assert.ok(has(lines, "enter choose · esc back"));
	const narrow = plain(state, 80);
	assert.ok(has(narrow, "Use another browser") && has(narrow, "enter choose · esc back"));
	assertFits(state, "account choice");
});

// S2
test("right pane header, actions and track rows; the playing track is marked ♪ in accent", () => {
	const state = apply(mainState({ player: playing() }), { type: "player", state: playing() }, key("tab"));
	const raw = render(state, 120);
	const lines = raw.map(stripAnsi);
	assert.match(lines.find((l) => l.includes("Recommended · 3"))!, /Recommended · 3\s+▸ ▶ Play all\s+⤮ Shuffle/);
	const first = lines.find((l) => l.includes("Aruarian Dance") && l.includes("Artist 1"))!;
	assert.match(first, /♪\s+Aruarian Dance\s+Artist 1\s+4:12/);
	assert.match(lines.find((l) => l.includes("Time: The Donut"))!, / 2\s+Time: The Donut of the Heart\s+Artist 2\s+4:12/);
	assert.ok(raw.some((l) => l.includes(`\x1b[${SGR.accent}m♪`)));
	assertFits(state, "main");
});

// S2/S8
test("right pane shows Loading…, Nothing here. and errors as message + hint without detail", () => {
	assert.ok(has(plain(mainState({}, null), 120), "Loading…"));
	assert.ok(has(plain(mainState({}, []), 120), "Nothing here."));

	const start = initPopover({ account: ACCOUNT, anonymous: false, browsers: [], deps: null, player: null });
	const id = (start.effects[0] as { id: number }).id;
	const failed = apply(start.state, {
		type: "loaded",
		id,
		result: {
			ok: false,
			error: { kind: "extract", message: "yt-dlp could not read YouTube.", hint: "Update yt-dlp and retry.", detail: "SECRET-DETAIL" },
		},
	});
	const lines = plain(failed, 120);
	assert.ok(has(lines, "yt-dlp could not read YouTube."));
	assert.ok(has(lines, "Update yt-dlp and retry."));
	assert.ok(!has(lines, "SECRET-DETAIL"));
	assertFits(failed, "error");
});

// S2/S8: one notice line for player errors.
test("player errors render as one notice line", () => {
	const state = apply(mainState(), { type: "playerError", error: { message: "mpv not found", hint: "Install it: sudo pacman -S mpv" } });
	assert.ok(plain(state, 120).some((l) => /mpv not found\s+Install it: sudo pacman -S mpv/.test(l)));
	assertFits(state, "notice");
});

// S2/S5
test("player row: playing, paused and nothing playing", () => {
	const row = (ps: PlayerState | null, width = 120) => {
		const state = ps ? apply(mainState(), { type: "player", state: ps }) : mainState();
		const lines = plain(state, width);
		return lines[lines.length - 2];
	};
	assert.match(row(playing()), /│ ⏮ ▶ ⏭ Aruarian Dance\s+Nujabes\s+━+\s+1:20\/4:12\s+⤮ on\s+vol 60%\s+tab pane · space ⏯ · n p track · , \. ±5s · esc/);
	assert.match(row(playing({ paused: true, shuffle: false })), /│ ⏮ ⏸ ⏭ Aruarian Dance\s+Nujabes.*1:20\/4:12\s+⤮ off\s+vol 60%/);
	assert.match(row(null), /■ Nothing playing\s+tab pane · space ⏯ · n p track · , \. ±5s · esc/);
	assert.match(row(playing({ idle: true })), /■ Nothing playing/);
	for (const width of WIDTHS) assert.ok(visibleWidth(row(playing(), width)) <= width);
	assert.match(row(playing(), 60), /1:20\/4:12/);
});

// S6
test("search pane shows the query input with a cursor and enter search", () => {
	let state = apply(mainState(), key({ text: "/" }), key({ text: "nujabes live" }));
	let lines = plain(state, 120);
	assert.ok(lines.some((l) => /› nujabes live█\s+enter search/.test(l)));
	assert.ok(has(lines, "enter search · esc"));
	const load = reduce(state, key("enter"));
	state = apply(load.state, {
		type: "loaded",
		id: (load.effects.find((e) => e.type === "load") as { id: number }).id,
		result: { ok: true, tracks: TRACKS },
	}, key("down"));
	lines = plain(state, 120);
	assert.ok(has(lines, "Aruarian Dance"));
	assert.ok(has(lines, "enter play · a queue · n p track · , . ±5s · esc"));
	assertFits(state, "search");
});

// S7
test("narrow terminals show one pane at a time; tab switches", () => {
	const left = mainState();
	let lines = plain(left, 80);
	assert.ok(has(lines, "Watch later"));
	assert.ok(!has(lines, "Aruarian Dance"));
	assert.ok(!lines.some((l) => l.slice(2, -2).includes("│")), "no pane rule");

	lines = plain(apply(left, key("tab")), 80);
	assert.ok(has(lines, "Aruarian Dance"));
	assert.ok(!has(lines, "Watch later"));

	lines = plain(left, 100);
	assert.ok(has(lines, "Watch later") && has(lines, "Aruarian Dance"), "100 columns shows both panes");
});

// S2: the list scrolls to keep the selection visible.
test("long lists scroll to keep the selection visible", () => {
	const many = Array.from({ length: 60 }, (_, i) => track(i + 1));
	let state = apply(mainState({}, many), key("tab"));
	for (let i = 0; i < 50; i++) state = apply(state, key("down"));
	const lines = plain(state, 120, 20);
	assert.equal(lines.length <= 20, true);
	assert.ok(lines.some((l) => /▸\s+49\s+Song 49/.test(l)), lines.join("\n"));
	assert.ok(!has(lines, "Song 1 "));
});

test("every line fits at 60, 80, 100 and 140 columns across states", () => {
	const long = [track(1, "A very long title ".repeat(10)), ...TRACKS];
	const states: [string, PopoverState][] = [
		["connect", connectState()],
		["long profile", connectState({ browsers: [LONG_PROFILE, { ...FIREFOX, profileName: "p".repeat(200) }] })],
		["loading", mainState({}, null)],
		["long", apply(mainState({ player: playing({ title: "x".repeat(300), artist: "y".repeat(80) }) }, long), key("tab"))],
		["anon", initPopover({ account: null, anonymous: true, browsers: [], deps: null, player: null }).state],
		["anon left", apply(initPopover({ account: null, anonymous: true, browsers: [], deps: null, player: null }).state, key("left"))],
	];
	for (const [label, state] of states) assertFits(state, label);
});

/** Recommended with a full first page, focus right, cursor on Load more. */
function pagedState() {
	const { state, effects } = initPopover({ account: ACCOUNT, anonymous: false, browsers: [], deps: null, player: null });
	const load = effects.find((e) => e.type === "load") as { id: number };
	const loaded = apply(state, { type: "loaded", id: load.id, result: { ok: true, tracks: TRACKS, hasMore: true } }, key("tab"));
	return apply(loaded, ...Array.from({ length: 5 }, () => key("down")));
}

// S14: a full page ends with Load more (dim); while the page loads it reads Loading more….
test("S14 Load more and Loading more… rows follow the tracks and fit", () => {
	const idle = apply(pagedState(), key("up"));
	let raw = render(idle, 120);
	assert.ok(raw.some((l) => l.includes(`\x1b[${SGR.dim}m  Load more\x1b[39m`)), raw.map(stripAnsi).join("\n"));
	const at = raw.map(stripAnsi).findIndex((l) => l.includes("Load more"));
	assert.ok(stripAnsi(raw[at - 1]).includes("South of the River"), "Load more is right after the last track");
	assertFits(idle, "load more");

	const selected = pagedState();
	assert.ok(plain(selected, 120).some((l) => /▸ Load more/.test(l)));
	assertFits(selected, "load more selected");

	const loading = apply(selected, key("enter"));
	const lines = plain(loading, 120);
	assert.ok(has(lines, "Loading more…"), lines.join("\n"));
	assert.ok(!has(lines, "Load more "));
	assert.ok(has(lines, "Aruarian Dance"), "loaded tracks stay visible");
	assertFits(loading, "loading more");

	assert.ok(!has(plain(mainState(), 120), "Load more"), "no row without hasMore");
});

// S14: appended tracks continue the numbering.
test("S14 appended tracks continue the numbering", () => {
	const loading = reduce(pagedState(), key("enter"));
	const more = (loading.effects.find((e) => e.type === "load") as { id: number }).id;
	const state = apply(loading.state, { type: "loaded", id: more, result: { ok: true, tracks: [track(4, "Feather")], hasMore: false } });
	const lines = plain(state, 120);
	assert.ok(lines.some((l) => / 4\s+Feather\s+Artist 4/.test(l)), lines.join("\n"));
	assert.ok(has(lines, "Recommended · 4"));
	assert.ok(!has(lines, "Load more"));
});

// S14: the right pane hints mention r reload where it fits.
test("S14 right pane hints include r reload and every line fits", () => {
	const right = apply(mainState(), key("tab"));
	assert.ok(has(plain(right, 120), "tab pane · space ⏯ · n p track · , . ±5s · r reload · esc"));
	const withPlayer = apply(mainState({ player: playing() }), { type: "player", state: playing() }, key("tab"));
	assert.ok(has(plain(withPlayer, 140), "r reload"));
	assertFits(right, "reload hint");
	assertFits(withPlayer, "reload hint playing");
	assert.ok(!has(plain(mainState(), 120), "r reload"), "left pane keeps the player hints");
});

// ---- S17 easy dependency install ----

const MISSING = { mpv: false, ytDlp: null };
/** Dependencies with both tools missing, on the Install yt-dlp confirmation. */
const confirmState = () => apply(connectState({ deps: MISSING, setup: SETUP }), key("enter"));
const lineMatching = (lines: string[], re: RegExp) => lines.find((l) => re.test(l));

// S17: the confirmation names version, source, size, folder and license, and asks first.
test("S17 the Install yt-dlp confirmation shows the exact rows and options", () => {
	const lines = plain(confirmState(), 100);
	for (const row of [
		"Version   2026.10.26 (official release)",
		"From      github.com/yt-dlp/yt-dlp",
		"Size      ~41 MB",
		"Into      ~/.local/share/pi-yt/bin",
		"License   Unlicense",
		"Nothing is installed system-wide and no sudo is needed.",
	])
		assert.ok(lines.some((l) => new RegExp(`│ ${row.replace(/[()~.]/g, "\\$&")}\\s+│$`).test(l)), `${row}\n${lines.join("\n")}`);
	assert.ok(lineMatching(lines, /│ ▸ Install\s+│$/));
	assert.ok(lineMatching(lines, /│ {3}Cancel\s+│$/));
	assert.ok(has(lines, "enter choose · esc cancel"));
	assertFits(confirmState(), "confirm");
	const unknownSize = apply(connectState({ deps: MISSING, setup: { ...SETUP, ytDlp: { ...SETUP.ytDlp, size: null } } }), key("enter"));
	assert.ok(!has(plain(unknownSize, 100), "Size"));
});

// S17: download progress with a bar and MB counts, esc cancel, then Verifying….
test("S17 the download shows progress in MB with esc cancel, then Verifying…", () => {
	const { state, effects } = reduce(confirmState(), key("enter"));
	const id = (effects[0] as { id: number }).id;
	const half = apply(state, { type: "installProgress", id, progress: { phase: "download", received: 20_583_484, total: 41_166_968 } });
	const lines = plain(half, 100);
	assert.ok(lineMatching(lines, /│ Downloading yt-dlp  ━+  20\.6\/41\.2 MB\s+│$/), lines.join("\n"));
	assert.ok(has(lines, "esc cancel"));
	const raw = render(half, 100).join("\n");
	assert.ok(raw.includes(`\x1b[${SGR.accent}m━`) && raw.includes(`\x1b[${SGR.dim}m━`), "bar shows filled and empty parts");
	assertFits(half, "download");
	const unknown = apply(state, { type: "installProgress", id, progress: { phase: "download", received: 3_000_000, total: null } });
	const sized = apply(connectState({ deps: MISSING, setup: { ...SETUP, ytDlp: { ...SETUP.ytDlp, size: null } } }), key("enter"));
	const unknownTotal = apply(reduce(sized, key("enter")).state, { type: "installProgress", id: id, progress: { phase: "download", received: 3_000_000, total: null } });
	assert.ok(has(plain(unknownTotal, 100), "Downloading yt-dlp  3.0 MB"), plain(unknownTotal, 100).join("\n"));
	assert.ok(has(plain(unknown, 100), "/41.2 MB"));
	const verifying = apply(half, { type: "installProgress", id, progress: { phase: "verify" } });
	assert.ok(lineMatching(plain(verifying, 100), /│ Verifying…\s+│$/));
	assertFits(verifying, "verifying");
});

// S17: success returns to the refreshed rows with ✓ yt-dlp installed; failure shows Retry / Back.
test("S17 install success and failure screens", () => {
	const { state, effects } = reduce(confirmState(), key("enter"));
	const id = (effects[0] as { id: number }).id;
	const done = apply(state, { type: "installed", id, result: { ok: true } }, { type: "deps", deps: { mpv: false, ytDlp: "managed" } });
	const lines = plain(done, 100);
	assert.ok(has(lines, "✓ yt-dlp installed"));
	assert.ok(lines.some((l) => /✓ yt-dlp   reads YouTube\s+\(managed\)/.test(l)), lines.join("\n"));
	assert.ok(!has(lines, "✗ yt-dlp"));
	assert.ok(render(done, 100).some((l) => l.includes(`\x1b[${SGR.success}m✓ yt-dlp installed`)));

	const failed = apply(state, {
		type: "installed",
		id,
		result: { ok: false, error: { kind: "network", message: "Could not download yt-dlp.", hint: "Check your connection and retry." } },
	});
	const fl = plain(failed, 100);
	assert.ok(has(fl, "Could not download yt-dlp.") && has(fl, "Check your connection and retry."));
	assert.ok(lineMatching(fl, /│ ▸ Retry\s+│$/) && lineMatching(fl, /│ {3}Back\s+│$/));
	assert.ok(has(fl, "enter choose · esc back"));
	assertFits(done, "installed");
	assertFits(failed, "install failed");
});

// S17: How to install mpv shows the command, Copy command and Check again, and the copy notices.
test("S17 How to install mpv screen, with the copy notices", () => {
	const help = apply(connectState({ deps: MISSING, setup: SETUP }), key("down"), key("enter"));
	const lines = plain(help, 100);
	assert.ok(lineMatching(lines, /│ mpv plays the audio\. Install it with your package manager:\s+│$/), lines.join("\n"));
	assert.ok(lineMatching(lines, /│ {3}sudo pacman -S mpv\s+│$/));
	assert.ok(lineMatching(lines, /│ ▸ Copy command\s+│$/) && lineMatching(lines, /│ {3}Check again\s+│$/));
	assert.ok(has(plain(apply(help, { type: "copied", ok: true }), 100), "Copied."));
	assert.ok(has(plain(apply(help, { type: "copied", ok: false }), 100), "No clipboard tool found; copy it by hand."));
	assertFits(help, "mpv help");

	const fallback = apply(
		connectState({ deps: MISSING, setup: { ...SETUP, mpv: { command: null, text: "Install mpv with your package manager: https://mpv.io/installation/" } } }),
		key("down"),
		key("enter"),
	);
	const fb = plain(fallback, 140);
	assert.ok(has(fb, "Install mpv with your package manager: https://mpv.io/installation/"));
	assert.ok(!has(fb, "Copy command") && has(fb, "Check again"));
	assertFits(fallback, "mpv fallback");
});

/** Main with an account and the account choice open. */
function accountChoice(ytDlp: "managed" | "system" | null) {
	const onRow = apply(mainState({ deps: { mpv: true, ytDlp }, setup: SETUP }), ...Array.from({ length: 7 }, () => key("down")));
	return apply(onRow, key("enter"));
}

// S23: Update yt-dlp left the Account menu; the update offer runs it, with Updating yt-dlp… while it runs.
test("S23 Account has no Update yt-dlp; the offer reads `yt-dlp <new> available  ▸ Update (u) · Later (l)` and updates", () => {
	const menu = accountChoice("managed");
	assert.ok(!has(plain(menu, 120), "Update yt-dlp"), plain(menu, 120).join("\n"));
	const offer = apply(mainState({ deps: { mpv: true, ytDlp: "managed" }, setup: SETUP }), { type: "updateAvailable", latest: "2026.11.05" });
	assert.ok(lineMatching(plain(offer, 120), /│ yt-dlp 2026\.11\.05 available  ▸ Update \(u\) · Later \(l\)\s+│$/), plain(offer, 120).join("\n"));
	assertFits(offer, "update offer");
	const updating = apply(offer, key({ text: "u" }));
	assert.ok(has(plain(updating, 120), "Updating yt-dlp…"));
	assertFits(updating, "updating");
});

// S17/S8: action notices read `<message>  ▸ <action>`.
test("S17 extract and mpv-missing notices offer their action", () => {
	const start = initPopover({ account: ACCOUNT, anonymous: false, browsers: [], deps: { mpv: true, ytDlp: "managed" }, player: null });
	const id = (start.effects[0] as { id: number }).id;
	const failed = apply(start.state, {
		type: "loaded",
		id,
		result: { ok: false, error: { kind: "extract", message: "yt-dlp could not read YouTube.", hint: "Update yt-dlp and retry." } },
	});
	assert.ok(plain(failed, 120).some((l) => /│ yt-dlp could not read YouTube\.\s+▸ Update yt-dlp\s+│$/.test(l)), plain(failed, 120).join("\n"));
	assertFits(failed, "extract notice");

	const mpv = apply(mainState(), { type: "playerError", error: { kind: "missing", message: "mpv not found", hint: "Install it." } });
	assert.ok(plain(mpv, 120).some((l) => /│ mpv not found\s+▸ How to install mpv\s+│$/.test(l)));
	assertFits(mpv, "mpv notice");
	const help = apply(mpv, key("enter"));
	assert.ok(has(plain(help, 120), "mpv plays the audio. Install it with your package manager:"));
	assertFits(help, "mpv help from main");
});

// S20: while a picked track resolves, the player row shows it with Loading… instead of Nothing playing.
test("S20 player row shows the picked track with Loading… while it resolves", () => {
	const row = (ps: PlayerState, width = 120) => {
		const lines = plain(apply(mainState(), { type: "player", state: ps }), width);
		return lines[lines.length - 2];
	};
	const loading = playing({ idle: true, resolving: true, elapsed: 0 });
	assert.match(row(loading), /◌ Aruarian Dance\s+Nujabes\s+Loading…\s+tab pane · space ⏯ · n p track · , \. ±5s · esc/);
	assert.doesNotMatch(row(loading), /Nothing playing/);
	for (const width of WIDTHS) assert.ok(visibleWidth(row(loading, width)) <= width);
	assert.match(row(loading, 60), /Loading…/);
});

// ---- S23 mouse, seek hints ----

/** Plain text of `line` between columns x (inclusive) and end (exclusive); fixtures use one-column glyphs. */
const cols = (line: string, x: number, end: number) => Array.from(stripAnsi(line)).slice(x, end).join("");
const frame = (state: PopoverState, width: number, height = 30, hover?: string) => renderFrame(state, { width, height, theme, hover });

/** Every expected hit exists, sits on its own text, and every hit stays inside the card. */
function assertHits(state: PopoverState, width: number, expected: Record<string, string>, height = 30) {
	const f = frame(state, width, height);
	for (const hit of f.hits) {
		assert.ok(hit.y > 0 && hit.y < f.lines.length - 1, `${hit.id} y ${hit.y}`);
		assert.ok(hit.x >= 2 && hit.end <= width - 2 && hit.end > hit.x, `${hit.id} x ${hit.x}-${hit.end} @${width}`);
	}
	for (const [id, text] of Object.entries(expected)) {
		const hit = f.hits.find((h) => h.id === id);
		assert.ok(hit, `${id} @${width}: ${f.hits.map((h) => h.id).join(", ")}`);
		assert.ok(cols(f.lines[hit.y], hit.x, hit.end).includes(text), `${id} @${width}: ${JSON.stringify(cols(f.lines[hit.y], hit.x, hit.end))}`);
	}
	return f;
}

test("S23 left and right rows, actions and player controls get hit regions over their text at every width", () => {
	const state = apply(mainState({ player: playing() }), { type: "player", state: playing() });
	for (const width of [100, 140]) {
		const f = assertHits(state, width, {
			"left:recommended": "Recommended",
			"left:playlists": "Playlists",
			"left:queue": "Queue",
			"left:search": "› Search…",
			"left:account": "Account · Firefox",
			"right:0": "▶ Play all",
			"right:1": "⤮ Shuffle",
			"right:2": "Aruarian Dance",
			"right:4": "South of the River",
			"control:prev": "⏮",
			"control:toggle": "▶",
			"control:next": "⏭",
			bar: "━",
		});
		const bar = f.hits.find((h) => h.id === "bar")!;
		assert.match(cols(f.lines[bar.y], bar.x, bar.end), /^━+$/);
		assert.equal(cols(f.lines[f.hits.find((h) => h.id === "control:prev")!.y], 2, 7), "⏮ ▶ ⏭");
		assert.deepEqual(
			f.panes.map((p) => p.pane),
			["left", "right"],
		);
	}
	// Narrow: only the focused pane, starting at the border padding.
	const narrow = assertHits(state, 80, { "left:history": "History" });
	assert.ok(!narrow.hits.some((h) => h.id.startsWith("right:")));
	assert.equal(narrow.hits.find((h) => h.id === "left:history")!.x, 2);
	const narrowRight = assertHits(apply(state, key("tab")), 60, { "right:2": "Aruarian Dance" });
	assert.equal(narrowRight.hits.find((h) => h.id === "right:2")!.x, 2);
	assert.deepEqual(narrowRight.panes.map((p) => p.pane), ["right"]);
});

test("S23 search input, Load more, scrolled rows, account choices and the playlists rows get hits", () => {
	const search = apply(mainState(), key({ text: "/" }), key({ text: "nujabes" }));
	for (const width of WIDTHS) if (width >= 100) assertHits(search, width, { "right:0": "› nujabes" });
	assertHits(apply(pagedState(), key("up")), 120, { "right:5": "Load more" });
	const many = Array.from({ length: 60 }, (_, i) => track(i + 1));
	let scrolled = apply(mainState({}, many), key("tab"));
	for (let i = 0; i < 50; i++) scrolled = apply(scrolled, key("down"));
	assertHits(scrolled, 120, { "right:49": "Song 48", "right:50": "Song 49" }, 20);
	const menu = accountChoice("managed");
	for (const width of WIDTHS) assertHits(menu, width, { "account:0": "Use another browser", "account:1": "Disconnect" });
});

test("S23 connect options, Dependencies rows, dialog buttons and notice actions get hits", () => {
	for (const width of WIDTHS) {
		assertHits(connectState(), width, { "connect:0": "Firefox", "connect:1": "Chromium", "connect:2": "Continue without an account" });
		assertHits(connectState({ deps: MISSING, setup: SETUP }), width, {
			"dependency:0": "Install yt-dlp",
			"dependency:1": "How to install mpv",
			"dependency:2": "Check again",
		});
		assertHits(confirmState(), width, { "dialog:0": "Install", "dialog:1": "Cancel" });
		const offer = apply(mainState({ deps: { mpv: true, ytDlp: "managed" } }), { type: "updateAvailable", latest: "2026.11.05" });
		const f = assertHits(offer, width, { "notice:action": "▸ Update (u)", "notice:later": "Later (l)" });
		const text = (id: string) => {
			const hit = f.hits.find((h) => h.id === id)!;
			return cols(f.lines[hit.y], hit.x, hit.end);
		};
		assert.equal(text("notice:action"), "▸ Update (u)");
		assert.equal(text("notice:later"), "Later (l)");
		const mpv = apply(mainState(), { type: "playerError", error: { kind: "missing", message: "mpv not found", hint: "" } });
		assertHits(mpv, width, { "notice:action": "▸ How to install mpv" });
	}
});

test("S23 hover repaints only the hovered cells in the warning role and keeps the width", () => {
	const state = apply(mainState(), key("tab"));
	const plainFrame = frame(state, 120);
	const hovered = frame(state, 120, 30, "right:3");
	const hit = hovered.hits.find((h) => h.id === "right:3")!;
	assert.equal(stripAnsi(hovered.lines[hit.y]), stripAnsi(plainFrame.lines[hit.y]));
	assert.equal(visibleWidth(hovered.lines[hit.y]), 120);
	assert.ok(hovered.lines[hit.y].includes(`\x1b[${SGR.warning}m`), JSON.stringify(hovered.lines[hit.y]));
	assert.ok(!plainFrame.lines[hit.y].includes(`\x1b[${SGR.warning}m`));
	hovered.lines.forEach((line, i) => i !== hit.y && assert.equal(line, plainFrame.lines[i]));
	// The text after the hovered cells keeps its own color (the border).
	assert.ok(hovered.lines[hit.y].endsWith(`\x1b[${SGR.border}m│\x1b[39m`));
});

test("S23 hitAt finds the hit under a cell and the progress-bar ratio; paneAt finds the pane", () => {
	const state = apply(mainState({ player: playing() }), { type: "player", state: playing() });
	const f = frame(state, 140);
	const bar = f.hits.find((h) => h.id === "bar")!;
	assert.equal(hitAt(f, bar.x, bar.y)?.ratio, 0);
	assert.equal(hitAt(f, bar.end - 1, bar.y)?.ratio, 1);
	const track = f.hits.find((h) => h.id === "right:2")!;
	assert.equal(hitAt(f, track.end - 1, track.y)?.hit.id, "right:2");
	assert.equal(hitAt(f, 0, track.y), null, "the border is not a hit");
	assert.equal(paneAt(f, 3, track.y), "left");
	assert.equal(paneAt(f, track.x, track.y), "right");
	assert.equal(paneAt(f, track.x, 0), null);
});

test("S23 hints show n p and , . where they fit and give way in order; every line fits", () => {
	const row = (state: PopoverState, width: number) => plain(state, width).at(-2)!;
	const playingState = apply(mainState({ player: playing() }), { type: "player", state: playing() });
	assert.match(row(playingState, 140), /tab pane · space ⏯ · n p track · , \. ±5s · esc/);
	assert.match(row(playingState, 90), /tab pane · space ⏯ · , \. ±5s · esc/);
	assert.match(row(playingState, 80), /tab pane · space ⏯ · esc/);
	const right = apply(playingState, key("tab"));
	assert.match(row(right, 140), /tab pane · space ⏯ · n p track · , \. ±5s · r reload · esc/);
	for (const state of [playingState, right, mainState(), apply(mainState(), key("tab"))]) assertFits(state, "hints");
	assert.match(row(mainState(), 60), /tab pane · space ⏯ · esc|, \. ±5s/);
});

// ---- S25 sticky update offer ----

const OFFER_LINE = "yt-dlp 2026.11.05 available  ▸ Update (u) · Later (l)";
const offerState = (latest = "2026.11.05") =>
	apply(mainState({ deps: { mpv: true, ytDlp: "managed" }, setup: SETUP }), { type: "updateAvailable", latest });
const offerRow = (lines: string[]) => lines.find((l) => l.includes("▸ Update (u)"));

// S25: the exact text at every width; a long version gives way before the actions.
test("S25 the offer reads `yt-dlp <latest> available  ▸ Update (u) · Later (l)` and fits 60/80/100/140", () => {
	for (const width of WIDTHS) {
		const lines = plain(offerState(), width);
		assert.ok(lineMatching(lines, new RegExp(`^│ ${OFFER_LINE.replace(/[.()]/g, "\\$&")}\\s+│$`)), `${width}\n${lines.join("\n")}`);
		const long = plain(offerState(`2026.11.05.${"9".repeat(100)}`), width);
		const row = offerRow(long);
		assert.ok(row && row.endsWith("▸ Update (u) · Later (l) │") && row.includes("…"), `${width}: ${row}`);
		assert.equal(visibleWidth(row), width);
	}
	assertFits(offerState(), "offer");
});

// S25: the offer is still drawn after moving, typing a search and playing.
test("S25 the offer is still shown after moving, searching and playing", () => {
	const used = apply(
		offerState(),
		key("down"),
		key("tab"),
		key("down"),
		key("enter"),
		{ type: "player", state: playing() },
		key({ text: "/" }),
		key({ text: "x" }),
	);
	for (const width of WIDTHS) assert.ok(has(plain(used, width), OFFER_LINE), `${width}\n${plain(used, width).join("\n")}`);
});

// S25: a transient error takes the notice row; the offer comes back once the error closes.
test("S25 a transient error shows over the offer and the offer returns after the error closes", () => {
	const error = apply(offerState(), { type: "playerError", error: { message: "Playback failed.", hint: "Try again from /yt." } });
	assert.ok(has(plain(error, 120), "Playback failed."));
	assert.ok(!has(plain(error, 120), OFFER_LINE));
	const closed = apply(error, key("down"));
	assert.ok(!has(plain(closed, 120), "Playback failed."));
	assert.ok(has(plain(closed, 120), OFFER_LINE), plain(closed, 120).join("\n"));
	const f = frame(closed, 120);
	assert.deepEqual(f.hits.filter((h) => h.id.startsWith("notice:")).map((h) => h.id), ["notice:action", "notice:later"]);
});
