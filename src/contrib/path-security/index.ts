/**
 * Path-Security Extension — Filesystem boundary enforcement.
 *
 * **Philosophy:** Reading is harmless — read-only tools are unrestricted.
 * Writes and bash commands are vetted by a three-tier classifier:
 * utility model → session model → heuristic (regex/allowlist fallback).
 *
 * This is a CONTRIB extension — peripheral, not cognitive architecture.
 * It can be disabled with BRAID_MODULES="-contrib" or toggled individually.
 *
 * @module path-security
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../lib/core/logger.js";
import { onEvent } from "../../lib/events/event-types.js";
import { getExtensionState } from "../../lib/state/extension-state.js";
import { vetWriteOperation, vetBashCommand, type VetResult } from "./vet-filter.js";

const log = createLogger("path-security");

// ── Tool classification ──────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "render_pdf_page",
  "read_document",
  "analyze_image",
  "file_diff",
  "codebase_graph",
  "codebase_tree",
]);

const WRITE_TOOLS = new Set(["write", "edit"]);

// ── State: tier tracking ─────────────────────────────────────────────────────

interface PathSecurityState {
  vetCount: number;
  tierCounts: { utility: number; session: number; heuristic: number };
  blockedCount: number;
}

function createState(): PathSecurityState {
  return { vetCount: 0, tierCounts: { utility: 0, session: 0, heuristic: 0 }, blockedCount: 0 };
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function pathSecurityExtension(pi: ExtensionAPI): void {
  onEvent(pi, "tool_call", async (event: any, ctx: ExtensionContext) => {
    const toolName: string = event?.toolName ?? "";
    const input = (event?.input ?? {}) as Record<string, unknown>;
    const cwd: string = (ctx as { cwd?: string }).cwd ?? process.cwd();

    // ── Read-only tools: no restriction ─────────────────────────────────
    if (READ_ONLY_TOOLS.has(toolName)) return;

    // ── Write tools: vetted ─────────────────────────────────────────────
    if (WRITE_TOOLS.has(toolName)) {
      const filePath = (input?.path ?? input?.filePath ?? input?.target ?? "") as string;
      if (!filePath) return;

      const result: VetResult = await vetWriteOperation(toolName, filePath, cwd, ctx);
      recordVet(ctx, result);

      if (!result.safe) {
        log.warn(`[path-security] BLOCKED ${toolName}: ${filePath} (${result.tier})`);
        await sendBlockWhisper(ctx, toolName, filePath);
        return { block: true, reason: "write blocked: path outside allowed directories" };
      }
      return;
    }

    // ── Bash: vetted ────────────────────────────────────────────────────
    if (toolName === "bash") {
      const command = (input?.command ?? "") as string;
      if (!command) return;

      const result: VetResult = await vetBashCommand(command, cwd, ctx);
      recordVet(ctx, result);

      if (!result.safe) {
        log.warn(`[path-security] BLOCKED bash (${result.tier}): ${command.slice(0, 100)}`);
        await sendBashBlockWhisper(ctx, command);
        return { block: true, reason: `bash blocked: classified as dangerous (${result.tier})` };
      }
      return;
    }
  });

  log.info("[path-security] loaded — vetted (utility model + heuristic fallback)");
}

// ── State tracking ───────────────────────────────────────────────────────────

function recordVet(ctx: ExtensionContext, result: VetResult): void {
  try {
    const state = getExtensionState(ctx, "path-security", createState);
    state.vetCount++;
    if (result.tier === "utility") state.tierCounts.utility++;
    else if (result.tier === "session") state.tierCounts.session++;
    else state.tierCounts.heuristic++;
    if (!result.safe) state.blockedCount++;
  } catch {
    /* non-fatal */
  }
}

// ── Steer Helpers ────────────────────────────────────────────────────────────

async function sendBlockWhisper(
  ctx: ExtensionContext,
  toolName: string,
  _filePath: string,
): Promise<void> {
  try {
    ctx.whisper?.(`Blocked ${toolName}: path outside allowed directories`, {
      category: "cognitive",
      priority: "low",
    });
  } catch {
    /* non-fatal */
  }
}

async function sendBashBlockWhisper(ctx: ExtensionContext, _command: string): Promise<void> {
  try {
    ctx.whisper?.(`Bash blocked: command classified as dangerous`, {
      category: "cognitive",
      priority: "low",
    });
  } catch {
    /* non-fatal */
  }
}
