/**
 * pi-braid — metacognitive agent extension suite.
 *
 * Architecture:
 *   Each extension is a self-contained factory function registered in
 *   src/extensions/manifest.ts. The loader (src/modules/loader.ts) resolves
 *   which extensions to load based on BRAID_MODULES env var, settings.json,
 *   or runtime API overrides.
 *
 *   Extensions are flat — no module grouping abstraction. The `module` tag
 *   is a convenience label for the subagent toggle commands.
 *
 * Config:
 *   BRAID_MODULES=enforcement,-turn-outcome,cognitive
 *   Default: all non-disabled extensions enabled.
 *   Reference targets: extension IDs ("enforcement") or module groups ("core").
 *
 * Subagent API:
 *   Researcher subagents can call `/modules-enable`, `/modules-disable`,
 *   `/modules-toggle`, `/modules-list`, `/modules-status`, `/modules-reset`
 *   to control extension loading during benchmark experiments.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "./lib/logger.js";
import { loadModules } from "./modules/loader.js";
import modulesApiExtension from "./modules/api.js";

// ── Shared constants (imported by extensions) ────────────────────────────────

// ESM-safe: use import.meta.url to resolve skills dir reliably.
// __dirname is undefined in ESM — using it as fallback caused skills to resolve
// to a non-existent directory outside the project.
import { fileURLToPath } from "node:url";
const _skillsUrl = new URL(".", import.meta.url);
export const SKILLS_DIR = join(fileURLToPath(_skillsUrl), "..", "skills");

const log = createLogger("braid");

// ── Entry point ──────────────────────────────────────────────────────────────

export default async function braidExtension(pi: ExtensionAPI): Promise<void> {
  log.info(`pi-braid v${getVersion()} loading...`);

  // 1. Load extensions from flat manifest
  //    Config source: BRAID_MODULES env var (format: +id,-id,module-group)
  const report = await loadModules(pi);

  if (report.total === 0) {
    log.warn("No extensions loaded — check BRAID_MODULES config or manifest.");
  } else {
    log.info(`Loaded ${report.total} extensions (${report.loaded.length} succeeded).`);

    for (const l of report.loaded) {
      log.info(`  ● ${l.id} — ${l.desc}`);
    }
    for (const s of report.skipped) {
      log.warn(`  ○ ${s.id}: ${s.reason}`);
    }
  }

  // 2. Register subagent API (always available so researcher can toggle modules)
  await modulesApiExtension(pi);

  log.info("pi-braid ready.");
}

// ── Version ──────────────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}
