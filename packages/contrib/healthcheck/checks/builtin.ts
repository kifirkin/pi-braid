import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";

export function testBuiltinTools(pi: ExtensionAPI): CheckResult[] {
  const checks: CheckResult[] = [];

  // Critical builtin tools that should always be available
  const builtinTools = [
    "read",
    "bash",
    "scratchpad",
    "think",
    "hypothesize",
    "healthcheck",
  ];

  let toolNames: string[] = [];
  let toolSource = "unknown";
  try {
    const allTools = pi.getAllTools();
    if (allTools.length > 0) {
      toolNames = allTools.map((t) => t.name);
      toolSource = "all";
    }
  } catch {
    // Ignore - will try getActiveTools as fallback
  }

  // Fallback to getActiveTools if getAllTools returned empty
  if (toolNames.length === 0) {
    try {
      const activeTools = pi.getActiveTools();
      if (activeTools.length > 0) {
        toolNames = activeTools;
        toolSource = "active";
      }
    } catch {
      return [
        check("Builtin", "tool-access", () => {
          return { status: "skip", message: "Cannot access tool registry" };
        }),
      ];
    }
  }

  // Test overall builtin availability
  checks.push(
    check("Builtin", "available", () => {
      const builtinCount = builtinTools.filter((t) =>
        toolNames.includes(t),
      ).length;
      return {
        status: builtinCount >= 4 ? "pass" : "warn",
        message: `${builtinCount}/${builtinTools.length} builtin tools available (via ${toolSource})`,
        details: `Tools: ${toolNames.slice(0, 15).join(", ")}${toolNames.length > 15 ? "..." : ""}`,
      };
    }),
  );

  for (const toolName of builtinTools) {
    checks.push(
      check("Builtin", toolName, () => {
        const found = toolNames.includes(toolName);
        return found
          ? { status: "pass", message: `${toolName} available` }
          : { status: "warn", message: `${toolName} not loaded (optional)` };
      }),
    );
  }

  return checks;
}
