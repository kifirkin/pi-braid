/**
 * Path-Security Extension — tiered security classification with opt-in blocking.
 *
 * Flow:
 *
 *   1. Heuristic runs (fast, no LLM).
 *   2. If heuristic is ambiguous, the LLM judge runs.
 *   3. If the result is "dangerous" (heuristic-yes or LLM-yes):
 *        - Always WHISPER a warning to the user (visibility).
 *        - HARD BLOCK only if `braid.contrib.pathSecurity.block: true` is set.
 *   4. Default behavior is "soft warn" — the operation is allowed, the
 *      user sees a low-priority whisper, and the session continues.
 *
 * This means: dangerous operations are never silently allowed (the user
 * always sees a whisper) but they're also not silently blocked — a hard block
 * on a heuristic yes breaks legitimate workflows, so blocking is opt-in.
 *
 * Settings:
 *   braid.contrib.pathSecurity: false → entire extension disabled
 *   braid.contrib.pathSecurity: true → enabled, soft-warn only
 *   braid.contrib.pathSecurity: { block: true } → enabled, hard block
 *
 * Three-tier classifier (heuristic → utility model → session model) lives
 * in vet-filter.ts. This file is the orchestrator.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";
import { onEvent, getExtensionState } from "pi-braid/lib";
import {
  vetWriteOperation,
  vetBashCommand,
  type VetResult,
} from "./vet-filter.js";

const log = createLogger("path-security");

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "describe_image",
  "document_parse",
  "document_search",
  "document_screenshot",
  "file_diff",
  "codebase", // consolidated tool (was codebase_graph, codebase_tree)
  "observatory",
  "repl",
  "healthcheck",
  "system_monitor",
  "sleep",
]);

const WRITE_TOOLS = new Set(["write", "edit"]);

interface PathSecuritySettings {
  enabled: boolean;
  block: boolean; // hard-block on dangerous; default false (soft-warn only)
}

function readPathSecuritySettings(): PathSecuritySettings {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let parsed: { braid?: { contrib?: { pathSecurity?: unknown } } } = {};
  try {
    if (fs.existsSync(settingsPath)) {
      parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    // ignored — default to soft-warn
  }
  const ps = parsed.braid?.contrib?.pathSecurity;
  if (ps === undefined || ps === true) {
    return { enabled: true, block: false };
  }
  if (ps === false) {
    return { enabled: false, block: false };
  }
  if (typeof ps === "object" && ps !== null) {
    return { enabled: true, block: (ps as { block?: boolean }).block === true };
  }
  return { enabled: true, block: false };
}

// State: tier tracking

interface PathSecurityState {
  vetCount: number;
  tierCounts: {
    utility: number;
    session: number;
    heuristic: number;
    skipped: number;
  };
  warnCount: number;
  blockCount: number;
}

function createState(): PathSecurityState {
  return {
    vetCount: 0,
    tierCounts: { utility: 0, session: 0, heuristic: 0, skipped: 0 },
    warnCount: 0,
    blockCount: 0,
  };
}

function recordVet(
  ctx: ExtensionContext,
  result: VetResult,
  blocked: boolean,
): void {
  try {
    const state = getExtensionState(ctx, "path-security", createState);
    state.vetCount++;
    if (result.tier === "utility") state.tierCounts.utility++;
    else if (result.tier === "session") state.tierCounts.session++;
    else if (result.tier === "skipped") state.tierCounts.skipped++;
    else state.tierCounts.heuristic++;
    if (!result.safe) state.warnCount++;
    if (blocked) state.blockCount++;
  } catch {
    // Counters are advisory diagnostics — a mis-shaped vet result must not
    // break the path check that produced it.
  }
}

function describeVet(toolName: string, result: VetResult): string {
  const verdict = result.safe ? "SAFE" : "DANGEROUS";
  const tier = result.tier;
  const h = result.heuristicVerdict;
  const llm = result.llmVerdict ? `, LLM=${result.llmVerdict}` : "";
  return `[path-security] ${verdict} (${tier}, heuristic=${h}${llm}) ${toolName}: ${result.reason}`;
}

async function sendWarnWhisper(
  ctx: ExtensionContext,
  toolName: string,
  result: VetResult,
  commandOrPath: string,
): Promise<void> {
  try {
    const preview =
      commandOrPath.length > 80
        ? commandOrPath.slice(0, 80) + "…"
        : commandOrPath;
    const msg = `⚠ ${toolName}: ${result.reason} — \`${preview}\``;
    // ctx.whisper is not on the current pi ExtensionContext type.
    // Keep the original optional-call surface (a silent no-op when absent)
    // rather than switching to a changed runtime API.
    (
      ctx as ExtensionContext & {
        whisper?: (
          msg: string,
          opts?: { category?: string; priority?: string },
        ) => void;
      }
    ).whisper?.(msg, { category: "cognitive", priority: "low" });
  } catch {
    // The advisory whisper is optional UI; the security verdict it decorates
    // has already been applied and must not be reverted on UI failure.
  }
}

export default function pathSecurityExtension(pi: ExtensionAPI): void {
  const settings = readPathSecuritySettings();
  if (!settings.enabled) {
    log.info(
      "[path-security] disabled via settings (braid.contrib.pathSecurity: false).",
    );
    return;
  }

  const mode = settings.block ? "hard-block" : "soft-warn";
  log.info(
    `[path-security] loaded — heuristic → LLM judge → ${mode} ` +
      `(set braid.contrib.pathSecurity.block: true to enable hard blocking).`,
  );

  onEvent(pi, "tool_call", async (event: unknown, ctx: ExtensionContext) => {
    const e = event as { toolName?: string; input?: Record<string, unknown> };
    const toolName: string = e?.toolName ?? "";
    const input = e?.input ?? {};
    const cwd: string = (ctx as { cwd?: string }).cwd ?? process.cwd();

    // Read-only tools: no restriction
    if (READ_ONLY_TOOLS.has(toolName)) return;

    // Write tools: vetted
    if (WRITE_TOOLS.has(toolName)) {
      const filePath = (input?.path ??
        input?.filePath ??
        input?.target ??
        "") as string;
      if (!filePath) return;

      const result = await vetWriteOperation(toolName, filePath, cwd, ctx);
      recordVet(ctx, result, false);

      if (!result.safe) {
        log.warn(describeVet(toolName, result));
        await sendWarnWhisper(ctx, toolName, result, filePath);
        if (settings.block) {
          recordVet(ctx, result, true);
          return { block: true, reason: `path-security: ${result.reason}` };
        }
      }
      return;
    }

    // Bash: vetted
    if (toolName === "bash") {
      const command = (input?.command ?? "") as string;
      if (!command) return;

      const result = await vetBashCommand(command, cwd, ctx);
      recordVet(ctx, result, false);

      if (!result.safe) {
        log.warn(describeVet(toolName, result));
        await sendWarnWhisper(ctx, toolName, result, command);
        if (settings.block) {
          recordVet(ctx, result, true);
          return { block: true, reason: `path-security: ${result.reason}` };
        }
      }
      return;
    }
  });
}
