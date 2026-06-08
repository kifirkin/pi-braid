/**
 * Project-local paths — paths within the project repo (not in ~/.pi/agent/braid/).
 *
 * `lib/config/braid-paths.ts` is for `~/.pi/agent/braid/` (user data).
 * This file is for paths inside the pi-braid project itself.
 *
 * Currently:
 *   SKILLS_DIR — the project's skills/ directory at the repo root,
 *                passed to pi core's loadSkills() so the LLM can
 *                read skills directly.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// We resolve the project root by walking up from this file's location:
//   src/lib/config/project-paths.ts  →  3 levels up  →  <project_root>
const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(HERE, "..", "..", "..");

/** Project root skills/ directory. */
export const SKILLS_DIR = join(PROJECT_ROOT, "skills");
