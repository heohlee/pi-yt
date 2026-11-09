import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { managedBinDir } from "./tools.ts";
import type { SpawnFn } from "./youtube-source.ts";

// Installs the official standalone yt-dlp release into /yt's own data folder.
// Pinned version, checked against its published SHA2-256; no sudo, no PATH change,
// nothing written outside managedBinDir().

export interface ReleaseAsset {
	name: string;
	sha256: string;
	/** Bytes, when known; shown before the download. */
	size?: number;
}

export interface Release {
	version: string;
	assets: Record<"linux-x64" | "linux-arm64" | "darwin", ReleaseAsset>;
}

/** yt-dlp 2026.10.26, hashes from its SHA2-256SUMS. */
export const YT_DLP: Release = {
	version: "2026.10.26",
	assets: {
		"linux-x64": {
			name: "yt-dlp_linux",
			sha256: "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795",
			size: 41166968,
		},
		"linux-arm64": {
			name: "yt-dlp_linux_aarch64",
			sha256: "e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483",
		},
		darwin: {
			name: "yt-dlp_macos",
			sha256: "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa",
		},
	},
};
export const YT_DLP_SOURCE = "github.com/yt-dlp/yt-dlp";
export const YT_DLP_LICENSE = "Unlicense";

export const MAX_BYTES = 60 * 1024 * 1024;
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
export const UPDATE_TIMEOUT_MS = 2 * 60_000;

export interface InstallError {
	kind: string;
	message: string;
	hint: string;
}
export type InstallResult = { ok: true; path: string } | { ok: false; error: InstallError };
export type UpdateResult = { ok: true } | { ok: false; error: InstallError };
export type InstallProgress = { phase: "download"; received: number; total: number | null } | { phase: "verify" };

export const UNSUPPORTED: InstallError = {
	kind: "unsupported",
	message: "No official yt-dlp build for this system.",
	hint: "Install yt-dlp with your package manager.",
};
const RETRY_HINT = "Check your connection and retry.";
const NOT_INSTALLED = "Nothing was installed. Retry later.";
const CANCELLED: InstallError = { kind: "cancelled", message: "Install cancelled.", hint: "" };
const TIMEOUT: InstallError = { kind: "timeout", message: "The download took too long.", hint: RETRY_HINT };
const NETWORK: InstallError = { kind: "network", message: "Could not download yt-dlp.", hint: RETRY_HINT };
const TOO_LARGE: InstallError = { kind: "size", message: "The download is larger than expected.", hint: NOT_INSTALLED };
const MISMATCH: InstallError = { kind: "hash", message: "The download did not match the official checksum.", hint: NOT_INSTALLED };

