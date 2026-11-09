import { browserLabel, type Browser } from "./browsers.ts";
import type { Account } from "./config.ts";
import { UNSUPPORTED, type InstallError, type InstallProgress } from "./installer.ts";
import type { PlayerState } from "./player.ts";
import type {
	Playlist,
	PlaylistsResult,
	SourceError,
	SourceKind,
	Track,
	TracksResult,
	VerifyResult,
} from "./youtube-source.ts";

// Pure state machine for the /yt popover: (state, action) -> (state, effects).
// No I/O here; extensions/youtube.ts runs the effects and feeds results back.

export type Key = "up" | "down" | "enter" | "esc" | "tab" | "left" | "right" | "backspace" | { text: string };

export type SourceRef =
	| { kind: SourceKind }
	| { kind: "playlist"; id: string; title: string }
	| { kind: "queue" }
	| { kind: "search" };

/** `start` asks for the page beginning at that entry (default 1); `refresh` skips the session cache. */
export type PageRequest = { start?: number; refresh?: boolean };
export type LoadRequest =
	| ({ kind: SourceKind } & PageRequest)
	| ({ kind: "playlist"; id: string } & PageRequest)
	| { kind: "search"; query: string };

/** What Enter on a notice does: update yt-dlp, install it, or show how to install mpv. */
export type NoticeAction = "update" | "install" | "mpv";
/** The load to run again after Update/Install yt-dlp from a notice. */
export type Retry = "list" | "more" | "playlists";

export interface Notice {
	message: string;
	hint: string;
	/** Error kind, when the notice comes from one (e.g. `missing` from the player). */
	kind?: string;
	tone?: "error" | "success" | "info";
	action?: NoticeAction;
	retry?: Retry;
}

export interface Deps {
	mpv: boolean;
	/** Where the yt-dlp in use comes from, or null when there is none. */
	ytDlp: "system" | "managed" | null;
}

/** What the install screens show; filled by the extension from the pinned release and the OS. */
export interface SetupInfo {
	/** The pinned yt-dlp release for this system, or null when there is no official build. */
	ytDlp: { version: string; size: number | null; dir: string } | null;
	mpv: { command: string | null; text: string };
}

export type Dialog =
	| { type: "confirm"; cursor: number; retry: Retry | null }
	| { type: "download"; id: number; received: number; total: number | null; verifying: boolean; retry: Retry | null }
	| { type: "failed"; error: Pick<Notice, "message" | "hint">; cursor: number; retry: Retry | null }
	| { type: "mpv"; cursor: number; checking: boolean };

export type DialogChoice = "install" | "cancel" | "retry" | "back" | "copy" | "check";

export type Effect =
	| { type: "verify"; id: number; account: Account }
	| { type: "saveAccount"; account: Account }
	| { type: "clearAccount" }
	| { type: "load"; id: number; request: LoadRequest }
	| { type: "loadPlaylists"; id: number; refresh?: boolean }
	| { type: "cancel"; id: number }
	| { type: "play"; tracks: Track[]; index: number }
	| { type: "enqueue"; track: Track }
	| { type: "togglePause" }
	| { type: "next" }
	| { type: "prev" }
	| { type: "setShuffle"; on: boolean }
	| { type: "setVolume"; volume: number }
	/** Seek `seconds` from the current position, or to that second when `absolute`. */
	| { type: "seek"; seconds: number; absolute?: boolean }
	| { type: "install"; id: number }
	| { type: "update"; id: number }
	| { type: "checkTools" }
	| { type: "copy"; text: string }
	/** The update offer was answered or hidden: do not offer it again in this Pi session. */
	| { type: "dismissUpdate" }
	/** The track under the right-pane cursor changed (null: none); the extension prepares it after a short rest. */
	| { type: "dwell"; track: Track | null }
	/** Put the panes' scroll offsets back (a remembered place restored after Dependencies). */
	| { type: "scroll"; scroll: PaneScroll }
	| { type: "close" };

export type Action =
	| { type: "key"; key: Key }
	| { type: "verified"; id: number; result: VerifyResult }
	| { type: "loaded"; id: number; result: TracksResult }
	| { type: "playlistsLoaded"; id: number; result: PlaylistsResult }
	| { type: "player"; state: PlayerState }
	| { type: "playerError"; error: Notice }
	| { type: "installProgress"; id: number; progress: InstallProgress }
	| { type: "installed"; id: number; result: { ok: true } | { ok: false; error: InstallError } }
	| { type: "updated"; id: number; result: { ok: true } | { ok: false; error: InstallError } }
	| { type: "deps"; deps: Deps }
	| { type: "copied"; ok: boolean }
	/** A newer yt-dlp than the managed copy exists (S23). */
	| { type: "updateAvailable"; latest: string }
	/** A mouse click on a rendered element; `ratio` is where on the progress bar (0–1). */
	| { type: "click"; target: Target; ratio?: number }
	/** A wheel step over a pane of the main view (null: elsewhere); negative is up. */
	| { type: "wheel"; pane: "left" | "right" | null; delta: number };

/** What a click lands on, as the view lays it out (S23). Indexes follow the matching keyboard cursor. */
export type Target =
	| { type: "left"; key: string }
	| { type: "right"; index: number }
	| { type: "account"; index: number }
	| { type: "connect"; index: number }
	| { type: "dependency"; index: number }
	| { type: "dialog"; index: number }
	| { type: "notice"; choice: "action" | "later" }
	| { type: "control"; control: "prev" | "toggle" | "next" }
	| { type: "bar" };

export type ConnectOption =
	| { type: "browser"; browser: Browser }
	| { type: "anonymous" }
	| { type: "retry" }
	| { type: "another" };

/** Rows of the Dependencies screen the cursor can reach: missing tools, then Check again. */
export type DependencyOption = "install" | "mpvHelp" | "check";

export type AccountChoice = "another" | "disconnect";
export const ACCOUNT_CHOICES: AccountChoice[] = ["another", "disconnect"];

