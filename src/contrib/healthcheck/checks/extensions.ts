import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";

export function testExtensionSystem(pi: ExtensionAPI): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: Extension API accessible
  checks.push(
    check("Extensions", "api-functional", () => {
      try {
        pi.getActiveTools();
        pi.getAllTools();
        pi.getFlag("nonexistent-flag");
        return { status: "pass", message: "Extension API functional" };
      } catch (error) {
        return { status: "fail", message: `Extension API error: ${error}` };
      }
    }),
  );

  // Test: Commands registered
  checks.push(
    check("Extensions", "commands", () => {
      try {
        const commands = pi.getCommands();
        return {
          status: "pass",
          message: `${commands.length} slash commands available`,
          details:
            commands
              .slice(0, 5)
              .map((c) => c.name)
              .join(", ") + (commands.length > 5 ? "..." : ""),
        };
      } catch {
        return { status: "warn", message: "Cannot access command registry" };
      }
    }),
  );

  // Test: Healthcheck tool can self-verify
  checks.push(
    check("Extensions", "healthcheck-self", () => {
      return { status: "pass", message: "Healthcheck extension is running" };
    }),
  );

  // Test: Events system accessible
  checks.push(
    check("Extensions", "events", () => {
      try {
        if (pi.events && typeof pi.events.on === "function") {
          return { status: "pass", message: "Event bus accessible" };
        }
        return { status: "warn", message: "Event bus not fully accessible" };
      } catch {
        return { status: "warn", message: "Cannot verify event bus" };
      }
    }),
  );

  return checks;
}
