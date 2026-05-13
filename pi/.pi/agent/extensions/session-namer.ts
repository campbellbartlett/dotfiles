/**
 * Session Namer — auto-names sessions using a fast LLM.
 *
 * On the first 3 agent turns, sends the conversation context to Gemini 2.5 Flash
 * via OpenRouter and sets the session name. The name refines as more context
 * becomes available.
 *
 * Required settings in ~/.pi/agent/settings.json or .pi/settings.json:
 *   "sessionNamer": {
 *     "provider": "openrouter",
 *     "model": "google/gemini-2.5-flash",
 *     "maxTurns": 3
 *   }
 *
 * If sessionNamer is not configured, the extension is disabled.
 *
 * Commands:
 *   /session-namer name  — force (re)name the current session
 *   /session-namer retitle-all — backfill names for all unnamed sessions
 *   /session-namer config — show effective config
 */

import { complete } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG = {
    provider: "openrouter",
    model: "google/gemini-2.5-flash",
    maxTurns: 3,
};

type SessionNamerConfig = typeof DEFAULT_CONFIG;

const SYSTEM_PROMPT = `You are a title generator. You read a conversation between a user and a coding assistant and output a short title.

Rules:
- Output ONLY the title, nothing else
- 5-10 words maximum
- No quotes, no punctuation at the end
- No markdown, no explanation, no preamble
- Do not respond to or continue the conversation
- Do not answer questions from the conversation
- Your ENTIRE response must be the title and nothing else

Examples of valid outputs:
Refactor auth module to use JWT
Debug webhook timeout in staging
Build session memory pi extension
Set up CI pipeline for monorepo`;