export interface PopoverState {
	screen: "dependencies" | "connect" | "main";
	account: Account | null;
	/** The user chose to continue without an account in this Pi session. */
	anonymous: boolean;
	browsers: Browser[];
	deps: Deps | null;
	setup: SetupInfo | null;
	/** Install / mpv screens drawn over the current screen, or null. */
	dialog: Dialog | null;
	/** A running Update yt-dlp, and the load to retry after it. */
	updating: { id: number; retry: Retry | null } | null;
	/** The newer yt-dlp offered (S25); it stays apart from the notices until Update or Later, or null. */
	offer: string | null;
	/** Dependencies screen (S19): its cursor, and the remembered place to open once both tools are found. */
	gate: { cursor: number; snapshot: PopoverSnapshot | null };
	connect: {
		phase: "pick" | "verifying" | "error";
		cursor: number;
		/** Index into browsers being verified or that failed. */
		target: number;
		verifyId: number;
		error: SourceError | null;
	};
	focus: "left" | "right";
	/** Key of the left row under the cursor (see leftRows). */
	leftKey: string;
	/** Cursor in the account choice shown in the right pane, or null when closed. */
	accountMenu: number | null;
	playlistsOpen: boolean;
	playlists: { status: "idle" | "loading" | "ready" | "error"; items: Playlist[]; error: SourceError | null; id: number };
	source: SourceRef | null;
	list: {
		status: "idle" | "loading" | "ready" | "error";
		tracks: Track[];
		error: SourceError | null;
		id: number;
		/** The last page came back full, so a Load more row follows the tracks. */
		hasMore: boolean;
		/** Id of the pending next-page load (Loading more…), or null. */
		more: number | null;
	};
	/** Loaded track counts by left row key. */
	counts: Record<string, number>;
	/** Right pane cursor: 0 Play all, 1 Shuffle, then tracks, then Load more; in search 0 is the input, then results. */
	rightIndex: number;
	/** Remembered cursor to put back when the restored list arrives (S18), or null. */
	restoreIndex: number | null;
	query: string;
	notice: Notice | null;
	player: PlayerState | null;
	nextId: number;
}

export interface PopoverInit {
	account: Account | null;
	anonymous: boolean;
	browsers: Browser[];
	deps: Deps | null;
	setup?: SetupInfo | null;
	player: PlayerState | null;
	/** Where the user left the popover earlier in this Pi session. */
	snapshot?: PopoverSnapshot | null;
}

/** Scroll offsets of both panes, kept by the extension between renders. */
export interface PaneScroll {
	left: number;
	right: number;
}

/** What the user could see when the popover closed, kept in memory for the Pi session (S18). */
export interface PopoverSnapshot {
	/** The account it was taken with; account-only sources need the same one. */
	account: Account | null;
	leftKey: string;
	source: SourceRef;
	focus: "left" | "right";
	rightIndex: number;
	scroll: PaneScroll;
	playlistsOpen: boolean;
	query: string;
	/** Search results on screen, or null. */
	results: Track[] | null;
}

export interface InitResult extends Result {
	scroll: PaneScroll;
}

export type LeftRow =
	| { type: "source"; key: string; source: SourceRef; label: string; count: number | null; accountOnly: boolean; indent: boolean }
	| { type: "playlists"; key: "playlists"; label: string; count: number | null; open: boolean; accountOnly: true }
	| { type: "account"; key: "account"; label: string; count: null; accountOnly: false }
	| { type: "rule" }
	| { type: "note"; text: string; tone: "dim" | "error" };

export interface Result {
	state: PopoverState;
	effects: Effect[];
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
	liked: "Liked videos",
	later: "Watch later",
	recommended: "Recommended",
	history: "History",
};
// YouTube's own order (S18).
const ACCOUNT_SOURCES: SourceKind[] = ["recommended", "history", "later", "liked"];
const COMMAND_KEYS = new Set([" ", "a", "n", "p", "+", "-", "/", ".", ","]);
const VOLUME_STEP = 5;
const SEEK_STEP = 5;

export function sourceKey(source: SourceRef): string {
	return source.kind === "playlist" ? `playlist:${source.id}` : source.kind;
}

export function sourceLabel(source: SourceRef): string {
	switch (source.kind) {
		case "playlist":
			return source.title;
		case "queue":
			return "Queue";
		case "search":
			return "Search";
		default:
			return SOURCE_LABELS[source.kind];
	}
}

export function hasAccount(state: PopoverState): boolean {
	return state.account !== null;
}

export function connectOptions(state: PopoverState): ConnectOption[] {
	const options: ConnectOption[] =
		state.connect.phase === "error"
			? [{ type: "retry" }, { type: "another" }, { type: "anonymous" }]
			: [...state.browsers.map((browser): ConnectOption => ({ type: "browser", browser })), { type: "anonymous" }];
	return options;
}

/** yt-dlp or mpv is known to be missing; unknown tools (null) do not block. */
export const missingTool = (deps: Deps | null) => deps !== null && (!deps.ytDlp || !deps.mpv);

export function dependencyOptions(state: PopoverState): DependencyOption[] {
	const options: DependencyOption[] = [];
	if (state.deps && !state.deps.ytDlp) options.push("install");
	if (state.deps && !state.deps.mpv) options.push("mpvHelp");
	options.push("check");
	return options;
}

/** The choices of the open dialog, in order; download has none. */
export function dialogChoices(state: PopoverState): DialogChoice[] {
	switch (state.dialog?.type) {
		case "confirm":
			return ["install", "cancel"];
		case "failed":
			return ["retry", "back"];
		case "mpv":
			return mpvSetup(state).command ? ["copy", "check"] : ["check"];
		default:
			return [];
	}
}

const MPV_UNKNOWN = { command: null, text: "Install mpv with your package manager: https://mpv.io/installation/" };
export function mpvSetup(state: PopoverState): SetupInfo["mpv"] {
	return state.setup?.mpv ?? MPV_UNKNOWN;
}

