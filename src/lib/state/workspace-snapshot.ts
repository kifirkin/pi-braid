/**
 * Workspace Snapshot - lightweight Time Travel for Braid.
 *
 * Captures atomic workspace snapshots: file state (modified files only) +
 * session position (leaf ID / turn tag) + extension state (checkpoint ref) +
 * working context (scratchpad goal/plan/decisions/learnings).
 *
 * Disk-backed under ~/.pi/agent/braid/snapshots/. No git dependency,
 * no user repo pollution. Only files the agent has actually modified
 * (traceable from the tool tracker) are captured, not the entire workspace.
 *
 * Inspired by Agent Zero's Time Travel (git-backed adaptive-debounced
 * snapshots) but adapted for Braid's architecture - lightweight file
 * copies + state references instead of git refs.
 *
 * Architecture:
 *   capture() → snapshot v1 → file copies + position + state ref
 *     (agent continues working)
 *   capture() → snapshot v2 → file copies + position + state ref
 *     (agent can navigate between snapshots)
 *   diff(snapId) → what changed between snap v1 and now
 *   list() → all snapshots with metadata
 *   restore(snapId) → preview + apply file copies
 *     (auth preserved: ~/.pi/ files excluded)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { BRAID_DIR } from "../config/braid-paths.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = createLogger("workspace-snapshot");

// ── Constants ───────────────────────────────────────────────────────────────

const SNAPSHOT_DIR = path.join(BRAID_DIR, "snapshots");
const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_PREFIX = "snap-";
const MAX_SNAPSHOTS = 20;

// Files/directories implicitly excluded from snapshots.
// These contain auth tokens, session state, or are managed by other systems.
const EXCLUDED_PATHS = [
  /\/\.pi\//,
  /\/node_modules\//,
  /\/\.git\//,
  /\/dist\//,
  /\/\.tsbuildinfo$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceSnapshotMeta {
  id: string;
  reason: string;
  timestamp: number;
  turn: number;
  sessionLeafId: string;
  sessionTag?: string;
  fileCount: number;
  /** File paths (relative to workspace root) captured in this snapshot */
  files: string[];
  /** Reference to state-checkpoint ID (if available at capture time) */
  checkpointRef?: string;
  /** Summary of working context at capture time */
  context?: {
    goal: string;
    planStepCount: number;
    decisionCount: number;
    learningCount: number;
  };
}

export interface WorkspaceSnapshot {
  meta: WorkspaceSnapshotMeta;
  /** Map of file path → content (base64-encoded for binary safety) */
  files: Record<string, string>;
}

export interface DiffEntry {
  status: "added" | "modified" | "removed" | "unchanged";
  filePath: string;
}

export interface SnapshotManifest {
  snapshots: WorkspaceSnapshotMeta[];
  updatedAt: number;
}

// ── Storage ─────────────────────────────────────────────────────────────────

function snapshotDir(id: string): string {
  return path.join(SNAPSHOT_DIR, id);
}

function manifestPath(): string {
  return path.join(SNAPSHOT_DIR, MANIFEST_FILE);
}

function filesDir(id: string): string {
  return path.join(snapshotDir(id), "files");
}

function metaFilePath(id: string): string {
  return path.join(snapshotDir(id), "meta.json");
}

/**
 * Generate a short, readable snapshot ID with a descriptive suffix.
 * Format: snap-<timestamp-base36>-<reason-slug>
 */
function generateSnapshotId(reason: string): string {
  const ts = Date.now().toString(36);
  const slug = reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 16);
  return `${SNAPSHOT_PREFIX}${ts}-${slug}`;
}

// ── Manifest Management ─────────────────────────────────────────────────────

async function loadManifest(): Promise<SnapshotManifest> {
  try {
    const data = await fs.readFile(manifestPath(), "utf-8");
    return JSON.parse(data) as SnapshotManifest;
  } catch {
    return { snapshots: [], updatedAt: Date.now() };
  }
}

async function saveManifest(manifest: SnapshotManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath()), { recursive: true });
  await fs.writeFile(manifestPath(), JSON.stringify(manifest, null, 2), "utf-8");
}

function isExcluded(filePath: string): boolean {
  return EXCLUDED_PATHS.some((pattern) => pattern.test(filePath));
}

/**
 * Resolve a relative file path against a base directory.
 * Returns the absolute path, or null if the result escapes the base.
 */






// ── Core Operations ─────────────────────────────────────────────────────────

/**
 * Capture a workspace snapshot.
 *
 * @param ctx - Extension context (for session position + scratchpad)
 * @param reason - Human-readable reason for this snapshot
 * @param modifiedFiles - List of absolute file paths the agent has modified
 * @param workspaceRoot - Project root directory for relative path resolution
 * @param checkpointRef - Optional state-checkpoint ID to reference
 * @returns The snapshot metadata, or null on failure
 */
