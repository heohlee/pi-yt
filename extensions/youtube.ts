import os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { cookieArg, detectBrowsers as defaultDetectBrowsers, type Browser } from "../lib/browsers.ts";
import {
	readConfig as defaultReadConfig,
	writeConfig as defaultWriteConfig,
	type Account,
	type Config,
	type ConfigLocation,
} from "../lib/config.ts";
import {
	installYtDlp as defaultInstallYtDlp,
	releaseAsset,
	tildePath,
	updateYtDlp as defaultUpdateYtDlp,
	YT_DLP,
} from "../lib/installer.ts";
import { createPlayer as defaultCreatePlayer, type Player, type PlayerDeps } from "../lib/player.ts";
import {
	initPopover,
	keyFromInput,
	reduce,
	snapshotPopover,
	type Action,
	type Deps,
	type Effect,
	type LoadRequest,
	type Notice,
	type PopoverSnapshot,
	type PopoverState,
	type SetupInfo,
} from "../lib/popover-model.ts";
import { hitAt, paneAt, renderFrame, type Frame, type Role, type Scroll, type ViewTheme } from "../lib/popover-view.ts";
import { blockedRecently, resolveAudio as defaultResolveAudio, probeStream } from "../lib/resolver.ts";
import {
	copyToClipboard as defaultCopyToClipboard,
	managedBinDir,
	mpvInstallHint,
	readOsRelease as defaultReadOsRelease,
	resolveTools as defaultResolveTools,
	type Tools,
} from "../lib/tools.ts";
import { checkYtDlpUpdate as defaultCheckYtDlpUpdate, ytDlpVersion as defaultYtDlpVersion } from "../lib/update-check.ts";
import * as youtube from "../lib/youtube-source.ts";

// /yt is a command, never an agent tool: account data stays out of the model's context.
// Nothing here logs; yt-dlp stderr (`detail`) is never displayed.

type Source = Pick<typeof youtube, "listSource" | "listPlaylists" | "listPlaylist" | "search" | "verifySession">;

