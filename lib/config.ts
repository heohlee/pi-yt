import path from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isBrowserId, type BrowserId } from "./browsers.ts";

// Stores only which browser profile yt-dlp should read cookies from, never cookies.

export interface Account {
	browser: BrowserId;
	profile: string;
}

export interface Config {
	version: 1;
	account: Account | null;
	/** Set by readConfig when the file existed but could not be used. */
	malformed?: true;
}

export interface ConfigLocation {
	home: string;
	env?: NodeJS.ProcessEnv;
}

const configFile = (folder: string, { home, env = process.env }: ConfigLocation) =>
	path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), folder, "config.json");

export function configPath(location: ConfigLocation): string {
	return configFile("pi-yt", location);
}

/** Where releases before the pi-yt rename saved the account; read only, never written. */
export function legacyConfigPath(location: ConfigLocation): string {
	return configFile("gentle-shell-yt", location);
}

function parseAccount(value: unknown): Account | null | undefined {
	if (value === null) return null;
	if (!value || typeof value !== "object") return undefined;
	const { browser, profile } = value as Record<string, unknown>;
	if (!isBrowserId(browser) || typeof profile !== "string" || !profile) return undefined;
	return { browser, profile };
}

function parseConfig(text: string): Config | undefined {
	try {
		const data = JSON.parse(text) as Record<string, unknown>;
		const account = data?.version === 1 ? parseAccount(data.account) : undefined;
		if (account !== undefined) return { version: 1, account };
	} catch {
		// fall through
	}
	return undefined;
}

/** The pi-yt config; when it does not exist yet, a valid one from the old gentle-shell-yt folder. */
export async function readConfig(location: ConfigLocation): Promise<Config> {
	let text: string;
	try {
		text = await readFile(configPath(location), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { version: 1, account: null };
		const legacy = await readFile(legacyConfigPath(location), "utf8").catch(() => null);
		return (legacy !== null && parseConfig(legacy)) || { version: 1, account: null };
	}
	return parseConfig(text) ?? { version: 1, account: null, malformed: true };
}

export async function writeConfig(location: ConfigLocation, config: Pick<Config, "account">): Promise<void> {
	const file = configPath(location);
	const dir = path.dirname(file);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const account = config.account ? { browser: config.account.browser, profile: config.account.profile } : null;
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify({ version: 1, account }, null, 2)}\n`, { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, file);
}
