#!/usr/bin/env node
/**
 * test-trigger-cap.mjs — an authored trigger list must fit the reader's caps.
 *
 * skill-triggers.ts reads a skill's trigger phrases from every place an author
 * writes them, spends MAX_TRIGGERS on the merged list, and drops any phrase
 * longer than MAX_TRIGGER_CHARS. Both cuts are silent: the skill simply stops
 * matching words its own file claims. Asking the reader how many phrases a file
 * declares cannot answer the question, because the cap is already spent by the
 * time the list is returned — so this fixture parses the authored declarations
 * itself, same sources and same order, with no cap, and compares the counts to
 * the two constants imported from the built module. Restating the caps here
 * would let a changed cap leave the fixture behind.
 *
 * The instrument is checked against its subject: for every skill, the phrases
 * the reader returns must be the prefix of this fixture's own authored list. A
 * source the reader grows, or a parse this fixture gets wrong, therefore fails
 * by name instead of quietly under-counting.
 *
 * A shipped skill authoring past a cap cannot be repaired from test — the packs
 * are content — so each such loss is pinned by name and exact figure. A pin
 * whose skill grew fails, a pin whose skill fits the cap again is stale and
 * fails, and the pinned losses print on every run: the deficit can shrink
 * without an edit here, and it cannot grow. Removing a pin is the edit that
 * records a repair.
 *
 * Planted controls: a copy of a shipped pack is scanned under a temp directory,
 * never the real tree. The unmodified copy must pass, then one skill gains a
 * phrase past the count cap and, in a second copy, one phrase past the
 * character cap; both must fail naming the skill, the figure and the cap. The
 * children run this same file with PI_TRIGGER_CAP_PACKS set, which is the only
 * reason that variable exists.
 *
 * Run: node test/runtime/lib/test-trigger-cap.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = fileURLToPath(import.meta.url);
const CORE = resolve(HERE, "..", "..", "..");
const REPO = resolve(CORE, "..", "..");
const DIST = join(CORE, "dist", "extensions", "core", "skills-tool", "skill-triggers.js");

const { MAX_TRIGGER_CHARS, MAX_TRIGGERS, parseDescriptionTriggers, readSkillTriggerEntries } =
  await import(DIST);

/** The packs this repository ships, each with the label a failure prints. */
const SHIPPED_PACKS = [
  { dir: join(CORE, "skills"), label: "packages/core/skills" },
  { dir: join(REPO, "packages", "skills", "skills"), label: "packages/skills/skills" },
];

/** The pack the planted controls copy: no pinned row names a skill in it. */
const CONTROL_PACK = join(REPO, "packages", "skills", "skills");

/**
 * A control child scans the pack it is given instead of the shipped ones. The
 * variable is the seam that keeps the planted copies out of the real tree.
 */
const GIVEN_PACKS = process.env.PI_TRIGGER_CAP_PACKS;
const IS_CONTROL_CHILD = GIVEN_PACKS !== undefined;

/** A pack's label: its path from the repo root, or its own name for a copy. */
function packLabel(dir) {
  const rel = relative(REPO, dir);
  return rel.startsWith("..") ? `${basename(dir)} copy` : rel;
}

function packsToScan() {
  if (IS_CONTROL_CHILD) {
    return GIVEN_PACKS.split(delimiter)
      .filter((dir) => dir !== "")
      .map((dir) => ({ dir: resolve(dir), label: packLabel(resolve(dir)) }));
  }
  return SHIPPED_PACKS;
}

/**
 * Standing count losses, pinned so the deficit can only shrink.
 *
 * Key: the skill directory. Value: how many phrases it authored. Such a skill
 * loses its tail to the reader's cap, which is the defect this fixture exists
 * to make loud; it survives here only because trimming a pack is a content
 * decision, not a test one. Delete a row once its skill fits the cap.
 */
const PINNED_OVER_CAP = new Map([
  ["braid-reference", 16],
  ["pi-reference", 15],
  ["voice-replies", 13],
]);

/**
 * Standing over-long phrases, pinned for the same reason: skill directory to
 * the exact phrase. The reader drops such a phrase before matching, so the file
 * claims a trigger that can never fire. A different over-long phrase is not
 * covered by the pin, and shortening the pinned one makes the pin stale.
 */
const PINNED_LONG_PHRASE = new Map([
  ["subagent-verification", "when verifying integration of pi-braid-lib into dependent packages"],
]);

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const BODY_HEADING = /^##\s*triggers?\s*:\s*(.*)$/i;

