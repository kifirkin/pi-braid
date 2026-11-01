/**
 * The skip licence is retired: the assembled prompt must not tell an agent it
 * may skip a skill read because the prompt already covers the domain.
 *
 * The retired sentence licensed exactly the behaviour the skills floor exists
 * to prevent. A prompt that covers a domain carries a catalog row, a
 * description or an excerpt; the skill's body is what the agent is supposed to
 * read, so "the prompt already covering the domain" named the one case where
 * the summary and the body part company. Its "only reason" also denied the
 * legitimate one (the body is in this prompt verbatim).
 *
 * Contract:
 *   1. The assembled prompt carries no skip licence: the retired sentence is
 *      absent, and every sentence that speaks of skipping a read lies inside
 *      the pointer rule, whose condition is on the body.
 *   2. The pointer rule states that condition: it names the body and
 *      distinguishes it from a description or an excerpt.
 *   3. The gate can fail. A detector that has never been seen red may be green
 *      because it matches nothing, so two plants are required to be caught: the
 *      licence inside sample text, and the licence restored in a copy of the
 *      built module. The mutant is a copy under a temp directory, so a parallel
 *      suite run never reads a reverted module out of `dist/`.
 *
 * The prompt is composed through the production entry (composeSections) over
 * the production sections in the handler's order, from the repository's own
 * skill pack. The sections the handler renders from the environment (memory
 * pointers, instance line) and the tools rows (a private handler helper) are
 * not part of this assembly; none of them is prompt text about reading a skill.
 *
 * Run: node test/runtime/lib/test-skip-licence.mjs
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFixtureParses } from "./fixture-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, "..", "..", "..");
const REPO_ROOT = join(CORE, "..", "..");
const DIST = join(CORE, "dist");
const SKILLS_TOOL_DIST = join(DIST, "extensions", "core", "skills-tool");
const PROMPT_BUILDER_DIST = join(DIST, "extensions", "core", "prompt-builder");

const { SKILLS_POINTER_RULE, skillsLoadingText } = await import(
  join(SKILLS_TOOL_DIST, "loading-guidance.js")
);
const { identitySection } = await import(join(PROMPT_BUILDER_DIST, "index.js"));
const { DISCOVERY, EPISTEMIC_STANCE, SELF_AUDIT, PHILOSOPHY } = await import(
  join(PROMPT_BUILDER_DIST, "identity.js")
);
const { surfaceDisciplineSection } = await import(
  join(PROMPT_BUILDER_DIST, "surface-discipline-section.js")
);
const { piReferenceSection } = await import(join(PROMPT_BUILDER_DIST, "pi-reference-section.js"));
const { simpleSection, composeSections } = await import(join(PROMPT_BUILDER_DIST, "section.js"));
const { TOOL_PIPELINES, toolPipelineLines } = await import(
  join(PROMPT_BUILDER_DIST, "tool-pipelines.js")
);
const { TOOL_GUIDELINES } = await import(join(PROMPT_BUILDER_DIST, "tool-guidelines.js"));

// ── The licence, and the detector that must find it ─────────────────────────

/** The retired sentence, verbatim. */
const RETIRED_LICENCE =
  "The prompt already covering the domain is the only reason to skip the read.";

/** The retired sentence's own words, which no prompt text may carry again. */
const RETIRED_PHRASE = "only reason to skip the read";

/**
 * One sentence that speaks of skipping a read: a skip verb and the word `read`
 * inside the same sentence. Proximity, not the retired wording, so a rephrasing
 * is caught; see the failure it cannot see in the fixture's closing note.
 */
const SKIP_A_READ = /\bskip\w*\b[^.\n]{0,40}\bread\b/i;

/** Every sentence of `text` that speaks of skipping a read. */
function skipSentences(text) {
  const found = [];
  for (const line of text.split("\n")) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (SKIP_A_READ.test(sentence)) found.push(sentence.trim());
    }
  }
  return found;
}

/**
 * Throw unless every sentence of `text` that speaks of skipping a read is part
 * of `allow` — the pointer rule, the one seat that may state the body
 * condition. `allow` is the live rule, so a rule that forgives nothing makes
 * this a scan for strays anywhere else in the prompt (a tool description, a
 * skills description, a whisper).
 */
