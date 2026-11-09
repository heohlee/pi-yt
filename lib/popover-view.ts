import { browserLabel } from "./browsers.ts";
import { formatTime, sanitize } from "./now-playing.ts";
import { YT_DLP_LICENSE, YT_DLP_SOURCE } from "./installer.ts";
import {
	ACCOUNT_CHOICES,
	accountLabel,
	connectOptions,
	dependencyOptions,
	dialogChoices,
	mpvSetup,
	hasAccount,
	offerShown,
	hasLoadMore,
	leftRows,
	loadMoreIndex,
	selectedTrack,
	sourceKey,
	sourceLabel,
	trackOffset,
	type DependencyOption,
	type DialogChoice,
	type LeftRow,
	type NoticeAction,
	type PopoverState,
	type Target,
} from "./popover-model.ts";
import { pad, padStart, spread, truncate, visibleWidth, wrap } from "./text.ts";
import type { Track } from "./youtube-source.ts";

// Renders popover state to terminal lines. Every line fits `width` columns.
// Each frame also lists where its clickable elements are (S23), in card cells.

export type Role = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text" | "border";

export interface ViewTheme {
	fg(role: Role, text: string): string;
	bold(text: string): string;
	/** Background for the row under the cursor. */
	selected(text: string): string;
}

/** Scroll offsets kept by the component between renders. */
export interface Scroll {
	left: number;
	right: number;
}

export interface ViewOptions {
	width: number;
	/** Maximum number of lines. */
	height: number;
	theme: ViewTheme;
	scroll?: Scroll;
	/** Id of the hit under the pointer, painted in the hover role. */
	hover?: string | null;
}

/** A clickable cell range: row `y` of the card (0 is the top border), columns `x` to `end` (exclusive). */
export interface Hit {
	id: string;
	x: number;
	end: number;
	y: number;
	target: Target;
}

/** Where a pane of the main view sits, for the wheel; rows `top` to `bottom` (exclusive). */
export interface PaneRegion {
	pane: "left" | "right";
	x: number;
	end: number;
	top: number;
	bottom: number;
}

export interface Frame {
	lines: string[];
	hits: Hit[];
	panes: PaneRegion[];
}

/** A hit inside one rendered line, columns relative to that line's text. */
type Span = { x: number; end: number; target: Target };
/** Hits and pane regions collected while a body renders, relative to the body text. */
interface Marks {
	hits: { y: number; span: Span }[];
	panes: PaneRegion[];
}

export const NARROW_WIDTH = 100;
export const LEFT_WIDTH = 24;
const MAX_BODY = 16;
const MIN_BODY = 3;
const MIN_BAR = 8;
const MIN_TEXT = 24;
// Key hints, longest first: n p and the seek keys give way before the rest (S23).
const TRACK_HINT = "n p track";
const SEEK_HINT = ", . ±5s";
const tiers = (head: string, tail: string) => [
	`${head} · ${TRACK_HINT} · ${SEEK_HINT} · ${tail}`,
	`${head} · ${SEEK_HINT} · ${tail}`,
	`${head} · ${tail}`,
];
const PLAYER_HINTS = tiers("tab pane · space ⏯", "esc");
const RELOAD_HINTS = tiers("tab pane · space ⏯", "r reload · esc");
const SEARCH_HINTS = ["enter search · esc"];
const RESULT_HINTS = tiers("enter play · a queue", "esc");
const ACCOUNT_HINTS = ["enter choose · esc back"];
const ACCOUNT_CHOICE_LABELS = { another: "Use another browser", disconnect: "Disconnect" } as const;
const DIALOG_LABELS: Record<DialogChoice, string> = {
	install: "Install",
	cancel: "Cancel",
	retry: "Retry",
	back: "Back",
	copy: "Copy command",
	check: "Check again",
};
const ACTION_LABELS: Record<NoticeAction, string> = {
	update: "Update yt-dlp",
	install: "Install yt-dlp",
	mpv: "How to install mpv",
};
const NO_SUDO = "Nothing is installed system-wide and no sudo is needed.";
const MPV_INTRO = "mpv plays the audio. Install it with your package manager:";
const UPDATING = "Updating yt-dlp…";
const RULE = "\u0000rule";

