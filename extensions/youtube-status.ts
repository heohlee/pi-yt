import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSocketPath, startMpvStatus, type MpvStatusHandle } from "../lib/mpv-status.ts";

const STATUS_KEY = "youtube";

export default function (pi: ExtensionAPI) {
	let handle: MpvStatusHandle | undefined;

	const stop = () => {
		handle?.stop();
		handle = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		if (!ctx.hasUI) return;
		try {
			handle = startMpvStatus({
				socketPath: resolveSocketPath(),
				setStatus: (text) => {
					try {
						ctx.ui.setStatus(STATUS_KEY, text);
					} catch {
						// Status is cosmetic.
					}
				},
			});
		} catch {
			handle = undefined;
		}
	});

	pi.on("session_shutdown", () => {
		stop();
	});
}
