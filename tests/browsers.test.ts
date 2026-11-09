import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BROWSER_IDS, browserLabel, cookieArg, detectBrowsers, isBrowserId } from "../lib/browsers.ts";

async function fakeHome(t: { after: (fn: () => Promise<void>) => void }) {
	const home = await mkdtemp(path.join(os.tmpdir(), "gsyt-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

async function writeProfilesIni(home: string, content: string, opened: string[] = []) {
	const dir = path.join(home, ".mozilla", "firefox");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "profiles.ini"), content);
	for (const folder of opened) await openedProfile(path.resolve(dir, folder));
}

// A Firefox profile that was opened at least once has a prefs.js.
async function openedProfile(folder: string) {
	await mkdir(folder, { recursive: true });
	await writeFile(path.join(folder, "prefs.js"), "");
}

async function writeLocalState(home: string, dir: string, state: unknown, folders: string[]) {
	const root = path.join(home, ".config", dir);
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, "Local State"), typeof state === "string" ? state : JSON.stringify(state));
	for (const folder of folders) await mkdir(path.join(root, folder), { recursive: true });
}

// S3: no browsers on a clean home.
test("detectBrowsers returns nothing for an empty home", async (t) => {
	const home = await fakeHome(t);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), []);
});

// S3/S4: the [Install*] Default= profile wins over Default=1 and is listed first.
test("firefox profiles.ini prefers the Install default over Default=1", async (t) => {
	const home = await fakeHome(t);
	await writeProfilesIni(
		home,
		[
			"[Profile1]",
			"Name=default",
			"IsRelative=1",
			"Path=abcd.default",
			"Default=1",
			"",
			"[Profile0]",
			"Name=default-release",
			"IsRelative=1",
			"Path=wxyz.default-release",
			"",
			"[General]",
			"StartWithLastProfile=1",
			"Version=2",
			"",
			"[Install4F96D1932A9F858E]",
			"Default=wxyz.default-release",
			"Locked=1",
			"",
		].join("\n"),
		["abcd.default", "wxyz.default-release"],
	);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{
			id: "firefox",
			label: "Firefox",
			profileName: "default-release",
			profile: path.join(home, ".mozilla", "firefox", "wxyz.default-release"),
		},
		{
			id: "firefox",
			label: "Firefox",
			profileName: "default",
			profile: path.join(home, ".mozilla", "firefox", "abcd.default"),
		},
	]);
});

// S3: without an Install section the Default=1 profile comes first.
test("firefox profiles.ini falls back to Default=1", async (t) => {
	const home = await fakeHome(t);
	await writeProfilesIni(
		home,
		"[Profile0]\r\nName=work\r\nPath=a.work\r\n\r\n[Profile1]\r\nName=personal\r\nPath=b.personal\r\nDefault=1\r\n",
		["a.work", "b.personal"],
	);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{
			id: "firefox",
			label: "Firefox",
			profileName: "personal",
			profile: path.join(home, ".mozilla", "firefox", "b.personal"),
		},
		{ id: "firefox", label: "Firefox", profileName: "work", profile: path.join(home, ".mozilla", "firefox", "a.work") },
	]);
});

// S3: chromium-family browsers are detected by their Default profile directory, in fixed order.
test("chromium, chrome and brave are detected by the Default directory", async (t) => {
	const home = await fakeHome(t);
	await writeProfilesIni(home, "[Profile0]\nName=default-release\nPath=x.default-release\nDefault=1\n", [
		"x.default-release",
	]);
	await mkdir(path.join(home, ".config", "BraveSoftware", "Brave-Browser", "Default"), { recursive: true });
	await mkdir(path.join(home, ".config", "chromium", "Default"), { recursive: true });
	await mkdir(path.join(home, ".config", "google-chrome", "Default"), { recursive: true });
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{
			id: "firefox",
			label: "Firefox",
			profileName: "default-release",
			profile: path.join(home, ".mozilla", "firefox", "x.default-release"),
		},
		{ id: "chromium", label: "Chromium", profileName: "Default", profile: "Default" },
		{ id: "chrome", label: "Chrome", profileName: "Default", profile: "Default" },
		{ id: "brave", label: "Brave", profileName: "Default", profile: "Default" },
	]);
});

// S3: a browser config dir without a Default profile is not offered.
test("a chromium dir without Default is ignored", async (t) => {
	const home = await fakeHome(t);
	await mkdir(path.join(home, ".config", "chromium", "Profile 1"), { recursive: true });
	assert.deepEqual(await detectBrowsers({ home, env: {} }), []);
});

