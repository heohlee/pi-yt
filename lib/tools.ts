import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

// Finds yt-dlp and mpv. A yt-dlp on PATH wins over the copy /yt installs into
// its own data folder; mpv only ever comes from PATH (the package manager).

export interface ToolsLocation {
	home: string;
	env?: NodeJS.ProcessEnv;
}

export interface Tools {
	ytDlp: { path: string; source: "system" | "managed" } | null;
	mpv: { path: string } | null;
}

export const MPV_FALLBACK = "Install mpv with your package manager: https://mpv.io/installation/";
const CLIPBOARD_TIMEOUT_MS = 2000;

const dataBinDir = (folder: string, { home, env = process.env }: ToolsLocation) => {
	// The XDG spec says to ignore a relative XDG_DATA_HOME.
	const xdg = env.XDG_DATA_HOME;
	const data = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
	return path.join(data, folder, "bin");
};

/** `${XDG_DATA_HOME:-~/.local/share}/pi-yt/bin`: the only folder /yt installs into. */
export function managedBinDir(location: ToolsLocation): string {
	return dataBinDir("pi-yt", location);
}

async function isExecutable(file: string): Promise<boolean> {
	try {
		if (!(await stat(file)).isFile()) return false;
		await access(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** First executable `name` in `dirs`, or null. */
export async function findExecutable(name: string, dirs: string[]): Promise<string | null> {
	for (const dir of dirs) {
		const file = path.join(dir, name);
		if (await isExecutable(file)) return file;
	}
	return null;
}

// Relative PATH entries (".", "bin") depend on the current directory, so they are never searched.
const pathDirs = (env: NodeJS.ProcessEnv) =>
	(env.PATH ?? "").split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));

export async function resolveTools({ home, env = process.env }: ToolsLocation): Promise<Tools> {
	const dirs = pathDirs(env);
	const [system, mpv] = await Promise.all([findExecutable("yt-dlp", dirs), findExecutable("mpv", dirs)]);
	const managed = system ? null : await findExecutable("yt-dlp", [managedBinDir({ home, env })]);
	return {
		ytDlp: system ? { path: system, source: "system" } : managed ? { path: managed, source: "managed" } : null,
		mpv: mpv ? { path: mpv } : null,
	};
}

/** yt-dlp solves YouTube's JS challenge with the node that runs Pi, so deno is not needed. */
export function jsRuntimeArgs(): string[] {
	return ["--js-runtimes", `node:${process.execPath}`];
}

/** /etc/os-release, or null when it cannot be read. */
export async function readOsRelease(file = "/etc/os-release"): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

/** ID then ID_LIKE entries; `opensuse-tumbleweed` and friends count as `opensuse`. */
function osIds(osRelease: string): string[] {
	const values: Record<string, string> = {};
	for (const line of osRelease.split(/\r?\n/)) {
		const match = /^(ID|ID_LIKE)=(.*)$/.exec(line.trim());
		if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "").toLowerCase();
	}
	return `${values.ID ?? ""} ${values.ID_LIKE ?? ""}`
		.split(/\s+/)
		.filter(Boolean)
		.map((id) => (id.startsWith("opensuse") ? "opensuse" : id));
}

const MPV_COMMANDS: [string[], string][] = [
	[["arch"], "sudo pacman -S mpv"],
	[["debian", "ubuntu"], "sudo apt install mpv"],
	[["fedora", "rhel"], "sudo dnf install mpv"],
	[["opensuse", "suse"], "sudo zypper install mpv"],
];

/** The package-manager command that installs mpv here, or null with a pointer to mpv.io. */
export function mpvInstallHint({
	platform,
	osRelease,
}: {
	platform: NodeJS.Platform | string;
	osRelease: string | null;
}): {
	command: string | null;
	text: string;
} {
	let command: string | null = null;
	if (platform === "darwin") command = "brew install mpv";
	else if (platform === "linux" && osRelease) {
		for (const id of osIds(osRelease)) {
			command = MPV_COMMANDS.find(([names]) => names.includes(id))?.[1] ?? null;
			if (command) break;
		}
	}
	return { command, text: command ?? MPV_FALLBACK };
}

interface ClipboardChild {
	stdin: Writable | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: (code: number | null) => void): unknown;
}
type ClipboardSpawn = (command: string, args: string[]) => ClipboardChild;

const CLIPBOARD_TOOLS: [string, string[]][] = [
	["wl-copy", []],
	["xclip", ["-selection", "clipboard"]],
	["pbcopy", []],
];

const defaultClipboardSpawn: ClipboardSpawn = (command, args) =>
	nodeSpawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });

function copyWith(file: string, args: string[], text: string, spawn: ClipboardSpawn): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ClipboardChild;
		const timer = setTimeout(() => {
			child?.kill();
			resolve(false);
		}, CLIPBOARD_TIMEOUT_MS);
		const finish = (ok: boolean) => {
			clearTimeout(timer);
			resolve(ok);
		};
		try {
			child = spawn(file, args);
		} catch {
			finish(false);
			return;
		}
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
		child.stdin?.on("error", () => finish(false));
		child.stdin?.end(text);
	});
}

/** Copy `text` with wl-copy, xclip or pbcopy from PATH, trying the next one when a tool fails; false when none worked. */
export async function copyToClipboard(
	text: string,
	{ env = process.env, spawn = defaultClipboardSpawn }: { env?: NodeJS.ProcessEnv; spawn?: ClipboardSpawn } = {},
): Promise<boolean> {
	const dirs = pathDirs(env);
	for (const [name, args] of CLIPBOARD_TOOLS) {
		const file = await findExecutable(name, dirs);
		if (file && (await copyWith(file, args, text, spawn))) return true;
	}
	return false;
}
