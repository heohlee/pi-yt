import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
	copyToClipboard,
	jsRuntimeArgs,
	MPV_FALLBACK,
	managedBinDir,
	mpvInstallHint,
	resolveTools,
} from "../lib/tools.ts";

async function scratch() {
	const root = await mkdtemp(path.join(os.tmpdir(), "gsyt-tools-"));
	const exe = async (dir: string, name: string) => {
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, name), "#!/bin/sh\n");
		await chmod(path.join(dir, name), 0o755);
		return path.join(dir, name);
	};
	return { root, exe, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// S17: the managed copy lives under XDG_DATA_HOME, else ~/.local/share.
test("S17 managedBinDir respects XDG_DATA_HOME and falls back to ~/.local/share", () => {
	assert.equal(managedBinDir({ home: "/h", env: {} }), "/h/.local/share/pi-yt/bin");
	assert.equal(managedBinDir({ home: "/h", env: { XDG_DATA_HOME: "/data" } }), "/data/pi-yt/bin");
	assert.equal(managedBinDir({ home: "/h", env: { XDG_DATA_HOME: "" } }), "/h/.local/share/pi-yt/bin");
});

// S17: a yt-dlp on PATH wins over the managed copy.
test("S17 resolveTools prefers yt-dlp on PATH over the managed copy", async () => {
	const s = await scratch();
	try {
		const home = path.join(s.root, "home");
		const system = await s.exe(path.join(s.root, "bin"), "yt-dlp");
		await s.exe(managedBinDir({ home, env: {} }), "yt-dlp");
		const tools = await resolveTools({ home, env: { PATH: path.join(s.root, "bin") } });
		assert.deepEqual(tools.ytDlp, { path: system, source: "system" });
	} finally {
		await s.cleanup();
	}
});

// S17: without one on PATH, the managed copy is used; a non-executable file is ignored.
test("S17 resolveTools finds the managed yt-dlp when PATH lacks it", async () => {
	const s = await scratch();
	try {
		const home = path.join(s.root, "home");
		const dataHome = path.join(s.root, "data");
		await mkdir(path.join(s.root, "bin"));
		await writeFile(path.join(s.root, "bin", "yt-dlp"), "not executable");
		await chmod(path.join(s.root, "bin", "yt-dlp"), 0o644);
		const managed = await s.exe(managedBinDir({ home, env: { XDG_DATA_HOME: dataHome } }), "yt-dlp");
		const tools = await resolveTools({ home, env: { PATH: path.join(s.root, "bin"), XDG_DATA_HOME: dataHome } });
		assert.deepEqual(tools.ytDlp, { path: managed, source: "managed" });
		assert.equal(tools.mpv, null);

		const none = await resolveTools({ home, env: { PATH: path.join(s.root, "bin") } });
		assert.equal(none.ytDlp, null);
	} finally {
		await s.cleanup();
	}
});

// S17: mpv is only taken from PATH, never from the managed folder.
test("S17 resolveTools takes mpv only from PATH", async () => {
	const s = await scratch();
	try {
		const home = path.join(s.root, "home");
		await s.exe(managedBinDir({ home, env: {} }), "mpv");
		assert.deepEqual(await resolveTools({ home, env: { PATH: "" } }), { ytDlp: null, mpv: null });
		const mpv = await s.exe(path.join(s.root, "bin"), "mpv");
		assert.deepEqual((await resolveTools({ home, env: { PATH: path.join(s.root, "bin") } })).mpv, { path: mpv });
	} finally {
		await s.cleanup();
	}
});

// S17(2): yt-dlp solves YouTube's JS challenge with Pi's own node.
test("S17 jsRuntimeArgs points yt-dlp at Pi's node", () => {
	assert.deepEqual(jsRuntimeArgs(), ["--js-runtimes", `node:${process.execPath}`]);
});

// S17(3): the package-manager command for the detected system.
test("S17 mpvInstallHint picks the package manager from os-release, or the fallback text", () => {
	const linux = (osRelease: string) => mpvInstallHint({ platform: "linux", osRelease });
	assert.deepEqual(linux('NAME="Arch Linux"\nID=arch\n'), {
		command: "sudo pacman -S mpv",
		text: "sudo pacman -S mpv",
	});
	assert.equal(linux("ID=endeavouros\nID_LIKE=arch\n").command, "sudo pacman -S mpv");
	assert.equal(linux('ID=ubuntu\nID_LIKE="debian"\n').command, "sudo apt install mpv");
	assert.equal(linux("ID=debian\n").command, "sudo apt install mpv");
	assert.equal(linux("ID=fedora\n").command, "sudo dnf install mpv");
	assert.equal(linux('ID="rocky"\nID_LIKE="rhel centos fedora"\n').command, "sudo dnf install mpv");
	assert.equal(linux('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n').command, "sudo zypper install mpv");
	assert.deepEqual(mpvInstallHint({ platform: "darwin", osRelease: null }), {
		command: "brew install mpv",
		text: "brew install mpv",
	});
	assert.deepEqual(linux("ID=gentoo\n"), {
		command: null,
		text: "Install mpv with your package manager: https://mpv.io/installation/",
	});
	assert.deepEqual(mpvInstallHint({ platform: "linux", osRelease: null }), { command: null, text: MPV_FALLBACK });
	assert.deepEqual(mpvInstallHint({ platform: "win32", osRelease: null }), { command: null, text: MPV_FALLBACK });
});

function fakeSpawn(code = 0) {
	const calls: { cmd: string; args: string[]; input: string }[] = [];
	const spawn = (cmd: string, args: string[]) => {
		const call = { cmd, args, input: "" };
		calls.push(call);
		const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: () => boolean };
		child.stdin = new PassThrough();
		child.stdin.setEncoding("utf8");
		child.stdin.on("data", (chunk: string) => (call.input += chunk));
		child.stdin.on("finish", () => setImmediate(() => child.emit("close", code)));
		child.kill = () => true;
		return child;
	};
	return { spawn, calls };
}

