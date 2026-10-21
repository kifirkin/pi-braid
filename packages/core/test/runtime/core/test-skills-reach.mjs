/**
 * Skill reach — the price of a read, before the read.
 *
 * Contract:
 *   1. A measured skill reports reachable, lines, bytes, chars, estTokens,
 *      sectionCount and its ATX headings with 1-indexed line numbers.
 *      estTokens is ceil(chars/4), the divisor pi-core's estimateTokens and
 *      the pre-send guard both use; `bytes` is the file's stat size and `chars`
 *      the decoded string length in UTF-16 code units, so a multi-byte file
 *      reports the two differently (and an astral-plane file counts each
 *      surrogate pair as two chars).
 *   2. Headings are parsed fence-aware: a `#`-prefixed line inside ``` or ~~~
 *      is content, not a heading, and so is an `#region` pragma or a line
 *      indented four spaces. The planted failure for this rule lives at the
 *      bottom of the file: with the fence branch removed from reach.ts, a
 *      fence-blind scan of the fixture finds 9 heading-shaped lines instead of
 *      the 4 real headings and this file goes red. Two edges are accepted and
 *      pinned as known limits: a four-space-indented fence opener is not
 *      tracked, and an unclosed fence hides every later heading.
 *   3. `sections` is capped by sectionsMax (0 omits the list), while
 *      sectionCount stays the file's true total - a truncated list never
 *      understates the file. The cap has one ceiling, SECTIONS_MAX_LIMIT: the
 *      clamp enforces it and the tool schema declares it, and the fixture
 *      measures both at the limit and one above it.
 *   4. Parsing is memoized on mtime + size: an unchanged file is never
 *      re-read, and a change is picked up on the next call. Failures are not
 *      cached, so a repaired permission is visible without a restart.
 *   5. The tool path carries the same fields: one row per skill from
 *      `list_skills` execution, with the arguments validated by pi-core's
 *      own validateToolArguments (so the schema, not the test, gates the
 *      params), and the prompt budget measured where it binds - the heaviest
 *      page of the shipped pack, priced on the row shape production serves (a
 *      package `sourceInfo`, not the fixture's own fallback) stays under 12KB.
 *
 * Windows are exercised inside a temp directory; the real agent tree is
 * untouched (HOME is redirected before the dist imports).
 *
 * Run: node test/runtime/core/test-skills-reach.mjs
 */

import { strict as assert } from "node:assert";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skills-reach-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const reachModule = await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "reach.js"));
const {
  CHARS_PER_TOKEN,
  DEFAULT_SECTIONS_MAX,
  SECTIONS_MAX_LIMIT,
  clampSectionsMax,
  clearReachCache,
  countLines,
  readSkillReach,
} = reachModule;
const skillsToolModule = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js")
);
const { setCachedSkills } = skillsToolModule;
const skillsToolExtension = skillsToolModule.default;
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");
const { parseFrontmatter } = await import("@earendil-works/pi-coding-agent");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  [fail] ${name}: ${e.message}`);
    });
}

const WORK = mkdtempSync(join(tmpdir(), "skills-reach-fixtures-"));
let fixtureSeq = 0;

/** Write a fixture file and return its path (fresh name per call: no cache carry-over). */
function fixture(text, name = `fixture-${++fixtureSeq}`) {
  const path = join(WORK, name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
  return path;
}

/** A realistic skill file whose `#` lines are mostly code comments. */
const FENCE_FIXTURE = `---
name: fence-fixture
description: fixture for the fence-aware heading parse
---

# Fence Fixture

Real intro.

## Setup

\`\`\`bash
# this is a shell comment, not a heading
## neither is this
\`\`\`
~~~
# tilde-fenced line
## also not a heading
~~~
\`\`\`ts
#region pragma, no space after the hash
# NoSpaceIsStillInside
\`\`\`
    # four spaces of indent is an indented code block

### Closing Hashes ###

## Last Section
`;

/** Minimal ExtensionAPI double: captures the registered tool definitions. */
function fakePi() {
  const tools = [];
  return {
    tools,
    on: () => {},
    registerTool: (def) => tools.push(def),
    sendMessage: () => {},
    getExtensionState: () => ({}),
    setExtensionState: () => {},
  };
}

