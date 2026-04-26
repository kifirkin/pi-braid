/**
 * pi-braid — metacognitive agent extension suite.
 *
 * Architecture:
 *   Extensions are organized into modules (see src/modules/definitions.ts).
 *   Modules are loaded config-drively via src/modules/loader.ts based on
 *   the `BRAID_MODULES` environment variable or runtime API overrides.
 *
 *   This replaces the old flat extension registration. All research tracks
 *   (cognitive, memory, heartbeat, etc.) are now modular and toggleable.
 *
 * Config:
 *   BRAID_MODULES=cognitive,memory,-heartbeat,+evolve
 *   Default: all non-disabled modules enabled.
 *
 * Subagent API:
 *   Researcher subagents can call `/modules-enable`, `/modules-disable`,
 *   `/modules-toggle`, `/modules-list`, `/modules-status`, `/modules-reset`
 *   to control module loading during benchmark experiments.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "./lib/logger.js";
import { loadModules } from "./modules/loader.js";
import modulesApiExtension from "./modules/api.js";

// ── Shared constants (imported by extensions) ────────────────────────────────

// esbuild CJS output provides __dirname — use it as-is.
/** Directory where agent skill files are stored. */
export const SKILLS_DIR = join(
	typeof __dirname !== "undefined" ? __dirname : ".",
	"..",
	"skills",
);

const log = createLogger("braid");

// ── Entry point ──────────────────────────────────────────────────────────────

export default async function braidExtension(pi: ExtensionAPI): Promise<void> {
	log.info(`pi-braid v${getVersion()} loading...`);

	// 1. Load modules defined in src/modules/definitions.ts
	//    Config source: BRAID_MODULES env var (format: +module,-module)
	const report = await loadModules(pi);

	if (report.total === 0) {
		log.warn("No extensions loaded — check BRAID_MODULES config or module definitions.");
	} else {
		log.info(`Loaded ${report.total} extensions (${report.loaded.length} modules).`);

		for (const m of report.loaded) {
			log.info(`  ● ${m.module} (${m.extensions} extensions)`);
		}
		for (const s of report.skipped) {
			log.warn(`  ○ ${s.module}/${s.ext || "*"}: ${s.reason}`);
		}
	}

	// 2. Register subagent API (always available so researcher can toggle modules)
	await modulesApiExtension(pi);

	log.info("pi-braid ready.");
}

// ── Version ──────────────────────────────────────────────────────────────────

function getVersion(): string {
	try {
		return "0.20.0";
	} catch {
		return "dev";
	}
}