const CONNECT_INTRO = [
	"Use the YouTube session already open in your browser.",
	"Cookies are read by yt-dlp only, never copied or stored.",
];
const NO_BROWSER = "No supported browser found (Firefox, Zen, Chromium, Chrome, Brave, Helium).";
/** Columns before the body text: the border and one space of padding. */
const INSET = 2;

export function renderPopover(state: PopoverState, opts: ViewOptions): string[] {
	return renderFrame(state, opts).lines;
}

export function renderFrame(state: PopoverState, opts: ViewOptions): Frame {
	const { width, theme: t } = opts;
	if (width < 8) return { lines: [truncate("YouTube", Math.max(0, width))], hits: [], panes: [] };
	const inner = width - 4;
	const marks: Marks = { hits: [], panes: [] };
	const body = state.dialog
		? dialogBody(state, inner, t, marks)
		: state.screen === "dependencies"
			? dependenciesBody(state, inner, t, marks)
			: state.screen === "connect"
				? connectBody(state, inner, t, marks)
				: mainBody(state, inner, opts, marks);
	const edge = (l: string, r: string) => t.fg("border", `${l}${"─".repeat(width - 2)}${r}`);
	const side = t.fg("border", "│");
	const lines = [
		edge("╭", "╮"),
		...body.map((line) => (line === RULE ? edge("├", "┤") : `${side} ${pad(line, inner)} ${side}`)),
		edge("╰", "╯"),
	];
	const hits: Hit[] = [];
	for (const { y, span } of marks.hits) {
		const x = Math.max(0, span.x);
		const end = Math.min(inner, span.end);
		if (end > x && y < body.length) hits.push({ id: targetId(span.target), x: x + INSET, end: end + INSET, y: y + 1, target: span.target });
	}
	const panes = marks.panes.map((p) => ({ ...p, x: p.x + INSET, end: p.end + INSET, top: p.top + 1, bottom: p.bottom + 1 }));
	const hovered = opts.hover ? hits.find((h) => h.id === opts.hover) : undefined;
	if (hovered) lines[hovered.y] = paintCells(lines[hovered.y], hovered.x, hovered.end, (text) => t.fg("warning", text));
	return { lines, hits, panes };
}

export function targetId(target: Target): string {
	switch (target.type) {
		case "left":
			return `left:${target.key}`;
		case "notice":
			return `notice:${target.choice}`;
		case "control":
			return `control:${target.control}`;
		case "bar":
			return "bar";
		default:
			return `${target.type}:${target.index}`;
	}
}

/** The hit under cell (x, y), with where on it the cell falls (0 first cell, 1 last), or null. */
export function hitAt(frame: Pick<Frame, "hits">, x: number, y: number): { hit: Hit; ratio: number } | null {
	const hit = frame.hits.find((h) => h.y === y && x >= h.x && x < h.end);
	if (!hit) return null;
	const span = hit.end - hit.x - 1;
	return { hit, ratio: span > 0 ? (x - hit.x) / span : 0 };
}

/** The main-view pane under cell (x, y), or null. */
export function paneAt(frame: Pick<Frame, "panes">, x: number, y: number): "left" | "right" | null {
	return frame.panes.find((p) => y >= p.top && y < p.bottom && x >= p.x && x < p.end)?.pane ?? null;
}