console.log("skills reach test (the price of a read)\n");

// ── 1. counting rules ────────────────────────────────────────────────────────

await test("countLines: trailing newline ends the last line, empty file has none", () => {
  assert.equal(countLines(""), 0, "empty text has no lines");
  assert.equal(countLines("a"), 1, "no trailing newline is still one line");
  assert.equal(countLines("a\n"), 1, "a trailing newline ends the line, it does not open one");
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\n\n"), 2, "a blank last line after the terminator is not a line");
});

await test("estTokens is ceil(chars/4) and chars counts characters, not bytes", () => {
  // 37 ASCII characters: 37/4 = 9.25, so floor would report 9 and ceil 10.
  const ascii = "# t\n" + "x".repeat(33);
  const path = fixture(ascii);
  const reach = readSkillReach(path);
  assert.equal(reach.reachable, true);
  assert.equal(reach.chars, ascii.length, "chars is the decoded length");
  assert.equal(reach.bytes, Buffer.byteLength(ascii, "utf-8"), "bytes is the stat size");
  assert.equal(
    reach.estTokens,
    Math.ceil(ascii.length / CHARS_PER_TOKEN),
    "estTokens must be ceil(chars/4), not floor",
  );
  assert.equal(reach.estTokens, 10, "37 chars -> 10 tokens (floor would be 9)");

  // The same character count in two-byte characters must not double the estimate.
  const multibyte = "# " + "\u00e9".repeat(35);
  const mbReach = readSkillReach(fixture(multibyte));
  assert.equal(mbReach.chars, multibyte.length, "chars stays a character count");
  assert.equal(mbReach.bytes, Buffer.byteLength(multibyte, "utf-8"), "bytes sees the encoding");
  assert.ok(mbReach.bytes > mbReach.chars, "a multi-byte file is larger in bytes than in chars");
  assert.equal(
    mbReach.estTokens,
    Math.ceil(mbReach.chars / CHARS_PER_TOKEN),
    "the token estimate follows chars, never bytes",
  );

  // `chars` is `String.length`, so it counts UTF-16 code units: one emoji
  // outside the BMP is two units and one code point, and estTokens follows it.
  const astral = "# " + "\u{1F600}".repeat(10);
  const astralReach = readSkillReach(fixture(astral));
  assert.equal(Array.from(astral).length, 12, "the text is 12 code points");
  assert.equal(astralReach.chars, 22, "chars counts 2 + 10 surrogate pairs as code units");
  assert.equal(astralReach.estTokens, Math.ceil(22 / CHARS_PER_TOKEN), "and the estimate inherits it");
});

// ── 2. fence-aware headings (the planted-failure subject) ────────────────────

