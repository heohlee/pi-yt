import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import extension from "../extensions/youtube-status.ts";

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	return {
		pi: { on: (name: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(name, fn) },
		emit: (name: string, ctx: unknown) => handlers.get(name)?.({ type: name }, ctx),
	};
}

test("extension does nothing headless and starts/stops cleanly with UI", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "gsyt-"));
	const previous = process.env.PI_YT_MPV_SOCKET;
	process.env.PI_YT_MPV_SOCKET = path.join(dir, "missing.sock");
	try {
		const { pi, emit } = fakePi();
		extension(pi as never);
		const calls: Array<[string, string | undefined]> = [];
		const ctx = { hasUI: true, ui: { setStatus: (k: string, t?: string) => calls.push([k, t]) } };
		emit("session_start", { hasUI: false, ui: { setStatus: () => assert.fail("headless must not touch UI") } });
		emit("session_start", ctx);
		emit("session_start", ctx);
		await new Promise((r) => setTimeout(r, 50));
		emit("session_shutdown", ctx);
		assert.ok(calls.length >= 1);
		assert.ok(calls.every(([k, t]) => k === "youtube" && t === undefined));
	} finally {
		if (previous === undefined) delete process.env.PI_YT_MPV_SOCKET;
		else process.env.PI_YT_MPV_SOCKET = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
