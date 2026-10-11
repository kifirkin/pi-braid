/**
 * Session-file statistics for the `session` tool's `stats` action.
 *
 * Split out of index.ts so the aggregation can be exercised against a fixture
 * tree: the sessions root is a module constant, so the tool itself can only
 * read the live tree.
 */

import { readFile, stat } from "node:fs/promises";
import { countArchivedMessages } from "./text-utils.js";
import { dateFromPath, pathMatchesProject, projectFromPath } from "./search.js";

export interface SessionStatEntry {
  path: string;
  size: number;
  project: string;
  date: string;
  /** True for a compaction archive under `<session dir>/archives/`. */
  archive: boolean;
}

export interface SessionStatsTotals {
  entries: SessionStatEntry[];
  totalSize: number;
  /** Compaction archives among `entries`, and the messages they carry. */
  archives: { files: number; messages: number };
}

export interface SessionStatsOptions {
  project?: string | null;
  /** Inclusive epoch-ms bounds on the file's date. */
  since?: number | null;
  until?: number | null;
}

/** Compaction archives live in `<session dir>/archives/`. */
export function isArchivePath(filePath: string): boolean {
  return /[/\\]archives[/\\]/.test(filePath);
}

export async function collectSessionStats(
  files: string[],
  options: SessionStatsOptions = {},
): Promise<SessionStatsTotals> {
  const { project = null, since = null, until = null } = options;
  const entries: SessionStatEntry[] = [];
  let totalSize = 0;

  for (const filePath of files) {
    if (project && !pathMatchesProject(filePath, project)) continue;

    // Archives carry no date stamp, so dateFromPath falls back to their mtime.
    // A file with neither is not statable and is skipped, as before.
    const date = dateFromPath(filePath);
    if (date === "unknown") continue;
    const fileTs = new Date(date + "T00:00:00.000Z").getTime();
    if (since !== null && fileTs < since) continue;
    if (until !== null && fileTs > until) continue;

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      continue; // unreadable file
    }

    totalSize += size;
    entries.push({
      path: filePath,
      size,
      project: projectFromPath(filePath),
      date,
      archive: isArchivePath(filePath),
    });
  }

  let archiveFiles = 0;
  let messages = 0;
  for (const entry of entries) {
    if (!entry.archive) continue;
    archiveFiles++;
    try {
      const body = await readFile(entry.path, "utf-8");
      for (const line of body.split("\n")) {
        if (line) messages += countArchivedMessages(line);
      }
    } catch {
      // Unreadable archive: counted as a file, not as messages.
    }
  }

  return { entries, totalSize, archives: { files: archiveFiles, messages } };
}