/** Quotes around a declaration are stripped; that is what the reader keeps. */
function clean(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

/** The comma-separated form the reader splits: one string, many phrases. */
function splitPhrases(value) {
  return value
    .split(",")
    .map(clean)
    .filter((phrase) => phrase !== "");
}

function frontmatterOf(text) {
  const block = FRONTMATTER.exec(text);
  return block ? { front: block[1], body: text.slice(block[0].length) } : { front: "", body: text };
}

/** First `key: value` line, quotes stripped, or null. */
function field(front, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(front);
  return match ? clean(match[1]) : null;
}

/**
 * Entries authored under `trigger:` / `triggers:`, in file order. The inline
 * form splits on commas; a block-list item is one phrase even when it carries
 * a comma, matching how the reader normalizes a YAML list.
 */
function frontmatterList(front, key) {
  const lines = front.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (start < 0) return [];
  const inline = lines[start].replace(new RegExp(`^${key}\\s*:`), "").trim();
  if (inline !== "" && inline !== "[]") return splitPhrases(inline.replace(/^\[|\]$/g, ""));
  const list = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (!item) {
      if (/^\s*$/.test(line)) continue;
      break;
    }
    const phrase = clean(item[1]);
    if (phrase !== "") list.push(phrase);
  }
  return list;
}

/** Phrases from the first `## trigger:` body heading; later ones are not input. */
function bodyHeading(body) {
  for (const line of body.split(/\r?\n/)) {
    const match = BODY_HEADING.exec(line);
    if (match) {
      const value = clean(match[1]);
      if (value !== "") return splitPhrases(value);
    }
  }
  return [];
}

/** Phrases from the description's trailing "Triggers: …" segment. */
function descriptionTail(description) {
  const idx = description.toLowerCase().lastIndexOf("triggers:");
  if (idx < 0) return [];
  const tail = description
    .slice(idx + "triggers:".length)
    .replace(/[.。]*\s*$/, "")
    .trim();
  if (tail === "") return [];
  // The reader decides whether a tail is input at all: a tail it parses no
  // phrase from is one it drops whole, so it cannot cost the count cap anything.
  if (parseDescriptionTriggers(description).length === 0) return [];
  return splitPhrases(tail);
}

/**
 * Every phrase the file authors, in the reader's source order, with no cap and
 * no length filter — the list the cap is measured against. Duplicates collapse
 * onto the first authoring source, as the reader merges them.
 */
function authoredPhrases(file) {
  const { front, body } = frontmatterOf(readFileSync(file, "utf8"));
  const description = field(front, "description") ?? "";
  const sources = [
    frontmatterList(front, "trigger"),
    frontmatterList(front, "triggers"),
    bodyHeading(body),
    descriptionTail(description),
  ];
  const phrases = [];
  for (const source of sources) {
    for (const raw of source) {
      const phrase = raw.trim().toLowerCase();
      if (phrase !== "" && !phrases.includes(phrase)) phrases.push(phrase);
    }
  }
  return { description, phrases };
}

/** The authored list under the reader's two caps: what must equal its output. */
function readerView(phrases) {
  const kept = [];
  for (const phrase of phrases) {
    if (phrase.length > MAX_TRIGGER_CHARS || kept.includes(phrase)) continue;
    if (kept.length >= MAX_TRIGGERS) break;
    kept.push(phrase);
  }
  return kept;
}

/** Every SKILL.md under a pack, one directory per skill. */
function skillsIn(label, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = join(dir, entry.name, "SKILL.md");
    try {
      readFileSync(file);
    } catch {
      continue; // a shared fragment directory, not a skill
    }
    skills.push({ file, name: entry.name, where: `${label}/${entry.name}` });
  }
  return skills;
}

/**
 * Scan every given pack and judge each skill against the reader's caps.
 * Returns the census (scanned, highest count, longest phrase), the standing
 * losses let through by a pin, and every problem found.
 */
