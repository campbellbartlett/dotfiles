/**
 * Exit Command Extension
 *
 * Adds /exit as an alias for the built-in /quit command.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