export function leftRows(state: PopoverState): LeftRow[] {
	const rows: LeftRow[] = ACCOUNT_SOURCES.map((kind) => ({
		type: "source",
		key: kind,
		source: { kind },
		label: SOURCE_LABELS[kind],
		count: state.counts[kind] ?? null,
		accountOnly: true,
		indent: false,
	}));
	rows.push({ type: "rule" });
	const { playlists } = state;
	rows.push({
		type: "playlists",
		key: "playlists",
		label: "Playlists",
		count: playlists.status === "ready" ? playlists.items.length : null,
		open: state.playlistsOpen,
		accountOnly: true,
	});
	if (state.playlistsOpen) {
		if (playlists.status === "loading") rows.push({ type: "note", text: "Loading…", tone: "dim" });
		else if (playlists.status === "error") rows.push({ type: "note", text: playlists.error?.message ?? "", tone: "error" });
		else if (playlists.status === "ready" && playlists.items.length === 0)
			rows.push({ type: "note", text: "Nothing here.", tone: "dim" });
		for (const p of playlists.status === "ready" ? playlists.items : []) {
			const source: SourceRef = { kind: "playlist", id: p.id, title: p.title };
			rows.push({
				type: "source",
				key: sourceKey(source),
				source,
				label: p.title,
				count: state.counts[sourceKey(source)] ?? p.count,
				accountOnly: true,
				indent: true,
			});
		}
	}
	rows.push({ type: "rule" });
	const queued = state.player?.queue.length ?? 0;
	rows.push({ type: "source", key: "queue", source: { kind: "queue" }, label: "Queue", count: queued || null, accountOnly: false, indent: false });
	rows.push({ type: "source", key: "search", source: { kind: "search" }, label: "Search…", count: null, accountOnly: false, indent: false });
	rows.push({ type: "rule" });
	rows.push({ type: "account", key: "account", label: accountLabel(state), count: null, accountOnly: false });
	return rows;
}

export function accountLabel(state: PopoverState): string {
	return state.account ? `Account · ${browserLabel(state.account.browser)}` : "Connect an account";
}

const selectable = (row: LeftRow): row is Extract<LeftRow, { key: string }> =>
	row.type === "source" || row.type === "playlists" || row.type === "account";

/** Right pane rows before the first track: Play all + Shuffle, or the search input. */
export function trackOffset(state: PopoverState): number {
	return state.source?.kind === "search" ? 1 : 2;
}

const clampRight = (state: PopoverState, index: number) => Math.max(0, Math.min(rightCount(state) - 1, index));

function rightCount(state: PopoverState): number {
	const tracks = state.list.tracks.length;
	if (state.source?.kind === "search") return 1 + tracks;
	return tracks > 0 ? 2 + tracks + (hasLoadMore(state) ? 1 : 0) : 0;
}

/** Whether the right pane ends with the Load more row; search results are a single page. */
export function hasLoadMore(state: PopoverState): boolean {
	return state.list.status === "ready" && state.list.hasMore && state.list.tracks.length > 0 && state.source?.kind !== "search";
}

/** Right pane index of the Load more row, or -1. */
export function loadMoreIndex(state: PopoverState): number {
	return hasLoadMore(state) ? trackOffset(state) + state.list.tracks.length : -1;
}

/** Index of the selected track, or -1 when the cursor is on an action or the input. */
export function selectedTrack(state: PopoverState): number {
	const i = state.rightIndex - trackOffset(state);
	return i >= 0 && i < state.list.tracks.length ? i : -1;
}

const emptyList = (): PopoverState["list"] => ({ status: "idle", tracks: [], error: null, id: 0, hasMore: false, more: null });
const loadingList = (id: number): PopoverState["list"] => ({ ...emptyList(), status: "loading", id });

export function initPopover(init: PopoverInit): InitResult {
	const state: PopoverState = {
		screen: init.account || init.anonymous ? "main" : "connect",
		account: init.account,
		anonymous: init.anonymous && !init.account,
		browsers: init.browsers,
		deps: init.deps,
		setup: init.setup ?? null,
		dialog: null,
		updating: null,
		offer: null,
		gate: { cursor: 0, snapshot: null },
		connect: { phase: "pick", cursor: 0, target: 0, verifyId: 0, error: null },
		focus: "left",
		leftKey: "recommended",
		accountMenu: null,
		playlistsOpen: false,
		playlists: { status: "idle", items: [], error: null, id: 0 },
		source: null,
		list: emptyList(),
		counts: {},
		rightIndex: 0,
		restoreIndex: null,
		query: "",
		notice: null,
		player: init.player,
		nextId: 1,
	};
	// S19: nothing can start a session until both tools are found; the remembered place waits.
	if (missingTool(state.deps)) {
		const gate = { cursor: 0, snapshot: init.snapshot ?? null };
		return { state: { ...state, screen: "dependencies", gate }, effects: [], scroll: { left: 0, right: 0 } };
	}
	return land(state, init.snapshot ?? null);
}

/** Where /yt opens with both tools: connect, the remembered place, or main. */
function land(state: PopoverState, snapshot: PopoverSnapshot | null): InitResult {
	const scroll = { left: 0, right: 0 };
	if (!state.account && !state.anonymous) return { state: { ...state, screen: "connect" }, effects: [], scroll };
	if (snapshot && canRestore(state, snapshot)) return restore(state, snapshot);
	return { ...enterMain(state), scroll };
}

const READY: Notice = { message: "✓ Ready", hint: "", tone: "success" };

/** Both tools found on Dependencies: leave for where /yt would have opened, saying so. */
function leaveGate(state: PopoverState): Result {
	const base: PopoverState = { ...state, dialog: null, notice: { ...READY }, gate: { cursor: 0, snapshot: null } };
	const out = land(base, state.gate.snapshot);
	const restored = out.scroll.left > 0 || out.scroll.right > 0;
	return { state: out.state, effects: restored ? [{ type: "scroll", scroll: out.scroll }, ...out.effects] : out.effects };
}

const sameAccount = (a: Account | null, b: Account | null) => a?.browser === b?.browser && a?.profile === b?.profile;
const needsAccount = (source: SourceRef) => source.kind !== "queue" && source.kind !== "search";

/** A remembered account-only source needs the same account connected now. */
function canRestore(state: PopoverState, snapshot: PopoverSnapshot): boolean {
	return !needsAccount(snapshot.source) || (state.account !== null && sameAccount(state.account, snapshot.account));
}

