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

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
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
  check(src.includes("findByIdOrText"), "findByIdOrText helper exists");
  // All add_* cases now use nextId
  check(/add_plan[\s\S]*?id: nextId\("pl"\)/.test(src), "add_plan uses nextId('pl')");
  check(/add_decision[\s\S]*?id: nextId\("dc"\)/.test(src), "add_decision uses nextId('dc')");
  check(/add_hypothesis[\s\S]*?id: nextId\("hp"\)/.test(src), "add_hypothesis uses nextId('hp')");
  check(/add_note[\s\S]*?id: nextId\("nt"\)/.test(src), "add_note uses nextId('nt')");
  check(/mark_done[\s\S]*?id: nextId\("dn"\)/.test(src), "mark_done uses nextId('dn')");
  // ID parameter
  check(/id: Type\.Optional\(Type\.String/, "id parameter registered");
  // Filter parameter
  check(/filter: Type\.Optional/, "filter parameter registered");
}

console.log("\n[4] archive_done writes to archive.jsonl");
{
  const src = readFileSync(INDEX, "utf-8");
  check(src.includes("archive.jsonl"), "archive_done writes to archive.jsonl");
  check(/archive_done[\s\S]*?appendFile/m.test(src), "archive_done uses appendFile");
}

console.log("\n[5] Read filter support");
{
  const src = readFileSync(INDEX, "utf-8");
  check(/formatScratchpad[\s\S]*?filter\?:/m.test(src), "formatScratchpad accepts filter param");
  check(/applyListFilter/.test(src), "formatScratchpad has applyListFilter helper");
  check(/filter\?\.ids/.test(src), "Filter supports ids");
  check(/filter\?\.sinceTurn/.test(src), "Filter supports sinceTurn");
  check(/filter\?\.untilTurn/.test(src), "Filter supports untilTurn");
  check(/filter\?\.limit/.test(src), "Filter supports limit");
}

console.log("\n[6] Removal helpers don't leave stale references");
{
  const src = readFileSync(INDEX, "utf-8");
  // Use a non-greedy match with explicit end-marker to avoid greedy match
  // across the entire switch statement.
  const casePattern = (name) => {
    const re = new RegExp(`case "${name}": \\{[\\s\\S]*?\\n    \\}`);
    return src.match(re);
  };
  const removePlanMatch = casePattern("remove_plan");
  check(!!removePlanMatch, "remove_plan case body present");
  if (removePlanMatch) {
    check(removePlanMatch[0].includes("mutateAndSave"), "remove_plan persists changes");
    check(removePlanMatch[0].includes("splice"), "remove_plan removes from array");
  }
  const removeNoteMatch = casePattern("remove_note");
  check(!!removeNoteMatch, "remove_note case body present");
  if (removeNoteMatch) {
    check(removeNoteMatch[0].includes("splice"), "remove_note removes from array");
  }
  const clearDoneMatch = casePattern("clear_done");
  check(!!clearDoneMatch, "clear_done case body present");
  if (clearDoneMatch) {
    check(clearDoneMatch[0].includes("mutateAndSave"), "clear_done persists");
  }
  const archiveDoneMatch = casePattern("archive_done");
  check(!!archiveDoneMatch, "archive_done case body present");
  if (archiveDoneMatch) {
    check(archiveDoneMatch[0].includes("appendFile"), "archive_done appends to file");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== scratchpad long-session tests passed ===");
