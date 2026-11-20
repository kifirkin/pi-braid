#!/usr/bin/env node
/**
 * check-preferences.mjs - the gate over the preference store and its projection.
 *
 * The store is a JSON file of standing owner rules, each filed under the surface
 * that has to be in play for it to apply. The prompt builder renders the rules
 * whose surface the session can reach. Three things the store cannot check about
 * itself:
 *
 *   - a rule with no surface is bound to nothing, which has to say so. An
 *     unmarked one is an omission that reads like a surface, so it is refused by
 *     id instead of rendering somewhere nobody chose;
 *   - two rules on one surface that contradict each other. A contradiction is
 *     either declared (one entry's `contradicts` names the other) or visible from
 *     both ends (each names the other), and a declaration naming an id that is
 *     not in the store is refused too, because a link nothing holds is not a
 *     check. Every case names the ids: a pair the model has to arbitrate
 *     mid-turn is a decision nobody made;
 *   - the rendered markdown file and the store disagreeing. The file is a view
 *     for a human reader, so it may not carry a rule the store lacks, and it may
 *     not miss one the store has. Either direction is refused with the id, which
 *     is what makes the file a projection instead of a second truth.
 *
 * `--render` writes that file from the store, so the projection is generated
 * rather than remembered. It refuses to write from a store it cannot read whole:
 * a render that silently drops a rule would replace one truth with a shorter one.
 *
 * The entry contract is not restated here. It comes from the same built module
 * the prompt section reads, so the gate and the section cannot disagree about
 * what an entry is; a tree with no build gets exit 2 and the reason.
 *
 * Exit codes:
 *   0 - the store is clean and the projection agrees with it
 *   1 - at least one refusal
 *   2 - the run could not be made (no build, or an argument it does not know)
 *
 * Scope: one store and one projection, at the paths the store module resolves.
 * Nothing here reads the memory subsystem: a preference may also live in memory,
 * and this instrument neither reads nor migrates one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const EXIT_REFUSED = 1;
const EXIT_CANNOT_RUN = 2;

let storeModule;
try {
  storeModule = await import("../dist/lib/preferences/store.js");
} catch (error) {
  console.error(
    `Preference gate: cannot run - the store contract is not built (${error.message}).`,
  );
  console.error(
    "  Run `npm run build` first: the gate reads the entry contract from the same module the prompt section reads.",
  );
  process.exit(EXIT_CANNOT_RUN);
}

const { readPreferences, preferencesFilePath, preferencesDocPath, sinceDate, describeStoreRefusal } =
  storeModule;

const RENDER = process.argv.includes("--render");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--render" && arg.startsWith("--"));
if (unknownArgs.length > 0) {
  console.error(`Preference gate: cannot run - unknown argument(s): ${unknownArgs.join(" ")}`);
  console.error("  Usage: node packages/core/scripts/check-preferences.mjs [--render]");
  process.exit(EXIT_CANNOT_RUN);
}

const storePath = preferencesFilePath();
const docPath = preferencesDocPath();

/** Refusals raised this run, each with the class that names why it was raised. */
const refusals = [];
const refuse = (kind, message) => refusals.push({ kind, message });

/** The store's own wording, flattened to one line. */
const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * A rule's surface as the projection writes it. `none` is the unbound state, and
 * it is written on every block so a reader who lands on one heading still sees
 * the surface its rule is filed under.
 */
const surfaceField = (entry) => entry.surface ?? "none";

/** Rules grouped by surface, in store order; the unbound state keeps its own key. */
function entriesBySurface(readResult) {
  const bySurface = new Map();
  for (const entry of readResult.entries) {
    const surface = surfaceField(entry);
    if (!bySurface.has(surface)) bySurface.set(surface, []);
    bySurface.get(surface).push(entry);
  }
  return bySurface;
}

const read = readPreferences(storePath);

// ── Refusals the store raises about itself ─────────────────────────────────

if (!read.ok) {
  refuse("store-unreadable", `store ${describeStoreRefusal(read)}; nothing was checked`);
} else {
  for (const rejection of read.rejected) {
    const handle = rejection.id === null ? `entry ${rejection.index}` : `entry "${rejection.id}"`;
    refuse("entry-unreadable", `${handle} could not be read: ${rejection.reason}`);
  }
  for (const entry of read.entries) {
    if (surfaceField(entry) !== "none" || entry.unbound === true) continue;
    refuse(
      "unbound-without-mark",
      `entry "${entry.id}" names no surface and is not marked unbound; a rule nothing can fire says so, or names the surface it governs`,
    );
  }
  collectContradictions(read);
}