// S4: yt-dlp BROWSER:PROFILE syntax.
test("cookieArg uses yt-dlp BROWSER:PROFILE syntax", () => {
	assert.equal(cookieArg({ id: "firefox", profile: "default-release" }), "firefox:default-release");
	assert.equal(cookieArg({ id: "chromium", profile: "Default" }), "chromium:Default");
	assert.equal(browserLabel("brave"), "Brave");
	assert.equal(browserLabel("chrome"), "Chrome");
});

// S4 (verify B1): yt-dlp needs the profile folder, not the display Name; absolute Path is kept as is.
test("firefox profile is the folder yt-dlp reads, relative or absolute", async (t) => {
	const home = await fakeHome(t);
	const elsewhere = path.join(home, "data", "ff", "elsewhere");
	await writeProfilesIni(
		home,
		`[Profile0]\nName=default-release\nIsRelative=1\nPath=abcd1234.default-release\nDefault=1\n\n[Profile1]\nName=elsewhere\nIsRelative=0\nPath=${elsewhere}\n`,
		["abcd1234.default-release", elsewhere],
	);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{
			id: "firefox",
			label: "Firefox",
			profileName: "default-release",
			profile: path.join(home, ".mozilla", "firefox", "abcd1234.default-release"),
		},
		{ id: "firefox", label: "Firefox", profileName: "elsewhere", profile: elsewhere },
	]);
});

// S3 (verify F3): Firefox 147+ keeps profiles under $XDG_CONFIG_HOME/mozilla/firefox.
test("firefox profiles under the XDG config dir are detected", async (t) => {
	const home = await fakeHome(t);
	const dir = path.join(home, "cfg", "mozilla", "firefox");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "profiles.ini"),
		"[Profile0]\nName=default-release\nIsRelative=1\nPath=q.default-release\nDefault=1\n",
	);
	await openedProfile(path.join(dir, "q.default-release"));
	assert.deepEqual(await detectBrowsers({ home, env: { XDG_CONFIG_HOME: path.join(home, "cfg") } }), [
		{ id: "firefox", label: "Firefox", profileName: "default-release", profile: path.join(dir, "q.default-release") },
	]);
});

// S4 (verify F1): a profile yt-dlp or mpv would split (",", "::") is not offered.
test("firefox profiles with a comma or :: are skipped", async (t) => {
	const home = await fakeHome(t);
	await writeProfilesIni(
		home,
		"[Profile0]\nName=bad\nIsRelative=1\nPath=a,exec=x\n\n[Profile1]\nName=bad2\nIsRelative=1\nPath=b::c\n\n[Profile2]\nName=ok\nIsRelative=1\nPath=c.ok\n",
		["a,exec=x", "b::c", "c.ok"],
	);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "firefox", label: "Firefox", profileName: "ok", profile: path.join(home, ".mozilla", "firefox", "c.ok") },
	]);
});

// S12: a Firefox profile that was never opened (no prefs.js) is hidden.
test("firefox profiles without prefs.js are hidden", async (t) => {
	const home = await fakeHome(t);
	await writeProfilesIni(
		home,
		"[Profile0]\nName=default-release\nIsRelative=1\nPath=r.default-release\n\n[Profile1]\nName=default\nIsRelative=1\nPath=d.default\nDefault=1\n",
		["r.default-release"],
	);
	await mkdir(path.join(home, ".mozilla", "firefox", "d.default"), { recursive: true });
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{
			id: "firefox",
			label: "Firefox",
			profileName: "default-release",
			profile: path.join(home, ".mozilla", "firefox", "r.default-release"),
		},
	]);
});

// S12: every Local State profile whose folder exists, Default first, then natural folder order, with its name.
test("chromium profiles come from Local State in natural order, skipping missing folders", async (t) => {
	const home = await fakeHome(t);
	const info_cache = {
		"Profile 10": { name: "Ten" },
		"Profile 2": { name: "Two" },
		Default: { name: "Personal" },
		"Profile 1": { name: "Work" },
		"Profile 3": { name: "Gone" },
	};
	await writeLocalState(home, "google-chrome", { profile: { info_cache } }, [
		"Default",
		"Profile 1",
		"Profile 2",
		"Profile 10",
	]);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "chrome", label: "Chrome", profileName: "Personal", profile: "Default" },
		{ id: "chrome", label: "Chrome", profileName: "Work", profile: "Profile 1" },
		{ id: "chrome", label: "Chrome", profileName: "Two", profile: "Profile 2" },
		{ id: "chrome", label: "Chrome", profileName: "Ten", profile: "Profile 10" },
	]);
});

