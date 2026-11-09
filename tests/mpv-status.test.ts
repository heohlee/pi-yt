import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveSocketPath, startMpvStatus } from "../lib/mpv-status.ts";

type Timer = { id: number; at: number; fn: () => void };

function fakeClock() {
	let now = 0;
	let nextId = 1;
	const timers: Timer[] = [];
	return {
		now: () => now,
		setTimeout: (fn: () => void, ms: number) => {
			const timer = { id: nextId++, at: now + ms, fn };
			timers.push(timer);
			return timer.id;
		},
		clearTimeout: (id: unknown) => {
			const i = timers.findIndex((t) => t.id === id);
			if (i >= 0) timers.splice(i, 1);
		},
		pending: () => timers.map((t) => t.at - now),
		advance(ms: number) {
			now += ms;
			for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
				if (timer.at > now) continue;
				const i = timers.indexOf(timer);
				if (i < 0) continue;
				timers.splice(i, 1);
				timer.fn();
			}
		},
	};
}

async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

async function fakeMpv() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "gsyt-"));
	const socketPath = path.join(dir, "mpv.sock");
	const clients: net.Socket[] = [];
	const received: string[] = [];
	let connections = 0;
	const server = net.createServer((socket) => {
		connections++;
		clients.push(socket);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => received.push(...chunk.split("\n").filter(Boolean)));
		socket.on("error", () => {});
	});
	await new Promise<void>((r) => server.listen(socketPath, r));
	const latest = () => clients[clients.length - 1];
	return {
		socketPath,
		received,
		connections: () => connections,
		send(name: string, data: unknown) {
			latest().write(`${JSON.stringify({ event: "property-change", id: 1, name, data })}\n`);
		},
		raw(line: string) {
			latest().write(line);
		},
		dropClients() {
			for (const c of clients) c.destroy();
		},
		async close() {
			for (const c of clients) c.destroy();
			await new Promise<void>((r) => server.close(() => r()));
			await rm(dir, { recursive: true, force: true });
		},
	};
}