function scan(packs) {
  const skills = packs.flatMap((pack) => skillsIn(pack.label, pack.dir));
  const result = { counts: [], debt: [], longest: null, maxCount: null, problems: [], scanned: 0 };
  if (skills.length === 0) {
    result.problems.push(
      `no SKILL.md found under ${packs.map((pack) => pack.label).join(", ")} — a scan over nothing proves nothing`,
    );
    return result;
  }
  result.scanned = skills.length;
  const seenPins = new Set();

  for (const skill of skills) {
    const { description, phrases } = authoredPhrases(skill.file);
    const count = phrases.length;
    result.counts.push({ count, name: skill.name, where: skill.where });
    if (!result.maxCount || count > result.maxCount.count) {
      result.maxCount = { count, where: skill.where };
    }

    // The reader must have read the prefixes of this list, in this order. A
    // disagreement means the fixture's sources, not the pack, are out of date.
    const read = readSkillTriggerEntries(skill.file, description).map((entry) => entry.phrase);
    const mirror = readerView(phrases);
    for (let index = 0; index < Math.max(read.length, mirror.length); index += 1) {
      if (read[index] !== mirror[index]) {
        result.problems.push(
          `${skill.where}: this fixture's authored parse and the reader disagree at phrase ${index + 1} (fixture ${JSON.stringify(mirror[index])}, reader ${JSON.stringify(read[index])}); update the fixture's sources, not the pack`,
        );
        break;
      }
    }

    const pinnedCount = PINNED_OVER_CAP.get(skill.name);
    if (count > MAX_TRIGGERS) {
      seenPins.add(skill.name);
      if (pinnedCount === undefined) {
        result.problems.push(
          `${skill.where}: ${count} authored trigger phrases; the reader keeps ${MAX_TRIGGERS} (MAX_TRIGGERS), so ${count - MAX_TRIGGERS} phrase(s) never reach the matcher`,
        );
      } else if (count > pinnedCount) {
        result.problems.push(
          `${skill.where}: ${count} authored trigger phrases; the reader keeps ${MAX_TRIGGERS} (MAX_TRIGGERS) and this skill is pinned at ${pinnedCount} — the loss grew`,
        );
      } else if (count < pinnedCount) {
        result.problems.push(
          `${skill.where}: pinned at ${pinnedCount} authored trigger phrases but authors ${count}; the pin is stale, lower or delete it`,
        );
      } else {
        result.debt.push({
          text: `${skill.where} ${count}>${MAX_TRIGGERS} phrases`,
          where: skill.where,
        });
      }
    } else if (pinnedCount !== undefined) {
      seenPins.add(skill.name);
      result.problems.push(
        `${skill.where}: pinned at ${pinnedCount} authored trigger phrases but authors ${count} (the reader keeps ${MAX_TRIGGERS}); the pin is stale, delete it`,
      );
    }

    const pinnedPhrase = PINNED_LONG_PHRASE.get(skill.name);
    for (const phrase of phrases) {
      if (!result.longest || phrase.length > result.longest.length) {
        result.longest = { length: phrase.length, phrase, where: skill.where };
      }
      if (phrase.length <= MAX_TRIGGER_CHARS) continue;
      if (pinnedPhrase === phrase) {
        result.debt.push({
          text: `${skill.where} ${phrase.length}>${MAX_TRIGGER_CHARS} chars "${phrase}"`,
          where: skill.where,
        });
      } else {
        result.problems.push(
          `${skill.where}: trigger phrase "${phrase}" is ${phrase.length} chars; the reader drops phrases over ${MAX_TRIGGER_CHARS} (MAX_TRIGGER_CHARS), so it never matches`,
        );
      }
    }
    if (
      pinnedPhrase !== undefined &&
      !(phrases.includes(pinnedPhrase) && pinnedPhrase.length > MAX_TRIGGER_CHARS)
    ) {
      result.problems.push(
        `${skill.where}: the pinned over-long phrase is no longer authored past ${MAX_TRIGGER_CHARS} chars; delete the pin`,
      );
    }
  }

  // A pin whose skill left the scan is a stale row. Only the full run can tell,
  // because a control child scans one pack.
  if (!IS_CONTROL_CHILD) {
    for (const name of [...PINNED_OVER_CAP.keys(), ...PINNED_LONG_PHRASE.keys()]) {
      if (!seenPins.has(name) && !skills.some((skill) => skill.name === name)) {
        result.problems.push(`pinned skill "${name}" is in no scanned pack; delete its pin`);
      }
    }
  }
  return result;
}

/** The printed census: what was examined, how close to the caps, what stands. */
function censusLine(result) {
  const caps = `MAX_TRIGGERS ${MAX_TRIGGERS}, MAX_TRIGGER_CHARS ${MAX_TRIGGER_CHARS}`;
  const standing =
    result.problems.length > 0
      ? `${result.problems.length} problem(s)`
      : result.debt.length === 0
        ? "within both caps"
        : `no new loss (${result.debt.length} pinned)`;
  const highest = result.maxCount
    ? `${result.maxCount.count} (${result.maxCount.where})`
    : "none";
  const longest = result.longest
    ? `${result.longest.length} chars (${result.longest.where})`
    : "none";
  return `trigger-cap: ${result.scanned} skill(s) examined, ${standing}; ${caps}; highest authored count ${highest}; longest phrase ${longest}`;
}

/** One line per standing loss, so a pinned row is never silent. */
function debtLine(result) {
  if (result.debt.length === 0) return null;
  return `trigger-cap debt: ${result.debt.map((row) => row.text).join("; ")}`;
}

