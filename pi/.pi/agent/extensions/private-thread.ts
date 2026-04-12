/**
 * Private Thread Extension
 *
 * /private    -> stop writing the current thread to the session file
 * /no-private -> write the current in-memory thread back to history
 *
 * Notes:
 * - In normal sessions, private mode keeps the current session in memory but disables disk persistence.
 * - /no-private re-enables persistence and rewrites the session file with the full in-memory history.
 * - If pi was started with --no-session, /no-private creates a new persisted session and copies the
 *   current branch into it.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionManager } from "@mariozechner/pi-coding-agent";

type ReadonlySessionManagerLike = Pick<
	SessionManager,
	"getBranch" | "isPersisted" | "getSessionFile"
>;

function isPrivate(ctx: ExtensionContext | ExtensionCommandContext): boolean {
	return !ctx.sessionManager.isPersisted();
}

function getSessionFile(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
	return ctx.sessionManager.getSessionFile();
}

function setPersisted(ctx: ExtensionContext | ExtensionCommandContext, persisted: boolean): void {
	(ctx.sessionManager as SessionManager & { persist: boolean }).persist = persisted;
}

function rewriteSessionFile(ctx: ExtensionContext | ExtensionCommandContext): void {
	(ctx.sessionManager as SessionManager & { _rewriteFile: () => void })._rewriteFile();
}

function updateStatus(ctx: ExtensionContext | ExtensionCommandContext): void {
	if (isPrivate(ctx)) {
		ctx.ui.setStatus(
			"private-thread",
			ctx.ui.theme.fg("warning", "◐ private") + ctx.ui.theme.fg("dim", " not saved to history"),
		);
	} else {
		ctx.ui.setStatus("private-thread", ctx.ui.theme.fg("dim", "○ public"));
	}
}

async function copyBranchToNewSession(source: ReadonlySessionManagerLike, target: SessionManager): Promise<void> {
	for (const entry of source.getBranch()) {
		switch (entry.type) {
			case "message": {
				target.appendMessage((entry as any).message);
				break;
			}
			case "thinking_level_change": {
				target.appendThinkingLevelChange((entry as any).thinkingLevel);
				break;
			}
			case "model_change": {
				target.appendModelChange((entry as any).provider, (entry as any).modelId);
				break;
			}
			case "compaction": {
				const e = entry as any;
				target.appendCompaction(e.summary, e.firstKeptEntryId, e.tokensBefore, e.details, e.fromHook);
				break;
			}
			case "custom_message": {
				const e = entry as any;
				target.appendCustomMessageEntry(e.customType, e.content, e.display, e.details);
				break;
			}
			case "session_info": {
				const name = (entry as any).name;
				if (name) target.appendSessionInfo(name);
				break;
			}
			case "branch_summary": {
				// No direct append API for branch summaries. Skip when materializing an ephemeral branch
				// into a fresh persisted session.
				break;
			}
			default:
				break;
		}
	}
}

export default function privateThreadExtension(pi: ExtensionAPI): void {
	async function enablePrivateMode(ctx: ExtensionCommandContext): Promise<void> {
		if (isPrivate(ctx)) {
			ctx.ui.notify("Private mode is already on", "info");
			updateStatus(ctx);
			return;
		}

		setPersisted(ctx, false);
		updateStatus(ctx);
		ctx.ui.notify("Private mode enabled. New messages in this thread will not be written to history.", "success");
	}

	async function disablePrivateMode(ctx: ExtensionCommandContext): Promise<void> {
		if (!isPrivate(ctx)) {
			ctx.ui.notify("Private mode is already off", "info");
			updateStatus(ctx);
			return;
		}

		const existingSessionFile = getSessionFile(ctx);
		if (existingSessionFile) {
			setPersisted(ctx, true);
			rewriteSessionFile(ctx);
			updateStatus(ctx);
			ctx.ui.notify(`Private mode disabled. Thread saved to history: ${existingSessionFile}`, "success");
			return;
		}

		const snapshot = ctx.sessionManager;
		const result = await ctx.newSession({
			setup: async (sessionManager) => {
				await copyBranchToNewSession(snapshot, sessionManager);
			},
		});

		if (result.cancelled) {
			ctx.ui.notify("Could not persist private thread", "warning");
			return;
		}
	}

	pi.registerCommand("private", {
		description: "Turn on private mode for the current thread (don't write new messages to history)",
		handler: async (_args, ctx) => {
			await enablePrivateMode(ctx);
		},
	});

	pi.registerCommand("no-private", {
		description: "Turn off private mode and save the current private thread to history",
		handler: async (_args, ctx) => {
			await disablePrivateMode(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("private-thread", undefined);
	});
}