/** Open main where the snapshot left it; lists come from the session cache through the usual load effects. */
function restore(state: PopoverState, snapshot: PopoverSnapshot): InitResult {
	const scroll = { left: Math.max(0, snapshot.scroll.left), right: Math.max(0, snapshot.scroll.right) };
	const same = sameAccount(state.account, snapshot.account);
	const playlistsOpen = snapshot.playlistsOpen && same && state.account !== null;
	const leftKey = !same && snapshot.leftKey.startsWith("playlist:") ? sourceKey(snapshot.source) : snapshot.leftKey;
	let base: PopoverState = { ...state, screen: "main", focus: snapshot.focus, leftKey };
	const effects: Effect[] = [];
	if (playlistsOpen) {
		const out = loadPlaylists(base, false);
		base = out.state;
		effects.push(...out.effects);
	}
	const out = openSource(base, snapshot.source, false);
	let next = out.state;
	effects.push(...out.effects);
	if (snapshot.source.kind === "search") {
		const list = snapshot.results ? { ...emptyList(), status: "ready" as const, tracks: snapshot.results } : emptyList();
		next = { ...next, query: snapshot.query, list };
	}
	if (next.list.status === "loading") next = { ...next, restoreIndex: snapshot.rightIndex };
	else next = { ...next, rightIndex: clampRight(next, snapshot.rightIndex) };
	return { state: next, effects, scroll };
}

/** What to remember when the popover closes; the connect screen leaves nothing, Dependencies keeps the earlier one. */
export function snapshotPopover(state: PopoverState, scroll: PaneScroll): PopoverSnapshot | null {
	// Closed on Dependencies: keep the place remembered before it.
	if (state.screen === "dependencies") return state.gate.snapshot;
	if (state.screen !== "main" || !state.source) return null;
	const searchResults = state.source.kind === "search" && state.list.status === "ready";
	return {
		account: state.account,
		leftKey: state.leftKey,
		source: state.source,
		// The account choice is not reopened: its row keeps the left pane.
		focus: state.accountMenu !== null ? "left" : state.focus,
		rightIndex: state.restoreIndex ?? state.rightIndex,
		scroll: { left: scroll.left, right: scroll.right },
		playlistsOpen: state.playlistsOpen,
		query: state.query,
		results: searchResults ? state.list.tracks : null,
	};
}

/** Land on main: Recommended with an account, search without. */
function enterMain(state: PopoverState): Result {
	state = { ...state, screen: "main", focus: "left" };
	if (state.account) return openSource({ ...state, leftKey: "recommended" }, { kind: "recommended" }, false);
	return openSource({ ...state, leftKey: "search" }, { kind: "search" }, true);
}

function cancelPending(state: PopoverState): Effect[] {
	if (state.list.status === "loading") return [{ type: "cancel", id: state.list.id }];
	return state.list.more !== null ? [{ type: "cancel", id: state.list.more }] : [];
}

function pageRequest(source: SourceRef, page: PageRequest): LoadRequest | null {
	if (source.kind === "playlist") return { kind: "playlist", id: source.id, ...page };
	if (source.kind === "queue" || source.kind === "search") return null;
	return { kind: source.kind, ...page };
}

function openSource(state: PopoverState, source: SourceRef, focusRight: boolean, page: PageRequest = {}): Result {
	const effects = cancelPending(state);
	const base: PopoverState = {
		...state,
		source,
		accountMenu: null,
		rightIndex: 0,
		restoreIndex: null,
		focus: focusRight ? "right" : state.focus,
	};
	if (source.kind === "search") return { state: { ...base, list: emptyList() }, effects };
	if (source.kind === "queue") {
		const tracks = state.player?.queue ?? [];
		return { state: { ...base, list: { ...emptyList(), status: "ready", tracks } }, effects };
	}
	const id = state.nextId;
	effects.push({ type: "load", id, request: pageRequest(source, page)! });
	return { state: { ...base, nextId: id + 1, list: loadingList(id) }, effects };
}

/** Enter on Load more: fetch the page after the loaded tracks; it is appended when it arrives. */
function loadMore(state: PopoverState): Result {
	const request = state.source && pageRequest(state.source, { start: state.list.tracks.length + 1 });
	if (!request || state.list.more !== null) return { state, effects: [] };
	const id = state.nextId;
	return { state: { ...state, nextId: id + 1, list: { ...state.list, more: id } }, effects: [{ type: "load", id, request }] };
}

/** r: reload the current source from page 1, bypassing the session cache. */
function reload(state: PopoverState): Result {
	if (!state.source || !pageRequest(state.source, {})) return { state, effects: [] };
	return openSource(state, state.source, false, { refresh: true });
}

function loadPlaylists(state: PopoverState, refresh: boolean): Result {
	const id = state.nextId;
	return {
		state: { ...state, nextId: id + 1, playlistsOpen: true, playlists: { status: "loading", items: [], error: null, id } },
		effects: [refresh ? { type: "loadPlaylists", id, refresh: true } : { type: "loadPlaylists", id }],
	};
}

function startSearch(state: PopoverState): Result {
	const query = state.query.trim();
	if (!query) return { state, effects: [] };
	const effects = cancelPending(state);
	const id = state.nextId;
	effects.push({ type: "load", id, request: { kind: "search", query } });
	return {
		state: { ...state, nextId: id + 1, rightIndex: 0, list: loadingList(id) },
		effects,
	};
}

function toConnect(state: PopoverState): Result {
	return {
		state: {
			...state,
			screen: "connect",
			anonymous: false,
			accountMenu: null,
			connect: { ...state.connect, phase: "pick", cursor: 0, error: null },
		},
		effects: cancelPending(state),
	};
}

function verify(state: PopoverState, target: number): Result {
	const browser = state.browsers[target];
	const id = state.nextId;
	return {
		state: { ...state, nextId: id + 1, connect: { ...state.connect, phase: "verifying", target, verifyId: id, error: null } },
		effects: [{ type: "verify", id, account: { browser: browser.id, profile: browser.profile } }],
	};
}

/** Back from the connect screen to main while an account is still saved; reloads a list or page cut off by toConnect. */
function backToMain(state: PopoverState): Result {
	const main: PopoverState = { ...state, screen: "main", focus: "left", leftKey: "account", accountMenu: null };
	if (state.list.status === "loading" && state.source) return openSource(main, state.source, false);
	if (state.list.more !== null) return loadMore({ ...main, list: { ...main.list, more: null } });
	return { state: main, effects: [] };
}

