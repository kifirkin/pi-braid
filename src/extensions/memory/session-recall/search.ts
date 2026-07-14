/**
 * Session Recall - search functions
 *
 * Grep-based keyword search across past pi session files.
 * Supports rg, grep, and Node.js fallback backends.
 */

import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { AGENT } from "../../../lib/config/braid-paths.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("session-recall-search");

// ── Types ─────────────────────────────────────────────────────────────────────

export type SearchBackend = "rg" | "grep" | "node";

export interface FileMatchCount {
  path: string;
  count: number;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function getSessionsDir(): string {
  return join(AGENT, "sessions");
}

export function projectFromPath(sessionPath: string): string {
  const match = sessionPath.match(/sessions[/\\](--.*?--)[/\\]/);
  if (!match || !match[1]) return "~";
  let encoded = match[1].slice(2, -2);
  const homeEncoded = homedir()
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-");
  if (encoded.startsWith(homeEncoded + "-")) {
    encoded = encoded.slice(homeEncoded.length + 1);
  } else if (encoded === homeEncoded) {
    return "~";
  }
  return encoded.replace(/-/g, "/") || "~";
}

export function dateFromPath(sessionPath: string): string {
  const match = sessionPath.match(/(\d{4}-\d{2}-\d{2})T/);
  return match?.[1] ?? "unknown";
}

// ── State (module-level, process-global by design) ───────────────────────────
// Cached search backend detection result. Survives across calls within the
// same process. Not per-session because there's no ctx available during
// tool execution (the tool execute callback doesn't receive ctx with
// sessionKey).

let _cachedBackend: SearchBackend | undefined;

export function getSearchBackend(): SearchBackend {
  if (_cachedBackend !== undefined) return _cachedBackend;
  for (const cmd of ["rg", "grep"] as const) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
      _cachedBackend = cmd;
      return cmd;
    } catch {
      /* try next */
    }
  }
  _cachedBackend = "node";
  return "node";
}

// ── File discovery ────────────────────────────────────────────────────────────

export async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) results.push(full);
    }
  }
  await walk(dir);
  return results;
}

// ── Search implementations ────────────────────────────────────────────────────

export const MAX_SEARCH_RESULTS = 10;
export const MAX_SNIPPETS_PER_SESSION = 3;

export async function searchFiles(
  query: string,
  sessionsDir: string,
  timeout = 10000,
): Promise<FileMatchCount[]> {
  const backend = getSearchBackend();

  if (backend === "rg") {
    try {
      const output = execFileSync("rg", ["-i", "-c", "-F", query, sessionsDir], {
        encoding: "utf-8",
        timeout,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return parseCountOutput(output);
    } catch (err: any) {
      if (err.status === 1) return [];
    }
  }

  if (backend === "grep") {
    try {
      const output = execFileSync(
        "grep",
        ["-r", "-i", "-c", "-F", "--include=*.jsonl", query, sessionsDir],
        { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] },
      );
      return parseCountOutput(output);
    } catch (err: any) {
      if (err.status === 1) return [];
    }
  }

  return nodeSearchFiles(query, sessionsDir);
}

function parseCountOutput(output: string): FileMatchCount[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const lastColon = line.lastIndexOf(":");
      return { path: line.slice(0, lastColon), count: parseInt(line.slice(lastColon + 1), 10) };
    });
}

async function nodeSearchFiles(query: string, sessionsDir: string): Promise<FileMatchCount[]> {
  const files = await walkJsonlFiles(sessionsDir);
  const results: FileMatchCount[] = [];
  const lowerQuery = query.toLowerCase();

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      let count = 0;
      for (const line of content.split("\n")) {
        if (line.toLowerCase().includes(lowerQuery)) count++;
      }
      if (count > 0) results.push({ path: filePath, count });
    } catch {
      /* skip bad files */
    }
  }

  return results;
}

export async function searchLines(query: string, filePath: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.toLowerCase().includes(lowerQuery)) {
        results.push(line);
        if (results.length >= limit) break;
      }
    }
  } catch {
    /* skip */
  }

  return results;
}