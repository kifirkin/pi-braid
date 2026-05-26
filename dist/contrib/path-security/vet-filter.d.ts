/**
 * Vet Filter — Utility-model security classification for path-security.
 *
 * Each check is a lightweight yes/no classification call. The utility model
 * "vets" (evaluates) tool operations for safety before execution.
 *
 * Three-tier fallback: utility model → session model → heuristic.
 * Heuristics are the current regex/allowlist logic, preserved as graceful
 * degradation — they fire only when no model is available or times out.
 *
 * Parallel to roast-filter.ts in input-polisher, but for security instead
 * of text quality. "Roast" critiques quality; "vet" checks security.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
export interface VetResult {
    safe: boolean;
    tier: "utility" | "session" | "heuristic";
}
/**
 * Vet a file write/edit operation for safety.
 *
 * Three-tier: utility model → session model → heuristic (allowlist check).
 * Safe = operation is allowed. Not safe = operation should be blocked.
 */
export declare function vetWriteOperation(toolName: string, filePath: string, cwd: string, ctx: ExtensionContext): Promise<VetResult>;
/**
 * Vet a bash command for safety.
 *
 * Three-tier: utility model → session model → heuristic (regex/allowlist).
 * Safe = command is allowed. Not safe = command should be blocked.
 */
export declare function vetBashCommand(command: string, cwd: string, ctx: ExtensionContext): Promise<VetResult>;
//# sourceMappingURL=vet-filter.d.ts.map