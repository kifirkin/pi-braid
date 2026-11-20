// Curated context return: the instruction text a compaction summarized away,
// delivered back as its own bytes.
//
// A compaction summary is a paraphrase, and a paraphrase of a rule is not the
// rule. The harness already knows which files the session read (pi's
// `CompactionDetails.readFiles` on the landed entry), so the curated subset can
// be re-delivered in the same cycle that dropped it rather than asking the model
// to spend a turn re-reading.
//
// Two invariants drive every decision here:
//
//   1. Bodies are whole and files are addressed by path. A section is the file's
//      own bytes; a file that does not fit the budget is named in a pointer line
//      instead of being cut, because a truncated instruction file is a
//      paraphrase by another name.
//   2. Nothing is complete. The population is the intersection of "an
//      instruction file" and "this session read it", never a scan for every
//      instruction file on disk: a file the session never opened is not context
//      the session lost.
//
// The module is silent: no log line per returned file, no counter. The message
// itself is the record, and it is visible in the transcript it was appended to.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../../lib/constants/injection-details.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { log } from "./shared.js";

/**
 * Basenames whose contents are instructions rather than material: the DOX
 * hierarchy, the agent contract a project carries for other tools, and the
 * design token contract. A file is curated when it is read AND named one of
 * these, which is why a source file of the same size is never returned.
 */
export const CURATED_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "DESIGN.md"] as const;

/**
 * Ceiling for one curated message, in characters. A compaction has just freed
 * this context; returning more than a small share of it would undo the cycle it
 * was meant to repair. 24k characters is roughly 6k tokens: comfortably above
 * the instruction chain a session normally reads, comfortably below any window's
 * compaction reserve.
 */
export const CURATED_CONTEXT_MAX_CHARS = 24_000;

/** Why a file the session read is not in the message. */
export type CuratedOmissionReason = "over-budget" | "unreadable" | "empty";

export interface CuratedSection {
  /** Absolute path the bytes came from; the address a reader needs. */
  path: string;
  /** The file's own bytes, unchanged. */
  text: string;
}

export interface CuratedOmission {
  path: string;
  reason: CuratedOmissionReason;
}

export interface CuratedInventory {
  sections: CuratedSection[];
  omitted: CuratedOmission[];
}

export interface CuratedInventoryInput {
  /** pi's record of the files the session read, possibly relative. */
  readFiles: readonly string[] | undefined;
  /** Base for relative entries; the session's own working directory. */
  cwd: string;
  /** Ceiling override, for a caller that knows its budget. */
  maxChars?: number;
}

/** True when a path's basename is one of the curated instruction files. */
export function isCuratedInstructionFile(path: string): boolean {
  const name = basename(path);
  return (CURATED_INSTRUCTION_FILES as readonly string[]).includes(name);
}

/**
 * The curated inventory behind one compaction: instruction files the session
 * read, resolved and deduplicated, in the order the session read them, taken as
 * a prefix that fits the ceiling.
 *
 * A prefix rather than a best-fit selection: the instruction chain is read
 * root-first, so the earliest entries are the widest contracts, and a scattered
 * subset would return a deep package's rules while dropping the repository's.
 */
export function collectCuratedInventory(input: CuratedInventoryInput): CuratedInventory {
  const maxChars = input.maxChars ?? CURATED_CONTEXT_MAX_CHARS;
  const sections: CuratedSection[] = [];
  const omitted: CuratedOmission[] = [];
  const seen = new Set<string>();
  let total = 0;
  let budgetExhausted = false;

  for (const entry of input.readFiles ?? []) {
    if (typeof entry !== "string" || !entry) continue;
    if (!isCuratedInstructionFile(entry)) continue;
    let path: string;
    try {
      path = resolve(input.cwd, entry);
    } catch {
      continue;
    }
    // A session that read the same file twice through two spellings lost one
    // body, not two: the second copy names nothing new.
    if (seen.has(path)) continue;
    seen.add(path);

    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      omitted.push({ path, reason: "unreadable" });
      continue;
    }
    if (!text.trim()) {
      omitted.push({ path, reason: "empty" });
      continue;
    }
    if (budgetExhausted || total + text.length > maxChars) {
      budgetExhausted = true;
      omitted.push({ path, reason: "over-budget" });
      continue;
    }
    sections.push({ path, text });
    total += text.length;
  }

  return { sections, omitted };
}

