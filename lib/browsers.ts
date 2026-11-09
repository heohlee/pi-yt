import path from "node:path";
import { readFile, stat } from "node:fs/promises";

// Detection only checks that profile directories exist, parses Firefox's
// profiles.ini and takes each profile's display name from Chromium's
// `Local State`. It never opens cookie databases, keyrings or credential files.

export type BrowserId = "firefox" | "zen" | "chromium" | "chrome" | "brave" | "helium";

export interface Browser {
	id: BrowserId;
	label: string;
	/** Profile name shown to the user. */
	profileName: string;
	/** What yt-dlp reads: a Firefox or Zen profile folder or a Helium profile folder (absolute paths), or a Chromium profile name. */
	profile: string;
}

const LABELS: Record<BrowserId, string> = {
	firefox: "Firefox",
	zen: "Zen",
	chromium: "Chromium",
	chrome: "Chrome",
	brave: "Brave",
	helium: "Helium",
};

export const BROWSER_IDS = Object.keys(LABELS) as BrowserId[];

const CHROMIUM_DIRS: [BrowserId, string][] = [
	["chromium", "chromium"],
	["chrome", "google-chrome"],
	["brave", path.join("BraveSoftware", "Brave-Browser")],
];

export function browserLabel(id: BrowserId): string {
	return LABELS[id];
}

export function isBrowserId(value: unknown): value is BrowserId {
	return typeof value === "string" && Object.hasOwn(LABELS, value);
}

// yt-dlp has no Zen or Helium: it reads them as Firefox and Chromium profiles given by path.
const YT_DLP_BROWSER: Record<BrowserId, string> = {
	firefox: "firefox",
	zen: "firefox",
	chromium: "chromium",
	chrome: "chrome",
	brave: "brave",
	helium: "chromium",
};

/** yt-dlp `--cookies-from-browser` value: `BROWSER:PROFILE`. */
export function cookieArg(browser: { id: BrowserId; profile: string }): string {
	return `${YT_DLP_BROWSER[browser.id]}:${browser.profile}`;
}

type IniSection = { name: string; values: Record<string, string> };

function parseIni(text: string): IniSection[] {
	const sections: IniSection[] = [];
	let current: IniSection | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(";") || line.startsWith("#")) continue;
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			current = { name: header[1], values: {} };
			sections.push(current);
			continue;
		}
		const eq = line.indexOf("=");
		if (current && eq > 0) current.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return sections;
}

// yt-dlp splits `BROWSER:PROFILE::CONTAINER` on "::" and mpv splits its raw
// options on ",", so profiles containing either are never offered.
function safeProfile(profile: string): boolean {
	return !profile.includes(",") && !profile.includes("::");
}

async function firefoxProfiles(dir: string): Promise<{ name: string; folder: string }[]> {
	let text: string;
	try {
		text = await readFile(path.join(dir, "profiles.ini"), "utf8");
	} catch {
		return [];
	}
	const sections = parseIni(text);
	let profiles = sections
		.filter((s) => /^Profile/i.test(s.name) && s.values.Name && s.values.Path)
		.map((s) => ({
			name: s.values.Name,
			path: s.values.Path,
			// yt-dlp treats a value with a "/" as a folder; a bare value is looked up by folder name, never by Name.
			folder: s.values.IsRelative === "0" ? s.values.Path : path.join(dir, s.values.Path),
			flagged: s.values.Default === "1",
		}))
		.filter((p) => safeProfile(p.folder));
	// Firefox writes prefs.js the first time a profile is opened; never-opened profiles are hidden.
	const opened = await Promise.all(profiles.map((p) => isFile(path.join(path.resolve(dir, p.folder), "prefs.js"))));
	profiles = profiles.filter((_, i) => opened[i]);
	const installDefault = sections.find((s) => /^Install/i.test(s.name) && s.values.Default)?.values.Default;
	const preferred =
		profiles.find((p) => installDefault !== undefined && p.path === installDefault) ??
		profiles.find((p) => p.flagged);
	const ordered = preferred ? [preferred, ...profiles.filter((p) => p !== preferred)] : profiles;
	return ordered.map((p) => ({ name: p.name, folder: p.folder }));
}

