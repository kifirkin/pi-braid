/**
 * Observatory Extension — lightweight, self-contained session inspector:
 * a passive recorder + read-only inspector with no external daemon dependency.
 *
 * What it does:
 *   - PASSIVELY records session lifecycle events (session_start,
 *     session_shutdown) to JSONL files under ~/.pi/observatory/. Recording
 *     is OPT-IN via `braid.contrib.observatory.record: true` (default off).
 *   - EXPOSES a `observatory` tool with three read-only actions:
 *       status  — current session state (model, cwd, tool/extension count)
 *       tools   — list all registered tools with active/disabled status
 *       events  — tail the recorded JSONL log (most recent N events)
 *
 * What it does NOT do (use pi-braid's full observatory for these):
 *   - Real-time WebSocket streaming to a 3D viz dashboard
 *   - Cross-session aggregation with metrics over time
 *   - Hot-path tracing of tool calls (we only record lifecycle)
 *
 * Storage: ~/.pi/observatory/sessions/*.jsonl  (one file per session-id
 * or "default" if no session id is exposed). Rotation: capped at
 * MAX_EVENTS_PER_SESSION events (oldest dropped). Recordings are never
 * sent anywhere — only written to local disk for later inspection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";
import { registerSessionStartHandler, SessionPhase } from "pi-braid/lib";

const log = createLogger("observatory");

const OBSERVATORY_DIR = path.join(os.homedir(), ".pi", "observatory");
const SESSIONS_DIR = path.join(OBSERVATORY_DIR, "sessions");
const MAX_EVENTS_PER_SESSION = 5000; // tail-cap; oldest dropped if exceeded

interface ContribSettings {
  braid?: {
    contrib?: {
      observatory?: boolean | { record?: boolean; maxEvents?: number };
    };
  };
}

function readObservatorySettings(): {
  enabled: boolean; // is the extension enabled (extension-level toggle)
  record: boolean; // should we write events to disk
  maxEvents: number; // cap
} {
  // Read settings.json once; observ is the only extension that does this
  // (other extensions rely on index.ts registry passing settings in).
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let parsed: ContribSettings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    // ignored — default to false
  }
  const obs = parsed.braid?.contrib?.observatory;
  // Default: enabled but no recording (privacy-conscious default)
  if (obs === undefined || obs === true) {
    return { enabled: true, record: false, maxEvents: MAX_EVENTS_PER_SESSION };
  }
  if (obs === false) {
    return { enabled: false, record: false, maxEvents: MAX_EVENTS_PER_SESSION };
  }
  // Object form
  return {
    enabled: true,
    record: obs.record === true,
    maxEvents: obs.maxEvents ?? MAX_EVENTS_PER_SESSION,
  };
}

type EventKind =
  | "session_start"
  | "session_shutdown"
  | "tool_call"
  | "turn_complete";

interface ObservatoryEvent {
  ts: number;
  kind: EventKind;
  sessionId: string;
  [key: string]: unknown;
}

function appendEvent(event: ObservatoryEvent, maxEvents: number): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const sessionKey = event.sessionId || "default";
    const file = path.join(
      SESSIONS_DIR,
      `${sanitizeForFilename(sessionKey)}.jsonl`,
    );
    const line = JSON.stringify(event) + "\n";

    fs.appendFileSync(file, line, "utf-8");

    // Cheap cap: read all lines, keep tail. Cheap up to a few MB.
    if (maxEvents > 0) {
      const stat = fs.statSync(file);
      // Only check if file is > 5 MB to avoid constant truncation
      if (stat.size > 5 * 1024 * 1024) {
        const lines = fs
          .readFileSync(file, "utf-8")
          .split("\n")
          .filter(Boolean);
        const tail = lines.slice(-maxEvents);
        fs.writeFileSync(file, tail.join("\n") + "\n", "utf-8");
      } else {
        const lines = fs
          .readFileSync(file, "utf-8")
          .split("\n")
          .filter(Boolean);
        if (lines.length > maxEvents) {
          const tail = lines.slice(-maxEvents);
          fs.writeFileSync(file, tail.join("\n") + "\n", "utf-8");
        }
      }
    }
  } catch (e) {
    log.warn(`[observatory] failed to append event: ${(e as Error).message}`);
  }
}

function sanitizeForFilename(s: string): string {
  // Session ids can contain "/" or other path-hostile chars
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "default";
}

function resolveSessionId(ctx: ExtensionContext): string {
  // The SDK doesn't expose a session-id string explicitly; use cwd + start time
  // as a stable per-session key. Good enough for grouping events locally.
  const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
  const start = Math.floor(Date.now() / 1000).toString(36);
  return `${path.basename(cwd)}-${start}`;
}

function tailEvents(n: number): ObservatoryEvent[] {
  const out: ObservatoryEvent[] = [];
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return out;
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const f of files) {
      if (out.length >= n) break;
      const content = fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8");
      const lines = content.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        try {
          out.push(JSON.parse(lines[i]));
        } catch {
          // Tolerant reader: a corrupt line is skipped, not fatal.
        }
      }
    }
  } catch (e) {
    log.warn(`[observatory] tailEvents failed: ${(e as Error).message}`);
  }
  return out.reverse();
}

const observatorySchema = Type.Object({
  action: Type.Union(
    [Type.Literal("status"), Type.Literal("tools"), Type.Literal("events")],
    { default: "status", description: "status | tools | events" },
  ),
  limit: Type.Optional(
    Type.Integer({
      description:
        "For events action: how many recent events to return (default: 20, max: 200)",
    }),
  ),
});

export default function observatoryExtension(pi: ExtensionAPI): void {
  const settings = readObservatorySettings();
  if (!settings.enabled) {
    log.info("Observatory disabled via braid.contrib.observatory setting.");
    return;
  }

  const sessionId = `pending-${Date.now().toString(36)}`;
  let resolvedSessionId = sessionId;

  // Recorder: session_start
  if (settings.record) {
    registerSessionStartHandler(
      pi,
      SessionPhase.MemoryState,
      async (event: unknown, ctx: ExtensionContext) => {
        resolvedSessionId = resolveSessionId(ctx);
        appendEvent(
          {
            ts: Date.now(),
            kind: "session_start",
            sessionId: resolvedSessionId,
            cwd: ctx.cwd,
            model: (event as { model?: unknown })?.model ?? null,
            ev: event,
          },
          settings.maxEvents,
        );
      },
    );

    // Recorder: session_shutdown
    pi.on("session_shutdown", async () => {
      appendEvent(
        {
          ts: Date.now(),
          kind: "session_shutdown",
          sessionId: resolvedSessionId,
        },
        settings.maxEvents,
      );
    });

    log.info(
      `Observatory recording enabled. Events written to ${SESSIONS_DIR} (cap ${settings.maxEvents}/session).`,
    );
  } else {
    log.info(
      "Observatory loaded (recording disabled). Set braid.contrib.observatory.record: true in ~/.pi/agent/settings.json to enable.",
    );
  }

  pi.registerTool({
    name: "observatory",
    exposure: "deferred",
    label: "Observatory",
    promptSnippet:
      "Inspect pi session state and recorded events (read-only, self-contained)",
    description:
      "Inspect the current pi session (status, registered tools, recorded events). " +
      "Self-contained — no daemon required. " +
      "Recording opt-in: braid.contrib.observatory.record. " +
      "For real-time 3D viz, use pi-braid's observatory.",
    parameters: observatorySchema,
    execute: async (
      _toolCallId: string,
      params: Static<typeof observatorySchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      const action = (params.action as string) ?? "status";

      if (action === "status") {
        const cwd = ctx.cwd ?? process.cwd();
        let toolCount = 0;
        try {
          toolCount = pi.getAllTools().length;
        } catch {
          // some extensions may not expose this; ignore
        }
        const sessionsDir = settings.record
          ? SESSIONS_DIR
          : "(recording disabled)";
        const text =
          `📊 Observatory Status\n` +
          `\n` +
          `- Session: ${resolvedSessionId}\n` +
          `- CWD: ${cwd}\n` +
          `- Registered tools: ${toolCount}\n` +
          `- Recording: ${settings.record ? "enabled" : "disabled"}\n` +
          `- Record path: ${sessionsDir}\n` +
          `- Record cap: ${settings.maxEvents} events/session`;
        return {
          content: [{ type: "text" as const, text }],
          details: { resolvedSessionId, cwd, toolCount, settings },
        };
      }

      if (action === "tools") {
        let tools: Array<{ name: string; description?: string }> = [];
        try {
          tools = pi
            .getAllTools()
            .map((t) => ({ name: t.name, description: t.description }));
        } catch {
          // pi API surface mismatch — report zero tools rather than failing
          // the whole status report.
        }
        if (tools.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "(no tools reported by the runtime)",
              },
            ],
            details: { tools: [] },
          };
        }
        const lines = ["# Registered Tools", ""];
        for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
          lines.push(
            `- \`${t.name}\`${t.description ? ` — ${t.description.slice(0, 60)}…` : ""}`,
          );
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { tools },
        };
      }

      if (action === "events") {
        if (!settings.record) {
          return {
            content: [
              {
                type: "text" as const,
                text: "ℹ️ Recording is disabled. Enable with: `braid.contrib.observatory.record: true` in ~/.pi/agent/settings.json.",
              },
            ],
            details: {},
          };
        }
        const requested = Math.min(
          (params.limit as number | undefined) ?? 20,
          200,
        );
        const events = tailEvents(requested);
        if (events.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "(no events recorded yet)" },
            ],
            details: { events: [] },
          };
        }
        const lines = [`# Last ${events.length} events`, ""];
        for (const ev of events) {
          const when = new Date(ev.ts).toISOString().slice(11, 19); // HH:MM:SS
          lines.push(`- \`${when}\` **${ev.kind}** — ${ev.sessionId}`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { events },
        };
      }

      return {
        content: [
          { type: "text" as const, text: `❌ Unknown action: ${action}` },
        ],
        details: {},
      };
    },
  });

  log.info("Observatory extension registered (self-contained, no daemon).");
}
