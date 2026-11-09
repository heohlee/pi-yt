import net from "node:net";
import os from "node:os";
import path from "node:path";
import { formatNowPlaying, formatTime, type NowPlayingState } from "./now-playing.ts";

export const RETRY_MS = 5000;
export const TICK_MS = 5000;

const OBSERVED = ["pause", "media-title", "metadata", "time-pos", "duration", "idle-active"] as const;
const ARTIST_KEYS = ["artist", "ARTIST", "uploader", "channel"];

export interface MpvStatusDeps {
	socketPath: string;
	/** Receives the formatted line, or undefined to clear it. */
	setStatus: (text: string | undefined) => void;
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

export interface MpvStatusHandle {
	stop(): void;
}

export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_YT_MPV_SOCKET;
	if (override) return override;
	return path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), "pi-yt", "mpv.sock");
}

function artistFrom(metadata: unknown): string | undefined {
	if (!metadata || typeof metadata !== "object") return undefined;
	const record = metadata as Record<string, unknown>;
	for (const key of ARTIST_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

interface PlayerProps {
	pause: boolean;
	title: string | null;
	artist: string | undefined;
	timePos: number | null;
	duration: number | null;
	idle: boolean;
}

const emptyProps = (): PlayerProps => ({
	pause: false,
	title: null,
	artist: undefined,
	timePos: null,
	duration: null,
	idle: true,
});

function toState(p: PlayerProps): NowPlayingState {
	if (p.idle || p.title === null) return { status: "idle" };
	return {
		status: p.pause ? "paused" : "playing",
		title: p.title,
		artist: p.artist,
		elapsed: p.timePos,
		duration: p.duration,
	};
}

/**
 * Connect to mpv's JSON IPC socket and publish one now-playing line.
 * Never throws; reconnects every RETRY_MS while mpv is unavailable.
 */
export function startMpvStatus(deps: MpvStatusDeps): MpvStatusHandle {
	const now = deps.now ?? Date.now;
	const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

	let props = emptyProps();
	let socket: net.Socket | undefined;
	let retryTimer: unknown;
	let tickTimer: unknown;
	let stopped = false;
	let published = false;
	let lastText: string | undefined;
	let lastShape: string | undefined;
	let lastPublishAt = 0;

	const cancelTick = () => {
		if (tickTimer !== undefined) cancel(tickTimer);
		tickTimer = undefined;
	};

	const publish = (text: string | undefined) => {
		if (published && text === lastText) return;
		cancelTick();
		published = true;
		lastText = text;
		lastPublishAt = now();
		try {
			deps.setStatus(text);
		} catch {
			// Status is cosmetic.
		}
	};

	const update = () => {
		const state = toState(props);
		const text = formatNowPlaying(state);
		// Everything except elapsed time: a change here publishes immediately.
		const shape = JSON.stringify([text === undefined, state.status, state.title, state.artist, formatTime(state.duration)]);
		if (shape !== lastShape) {
			lastShape = shape;
			publish(text);
		} else if (text !== lastText) {
			const wait = lastPublishAt + TICK_MS - now();
			if (wait <= 0) publish(text);
			// No later event may come (paused seek), so a held-back tick is published when the window ends.
			else if (tickTimer === undefined) {
				tickTimer = schedule(() => {
					tickTimer = undefined;
					update();
				}, wait);
			}
		}
	};

	const onEvent = (msg: { event?: string; name?: string; data?: unknown }) => {
		if (msg.event !== "property-change") return;
		const { data } = msg;
		switch (msg.name) {
			case "pause":
				props.pause = data === true;
				break;
			case "media-title":
				props.title = typeof data === "string" ? data : null;
				break;
			case "metadata":
				props.artist = artistFrom(data);
				break;
			case "time-pos":
				props.timePos = typeof data === "number" ? data : null;
				break;
			case "duration":
				props.duration = typeof data === "number" ? data : null;
				break;
			case "idle-active":
				props.idle = data === true;
				break;
			default:
				return;
		}
		update();
	};

	const scheduleRetry = () => {
		if (stopped || retryTimer !== undefined) return;
		retryTimer = schedule(() => {
			retryTimer = undefined;
			connect();
		}, RETRY_MS);
	};

	const disconnected = (sock: net.Socket) => {
		if (socket !== sock) return;
		socket = undefined;
		sock.destroy();
		cancelTick();
		props = emptyProps();
		lastShape = undefined;
		publish(undefined);
		scheduleRetry();
	};

	function connect() {
		if (stopped) return;
		let sock: net.Socket;
		try {
			sock = net.createConnection(deps.socketPath);
		} catch {
			publish(undefined);
			scheduleRetry();
			return;
		}
		socket = sock;
		let buffer = "";
		sock.setEncoding("utf8");
		sock.on("connect", () => {
			OBSERVED.forEach((name, i) => {
				sock.write(`${JSON.stringify({ command: ["observe_property", i + 1, name] })}\n`);
			});
		});
		sock.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				try {
					onEvent(JSON.parse(line));
				} catch {
					// Ignore malformed lines.
				}
			}
		});
		sock.on("error", () => disconnected(sock));
		sock.on("close", () => disconnected(sock));
	}

	connect();

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			if (retryTimer !== undefined) cancel(retryTimer);
			retryTimer = undefined;
			cancelTick();
			const sock = socket;
			socket = undefined;
			sock?.destroy();
			publish(undefined);
		},
	};
}