function connectKey(state: PopoverState, key: Key): Result {
	if (key === "esc") return state.account ? backToMain(state) : { state, effects: [{ type: "close" }] };
	if (state.connect.phase === "verifying") return { state, effects: [] };
	const options = connectOptions(state);
	const cursor = state.connect.cursor;
	if (key === "up" || key === "down") {
		const next = Math.max(0, Math.min(options.length - 1, cursor + (key === "up" ? -1 : 1)));
		return { state: { ...state, connect: { ...state.connect, cursor: next } }, effects: [] };
	}
	if (key !== "enter") return { state, effects: [] };
	const option = options[cursor];
	switch (option?.type) {
		case "browser":
			return verify(state, state.browsers.indexOf(option.browser));
		case "retry":
			return verify(state, state.connect.target);
		case "another":
			return {
				state: { ...state, connect: { ...state.connect, phase: "pick", cursor: state.connect.target, error: null } },
				effects: [],
			};
		case "anonymous":
			return enterMain({ ...state, anonymous: true, account: null });
		default:
			return { state, effects: [] };
	}
}

/** Dependencies (S19): only the tool actions and Check again; esc closes. */
function dependenciesKey(state: PopoverState, key: Key): Result {
	if (key === "esc") return { state, effects: [{ type: "close" }] };
	const options = dependencyOptions(state);
	const cursor = state.gate.cursor;
	if (key === "up" || key === "down") {
		const next = Math.max(0, Math.min(options.length - 1, cursor + (key === "up" ? -1 : 1)));
		return { state: { ...state, gate: { ...state.gate, cursor: next } }, effects: [] };
	}
	if (key !== "enter") return { state, effects: [] };
	switch (options[cursor]) {
		case "install":
			return openInstall(state, null);
		case "mpvHelp":
			return { state: { ...state, dialog: { type: "mpv", cursor: 0, checking: false } }, effects: [] };
		case "check":
			return { state, effects: [{ type: "checkTools" }] };
		default:
			return { state, effects: [] };
	}
}

// ---- S17: install yt-dlp, update it, and how to install mpv ----

const SYSTEM_UPDATE: Notice = { message: "yt-dlp comes from your system.", hint: "Update yt-dlp with your package manager." };
const YTDLP_MISSING: Notice = { message: "yt-dlp not found", hint: "", action: "install" };

/** Install yt-dlp: the confirmation, or straight to the reason when there is no official build. */
function openInstall(state: PopoverState, retry: Retry | null): Result {
	if (!state.setup?.ytDlp)
		return {
			state: { ...state, dialog: { type: "failed", error: { message: UNSUPPORTED.message, hint: UNSUPPORTED.hint }, cursor: 0, retry } },
			effects: [],
		};
	return { state: { ...state, dialog: { type: "confirm", cursor: 0, retry } }, effects: [] };
}

function startInstall(state: PopoverState, retry: Retry | null): Result {
	if (!state.setup?.ytDlp) return openInstall(state, retry);
	const id = state.nextId;
	const total = state.setup.ytDlp.size;
	return {
		state: { ...state, nextId: id + 1, dialog: { type: "download", id, received: 0, total, verifying: false, retry } },
		effects: [{ type: "install", id }],
	};
}

/** Update yt-dlp: runs on the managed copy; a system copy is the package manager's job. */
function startUpdate(state: PopoverState, retry: Retry | null): Result {
	if (state.updating) return { state, effects: [] };
	// Unknown tools (the check failed): the update effect looks at the real copy and reports what it finds.
	const source = state.deps ? state.deps.ytDlp : undefined;
	if (source === "system") return { state: { ...state, notice: { ...SYSTEM_UPDATE } }, effects: [] };
	if (source === null) return { state: { ...state, notice: { ...YTDLP_MISSING, ...(retry ? { retry } : {}) } }, effects: [] };
	const id = state.nextId;
	return { state: { ...state, nextId: id + 1, updating: { id, retry } }, effects: [{ type: "update", id }] };
}

/** Run the load that failed before Update/Install yt-dlp, once, if it is still the one on screen. */
function runRetry(state: PopoverState, retry: Retry | null): Result {
	if (retry === "list" && state.list.status === "error" && state.source) {
		return state.source.kind === "search" ? startSearch(state) : openSource(state, state.source, false);
	}
	if (retry === "more" && hasLoadMore(state)) return loadMore(state);
	if (retry === "playlists" && state.playlists.status === "error") return loadPlaylists(state, true);
	return { state, effects: [] };
}

function noticeAction(state: PopoverState, notice: Notice): Result {
	switch (notice.action) {
		case "update":
			return startUpdate(state, notice.retry ?? null);
		case "install":
			return openInstall(state, notice.retry ?? null);
		case "mpv":
			return { state: { ...state, dialog: { type: "mpv", cursor: 0, checking: false } }, effects: [] };
		default:
			return { state, effects: [] };
	}
}

/** A notice for a failed yt-dlp call, offering Update (extract) or Install (missing) when they can help. */
function errorNotice(error: { kind: string; message: string; hint: string }, retry: Retry): Notice {
	const notice: Notice = { message: error.message, hint: error.hint };
	if (error.kind === "extract") return { ...notice, action: "update", retry };
	if (error.kind === "missing") return { ...notice, action: "install", retry };
	return notice;
}
const offersAction = (error: { kind: string }) => error.kind === "extract" || error.kind === "missing";

function dialogKey(state: PopoverState, key: Key): Result {
	const dialog = state.dialog!;
	const close = { ...state, dialog: null };
	if (dialog.type === "download") {
		if (key !== "esc") return { state, effects: [] };
		return { state: close, effects: [{ type: "cancel", id: dialog.id }] };
	}
	if (key === "esc") return { state: close, effects: [] };
	const choices = dialogChoices(state);
	if (key === "up" || key === "down") {
		const cursor = Math.max(0, Math.min(choices.length - 1, dialog.cursor + (key === "up" ? -1 : 1)));
		return { state: { ...state, dialog: { ...dialog, cursor } }, effects: [] };
	}
	if (key !== "enter") return { state, effects: [] };
	switch (choices[dialog.cursor]) {
		case "install":
		case "retry":
			return startInstall(state, dialog.type === "mpv" ? null : dialog.retry);
		case "copy": {
			const command = mpvSetup(state).command;
			return { state, effects: command ? [{ type: "copy", text: command }] : [] };
		}
		case "check":
			return { state: { ...state, dialog: { type: "mpv", cursor: dialog.cursor, checking: true } }, effects: [{ type: "checkTools" }] };
		default:
			return { state: close, effects: [] };
	}
}

