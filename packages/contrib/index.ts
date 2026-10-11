/**
 * pi-braid-contrib — Convenience bundle loader
 *
 * Loads all 12 contrib extensions at once, with per-extension toggling via
 * `braid.contrib.<name>` in `~/.pi/agent/settings.json`.
 *
 * This is a CONVENIENCE entry point. The native pi way to load contrib
 * extensions is via `pi.extensions` in package.json (all 12 listed
 * individually) — loaded automatically when the package is registered:
 *
 *   {
 *     "packages": ["file:~/pi-braid-contrib"]
 *   }
 *
 * Use this file when you want the convenience bundle with braid.contrib.*
 * toggles:
 *
 *   {
 *     "extensions": ["file:~/pi-braid-contrib/index.ts"]
 *   }
 *
 * Per-extension enable/disable (all enabled by default):
 *
 *   {
 *     "braid": {
 *       "contrib": {
 *         "browser": false,
 *         "repl": false
 *       }
 *     }
 *   }
 *
 * Disabled extensions are simply not loaded; their tools are not
 * registered. This is the cheapest way to drop heavy tools (e.g.
 * browser) for sessions that don't need them.
 *
 * The list of available extension names is enumerated below as
 * `EXTENSIONS`. The settings reader only respects names in this list;
 * unknown names are ignored (with a warning).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { setLoggerContext } from "./logger.js";

import browser from "./browser/index.js";
import codebase from "./codebase/index.js";
import diff from "./diff/index.js";
import healthcheck from "./healthcheck/index.js";
import networkMonitor from "./network-monitor/index.js";
import observatory from "./observatory/index.js";
import pathSecurity from "./path-security/index.js";
import rateLimiter from "./rate-limiter/index.js";
import repl from "./repl/index.js";
import sleep from "./sleep/index.js";
import systemMonitor from "./system-monitor/index.js";
import toolConfig from "./tool-config/index.js";

// Extension registry. Adding a new contrib extension: add the import above
// and an entry here. The `name` is the key users reference in settings.json.
const EXTENSIONS: Record<string, (pi: ExtensionAPI) => void> = {
  browser,
  codebase,
  diff,
  healthcheck,
  networkMonitor,
  observatory,
  pathSecurity,
  rateLimiter,
  repl,
  sleep,
  systemMonitor,
  toolConfig,
};

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

interface BraidSettings {
  contrib?: Record<string, boolean>;
}

function readBraidContribSettings(): {
  enabled: Set<string>;
  unknown: string[];
} {
  const enabled = new Set<string>(Object.keys(EXTENSIONS));
  const unknown: string[] = [];
  if (!existsSync(SETTINGS_PATH)) return { enabled, unknown };
  let parsed: { braid?: BraidSettings };
  try {
    parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return { enabled, unknown };
  }
  const overrides = parsed.braid?.contrib;
  if (!overrides || typeof overrides !== "object") return { enabled, unknown };
  for (const [name, val] of Object.entries(overrides)) {
    if (!(name in EXTENSIONS)) {
      unknown.push(name);
      continue;
    }
    if (val === false) enabled.delete(name);
    // val === true is a no-op (already enabled by default)
  }
  return { enabled, unknown };
}

function log(name: string, msg: string): void {
  // Minimal logger; contrib is meant to have zero deps.
  process.stderr.write(`[contrib] ${name}: ${msg}\n`);
}

export default function (pi: ExtensionAPI): void {
  const { enabled, unknown } = readBraidContribSettings();
  for (const name of unknown) {
    log(name, "unknown extension in braid.contrib settings (ignored)");
  }
  let loaded = 0;
  let skipped = 0;
  for (const [name, fn] of Object.entries(EXTENSIONS)) {
    if (!enabled.has(name)) {
      skipped++;
      continue;
    }
    try {
      fn(pi);
      loaded++;
    } catch (err) {
      log(name, `load failed: ${(err as Error).message}`);
    }
  }

  // Bind the logger context so all createLogger() calls route through
  // ctx.ui.notify (TUI-safe) instead of writing to stdout. This matches
  // pi-braid's session lifecycle pattern (src/index.ts).
  pi.on("session_start", (_event, ctx) => {
    setLoggerContext(ctx);
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    setLoggerContext(null);
  });
  if (skipped > 0 || unknown.length > 0) {
    log(
      "<loader>",
      `loaded ${loaded}, skipped ${skipped}${unknown.length > 0 ? `, ${unknown.length} unknown` : ""}`,
    );
  }
}

// Expose for tests / introspection. Not used by the runtime.
export { EXTENSIONS };
