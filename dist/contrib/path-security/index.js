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
import { createLogger } from "../../lib/logger.js";
import { onEvent } from "../../lib/event-types.js";
import { getExtensionState } from "../../lib/extension-state.js";
import { vetWriteOperation, vetBashCommand } from "./vet-filter.js";
const log = createLogger("path-security");
// ── Tool classification ──────────────────────────────────────────────────────
const READ_ONLY_TOOLS = new Set([
    "read", "grep", "find", "ls",
    "render_pdf_page", "read_document", "analyze_image",
    "file_diff", "codebase_graph", "codebase_tree",
]);
const WRITE_TOOLS = new Set(["write", "edit"]);
function createState() {
    return { vetCount: 0, tierCounts: { utility: 0, session: 0, heuristic: 0 }, blockedCount: 0 };
}
// ── Extension ────────────────────────────────────────────────────────────────
export default function pathSecurityExtension(pi) {
    onEvent(pi, "tool_call", async (event, ctx) => {
        const toolName = event?.toolName ?? "";
        const input = (event?.input ?? {});
        const cwd = ctx.cwd ?? process.cwd();
        // ── Read-only tools: no restriction ─────────────────────────────────
        if (READ_ONLY_TOOLS.has(toolName))
            return;
        // ── Write tools: vetted ─────────────────────────────────────────────
        if (WRITE_TOOLS.has(toolName)) {
            const filePath = (input?.path ?? input?.filePath ?? input?.target ?? "");
            if (!filePath)
                return;
            const result = await vetWriteOperation(toolName, filePath, cwd, ctx);
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
            const command = (input?.command ?? "");
            if (!command)
                return;
            const result = await vetBashCommand(command, cwd, ctx);
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
function recordVet(ctx, result) {
    try {
        const state = getExtensionState(ctx, "path-security", createState);
        state.vetCount++;
        if (result.tier === "utility")
            state.tierCounts.utility++;
        else if (result.tier === "session")
            state.tierCounts.session++;
        else
            state.tierCounts.heuristic++;
        if (!result.safe)
            state.blockedCount++;
    }
    catch { /* non-fatal */ }
}
// ── Steer Helpers ────────────────────────────────────────────────────────────
async function sendBlockWhisper(ctx, toolName, filePath) {
    try {
        ctx.whisper?.(`Blocked ${toolName}: path outside allowed directories`, { category: "cognitive", priority: "low" });
    }
    catch { /* non-fatal */ }
}
async function sendBashBlockWhisper(ctx, command) {
    try {
        ctx.whisper?.(`Bash blocked: command classified as dangerous`, { category: "cognitive", priority: "low" });
    }
    catch { /* non-fatal */ }
}
//# sourceMappingURL=index.js.map