async function setup() {
	const mpv = await fakeMpv();
	const clock = fakeClock();
	const calls: Array<string | undefined> = [];
	const handle = startMpvStatus({
		socketPath: mpv.socketPath,
		setStatus: (text) => calls.push(text),
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	await waitFor(() => mpv.connections() === 1 && mpv.received.length >= 6, "observe_property commands");
	const playing = async () => {
		mpv.send("idle-active", false);
		mpv.send("pause", false);
		mpv.send("metadata", { uploader: "Nujabes" });
		mpv.send("duration", 252);
		mpv.send("time-pos", 80.2);
		mpv.send("media-title", "Aruarian Dance");
		await waitFor(() => calls.includes("♪ Aruarian Dance · Nujabes · 1:20/4:12"), "playing line");
	};
	const teardown = async () => {
		handle.stop();
		await mpv.close();
	};
	return { mpv, clock, calls, handle, playing, teardown };
}

test("resolveSocketPath honours env override, XDG_RUNTIME_DIR, then tmpdir", () => {
	assert.equal(resolveSocketPath({ PI_YT_MPV_SOCKET: "/x/y.sock", XDG_RUNTIME_DIR: "/run/u" }), "/x/y.sock");
	assert.equal(resolveSocketPath({ XDG_RUNTIME_DIR: "/run/u" }), "/run/u/pi-yt/mpv.sock");
	assert.equal(resolveSocketPath({}), path.join(os.tmpdir(), "pi-yt", "mpv.sock"));
});

test("observes the six mpv properties", async () => {
	const { mpv, teardown } = await setup();
	try {
		const names = mpv.received.map((line) => JSON.parse(line).command);
		assert.deepEqual(
			names.map((c: unknown[]) => [c[0], c[2]]),
			["pause", "media-title", "metadata", "time-pos", "duration", "idle-active"].map((n) => ["observe_property", n]),
		);
		assert.equal(new Set(names.map((c: unknown[]) => c[1])).size, 6);
	} finally {
		await teardown();
	}
});

test("S1/S2/S3/S7 playing, pause immediately, then idle clears", async () => {
	const { mpv, calls, playing, teardown } = await setup();
	try {
		await playing();
		const start = calls.length - 1;
		mpv.raw('{"request_id":0,"error":"success"}\nnot json\n');
		mpv.send("pause", true);
		await waitFor(() => calls.includes("⏸ Aruarian Dance · Nujabes · 1:20/4:12"), "paused line");
		mpv.send("idle-active", true);
		await waitFor(() => calls.length === start + 3, "idle clear");
		assert.deepEqual(calls.slice(start), [
			"♪ Aruarian Dance · Nujabes · 1:20/4:12",
			"⏸ Aruarian Dance · Nujabes · 1:20/4:12",
			undefined,
		]);
		// No duplicate consecutive publishes anywhere.
		for (let i = 1; i < calls.length; i++) assert.notEqual(calls[i], calls[i - 1]);
	} finally {
		await teardown();
	}
});

test("S3 media-title null means idle", async () => {
	const { mpv, calls, playing, teardown } = await setup();
	try {
		await playing();
		mpv.send("media-title", null);
		await waitFor(() => calls[calls.length - 1] === undefined, "idle clear");
	} finally {
		await teardown();
	}
});

test("S7 elapsed ticks publish at most once every 5 seconds", async () => {
	const { mpv, clock, calls, playing, teardown } = await setup();
	try {
		await playing();
		const before = calls.length;
		clock.advance(1000);
		mpv.send("time-pos", 81.1);
		clock.advance(1000);
		mpv.send("time-pos", 82.1);
		clock.advance(2900);
		mpv.send("time-pos", 85.0);
		// Flush: a structural change proves earlier lines were processed.
		mpv.send("metadata", { uploader: "Nujabes", album: "Modal Soul" });
		mpv.send("pause", false);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(calls.length, before, "ticks within 5s must not publish");
		clock.advance(100);
		mpv.send("time-pos", 85.2);
		await waitFor(() => calls.length === before + 1, "tick after 5s");
		assert.equal(calls[calls.length - 1], "♪ Aruarian Dance · Nujabes · 1:25/4:12");
		// Same text again (sub-second tick) is never re-published, even after 5s.
		clock.advance(6000);
		mpv.send("time-pos", 85.7);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(calls.length, before + 1);
	} finally {
		await teardown();
	}
});

test("S7 structural change publishes immediately even inside the 5s window", async () => {
	const { mpv, clock, calls, playing, teardown } = await setup();
	try {
		await playing();
		clock.advance(1000);
		mpv.send("time-pos", 81.3);
		mpv.send("media-title", "Feather");
		await waitFor(() => calls[calls.length - 1] === "♪ Feather · Nujabes · 1:21/4:12", "new title");
	} finally {
		await teardown();
	}
});

test("S3 socket close clears status and reconnects after 5s", async () => {
	const { mpv, clock, calls, playing, teardown } = await setup();
	try {
		await playing();
		mpv.dropClients();
		await waitFor(() => calls[calls.length - 1] === undefined, "clear on close");
		await waitFor(() => clock.pending().includes(5000), "reconnect timer");
		const clears = calls.length;
		clock.advance(4999);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(mpv.connections(), 1);
		clock.advance(1);
		await waitFor(() => mpv.connections() === 2, "reconnect");
		await waitFor(() => mpv.received.length >= 12, "re-observe");
		await playing();
		assert.equal(calls.slice(clears - 1).filter((c) => c === undefined).length, 1);
	} finally {
		await teardown();
	}
});

test("S3 connect failure clears once and retries every 5s", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "gsyt-"));
	const clock = fakeClock();
	const calls: Array<string | undefined> = [];
	const handle = startMpvStatus({
		socketPath: path.join(dir, "missing.sock"),
		setStatus: (text) => calls.push(text),
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	try {
		await waitFor(() => clock.pending().includes(5000), "first retry timer");
		clock.advance(5000);
		await waitFor(() => clock.pending().includes(5000), "second retry timer");
		assert.deepEqual(calls, [undefined]);
		handle.stop();
		assert.deepEqual(clock.pending(), []);
	} finally {
		handle.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("setStatus throwing never escapes", async () => {
	const mpv = await fakeMpv();
	const clock = fakeClock();
	const handle = startMpvStatus({
		socketPath: mpv.socketPath,
		setStatus: () => {
			throw new Error("ui gone");
		},
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	try {
		await waitFor(() => mpv.received.length >= 6, "observe");
		mpv.send("media-title", "Aruarian Dance");
		mpv.send("idle-active", false);
		await new Promise((r) => setTimeout(r, 30));
	} finally {
		handle.stop();
		await mpv.close();
	}
});

test("stop cancels timers and closes the socket", async () => {
	const { mpv, clock, handle, playing, teardown } = await setup();
	try {
		await playing();
		handle.stop();
		await new Promise((r) => setTimeout(r, 30));
		assert.deepEqual(clock.pending(), []);
		assert.equal(mpv.connections(), 1);
	} finally {
		await teardown();
	}
});

// S24: PI_YT_MPV_SOCKET, then <runtime>/pi-yt/mpv.sock.
test("S24 resolveSocketPath prefers PI_YT_MPV_SOCKET", () => {
	assert.equal(resolveSocketPath({ PI_YT_MPV_SOCKET: "/new.sock", XDG_RUNTIME_DIR: "/run/u" }), "/new.sock");
	assert.equal(resolveSocketPath({ XDG_RUNTIME_DIR: "/run/u" }), "/run/u/pi-yt/mpv.sock");
});
