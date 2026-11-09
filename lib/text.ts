// Column math for terminal lines that may carry ANSI escape sequences.
// Kept free of host packages so the view stays testable with plain node.

const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const ANSI_START = /^(?:\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/;
const segmenter = new Intl.Segmenter();

export const ELLIPSIS = "…";

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

function graphemeWidth(g: string): number {
	const cp = g.codePointAt(0) ?? 0;
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (/^[\p{M}\u200b-\u200f\u2060\ufeff]+$/u.test(g)) return 0;
	if (/\p{Emoji_Presentation}/u.test(g) || (g.includes("\ufe0f") && /\p{Extended_Pictographic}/u.test(g))) return 2;
	return isWide(cp) ? 2 : 1;
}

/** Visible terminal columns, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const { segment } of segmenter.segment(stripAnsi(text))) width += graphemeWidth(segment);
	return width;
}

/** Cut to at most `width` columns, ending in "…" when cut. Escape sequences are kept. */
export function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const budget = width - visibleWidth(ELLIPSIS);
	let out = "";
	let used = 0;
	let styled = false;
	let rest = text;
	while (rest) {
		const escape = ANSI_START.exec(rest);
		if (escape) {
			out += escape[0];
			styled = true;
			rest = rest.slice(escape[0].length);
			continue;
		}
		const next = rest.search(/\x1b/);
		const chunk = next < 0 ? rest : rest.slice(0, next || 1);
		let consumed = 0;
		for (const { segment } of segmenter.segment(chunk)) {
			const w = graphemeWidth(segment);
			if (used + w > budget) return `${out}${ELLIPSIS}${styled ? "\x1b[0m" : ""}`;
			out += segment;
			used += w;
			consumed += segment.length;
		}
		rest = rest.slice(consumed);
	}
	return out;
}

/** Truncate, then pad with spaces on the right to exactly `width` columns. */
export function pad(text: string, width: number): string {
	const cut = truncate(text, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** Pad with spaces on the left to exactly `width` columns. */
export function padStart(text: string, width: number): string {
	const cut = truncate(text, width);
	return " ".repeat(Math.max(0, width - visibleWidth(cut))) + cut;
}

/** `left` and `right` on one line of `width` columns; `left` gives way first. */
export function spread(left: string, right: string, width: number): string {
	const rightCut = truncate(right, width);
	const rightWidth = visibleWidth(rightCut);
	if (!rightWidth) return pad(left, width);
	const room = width - rightWidth - 1;
	if (room <= 0) return padStart(rightCut, width);
	const leftCut = truncate(left, room);
	return leftCut + " ".repeat(width - visibleWidth(leftCut) - rightWidth) + rightCut;
}

/** Word-wrap plain text to `width` columns; long words are truncated. */
export function wrap(text: string, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const candidate = line ? `${line} ${word}` : word;
		if (visibleWidth(candidate) <= width) {
			line = candidate;
			continue;
		}
		if (line) lines.push(line);
		line = truncate(word, width);
	}
	if (line) lines.push(line);
	return lines;
}