// S12: the display name loses control characters, is trimmed and capped at 40; a missing name falls back to the folder.
test("chromium profile names are sanitized and capped", async (t) => {
	const home = await fakeHome(t);
	const info_cache = {
		Default: { name: "  Wo\u001b[31mrk\u0007\n " },
		"Profile 1": { name: "x".repeat(60) },
		"Profile 2": { name: 42 },
		"Profile 3": {},
	};
	await writeLocalState(home, "chromium", { profile: { info_cache } }, [
		"Default",
		"Profile 1",
		"Profile 2",
		"Profile 3",
	]);
	assert.deepEqual(
		(await detectBrowsers({ home, env: {} })).map((b) => b.profileName),
		["Wo[31mrk", "x".repeat(40), "Profile 2", "Profile 3"],
	);
});

// S4/S12: only info_cache.<dir>.name is used; account fields never leave detection.
test("Local State account fields never appear in the detected browsers", async (t) => {
	const home = await fakeHome(t);
	const state = {
		account_info: [{ email: "secret@example.com" }],
		profile: {
			last_used: "secret-last-used",
			info_cache: {
				Default: {
					name: "Personal",
					user_name: "secret@example.com",
					gaia_name: "Secret Person",
					gaia_id: "secret-id",
				},
			},
		},
	};
	await writeLocalState(home, path.join("BraveSoftware", "Brave-Browser"), state, ["Default"]);
	const found = await detectBrowsers({ home, env: {} });
	assert.deepEqual(found, [{ id: "brave", label: "Brave", profileName: "Personal", profile: "Default" }]);
	assert.ok(!JSON.stringify(found).includes("secret"));
	assert.ok(!JSON.stringify(found).includes("Secret"));
});

// S12: a missing, malformed or info_cache-less Local State falls back to the Default folder.
test("chromium falls back to Default when Local State is missing or malformed", async (t) => {
	const home = await fakeHome(t);
	await writeLocalState(home, "chromium", "{not json", ["Default", "Profile 1"]);
	await writeLocalState(home, "google-chrome", { profile: {} }, ["Default", "Profile 1"]);
	await mkdir(path.join(home, ".config", "BraveSoftware", "Brave-Browser", "Default"), { recursive: true });
	await mkdir(path.join(home, ".config", "BraveSoftware", "Brave-Browser", "Profile 1"), { recursive: true });
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "chromium", label: "Chromium", profileName: "Default", profile: "Default" },
		{ id: "chrome", label: "Chrome", profileName: "Default", profile: "Default" },
		{ id: "brave", label: "Brave", profileName: "Default", profile: "Default" },
	]);
});

// S4/S12: a Chromium profile folder yt-dlp or mpv would split is not offered.
test("chromium profile folders with a comma or :: are skipped", async (t) => {
	const home = await fakeHome(t);
	const info_cache = { "Profile,1": { name: "Bad" }, "Profile::2": { name: "Bad2" }, Default: { name: "Ok" } };
	await writeLocalState(home, "chromium", { profile: { info_cache } }, ["Default", "Profile,1", "Profile::2"]);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "chromium", label: "Chromium", profileName: "Ok", profile: "Default" },
	]);
});

// S12 (verify follow-up): a Local State that lists no usable profile still offers an existing Default.
test("chromium falls back to Default when info_cache lists no usable profile", async (t) => {
	const home = await fakeHome(t);
	await writeLocalState(home, "chromium", { profile: { info_cache: {} } }, ["Default"]);
	await writeLocalState(home, "google-chrome", { profile: { info_cache: { "Profile 9": { name: "Gone" } } } }, [
		"Default",
	]);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "chromium", label: "Chromium", profileName: "Default", profile: "Default" },
		{ id: "chrome", label: "Chrome", profileName: "Default", profile: "Default" },
	]);
});

// S4 (verify follow-up): folder names yt-dlp would mis-parse ("", ":x", surrounding spaces) are never offered.
test("chromium folders that yt-dlp would mis-parse are skipped", async (t) => {
	const home = await fakeHome(t);
	const info = {
		"": { name: "Empty" },
		":x": { name: "Colon" },
		" lead": { name: "Lead" },
		"trail ": { name: "Trail" },
		"Profile 1": { name: "Ok" },
	};
	await writeLocalState(home, "chromium", { profile: { info_cache: info } }, [":x", " lead", "trail ", "Profile 1"]);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "chromium", label: "Chromium", profileName: "Ok", profile: "Profile 1" },
	]);
});