// S17(3): Copy command uses the first of wl-copy, xclip, pbcopy found on PATH.
test("S17 copyToClipboard uses the first clipboard tool on PATH, or reports none", async () => {
	const s = await scratch();
	try {
		const bin = path.join(s.root, "bin");
		await s.exe(bin, "pbcopy");
		await s.exe(bin, "xclip");
		const fake = fakeSpawn();
		assert.equal(await copyToClipboard("sudo pacman -S mpv", { env: { PATH: bin }, spawn: fake.spawn }), true);
		assert.deepEqual(fake.calls, [
			{ cmd: path.join(bin, "xclip"), args: ["-selection", "clipboard"], input: "sudo pacman -S mpv" },
		]);

		await s.exe(bin, "wl-copy");
		const wl = fakeSpawn();
		assert.equal(await copyToClipboard("x", { env: { PATH: bin }, spawn: wl.spawn }), true);
		assert.equal(wl.calls[0].cmd, path.join(bin, "wl-copy"));

		const none = fakeSpawn();
		assert.equal(await copyToClipboard("x", { env: { PATH: path.join(s.root, "empty") }, spawn: none.spawn }), false);
		assert.deepEqual(none.calls, []);

		assert.equal(await copyToClipboard("x", { env: { PATH: bin }, spawn: fakeSpawn(1).spawn }), false);
	} finally {
		await s.cleanup();
	}
});

// Advisory S15/S18: a clipboard tool that fails (exit code, spawn throw, error event) hands over to the next one.
test("copyToClipboard tries the next clipboard tool when one fails", async () => {
	const s = await scratch();
	try {
		const bin = path.join(s.root, "bin");
		for (const name of ["wl-copy", "xclip", "pbcopy"]) await s.exe(bin, name);
		const ok = fakeSpawn(0);
		const failing = fakeSpawn(1);
		const calls: string[] = [];
		const spawn = (cmd: string, args: string[]) => {
			calls.push(path.basename(cmd));
			if (cmd.endsWith("wl-copy")) return failing.spawn(cmd, args);
			if (cmd.endsWith("xclip")) throw new Error("spawn failed");
			return ok.spawn(cmd, args);
		};
		assert.equal(await copyToClipboard("hello", { env: { PATH: bin }, spawn }), true);
		assert.deepEqual(calls, ["wl-copy", "xclip", "pbcopy"]);
		assert.deepEqual(ok.calls, [{ cmd: path.join(bin, "pbcopy"), args: [], input: "hello" }]);

		const errored: string[] = [];
		const erroring = (cmd: string) => {
			errored.push(path.basename(cmd));
			const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: () => boolean };
			child.stdin = new PassThrough();
			child.kill = () => true;
			setImmediate(() => child.emit("error", new Error("ENOENT")));
			return child;
		};
		assert.equal(await copyToClipboard("x", { env: { PATH: bin }, spawn: erroring }), false);
		assert.deepEqual(errored, ["wl-copy", "xclip", "pbcopy"]);
	} finally {
		await s.cleanup();
	}
});

// S17 (verify A2): relative XDG_DATA_HOME is ignored (XDG spec) and relative PATH entries are never searched.
test("S17 relative XDG_DATA_HOME and relative PATH entries are ignored", async (t) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "gsyt-rel-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	assert.equal(
		managedBinDir({ home, env: { XDG_DATA_HOME: "rel/data" } }),
		path.join(home, ".local", "share", "pi-yt", "bin"),
	);
	const cwd = process.cwd();
	await writeFile(path.join(home, "yt-dlp"), "#!/bin/sh\n");
	await chmod(path.join(home, "yt-dlp"), 0o755);
	process.chdir(home);
	try {
		const tools = await resolveTools({ home, env: { PATH: ".", XDG_DATA_HOME: path.join(home, "none") } });
		assert.equal(tools.ytDlp, null);
	} finally {
		process.chdir(cwd);
	}
});

// S17 (verify): os-release values only pick from fixed commands.
test("S17 mpvInstallHint ignores injected IDs and follows ID_LIKE", () => {
	assert.equal(mpvInstallHint({ platform: "linux", osRelease: 'ID="arch;touch /tmp/pwn"\n' }).command, null);
	assert.equal(
		mpvInstallHint({ platform: "linux", osRelease: 'ID=linuxmint\nID_LIKE="ubuntu debian"\n' }).command,
		"sudo apt install mpv",
	);
});

// S24: the managed copy now lives in pi-yt/bin.
test("S24 managedBinDir is pi-yt/bin", () => {
	assert.equal(managedBinDir({ home: "/h", env: {} }), "/h/.local/share/pi-yt/bin");
	assert.equal(managedBinDir({ home: "/h", env: { XDG_DATA_HOME: "/data" } }), "/data/pi-yt/bin");
});
