import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { configPath, readConfig, writeConfig } from "../lib/config.ts";

async function fakeHome(t: { after: (fn: () => Promise<void>) => void }) {
	const home = await mkdtemp(path.join(os.tmpdir(), "gsyt-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

test("configPath honours XDG_CONFIG_HOME and falls back to ~/.config", () => {
	assert.equal(configPath({ home: "/h", env: {} }), "/h/.config/pi-yt/config.json");
	assert.equal(configPath({ home: "/h", env: { XDG_CONFIG_HOME: "/x" } }), "/x/pi-yt/config.json");
});

test("missing config reads as no account", async (t) => {
	const home = await fakeHome(t);
	assert.deepEqual(await readConfig({ home, env: {} }), { version: 1, account: null });
});

test("malformed config reads as no account and is flagged", async (t) => {
	const home = await fakeHome(t);
	const file = configPath({ home, env: {} });
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, "{not json");
	assert.deepEqual(await readConfig({ home, env: {} }), { version: 1, account: null, malformed: true });
	await writeFile(file, JSON.stringify({ version: 1, account: { browser: "netscape", profile: "x" } }));
	assert.deepEqual(await readConfig({ home, env: {} }), { version: 1, account: null, malformed: true });
});

// S4: only browser id and profile name are stored, 0600 file in a 0700 dir, atomically.
test("writeConfig stores only browser and profile with private modes", async (t) => {
	const home = await fakeHome(t);
	const env = { XDG_CONFIG_HOME: path.join(home, "xdg") };
	const extra = { browser: "firefox", profile: "default-release", cookies: "SECRET", label: "Firefox" };
	await writeConfig({ home, env }, { version: 1, account: extra as never });
	const file = path.join(home, "xdg", "pi-yt", "config.json");
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		version: 1,
		account: { browser: "firefox", profile: "default-release" },
	});
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
	assert.deepEqual(await readdir(path.dirname(file)), ["config.json"]);
	assert.deepEqual(await readConfig({ home, env }), {
		version: 1,
		account: { browser: "firefox", profile: "default-release" },
	});

	await writeConfig({ home, env }, { version: 1, account: null });
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, account: null });
	assert.equal((await stat(file)).mode & 0o777, 0o600);
});

// S13: Zen and Helium accounts round-trip with their absolute profile folders.
test("zen and helium accounts round-trip", async (t) => {
	const home = await fakeHome(t);
	for (const account of [
		{ browser: "zen" as const, profile: "/h/.zen/a.Default (release)" },
		{ browser: "helium" as const, profile: "/h/.config/net.imput.helium/Default" },
	]) {
		await writeConfig({ home, env: {} }, { account });
		assert.deepEqual(await readConfig({ home, env: {} }), { version: 1, account });
	}
});

// S24: the config lives in ~/.config/pi-yt; a relative XDG_CONFIG_HOME is used as before.
test("S24 configPath is pi-yt/config.json", () => {
	assert.equal(configPath({ home: "/h", env: {} }), "/h/.config/pi-yt/config.json");
	assert.equal(configPath({ home: "/h", env: { XDG_CONFIG_HOME: "/x" } }), "/x/pi-yt/config.json");
});

async function oldConfig(home: string, env: NodeJS.ProcessEnv, text: string) {
	const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
	const file = path.join(base, "gentle-shell-yt", "config.json");
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, text);
	return file;
}

// S24: an account saved under the old gentle-shell-yt folder is still found; the next write goes to pi-yt.
test("S24 readConfig falls back to the old gentle-shell-yt config and writeConfig targets pi-yt", async (t) => {
	const home = await fakeHome(t);
	for (const env of [{}, { XDG_CONFIG_HOME: path.join(home, "xdg") }] as NodeJS.ProcessEnv[]) {
		const oldText = JSON.stringify({ version: 1, account: { browser: "firefox", profile: "abc.default-release" } });
		const old = await oldConfig(home, env, oldText);
		assert.deepEqual(await readConfig({ home, env }), {
			version: 1,
			account: { browser: "firefox", profile: "abc.default-release" },
		});
		await writeConfig({ home, env }, { account: { browser: "chrome", profile: "Default" } });
		assert.deepEqual(JSON.parse(await readFile(configPath({ home, env }), "utf8")), {
			version: 1,
			account: { browser: "chrome", profile: "Default" },
		});
		assert.equal(await readFile(old, "utf8"), oldText, "the old file is left untouched");
		assert.deepEqual(await readConfig({ home, env }), { version: 1, account: { browser: "chrome", profile: "Default" } });
	}
});

// S24: when both exist the pi-yt config wins, even when it says "no account".
test("S24 the pi-yt config wins over the old one", async (t) => {
	const home = await fakeHome(t);
	await oldConfig(home, {}, JSON.stringify({ version: 1, account: { browser: "firefox", profile: "old" } }));
	await writeConfig({ home, env: {} }, { account: null });
	assert.deepEqual(await readConfig({ home, env: {} }), { version: 1, account: null });
});

// S24: an unusable old config reads as no account, not as a malformed pi-yt config.
test("S24 an invalid old config is ignored", async (t) => {
	const home = await fakeHome(t);
	await oldConfig(home, {}, "{not json");
	assert.deepEqual(await readConfig({ home, env: {} }), { version: 1, account: null });
});