async function writeZenProfiles(root: string, content: string, opened: string[] = []) {
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, "profiles.ini"), content);
	for (const folder of opened) await openedProfile(path.resolve(root, folder));
}

// S13: Zen reads profiles.ini under ~/.config/zen, then ~/.zen, with the Firefox rules (prefs.js, Install default first).
test("zen profiles come from ~/.config/zen then ~/.zen", async (t) => {
	const home = await fakeHome(t);
	const config = path.join(home, ".config", "zen");
	const legacy = path.join(home, ".zen");
	await writeZenProfiles(
		config,
		"[Profile0]\nName=Work\nIsRelative=1\nPath=w.Work\n\n[Profile1]\nName=Default (release)\nIsRelative=1\nPath=r.Default (release)\n\n[Profile2]\nName=Unused\nIsRelative=1\nPath=u.Unused\n\n[Install1]\nDefault=r.Default (release)\n",
		["w.Work", "r.Default (release)"],
	);
	await mkdir(path.join(config, "u.Unused"), { recursive: true });
	await writeZenProfiles(legacy, "[Profile0]\nName=Old\nIsRelative=1\nPath=o.Old\nDefault=1\n", ["o.Old"]);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "zen", label: "Zen", profileName: "Default (release)", profile: path.join(config, "r.Default (release)") },
		{ id: "zen", label: "Zen", profileName: "Work", profile: path.join(config, "w.Work") },
		{ id: "zen", label: "Zen", profileName: "Old", profile: path.join(legacy, "o.Old") },
	]);
});

// S13: Zen under $XDG_CONFIG_HOME/zen and the Flatpak roots (zen, then .zen), in that order.
test("zen profiles come from XDG config and both Flatpak roots", async (t) => {
	const home = await fakeHome(t);
	const xdg = path.join(home, "cfg", "zen");
	const flatpak = path.join(home, ".var", "app", "app.zen_browser.zen");
	await writeZenProfiles(xdg, "[Profile0]\nName=Xdg\nPath=x.Xdg\n", ["x.Xdg"]);
	await writeZenProfiles(path.join(flatpak, ".zen"), "[Profile0]\nName=FlatOld\nPath=b.FlatOld\n", ["b.FlatOld"]);
	await writeZenProfiles(path.join(flatpak, "zen"), "[Profile0]\nName=FlatNew\nPath=a.FlatNew\n", ["a.FlatNew"]);
	// Ignored: XDG_CONFIG_HOME replaces ~/.config.
	await writeZenProfiles(path.join(home, ".config", "zen"), "[Profile0]\nName=Hidden\nPath=h.Hidden\n", ["h.Hidden"]);
	assert.deepEqual(await detectBrowsers({ home, env: { XDG_CONFIG_HOME: path.join(home, "cfg") } }), [
		{ id: "zen", label: "Zen", profileName: "Xdg", profile: path.join(xdg, "x.Xdg") },
		{ id: "zen", label: "Zen", profileName: "FlatNew", profile: path.join(flatpak, "zen", "a.FlatNew") },
		{ id: "zen", label: "Zen", profileName: "FlatOld", profile: path.join(flatpak, ".zen", "b.FlatOld") },
	]);
});

// S13: Helium profiles come from its Local State; the profile is the absolute folder yt-dlp reads as a path.
test("helium profiles come from Local State with absolute folders", async (t) => {
	const home = await fakeHome(t);
	const root = path.join(home, ".config", "net.imput.helium");
	const info_cache = {
		"Profile 2": { name: "Two" },
		Default: { name: "Personal" },
		"Profile 1": {},
		"Profile 3": { name: "Gone" },
	};
	await writeLocalState(home, "net.imput.helium", { profile: { info_cache } }, ["Default", "Profile 1", "Profile 2"]);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "helium", label: "Helium", profileName: "Personal", profile: path.join(root, "Default") },
		{ id: "helium", label: "Helium", profileName: "Profile 1", profile: path.join(root, "Profile 1") },
		{ id: "helium", label: "Helium", profileName: "Two", profile: path.join(root, "Profile 2") },
	]);
});