/** Copy a shipped pack into a throwaway directory; the caller removes it. */
function copyPack() {
  const tree = mkdtempSync(join(tmpdir(), "trigger-cap-"));
  const copy = join(tree, "skills");
  cpSync(CONTROL_PACK, copy, { recursive: true });
  return { copy, tree };
}

/** Insert one frontmatter line into a skill file, keeping the block valid. */
function plantFrontmatter(file, line) {
  const text = readFileSync(file, "utf8");
  const block = /^---\r?\n/.exec(text);
  assert.ok(block, `${file}: the planted skill must open with a frontmatter block`);
  writeFileSync(file, `${block[0]}${line}\n${text.slice(block[0].length)}`);
}

/** Run this fixture over one pack in a child process, as a control would. */
function runCheck(copy) {
  const child = spawnSync(process.execPath, [FIXTURE], {
    encoding: "utf8",
    env: { ...process.env, PI_TRIGGER_CAP_PACKS: copy },
  });
  return { out: `${child.stdout ?? ""}${child.stderr ?? ""}`, status: child.status };
}

/** The failure line naming a skill, or "" when the check printed none. */
function lineNaming(out, skill) {
  return out.split("\n").find((line) => line.includes(`/${skill}:`)) ?? "";
}

/**
 * The skill in the copied pack that is nearest the count cap: the plant needs
 * the fewest phrases, and a copy whose maximum is already over the cap is not a
 * control arm a plant can prove anything against.
 */
function nearestCapSkill(result) {
  const best = result.counts.reduce(
    (top, row) => (top === null || row.count > top.count ? row : top),
    null,
  );
  assert.ok(best, "the copied pack carries no skill to plant in");
  assert.ok(
    best.count <= MAX_TRIGGERS,
    `${best.where} already authors ${best.count} phrases (cap ${MAX_TRIGGERS}); the copy is not a control arm`,
  );
  return best;
}

const SHIPPED = scan(packsToScan());
console.log(censusLine(SHIPPED));
const standingDebt = debtLine(SHIPPED);
if (standingDebt) console.log(standingDebt);

describe("trigger caps", () => {
  it("every shipped skill authors within the reader's caps, pinned losses aside", () => {
    assert.deepEqual(SHIPPED.problems, []);
  });

  if (!IS_CONTROL_CHILD) {
    it("a phrase past the count cap fails naming the skill, the count and the cap", () => {
      const { copy, tree } = copyPack();
      try {
        const target = nearestCapSkill(scan([{ dir: copy, label: "copy" }]));
        const planted = runCheck(copy);
        assert.equal(planted.status, 0, `the unmodified copy must pass:\n${planted.out}`);

        const fillers = [];
        for (let index = target.count; index <= MAX_TRIGGERS; index += 1) {
          fillers.push(`planted filler ${index}`);
        }
        plantFrontmatter(join(copy, target.name, "SKILL.md"), `trigger: "${fillers.join(", ")}"`);

        const red = runCheck(copy);
        assert.equal(red.status, 1, `a planted ${MAX_TRIGGERS + 1}th phrase must fail:\n${red.out}`);
        const line = lineNaming(red.out, target.name);
        assert.ok(line !== "", `the failure must name ${target.name}:\n${red.out}`);
        assert.ok(
          line.includes(String(MAX_TRIGGERS + 1)),
          `the failure must name the count ${MAX_TRIGGERS + 1}:\n${line}`,
        );
        assert.ok(
          line.includes(String(MAX_TRIGGERS)),
          `the failure must name the cap ${MAX_TRIGGERS}:\n${line}`,
        );
      } finally {
        rmSync(tree, { force: true, recursive: true });
      }
    });

    it("a phrase past the character cap fails naming the skill, the length and the cap", () => {
      const { copy, tree } = copyPack();
      try {
        const target = nearestCapSkill(scan([{ dir: copy, label: "copy" }]));
        const phrase = `planted ${"x".repeat(MAX_TRIGGER_CHARS + 1 - "planted ".length)}`;
        plantFrontmatter(join(copy, target.name, "SKILL.md"), `trigger: "${phrase}"`);

        const red = runCheck(copy);
        assert.equal(red.status, 1, `a planted over-long phrase must fail:\n${red.out}`);
        const line = lineNaming(red.out, target.name);
        assert.ok(line !== "", `the failure must name ${target.name}:\n${red.out}`);
        assert.ok(
          line.includes(String(MAX_TRIGGER_CHARS + 1)),
          `the failure must name the length ${MAX_TRIGGER_CHARS + 1}:\n${line}`,
        );
        assert.ok(
          line.includes(String(MAX_TRIGGER_CHARS)),
          `the failure must name the cap ${MAX_TRIGGER_CHARS}:\n${line}`,
        );
      } finally {
        rmSync(tree, { force: true, recursive: true });
      }
    });
  }
});