/**
 * Every contradiction the store declares, once per unordered pair, with the two
 * readings of "contradicts" separated: two rules on one surface, or a pair that
 * names each other wherever they sit. A declaration naming an unknown id, or an
 * entry naming itself, is refused in its own right: a link nothing holds is not
 * a check.
 */
function collectContradictions(readResult) {
  const index = new Map(readResult.entries.map((entry) => [entry.id, entry]));
  const declared = new Map();
  for (const entry of readResult.entries) {
    for (const other of entry.contradicts ?? []) {
      declared.set(entry.id, [...(declared.get(entry.id) ?? []), other]);
    }
  }
  const seen = new Set();
  for (const [id, others] of declared) {
    for (const other of others) {
      const target = index.get(other);
      if (target === undefined) {
        refuse(
          "contradiction-dangling",
          `entry "${id}" declares a contradiction with "${other}", which is not in the store`,
        );
        continue;
      }
      if (other === id) {
        refuse("contradiction", `entry "${id}" declares a contradiction with itself`);
        continue;
      }
      const [first, second] = [id, other].sort();
      const key = `${first}|${second}`;
      if (seen.has(key)) continue;
      const a = index.get(first);
      const b = index.get(second);
      const sameSurface = a.surface !== null && a.surface === b.surface;
      const mutual = (declared.get(second) ?? []).includes(first);
      if (!sameSurface && !mutual) continue;
      seen.add(key);
      refuse(
        "contradiction",
        `entries "${first}" and "${second}" contradict ${sameSurface ? `on surface "${a.surface}"` : "by mutual declaration across surfaces"}`,
      );
    }
  }
}

// ── The projection ─────────────────────────────────────────────────────────

function renderDoc(readResult) {
  const lines = [
    "<!-- Generated by `node packages/core/scripts/check-preferences.mjs --render`. -->",
    `<!-- A view of the store at ${storePath} (version ${readResult.version}); the store is the truth. -->`,
    "",
    "# Standing preferences",
    "",
    "Each rule below is projected from the preference store: the surface it applies on, the day it",
    "began, and where it came from. Edit the store, then render again; the gate refuses a rule that",
    "appears on one side only.",
  ];
  for (const [surface, entries] of entriesBySurface(readResult)) {
    lines.push("", surface === "none" ? "## no surface (unbound)" : `## ${surface}`, "");
    for (const entry of entries) {
      lines.push(`### \`${entry.id}\``, "");
      lines.push(`- surface: ${surface}`);
      lines.push(`- rule: ${collapse(entry.rule)}`);
      lines.push(`- since: ${sinceDate(entry.since) ?? collapse(entry.since)}`);
      lines.push(`- source: ${collapse(entry.source)}`);
      if (entry.contradicts && entry.contradicts.length > 0) {
        lines.push(`- contradicts: ${entry.contradicts.map((id) => `\`${id}\``).join(", ")}`);
      }
      lines.push("");
    }
  }
  // One blank line between blocks: each rule block ends with one, and the next
  // surface heading opens with one, so the pair would read as two.
  const spaced = lines.filter((line, index) => !(line === "" && lines[index - 1] === ""));
  return `${spaced.join("\n").trimEnd()}\n`;
}

/** The projection read back: id -> the fields its block carries. */
function parseDoc(source) {
  const blocks = new Map();
  const duplicated = [];
  let current = null;
  const flush = () => {
    if (current === null) return;
    if (blocks.has(current.id)) duplicated.push(current.id);
    blocks.set(current.id, current.fields);
    current = null;
  };
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { id: heading[1].replace(/`/g, "").trim(), fields: {} };
      continue;
    }
    if (/^##\s+/.test(line)) {
      flush();
      continue;
    }
    if (current === null) continue;
    const bullet = /^-\s+(surface|rule|since|source|contradicts):\s*(.*)$/.exec(line);
    if (bullet) current.fields[bullet[1]] = bullet[2].trim();
  }
  flush();
  return { blocks, duplicated };
}

