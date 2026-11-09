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