function clampConnect(state: PopoverState): PopoverState {
	const last = Math.max(0, connectOptions(state).length - 1);
	return state.connect.cursor > last ? { ...state, connect: { ...state.connect, cursor: last } } : state;
}

/** After a tool appears the rows above Check again shrink; the cursor keeps its row from the bottom. */
function clampGate(state: PopoverState, before: number): PopoverState {
	const count = dependencyOptions(state).length;
	const cursor = Math.max(0, Math.min(count - 1, state.gate.cursor - (before - count)));
	return { ...state, gate: { ...state.gate, cursor } };
}

function moveLeft(state: PopoverState, delta: number): PopoverState {
	const keys = leftRows(state).filter(selectable).map((r) => r.key);
	const at = Math.max(0, keys.indexOf(state.leftKey));
	return { ...state, leftKey: keys[Math.max(0, Math.min(keys.length - 1, at + delta))] };
}

function enterLeft(state: PopoverState): Result {
	const row = leftRows(state).filter(selectable).find((r) => r.key === state.leftKey);
	if (!row) return { state, effects: [] };
	if (row.type === "account") {
		if (!hasAccount(state)) return toConnect(state);
		return { state: { ...state, accountMenu: 0, focus: "right" }, effects: [] };
	}
	if (row.accountOnly && !hasAccount(state)) return toConnect(state);
	// Any other row replaces the account choice on the right.
	state = { ...state, accountMenu: null };
	if (row.type === "playlists") {
		if (state.playlistsOpen) return { state: { ...state, playlistsOpen: false }, effects: [] };
		if (state.playlists.status === "ready" || state.playlists.status === "loading")
			return { state: { ...state, playlistsOpen: true }, effects: [] };
		return loadPlaylists(state, false);
	}
	return openSource(state, row.source, true);
}

function enterRight(state: PopoverState): Result {
	const { tracks } = state.list;
	if (state.source?.kind === "search" && state.rightIndex === 0) return startSearch(state);
	if (state.rightIndex === loadMoreIndex(state)) return loadMore(state);
	const index = selectedTrack(state);
	if (index >= 0) return { state, effects: [{ type: "play", tracks, index }] };
	if (tracks.length === 0) return { state, effects: [] };
	if (state.rightIndex === 0) return { state, effects: [{ type: "play", tracks, index: 0 }] };
	return {
		state,
		effects: [
			{ type: "play", tracks, index: 0 },
			{ type: "setShuffle", on: true },
		],
	};
}

function command(state: PopoverState, ch: string): Result {
	const volume = state.player?.volume ?? 100;
	switch (ch) {
		case " ":
			return { state, effects: [{ type: "togglePause" }] };
		case "n":
			return { state, effects: [{ type: "next" }] };
		case "p":
			return { state, effects: [{ type: "prev" }] };
		case "+":
			return { state, effects: [{ type: "setVolume", volume: volume + VOLUME_STEP }] };
		case "-":
			return { state, effects: [{ type: "setVolume", volume: volume - VOLUME_STEP }] };
		case ".":
		case ",":
			return playing(state) ? { state, effects: [{ type: "seek", seconds: ch === "." ? SEEK_STEP : -SEEK_STEP }] } : { state, effects: [] };
		case "/":
			return openSource({ ...state, leftKey: "search" }, { kind: "search" }, true);
		case "r":
			if (state.focus === "right") return reload(state);
			if (state.leftKey === "playlists" && hasAccount(state)) return loadPlaylists(state, true);
			return { state, effects: [] };
		case "a": {
			const index = state.focus === "right" ? selectedTrack(state) : -1;
			return { state, effects: index >= 0 ? [{ type: "enqueue", track: state.list.tracks[index] }] : [] };
		}
		default:
			return { state, effects: [] };
	}
}

function accountKey(state: PopoverState, key: Key): Result {
	const cursor = state.accountMenu ?? 0;
	switch (key) {
		case "esc":
			return { state: { ...state, accountMenu: null, focus: "left" }, effects: [] };
		// Panes switch as anywhere else; the choice stays open on the right until another row opens (S23).
		case "tab":
		case "left":
			return { state: { ...state, focus: "left" }, effects: [] };
		case "up":
		case "down": {
			const next = Math.max(0, Math.min(ACCOUNT_CHOICES.length - 1, cursor + (key === "up" ? -1 : 1)));
			return { state: { ...state, accountMenu: next }, effects: [] };
		}
		case "enter": {
			if (ACCOUNT_CHOICES[cursor] === "another") return toConnect(state);
			const out = toConnect({
				...state,
				account: null,
				counts: {},
				playlists: { status: "idle", items: [], error: null, id: 0 },
				playlistsOpen: false,
			});
			return { state: out.state, effects: [...out.effects, { type: "clearAccount" }] };
		}
		default:
			return { state, effects: [] };
	}
}

function mainKey(state: PopoverState, key: Key): Result {
	if (state.accountMenu !== null && state.focus === "right") return accountKey(state, key);
	const searching = state.focus === "right" && state.source?.kind === "search";
	if (typeof key === "object") {
		const typing = searching && (state.rightIndex === 0 || !COMMAND_KEYS.has(key.text));
		if (typing) return { state: { ...state, query: state.query + key.text, rightIndex: 0 }, effects: [] };
		return command(state, key.text);
	}
	switch (key) {
		case "esc":
			if (searching && state.query) return { state: { ...state, query: "", rightIndex: 0 }, effects: [] };
			return { state, effects: [{ type: "close" }] };
		case "tab":
			return { state: { ...state, focus: state.focus === "left" ? "right" : "left" }, effects: [] };
		case "left":
		case "right":
			return { state: { ...state, focus: key }, effects: [] };
		case "backspace":
			if (!searching) return { state, effects: [] };
			return { state: { ...state, query: [...state.query].slice(0, -1).join(""), rightIndex: 0 }, effects: [] };
		case "up":
		case "down": {
			const delta = key === "up" ? -1 : 1;
			if (state.focus === "left") return { state: moveLeft(state, delta), effects: [] };
			const last = Math.max(0, rightCount(state) - 1);
			return { state: { ...state, rightIndex: Math.max(0, Math.min(last, state.rightIndex + delta)) }, effects: [] };
		}
		case "enter":
			return state.focus === "left" ? enterLeft(state) : enterRight(state);
	}
}