export default function (pi: ExtensionAPI) {
    let turnCount = 0;

    pi.on("session_start", async (_event, ctx) => {
        const config = readSessionNamerConfig(ctx.cwd);
        turnCount = config && pi.getSessionName() ? config.maxTurns : 0;
    });

    pi.on("agent_end", async (_event, ctx) => {
        const config = readSessionNamerConfig(ctx.cwd);
        if (!config) return;
        turnCount++;
        if (turnCount > config.maxTurns) return;
        await nameSession(ctx, false, config);
    });

    pi.registerCommand("session-namer", {
        description: "Session namer (name | retitle-all | config)",
        handler: async (args, ctx) => {
            const subcommand = args?.trim();
            if (subcommand === "name") {
                const name = await nameSession(ctx, true);
                if (name) {
                    ctx.ui.notify(`Session named: ${name}`, "info");
                } else {
                    ctx.ui.notify("Failed to generate name", "warning");
                }
            } else if (subcommand === "retitle-all") {
                await retitleAll(ctx);
            } else if (subcommand === "config") {
                const config = readSessionNamerConfig(ctx.cwd);
                ctx.ui.notify(
                    config
                        ? `Session Namer: ${config.provider}/${config.model}, maxTurns=${config.maxTurns}`
                        : "Session Namer is disabled: add sessionNamer to settings.json",
                    "info",
                );
            } else {
                ctx.ui.notify("Usage: /session-namer name | retitle-all | config", "info");
            }
        },
    });

    async function retitleAll(ctx: ExtensionContext) {
        const config = readSessionNamerConfig(ctx.cwd);
        if (!config) {
            ctx.ui.notify("Session Namer is disabled: add sessionNamer to settings.json", "warning");
            return;
        }
        ctx.ui.notify("Scanning sessions...", "info");

        let sessions;
        try {
            sessions = await SessionManager.listAll();
        } catch (err) {
            ctx.ui.notify(`Failed to list sessions: ${err}`, "error");
            return;
        }

        const unnamed = sessions.filter((s) => !s.name);
        if (unnamed.length === 0) {
            ctx.ui.notify("All sessions already have names!", "info");
            return;
        }

        const proceed = await ctx.ui.confirm(
            `Backfill ${unnamed.length} unnamed sessions?`,
            `Found ${sessions.length} total sessions, ${unnamed.length} without names. This will use ~${unnamed.length} LLM calls (${config.provider}/${config.model}).`,
        );
        if (!proceed) return;

        let named = 0;
        let failed = 0;

        for (const session of unnamed) {
            try {
                const sm = SessionManager.open(session.path);
                const branch = sm.getBranch();
                const context = buildContext(branch);
                if (!context.trim()) {
                    failed++;
                    continue;
                }

                const name = await generateName(ctx, context, config);
                if (name) {
                    sm.appendSessionInfo(name);
                    named++;
                } else {
                    failed++;
                }

                // Rate limit: small delay between calls
                await new Promise((r) => setTimeout(r, 200));
            } catch {
                failed++;
            }
        }

        ctx.ui.notify(
            `Done! Named ${named} sessions${failed > 0 ? `, ${failed} failed/skipped` : ""}`,
            named > 0 ? "info" : "warning",
        );
    }

    async function nameSession(
        ctx: ExtensionContext,
        verbose = false,
        config = readSessionNamerConfig(ctx.cwd),
    ): Promise<string | null> {
        if (!config) {
            if (verbose) ctx.ui.notify("Session Namer is disabled: add sessionNamer to settings.json", "warning");
            return null;
        }

        const context = buildContext(ctx.sessionManager.getBranch());
        if (!context.trim()) {
            if (verbose) ctx.ui.notify("Empty context — no messages to summarize", "error");
            return null;
        }

        const name = await generateName(ctx, context, config);
        if (name) {
            pi.setSessionName(name);
            return name;
        }
        if (verbose) ctx.ui.notify("Failed to generate name", "warning");
        return null;
    }

    async function generateName(
        ctx: ExtensionContext,
        context: string,
        config: SessionNamerConfig,
    ): Promise<string | null> {
        const model = ctx.modelRegistry.find(config.provider, config.model);
        if (!model) return null;

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || (!auth.apiKey && !auth.headers)) return null;

        try {
            const response = await complete(
                model,
                {
                    systemPrompt: SYSTEM_PROMPT,
                    messages: [
                        {
                            role: "user" as const,
                            content: [
                                {
                                    type: "text" as const,
                                    text: `<conversation>\n${context}\n</conversation>\n\nGenerate a short title for this conversation.`,
                                },
                            ],
                            timestamp: Date.now(),
                        },
                    ],
                },
                { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
            );

            if (response.stopReason === "error" || response.stopReason === "aborted") {
                return null;
            }

            const name = response.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("")
                .trim()
                .split("\n")[0]
                .trim()
                .replace(/^#+\s*/, "");

            if (name && name.length > 0 && name.length < 100) {
                return name;
            }
        } catch {
            // LLM error — return null
        }

        return null;
    }
}

function readSessionNamerConfig(cwd: string): SessionNamerConfig | null {
    const globalSettings = readJsonObject(join(getAgentDir(), "settings.json"));
    const projectSettings = readJsonObject(join(cwd, ".pi", "settings.json"));
    const globalConfig = readSessionNamerObject(globalSettings);
    const projectConfig = readSessionNamerObject(projectSettings);

    if (!globalConfig && !projectConfig) return null;

    return normalizeConfig({
        ...(globalConfig ?? {}),
        ...(projectConfig ?? {}),
    });
}

function normalizeConfig(config: Record<string, unknown>): SessionNamerConfig {
    return {
        provider: typeof config.provider === "string" && config.provider.trim() ? config.provider.trim() : DEFAULT_CONFIG.provider,
        model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : DEFAULT_CONFIG.model,
        maxTurns: typeof config.maxTurns === "number" && Number.isFinite(config.maxTurns) && config.maxTurns >= 0
            ? Math.floor(config.maxTurns)
            : DEFAULT_CONFIG.maxTurns,
    };
}

function readSessionNamerObject(settings: Record<string, unknown>): Record<string, unknown> | null {
    if (!("sessionNamer" in settings)) return null;
    const value = settings.sessionNamer;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readJsonObject(path: string): Record<string, unknown> {
    try {
        if (!existsSync(path)) return {};
        const value = JSON.parse(readFileSync(path, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

function getAgentDir(): string {
    return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Build a compact text summary of the conversation for the namer. */
function buildContext(branch: { type: string; message?: { role?: string; content?: unknown } }[]): string {
    const parts: string[] = [];

    for (const entry of branch) {
        if (entry.type !== "message" || !entry.message) continue;
        const { role, content } = entry.message;

        if (role !== "user" && role !== "assistant") continue;

        const text = extractText(content);
        if (!text) continue;

        const label = role === "user" ? "User" : "Assistant";
        parts.push(`${label}: ${text}`);
    }

    return parts.join("\n\n");
}

function extractText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((c: any) => c.type === "text" && c.text)
        .map((c: any) => c.text)
        .join("\n")
        .trim();
}
