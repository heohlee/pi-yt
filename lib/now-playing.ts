export type PlayerStatus = "playing" | "paused" | "idle" | "signin";

export interface NowPlayingState {
	status: PlayerStatus;
	title?: string | null;
	artist?: string | null;
	elapsed?: number | null;
	duration?: number | null;
}

const SEP = " · ";

/** Replace control characters with spaces, collapse runs of spaces, trim. */
export function sanitize(text: string | null | undefined): string {
	if (typeof text !== "string") return "";
	return text
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function validSeconds(seconds: number | null | undefined): number | undefined {
	return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : undefined;
}

/** m:ss, or h:mm:ss from one hour on. Negative or NaN becomes 0:00. */
export function formatTime(seconds: number | null | undefined): string {
	const total = Math.max(0, Math.floor(validSeconds(seconds) ?? 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The single sidebar status line, or undefined when it should be cleared. */
export function formatNowPlaying(state: NowPlayingState): string | undefined {
	if (state.status === "signin") return `youtube${SEP}sign in again${SEP}/yt`;
	if (state.status === "idle") return undefined;

	const glyph = state.status === "paused" ? "⏸" : "♪";
	const title = sanitize(state.title) || "YouTube";
	const artist = sanitize(state.artist);
	const duration = validSeconds(state.duration);
	const time =
		duration === undefined ? formatTime(state.elapsed) : `${formatTime(state.elapsed)}/${formatTime(duration)}`;

	const parts = [`${glyph} ${title}`];
	if (artist) parts.push(artist);
	parts.push(time);
	return parts.join(SEP);
}