/** The track the right-pane cursor rests on in the main view: library lists, search results and Queue. */
function dwellTrack(state: PopoverState): Track | null {
	if (state.screen !== "main" || state.focus !== "right" || state.dialog || state.accountMenu !== null) return null;
	const index = selectedTrack(state);
	return index >= 0 ? state.list.tracks[index] : null;
}

export function reduce(state: PopoverState, action: Action): Result {
	let out = step(state, action);
	// The update offer was answered (Update or Later): not again this session.
	if (state.offer !== null && out.state.offer === null)
		out = { state: out.state, effects: [...out.effects, { type: "dismissUpdate" }] };
	const before = dwellTrack(state);
	const after = dwellTrack(out.state);
	if (before?.url === after?.url) return out;
	return { state: out.state, effects: [...out.effects, { type: "dwell", track: after }] };
}

const playing = (state: PopoverState) => !!state.player?.running && !state.player.idle;

/** S23(1): a click does what the keys would on that element; targets of another screen are ignored. */
function click(state: PopoverState, target: Target, ratio: number | undefined): Result {
	const none = { state, effects: [] };
	const notice = state.notice;
	const cleared = notice ? { ...state, notice: null } : state;
	if (target.type === "notice") {
		if (notice) return notice.action && target.choice === "action" ? noticeAction(cleared, notice) : none;
		return offerShown(state) ? answerOffer(state, target.choice === "action") : none;
	}
	if (cleared.dialog) {
		if (target.type !== "dialog" || target.index >= dialogChoices(cleared).length || cleared.dialog.type === "download") return none;
		return dialogKey({ ...cleared, dialog: { ...cleared.dialog, cursor: target.index } }, "enter");
	}
	switch (cleared.screen) {
		case "dependencies":
			if (target.type !== "dependency" || target.index >= dependencyOptions(cleared).length) return none;
			return dependenciesKey({ ...cleared, gate: { ...cleared.gate, cursor: target.index } }, "enter");
		case "connect":
			if (target.type !== "connect" || cleared.connect.phase === "verifying" || target.index >= connectOptions(cleared).length) return none;
			return connectKey({ ...cleared, connect: { ...cleared.connect, cursor: target.index } }, "enter");
	}
	switch (target.type) {
		case "left": {
			if (!leftRows(cleared).some((row) => selectable(row) && row.key === target.key)) return none;
			return enterLeft({ ...cleared, focus: "left", leftKey: target.key });
		}
		case "right": {
			if (cleared.accountMenu !== null || target.index >= rightCount(cleared)) return none;
			const focused: PopoverState = { ...cleared, focus: "right", rightIndex: target.index };
			// The search input only takes focus; a track plays on a click once selected; actions run at once.
			if (cleared.source?.kind === "search" && target.index === 0) return { state: focused, effects: [] };
			if (selectedTrack(focused) >= 0 && !(state.focus === "right" && state.rightIndex === target.index))
				return { state: focused, effects: [] };
			return enterRight(focused);
		}
		case "account":
			if (cleared.accountMenu === null || target.index >= ACCOUNT_CHOICES.length) return none;
			return accountKey({ ...cleared, focus: "right", accountMenu: target.index }, "enter");
		case "control": {
			const type = target.control === "toggle" ? "togglePause" : target.control;
			return { state: cleared, effects: [{ type }] };
		}
		case "bar": {
			const duration = cleared.player?.duration;
			if (!playing(cleared) || !duration || ratio === undefined) return none;
			const seconds = Math.round(Math.max(0, Math.min(1, ratio)) * duration);
			return { state: cleared, effects: [{ type: "seek", seconds, absolute: true }] };
		}
		default:
			return none;
	}
}

/** S23(1): one wheel step moves the cursor of the pane under the pointer (focusing it), or of the open list. */
function wheel(state: PopoverState, pane: "left" | "right" | null, delta: number): Result {
	if (!delta) return { state, effects: [] };
	const key: Key = delta < 0 ? "up" : "down";
	if (!state.dialog && state.screen === "main") {
		if (!pane) return { state, effects: [] };
		return step({ ...state, focus: pane }, { type: "key", key });
	}
	return step(state, { type: "key", key });
}

/** The update offer is kept on connect and main (S25); never on Dependencies or while an update runs. */
function offerUpdate(state: PopoverState, latest: string): Result {
	if (state.screen === "dependencies" || state.updating) return { state, effects: [] };
	return { state: { ...state, offer: latest }, effects: [] };
}

/** The update offer is on screen: no transient notice, update or dialog takes its row. */
export function offerShown(state: PopoverState): boolean {
	return state.offer !== null && !state.notice && !state.updating && !state.dialog && state.screen !== "dependencies";
}

/** Update (`u`) or Later (`l`) on the offer; both end it for the session. */
function answerOffer(state: PopoverState, update: boolean): Result {
	const answered = { ...state, offer: null };
	return update ? startUpdate(answered, null) : { state: answered, effects: [] };
}

/** `u` and `l` answer the offer while it shows, except typed into the search input (S25). */
function offerKey(state: PopoverState, key: Key): boolean | null {
	if (typeof key !== "object" || (key.text !== "u" && key.text !== "l") || !offerShown(state)) return null;
	const input =
		state.screen === "main" && state.focus === "right" && state.accountMenu === null && state.source?.kind === "search" && state.rightIndex === 0;
	return input ? null : key.text === "u";
}

