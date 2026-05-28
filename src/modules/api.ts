/**
 * Subagent API for module/toggle.
 *
 * Registers commands that a researcher subagent can call during benchmarks
 * to enable/disable extensions (or module groups) and query their state:
 *
 *   modules-enable <id>      — Enable an extension or module group
 *   modules-disable <id>     — Disable an extension or module group
 *   modules-toggle <id>      — Toggle an extension or module group
 *   modules-list             — Show all extensions and their state
 *   modules-status           — Show current session extension state
 *   modules-reset            — Reset all runtime overrides
 *
 * Reference targets can be individual extension IDs (e.g. "enforcement")
 * or module group names (e.g. "memory" expands to all memory extensions).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { createLogger } from "../lib/core/logger.js";
import {
  enableModule,
  disableModule,
  toggleModule,
  getModuleStates,
  resetModuleOverrides,
  getAllRefNames,
} from "./loader.js";

const log = createLogger("modules-api");

export default async function modulesApiExtension(pi: ExtensionAPI): Promise<void> {
  // ── enable ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-enable", {
    description: "Enable an extension or module group. Usage: modules-enable <id>",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const name = _args.trim().toLowerCase();
      const refs = getAllRefNames();
      if (!name || !refs.includes(name)) {
        ctx.ui.notify?.(
          `Usage: modules-enable <id>\nAvailable: ${refs.join(", ")}`,
          "warning",
        );
        return;
      }
      const ok = enableModule(name, ctx);
      ctx.ui.notify?.(
        ok ? `"${name}" enabled (next session startup).` : `Cannot enable "${name}".`,
        ok ? "info" : "error",
      );
    },
  });

  // ── disable ─────────────────────────────────────────────────────────
  pi.registerCommand("modules-disable", {
    description: "Disable an extension or module group. Usage: modules-disable <id>",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const name = _args.trim().toLowerCase();
      if (!name) {
        ctx.ui.notify?.("Usage: modules-disable <id>", "warning");
        return;
      }
      const ok = disableModule(name, ctx);
      ctx.ui.notify?.(
        ok
          ? `"${name}" disabled (next session).`
          : `Cannot disable "${name}" — it may be a core extension.`,
        ok ? "info" : "error",
      );
    },
  });

  // ── toggle ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-toggle", {
    description: "Toggle an extension or module group. Usage: modules-toggle <id>",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const name = _args.trim().toLowerCase();
      if (!name) {
        ctx.ui.notify?.("Usage: modules-toggle <id>", "warning");
        return;
      }
      const state = toggleModule(name, ctx);
      if (state === null) ctx.ui.notify?.(`"${name}" not found.`, "error");
      else
        ctx.ui.notify?.(`"${name}" toggled ${state ? "ON" : "OFF"} (next session).`, "info");
    },
  });

  // ── list ────────────────────────────────────────────────────────────
  pi.registerCommand("modules-list", {
    description: "List all extensions with state, load status, and config source.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const states = getModuleStates(ctx);
      const lines: string[] = [];
      const source = Object.values(states)[0]?.source ?? "?";
      lines.push(`Extensions (config: ${source}):`);
      for (const [id, info] of Object.entries(states)) {
        const status = info.enabled ? (info.loaded ? "●" : "○ pending") : "— disabled";
        lines.push(`  ${status.padEnd(12)} ${id}`);
        lines.push(`                 ${info.desc}`);
      }
      lines.push("");
      lines.push("Toggle: /modules-toggle <id>");
      lines.push("Enable: /modules-enable <id>  Disable: /modules-disable <id>");
      lines.push("Reset:  /modules-reset");
      ctx.ui.notify?.(lines.join("\n"), "info");
    },
  });

  // ── status ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-status", {
    description: "Show current runtime overrides and load state.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const states = getModuleStates(ctx);
      const loaded = Object.values(states).filter((s) => s.loaded).length;
      const enabled = Object.values(states).filter((s) => s.enabled).length;
      const lines: string[] = [
        `Extensions: ${loaded} loaded, ${enabled} enabled` +
          ` (config: ${Object.values(states)[0]?.source ?? "?"})`,
      ];
      for (const [id, info] of Object.entries(states)) {
        const status = info.enabled ? (info.loaded ? "●" : "○ pending") : "— disabled";
        lines.push(`  ${status.padEnd(12)} ${id}`);
      }
      ctx.ui.notify?.(lines.join("\n"), "info");
    },
  });

  // ── reset ──────────────────────────────────────────────────────────
  pi.registerCommand("modules-reset", {
    description: "Reset all runtime overrides (restore defaults).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      resetModuleOverrides(ctx);
      ctx.ui.notify?.(
        "All overrides reset. Defaults will apply on next session start.",
        "info",
      );
    },
  });

  log.info("Module API registered: enable/disable/toggle/list/status/reset");
}