/** The one-line reason a reader is given for each omission kind. */
function omissionNote(omitted: readonly CuratedOmission[]): string | undefined {
  if (!omitted.length) return undefined;
  const names = omitted.map((item) => item.path).join(", ");
  const unreadable = omitted.some((item) => item.reason === "unreadable");
  const empty = omitted.some((item) => item.reason === "empty");
  const parts = ["not returned"];
  if (unreadable) parts.push("unreadable now");
  if (empty) parts.push("empty");
  if (omitted.some((item) => item.reason === "over-budget"))
    parts.push("past this message's budget");
  return `${parts.join(", ")}: ${names}. Read the ones you need by path.`;
}

/**
 * The message body: one heading per file carrying its path, the file's bytes
 * unchanged under it, and one trailing line naming what was left out. The
 * preamble is two sentences because its facts are the ones a reader acts on:
 * this text is not a summary, and the headings are addresses.
 */
export function formatCuratedText(inventory: CuratedInventory): string {
  if (!inventory.sections.length) return "";
  const lines = [
    "## Curated context returned after compaction",
    "",
    "The transcript was summarized. The text below is the files' own bytes, returned because the " +
      "session had read them and the compaction left them out of context. Each heading is the " +
      "path the text came from; none of it is a paraphrase.",
  ];
  for (const section of inventory.sections) {
    lines.push("", `### ${section.path}`, "", section.text.replace(/\s+$/, ""));
  }
  const note = omissionNote(inventory.omitted);
  if (note) lines.push("", note);
  return lines.join("\n");
}

export interface CuratedReturn extends CuratedInventory {
  /** Bytes of instruction text appended to the transcript. */
  chars: number;
}

/**
 * Deliver one compaction's curated instruction text to the agent.
 *
 * Acceptance is reported, not assumed: `sendTrackedMessage` answers whether a
 * suppression dropped the send, and a refusal here returns the empty shape so no
 * caller can count a message that reached no stream.
 */
export function reinjectCuratedContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  entry: { details?: { readFiles?: string[] } } | undefined,
): CuratedReturn {
  const empty: CuratedReturn = { sections: [], omitted: [], chars: 0 };
  try {
    const readFiles = entry?.details?.readFiles;
    if (!Array.isArray(readFiles) || readFiles.length === 0) return empty;

    const inventory = collectCuratedInventory({ readFiles, cwd: ctx.cwd || process.cwd() });
    if (!inventory.sections.length) return empty;
    const text = formatCuratedText(inventory);
    if (!text) return empty;

    const delivered = sendTrackedMessage(
      pi,
      {
        customType: "context-reinject",
        content: [{ type: "text" as const, text }],
        display: true,
        details: {
          [BRAID_INJECTED]: true,
          [BRAID_SOURCE]: "context-manager",
          curatedPaths: inventory.sections.map((section) => section.path),
          omittedPaths: inventory.omitted.map((item) => item.path),
        },
      },
      // The compaction cycle is over; the message belongs to the run that
      // resumes after it, so it is parked rather than steered into a dying loop.
      { delivery: "park", deliverAs: "steer" },
      { type: "context", source: "context-manager" },
      // The cycle guard is the bound: one message per landed compaction, and the
      // run that follows it is the reader it was assembled for. A per-turn cap
      // must not drop it here.
      { bypassFloodCap: true },
    );
    if (!delivered) return empty;
    return { ...inventory, chars: text.length };
  } catch (err) {
    log.debug("[compaction-curator] curated return skipped:", err);
    return empty;
  }
}
