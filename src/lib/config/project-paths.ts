/**
 * Project-local paths — paths within the project repo (not in ~/.pi/agent/braid/).
 *
 * `lib/config/braid-paths.ts` is for `~/.pi/agent/braid/` (user data).
 * This file is for paths inside the pi-braid project itself.
 *
 * (Previously exported SKILLS_DIR for the bundled skills/ directory.
 * Skills have been moved to a separate package: pi-braid-skills.
 * See ~/projects/agents/pi-braid-skills/.)
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// We resolve the project root by walking up from this file's location:
//   src/lib/config/project-paths.ts  →  3 levels up  →  <project_root>
const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(HERE, "..", "..", "..");