async function isDir(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(file: string): Promise<boolean> {
	try {
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

const MAX_PROFILE_NAME = 40;

function profileDisplayName(name: unknown, folder: string): string {
	if (typeof name !== "string") return folder;
	const clean = Array.from(name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim())
		.slice(0, MAX_PROFILE_NAME)
		.join("")
		.trim();
	return clean || folder;
}

/**
 * Profile folders and display names from Chromium's `Local State`. Only
 * `profile.info_cache.<folder>.name` is read; every other field (it holds
 * account data) is dropped here. Undefined when the file is unusable.
 */
async function localStateNames(dir: string): Promise<Map<string, string> | undefined> {
	let cache: unknown;
	try {
		cache = JSON.parse(await readFile(path.join(dir, "Local State"), "utf8"))?.profile?.info_cache;
	} catch {
		return undefined;
	}
	if (!cache || typeof cache !== "object" || Array.isArray(cache)) return undefined;
	const names = new Map<string, string>();
	for (const [folder, info] of Object.entries(cache as Record<string, unknown>)) {
		const name = info && typeof info === "object" ? (info as { name?: unknown }).name : undefined;
		names.set(folder, profileDisplayName(name, folder));
	}
	return names;
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true }).compare;

async function chromiumProfiles(dir: string): Promise<{ name: string; folder: string }[]> {
	const names = await localStateNames(dir);
	if (!names) return (await isDir(path.join(dir, "Default"))) ? [{ name: "Default", folder: "Default" }] : [];
	const folders = [...names.keys()]
		// yt-dlp trims spaces around ":" and reads a leading ":" as part of "::", so those names would point elsewhere.
		.filter((folder) => safeProfile(folder) && folder !== "." && folder !== ".." && !folder.includes("/") && folder.trim() === folder && folder !== "" && !folder.startsWith(":"))
		.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : naturalOrder(a, b)));
	const exists = await Promise.all(folders.map((folder) => isDir(path.join(dir, folder))));
	const found = folders.filter((_, i) => exists[i]).map((folder) => ({ name: names.get(folder)!, folder }));
	if (found.length) return found;
	return (await isDir(path.join(dir, "Default"))) ? [{ name: "Default", folder: "Default" }] : [];
}

export async function detectBrowsers({
	home,
	env = process.env,
}: {
	home: string;
	env?: NodeJS.ProcessEnv;
}): Promise<Browser[]> {
	const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
	// Firefox 147+ keeps profiles under the XDG config dir; older installs under ~/.mozilla.
	const firefox = [
		...(await firefoxProfiles(path.join(configHome, "mozilla", "firefox"))),
		...(await firefoxProfiles(path.join(home, ".mozilla", "firefox"))),
	];
	const found: Browser[] = firefox.map(({ name, folder }) => ({
		id: "firefox",
		label: LABELS.firefox,
		profileName: name,
		profile: folder,
	}));
	// Zen 1.18.6b+ uses the XDG config dir; older installs ~/.zen; Flatpak keeps both under ~/.var.
	const zenFlatpak = path.join(home, ".var", "app", "app.zen_browser.zen");
	for (const dir of [path.join(configHome, "zen"), path.join(home, ".zen"), path.join(zenFlatpak, "zen"), path.join(zenFlatpak, ".zen")]) {
		for (const { name, folder } of await firefoxProfiles(dir)) {
			found.push({ id: "zen", label: LABELS.zen, profileName: name, profile: folder });
		}
	}
	for (const [id, dir] of CHROMIUM_DIRS) {
		for (const { name, folder } of await chromiumProfiles(path.join(configHome, dir))) {
			found.push({ id, label: LABELS[id], profileName: name, profile: folder });
		}
	}
	// yt-dlp reads Helium as Chromium, so it gets the profile folder as an absolute path.
	const helium = path.join(configHome, "net.imput.helium");
	for (const { name, folder } of await chromiumProfiles(helium)) {
		const profile = path.join(helium, folder);
		if (safeProfile(profile)) found.push({ id: "helium", label: LABELS.helium, profileName: name, profile });
	}
	return found;
}