/** `path` with the home folder shown as `~`. */
export function tildePath(file: string, home: string): string {
	return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function assetKey(platform: string, arch: string): keyof Release["assets"] | null {
	if (platform === "darwin") return "darwin"; // yt-dlp_macos is a universal build
	if (platform === "linux" && arch === "x64") return "linux-x64";
	if (platform === "linux" && arch === "arm64") return "linux-arm64";
	return null;
}

/** The pinned asset for this system with its download URL, or null when there is no official build. */
export function releaseAsset(
	{ platform, arch }: { platform: string; arch: string },
	release: Release = YT_DLP,
): (ReleaseAsset & { url: string }) | null {
	const key = assetKey(platform, arch);
	if (!key) return null;
	const asset = release.assets[key];
	return { ...asset, url: `https://github.com/yt-dlp/yt-dlp/releases/download/${release.version}/${asset.name}` };
}

export interface InstallOptions {
	home: string;
	env?: NodeJS.ProcessEnv;
	platform: string;
	arch: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	onProgress?: (progress: InstallProgress) => void;
	release?: Release;
	maxBytes?: number;
	timeoutMs?: number;
}

class Stop extends Error {
	reason: InstallError;
	constructor(reason: InstallError) {
		super(reason.message);
		this.reason = reason;
	}
}

/** Download, verify and atomically place `<managedBinDir>/yt-dlp`; on any failure the temp file is removed. */
export async function installYtDlp(opts: InstallOptions): Promise<InstallResult> {
	const asset = releaseAsset(opts, opts.release);
	if (!asset) return { ok: false, error: { ...UNSUPPORTED } };
	if (opts.signal?.aborted) return { ok: false, error: { ...CANCELLED } };

	const fetchFn = opts.fetch ?? globalThis.fetch;
	const maxBytes = opts.maxBytes ?? MAX_BYTES;
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const stopped = () => (opts.signal?.aborted ? CANCELLED : TIMEOUT);

	const dir = managedBinDir({ home: opts.home, env: opts.env });
	const target = path.join(dir, "yt-dlp");
	const temp = path.join(dir, `.yt-dlp-${randomBytes(6).toString("hex")}.part`);
	let created = false;

	try {
		let response: Response;
		try {
			response = await fetchFn(asset.url, { signal, redirect: "follow" });
		} catch {
			throw new Stop(signal.aborted ? stopped() : NETWORK);
		}
		if (!response.ok || !response.body) throw new Stop(NETWORK);
		const announced = Number(response.headers.get("content-length"));
		if (Number.isFinite(announced) && announced > maxBytes) throw new Stop(TOO_LARGE);
		const total = Number.isFinite(announced) && announced > 0 ? announced : (asset.size ?? null);

		await mkdir(dir, { recursive: true, mode: 0o755 });
		const file = await open(temp, "wx", 0o600);
		created = true;
		const hash = createHash("sha256");
		const reader = response.body.getReader();
		const onAbort = () => void reader.cancel().catch(() => {});
		signal.addEventListener("abort", onAbort, { once: true });
		let received = 0;
		try {
			opts.onProgress?.({ phase: "download", received, total });
			while (true) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch {
					throw new Stop(signal.aborted ? stopped() : NETWORK);
				}
				if (signal.aborted) throw new Stop(stopped());
				if (chunk.done) break;
				received += chunk.value.byteLength;
				if (received > maxBytes) throw new Stop(TOO_LARGE);
				hash.update(chunk.value);
				await file.write(chunk.value);
				opts.onProgress?.({ phase: "download", received, total });
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			await file.close();
		}
		if (signal.aborted) throw new Stop(stopped());

		opts.onProgress?.({ phase: "verify" });
		if (hash.digest("hex") !== asset.sha256) throw new Stop(MISMATCH);
		await chmod(temp, 0o755);
		await rename(temp, target);
		created = false;
		return { ok: true, path: target };
	} catch (error) {
		if (created) await unlink(temp).catch(() => {});
		if (error instanceof Stop) return { ok: false, error: { ...error.reason } };
		return {
			ok: false,
			error: { kind: "write", message: "Could not save yt-dlp.", hint: `Check that ${tildePath(dir, opts.home)} is writable.` },
		};
	}
}

const defaultSpawn: SpawnFn = (command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

export interface UpdateOptions {
	path: string;
	source: "system" | "managed";
	spawn?: SpawnFn;
	signal?: AbortSignal;
	timeoutMs?: number;
}

const UPDATE_FAILED: InstallError = { kind: "update", message: "Could not update yt-dlp.", hint: RETRY_HINT };

/** `<path> -U` on the managed copy; a system copy belongs to the package manager. stderr is never shown. */
export function updateYtDlp(opts: UpdateOptions): Promise<UpdateResult> {
	if (opts.source !== "managed")
		return Promise.resolve({
			ok: false,
			error: { kind: "system", message: "yt-dlp comes from your system.", hint: "Update yt-dlp with your package manager." },
		});
	if (opts.signal?.aborted) return Promise.resolve({ ok: false, error: { ...CANCELLED, message: "Update cancelled." } });

	return new Promise((resolve) => {
		let settled = false;
		let child: ReturnType<SpawnFn>;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: UpdateResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const kill = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
		};
		const onAbort = () => {
			kill();
			finish({ ok: false, error: { ...CANCELLED, message: "Update cancelled." } });
		};
		try {
			child = (opts.spawn ?? defaultSpawn)(opts.path, ["-U"]);
		} catch (error) {
			finish({ ok: false, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? missing() : { ...UPDATE_FAILED } });
			return;
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			kill();
			finish({ ok: false, error: { kind: "timeout", message: "yt-dlp took too long to update.", hint: RETRY_HINT } });
		}, opts.timeoutMs ?? UPDATE_TIMEOUT_MS);
		// Drain the pipes so yt-dlp never blocks on them; their text is not used.
		child.stdout?.resume();
		child.stderr?.resume();
		child.on("error", (error) => finish({ ok: false, error: error.code === "ENOENT" ? missing() : { ...UPDATE_FAILED } }));
		child.on("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: { ...UPDATE_FAILED } }));
	});
}

const missing = (): InstallError => ({ kind: "missing", message: "yt-dlp not found", hint: "Install yt-dlp from /yt." });
