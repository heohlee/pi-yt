import { spawn as nodeSpawn } from "node:child_process";
import { mkdir as fsMkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { resolveSocketPath } from "./mpv-status.ts";
import type { ResolveResult } from "./resolver.ts";

export const START_TIMEOUT_MS = 5000;
export const START_POLL_MS = 100;
export const COMMAND_TIMEOUT_MS = 2000;
export const QUIT_GRACE_MS = 1000;
export const TICK_MS = 1000;
/** YouTube stream URLs expire after a few hours; older ones are resolved again. */
export const STREAM_TTL_MS = 2 * 60 * 60 * 1000;
/** How many tracks after the current one get a ready stream URL. */
export const PREFETCH_AHEAD = 2;

const OBSERVED = [
	"pause",
	"time-pos",
	"duration",
	"media-title",
	"playlist-pos",
	"volume",
	"idle-active",
	"playlist",
] as const;

export interface Track {
	id: string;
	title: string;
	artist: string | null;
	duration: number | null;
	url: string;
}

export interface PlayerError {
	kind: string;
	message: string;
	hint: string;
}

export interface PlayerState {
	running: boolean;
	idle: boolean;
	paused: boolean;
	title: string | null;
	artist: string | null;
	elapsed: number;
	duration: number | null;
	volume: number;
	shuffle: boolean;
	/** Index into queue, or -1 when nothing is selected. */
	position: number;
	queue: Track[];
	/** True while the first track of play() is being resolved, before mpv gets it. */
	resolving: boolean;
}

export interface ChildLike {
	on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface PlayerDeps {
	/** Defaults to the status-line socket so the sidebar sees the same mpv. */
	socketPath?: string;
	spawn?: (command: string, args: string[], options: { detached: false; stdio: "ignore" }) => ChildLike;
	connect?: (socketPath: string) => net.Socket;
	/** Browser spec for yt-dlp (`firefox` or `firefox:profile`), or undefined for no account. */
	cookieArg?: () => string | undefined;
	/** The yt-dlp /yt resolved (system or managed), for mpv's ytdl hook; read when mpv starts. */
	ytDlpPath?: () => string | undefined;
	mkdir?: (dir: string, options: { recursive: true; mode: number }) => Promise<unknown>;
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	/** Resolves a track's audio stream URL; without it every entry goes through mpv's ytdl hook. */
	resolver?: (track: Track, options: { signal: AbortSignal }) => Promise<ResolveResult>;
}

export interface Player {
	ensureRunning(): Promise<void>;
	play(tracks: Track[], startIndex?: number): Promise<void>;
	enqueue(track: Track): Promise<void>;
	togglePause(): Promise<void>;
	next(): Promise<void>;
	prev(): Promise<void>;
	setShuffle(on: boolean): Promise<void>;
	setVolume(volume: number): Promise<void>;
	/** Seek `seconds` from the current position (mpv clamps at 0), or to that second when `absolute`. */
	seek(seconds: number, absolute?: boolean): Promise<void>;
	/**
	 * Resolve a track's stream into the cache ahead of a pick (the cursor rests on it); mpv gets nothing.
	 * One at a time: a newer prepare or a pick cancels it, unless that pick or a prefetch shares its resolve.
	 */
	prepare(track: Track): void;
	/** Cancel pending resolves and drop cached stream URLs (the account changed); playback goes on. */
	forgetStreams(): void;
	getState(): PlayerState;
	onChange(listener: (state: PlayerState) => void): () => void;
	/** Quit mpv when we started it; always release the socket and timers. */
	stop(): Promise<void>;
	/** Release the socket and timers, leaving mpv running. */
	dispose(): void;
}

const MISSING: PlayerError = { kind: "missing", message: "mpv not found", hint: "Install it: sudo pacman -S mpv" };
const START: PlayerError = {
	kind: "start",
	message: "mpv did not start",
	hint: "Run mpv --version to check your install.",
};
const NOT_RUNNING: PlayerError = {
	kind: "not-running",
	message: "mpv is not running",
	hint: "Play something from /yt to start it.",
};

interface Pending {
	resolve: (data: unknown) => void;
	reject: (err: PlayerError) => void;
	timer: unknown;
}

interface Props {
	idle: boolean;
	paused: boolean;
	timePos: number | null;
	duration: number | null;
	mediaTitle: string | null;
	position: number;
	volume: number;
}

const emptyProps = (): Props => ({
	idle: true,
	paused: false,
	timePos: null,
	duration: null,
	mediaTitle: null,
	position: -1,
	volume: 100,
});

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * New order of mirror indices matching mpv's playlist, when it is a permutation of the
 * loaded filenames (`entries`, watch or stream URLs); otherwise undefined.
 */
function reorder(entries: string[], playlist: unknown): number[] | undefined {
	if (!Array.isArray(playlist) || playlist.length !== entries.length) return undefined;
	const pool = entries.map((_, i) => i);
	const out: number[] = [];
	for (const entry of playlist) {
		const filename = entry && typeof entry === "object" ? (entry as { filename?: unknown }).filename : undefined;
		const i = pool.findIndex((j) => entries[j] === filename);
		if (i < 0) return undefined;
		out.push(pool.splice(i, 1)[0]);
	}
	return out;
}

/**
 * mpv per-file option, given to every entry so media-title is the track title, never the watch URL.
 * A comma or leading quote would end the value, so those use mpv's %bytes% form.
 */
function titleOption(title: string): string {
	const quote = /,/.test(title) || /^["'[%]/.test(title);
	return `force-media-title=${quote ? `%${Buffer.byteLength(title)}%${title}` : title}`;
}

const entryIdOf = (data: unknown): number | undefined => {
	const id = data && typeof data === "object" ? (data as { playlist_entry_id?: unknown }).playlist_entry_id : undefined;
	return typeof id === "number" ? id : undefined;
};

/** Controls one mpv over its JSON IPC socket, starting it when none is listening. */
export function createPlayer(deps: PlayerDeps = {}): Player {
	const socketPath = deps.socketPath ?? resolveSocketPath();
	const spawn = deps.spawn ?? ((cmd, args, options) => nodeSpawn(cmd, args, options) as ChildLike);
	const connect = deps.connect ?? ((p: string) => net.createConnection(p));
	const mkdir = deps.mkdir ?? ((dir, options) => fsMkdir(dir, options));
	const now = deps.now ?? Date.now;
	const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

	let socket: net.Socket | undefined;
	let child: ChildLike | undefined;
	let childExited = false;
	let starting: Promise<void> | undefined;
	let props = emptyProps();
	let queue: Track[] = [];
	/** What mpv holds for each mirror entry: the watch URL, or a stream URL once swapped. */
	let entries: string[] = [];
	/** mpv's playlist_entry_id for each mirror entry; only entries with this player's ids are ever touched. */
	let ids: (number | undefined)[] = [];
	/** Another client (a second Pi) replaced mpv's playlist; prefetching stops until this player loads again. */
	let foreign = false;
	let shuffle = false;
	let resolving = false;
	/** The tracks and start of the play() being resolved, reported by getState() meanwhile. */
	let picked: { tracks: Track[]; start: number } | undefined;
	/** Mirror index mpv plays; set by play() and every playlist-pos change. */
	let cursor = -1;
	/** Bumped when play() starts; an older play() stops before touching mpv. */
	let playGen = 0;
	/** Settles with whether the newest play() was applied; an enqueue waits for it. */
	let picking: Promise<boolean> | undefined;
	let startCtl = new AbortController();
	/** Bumped when indices may change (new queue, shuffle); pending swaps for older layouts are dropped. */
	let layout = 0;
	let prefetchCtl = new AbortController();
	/** The one prepare() in progress for the track under the cursor. */
	let dwellCtl = new AbortController();
	const streams = new Map<string, { url: string; at: number }>();
	/** Bumped by forgetStreams(); a resolve started before it is never cached or used. */
	let session = 0;
	/** Resolves in progress by watch URL; one is cancelled only when every caller gave up on it. */
	const inflight = new Map<string, { promise: Promise<string | undefined>; ctl: AbortController; users: number }>();
	/** mpv entry id → track, for entries loaded from a stream URL. */
	const streamEntries = new Map<number, Track>();
	/** Watch URLs whose stream failed in mpv; they stay on the ytdl hook for this queue. */
	const hookOnly = new Set<string>();
	let lock: Promise<unknown> = Promise.resolve();
	let nextRequestId = 1;
	const pending = new Map<number, Pending>();
	const listeners = new Set<(state: PlayerState) => void>();
	const timers = new Set<unknown>();
	let lastTickAt = -Infinity;

	const later = (fn: () => void, ms: number) => {
		const handle = schedule(() => {
			timers.delete(handle);
			fn();
		}, ms);
		timers.add(handle);
		return handle;
	};
	const unschedule = (handle: unknown) => {
		if (!timers.delete(handle)) return;
		cancel(handle);
	};

	const getState = (): PlayerState => {
		if (resolving && picked) {
			// The old song is stopped; the picked track is what the user waits for.
			const track = picked.tracks[picked.start];
			return {
				running: socket !== undefined,
				idle: props.idle,
				paused: props.paused,
				title: track.title,
				artist: track.artist,
				elapsed: 0,
				duration: track.duration,
				volume: props.volume,
				shuffle: false,
				position: -1,
				queue: [...picked.tracks],
				resolving,
			};
		}
		const current = props.position >= 0 ? queue[props.position] : undefined;
		return {
			running: socket !== undefined,
			idle: props.idle,
			paused: props.paused,
			title: current?.title ?? props.mediaTitle,
			artist: current ? current.artist : null,
			elapsed: props.timePos ?? 0,
			duration: props.duration ?? current?.duration ?? null,
			volume: props.volume,
			shuffle,
			position: props.position,
			queue: [...queue],
			resolving,
		};
	};

	const emit = () => {
		if (listeners.size === 0) return;
		const state = getState();
		for (const listener of [...listeners]) {
			try {
				listener(state);
			} catch {
				// A broken view must not break playback.
			}
		}
	};

	const onEvent = (name: unknown, data: unknown) => {
		switch (name) {
			case "pause":
				props.paused = data === true;
				break;
			case "time-pos": {
				props.timePos = num(data);
				if (now() - lastTickAt < TICK_MS) return;
				lastTickAt = now();
				break;
			}
			case "duration":
				props.duration = num(data);
				break;
			case "media-title":
				props.mediaTitle = typeof data === "string" ? data : null;
				break;
			case "playlist-pos":
				props.position = num(data) ?? -1;
				if (props.position >= 0 && props.position !== cursor) {
					cursor = props.position;
					prefetch();
				}
				break;
			case "volume":
				props.volume = num(data) ?? props.volume;
				break;
			case "idle-active":
				props.idle = data === true;
				break;
			case "playlist": {
				const order = reorder(entries, data);
				if (!order) return;
				if (order.some((j, i) => j !== i)) {
					cancelPrefetch();
					queue = order.map((j) => queue[j]);
					entries = order.map((j) => entries[j]);
					ids = order.map((j) => ids[j]);
					prefetch();
				}
				break;
			}
			default:
				return;
		}
		emit();
	};

	const onLine = (line: string) => {
		let msg: { request_id?: unknown; error?: unknown; data?: unknown; event?: unknown; name?: unknown };
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.event === "property-change") {
			onEvent(msg.name, msg.data);
			return;
		}
		if (msg.event === "end-file") {
			const { reason, playlist_entry_id: id } = msg as { reason?: unknown; playlist_entry_id?: unknown };
			const track = typeof id === "number" && reason === "error" ? streamEntries.get(id) : undefined;
			if (track && typeof id === "number") {
				streamEntries.delete(id);
				void reload(track, id);
			}
			return;
		}
		if (typeof msg.request_id !== "number") return;
		const entry = pending.get(msg.request_id);
		if (!entry) return;
		pending.delete(msg.request_id);
		unschedule(entry.timer);
		if (msg.error === "success") entry.resolve(msg.data);
		else
			entry.reject({
				kind: "command",
				message: `mpv: ${typeof msg.error === "string" ? msg.error : "command failed"}`,
				hint: "The video may be unavailable; try updating yt-dlp.",
			});
	};

	const rejectPending = (err: PlayerError) => {
		for (const [id, entry] of pending) {
			pending.delete(id);
			unschedule(entry.timer);
			entry.reject(err);
		}
	};

	const detach = () => {
		const sock = socket;
		if (!sock) return;
		socket = undefined;
		sock.destroy();
		rejectPending(NOT_RUNNING);
		props = emptyProps();
	};

	const send = (command: unknown[]): Promise<unknown> => {
		const sock = socket;
		if (!sock) return Promise.reject(NOT_RUNNING);
		const id = nextRequestId++;
		return new Promise((resolve, reject) => {
			const timer = later(() => {
				pending.delete(id);
				reject({ kind: "timeout", message: "mpv did not answer", hint: "Restart playback from /yt." });
			}, COMMAND_TIMEOUT_MS);
			pending.set(id, { resolve, reject, timer });
			sock.write(`${JSON.stringify({ command, request_id: id })}\n`);
		});
	};

	const run = async (command: unknown[]) => {
		await send(command);
	};

	/** Serialises commands that change mpv's playlist, so a swap's insert/remove pair is never split. */
	const locked = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = lock.then(fn);
		lock = result.catch(() => {});
		return result;
	};

	const cancelPrefetch = () => {
		prefetchCtl.abort();
		prefetchCtl = new AbortController();
		layout++;
	};

	/** A fresh stream URL for the track, from the cache or the resolver; undefined when it fails. */
	const streamFor = (track: Track, signal: AbortSignal): Promise<string | undefined> => {
		const resolver = deps.resolver;
		if (!resolver || signal.aborted) return Promise.resolve(undefined);
		const cached = streams.get(track.url);
		if (cached && now() - cached.at <= STREAM_TTL_MS) return Promise.resolve(cached.url);
		let job = inflight.get(track.url);
		if (!job) {
			const started = session;
			const ctl = new AbortController();
			// A resolver that throws instead of rejecting falls back to the ytdl hook like any failed resolve.
			const promise = new Promise<ResolveResult>((resolve) => resolve(resolver(track, { signal: ctl.signal })))
				.then((result) => {
					if (!result.ok || started !== session || ctl.signal.aborted) return undefined;
					streams.set(track.url, { url: result.url, at: now() });
					return result.url;
				})
				.catch(() => undefined)
				.finally(() => {
					if (inflight.get(track.url) === job) inflight.delete(track.url);
				});
			job = { promise, ctl, users: 0 };
			inflight.set(track.url, job);
		}
		// A pick shares the prefetch's resolve for its track; the resolve stops when its last caller gives up.
		const shared = job;
		shared.users++;
		const leave = () => {
			if (--shared.users > 0) return;
			shared.ctl.abort();
			if (inflight.get(track.url) === shared) inflight.delete(track.url);
		};
		signal.addEventListener("abort", leave, { once: true });
		return shared.promise.finally(() => signal.removeEventListener("abort", leave));
	};

	/**
	 * mpv's playlist, when it still holds exactly the entries this player loaded; undefined when another
	 * client (a second Pi) replaced them. Only asked under the lock, where the mirror matches mpv.
	 */
	const ownPlaylist = async (): Promise<{ current: number } | undefined> => {
		let list: unknown;
		try {
			list = await send(["get_property", "playlist"]);
		} catch {
			return undefined;
		}
		if (!Array.isArray(list)) return undefined;
		const theirs = list.map((entry) =>
			entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined,
		);
		if (list.length !== ids.length || theirs.some((id, j) => id !== ids[j])) {
			// None of ours left: someone else owns mpv now, so stop preparing links for it.
			if (!theirs.some((id) => typeof id === "number" && ids.includes(id))) foreign = true;
			return undefined;
		}
		const current = list.findIndex((entry) => (entry as { current?: unknown }).current === true);
		return { current };
	};

	/** Replace mpv's entry `i` (still the watch URL) with a ready stream URL, unless it is playing. */
	const swap = (track: Track, i: number, gen: number, url: string) =>
		locked(async () => {
			const stale = () =>
				gen !== layout || i === cursor || queue[i] !== track || entries[i] !== track.url || hookOnly.has(track.url);
			if (stale()) return;
			// mpv may have moved to entry `i` before its playlist-pos event arrived; removing it then would cut the track.
			const own = await ownPlaylist();
			if (!own || own.current === i || stale()) return;
			entries[i] = url;
			let reply: unknown;
			try {
				reply = await send(["loadfile", url, "insert-at", i, titleOption(track.title)]);
			} catch {
				entries[i] = track.url;
				return;
			}
			const id = entryIdOf(reply);
			ids[i] = id;
			if (id !== undefined) streamEntries.set(id, track);
			await send(["playlist-remove", i + 1]);
		});

	/** Resolve the next tracks after the playing one and hand mpv their stream URLs. */
	function prefetch() {
		if (!deps.resolver || resolving || foreign || !socket || cursor < 0) return;
		const gen = layout;
		const signal = prefetchCtl.signal;
		for (let i = cursor + 1; i <= cursor + PREFETCH_AHEAD && i < queue.length; i++) {
			const track = queue[i];
			if (entries[i] !== track.url || hookOnly.has(track.url)) continue;
			streamFor(track, signal)
				.then((url) => (url && !signal.aborted ? swap(track, i, gen, url) : undefined))
				.catch(() => {});
		}
	}

	/** mpv could not play a stream URL (expired, blocked): load the watch URL in its place, once. */
	const reload = (track: Track, failed: number) =>
		locked(async () => {
			const i = ids.indexOf(failed);
			if (i < 0 || queue[i] !== track) return;
			// Only in a playlist this player loaded: another player's queue must never get this track back.
			if (!(await ownPlaylist())) return;
			streams.delete(track.url);
			hookOnly.add(track.url);
			entries[i] = track.url;
			const reply = await send(["loadfile", track.url, "insert-at", i, titleOption(track.title)]);
			ids[i] = entryIdOf(reply);
			await send(["playlist-remove", i + 1]);
			await send(["playlist-play-index", i]);
		}).catch(() => {});

	const attach = (sock: net.Socket) => {
		socket = sock;
		let buffer = "";
		sock.setEncoding("utf8");
		sock.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line) onLine(line);
			}
		});
		const lost = () => {
			if (socket !== sock) return;
			detach();
			emit();
		};
		sock.on("error", lost);
		sock.on("close", lost);
		OBSERVED.forEach((name, i) => {
			send(["observe_property", i + 1, name]).catch(() => {});
		});
		emit();
	};

	/** Resolve a connected socket, or undefined when nothing accepts on socketPath. */
	const probe = () =>
		new Promise<net.Socket | undefined>((resolve) => {
			let sock: net.Socket;
			try {
				sock = connect(socketPath);
			} catch {
				resolve(undefined);
				return;
			}
			const fail = () => {
				sock.destroy();
				resolve(undefined);
			};
			sock.once("error", fail);
			sock.once("connect", () => {
				sock.off("error", fail);
				resolve(sock);
			});
		});

	const start = async () => {
		const live = await probe();
		if (live) {
			child = undefined;
			attach(live);
			return;
		}
		try {
			await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
			await rm(socketPath, { force: true });
		} catch {
			throw START;
		}
		const args = [
			"--idle=yes",
			"--no-video",
			"--no-terminal",
			"--force-window=no",
			`--input-ipc-server=${socketPath}`,
			// Start fetching the next track early and skip the video stream.
			"--prefetch-playlist=yes",
			"--ytdl-format=bestaudio/best",
			// A fresh YouTube stream link answers 403 for about 2 s; retry it (0, 1, 3 s) instead of skipping the track.
			"--stream-lavf-o-append=reconnect=1",
			"--stream-lavf-o-append=reconnect_on_http_error=403",
			"--stream-lavf-o-append=reconnect_delay_max=5",
			// The hook's yt-dlp solves YouTube's JS challenge with Pi's node, so deno is not needed.
			`--ytdl-raw-options-append=js-runtimes=node:${process.execPath}`,
		];
		const ytDlp = deps.ytDlpPath?.();
		// mpv's ytdl_hook splits ytdl_path on ":", so such a path would break; the hook then uses its default.
		if (ytDlp && !ytDlp.includes(":")) args.push(`--script-opts-append=ytdl_hook-ytdl_path=${ytDlp}`);
		const browser = deps.cookieArg?.();
		// The -append form takes one key=value pair, so a value is never split on commas.
		if (browser) args.push(`--ytdl-raw-options-append=cookies-from-browser=${browser}`);

		let failure: PlayerError | undefined;
		let proc: ChildLike;
		try {
			proc = spawn("mpv", args, { detached: false, stdio: "ignore" });
		} catch (err) {
			throw (err as NodeJS.ErrnoException)?.code === "ENOENT" ? MISSING : START;
		}
		child = proc;
		childExited = false;
		proc.on("error", (err) => {
			failure = err?.code === "ENOENT" ? MISSING : START;
		});
		proc.on("exit", () => {
			if (child === proc) childExited = true;
			failure ??= START;
		});

		const deadline = now() + START_TIMEOUT_MS;
		while (true) {
			if (failure) break;
			const sock = await probe();
			if (sock) {
				attach(sock);
				return;
			}
			if (failure || now() >= deadline) break;
			await new Promise<void>((resolve) => later(resolve, START_POLL_MS));
		}
		if (!failure && child === proc && !childExited) proc.kill();
		if (child === proc) child = undefined;
		throw failure ?? START;
	};

	const ensureRunning = () => {
		if (socket) return Promise.resolve();
		starting ??= start().finally(() => {
			starting = undefined;
		});
		return starting;
	};

	const release = () => {
		startCtl.abort();
		dwellCtl.abort();
		cancelPrefetch();
		detach();
		rejectPending(NOT_RUNNING);
		for (const handle of [...timers]) unschedule(handle);
	};

	return {
		ensureRunning,
		async play(tracks, startIndex = 0) {
			if (tracks.length === 0) return;
			if (!deps.resolver) {
				await ensureRunning();
				await locked(async () => {
					queue = [...tracks];
					entries = tracks.map((t) => t.url);
					ids = [];
					foreign = false;
					shuffle = false;
					for (const [i, t] of tracks.entries())
						ids.push(
							entryIdOf(await send(["loadfile", t.url, i === 0 ? "replace" : "append", -1, titleOption(t.title)])),
						);
					if (startIndex > 0) await run(["playlist-play-index", startIndex]);
				});
				emit();
				return;
			}

			const gen = ++playGen;
			let applied = false;
			let done = (_: boolean) => {};
			picking = new Promise<boolean>((resolve) => {
				done = resolve;
			});
			const settled = () => {
				if (gen === playGen) picking = undefined;
				done(applied);
			};
			const start = Math.min(Math.max(0, startIndex), tracks.length - 1);
			const first = tracks[start];
			const previous = startCtl;
			startCtl = new AbortController();
			const signal = startCtl.signal;
			// Joined before the old pick and the prefetch let go, so a link already being prepared for it is reused.
			const link = streamFor(first, signal);
			previous.abort();
			dwellCtl.abort();
			cancelPrefetch();
			// An overtaken pick may already be loading into mpv while mpv still reports idle from its stop.
			const wasResolving = resolving;
			resolving = true;
			picked = { tracks: [...tracks], start };
			emit();
			// The old song stops at once instead of playing on while the new link resolves (S20).
			if (socket && (!props.idle || wasResolving)) void locked(() => run(["stop"])).catch(() => {});
			let url: string | undefined;
			const sess = session;
			try {
				[, url] = await Promise.all([ensureRunning(), link]);
			} catch (err) {
				if (gen === playGen) {
					startCtl.abort();
					resolving = false;
					picked = undefined;
					emit();
				}
				settled();
				throw err;
			}
			if (gen !== playGen) return settled();
			try {
				await locked(async () => {
					queue = [...tracks];
					entries = tracks.map((t) => t.url);
					ids = tracks.map(() => undefined);
					foreign = false;
					streamEntries.clear();
					hookOnly.clear();
					shuffle = false;
					cursor = start;
					layout++;
					// forgetStreams() ran while mpv was starting: the link belongs to the old session.
					if (sess !== session) url = undefined;
					if (url) entries[start] = url;
					/** Mirror entries mpv took; in mirror order they match mpv's playlist. */
					const loaded = tracks.map(() => false);
					try {
						const reply = await send(["loadfile", url ?? first.url, "replace", -1, titleOption(first.title)]);
						const id = entryIdOf(reply);
						ids[start] = id;
						loaded[start] = true;
						if (url && id !== undefined) streamEntries.set(id, first);
						for (let i = start + 1; i < tracks.length; i++) {
							ids[i] = entryIdOf(await send(["loadfile", tracks[i].url, "append", -1, titleOption(tracks[i].title)]));
							loaded[i] = true;
						}
						for (let i = 0; i < start; i++) {
							ids[i] = entryIdOf(await send(["loadfile", tracks[i].url, "insert-at", i, titleOption(tracks[i].title)]));
							loaded[i] = true;
						}
					} catch (err) {
						// The queue lists only what mpv holds, never a track it refused or never got.
						const kept = (_: unknown, i: number) => loaded[i];
						queue = queue.filter(kept);
						entries = entries.filter(kept);
						ids = ids.filter(kept);
						cursor = loaded[start] ? loaded.slice(0, start).filter(Boolean).length : -1;
						layout++;
						throw err;
					}
					applied = true;
				});
			} finally {
				if (gen === playGen) {
					resolving = false;
					picked = undefined;
				}
				emit();
				settled();
			}
			prefetch();
		},
		async enqueue(track) {
			// A pick still resolving goes first; an overtaken one hands over to the pick that wins.
			let afterPick = false;
			for (let wait = picking; wait; wait = picking) afterPick = await wait;
			await ensureRunning();
			await locked(async () => {
				const flag = afterPick ? "append" : "append-play";
				const reply = await send(["loadfile", track.url, flag, -1, titleOption(track.title)]);
				queue.push(track);
				entries.push(track.url);
				ids.push(entryIdOf(reply));
			});
			emit();
			prefetch();
		},
		togglePause: () => run(["cycle", "pause"]),
		next: () => locked(() => run(["playlist-next"])),
		prev: () => locked(() => run(["playlist-prev"])),
		async setShuffle(on) {
			await locked(async () => {
				cancelPrefetch();
				await run([on ? "playlist-shuffle" : "playlist-unshuffle"]);
			});
			shuffle = on;
			emit();
		},
		setVolume: (volume) => run(["set_property", "volume", Math.min(100, Math.max(0, volume))]),
		seek: (seconds, absolute = false) => run(["seek", seconds, absolute ? "absolute" : "relative"]),
		prepare(track) {
			dwellCtl.abort();
			dwellCtl = new AbortController();
			// A fresh cached link comes back at once; a resolve in progress for it is shared.
			void streamFor(track, dwellCtl.signal);
		},
		forgetStreams() {
			session++;
			startCtl.abort();
			dwellCtl.abort();
			cancelPrefetch();
			streams.clear();
			// The running (or starting) mpv's ytdl hook must stop using the previous account's cookies too.
			// Queued through the lock and read at send time, so the last account change always wins.
			if (!socket && !starting) return; // not running: the next start uses the current cookie argument
			const pending = starting ?? Promise.resolve();
			void pending
				.then(() =>
					locked(async () => {
						const browser = deps.cookieArg?.();
						await send(["change-list", "ytdl-raw-options", "remove", "cookies-from-browser"]);
						if (browser) await send(["change-list", "ytdl-raw-options", "append", `cookies-from-browser=${browser}`]);
					}),
				)
				.catch(() => {
					// mpv failed to start or went away: the next start uses the current cookie argument.
				});
		},
		getState,
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async stop() {
			const proc = child;
			child = undefined;
			if (proc && !childExited && socket) {
				const exited = new Promise<void>((resolve) => {
					proc.on("exit", () => resolve());
					later(() => {
						proc.kill("SIGTERM");
						resolve();
					}, QUIT_GRACE_MS);
				});
				socket.write(`${JSON.stringify({ command: ["quit"] })}\n`);
				await exited;
			} else if (proc && !childExited) {
				proc.kill("SIGTERM");
			}
			release();
			emit();
		},
		dispose() {
			child = undefined;
			release();
		},
	};
}
