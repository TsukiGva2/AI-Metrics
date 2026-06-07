/**
 * Session Info Extension
 *
 * Exposes session identity and usage metrics (same data as the pi UI footer)
 * to both the LLM (via tools) and the user (via commands).
 *
 * Pi UI footer shows:
 *   <cwd> | <session name> | ⏣ <input>/<output>/<cache> tokens | $<cost> | █ <ctx%> | <model>
 *
 * Tools:
 *   get_session_id    — session UUID + file path
 *   usage_metrics     — aggregated token/cost/context usage (same as footer)
 *
 * Commands:
 *   /session-id       — show session UUID
 *   /metrics          — show usage metrics breakdown
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Typed usage info from assistant messages ─────────────────────────
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface AssistantMessage {
  role: "assistant";
  provider: string;
  model: string;
  usage?: Usage;
}

// ── Extension entry point ────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ── /session-id command ────────────────────────────────────────────
  pi.registerCommand("session-id", {
    description: "Show the current pi session ID",
    handler: async (_args, ctx) => {
      const id = getSessionId(ctx);
      const file = ctx.sessionManager.getSessionFile();

      if (id) {
        ctx.ui.notify(`Session ID: ${id}`, "info");
        if (file) {
          ctx.ui.notify(`File: ${file}`, "info");
        }
      } else {
        ctx.ui.notify("No session file (ephemeral mode)", "info");
      }
    },
  });

  // ── /metrics command ────────────────────────────────────────────────
  pi.registerCommand("metrics", {
    description: "Show aggregated usage metrics (tokens, cost, context, model)",
    handler: async (_args, ctx) => {
      const metrics = buildMetrics(pi, ctx);
      const lines = formatMetrics(metrics);
      for (const line of lines) {
        ctx.ui.notify(line, "info");
      }
    },
  });

  // ── get_session_id tool ─────────────────────────────────────────────
  pi.registerTool({
    name: "get_session_id",
    label: "Get Session ID",
    description:
      "Returns the current pi session UUID and session file path.",
    promptSnippet: "Return the current pi session identifier",
    promptGuidelines: [
      "Use get_session_id when the user asks what the current session ID is.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const id = getSessionId(ctx);
      const file = ctx.sessionManager.getSessionFile();

      if (id) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionId: id, sessionFile: file ?? null }, null, 2),
            },
          ],
          details: { sessionId: id },
        };
      }

      return {
        content: [{ type: "text", text: "No active session (ephemeral mode)." }],
        details: {},
      };
    },
  });

  // ── usage_metrics tool ──────────────────────────────────────────────
  pi.registerTool({
    name: "usage_metrics",
    label: "Usage Metrics",
    description:
      "Returns aggregated token usage, cost, context utilization, and current model — the same metrics shown in the pi UI footer.",
    promptSnippet: "Return aggregated usage metrics for the current session",
    promptGuidelines: [
      "Use usage_metrics when the user asks about token usage, cost, context usage, or session statistics.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const metrics = buildMetrics(pi, ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }],
        details: metrics,
      };
    },
  });
}

// ── Metrics data shape ────────────────────────────────────────────────
interface SessionMetrics {
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  cwd: string;
  model: { provider: string; id: string } | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  contextUsage: {
    tokens: number;
    maxTokens: number;
    percentage: number;
  } | null;
  turnCount: number;
  toolCallCount: number;
}

// ── Build metrics from session state ──────────────────────────────────
function buildMetrics(pi: ExtensionAPI, ctx: { sessionManager: { getSessionFile(): string | undefined; getEntries(): SessionEntry[]; getCwd(): string }; getContextUsage?(): { tokens: number; maxTokens: number } | undefined }): SessionMetrics {
  const entries = ctx.sessionManager.getEntries();
  const cwd = ctx.sessionManager.getCwd();
  const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
  const sessionId = parseSessionId(sessionFile);

  // Aggregate usage from all assistant messages
  let lastModel: { provider: string; id: string } | null = null;
  let turnCount = 0;
  let toolCallCount = 0;

  const totals: Required<Usage> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const msg = entry.message as AssistantMessage;
      turnCount++;
      lastModel = { provider: msg.provider, id: msg.model };

      if (msg.usage) {
        totals.input += msg.usage.input ?? 0;
        totals.output += msg.usage.output ?? 0;
        totals.cacheRead += msg.usage.cacheRead ?? 0;
        totals.cacheWrite += msg.usage.cacheWrite ?? 0;
        totals.totalTokens += msg.usage.totalTokens ?? 0;

        if (msg.usage.cost) {
          totals.cost.input += msg.usage.cost.input ?? 0;
          totals.cost.output += msg.usage.cost.output ?? 0;
          totals.cost.cacheRead += msg.usage.cost.cacheRead ?? 0;
          totals.cost.cacheWrite += msg.usage.cost.cacheWrite ?? 0;
          totals.cost.total += msg.usage.cost.total ?? 0;
        }
      }
    }

    // Count tool calls (toolResult messages)
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      toolCallCount++;
    }
  }

  // Context usage
  let contextUsage: SessionMetrics["contextUsage"] = null;
  try {
    const cu = ctx.getContextUsage?.();
    if (cu && cu.maxTokens > 0) {
      contextUsage = {
        tokens: cu.tokens,
        maxTokens: cu.maxTokens,
        percentage: Math.round((cu.tokens / cu.maxTokens) * 100),
      };
    }
  } catch {
    // getContextUsage may not be available in all contexts
  }

  return {
    sessionId,
    sessionFile,
    sessionName: pi.getSessionName() ?? null,
    cwd,
    model: lastModel,
    tokens: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      total: totals.totalTokens,
    },
    cost: { ...totals.cost },
    contextUsage,
    turnCount,
    toolCallCount,
  };
}

// ── Format metrics for human display ───────────────────────────────────
function formatMetrics(m: SessionMetrics): string[] {
  const lines: string[] = [];

  lines.push(`Session: ${m.sessionId ?? "ephemeral"}`);
  if (m.sessionName) lines.push(`Name:    ${m.sessionName}`);
  lines.push(`Dir:     ${m.cwd}`);

  if (m.model) {
    lines.push(`Model:   ${m.model.provider}/${m.model.id}`);
  }

  lines.push("");
  lines.push("── Tokens ──────────────────────");
  lines.push(`  Input        ${m.tokens.input.toLocaleString()}`);
  lines.push(`  Output       ${m.tokens.output.toLocaleString()}`);
  lines.push(`  Cache Read   ${m.tokens.cacheRead.toLocaleString()}`);
  lines.push(`  Cache Write  ${m.tokens.cacheWrite.toLocaleString()}`);
  lines.push(`  Total        ${m.tokens.total.toLocaleString()}`);

  lines.push("");
  lines.push("── Cost ────────────────────────");
  lines.push(`  Input        $${m.cost.input.toFixed(4)}`);
  lines.push(`  Output       $${m.cost.output.toFixed(4)}`);
  lines.push(`  Cache Read   $${m.cost.cacheRead.toFixed(4)}`);
  lines.push(`  Cache Write  $${m.cost.cacheWrite.toFixed(4)}`);
  lines.push(`  Total        $${m.cost.total.toFixed(4)}`);

  if (m.contextUsage) {
    const bar = contextBar(m.contextUsage.percentage);
    lines.push("");
    lines.push("── Context ─────────────────────");
    lines.push(`  ${bar} ${m.contextUsage.percentage}%`);
    lines.push(`  ${m.contextUsage.tokens.toLocaleString()} / ${m.contextUsage.maxTokens.toLocaleString()} tokens`);
  }

  lines.push("");
  lines.push(`  ${m.turnCount} assistant turns, ${m.toolCallCount} tool calls`);

  return lines;
}

function contextBar(pct: number): string {
  const filled = Math.round((pct / 100) * 20);
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

// ── Session ID helpers ────────────────────────────────────────────────
function getSessionId(ctx: { sessionManager: { getSessionFile(): string | undefined } }): string | null {
  return parseSessionId(ctx.sessionManager.getSessionFile() ?? null);
}

function parseSessionId(file: string | null): string | null {
  if (!file) return null;
  const basename = file.split("/").pop() ?? file;
  const match = basename.match(/_(?<uuid>[a-f0-9-]+)\.jsonl$/i);
  return match?.groups?.uuid ?? null;
}
