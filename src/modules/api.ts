/**
 * Subagent API for module toggling.
 *
 * Registers tools that a researcher subagent can call during benchmarks
 * to enable/disable modules and query their state:
 *
 *   modules-enable <name>     — Enable a module
 *   modules-disable <name>    — Disable a module
 *   modules-toggle <name>     — Toggle a module on/off
 *   modules-list              — Show all modules and their state
 *   modules-status            — Show current session module state
 *   modules-reset             — Reset all runtime overrides
 *
 * These tools work by calling the module loader's runtime API, so the
 * effect is immediate for session_start handlers.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { createLogger } from "../lib/logger.js";
import {
  enableModule,
  disableModule,
  toggleModule,
  getModuleStates,
  resetModuleOverrides,
} from "./loader.js";
import { getAllModuleNames } from "./definitions.js";

const log = createLogger("modules-api");

export default async function modulesApiExtension(pi: ExtensionAPI): Promise<void> {
  // ── enable ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-enable", {
    description: "Enable a module. Usage: modules-enable <name>",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const name = _args.trim().toLowerCase();
      const names = getAllModuleNames();
      if (!name || !names.includes(name)) {
        ctx.ui.notify?.(`Usage: modules-enable <name>\nAvailable: ${names.join(", ")}`, "warning");
        return;
      }
      const ok = enableModule(name, ctx as any);
      ctx.ui.notify?.(
        ok ? `Module "${name}" enabled (next session startup).` : `Cannot enable "${name}".`,
        ok ? "info" : "error",
      );
    },
  });

  // ── disable ─────────────────────────────────────────────────────────
  pi.registerCommand("modules-disable", {
    description: "Disable a module. Usage: modules-disable <name>",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const name = _args.trim().toLowerCase();
      if (!name) {
        ctx.ui.notify?.("Usage: modules-disable <name>", "warning");
        return;
      }
      const ok = disableModule(name, ctx as any);
      ctx.ui.notify?.(
        ok
          ? `Module "${name}" disabled (next session).`
          : `Cannot disable "${name}" — it may be a core module.`,
        ok ? "info" : "error",
      );
    },
  });

  // ── toggle ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-toggle", {
    description: "Toggle a module on/off. Usage: modules-toggle <name>",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const name = _args.trim().toLowerCase();
      if (!name) {
        ctx.ui.notify?.("Usage: modules-toggle <name>", "warning");
        return;
      }
      const state = toggleModule(name, ctx as any);
      if (state === null) ctx.ui.notify?.(`Module "${name}" not found.`, "error");
      else
        ctx.ui.notify?.(`Module "${name}" toggled ${state ? "ON" : "OFF"} (next session).`, "info");
    },
  });

  // ── list ────────────────────────────────────────────────────────────
  pi.registerCommand("modules-list", {
    description: "List all modules with their state, load status, and config source.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const states = getModuleStates(ctx as any);
      const lines: string[] = [];
      const source = Object.values(states)[0]?.source ?? "?";
      lines.push(`Modules (config: ${source}):`);
      for (const [name, info] of Object.entries(states)) {
        const status = info.enabled ? (info.loaded ? "●" : "○ pending") : "— disabled";
        const deps = (() => {
          const def = Object.values(states).find(() => true); // get def
          return "";
        })();
        lines.push(`  ${status.padEnd(12)} ${name}`);
        lines.push(`                 ${info.description}`);
      }
      lines.push("");
      lines.push("Toggle: /modules-toggle <name>");
      lines.push("Enable: /modules-enable <name>  Disable: /modules-disable <name>");
      lines.push("Reset:  /modules-reset");
      ctx.ui.notify?.(lines.join("\n"), "info");
    },
  });

  // ── status ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-status", {
    description: "Show current runtime module overrides and load state.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const states = getModuleStates(ctx as any);
      const loaded = Object.values(states).filter((s) => s.loaded).length;
      const enabled = Object.values(states).filter((s) => s.enabled).length;
      const overrides = Object.entries(states).filter(([, s]) => {
        // Check if runtime override exists (simplified — best-effort)
        return false;
      });
      ctx.ui.notify?.(
        `Module state:\n  ${loaded} loaded, ${enabled} enabled\n` +
          (Object.keys(states).length > 0 ? `  To toggle: modules-toggle <name>` : ""),
        "info",
      );
    },
  });

  // ── reset ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-reset", {
    description: "Reset all runtime module overrides (restore defaults).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      resetModuleOverrides(ctx as any);
      ctx.ui.notify?.(
        "All module overrides reset. Defaults will apply on next session start.",
        "info",
      );
    },
  });

  log.info("Module API registered: enable/disable/toggle/list/status/reset");
}
