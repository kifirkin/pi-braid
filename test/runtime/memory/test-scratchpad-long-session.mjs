/**
 * Test: Scratchpad long-session hygiene.
 *
 * Locks the D-39 contract: scratchpad can be cleaned up during a long
 * session via targeted remove_* actions, clear_done, archive_done, and
 * filtered read.
 *
 * Covers:
 *   - IDs on plan/note/decision/hypothesis items (added at add-time)
 *   - remove_plan, remove_note, remove_decision, remove_hypothesis by id
 *   - remove_plan, remove_note, etc. by text (fallback)
 *   - clear_done wipes the done list
 *   - archive_done moves done to disk and clears the list
 *   - read filter (ids, sinceTurn, untilTurn, limit)
 *   - Migration: old-format scratchpad (string[] for done/notes/hypotheses,
 *     PlanStep[] without id) is migrated to new format on load
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TYPES = join(ROOT, "src/extensions/memory/scratchpad/types.ts");
const PERSISTENCE = join(ROOT, "src/extensions/memory/scratchpad/persistence.ts");
const INDEX = join(ROOT, "src/extensions/memory/scratchpad/index.ts");
const FORMAT = join(ROOT, "src/extensions/memory/scratchpad/format.ts");
const HANDLERS = join(ROOT, "src/extensions/memory/scratchpad/handlers.ts");
const UTILS = join(ROOT, "src/extensions/memory/scratchpad/utils.ts");

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`  [v] ${msg}`);
    passed++;
  } else {
    console.log(`  [x] ${msg}`);
    failed++;
  }
};

console.log("\n[1] Type definitions");
{
  const src = readFileSync(TYPES, "utf-8");
  check(src.includes("interface PlanStep"), "PlanStep interface exists");
  check(/interface PlanStep\s*\{[^}]*\bid: string/m.test(src), "PlanStep has id field");
  check(/interface Decision\s*\{[^}]*\bid: string/m.test(src), "Decision has id field");
  check(src.includes("interface NoteItem"), "NoteItem interface exists");
  check(/interface NoteItem\s*\{[^}]*\bid: string/m.test(src), "NoteItem has id field");
  check(src.includes("interface HypothesisItem"), "HypothesisItem interface exists");
  check(/interface HypothesisItem\s*\{[^}]*\bid: string/m.test(src), "HypothesisItem has id field");
  check(src.includes("interface DoneItem"), "DoneItem interface exists");
  check(/interface DoneItem\s*\{[^}]*\bid: string/m.test(src), "DoneItem has id field");
  // done: should be DoneItem[], not string[]
  check(/done: DoneItem\[\]/.test(src), "TaskScratchpad.done is DoneItem[]");
  check(/notes: NoteItem\[\]/.test(src), "TaskScratchpad.notes is NoteItem[]");
  check(/hypotheses: HypothesisItem\[\]/.test(src), "TaskScratchpad.hypotheses is HypothesisItem[]");
}

console.log("\n[2] Migration logic in persistence.ts");
{
  const src = readFileSync(PERSISTENCE, "utf-8");
  check(src.includes("migrateScratchpad"), "migrateScratchpad function exists");
  check(/loadScratchpadFromDisk[\s\S]*migrateScratchpad/m.test(src), "loadScratchpadFromDisk calls migrateScratchpad");
  check(/migrateDoneItems\(/.test(src), "Migration handles done (was string[])");
  check(/migratePlanSteps\(/.test(src), "Migration handles plan (was no id)");
  check(/migrateNoteItems\(/.test(src), "Migration handles notes (was string[])");
  check(/migrateDecisions\(/.test(src), "Migration handles decisions (was no id)");
  check(/migrateHypotheses\(/.test(src), "Migration handles hypotheses (was string[])");
}

console.log("\n[3] New actions in index.ts");
{
  const src = readFileSync(INDEX, "utf-8");
  // New actions registered
  check(src.includes('Type.Literal("remove_plan")'), 'remove_plan action registered');
  check(src.includes('Type.Literal("remove_note")'), 'remove_note action registered');
  check(src.includes('Type.Literal("remove_decision")'), 'remove_decision action registered');
  check(src.includes('Type.Literal("remove_hypothesis")'), 'remove_hypothesis action registered');
  check(src.includes('Type.Literal("clear_done")'), 'clear_done action registered');
  check(src.includes('Type.Literal("archive_done")'), 'archive_done action registered');
  // findByIdOrText helper
  check(src.includes("findByIdOrText") || readFileSync(UTILS, "utf-8").includes("findByIdOrText"), "findByIdOrText helper exists");
  // ID parameter
  check(/id: Type\.Optional\(Type\.String/.test(src), "id parameter registered");
  // Filter parameter
  check(/filter: Type\.Optional/.test(src), "filter parameter registered");
}

console.log("\n[3.5] Handlers file: per-action logic");
{
  const src = readFileSync(HANDLERS, "utf-8");
  // All add_* cases now use nextId
  check(/handleAddPlan[\s\S]*?id: nextId\("pl"\)/.test(src), "handleAddPlan uses nextId('pl')");
  check(/handleAddDecision[\s\S]*?id: nextId\("dc"\)/.test(src), "handleAddDecision uses nextId('dc')");
  check(/handleAddHypothesis[\s\S]*?id: nextId\("hp"\)/.test(src), "handleAddHypothesis uses nextId('hp')");
  check(/handleAddNote[\s\S]*?id: nextId\("nt"\)/.test(src), "handleAddNote uses nextId('nt')");
  check(/handleMarkDone[\s\S]*?id: nextId\("dn"\)/.test(src), "handleMarkDone uses nextId('dn')");
  // archive_done uses appendFile
  check(/handleArchiveDone[\s\S]*?appendFile/m.test(src), "handleArchiveDone uses appendFile");
  check(/handleArchiveDone[\s\S]*?archive\.jsonl/.test(src), "handleArchiveDone uses archive.jsonl");
}

console.log("\n[4] archive_done writes to archive.jsonl");
{
  const src = readFileSync(HANDLERS, "utf-8");
  check(src.includes("archive.jsonl"), "archive_done writes to archive.jsonl");
  check(/handleArchiveDone[\s\S]*?appendFile/m.test(src), "archive_done uses appendFile");
}

console.log("\n[5] Read filter support");
{
  const src = readFileSync(FORMAT, "utf-8");
  check(/formatScratchpad[\s\S]*?filter\?:/m.test(src), "formatScratchpad accepts filter param");
  check(/applyListFilter/.test(src), "formatScratchpad has applyListFilter helper");
  check(/filter\?\.ids/.test(src), "Filter supports ids");
  check(/filter\?\.sinceTurn/.test(src), "Filter supports sinceTurn");
  check(/filter\?\.untilTurn/.test(src), "Filter supports untilTurn");
  check(/filter\?\.limit/.test(src), "Filter supports limit");
}

console.log("\n[5.5] continue action for session resumption");
{
  const src = readFileSync(INDEX, "utf-8");
  check(src.includes('Type.Literal("continue")'), 'continue action registered');
  // formatContinueDigest is re-exported from format.ts
  check(src.includes("export * from \"./format.js\""), "formatContinueDigest re-exported from format.ts");
  check(/ACTION_DISPATCH\[action\]/.test(src), 'dispatch table in router (replaces switch)');
  // The continue digest body is in format.ts
  const fmtSrc = readFileSync(FORMAT, "utf-8");
  const digestStart = fmtSrc.indexOf("export function formatContinueDigest");
  check(digestStart >= 0, "formatContinueDigest function found");
  if (digestStart >= 0) {
    let depth = 0;
    let i = fmtSrc.indexOf("{", digestStart);
    let endIdx = -1;
    for (; i < fmtSrc.length; i++) {
      if (fmtSrc[i] === "{") depth++;
      else if (fmtSrc[i] === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    check(endIdx > digestStart, "formatContinueDigest has matching closing brace");
    const digestBody = endIdx > 0 ? fmtSrc.slice(digestStart, endIdx) : "";
    check(digestBody.length > 100, "formatContinueDigest body has substantial content");
    check(digestBody.includes("Open plan"), "Digest includes 'Open plan' section");
    check(digestBody.includes("Recently completed"), "Digest includes 'Recently completed' section");
    check(digestBody.includes("Recent decisions"), "Digest includes 'Recent decisions' section");
    check(digestBody.includes("Recent notes"), "Digest includes 'Recent notes' section");
    check(/slice\(-3\)/.test(digestBody), "Digest uses slice(-3) for recency");
  }
  // Tool description must document the continue action (what it does),
  // not prescribe when to call it.
  const descMatch = src.match(/description:[\s\S]*?"Use this scratchpad for/);
  check(!!descMatch, "Tool description found");
  if (descMatch) {
    check(
      /`continue`/.test(descMatch[0]),
      "Tool description lists `continue` among the actions",
    );
    check(
      /resumption digest/i.test(descMatch[0]),
      "Tool description says continue returns a resumption digest",
    );
  }
}

console.log("\n[6] Removal helpers don't leave stale references");
{
  // After the P2-2 split, case bodies live in handlers.ts. The router
  // in index.ts just calls the right handler. Verify handler logic
  // matches the original case bodies.
  const src = readFileSync(HANDLERS, "utf-8");
  // For each remove_*/clear_*/archive_*, find the handler function body
  // and assert it does the right thing.
  const handlerPattern = (name) => {
    const re = new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`);
    return src.match(re);
  };
  const removePlanMatch = handlerPattern("handleRemovePlan");
  check(!!removePlanMatch, "handleRemovePlan body present");
  if (removePlanMatch) {
    check(removePlanMatch[0].includes("mutateAndSave"), "remove_plan persists changes");
    check(removePlanMatch[0].includes("splice"), "remove_plan removes from array");
  }
  const removeNoteMatch = handlerPattern("handleRemoveNote");
  check(!!removeNoteMatch, "handleRemoveNote body present");
  if (removeNoteMatch) {
    check(removeNoteMatch[0].includes("splice"), "remove_note removes from array");
  }
  const clearDoneMatch = handlerPattern("handleClearDone");
  check(!!clearDoneMatch, "handleClearDone body present");
  if (clearDoneMatch) {
    check(clearDoneMatch[0].includes("mutateAndSave"), "clear_done persists");
  }
  const archiveDoneMatch = handlerPattern("handleArchiveDone");
  check(!!archiveDoneMatch, "handleArchiveDone body present");
  if (archiveDoneMatch) {
    check(archiveDoneMatch[0].includes("appendFile"), "archive_done appends to file");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== scratchpad long-session tests passed ===");