function compareDoc(readResult) {
  let source;
  try {
    source = readFileSync(docPath, "utf-8");
  } catch (error) {
    // Nothing to project is not a disagreement: a store with no rules and no
    // file is the state before anyone has written a preference, and it stays
    // clean. A file that does exist is read below, and a rule in it that the
    // store does not have is refused like any other extra.
    if (readResult.entries.length === 0) return;
    refuse(
      "projection-missing",
      `rendered file ${docPath} cannot be read (${error.message}); run the gate with --render to write it from the store`,
    );
    return;
  }

  const { blocks, duplicated } = parseDoc(source);
  for (const id of duplicated) {
    refuse("projection-duplicate", `rendered file ${docPath} carries rule "${id}" more than once`);
  }

  for (const entry of readResult.entries) {
    const block = blocks.get(entry.id);
    if (block === undefined) {
      refuse(
        "projection-missing-rule",
        `rule "${entry.id}" is in the store and missing from ${docPath}; run the gate with --render`,
      );
      continue;
    }
    const differences = [];
    if (block.surface !== surfaceField(entry)) {
      differences.push(`surface "${block.surface ?? "absent"}" is not "${surfaceField(entry)}"`);
    }
    if (collapse(block.rule ?? "") !== collapse(entry.rule)) differences.push("rule text differs");
    const day = sinceDate(entry.since) ?? collapse(entry.since);
    if ((block.since ?? "") !== day) {
      differences.push(`since "${block.since ?? "absent"}" is not "${day}"`);
    }
    if (collapse(block.source ?? "") !== collapse(entry.source)) differences.push("source differs");
    const declared = [...(entry.contradicts ?? [])].sort().join(",");
    const printed = (block.contradicts ?? "")
      .split(",")
      .map((item) => item.replace(/`/g, "").trim())
      .filter(Boolean)
      .sort()
      .join(",");
    if (declared !== printed) differences.push("declared contradictions differ");
    if (differences.length > 0) {
      refuse(
        "projection-differs",
        `rule "${entry.id}" differs between the store and ${docPath}: ${differences.join("; ")}`,
      );
    }
  }

  const storeIds = new Set(readResult.entries.map((entry) => entry.id));
  for (const id of blocks.keys()) {
    if (storeIds.has(id)) continue;
    refuse(
      "projection-extra-rule",
      `rule "${id}" is in ${docPath} and not in the store; a projection cannot carry a rule the store does not`,
    );
  }
}

// ── Run ────────────────────────────────────────────────────────────────────

if (RENDER) {
  if (refusals.length > 0) {
    report(read);
    console.log("\n  Preference gate: FAIL - refusing to write a projection from a store with refusals");
    process.exit(EXIT_REFUSED);
  }
  mkdirSync(dirname(docPath), { recursive: true });
  writeFileSync(docPath, renderDoc(read), "utf-8");
  console.log(
    `Preference gate: wrote ${docPath} (${read.entries.length} rule${read.entries.length === 1 ? "" : "s"} from ${storePath})`,
  );
  process.exit(0);
}

if (read.ok) compareDoc(read);
report(read);

if (refusals.length > 0) {
  console.log(
    `\n  Preference gate: FAIL (${refusals.length} refusal${refusals.length === 1 ? "" : "s"})`,
  );
  process.exit(EXIT_REFUSED);
}
console.log("\n  Preference gate: PASS");

// ── Reporting ──────────────────────────────────────────────────────────────

function report(readResult) {
  console.log(`Preference gate: store ${storePath}`);
  if (!readResult.ok) {
    console.log(`  store: unreadable (${readResult.error})`);
  } else {
    console.log(
      `  store: version ${readResult.version}, ${readResult.entries.length} rule(s), ${readResult.rejected.length} unreadable entr${readResult.rejected.length === 1 ? "y" : "ies"}`,
    );
    const surfaces = entriesBySurface(readResult);
    if (surfaces.size === 0) {
      console.log("  surfaces: none (the store holds no rules)");
    } else {
      for (const [surface, entries] of surfaces) {
        console.log(`  surface ${surface}: ${entries.length} rule(s)`);
      }
    }
  }
  console.log(`  rendered file: ${docPath}`);
  if (refusals.length === 0) return;
  console.log(`\n  Refused (${refusals.length}):`);
  for (const refusal of refusals) console.log(`    [${refusal.kind}] ${refusal.message}`);
}