await test("headings skip fenced blocks, pragmas and indented code", () => {
  const path = fixture(FENCE_FIXTURE);
  const reach = readSkillReach(path, DEFAULT_SECTIONS_MAX);
  assert.deepEqual(
    reach.sections.map((s) => [s.line, s.text]),
    [
      [6, "Fence Fixture"],
      [10, "Setup"],
      [26, "Closing Hashes"],
      [28, "Last Section"],
    ],
    "only the four real headings survive, at their true line numbers",
  );
  assert.equal(reach.sectionCount, 4, "sectionCount agrees with the list");

  // Guard the guard: a fence-blind scan of the same text finds the code
  // comments, so the assertion above cannot pass by accident. The delta is
  // the planted-failure signature: 9 lines shaped like headings, 5 of them
  // inside fences or indented code, 4 real.
  const naive = FENCE_FIXTURE.split("\n").filter((l) => /^#{1,6}[ \t]/.test(l)).length;
  assert.equal(naive, 9, `a fence-blind scan sees 9 heading-shaped lines, saw ${naive}`);
  assert.equal(naive - reach.sectionCount, 5, "five phantom headings, all inside code");
  assert.equal(reach.lines, FENCE_FIXTURE.split("\n").length - 1, "the file's own line count");
});

await test("a heading's closing hash sequence is stripped, its line number kept", () => {
  const reach = readSkillReach(fixture("## Title ##\ntext\n"));
  assert.deepEqual(reach.sections, [{ line: 1, text: "Title" }]);

  // Trailing whitespace after the closing run is still a closing run: the run
  // ends the line even when spaces follow it, and none of them reach the text.
  const padded = readSkillReach(fixture("## Padded ##   \ntext\n"));
  assert.deepEqual(padded.sections, [{ line: 1, text: "Padded" }]);
});

await test("known limits: an indented fence opener and an unclosed fence are not repaired", () => {
  // Both are recorded in reach.ts as accepted edges rather than bugs. Pinned
  // here so that changing either is a decision with a red test behind it.
  const indented = readSkillReach(fixture("    ```\n# inside a four-space block\n```\n", "indented-fence"));
  assert.deepEqual(
    indented.sections.map((s) => [s.line, s.text]),
    [[2, "inside a four-space block"]],
    "a four-space-indented opener is not a fence, so its `#` line is advertised",
  );

  const unclosed = readSkillReach(fixture("# Before\n```\n## Swallowed\n", "unclosed-fence"));
  assert.equal(unclosed.sectionCount, 1, "an unclosed fence hides every heading after it");
  assert.deepEqual(unclosed.sections.map((s) => s.text), ["Before"]);
});

await test("the installed pack proves the fence case is not academic", () => {
  const skillsDir = join(ROOT, "skills");
  let naiveTotal = 0;
  let fencedTotal = 0;
  // The doc block states the two known limits are not exercised by the pack.
  // Measure that absence instead of asserting it in prose: an opener indented
  // four spaces, or a file whose last fence never closes, would both make the
  // sentence false and would need the limits revisited.
  let indentedOpeners = 0;
  let endsInFence = 0;
  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  for (const name of readdirSync(skillsDir)) {
    let text;
    try {
      text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf-8");
    } catch {
      continue; // _shared and friends carry no SKILL.md
    }
    const naive = text.split("\n").filter((l) => /^\s*#{1,6}[ \t]/.test(l)).length;
    const reach = readSkillReach(join(skillsDir, name, "SKILL.md"));
    naiveTotal += naive;
    fencedTotal += reach.sectionCount;

    let fence = null;
    for (const line of text.split("\n")) {
      if (/^ {4,}(`{3,}|~{3,})/.test(line)) indentedOpeners += 1;
      const fenceLine = FENCE_RE.exec(line);
      if (fence) {
        if (
          fenceLine &&
          fenceLine[1][0] === fence.marker &&
          fenceLine[1].length >= fence.length &&
          fenceLine[2].trim() === ""
        ) {
          fence = null;
        }
        continue;
      }
      if (fenceLine && !(fenceLine[1][0] === "`" && fenceLine[2].includes("`"))) {
        fence = { marker: fenceLine[1][0], length: fenceLine[1].length };
      }
    }
    if (fence) endsInFence += 1;
  }
  assert.ok(naiveTotal > fencedTotal, "the pack carries code-comment lines shaped like headings");
  assert.ok(
    naiveTotal - fencedTotal >= 10,
    `expected a double-digit over-count on the pack, measured ${naiveTotal} naive vs ${fencedTotal} real`,
  );
  assert.equal(indentedOpeners, 0, "the pack has no fence opener indented four spaces");
  assert.equal(endsInFence, 0, "no skill file ends inside an unclosed fence");
  console.log(
    `  [pack] heading-shaped lines: ${naiveTotal} naive vs ${fencedTotal} real (${naiveTotal - fencedTotal} phantom, ${(naiveTotal / fencedTotal).toFixed(2)}x); indented openers ${indentedOpeners}, files ending in a fence ${endsInFence}`,
  );
});

// ── 3. the per-call cap never understates the file ──────────────────────────

await test("sectionsMax truncates the list while sectionCount stays the true total", () => {
  const path = fixture("# A\ntext\n## B\ntext\n### C\ntext\n## D\n");
  const full = readSkillReach(path, 8);
  assert.equal(full.sectionCount, 4);
  assert.equal(full.sections.length, 4);

  const two = readSkillReach(path, 2);
  assert.deepEqual(
    two.sections.map((s) => s.text),
    ["A", "B"],
    "the list is capped to the first N headings",
  );
  assert.equal(two.sectionCount, 4, "the count is the file's, not the page's");

  const none = readSkillReach(path, 0);
  assert.equal("sections" in none, false, "sectionsMax 0 omits the list entirely");
  assert.equal(none.sectionCount, 4, "…and still reports the total");

  const over = readSkillReach(path, 999);
  assert.equal(over.sections.length, 4, "a cap above the heading count changes nothing");
});

// ── 4. one read per change: the mtime + size cache ──────────────────────────

await test("an unchanged file is not re-read; a changed mtime is", () => {
  const path = join(WORK, "cached", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  const T = new Date("2020-01-01T00:00:00Z");
  const first = "# One\n\ntext\n";
  const second = "# Two\n\ntext\n"; // same byte length: only the text differs
  assert.equal(first.length, second.length, "the swap keeps the size, isolating mtime");

  writeFileSync(path, first, "utf-8");
  utimesSync(path, T, T);
  const a = readSkillReach(path);
  assert.deepEqual(a.sections.map((s) => s.text), ["One"], "first read parses the file");

  // Same mtime, same size, different content: a re-read would report "Two".
  writeFileSync(path, second, "utf-8");
  utimesSync(path, T, T);
  const b = readSkillReach(path);
  assert.equal(b.mtimeMs, undefined, "the reach record carries no cache internals");
  assert.deepEqual(
    b.sections.map((s) => s.text),
    ["One"],
    "unchanged mtime+size means the memoized parse answers, with no second read",
  );

  // Bumping the mtime invalidates, and the new content is parsed.
  const later = new Date(T.getTime() + 2000);
  utimesSync(path, later, later);
  const c = readSkillReach(path);
  assert.deepEqual(c.sections.map((s) => s.text), ["Two"], "a changed mtime is re-read");
  assert.equal(c.bytes, second.length, "the measurement follows the new file");
});

await test("an unreadable file answers reachable:false and is never cached as a failure", () => {
  const path = join(WORK, "locked", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# Locked\n", "utf-8");

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (!root) {
    const before = statSync(path);
    chmodSync(path, 0o000);
    try {
      const denied = readSkillReach(path);
      assert.equal(denied.reachable, false, "an unreadable file must not throw the catalog");
      assert.equal(denied.bytes, before.size, "the stat size is still known");
    } finally {
      chmodSync(path, 0o600);
    }
  } else {
    console.log("  [note] running as root — chmod isolation is ineffective, read denied skipped");
  }

  // Repaired (or never blocked): the next call reads it, proving the failure
  // was not memoized. The mtime is untouched throughout — only a cached
  // failure would keep answering false here.
  const repaired = readSkillReach(path);
  assert.equal(repaired.reachable, true, "a lost read is retried on the next call");
  assert.equal(repaired.sectionCount, 1);

  const missing = readSkillReach(join(WORK, "no-such-dir", "SKILL.md"));
  assert.deepEqual(missing, { reachable: false }, "a missing file reports unreachable, no bytes");
});

await test("clearReachCache drops the memoized parse", () => {
  const path = fixture("# Before\n", "cleared");
  const T = new Date("2020-01-01T00:00:00Z");
  utimesSync(path, T, T);
  assert.deepEqual(readSkillReach(path).sections.map((s) => s.text), ["Before"]);

  // Same mtime and size, different text: only a dropped cache can see it.
  writeFileSync(path, "# After!\n", "utf-8");
  utimesSync(path, T, T);
  assert.deepEqual(
    readSkillReach(path).sections.map((s) => s.text),
    ["Before"],
    "the memoized parse still answers while the cache stands",
  );
  clearReachCache();
  assert.deepEqual(
    readSkillReach(path).sections.map((s) => s.text),
    ["After!"],
    "clearing the cache forces the next read",
  );
});

// ── 5. the tool path: validated arguments, one row per skill ────────────────

await test("list_skills rows carry reach, and validateToolArguments gates the params", async () => {
  const fencePath = fixture(FENCE_FIXTURE, "tool-fence");
  const tinyPath = fixture("---\nname: tiny\ndescription: tiny fixture\n---\n# Tiny\n", "tool-tiny");

  const pi = fakePi();
  skillsToolExtension(pi);
  const tool = pi.tools.find((t) => t.name === "list_skills");
  assert.ok(tool, "list_skills must be registered");

  setCachedSkills([
    { name: "tool-fence", filePath: fencePath, description: "fence fixture", source: "project" },
    { name: "tool-tiny", filePath: tinyPath, description: "tiny fixture", source: "user" },
  ]);

  const args = validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: { action: "list" } },
  );
  assert.equal(args.action, "list", "the schema accepts the one action");
  assert.equal(
    args.sectionsMax,
    undefined,
    "an omitted sectionsMax stays omitted: the schema default is metadata, so the tool owns the fallback",
  );

  const result = await tool.execute("call-1", args, undefined, undefined, {});
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.total, 2, "both visible skills are listed");
  const byName = new Map(payload.skills.map((s) => [s.name, s]));

  const fenceRow = byName.get("tool-fence");
  assert.ok(fenceRow, "the fence fixture is on the page");
  assert.equal(fenceRow.reachable, true, "a readable file says so");
  for (const field of ["lines", "bytes", "chars", "estTokens", "sectionCount"]) {
    assert.equal(typeof fenceRow[field], "number", `row.${field} must be a number`);
  }
  assert.equal(fenceRow.sectionCount, 4, "the tool path inherits the fence-aware count");
  assert.deepEqual(
    fenceRow.sections.map((s) => s.text),
    ["Fence Fixture", "Setup", "Closing Hashes", "Last Section"],
  );
  assert.ok(fenceRow.sections.every((s) => typeof s.line === "number" && s.text.length > 0));
  assert.equal(fenceRow.filePath, fencePath, "the row still names the file it prices");
  assert.equal(fenceRow.description, "fence fixture", "the existing fields are untouched");

  const tinyRow = byName.get("tool-tiny");
  assert.equal(tinyRow.lines, 5, "four frontmatter lines plus one heading line");
  assert.equal(tinyRow.sectionCount, 1);

  // The fallback cap, applied where it matters: a nine-heading file through
  // the tool with no sectionsMax reports DEFAULT_SECTIONS_MAX headings and
  // the true count.
  const manyPath = fixture(
    Array.from({ length: 9 }, (_, i) => `## Section ${i + 1}\ntext`).join("\n"),
    "tool-many",
  );
  setCachedSkills([
    { name: "tool-many", filePath: manyPath, description: "many headings", source: "project" },
  ]);
  const fallback = JSON.parse(
    (await tool.execute("call-3", { action: "list" }, undefined, undefined, {})).content[0].text,
  );
  const manyRow = fallback.skills[0];
  assert.equal(manyRow.sectionCount, 9, "the count is the file's own");
  assert.equal(
    manyRow.sections.length,
    DEFAULT_SECTIONS_MAX,
    "an omitted sectionsMax falls back to the declared page cap",
  );

  // sectionsMax 0 through the same validated path: count kept, list dropped.
  const leanArgs = validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: { action: "list", sectionsMax: 0 } },
  );
  const lean = JSON.parse(
    (await tool.execute("call-2", leanArgs, undefined, undefined, {})).content[0].text,
  );
  for (const row of lean.skills) {
    assert.equal("sections" in row, false, `row ${row.name} must omit sections at sectionsMax 0`);
    assert.ok(row.sectionCount >= 0, "the count survives");
  }

  // A schema-out-of-range value is refused by the validator, not silently clamped.
  assert.throws(
    () =>
      validateToolArguments(
        { name: tool.name, parameters: tool.parameters },
        { name: tool.name, arguments: { action: "list", sectionsMax: SECTIONS_MAX_LIMIT + 1 } },
      ),
    /sectionsMax|maximum/i,
    "sectionsMax above the schema maximum is a validation error",
  );
});

await test("both documentation surfaces name every field the row carries", async () => {
  // The two strategy strings are byte-identical by contract, so
  // check:doc-drift proves they agree with each other and cannot see a field
  // both of them omit. This case is the completeness check the pair cannot
  // make, and it is driven by the row's own field list.
  const REACH_FIELDS = ["reachable", "lines", "bytes", "chars", "estTokens", "sectionCount", "sections"];
  const fieldList = `(${REACH_FIELDS.join(", ")})`;
  const { TOOL_GUIDELINES } = await import(
    join(ROOT, "dist/extensions/core/prompt-builder/tool-guidelines.js")
  );
  const guideline = TOOL_GUIDELINES.list_skills;
  assert.ok(typeof guideline === "string" && guideline.length > 0, "list_skills has a guideline");
  assert.ok(guideline.includes(fieldList), `the guideline must name ${fieldList}`);

  const docRow = readFileSync(join(ROOT, "TOOLS.md"), "utf-8")
    .split("\n")
    .find((line) => line.startsWith("| `list_skills`"));
  assert.ok(docRow, "TOOLS.md carries the list_skills row");
  assert.ok(docRow.includes(fieldList), `the catalog row must name ${fieldList}`);
});

await test("the heading ceiling is one number, measured at the limit and one above it", () => {
  const path = fixture(
    Array.from({ length: SECTIONS_MAX_LIMIT + 6 }, (_, i) => `## Heading ${i + 1}\ntext`).join("\n"),
    "ceiling",
  );
  const total = SECTIONS_MAX_LIMIT + 6;
  assert.equal(readSkillReach(path, 0).sectionCount, total, "the fixture is longer than the ceiling");

  assert.equal(clampSectionsMax(SECTIONS_MAX_LIMIT), SECTIONS_MAX_LIMIT, "the ceiling itself is legal");
  assert.equal(
    clampSectionsMax(SECTIONS_MAX_LIMIT + 1),
    SECTIONS_MAX_LIMIT,
    "one above the ceiling clamps down to it",
  );
  assert.equal(clampSectionsMax(undefined), DEFAULT_SECTIONS_MAX, "an omitted cap takes the default");

  const atLimit = readSkillReach(path, SECTIONS_MAX_LIMIT);
  assert.equal(atLimit.sections.length, SECTIONS_MAX_LIMIT, "the ceiling is served in full");
  const beyond = readSkillReach(path, SECTIONS_MAX_LIMIT + 1);
  assert.equal(beyond.sections.length, SECTIONS_MAX_LIMIT, "a request above it is clamped, not honoured");
  assert.equal(beyond.sectionCount, total, "the count still reports the file");

  const pi = fakePi();
  skillsToolExtension(pi);
  const tool = pi.tools.find((t) => t.name === "list_skills");
  assert.equal(
    tool.parameters.properties.sectionsMax.maximum,
    SECTIONS_MAX_LIMIT,
    "the schema maximum references the module ceiling instead of restating a number",
  );
  const accepted = validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: { action: "list", sectionsMax: SECTIONS_MAX_LIMIT } },
  );
  assert.equal(accepted.sectionsMax, SECTIONS_MAX_LIMIT, "the validator accepts the ceiling");
  assert.throws(
    () =>
      validateToolArguments(
        { name: tool.name, parameters: tool.parameters },
        { name: tool.name, arguments: { action: "list", sectionsMax: SECTIONS_MAX_LIMIT + 1 } },
      ),
    /sectionsMax|maximum/i,
    "one above the ceiling is refused, so the two numbers cannot drift apart",
  );
});

await test("the shipped pack's heaviest page fits the 12KB budget on production rows", async () => {
  // Production row shape. pi hands braid a skill whose `sourceInfo.source` is
  // the package spec it was installed from (settings: "npm:pi-braid@<version>"),
  // and formatSource passes that string into the row. Measuring without it
  // prices a 7-character "unknown" where production spends 19, which is how an
  // earlier table under-counted a full page by more than a kilobyte.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const PACKAGE_SOURCE = `npm:${pkg.name}@${pkg.version}`;
  const skillsDir = join(ROOT, "skills");
  const rows = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const filePath = join(skillsDir, name, "SKILL.md");
    let text;
    try {
      text = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter } = parseFrontmatter(text);
    rows.push({
      name,
      filePath,
      description: String(frontmatter.description ?? "").slice(0, 280),
      baseDir: join(skillsDir, name),
      sourceInfo: { source: PACKAGE_SOURCE, scope: "package", baseDir: join(skillsDir, name) },
    });
  }
  assert.ok(rows.length >= 20, `expected the shipped pack, saw ${rows.length} skills`);

  const pi = fakePi();
  skillsToolExtension(pi);
  const tool = pi.tools.find((t) => t.name === "list_skills");
  setCachedSkills(rows);

  const PAGE_SIZE = 10;
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const payload = async (page, pageSize, sectionsMax) => {
    const args = { action: "list", page, pageSize };
    if (sectionsMax !== undefined) args.sectionsMax = sectionsMax;
    const res = await tool.execute(`size-${page}-${pageSize}-${sectionsMax ?? "default"}`, args, undefined, undefined, {});
    return res.content[0].text;
  };
  const pagesAt = async (sectionsMax) => {
    const pages = [];
    for (let page = 1; page <= pageCount; page++) {
      const text = await payload(page, PAGE_SIZE, sectionsMax);
      pages.push({ page, bytes: Buffer.byteLength(text, "utf-8"), text });
    }
    return pages;
  };
  const heaviestOf = (pages) => pages.reduce((a, b) => (b.bytes > a.bytes ? b : a));

  // The rows this measurement prices must be the rows production serves: a
  // fixture row without sourceInfo silently prices a different catalog.
  const firstPage = await pagesAt(DEFAULT_SECTIONS_MAX);
  const firstRow = JSON.parse(firstPage[0].text);
  assert.equal(firstRow.total, rows.length, "every skill is in the catalog");
  assert.equal(
    firstRow.skills[0].source,
    PACKAGE_SOURCE,
    "the measured rows carry the source string production emits",
  );

  const table = [];
  for (const cap of [8, DEFAULT_SECTIONS_MAX, 5, 4]) {
    const pages = cap === DEFAULT_SECTIONS_MAX ? firstPage : await pagesAt(cap);
    const heaviest = heaviestOf(pages);
    table.push({ cap, pages, heaviest });
    console.log(
      `  [size] sectionsMax ${cap}: ${pages.map((p) => `page ${p.page} ${p.bytes} B`).join(", ")}; heaviest page ${heaviest.page} (${heaviest.bytes} B)`,
    );
  }
  const byCap = new Map(table.map((row) => [row.cap, row]));

  // The budget binds on the heaviest page, not page 1: a page of ten heavy
  // rows is what the prompt actually pays, and it is rarely the first page.
  const dflt = byCap.get(DEFAULT_SECTIONS_MAX);
  assert.ok(
    dflt.heaviest.bytes < 12 * 1024,
    `the heaviest default page is page ${dflt.heaviest.page} of ${pageCount} at ${dflt.heaviest.bytes} bytes, against a ${12 * 1024}-byte bound`,
  );

  // Omission is the default: a call that passes no sectionsMax must produce
  // the page the table priced, or the budget describes a request nobody makes.
  const omitted = await pagesAt(undefined);
  assert.deepEqual(
    omitted.map((p) => p.bytes),
    dflt.pages.map((p) => p.bytes),
    "an omitted sectionsMax measures exactly what the default cap measures",
  );

  // The default cap is chosen against the next size up: if eight headings stop
  // crossing the bound, six is no longer the cheapest safe default and the
  // reasoning in reach.ts has to be remade rather than inherited.
  const atEight = byCap.get(8);
  assert.ok(
    atEight.heaviest.bytes > 12 * 1024,
    `eight headings must cross the bound: heaviest page ${atEight.heaviest.page} measures ${atEight.heaviest.bytes} bytes`,
  );

  // What the schema actually lets a caller ask for, priced once so the doc
  // block's maximum is a measurement and not an assumption.
  const widestArgs = validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: { action: "list", pageSize: 50, sectionsMax: SECTIONS_MAX_LIMIT } },
  );
  const widest = Buffer.byteLength(
    await payload(1, widestArgs.pageSize, widestArgs.sectionsMax),
    "utf-8",
  );
  console.log(
    `  [size] widest legal request (pageSize ${widestArgs.pageSize}, sectionsMax ${widestArgs.sectionsMax}): ${widest} bytes`,
  );
  assert.ok(
    widest < 64 * 1024,
    `the widest legal request must stay in the tens of KB, measured ${widest} bytes`,
  );
});

// ── cleanup ─────────────────────────────────────────────────────────────────

try {
  chmodSync(WORK, 0o755);
} catch {
  /* best-effort */
}
rmSync(WORK, { recursive: true, force: true });
rmSync(FAKE_HOME, { recursive: true, force: true });

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
