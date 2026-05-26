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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function pathSecurityExtension(pi: ExtensionAPI): void;
//# sourceMappingURL=index.d.ts.map