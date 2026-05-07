import { createLogger } from "../../../lib/logger.js";

const log = createLogger("cognitive-systems");
/**
 * Project storage utilities for cognitive systems.
 *
 * Provides persistent storage per git repository:
 * - Finds git root from any working directory path
 * - Creates stable project ID (hash of git root)
 * - Provides storage directory: ~/.pi/memory/projects/<project-id>/
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BRAID_PROJECTS_DIR } from "../../../lib/braid-paths.js";

const PROJECTS_DIR = BRAID_PROJECTS_DIR;

/**
 * Find the git root directory from a working directory.
 * Walks up the directory tree looking for .git folder.
 * Returns null if not in a git repository.
 */
export function findGitRoot(cwd: string): string | null {
  let current = path.resolve(cwd);

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory()) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}

/**
 * Create a stable project ID from git root path.
 * Uses MD5 hash for a short, consistent identifier.
 */
export function createProjectId(gitRoot: string): string {
  return crypto.createHash("md5").update(gitRoot).digest("hex").substring(0, 12);
}

/**
 * Get the project storage directory for cognitive systems.
 * Creates the directory if it doesn't exist.
 *
 * @param cwd Current working directory
 * @returns Project storage directory path, or null if not in a git repo
 */
export function getProjectStorageDir(cwd: string): string | null {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return null;
  }

  const projectId = createProjectId(gitRoot);
  const storageDir = path.join(PROJECTS_DIR, projectId);

  // Ensure directory exists
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  return storageDir;
}

/**
 * Get info about the current project.
 * Useful for debugging and display.
 */
export function getProjectInfo(cwd: string): {
  gitRoot: string | null;
  projectId: string | null;
  storageDir: string | null;
} {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return { gitRoot: null, projectId: null, storageDir: null };
  }

  const projectId = createProjectId(gitRoot);
  const storageDir = path.join(PROJECTS_DIR, projectId);

  return { gitRoot, projectId, storageDir };
}
