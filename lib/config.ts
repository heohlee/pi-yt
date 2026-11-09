import path from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isBrowserId, isProfileFor, type BrowserId } from "./browsers.ts";

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

export function configPath({ home, env = process.env }: ConfigLocation): string {
	return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "pi-yt", "config.json");
}

function parseAccount(value: unknown): Account | null | undefined {
	if (value === null) return null;
	if (!value || typeof value !== "object") return undefined;
	const { browser, profile } = value as Record<string, unknown>;
	// A profile detection could never offer (e.g. "../x") means the file was tampered with.
	if (!isBrowserId(browser) || typeof profile !== "string" || !isProfileFor(browser, profile)) return undefined;
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

export async function readConfig(location: ConfigLocation): Promise<Config> {
	let text: string;
	try {
		text = await readFile(configPath(location), "utf8");
	} catch (error) {
		// Only a missing file means "never connected"; an unreadable one is flagged like a malformed one.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, account: null };
		return { version: 1, account: null, malformed: true };
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
	try {
		await writeFile(tmp, `${JSON.stringify({ version: 1, account }, null, 2)}\n`, { mode: 0o600 });
		await chmod(tmp, 0o600);
		await rename(tmp, file);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
