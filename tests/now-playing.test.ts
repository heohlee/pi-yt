import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNowPlaying, formatTime, sanitize } from "../lib/now-playing.ts";

const base = { title: "Aruarian Dance", artist: "Nujabes", elapsed: 80, duration: 252 };

test("S1 playing line", () => {
	assert.equal(formatNowPlaying({ status: "playing", ...base }), "♪ Aruarian Dance · Nujabes · 1:20/4:12");
});

test("S2 paused line", () => {
	assert.equal(formatNowPlaying({ status: "paused", ...base }), "⏸ Aruarian Dance · Nujabes · 1:20/4:12");
});

test("S3 idle clears the status", () => {
	assert.equal(formatNowPlaying({ status: "idle" }), undefined);
	assert.equal(formatNowPlaying({ status: "idle", ...base }), undefined);
});

test("S4 needs sign-in line", () => {
	assert.equal(formatNowPlaying({ status: "signin" }), "youtube · sign in again · /yt");
});

test("S5 missing artist, duration and title", () => {
	assert.equal(formatNowPlaying({ status: "playing", ...base, artist: undefined }), "♪ Aruarian Dance · 1:20/4:12");
	assert.equal(formatNowPlaying({ status: "playing", ...base, artist: "  " }), "♪ Aruarian Dance · 1:20/4:12");
	assert.equal(
		formatNowPlaying({ status: "playing", ...base, duration: undefined }),
		"♪ Aruarian Dance · Nujabes · 1:20",
	);
	assert.equal(
		formatNowPlaying({ status: "playing", ...base, duration: Number.NaN }),
		"♪ Aruarian Dance · Nujabes · 1:20",
	);
	assert.equal(formatNowPlaying({ status: "playing", ...base, title: undefined }), "♪ YouTube · Nujabes · 1:20/4:12");
	assert.equal(formatNowPlaying({ status: "playing", ...base, title: "" }), "♪ YouTube · Nujabes · 1:20/4:12");
});

test("S5 time formatting", () => {
	assert.equal(formatTime(0), "0:00");
	assert.equal(formatTime(5), "0:05");
	assert.equal(formatTime(80.9), "1:20");
	assert.equal(formatTime(3599), "59:59");
	assert.equal(formatTime(3600), "1:00:00");
	assert.equal(formatTime(3733), "1:02:13");
	assert.equal(formatTime(-12), "0:00");
	assert.equal(formatTime(Number.NaN), "0:00");
	assert.equal(formatNowPlaying({ status: "playing", ...base, elapsed: -3 }), "♪ Aruarian Dance · Nujabes · 0:00/4:12");
	assert.equal(
		formatNowPlaying({ status: "playing", ...base, elapsed: Number.NaN }),
		"♪ Aruarian Dance · Nujabes · 0:00/4:12",
	);
});

test("S6 title and artist are sanitized", () => {
	assert.equal(sanitize("  Aruarian\r\n\tDance \u0007  x  "), "Aruarian Dance x");
	assert.equal(
		formatNowPlaying({ status: "playing", ...base, title: "Aruarian\nDance\u0000", artist: "\tNujabes\r" }),
		"♪ Aruarian Dance · Nujabes · 1:20/4:12",
	);
});
