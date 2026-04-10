/**
 * Continue Command Extension
 *
 * Adds a /continue command as an alias for /resume.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("continue", {
		description: "Continue a previous session (alias for /resume)",
		handler: async (_args, ctx) => {
			const sessions = await SessionManager.list(ctx.cwd);
			if (sessions.length === 0) {
				ctx.ui.notify("No previous sessions found", "info");
				return;
			}

			const labels = sessions.map((s) => s.name ?? s.firstMessage ?? s.path);

			const choice = await ctx.ui.select("Pick a session to continue:", labels);
			if (choice === null || choice === undefined) return;

			const index = labels.indexOf(choice);
			if (index < 0) return;

			await ctx.switchSession(sessions[index].path);
		},
	});
}