// S13: without Local State Helium falls back to its Default folder, as an absolute path.
test("helium falls back to the absolute Default folder without Local State", async (t) => {
	const home = await fakeHome(t);
	const root = path.join(home, "cfg", "net.imput.helium");
	await mkdir(path.join(root, "Default"), { recursive: true });
	await mkdir(path.join(root, "Profile 1"), { recursive: true });
	assert.deepEqual(await detectBrowsers({ home, env: { XDG_CONFIG_HOME: path.join(home, "cfg") } }), [
		{ id: "helium", label: "Helium", profileName: "Default", profile: path.join(root, "Default") },
	]);
});

// S13: display order is firefox, zen, chromium, chrome, brave, helium.
test("browsers are listed in a fixed order across every family", async (t) => {
	const home = await fakeHome(t);
	for (const dir of ["net.imput.helium", path.join("BraveSoftware", "Brave-Browser"), "google-chrome", "chromium"]) {
		await mkdir(path.join(home, ".config", dir, "Default"), { recursive: true });
	}
	await writeZenProfiles(path.join(home, ".zen"), "[Profile0]\nName=z\nPath=z.z\n", ["z.z"]);
	await writeProfilesIni(home, "[Profile0]\nName=f\nPath=f.f\n", ["f.f"]);
	assert.deepEqual(
		(await detectBrowsers({ home, env: {} })).map((b) => b.id),
		["firefox", "zen", "chromium", "chrome", "brave", "helium"],
	);
	assert.deepEqual(BROWSER_IDS, ["firefox", "zen", "chromium", "chrome", "brave", "helium"]);
});

// S13: Zen is passed as a Firefox profile path and Helium as a Chromium profile path.
test("cookieArg maps zen to firefox and helium to chromium", () => {
	assert.equal(cookieArg({ id: "zen", profile: "/h/.zen/a.Default (release)" }), "firefox:/h/.zen/a.Default (release)");
	assert.equal(
		cookieArg({ id: "helium", profile: "/h/.config/net.imput.helium/Default" }),
		"chromium:/h/.config/net.imput.helium/Default",
	);
	assert.equal(browserLabel("zen"), "Zen");
	assert.equal(browserLabel("helium"), "Helium");
	assert.equal(isBrowserId("zen"), true);
	assert.equal(isBrowserId("helium"), true);
});

// S4 (verify A2): Helium's absolute profile path is filtered as a whole, like Firefox and Zen.
test("helium profiles under a config dir with a comma are skipped", async (t) => {
	const home = await fakeHome(t);
	const cfg = path.join(home, "a,b");
	const root = path.join(cfg, "net.imput.helium");
	await mkdir(path.join(root, "Default"), { recursive: true });
	await writeFile(
		path.join(root, "Local State"),
		JSON.stringify({ profile: { info_cache: { Default: { name: "You" } } } }),
	);
	assert.deepEqual(
		(await detectBrowsers({ home, env: { XDG_CONFIG_HOME: cfg } })).filter((b) => b.id === "helium"),
		[],
	);
});

// Advisory S18: Firefox profile names are sanitized and capped like Chromium's; an empty name falls back to the folder.
test("firefox profile names are sanitized and capped", async (t) => {
	const home = await fakeHome(t);
	await writeProfilesIni(
		home,
		`[Profile0]\nName=Wo\u001b[31mrk\u0007\nIsRelative=1\nPath=a.work\nDefault=1\n\n[Profile1]\nName=${"x".repeat(60)}\nIsRelative=1\nPath=b.long\n\n[Profile2]\nName=\u0007\nIsRelative=1\nPath=c.blank\n`,
		["a.work", "b.long", "c.blank"],
	);
	assert.deepEqual(
		(await detectBrowsers({ home, env: {} })).map((b) => b.profileName),
		["Wo[31mrk", "x".repeat(40), "c.blank"],
	);
});

// Advisory S13: detection offers only profiles that a saved config would accept.
test("firefox profiles with a relative non-plain folder are skipped", async (t) => {
	const home = await fakeHome(t);
	await writeProfilesIni(
		home,
		"[Profile0]\nName=out\nIsRelative=0\nPath=../outside\n\n[Profile1]\nName=ok\nIsRelative=1\nPath=c.ok\n",
		["../outside", "c.ok"],
	);
	assert.deepEqual(await detectBrowsers({ home, env: {} }), [
		{ id: "firefox", label: "Firefox", profileName: "ok", profile: path.join(home, ".mozilla", "firefox", "c.ok") },
	]);
});