export interface YoutubeDeps {
	createPlayer?: (deps?: PlayerDeps) => Player;
	readConfig?: (location: ConfigLocation) => Promise<Config>;
	writeConfig?: (location: ConfigLocation, config: Pick<Config, "account">) => Promise<void>;
	detectBrowsers?: (options: { home: string }) => Promise<Browser[]>;
	resolveTools?: typeof defaultResolveTools;
	installYtDlp?: typeof defaultInstallYtDlp;
	updateYtDlp?: typeof defaultUpdateYtDlp;
	checkYtDlpUpdate?: typeof defaultCheckYtDlpUpdate;
	ytDlpVersion?: typeof defaultYtDlpVersion;
	copyToClipboard?: (text: string) => Promise<boolean>;
	readOsRelease?: () => Promise<string | null>;
	fetch?: typeof globalThis.fetch;
	source?: Source;
	resolveAudio?: typeof defaultResolveAudio;
	home?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	arch?: string;
	/** Clock and timers for the dwell wait and the resolver's cooldowns. */
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

interface HostTheme {
	fg(role: string, text: string): string;
	bg?(role: string, text: string): string;
	bold?(text: string): string;
}
interface HostTui {
	requestRender(): void;
	terminal?: { rows?: number };
}
interface HostKeybindings {
	matches(data: string, id: string): boolean;
}

// 95% so a 106-column terminal already gets both panes (NARROW_WIDTH is 100).
const OVERLAY = { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%" } as const;
const HEADLESS = "/yt needs the interactive terminal.";
/** How long the cursor rests on a track before its link is prepared (S21). */
export const DWELL_MS = 400;
const PLAYBACK_FAILED: Notice = { message: "Playback failed.", hint: "Try again from /yt." };
const SAVE_FAILED: Notice = {
	message: "Could not save the account.",
	hint: "Check that ~/.config/pi-yt is writable.",
};
const CLEAR_FAILED: Notice = {
	message: "Could not update the account settings.",
	hint: "Check ~/.config/pi-yt permissions.",
};
/** What a source or verify call that threw instead of answering shows. */
const SOURCE_FAILED: youtube.Failure = { ok: false, error: { kind: "network", message: "Could not load from YouTube.", hint: "Try again." } };
const INSTALL_FAILED = { ok: false as const, error: { kind: "install", message: "Could not install yt-dlp.", hint: "Try again." } };

/** One loaded list for the Pi session: titles and ids only, never cookies. */
type CachedList = { tracks: youtube.Track[]; hasMore: boolean } | { playlists: youtube.Playlist[] };

const accountKey = (account: Account | null) => (account ? `${account.browser}:${account.profile}` : "anon");

/** Session cache key for a library list or the playlists feed; search is never cached. */
function cacheKey(account: Account | null, request: LoadRequest | "playlists"): string | null {
	if (request === "playlists") return `${accountKey(account)}|playlists`;
	if (request.kind === "search") return null;
	return `${accountKey(account)}|${request.kind === "playlist" ? `playlist:${request.id}` : request.kind}`;
}

const copyTrack = ({ id, title, artist, duration, url }: youtube.Track): youtube.Track => ({ id, title, artist, duration, url });

function toNotice(error: unknown): Notice {
	const e = error as { message?: unknown; hint?: unknown; kind?: unknown } | null;
	if (!e || typeof e.message !== "string" || typeof e.hint !== "string") return PLAYBACK_FAILED;
	return typeof e.kind === "string" ? { message: e.message, hint: e.hint, kind: e.kind } : { message: e.message, hint: e.hint };
}

const toDeps = (tools: Tools): Deps => ({ mpv: tools.mpv !== null, ytDlp: tools.ytDlp?.source ?? null });

function viewTheme(theme: HostTheme): ViewTheme {
	const safe = (fn: () => string, text: string) => {
		try {
			return fn();
		} catch {
			return text;
		}
	};
	return {
		fg: (role: Role, text: string) => safe(() => theme.fg(role, text), text),
		bold: (text) => safe(() => theme.bold?.(text) ?? text, text),
		selected: (text) => safe(() => theme.bg?.("selectedBg", text) ?? text, text),
	};
}

export function createYoutubeExtension(deps: YoutubeDeps = {}) {
	const createPlayer = deps.createPlayer ?? defaultCreatePlayer;
	const readConfig = deps.readConfig ?? defaultReadConfig;
	const writeConfig = deps.writeConfig ?? defaultWriteConfig;
	const detectBrowsers = deps.detectBrowsers ?? defaultDetectBrowsers;
	const resolveTools = deps.resolveTools ?? defaultResolveTools;
	const installYtDlp = deps.installYtDlp ?? defaultInstallYtDlp;
	const updateYtDlp = deps.updateYtDlp ?? defaultUpdateYtDlp;
	const checkYtDlpUpdate = deps.checkYtDlpUpdate ?? defaultCheckYtDlpUpdate;
	const ytDlpVersion = deps.ytDlpVersion ?? defaultYtDlpVersion;
	const readOsRelease = deps.readOsRelease ?? (() => defaultReadOsRelease());
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const copyToClipboard = deps.copyToClipboard ?? ((text: string) => defaultCopyToClipboard(text, { env }));
	const source = deps.source ?? youtube;
	const resolveAudio = deps.resolveAudio ?? defaultResolveAudio;
	const now = deps.now ?? Date.now;
	const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const unschedule = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

	return function (pi: ExtensionAPI) {
		let player: Player | undefined;
		let account: Account | null = null;
		/** "Continue without an account" lasts for this Pi session. */
		let anonymous = false;
		/** Lists loaded in this Pi session, in memory only; cleared when the account changes. */
		const cache = new Map<string, CachedList>();
		/** Bumped when the cache is cleared; a load started before it is never stored. */
		let cacheGen = 0;
		/** Where the last popover was left (S18), in memory only; /yt reopens there. */
		let snapshot: PopoverSnapshot | null = null;
		/** yt-dlp and mpv as last resolved: on each /yt, and after Install, Update or Check again. */
		let tools: Tools = { ytDlp: null, mpv: null };
		const ytDlpPath = () => tools.ytDlp?.path;
		const refreshTools = async (home: string) => {
			tools = await resolveTools({ home, env }).catch(() => tools);
			return tools;
		};
		/** The update offer was answered or hidden (S23): not checked or shown again this Pi session. */
		let offerDone = false;
		/** The managed copy's `--version`, by path, for the Pi session. */
		const versions = new Map<string, Promise<string | null>>();
		const managedVersion = (path: string) => {
			let version = versions.get(path);
			if (!version) versions.set(path, (version = ytDlpVersion({ path }).catch(() => null)));
			return version;
		};

		const currentCookieArg = () => (account ? cookieArg({ id: account.browser, profile: account.profile }) : undefined);
		/** Per strategy and browser spec: when YouTube last blocked it (S21); in memory for the Pi session. */
		const cooldowns = new Map<string, number>();
		const getPlayer = () =>
			(player ??= createPlayer({
				cookieArg: currentCookieArg,
				ytDlpPath,
				// Same browser spec as mpv's ytdl hook, read at resolve time so Disconnect applies at once.
				// The link is handed over once it plays: a fresh one answers 403 for about 2 s.
				resolver: (track, { signal }) =>
					resolveAudio(track, { account, cookieArg: currentCookieArg(), ytDlpPath: ytDlpPath(), signal, probe: probeStream, cooldowns, now }),
			}));

		function popover(home: string, init: Parameters<typeof initPopover>[0], tui: HostTui, theme: HostTheme, keys: HostKeybindings, done: (v: void) => void) {
			const p = getPlayer();
			const view = viewTheme(theme);
			const location = { home };
			const controllers = new Map<number, AbortController>();
			let scroll: Scroll = { left: 0, right: 0 };
			let chain = Promise.resolve();
			/** Bumped by each key press that plays; an older press stops before its next effect. */
			let pick = 0;
			let closed = false;
			/** The pending prepare of the track under the cursor (S21). */
			let dwell: unknown;
			const stopDwell = () => {
				if (dwell !== undefined) unschedule(dwell);
				dwell = undefined;
			};
			/** Prepare the track once the cursor rested on it; never during a pick or after a bot check. */
			const startDwell = (track: youtube.Track) => {
				stopDwell();
				dwell = schedule(() => {
					dwell = undefined;
					if (closed || p.getState().resolving || blockedRecently(cooldowns, currentCookieArg(), now)) return;
					p.prepare(copyTrack(track));
				}, DWELL_MS);
			};
			let rendered: { width: number; rows: number; hover: string | null; lines: string[] } | undefined;
			/** The frame on screen, for mouse hits (S23). */
			let frame: (Frame & { width: number; rows: number }) | undefined;
			/** Id of the hit under the pointer, or null. */
			let hover: string | null = null;
			let state: PopoverState;

			const refresh = () => {
				rendered = undefined;
				tui.requestRender();
			};

			const dispatch = (action: Action) => {
				if (closed) return;
				const out = reduce(state, action);
				state = out.state;
				anonymous = state.anonymous;
				run(out.effects);
				refresh();
			};

			/** Run a call for the popover; one that throws answers `failed`, so its screen shows the error. */
			const request = <T>(id: number, call: (signal: AbortSignal) => Promise<T>, onResult: (result: T) => Action, failed: T) => {
				const controller = new AbortController();
				controllers.set(id, controller);
				new Promise<T>((resolve) => resolve(call(controller.signal)))
					.catch(() => failed)
					.then((result) => {
						controllers.delete(id);
						if (!controller.signal.aborted) dispatch(onResult(result));
					})
					.catch(() => {
						controllers.delete(id);
					});
			};

			const playerOp = (effect: Effect): Promise<void> => {
				switch (effect.type) {
					case "play":
						return p.play(effect.tracks, effect.index);
					case "enqueue":
						return p.enqueue(effect.track);
					case "togglePause":
						return p.togglePause();
					case "next":
						return p.next();
					case "prev":
						return p.prev();
					case "setShuffle":
						return p.setShuffle(effect.on);
					case "setVolume":
						return p.setVolume(effect.volume);
					case "seek":
						return effect.absolute ? p.seek(effect.seconds, true) : p.seek(effect.seconds);
					default:
						return Promise.resolve();
				}
			};

			/** Store a loaded page: page 1 replaces the entry, later pages append to it. */
			const remember = (key: string | null, start: number, result: youtube.TracksResult) => {
				if (!key || !result.ok) return;
				const tracks = result.tracks.map(copyTrack);
				const hasMore = result.hasMore ?? false;
				if (start <= 1) {
					cache.set(key, { tracks, hasMore });
					return;
				}
				const entry = cache.get(key);
				if (entry && "tracks" in entry && entry.tracks.length === start - 1)
					cache.set(key, { tracks: [...entry.tracks, ...tracks], hasMore });
			};

			function run(effects: Effect[]) {
				const playback: Effect[] = [];
				const cached: Action[] = [];
				for (const effect of effects) {
					switch (effect.type) {
						case "verify":
							request(
								effect.id,
								(signal) => source.verifySession(effect.account, { signal, ytDlpPath: ytDlpPath() }),
								(result) => ({ type: "verified", id: effect.id, result }),
								SOURCE_FAILED,
							);
							break;
						case "load": {
							const { request: req } = effect;
							const key = cacheKey(account, req);
							const gen = cacheGen;
							const start = req.kind === "search" ? 1 : (req.start ?? 1);
							const hit = key && start === 1 && !(req.kind !== "search" && req.refresh) ? cache.get(key) : undefined;
							if (hit && "tracks" in hit) {
								cached.push({ type: "loaded", id: effect.id, result: { ok: true, tracks: hit.tracks, hasMore: hit.hasMore } });
								break;
							}
							request(
								effect.id,
								(signal) =>
									req.kind === "search"
										? source.search(req.query, { signal, ytDlpPath: ytDlpPath() })
										: req.kind === "playlist"
											? source.listPlaylist(req.id, { account, signal, start, ytDlpPath: ytDlpPath() })
											: source.listSource(req.kind, { account, signal, start, ytDlpPath: ytDlpPath() }),
								(result) => {
									if (gen === cacheGen) remember(key, start, result);
									return { type: "loaded", id: effect.id, result };
								},
								SOURCE_FAILED,
							);
							break;
						}
						case "loadPlaylists": {
							const key = cacheKey(account, "playlists")!;
							const gen = cacheGen;
							const hit = effect.refresh ? undefined : cache.get(key);
							if (hit && "playlists" in hit) {
								cached.push({ type: "playlistsLoaded", id: effect.id, result: { ok: true, playlists: hit.playlists } });
								break;
							}
							request(
								effect.id,
								(signal) => source.listPlaylists({ account, signal, ytDlpPath: ytDlpPath() }),
								(result) => {
									if (result.ok && gen === cacheGen)
										cache.set(key, { playlists: result.playlists.map(({ id, title, count }) => ({ id, title, count })) });
									return { type: "playlistsLoaded", id: effect.id, result };
								},
								SOURCE_FAILED,
							);
							break;
						}
						case "cancel":
							controllers.get(effect.id)?.abort();
							controllers.delete(effect.id);
							break;
						case "install":
							// esc (cancel) or closing the popover aborts the download; the installer removes its temp file.
							request(
								effect.id,
								async (signal) => {
									const result = await installYtDlp({
										home,
										env,
										platform,
										arch,
										fetch: deps.fetch ?? globalThis.fetch,
										signal,
										onProgress: (progress) => {
											if (!signal.aborted) dispatch({ type: "installProgress", id: effect.id, progress });
										},
									});
									// The retried load right after must already use the new copy.
									if (result.ok) await refreshTools(home);
									return result;
								},
								(result) => ({ type: "installed", id: effect.id, result: result.ok ? { ok: true } : result }),
								INSTALL_FAILED,
							);
							break;
						case "update": {
							// Not tied to the popover: closing it must not kill yt-dlp while it replaces itself.
							const ytDlp = tools.ytDlp;
							const update = ytDlp
								? updateYtDlp({ path: ytDlp.path, source: ytDlp.source })
								: Promise.resolve({ ok: false as const, error: { kind: "missing", message: "yt-dlp not found", hint: "Install yt-dlp from /yt." } });
							update
								.catch(() => ({ ok: false as const, error: { kind: "update", message: "Could not update yt-dlp.", hint: "Check your connection and retry." } }))
								.then((result) => dispatch({ type: "updated", id: effect.id, result }));
							break;
						}
						case "checkTools":
							void refreshTools(home).then((found) => dispatch({ type: "deps", deps: toDeps(found) }));
							break;
						case "copy":
							copyToClipboard(effect.text)
								.catch(() => false)
								.then((ok) => dispatch({ type: "copied", ok }));
							break;
						case "saveAccount":
							account = effect.account;
							cache.clear();
							cacheGen++;
							// Stream URLs resolved with the previous session are never reused.
							p.forgetStreams();
							writeConfig(location, { account: effect.account }).catch(() =>
								dispatch({ type: "playerError", error: SAVE_FAILED }),
							);
							break;
						case "clearAccount":
							// The running mpv keeps playing; only later yt-dlp/mpv calls lose the cookies.
							account = null;
							cache.clear();
							cacheGen++;
							p.forgetStreams();
							Promise.resolve()
								.then(() => writeConfig(location, { account: null }))
								.catch(() => dispatch({ type: "playerError", error: CLEAR_FAILED }));
							break;
						case "scroll":
							scroll = { ...effect.scroll };
							break;
						case "dwell":
							if (effect.track) startDwell(effect.track);
							else stopDwell();
							break;
						case "dismissUpdate":
							offerDone = true;
							break;
						case "close":
							close();
							break;
						default:
							playback.push(effect);
					}
				}
				// One microtask later, so a cached list never renders before Pi has mounted the popover.
				if (cached.length) queueMicrotask(() => { for (const action of cached) dispatch(action); });
				if (playback.length === 0) return;
				// One link per key press, so a failed play does not also report the shuffle after it.
				// A new pick starts at once (the player cancels the old pick's resolve) and the old press stops there.
				const picks = playback.some((effect) => effect.type === "play");
				// The pick resolves its own track; a pending prepare would only compete with it.
				if (picks) stopDwell();
				const id = picks ? ++pick : pick;
				chain = (picks ? Promise.resolve() : chain)
					.then(async () => {
						for (const effect of playback) {
							if (id !== pick) return;
							await playerOp(effect);
						}
					})
					.catch((error) => {
						if (id === pick) dispatch({ type: "playerError", error: toNotice(error) });
					});
			}

			const unsubscribe = p.onChange((ps) => dispatch({ type: "player", state: ps }));

			function release() {
				if (closed) return;
				closed = true;
				stopDwell();
				snapshot = snapshotPopover(state, scroll);
				unsubscribe();
				for (const controller of controllers.values()) controller.abort();
				controllers.clear();
			}

			function close() {
				release();
				done(undefined);
			}

			const start = initPopover({ ...init, player: p.getState(), snapshot });
			state = start.state;
			scroll = start.scroll;
			run(start.effects);

			// S23: a newer yt-dlp for the managed copy, asked in the background; a system copy is the package manager's.
			const ytDlp = tools.ytDlp;
			if (!offerDone && ytDlp?.source === "managed" && state.screen !== "dependencies") {
				void checkYtDlpUpdate({ home, env, fetch: deps.fetch ?? globalThis.fetch, now, currentVersion: () => managedVersion(ytDlp.path) })
					.then((found) => {
						if (found && !offerDone) dispatch({ type: "updateAvailable", latest: found.latest });
					})
					.catch(() => {});
			}

			const setHover = (id: string | null) => {
				if (id === hover) return false;
				hover = id;
				rendered = undefined;
				return true;
			};

			/** S23: mouse: press captures, click acts, move hovers, wheel scrolls. */
			function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (closed || !frame) return undefined;
				// Clicks on a frame of another size would land on the wrong element.
				if (event.width !== frame.width || (tui.terminal?.rows ?? 30) !== frame.rows) {
					const changed = setHover(null);
					return changed ? { handled: true, render: true } : undefined;
				}
				const found = hitAt(frame, event.x, event.y);
				switch (event.type) {
					case "move":
						if (event.button !== "none") return undefined;
						return { handled: true, render: setHover(found?.hit.id ?? null) };
					case "press":
						return found ? { handled: true, capture: true, render: false } : undefined;
					case "release":
					case "drag":
						return found ? { handled: true } : undefined;
					case "click":
						if (!found || event.button !== "left") return undefined;
						dispatch({ type: "click", target: found.hit.target, ratio: found.ratio });
						return { handled: true, render: true };
					case "wheel": {
						const delta = Math.sign(event.wheelDelta ?? 0);
						if (!delta) return undefined;
						dispatch({ type: "wheel", pane: paneAt(frame, event.x, event.y), delta });
						return { handled: true, render: true };
					}
					default:
						return undefined;
				}
			}

			return {
				render(width: number): string[] {
					const rows = tui.terminal?.rows ?? 30;
					if (rendered && rendered.width === width && rendered.rows === rows && rendered.hover === hover) return rendered.lines;
					const height = Math.max(10, Math.floor(rows * 0.85));
					const out = renderFrame(state, { width, height, theme: view, scroll, hover });
					rendered = { width, rows, hover, lines: out.lines };
					frame = { ...out, width, rows };
					return out.lines;
				},
				handleInput(data: string) {
					setHover(null);
					const key = keyFromInput(data, (d, id) => keys.matches(d, id));
					if (key) dispatch({ type: "key", key });
				},
				handleMouse,
				invalidate() {
					rendered = undefined;
				},
				dispose: release,
			};
		}

		/** What the install screens show: the pinned release for this system and the mpv command. */
		async function setupInfo(home: string): Promise<SetupInfo> {
			const asset = releaseAsset({ platform, arch });
			const osRelease = platform === "linux" ? await readOsRelease().catch(() => null) : null;
			return {
				ytDlp: asset ? { version: YT_DLP.version, size: asset.size ?? null, dir: tildePath(managedBinDir({ home, env }), home) } : null,
				mpv: mpvInstallHint({ platform, osRelease }),
			};
		}

		async function open(ctx: ExtensionCommandContext) {
			const home = deps.home ?? os.homedir();
			const [config, browsers, found, setup] = await Promise.all([
				readConfig({ home }).catch((): Config => ({ version: 1, account: null })),
				detectBrowsers({ home }).catch((): Browser[] => []),
				resolveTools({ home, env })
					.then((t) => toDeps((tools = t)))
					.catch(() => null),
				setupInfo(home),
			]);
			account = config.account;
			const init = { account, anonymous, browsers, deps: found, setup, player: null };
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) =>
					popover(home, init, tui as HostTui, theme as unknown as HostTheme, keybindings as unknown as HostKeybindings, done),
				{ overlay: true, overlayOptions: { ...OVERLAY } },
			);
		}

		pi.registerCommand("yt", {
			description: "Browse and play YouTube with your browser session",
			handler: async (_args, ctx) => {
				const notify = (message: string) => {
					try {
						ctx.ui?.notify(message, "error");
					} catch {
						// Nothing else to tell.
					}
				};
				if (!ctx.hasUI || ctx.mode !== "tui") {
					notify(HEADLESS);
					return;
				}
				try {
					await open(ctx);
				} catch {
					notify("Could not open /yt.");
				}
			},
		});

		pi.on("session_shutdown", async (event) => {
			const p = player;
			player = undefined;
			if (!p) return;
			if (event?.reason === "quit") await p.stop().catch(() => {});
			else p.dispose();
		});
	};
}

export default createYoutubeExtension();