export async function captureSnapshot(
  ctx: ExtensionContext,
  reason: string,
  modifiedFiles: string[],
  workspaceRoot: string,
  checkpointRef?: string,
): Promise<WorkspaceSnapshotMeta | null> {
  try {
    // 1. Prune old snapshots if at capacity
    const manifest = await loadManifest();
    while (manifest.snapshots.length >= MAX_SNAPSHOTS) {
      const oldest = manifest.snapshots.shift()!;
      await fs.rm(snapshotDir(oldest.id), { recursive: true, force: true }).catch(() => {});
    }

    // 2. Generate ID and create directories
    const id = generateSnapshotId(reason);
    await fs.mkdir(filesDir(id), { recursive: true });

    // 3. Filter and copy modified files
    const capturedFiles: string[] = [];
    const fileContents: Record<string, string> = {};
    const normalizedRoot = path.resolve(workspaceRoot);

    for (const absPath of modifiedFiles) {
      if (!absPath.startsWith(normalizedRoot)) continue;
      if (isExcluded(absPath)) continue;

      try {
        const content = await fs.readFile(absPath, "utf-8");
        const relPath = path.relative(normalizedRoot, absPath);
        capturedFiles.push(relPath);
        fileContents[relPath] = content;
      } catch {
        // File may have been deleted between tracking and capture
      }
    }

    if (capturedFiles.length === 0) {
      log.warn("Snapshot capture: no modified files to capture");
      return null;
    }

    // 4. Write file copies to snapshot directory
    const fileMeta: Record<string, string> = {};
    for (const [relPath, content] of Object.entries(fileContents)) {
      const snapFilePath = path.join(filesDir(id), relPath.replace(/\//g, "__"));
      await fs.mkdir(path.dirname(snapFilePath), { recursive: true }).catch(() => {});
      await fs.writeFile(snapFilePath, content, "utf-8");
      fileMeta[relPath] = snapFilePath;
    }

    // 5. Capture session position
    let sessionLeafId = "";
    let sessionTag: string | undefined;
    try {
      const sm = (ctx as unknown as { sessionManager?: { getLeafId(): string; getLabel(id: string): string | undefined } }).sessionManager;
      if (sm) {
        sessionLeafId = sm.getLeafId();
        // Check if current leaf has a tag
        sessionTag = sm.getLabel(sessionLeafId);
      }
    } catch {
      // Non-fatal: session position is best-effort
    }

    // 6. Capture working context from scratchpad (best-effort)
    let context;
    try {
      const scratchpadResult = await (
        ctx as unknown as { tools?: { scratchpad?(params: { action: string }): Promise<{ details?: { goal?: string; plan?: unknown[]; decisions?: unknown[]; key_learnings?: unknown[] } }> } }
      ).tools?.scratchpad?.({ action: "read" });
      const d = scratchpadResult?.details;
      if (d) {
        context = {
          goal: d.goal ?? "",
          planStepCount: (d.plan as unknown[])?.length ?? 0,
          decisionCount: (d.decisions as unknown[])?.length ?? 0,
          learningCount: (d.key_learnings as unknown[])?.length ?? 0,
        };
      }
    } catch {
      // Non-fatal
    }

    // 7. Build metadata
    const meta: WorkspaceSnapshotMeta = {
      id,
      reason,
      timestamp: Date.now(),
      turn: 0, // Enforcement turn not directly accessible here - will be enriched
      sessionLeafId,
      sessionTag,
      fileCount: capturedFiles.length,
      files: capturedFiles,
      checkpointRef,
      context,
    };

    await fs.writeFile(metaFilePath(id), JSON.stringify(meta, null, 2), "utf-8");

    // 8. Update manifest
    manifest.snapshots.push(meta);
    manifest.updatedAt = Date.now();
    await saveManifest(manifest);

    log.info(`Snapshot created: ${id} - ${capturedFiles.length} files, reason: ${reason}`);
    return meta;
  } catch (err) {
    log.error("Failed to capture snapshot:", err);
    return null;
  }
}

/**
 * List all workspace snapshots, most recent first.
 */
export async function listSnapshots(): Promise<WorkspaceSnapshotMeta[]> {
  const manifest = await loadManifest();
  return manifest.snapshots.slice().reverse();
}

/**
 * Get a single snapshot's metadata by ID.
 */
export async function getSnapshot(id: string): Promise<WorkspaceSnapshotMeta | null> {
  const manifest = await loadManifest();
  return manifest.snapshots.find((s) => s.id === id) ?? null;
}

/**
 * Compute diff between a snapshot and the current state of the workspace.
 *
 * Returns per-file diff status: added (snapshot has file not in workspace),
 * modified (content differs), removed (workspace has file not in snapshot),
 * unchanged.
 */
export async function diffSnapshot(
  id: string,
  workspaceRoot: string,
): Promise<{ meta: WorkspaceSnapshotMeta; diff: DiffEntry[] } | null> {
  const meta = await getSnapshot(id);
  if (!meta) return null;

  const normalizedRoot = path.resolve(workspaceRoot);
  const diff: DiffEntry[] = [];

  // Read snapshot file contents
  const snapFiles = new Map<string, string>();
  for (const relPath of meta.files) {
    const snapFilePath = path.join(filesDir(id), relPath.replace(/\//g, "__"));
    try {
      snapFiles.set(relPath, await fs.readFile(snapFilePath, "utf-8"));
    } catch {
      // Snapshot file missing - treat as empty
      snapFiles.set(relPath, "");
    }
  }

  // Compare each snapshot file against current workspace
  for (const [relPath, snapContent] of snapFiles) {
    const absPath = path.resolve(normalizedRoot, relPath);
    try {
      const currentContent = await fs.readFile(absPath, "utf-8");
      if (currentContent === snapContent) {
        diff.push({ status: "unchanged", filePath: relPath });
      } else {
        diff.push({ status: "modified", filePath: relPath });
      }
    } catch {
      // File deleted from workspace since snapshot
      diff.push({ status: "removed", filePath: relPath });
    }
  }

  // Check for files in workspace root that exist but aren't in snapshot
  // (only top-level check - deep scanning is expensive)
  const rootEntries = await fs.readdir(normalizedRoot).catch(() => []);
  for (const entry of rootEntries) {
    if (!meta.files.includes(entry)) {
      const fullPath = path.join(normalizedRoot, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile() && !isExcluded(fullPath) && !diff.some((d) => d.filePath === entry)) {
          diff.push({ status: "added", filePath: entry });
        }
      } catch {
        // stat failed - skip
      }
    }
  }

  return { meta, diff };
}

/**
 * Restore files from a snapshot to the workspace.
 * Returns a preview of what would change without applying.
 *
 * @param id - Snapshot ID
 * @param workspaceRoot - Project root directory
 * @param dryRun - If true, only return the diff without applying changes
 * @returns Summary of restored files, or null on failure
 */
export async function restoreSnapshot(
  id: string,
  workspaceRoot: string,
  dryRun: boolean = true,
): Promise<{
  meta: WorkspaceSnapshotMeta;
  toRestore: DiffEntry[];
  skipped: string[];
} | null> {
  const meta = await getSnapshot(id);
  if (!meta) return null;

  const normalizedRoot = path.resolve(workspaceRoot);
  const toRestore: DiffEntry[] = [];
  const skipped: string[] = [];

  for (const relPath of meta.files) {
    const absPath = path.resolve(normalizedRoot, relPath);

    // Safety: don't restore files outside workspace
    if (!absPath.startsWith(normalizedRoot)) {
      skipped.push(relPath);
      continue;
    }

    // Safety: don't restore excluded paths
    if (isExcluded(absPath)) {
      skipped.push(relPath);
      continue;
    }

    const snapFilePath = path.join(filesDir(id), relPath.replace(/\//g, "__"));
    let snapContent: string;
    try {
      snapContent = await fs.readFile(snapFilePath, "utf-8");
    } catch {
      skipped.push(relPath);
      continue;
    }

    // Check if current content differs
    let currentContent: string | undefined;
    try {
      currentContent = await fs.readFile(absPath, "utf-8");
    } catch {
      // File doesn't exist in workspace - it's a new file to restore
    }

    if (currentContent === snapContent) {
      // Already up to date - skip
      continue;
    }

    toRestore.push({ status: currentContent === undefined ? "added" : "modified", filePath: relPath });

    // Only apply if not a dry run
    if (!dryRun) {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, snapContent, "utf-8");
    }
  }

  return { meta, toRestore, skipped };
}

/**
 * Delete a snapshot by ID.
 */
export async function deleteSnapshot(id: string): Promise<boolean> {
  const manifest = await loadManifest();
  const idx = manifest.snapshots.findIndex((s) => s.id === id);
  if (idx === -1) return false;

  manifest.snapshots.splice(idx, 1);
  manifest.updatedAt = Date.now();
  await saveManifest(manifest);

  await fs.rm(snapshotDir(id), { recursive: true, force: true }).catch(() => {});
  log.info(`Snapshot deleted: ${id}`);
  return true;
}

/**
 * Get snapshot storage usage info.
 */
export async function getSnapshotInfo(): Promise<{
  count: number;
  snapshots: WorkspaceSnapshotMeta[];
  storageBytes: number;
}> {
  const manifest = await loadManifest();
  let storageBytes = 0;

  for (const snap of manifest.snapshots) {
    try {
      const dir = snapshotDir(snap.id);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile()) {
          const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
          if (stat) storageBytes += stat.size;
        }
      }
    } catch {
      // Snapshot directory missing - skip
    }
  }

  return {
    count: manifest.snapshots.length,
    snapshots: manifest.snapshots.slice().reverse(),
    storageBytes,
  };
}