function step(state: PopoverState, action: Action): Result {
	switch (action.type) {
		case "key": {
			const cleared = state.notice ? { ...state, notice: null } : state;
			if (cleared.dialog) return dialogKey(cleared, action.key);
			if (cleared.screen === "dependencies") return dependenciesKey(cleared, action.key);
			const answer = offerKey(state, action.key);
			if (answer !== null) return answerOffer(state, answer);
			if (state.notice?.action && action.key === "enter") return noticeAction(cleared, state.notice);
			return cleared.screen === "connect" ? connectKey(cleared, action.key) : mainKey(cleared, action.key);
		}
		case "verified": {
			if (state.screen !== "connect" || state.connect.phase !== "verifying" || action.id !== state.connect.verifyId)
				return { state, effects: [] };
			if (!action.result.ok) {
				return {
					state: { ...state, connect: { ...state.connect, phase: "error", cursor: 0, error: action.result.error } },
					effects: [],
				};
			}
			const browser = state.browsers[state.connect.target];
			const account: Account = { browser: browser.id, profile: browser.profile };
			const main = enterMain({
				...state,
				account,
				anonymous: false,
				counts: {},
				playlists: { status: "idle", items: [], error: null, id: 0 },
				playlistsOpen: false,
			});
			return { state: main.state, effects: [{ type: "saveAccount", account }, ...main.effects] };
		}
		case "loaded": {
			if (!state.source) return { state, effects: [] };
			const { result } = action;
			const page = state.list.status === "ready" && action.id === state.list.more;
			if (!page && (state.list.status !== "loading" || action.id !== state.list.id)) return { state, effects: [] };
			if (!result.ok) {
				if (page)
					return { state: { ...state, list: { ...state.list, more: null }, notice: errorNotice(result.error, "more") }, effects: [] };
				const notice = offersAction(result.error) ? errorNotice(result.error, "list") : state.notice;
				return {
					state: { ...state, notice, restoreIndex: null, list: { ...state.list, status: "error", error: result.error } },
					effects: [],
				};
			}
			const tracks = page ? [...state.list.tracks, ...result.tracks] : result.tracks;
			const counts = state.source.kind === "search" ? state.counts : { ...state.counts, [sourceKey(state.source)]: tracks.length };
			const list: PopoverState["list"] = { ...state.list, status: "ready", tracks, hasMore: result.hasMore ?? false, more: null };
			const next: PopoverState = { ...state, counts, list, restoreIndex: null };
			const rightIndex = page ? state.rightIndex : clampRight(next, state.restoreIndex ?? 0);
			return { state: { ...next, rightIndex }, effects: [] };
		}
		case "playlistsLoaded": {
			if (state.playlists.status !== "loading" || action.id !== state.playlists.id) return { state, effects: [] };
			const { result } = action;
			const playlists: PopoverState["playlists"] = result.ok
				? { status: "ready", items: result.playlists, error: null, id: action.id }
				: { status: "error", items: [], error: result.error, id: action.id };
			return {
				state: { ...state, playlists, notice: result.ok ? state.notice : errorNotice(result.error, "playlists") },
				effects: [],
			};
		}
		case "player": {
			let next: PopoverState = { ...state, player: action.state };
			if (state.source?.kind === "queue") {
				const tracks = action.state.queue;
				const last = Math.max(0, (tracks.length ? tracks.length + 2 : 0) - 1);
				next = { ...next, rightIndex: Math.min(state.rightIndex, last), list: { ...state.list, tracks } };
			}
			return { state: next, effects: [] };
		}
		case "playerError": {
			const { kind, message, hint } = action.error;
			// The player's `missing` is mpv; an extraction failure is yt-dlp's.
			const extra: Partial<Notice> = kind === "missing" ? { action: "mpv" } : kind === "extract" ? { action: "update" } : {};
			return { state: { ...state, notice: { message, hint, ...extra } }, effects: [] };
		}
		case "installProgress": {
			const { dialog } = state;
			if (dialog?.type !== "download" || dialog.id !== action.id) return { state, effects: [] };
			const { progress } = action;
			const next =
				progress.phase === "verify"
					? { ...dialog, verifying: true }
					: { ...dialog, received: progress.received, total: progress.total ?? dialog.total };
			return { state: { ...state, dialog: next }, effects: [] };
		}
		case "installed": {
			const { dialog } = state;
			if (dialog?.type !== "download" || dialog.id !== action.id) return { state, effects: [] };
			const { result } = action;
			if (!result.ok) {
				const error = { message: result.error.message, hint: result.error.hint };
				return { state: { ...state, dialog: { type: "failed", error, cursor: 0, retry: dialog.retry } }, effects: [] };
			}
			const done: PopoverState = { ...state, dialog: null, notice: { message: "✓ yt-dlp installed", hint: "", tone: "success" } };
			const again = runRetry(done, dialog.retry);
			return { state: again.state, effects: [{ type: "checkTools" }, ...again.effects] };
		}
		case "updated": {
			if (state.updating?.id !== action.id) return { state, effects: [] };
			const { retry } = state.updating;
			const { result } = action;
			const base: PopoverState = { ...state, updating: null };
			if (!result.ok) return { state: { ...base, notice: { message: result.error.message, hint: result.error.hint } }, effects: [] };
			return runRetry({ ...base, notice: { message: "yt-dlp is up to date.", hint: "", tone: "success" } }, retry);
		}
		case "deps": {
			const before = dependencyOptions(state).length;
			let next = clampConnect({ ...state, deps: action.deps });
			const { dialog } = next;
			if (dialog?.type === "mpv" && dialog.checking) {
				next = action.deps.mpv
					? { ...next, dialog: null, notice: { message: "✓ mpv found", hint: "", tone: "success" } }
					: { ...next, dialog: { ...dialog, checking: false }, notice: { message: "mpv still not found.", hint: "Install it, then check again." } };
			}
			if (next.screen === "dependencies") {
				if (!missingTool(action.deps)) return leaveGate(next);
				next = clampGate(next, before);
			}
			return { state: next, effects: [] };
		}
		case "updateAvailable":
			return offerUpdate(state, action.latest);
		case "click":
			return click(state, action.target, action.ratio);
		case "wheel":
			return wheel(state, action.pane, action.delta);
		case "copied":
			return {
				state: {
					...state,
					notice: action.ok
						? { message: "Copied.", hint: "", tone: "success" }
						: { message: "No clipboard tool found; copy it by hand.", hint: "" },
				},
				effects: [],
			};
	}
}

/** Map raw terminal input to a popover key, using the host keybindings for the select keys. */
export function keyFromInput(data: string, matches: (data: string, id: string) => boolean): Key | undefined {
	if (matches(data, "tui.select.up")) return "up";
	if (matches(data, "tui.select.down")) return "down";
	if (matches(data, "tui.select.confirm")) return "enter";
	if (matches(data, "tui.select.cancel")) return "esc";
	switch (data) {
		case "\t":
			return "tab";
		case "\x1b[D":
			return "left";
		case "\x1b[C":
			return "right";
		case "\x7f":
		case "\b":
			return "backspace";
	}
	if (!data || /[\u0000-\u001f\u007f-\u009f]/.test(data)) return undefined;
	return { text: data };
}