function assertNoSkipLicence(text, allow, label) {
  const stray = skipSentences(text).filter((sentence) => !allow.includes(sentence));
  if (stray.length > 0) {
    throw new Error(`skip licence in ${label}: ${stray.join(" | ")}`);
  }
}

// ── The assembled prompt ────────────────────────────────────────────────────

/** First `key: value` line of a frontmatter block, or null. */
function frontmatterField(front, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(front);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** Read a skill pack the way the catalog cache holds it. */
function readPack(packDir) {
  const entries = [];
  for (const dir of readdirSync(packDir).sort()) {
    const filePath = join(packDir, dir, "SKILL.md");
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
    const front = end < 0 ? "" : text.slice(4, end);
    entries.push({
      name: frontmatterField(front, "name") ?? dir,
      description: frontmatterField(front, "description") ?? "",
      filePath,
    });
  }
  return entries;
}

const ENTRIES = readPack(join(CORE, "skills"));

/** Every documented tool plus every pipeline guard, so each guarded section renders. */
const TOOLS = [
  ...new Set([
    "read",
    "list_skills",
    ...Object.keys(TOOL_GUIDELINES),
    ...Object.values(TOOL_PIPELINES).flatMap((pipeline) => pipeline.guard),
  ]),
];

/** The handler's stable section list, over the production composition entry. */
async function assemblePrompt(toolNames, entries) {
  const discovery = DISCOVERY.filter(
    (line) => line.guard.length === 0 || line.guard.some((tool) => toolNames.includes(tool)),
  ).map((line) => line.text);
  const pipelines = toolPipelineLines(toolNames);
  return composeSections(
    [
      identitySection(),
      surfaceDisciplineSection(),
      simpleSection("identity-core", [EPISTEMIC_STANCE, SELF_AUDIT, PHILOSOPHY].join("\n\n")),
      simpleSection("skills-loading", skillsLoadingText(toolNames, entries)),
      ...(discovery.length > 0 ? [simpleSection("discovery", discovery.join("\n\n"))] : []),
      ...(pipelines.length > 0 ? [simpleSection("pipelines", pipelines.join("\n\n"))] : []),
      piReferenceSection(),
    ],
    "\n\n",
    new Set(),
  );
}

const PROMPT = await assemblePrompt(TOOLS, ENTRIES);

/**
 * The assembly as the detector reads it: the catalog's own read root is
 * replaced, because a machine's directory name must not be able to feed a
 * scan for prompt prose (a checkout under a path spelling "skip ... read"
 * would otherwise redden the gate for its location).
 */
const SCANNED = PROMPT.split(join(CORE, "skills")).join("<skills>");

// ── 1. the licence is absent from the assembled prompt ──────────────────────

test("the assembled prompt carries no skip licence", () => {
  assert.ok(ENTRIES.length > 0, "the repository's skill pack must be the catalog");
  assert.ok(PROMPT.includes("When the task enters a listed skill's domain"), "the floor renders");
  const phraseHits = PROMPT.split(RETIRED_PHRASE).length - 1;
  assert.equal(
    phraseHits,
    0,
    `the retired skip licence is back in the assembled prompt: "${RETIRED_PHRASE}" (${phraseHits} occurrence(s))`,
  );
  assert.equal(
    PROMPT.split(RETIRED_LICENCE).length - 1,
    0,
    "the retired sentence is back in the assembled prompt",
  );
  const census = skipSentences(SCANNED);
  console.log(
    `  census: ${census.length} sentence(s) of the assembled prompt speak of skipping a read`,
  );
  assertNoSkipLicence(SCANNED, SKILLS_POINTER_RULE, "assembled prompt");
});

// ── 2. the replacement states the body condition ───────────────────────────

test("the pointer rule keys the read on the body, not on the prompt's coverage", () => {
  assert.ok(PROMPT.includes(SKILLS_POINTER_RULE), "the pointer rule must render");
  assert.match(
    SKILLS_POINTER_RULE,
    /the catalog one-liner is metadata, not content/,
    "the first sentence is the part that works: it must survive",
  );
  assert.match(SKILLS_POINTER_RULE, /\bbody\b/i, "the condition must be on the body");
  assert.match(
    SKILLS_POINTER_RULE,
    /already in this prompt/i,
    "the condition must name the one state a read is unnecessary in",
  );
  assert.match(
    SKILLS_POINTER_RULE,
    /description or an excerpt/i,
    "the rule must say what is NOT the body",
  );
  assert.doesNotMatch(
    SKILLS_POINTER_RULE,
    /covering the domain/i,
    "the retired test must not survive: coverage is not the condition",
  );
});

// ── 3. the detector reddens on planted licence text ─────────────────────────

test("the detector reddens on a planted licence", () => {
  const samples = [
    RETIRED_LICENCE,
    "You may skip the read whenever the prompt already covers the domain.",
    `Pointer rule: the catalog one-liner is metadata, not content. ${RETIRED_LICENCE}`,
  ];
  for (const sample of samples) {
    assert.throws(
      () => assertNoSkipLicence(sample, SKILLS_POINTER_RULE, "sample"),
      /skip licence/,
      `the detector must redden on a licence it was handed: ${sample}`,
    );
  }
  // Negative control: the replacement itself grants nothing, so it is not a hit
  // and the allow-region holds nothing. A green here is a green that can go red.
  assert.deepEqual(skipSentences(SKILLS_POINTER_RULE), [], "the replacement grants no skip");
  assertNoSkipLicence(SKILLS_POINTER_RULE, SKILLS_POINTER_RULE, "the replacement");
});

// ── 4. the planted revert, in a copy of the built module ───────────────────

test("restoring the retired sentence in a built copy reddens the same gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "skip-licence-mutant-"));
  try {
    // The copy is judged as the file it replaces: the built module is ESM, so
    // the temp directory carries the package type the dist module inherits, and
    // the workspace install the module resolves its own imports against.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const installed = join(REPO_ROOT, "node_modules");
    assert.ok(
      existsSync(installed),
      `the mutant needs the workspace install it resolves its own imports against: ${installed}`,
    );
    symlinkSync(installed, join(dir, "node_modules"));
    const mutantDir = join(dir, "skills-tool");
    cpSync(SKILLS_TOOL_DIST, mutantDir, { recursive: true });
    const mutant = join(mutantDir, "loading-guidance.js");
    const source = readFileSync(mutant, "utf8");

    assert.ok(
      source.includes(SKILLS_POINTER_RULE),
      "the built module must carry the pointer rule verbatim, so the revert has a target",
    );
    // The revert keeps the rule's first sentence (the part that works) and
    // restores the licence in place of its condition. Extra sentences, if a
    // later edit adds any, are irrelevant to what this mutant has to carry.
    const sentences = SKILLS_POINTER_RULE.split(/(?<=[.!?])\s+/);
    assert.ok(
      sentences.length >= 2,
      "the pointer rule must keep the first sentence separable, so the revert restores only the licence",
    );
    const retiredRule = [sentences[0], RETIRED_LICENCE].join(" ");
    writeFileSync(mutant, source.replace(SKILLS_POINTER_RULE, retiredRule));
    assertFixtureParses(mutant);

    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      [
        `import { skillsLoadingText } from ${JSON.stringify(pathToFileURL(mutant).href)};`,
        `process.stdout.write(skillsLoadingText(${JSON.stringify(TOOLS)}, ${JSON.stringify(ENTRIES)}));`,
        "",
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, [probe], { encoding: "utf8" });
    assert.equal(run.status, 0, `the mutant must run before its verdict is read: ${run.stderr}`);

    // RED: the reverted build renders the licence, and the gate names it.
    assert.equal(
      run.stdout.split(RETIRED_LICENCE).length - 1,
      1,
      "the planted revert must render the retired sentence exactly once",
    );
    assert.throws(
      () => assertNoSkipLicence(run.stdout, SKILLS_POINTER_RULE, "planted revert"),
      /skip licence/,
      "the planted revert must redden the gate",
    );

    // GREEN: the build on disk, through the same check and the same allow-region.
    assertNoSkipLicence(SCANNED, SKILLS_POINTER_RULE, "restored build");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// What this fixture cannot see: a licence phrased without a skip verb ("you
// need not open the body") or one keyed on a word other than a read. The
// retired test is named literally, so that class is out of reach by
// construction; the structural narrowing here is the body-versus-summary
// condition, and a probe is what would show whether the text changes a read.
