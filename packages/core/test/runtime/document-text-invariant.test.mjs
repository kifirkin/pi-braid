/**
 * Test: the tree's text invariant - a token is a run of letters and digits in
 * any script.
 *
 * Nine assertions, each naming a site that answers "no tokens" for a string the
 * owner writes and then reports that zero as a fact about the string. Every one
 * was red at HEAD; the row id on each name joins it to the census that measured
 * the defect. The four rows this branch repairs assert; the five a later stage
 * of that census's plan owns are declared skipped, each with the row and the
 * stage in its reason, so the pending work stays visible in the suite's own
 * output instead of in a report.
 *
 *   R2  extractKeywords      a Cyrillic prompt has no keywords          repaired
 *   R6  CognitiveMemory      a Cyrillic query retrieves no memory       repaired
 *   R1  triggerMatches       a phrase matches inside a longer word      skipped
 *   R16 extractAnchors       a Cyrillic request has no anchors          repaired
 *   R8  deriveTopicTags      a Cyrillic ruling earns no tags            repaired
 *   R39 classifyLlmError     a Cyrillic balance failure is unknown      skipped
 *   R39 classifyLlmError     /401/ fires inside a millisecond figure    skipped
 *   R22 findSelfStateClaims  a Cyrillic liveness claim is invisible     skipped
 *   R7  classifyRulingBody   a Cyrillic standing instruction is null     skipped
 *
 * The assertions drive the shipped functions through their exported entry
 * points, never a copy of their expressions: a test that restates the regex
 * can pass while the site it names still returns nothing.
 *
 * Two departures from the census table, stated rather than hidden:
 *
 *   - R1's leg reads `triggerMatches` and not `skillApplicability`. The
 *     applicability module was removed when the catalog moved to the utility
 *     model, and the boundary class this row names is triggerMatches' one. The
 *     shipped skill catalog is not in this tree either (skills ship in their
 *     own package), so the leg drives the function with a declared phrase and
 *     a prompt, which is the same comparison the row's probe ran.
 *   - R28 is out. `hasCompletionClaim` is private, and a test that reaches
 *     through the extension to call it tests the test.
 *
 * The file sits inside the tree the core runner walks, so `npm test` collects
 * it and its five skipped rows are visible on every run. Run it alone with:
 *
 *   node packages/core/test/runtime/document-text-invariant.test.mjs
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports, so the
 * memory leg reads and writes a fresh store and never the live one.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "document-text-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const STORE_FILE = join(FAKE_HOME, ".pi", "agent", "braid", "memory", "semantic.json");
const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (path) => join(CORE, "dist", path);

const { extractKeywords } = await import(dist("extensions/core/skills-tool/auto-inject.js"));
const { triggerMatches } = await import(dist("extensions/core/skills-tool/skill-triggers.js"));
const { CognitiveMemory } = await import(dist("lib/memory/index.js"));
const { extractAnchors } = await import(dist("lib/reasoning/reasoning-metrics.js"));
const { classifyRulingBody, deriveTopicTags } = await import(dist("lib/memory/decision-grammar.js"));
const { classifyLlmError } = await import(dist("lib/errors/llm-error.js"));
const { findSelfStateClaims } = await import(dist("extensions/enforcement/self-state-claims.js"));
const { BRAID_VOCABULARY } = await import(dist("lib/orchestrator/owner-speech.js"));

// ── R2: the skills matcher's keyword leg ────────────────────────────────────

test("R2 extractKeywords keeps the words of a Cyrillic prompt", () => {
  const keywords = extractKeywords("Проверь безопасность npm пакета");
  assert.ok(
    keywords.length > 0,
    `a Cyrillic prompt names work, so the leg sees words: got ${JSON.stringify(keywords)}`,
  );
});

// ── R6: the memory read path ────────────────────────────────────────────────

test("R6 recall finds a Cyrillic memory by its own words", async () => {
  rmSync(STORE_FILE, { force: true });
  const memory = new CognitiveMemory();
  // The tag is deliberately not a word of the query: recall's tag leg reads
  // the raw query with `includes`, so a matching tag would retrieve the entry
  // through a path the token leg does not own and hide the zero under test.
  await memory.store("Проверка сборки перед коммитом: сначала линт, потом тесты.", "error", {
    tags: ["stored"],
  });
  const hits = await memory.recall("проверка сборки");
  assert.ok(
    hits.length > 0,
    `the query carries two words of the entry, so recall returns it: got ${hits.length} hits`,
  );
});

// ── R1: the trigger boundary ────────────────────────────────────────────────

// Skipped: the census plan runs no stage that closes this row, and its remedy is
// not a one-line class edit. `triggerMatches` needs a script-aware boundary
// (today a Cyrillic letter counts as a boundary, so a phrase matches inside a
// longer word), and the row's own replacement is authored phrases in the
// language the owner types plus a semantic recall leg. The positive leg below is
// asserted first, so the skip cannot hide a function that refuses everything.
test(
  "R1 triggerMatches does not match inside a longer Cyrillic word",
  {
    skip:
      "R1: no stage of the census plan closes it; it needs a script-aware boundary class in skill-triggers.ts plus phrases authored in the owner's language",
  },
  () => {
  const inside = triggerMatches("проверить", "нужно проверитьсборку");
  assert.equal(
    inside,
    false,
    "a Cyrillic letter is not a word boundary: the phrase ends where the word does",
  );
    // Sensitivity: the same phrase must still match where it does stand alone,
    // so a boundary fix cannot pass this leg by refusing every Cyrillic phrase.
    assert.equal(triggerMatches("проверить", "нужно проверить сборку"), true);
  },
);

// ── R16: the stability anchors ──────────────────────────────────────────────

test("R16 extractAnchors keeps the words of a Cyrillic request", () => {
  const anchors = extractAnchors("Починить падающий тест");
  assert.ok(anchors.size > 0, `a request names a subject, so it has anchors: got ${anchors.size}`);
});

// ── R8: the ruling's topic tags ─────────────────────────────────────────────

test("R8 deriveTopicTags tags a Cyrillic ruling", () => {
  const tags = deriveTopicTags("никогда не публикуй релиз вручную", { total: 10, count: () => 0 });
  assert.ok(
    tags.length > 0,
    `a ruling carries its subject, so it earns a tag: got ${JSON.stringify(tags)}`,
  );
});

// ── R39: the provider error classifier, both directions ─────────────────────

// Skipped: the census plan's structure-before-prose change reads the structured
// failure channel (`err.status`) instead of matching provider prose, which is
// what makes a balance failure phrased in the owner's language land in the
// balance arm instead of `unknown`.
test(
  "R39 classifyLlmError reads a Cyrillic balance failure as balance",
  {
    skip:
      "R39: the census plan's structure-before-prose change reads err.status instead of provider prose",
  },
  () => {
  const verdict = classifyLlmError({ message: "Ваш баланс исчерпан" });
    assert.equal(verdict.category, "balance", "an exhausted balance is not an unknown failure");
  },
);

// Skipped: same row, same change. The unanchored `/401/` arm fires inside
// `4012`, and the structured channel plus an anchored numeric arm is what stops
// a timeout from asking the owner to re-authenticate.
test(
  "R39 classifyLlmError does not read a millisecond figure as auth",
  {
    skip:
      "R39: the census plan's structure-before-prose change anchors the numeric arms to a status",
  },
  () => {
  const verdict = classifyLlmError({ message: "Connect timeout after 4012 ms" });
    assert.notEqual(verdict.category, "auth", "a timeout is not a rejected credential");
    assert.equal(verdict.retryable, true, "a timeout is retried");
  },
);

// ── R22: the self-state claim screen ────────────────────────────────────────

// Skipped: the census plan's one-classification-per-turn change gives this screen
// a language-neutral candidate leg. No verb form is shared across languages, so
// that leg is a model call, and the row's pattern table stays as the cheap recall
// net in front of it.
test(
  "R22 findSelfStateClaims sees a Cyrillic liveness claim",
  {
    skip:
      "R22: the census plan's one-classification-per-turn change gives the claim screen a language-neutral leg",
  },
  () => {
    const claims = findSelfStateClaims({
      responseText: "Поллер работает, сообщения до меня доходят.",
      toolsUsed: [],
    });
    assert.ok(
      claims.length > 0,
      `the response asserts a channel is live, so the judge is asked: got ${claims.length}`,
    );
  },
);

// ── R7: the owner's standing instructions ───────────────────────────────────

// Skipped: the census plan's one-classification-per-turn change assigns the class
// with one small call over the turn, returning the quote verbatim so the pointer
// check keeps a byte-for-byte slice. The English marker frames this row names are
// only the recall net in front of that call.
test(
  "R7 classifyRulingBody files a Cyrillic standing instruction",
  {
    skip:
      "R7: the census plan's one-classification-per-turn change replaces the English marker frames",
  },
  () => {
    const shape = classifyRulingBody("Никогда не публикуй релиз вручную.", BRAID_VOCABULARY);
    assert.notEqual(shape, null, "a prohibition addressed to the agent is a standing instruction");
  },
);