const ESCAPE = /^(?:\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/;
const graphemes = new Intl.Segmenter();

/**
 * Repaint columns x to end of `line` with `paint` over their plain text; the styles in force
 * are replayed after it, so the rest of the line keeps its colors.
 */
function paintCells(line: string, x: number, end: number, paint: (text: string) => string): string {
	let before = "";
	let cells = "";
	let after = "";
	let replay = "";
	let col = 0;
	let rest = line;
	while (rest) {
		const escape = ESCAPE.exec(rest);
		if (escape) {
			if (col < end) replay += escape[0];
			if (col < x) before += escape[0];
			else if (col >= end) after += escape[0];
			rest = rest.slice(escape[0].length);
			continue;
		}
		const next = rest.search(/\x1b/);
		const chunk = next < 0 ? rest : rest.slice(0, next || 1);
		for (const { segment } of graphemes.segment(chunk)) {
			if (col < x) before += segment;
			else if (col < end) cells += segment;
			else after += segment;
			col += visibleWidth(segment);
		}
		rest = rest.slice(chunk.length);
	}
	return `${before}${paint(cells)}${replay}${after}`;
}

/** Note a hit on body line `y`. */
const mark = (marks: Marks, y: number, x: number, end: number, target: Target) => marks.hits.push({ y, span: { x, end, target } });

function titleRow(state: PopoverState, inner: number, t: ViewTheme): string {
	let right: string;
	if (state.screen === "dependencies") right = t.fg("dim", "Dependencies");
	else if (state.screen === "connect") right = t.fg("dim", "not connected");
	else if (state.account) right = `${browserLabel(state.account.browser)} ${t.fg("success", "✓")}`;
	else right = t.fg("dim", "no account");
	return spread(t.bold(t.fg("accent", "YouTube")), right, inner);
}

function optionRow(label: string, cursor: boolean, inner: number, t: ViewTheme): string {
	const line = pad(`${cursor ? t.fg("accent", "▸ ") : "  "}${label}`, inner);
	return cursor ? t.selected(line) : line;
}

function connectBody(state: PopoverState, inner: number, t: ViewTheme, marks: Marks): string[] {
	const { connect } = state;
	const lines = [titleRow(state, inner, t), RULE, ""];
	for (const text of CONNECT_INTRO) lines.push(...wrap(text, inner));
	lines.push("");

	if (connect.phase === "error" && connect.error) {
		lines.push(...wrap(connect.error.message, inner).map((l) => t.fg("error", l)));
		lines.push(...wrap(connect.error.hint, inner).map((l) => t.fg("dim", l)));
		lines.push("");
	} else if (state.browsers.length === 0) {
		lines.push(...wrap(NO_BROWSER, inner).map((l) => t.fg("warning", l)), "");
	}

	const options = connectOptions(state);
	options.forEach((option, i) => {
		const cursor = i === connect.cursor;
		let label: string;
		switch (option.type) {
			case "browser": {
				const target = state.browsers.indexOf(option.browser) === connect.target;
				const checking = connect.phase === "verifying" && target ? `  ${t.fg("dim", "checking…")}` : "";
				// Long profile names give way first so checking… stays visible.
				const nameW = Math.max(0, inner - 2 - 12 - visibleWidth(checking));
				const name = truncate(sanitize(option.browser.profileName), nameW);
				label = `${pad(option.browser.label, 12)}${t.fg("dim", name)}${checking}`;
				break;
			}
			case "anonymous":
				label = "Continue without an account";
				break;
			case "retry":
				label = "Retry";
				break;
			case "another":
				label = "Use another browser";
				break;
		}
		if (connect.phase !== "verifying") mark(marks, lines.length, 0, inner, { type: "connect", index: i });
		lines.push(optionRow(label, cursor, inner, t));
	});

	// Dependencies (S19) guarantees both tools here; a tool removed later is offered by the notices.

	pushNotice(lines, noticeRow(state, t, inner), marks);

	const footer =
		connect.phase === "verifying" ? "esc close" : connect.phase === "error" ? "enter select · esc close" : "enter connect · esc close";
	lines.push(RULE, t.fg("dim", footer));
	return lines;
}

/** Dependencies (S19): one row per tool, a missing one with its action on the right, then Check again. */
function dependenciesBody(state: PopoverState, inner: number, t: ViewTheme, marks: Marks): string[] {
	const deps = state.deps;
	const options = dependencyOptions(state);
	const selected = options[state.gate.cursor];
	const tool = (name: string, purpose: string, found: boolean, option: DependencyOption, right: string) => {
		const cursor = !found && selected === option;
		const mark = found ? t.fg("success", "✓") : t.fg("error", "✗");
		const line = spread(`${cursor ? t.fg("accent", "▸ ") : "  "}${mark} ${pad(name, 9)}${purpose}`, right, inner);
		return cursor ? t.selected(line) : line;
	};
	const lines = [titleRow(state, inner, t), RULE, ""];
	const option = (name: DependencyOption) => {
		const index = options.indexOf(name);
		if (index >= 0) mark(marks, lines.length, 0, inner, { type: "dependency", index });
	};
	const ytDlp = deps?.ytDlp ?? null;
	option("install");
	lines.push(tool("yt-dlp", "reads YouTube", ytDlp !== null, "install", ytDlp ? t.fg("dim", `(${ytDlp})`) : t.fg("accent", ACTION_LABELS.install)));
	const mpv = deps?.mpv ?? false;
	option("mpvHelp");
	lines.push(tool("mpv", "plays the audio", mpv, "mpvHelp", mpv ? "" : t.fg("accent", ACTION_LABELS.mpv)));
	lines.push("");
	option("check");
	lines.push(optionRow(DIALOG_LABELS.check, selected === "check", inner, t));
	pushNotice(lines, noticeRow(state, t, inner), marks);
	lines.push(RULE, t.fg("dim", "enter choose · esc close"));
	return lines;
}

type Row = { line: string; spans: Span[] };

/**
 * The notice line (`Updating yt-dlp…` while an update runs) with its action hits, or null.
 * A transient notice takes the row; the update offer (S25) is drawn when none is shown.
 */
function noticeRow(state: PopoverState, t: ViewTheme, inner: number): Row | null {
	if (state.updating) return { line: t.fg("dim", UPDATING), spans: [] };
	if (offerShown(state)) return offerRow(state.offer!, t, inner);
	const notice = state.notice;
	if (!notice) return null;
	const message = t.fg(notice.tone === "info" ? "text" : (notice.tone ?? "error"), sanitize(notice.message));
	if (notice.action) {
		const action = `▸ ${ACTION_LABELS[notice.action]}`;
		const x = visibleWidth(message) + 2;
		const spans: Span[] = [{ x, end: x + visibleWidth(action), target: { type: "notice", choice: "action" } }];
		return { line: `${message}  ${t.fg("accent", action)}`, spans };
	}
	return { line: notice.hint ? `${message}  ${t.fg("dim", sanitize(notice.hint))}` : message, spans: [] };
}

const OFFER_UPDATE = "▸ Update (u)";
const OFFER_LATER = "Later (l)";

/** `yt-dlp <latest> available  ▸ Update (u) · Later (l)`; the message gives way before the actions. */
function offerRow(latest: string, t: ViewTheme, inner: number): Row {
	const actionsW = visibleWidth(OFFER_UPDATE) + 3 + visibleWidth(OFFER_LATER);
	const message = truncate(`yt-dlp ${sanitize(latest)} available`, Math.max(0, inner - actionsW - 2));
	const x = visibleWidth(message) + 2;
	const later = x + visibleWidth(OFFER_UPDATE) + 3;
	return {
		line: `${t.fg("text", message)}  ${t.fg("accent", OFFER_UPDATE)} ${t.fg("dim", "·")} ${t.fg("muted", OFFER_LATER)}`,
		spans: [
			{ x, end: x + visibleWidth(OFFER_UPDATE), target: { type: "notice", choice: "action" } },
			{ x: later, end: later + visibleWidth(OFFER_LATER), target: { type: "notice", choice: "later" } },
		],
	};
}

/** A blank line and the notice, with its hits. */
function pushNotice(lines: string[], row: Row | null, marks: Marks) {
	if (!row) return;
	lines.push("");
	for (const span of row.spans) mark(marks, lines.length, span.x, span.end, span.target);
	lines.push(row.line);
}

const MB = 1_000_000;
const mb = (bytes: number) => (bytes / MB).toFixed(1);

function downloadRow(received: number, total: number | null, inner: number, t: ViewTheme): string {
	const label = "Downloading yt-dlp";
	if (total === null) return `${label}  ${mb(received)} MB`;
	const count = `${mb(received)}/${mb(total)} MB`;
	const barW = Math.min(30, inner - visibleWidth(label) - visibleWidth(count) - 4);
	if (barW < MIN_BAR) return `${label}  ${count}`;
	const filled = Math.round(barW * Math.max(0, Math.min(1, received / total)));
	const bar = `${t.fg("accent", "━".repeat(filled))}${t.fg("dim", "━".repeat(barW - filled))}`;
	return `${label}  ${bar}  ${count}`;
}

/** Install yt-dlp and How to install mpv, drawn instead of the current screen. */
function dialogBody(state: PopoverState, inner: number, t: ViewTheme, marks: Marks): string[] {
	const dialog = state.dialog!;
	const lines = [titleRow(state, inner, t), RULE, ""];
	let footer = "enter choose · esc back";
	switch (dialog.type) {
		case "confirm": {
			const info = state.setup?.ytDlp;
			lines.push(t.bold("Install yt-dlp"), "");
			if (info) {
				lines.push(`Version   ${info.version} (official release)`, `From      ${YT_DLP_SOURCE}`);
				if (info.size !== null) lines.push(`Size      ~${Math.round(info.size / MB)} MB`);
				lines.push(`Into      ${sanitize(info.dir)}`, `License   ${YT_DLP_LICENSE}`, "");
			}
			lines.push(...wrap(NO_SUDO, inner), "");
			footer = "enter choose · esc cancel";
			break;
		}
		case "download":
			lines.push(dialog.verifying ? "Verifying…" : downloadRow(dialog.received, dialog.total, inner, t));
			lines.push(RULE, t.fg("dim", "esc cancel"));
			return lines;
		case "failed":
			lines.push(...wrap(sanitize(dialog.error.message), inner).map((l) => t.fg("error", l)));
			lines.push(...wrap(sanitize(dialog.error.hint), inner).map((l) => t.fg("dim", l)), "");
			break;
		case "mpv": {
			const mpv = mpvSetup(state);
			lines.push(...wrap(MPV_INTRO, inner), "");
			if (mpv.command) lines.push(t.fg("accent", truncate(`  ${mpv.command}`, inner)));
			else lines.push(...wrap(mpv.text, inner));
			lines.push("");
			break;
		}
	}
	dialogChoices(state).forEach((choice, i) => {
		mark(marks, lines.length, 0, inner, { type: "dialog", index: i });
		lines.push(optionRow(DIALOG_LABELS[choice], i === dialog.cursor, inner, t));
	});
	pushNotice(lines, noticeRow(state, t, inner), marks);
	lines.push(RULE, t.fg("dim", footer));
	return lines;
}

function mainBody(state: PopoverState, inner: number, opts: ViewOptions, marks: Marks): string[] {
	const t = opts.theme;
	const scroll = opts.scroll ?? { left: 0, right: 0 };
	const row = noticeRow(state, t, inner);
	// top + title + rule + panes + rule + notice + player + bottom
	const fixed = 6 + (row ? 1 : 0);
	const h = Math.max(MIN_BODY, Math.min(MAX_BODY, opts.height - fixed));
	const top = 2;
	/** Note a pane's region and the hits of its visible lines, `x` columns from the body's left edge. */
	const place = (pane: "left" | "right", x: number, w: number, spans: Span[][]) => {
		marks.panes.push({ pane, x, end: x + w, top, bottom: top + h });
		spans.slice(0, h).forEach((line, i) => line.forEach((s) => mark(marks, top + i, x + s.x, x + Math.min(w, s.end), s.target)));
	};

	let panes: string[];
	if (opts.width < NARROW_WIDTH) {
		const pane = state.focus === "left" ? leftPane(state, inner, h, t, scroll) : rightPane(state, inner, h, t, scroll);
		place(state.focus, 0, inner, pane.spans);
		panes = Array.from({ length: h }, (_, i) => pane.lines[i] ?? "");
	} else {
		const rw = inner - LEFT_WIDTH - 3;
		const left = leftPane(state, LEFT_WIDTH, h, t, scroll);
		const right = rightPane(state, rw, h, t, scroll);
		place("left", 0, LEFT_WIDTH, left.spans);
		place("right", LEFT_WIDTH + 3, rw, right.spans);
		const rule = t.fg("border", "│");
		panes = Array.from({ length: h }, (_, i) => `${pad(left.lines[i] ?? "", LEFT_WIDTH)} ${rule} ${pad(right.lines[i] ?? "", rw)}`);
	}
	const lines = [titleRow(state, inner, t), RULE, ...panes, RULE];
	if (row) {
		for (const span of row.spans) mark(marks, lines.length, span.x, span.end, span.target);
		lines.push(row.line);
	}
	const player = playerRow(state, inner, t);
	for (const span of player.spans) mark(marks, lines.length, span.x, span.end, span.target);
	lines.push(player.line);
	return lines;
}

/** Lines of a pane with the hits on each. */
type PaneLines = { lines: string[]; spans: Span[][] };

/** Slice `lines` to `h` rows keeping `sel` visible, remembering the offset in `scroll[key]`. */
function windowed(lines: string[], sel: number, h: number, scroll: Scroll, key: keyof Scroll): string[] {
	if (lines.length <= h) {
		scroll[key] = 0;
		return lines;
	}
	let off = scroll[key];
	if (sel >= 0) {
		if (sel < off) off = sel;
		if (sel >= off + h) off = sel - h + 1;
	}
	off = Math.max(0, Math.min(lines.length - h, off));
	scroll[key] = off;
	return lines.slice(off, off + h);
}

function leftLabel(row: Extract<LeftRow, { key: string }>): string {
	if (row.type === "playlists") return `${row.open ? "▾" : "▸"} ${row.label}`;
	if (row.key === "search") return `› ${row.label}`;
	if (row.type === "account") return row.label;
	return row.indent ? `  ${sanitize(row.label)}` : row.label;
}

function leftPane(state: PopoverState, w: number, h: number, t: ViewTheme, scroll: Scroll): PaneLines {
	const active = state.source ? sourceKey(state.source) : null;
	const anonymous = !hasAccount(state);
	let sel = -1;
	const rows = leftRows(state);
	const lines = rows.map((row, i) => {
		if (row.type === "rule") return t.fg("border", "─".repeat(w));
		if (row.type === "note") return t.fg(row.tone, truncate(`  ${sanitize(row.text)}`, w));
		const cursor = state.focus === "left" && row.key === state.leftKey;
		if (cursor) sel = i;
		const text = leftLabel(row);
		const label = row.accountOnly && anonymous ? t.fg("dim", text) : row.key === active ? t.fg("accent", text) : text;
		const count = row.count === null ? "" : t.fg("dim", String(row.count));
		const line = spread(`${cursor ? t.fg("accent", "▸ ") : "  "}${label}`, count, w);
		return cursor ? t.selected(line) : line;
	});
	const visible = windowed(lines, sel, h, scroll, "left");
	const spans = visible.map((_, i): Span[] => {
		const row = rows[scroll.left + i];
		if (!row || !("key" in row)) return [];
		const { key } = row;
		return [{ x: 0, end: w, target: { type: "left", key } }];
	});
	return { lines: visible, spans };
}

function currentTrackId(state: PopoverState): string | undefined {
	const p = state.player;
	if (!p || !p.running || p.idle || p.position < 0) return undefined;
	return p.queue[p.position]?.id;
}

function accountPane(state: PopoverState, w: number, t: ViewTheme): PaneLines {
	const focused = state.focus === "right";
	const rows = ACCOUNT_CHOICES.map((choice, i) => optionRow(ACCOUNT_CHOICE_LABELS[choice], focused && i === state.accountMenu, w, t));
	const spans = ACCOUNT_CHOICES.map((_, index): Span[] => [{ x: 0, end: w, target: { type: "account", index } }]);
	return { lines: [truncate(t.bold(accountLabel(state)), w), "", ...rows], spans: [[], [], ...spans] };
}

function rightPane(state: PopoverState, w: number, h: number, t: ViewTheme, scroll: Scroll): PaneLines {
	if (state.accountMenu !== null) {
		const pane = accountPane(state, w, t);
		return { lines: pane.lines.slice(0, h), spans: pane.spans };
	}
	const { source, list } = state;
	if (!source) return { lines: [t.fg("dim", "Pick a source on the left.")], spans: [] };
	const focused = state.focus === "right";
	const searching = source.kind === "search";

	let header: string;
	const headerSpans: Span[] = [];
	if (searching) {
		const cursor = focused && state.rightIndex === 0 ? t.fg("accent", "█") : "";
		header = spread(`› ${sanitize(state.query)}${cursor}`, t.fg("dim", "enter search"), w);
		headerSpans.push({ x: 0, end: w, target: { type: "right", index: 0 } });
	} else {
		const count = list.status === "ready" ? t.fg("dim", ` · ${list.tracks.length}`) : "";
		const labels = list.tracks.length === 0 ? [] : ["▶ Play all", "⤮ Shuffle"];
		const actions = labels
			.map((a, i) => (focused && state.rightIndex === i ? t.selected(t.fg("accent", `▸ ${a}`)) : t.fg("muted", `  ${a}`)))
			.join(" ");
		header = spread(`${t.bold(sanitize(sourceLabel(source)))}${count}`, actions, w);
		// The actions sit right-aligned: `  ▶ Play all ⤮ Shuffle`, each after its two-column marker.
		let x = w - visibleWidth(actions);
		labels.forEach((label, index) => {
			headerSpans.push({ x: x + 2, end: x + 2 + visibleWidth(label), target: { type: "right", index } });
			x += 2 + visibleWidth(label) + 1;
		});
	}

	const rows = h - 1;
	let content: string[];
	let spans: Span[][] = [];
	if (list.status === "loading") content = [t.fg("dim", "Loading…")];
	else if (list.status === "error" && list.error)
		content = [
			...wrap(sanitize(list.error.message), w).map((l) => t.fg("error", l)),
			...wrap(sanitize(list.error.hint), w).map((l) => t.fg("dim", l)),
		];
	else if (list.status === "idle") content = searching ? [t.fg("dim", "Type to search YouTube.")] : [];
	else if (list.tracks.length === 0) content = [t.fg("dim", "Nothing here.")];
	else {
		const onMore = focused && state.rightIndex === loadMoreIndex(state);
		const sel = focused ? selectedTrack(state) : -1;
		const lines = trackRows(list.tracks, w, sel, currentTrackId(state), t);
		if (list.more !== null) lines.push(t.fg("dim", "  Loading more…"));
		else if (hasLoadMore(state)) lines.push(onMore ? optionRow(t.fg("dim", "Load more"), true, w, t) : t.fg("dim", "  Load more"));
		const keep = onMore ? lines.length - 1 : sel >= 0 ? sel : state.rightIndex < trackOffset(state) ? 0 : -1;
		content = windowed(lines, keep, rows, scroll, "right");
		const more = list.more === null && hasLoadMore(state);
		spans = content.map((_, i): Span[] => {
			const at = scroll.right + i;
			if (at < list.tracks.length) return [{ x: 0, end: w, target: { type: "right", index: trackOffset(state) + at } }];
			return more && at === list.tracks.length ? [{ x: 0, end: w, target: { type: "right", index: loadMoreIndex(state) } }] : [];
		});
	}
	return { lines: [header, ...content.slice(0, rows)], spans: [headerSpans, ...spans.slice(0, rows)] };
}

function trackRows(tracks: Track[], w: number, sel: number, current: string | undefined, t: ViewTheme): string[] {
	const numW = Math.max(2, String(tracks.length).length);
	const durations = tracks.map((tr) => (tr.duration === null ? "" : formatTime(tr.duration)));
	const durW = Math.max(4, ...durations.map((d) => d.length));
	const rest = Math.max(0, w - 2 - numW - 2 - 2 - durW);
	const longestArtist = Math.max(0, ...tracks.map((tr) => visibleWidth(sanitize(tr.artist))));
	const artistW = Math.min(24, longestArtist, Math.floor(rest * 0.35));
	const titleW = Math.max(0, rest - (artistW ? artistW + 2 : 0));
	return tracks.map((tr, i) => {
		const playing = tr.id === current;
		const num = playing ? `${" ".repeat(numW - 1)}${t.fg("accent", "♪")}` : padStart(String(i + 1), numW);
		const title = pad(sanitize(tr.title), titleW);
		const artist = artistW ? `  ${t.fg("dim", pad(sanitize(tr.artist), artistW))}` : "";
		const line = `${i === sel ? t.fg("accent", "▸ ") : "  "}${num}  ${playing ? t.fg("accent", title) : title}${artist}  ${padStart(durations[i], durW)}`;
		return i === sel ? t.selected(line) : line;
	});
}

/** The key hints for the focus, longest first. */
function hintsFor(state: PopoverState): string[] {
	if (state.accountMenu !== null && state.focus === "right") return ACCOUNT_HINTS;
	if (state.focus !== "right" || state.source?.kind === "queue") return PLAYER_HINTS;
	if (state.source?.kind !== "search") return RELOAD_HINTS;
	return state.rightIndex === 0 ? SEARCH_HINTS : RESULT_HINTS;
}

/** The longest hints that fit in `room` columns, or "". */
const fitHints = (hints: string[], room: number) => hints.find((h) => visibleWidth(h) <= room) ?? "";

/** ⏮ ⏸/▶ ⏭ at the start of the player row, each one clickable; the middle one shows the state. */
const CONTROLS = ["prev", "toggle", "next"] as const;

function playerRow(state: PopoverState, inner: number, t: ViewTheme): Row {
	const tiers = hintsFor(state);
	const p = state.player;
	const title = sanitize(p?.title);
	// A picked track that is still resolving: the old song is already stopped, so say what is coming.
	if (p?.resolving && title) {
		const label = t.fg("dim", "Loading…");
		const hints = fitHints(tiers, inner - (2 + visibleWidth("Loading…") + 2 + 2) - 12);
		const tail = `${label}${hints ? `  ${t.fg("dim", hints)}` : ""}`;
		const room = Math.max(0, inner - 2 - visibleWidth(tail) - 2);
		const artist = sanitize(p.artist);
		const who = artist && room > visibleWidth(title) + 4 ? `${title}  ${t.fg("dim", truncate(artist, room - visibleWidth(title) - 2))}` : truncate(title, room);
		return { line: spread(`${t.fg("accent", "◌")} ${who}`, tail, inner), spans: [] };
	}
	if (!p || !p.running || p.idle || !title) {
		const idle = "■ Nothing playing";
		const hints = fitHints(tiers, inner - visibleWidth(idle) - 2) || tiers[tiers.length - 1];
		return { line: spread(t.fg("dim", idle), t.fg("dim", hints), inner), spans: [] };
	}

	const time = p.duration === null ? formatTime(p.elapsed) : `${formatTime(p.elapsed)}/${formatTime(p.duration)}`;
	const status = `${time}  ⤮ ${p.shuffle ? "on" : "off"}  vol ${Math.round(p.volume)}%`;
	const lead = `⏮ ${p.paused ? "⏸" : "▶"} ⏭`;
	const spans: Span[] = CONTROLS.map((control, i) => ({ x: i * 2, end: i * 2 + 1, target: { type: "control", control } }));
	const leadW = visibleWidth(lead) + 1;
	// Hints give way first (n p and seek before the rest), so the title and a bar keep room; then the bar, then the title.
	const fixed = leadW + visibleWidth(status) + 2 + 2;
	const hints = fitHints(tiers, inner - fixed - (MIN_TEXT + 2 + MIN_BAR)) || fitHints(tiers, inner - fixed - 12);
	const tail = `${status}${hints ? `  ${t.fg("dim", hints)}` : ""}`;
	const avail = Math.max(0, inner - leadW - visibleWidth(tail) - 2);

	const artist = sanitize(p.artist);
	const natural = visibleWidth(title) + (artist ? 2 + visibleWidth(artist) : 0);
	let textW = Math.min(natural, Math.max(MIN_TEXT, Math.floor(avail * 0.5)), avail);
	let barW = avail - textW - 2;
	if (barW < MIN_BAR) {
		barW = 0;
		textW = Math.min(natural, avail);
	}
	let artistW = artist ? Math.min(visibleWidth(artist), Math.floor(textW * 0.4)) : 0;
	if (artistW < 3) artistW = 0;
	const titleW = Math.max(0, textW - (artistW ? artistW + 2 : 0));
	const text = `${truncate(title, titleW)}${artistW ? `  ${t.fg("dim", truncate(artist, artistW))}` : ""}`;

	let bar = "";
	if (barW > 0) {
		const ratio = p.duration ? Math.max(0, Math.min(1, p.elapsed / p.duration)) : 0;
		const filled = Math.round(barW * ratio);
		bar = `${t.fg("accent", "━".repeat(filled))}${t.fg("dim", "━".repeat(barW - filled))}`;
	}
	const left = `${lead} ${text}`;
	if (bar) {
		const x = visibleWidth(left) + 2;
		spans.push({ x, end: x + barW, target: { type: "bar" } });
	}
	const gap = Math.max(1, inner - visibleWidth(left) - (bar ? barW + 2 : 0) - visibleWidth(tail));
	return { line: truncate(`${left}${bar ? `  ${bar}` : ""}${" ".repeat(gap)}${tail}`, inner), spans };
}
