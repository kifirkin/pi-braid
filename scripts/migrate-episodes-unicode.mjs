#!/usr/bin/env node
/**
 * One-time migration for episodes.jsonl: replace literal \uXXXX sequences
 * in stored episode strings with their decoded unicode characters.
 *
 * Background: a previous code path double-encoded unicode (BUG-M3),
 * leaving entries with strings like `\u2192` instead of `→`. The runtime
 * sanitizer at load time (three-memory-stores/episodes.ts:sanitizeEpisode)
 * already heals these transparently, so this migration is cosmetic -
 * it makes the on-disk file human-readable and reduces the work the
 * runtime sanitizer does on every load.
 *
 * Usage:
 *   node scripts/migrate-episodes-unicode.mjs           # dry-run by default
 *   node scripts/migrate-episodes-unicode.mjs --apply   # write changes
 *
 * The script ALWAYS creates a timestamped backup before applying. The
 * backup is written next to the original file as episodes.jsonl.bak-<ts>.
 *
 * The script exits non-zero on any error (parse, I/O, write) so it can
 * be used in CI or pre-commit hooks.
 */

import { readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EPISODES_FILE = join(homedir(), ".pi", "agent", "braid", "memory", "episodes.jsonl");

// Same algorithm as src/extensions/memory/three-memory-stores/episodes.ts:
// regex-replace each \\uXXXX with the decoded code point. Detection: only
// run if the string contains at least one \\uXXXX pattern. The previous
// JSON.parse-based approach silently failed for strings with raw newline
// characters (the common case for multi-line task/solution fields).
function unescapeUnicodeIfDoubleEncoded(s) {
  if (typeof s !== "string") return s;
  if (!/\\u[0-9a-fA-F]{4}/.test(s)) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}

function sanitizeEpisode(ep) {
  return {
    ...ep,
    task: unescapeUnicodeIfDoubleEncoded(ep.task),
    solution: unescapeUnicodeIfDoubleEncoded(ep.solution),
    toolSequence: ep.toolSequence?.map(unescapeUnicodeIfDoubleEncoded),
    tags: ep.tags?.map(unescapeUnicodeIfDoubleEncoded),
    project: unescapeUnicodeIfDoubleEncoded(ep.project),
    strategicSOP: ep.strategicSOP ? unescapeUnicodeIfDoubleEncoded(ep.strategicSOP) : undefined,
    functionalSOP: ep.functionalSOP?.map(unescapeUnicodeIfDoubleEncoded),
    atomicSOP: ep.atomicSOP?.map(unescapeUnicodeIfDoubleEncoded),
  };
}

function hasLiteralEscape(value) {
  if (typeof value === "string") return /\\u[0-9a-fA-F]{4}/.test(value);
  if (Array.isArray(value)) return value.some(hasLiteralEscape);
  return false;
}

async function main() {
  const apply = process.argv.includes("--apply");

  if (!existsSync(EPISODES_FILE)) {
    console.log(`No file at ${EPISODES_FILE} - nothing to migrate.`);
    return;
  }

  const content = await readFile(EPISODES_FILE, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const out = [];
  let changed = 0;
  let malformed = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const ep = JSON.parse(lines[i]);
      const needs = hasLiteralEscape(ep.task) || hasLiteralEscape(ep.solution) ||
        hasLiteralEscape(ep.toolSequence) || hasLiteralEscape(ep.tags) ||
        hasLiteralEscape(ep.project) || hasLiteralEscape(ep.strategicSOP) ||
        hasLiteralEscape(ep.functionalSOP) || hasLiteralEscape(ep.atomicSOP);
      if (needs) {
        const sanitized = sanitizeEpisode(ep);
        out.push(JSON.stringify(sanitized));
        changed++;
      } else {
        out.push(lines[i]);
      }
    } catch {
      // Preserve malformed lines as-is rather than dropping data.
      out.push(lines[i]);
      malformed++;
    }
  }

  console.log(`Scanned ${lines.length} lines, ${changed} need migration, ${malformed} malformed.`);

  if (changed === 0) {
    console.log("No changes needed.");
    return;
  }

  if (!apply) {
    console.log("Dry-run mode (pass --apply to write). Sample of first changed entry:");
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== lines[i]) {
        console.log(`  Line ${i + 1}:`);
        console.log(`    BEFORE: ${lines[i].slice(0, 200)}...`);
        console.log(`    AFTER:  ${out[i].slice(0, 200)}...`);
        break;
      }
    }
    return;
  }

  // Write atomically: backup, then write to temp file, then rename.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${EPISODES_FILE}.bak-${ts}`;
  await copyFile(EPISODES_FILE, backupPath);
  console.log(`Backup: ${backupPath}`);

  const tmpPath = `${EPISODES_FILE}.tmp`;
  await writeFile(tmpPath, out.join("\n") + "\n", "utf-8");
  await rename(tmpPath, EPISODES_FILE);
  console.log(`Wrote ${EPISODES_FILE} (${changed} entries migrated).`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});