/**
 * Decision grammar: the generic half of the ruling write path.
 *
 * Contract pinned here, and nothing about channels or products is imported to
 * pin it:
 *   (a) the four shapes are named from a body alone: a prohibition, a
 *       preference, a requirement, a policy - each with the class the marker
 *       table assigns;
 *   (b) the quote is verbatim: a contiguous slice of the body, capped with a
 *       trailing ellipsis, never a paraphrase;
 *   (c) the non-instructions stay out: a question, a pasted shell command, a
 *       tool-output paste, a hedged recommendation, a status report, an
 *       acknowledgement;
 *   (d) person grammar: a second-person directive is refused unless the
 *       vocabulary says it generalizes, and a bare directive with no first
 *       person and no named subject is refused;
 *   (e) the vocabulary is load-bearing: the same body is classified one way by
 *       a vocabulary that names its subject and refused by one that does not,
 *       which is how a caller's world knowledge enters without entering this
 *       module;
 *   (f) the tag derivation: tokens of four characters or more, the read path's
 *       stop words dropped, any token more than a quarter of the population
 *       carries dropped, and the three the population carries most kept, ties
 *       by first occurrence;
 *   (g) the derivation check is load-bearing: a planted revert to the rarity
 *       ranking reddens it, by name.
 *
 * Run: node test/runtime/lib/test-decision-grammar.mjs
 */
import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFixtureParses } from "./fixture-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const DIST = join(ROOT, "dist");

// -- Isolation, before any dist import --------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), "decision-grammar-"));
process.env.HOME = SANDBOX;
process.env.BRAID_HOME = join(SANDBOX, "braid");

const { classifyRulingBody, deriveTopicTags, QUOTE_LIMIT, TAG_LIMIT } = await import(
  pathToFileURL(join(DIST, "lib", "memory", "decision-grammar.js")).href
);
const { QUERY_STOP_WORDS } = await import(
  pathToFileURL(join(DIST, "lib", "memory", "constants.js")).href
);

/**
 * A caller's vocabulary, fixture-local on purpose: the module under test must
 * classify with words it has never seen, or (e) below proves nothing.
 */
const WORLD = {
  namesSubject: (text) =>
    /\b(?:system|tool|tools|memory|store|model|models|writer|readers?|brief)\b/i.test(text),
  talksProcess: (text) => /\b(?:timer|poller|pane)\b/i.test(text),
  generalizes: (text) => /\b(?:any instance|every instance|generically?)\b/i.test(text),
};

const POSITIVES = {
  prohibition: "we never post through platform APIs; the browser session is the delivery path.",
  preference: "we prefer the browser session over the API route, always.",
  requirement: "from now our reports should carry the exact command a reviewer can run.",
  policy: "the rule is: one writer, up to two readers.",
};

const TOOL_PASTE = Array.from(
  { length: 60 },
  (_, i) => `2026-10-30T12:${String(i % 60).padStart(2, "0")}:00Z INFO gate step ${i} passed with 0 findings`,
).join("\n");

const NEGATIVES = {
  question: "May a contact reach the owner directly?",
  "pasted shell command": "$ npm run ci:check\n$ git commit -am wip\n",
  "tool-output paste": TOOL_PASTE,
  "unadopted recommendation": "perhaps we should consider preferring the browser session over APIs.",
  "status report": "done: merged and pushed, all gates green.",
  acknowledgement: "ok, proceed.",
  "second person directive": "you should always read the brief before you commit.",
  "bare directive, no subject": "Do not read or write files.",
};

// -- (a) and (b): classes and verbatim quotes -------------------------------
test("each ruling shape is named, and its quote is a slice of the body", () => {
  for (const [expected, text] of Object.entries(POSITIVES)) {
    const shape = classifyRulingBody(text, WORLD);
    assert.ok(shape, `no shape for ${expected}: ${text}`);
    assert.equal(shape.class, expected, `${expected} classified as ${shape.class}`);
    const quote = shape.quote.replace(/\.\.\.$/, "");
    assert.ok(text.includes(quote), `quote is not a slice of the body: ${quote}`);
    assert.ok(shape.quote.length <= QUOTE_LIMIT, `quote over ${QUOTE_LIMIT} characters`);
    if (shape.quote !== quote) assert.ok(shape.quote.endsWith("..."), "a cut quote ends with an ellipsis");
  }
});

test("a long body is cut at the limit, not summarized", () => {
  const body = `we must always keep ${"the exact words of the sentence ".repeat(24)}`;
  const shape = classifyRulingBody(body, WORLD);
  assert.ok(shape, "the marker sentence was not found in a long body");
  assert.ok(shape.quote.length <= QUOTE_LIMIT + 3, `quote length ${shape.quote.length}`);
  assert.ok(shape.quote.endsWith("..."), "the cut quote carries no ellipsis");
  const kept = shape.quote.replace(/\.\.\.$/, "");
  assert.ok(body.startsWith(kept), "the kept part is not the body's own opening words");
});

// -- (c): the named non-instructions ---------------------------------------
test("the named non-instructions stay out, each by its own screen", () => {
  for (const [name, text] of Object.entries(NEGATIVES)) {
    const shape = classifyRulingBody(text, WORLD);
    assert.equal(shape, null, `${name} produced a shape: ${shape && shape.quote}`);
  }
});

// -- (d) and (e): person grammar, and a vocabulary that has to be supplied --
test("second person is refused unless the vocabulary says it generalizes", () => {
  const body = "you should always read the brief before you commit.";
  assert.equal(classifyRulingBody(body, WORLD), null, "a directive to the reader was accepted");
  const generalized = { ...WORLD, generalizes: () => true };
  const shape = classifyRulingBody(body, generalized);
  assert.ok(shape, "an explicitly generalized body was refused");
  assert.equal(shape.class, "requirement");
});

test("the vocabulary decides what a ruling can be about, not this module", () => {
  const body = "the store must always be backed up before a prune.";
  const named = classifyRulingBody(body, WORLD);
  assert.ok(named, "a body naming a subject the vocabulary knows was refused");
  const blind = classifyRulingBody(body, { ...WORLD, namesSubject: () => false });
  assert.equal(blind, null, "a body with no first person and no named subject was accepted");
  const processTalk = classifyRulingBody(body, { ...WORLD, talksProcess: () => true });
  assert.equal(processTalk, null, "a body the vocabulary calls process talk was accepted");
});

// -- (f): the tag derivation ----------------------------------------------
/** A population as the derivation sees it: how many documents carry a token. */
function population(documents) {
  const counts = new Map();
  for (const text of documents) {
    for (const token of new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return { total: documents.length, count: (token) => counts.get(token) ?? 0 };
}

const QUOTE =
  "Actually today I'll buy one more opencode key soon, and we need to use opencode subscription in first place";
// Twenty documents: `need` and `first` in five, `place` in four, `opencode` in
// six (past the quarter cap), the rest once. A quarter of twenty is five, so a
// token in six documents must not be taggable however often it appears.
const DOCUMENTS = [
  ...Array.from({ length: 5 }, () => "we need first the exact command"),
  ...Array.from({ length: 4 }, () => "in place of the previous report"),
  ...Array.from({ length: 6 }, () => "opencode keys are rotated"),
  "subscription facts",
  "soon the release lands",
  "today the census ran",
  "actually the store moved",
  "harness note",
];
const POP = population(DOCUMENTS);

test("the derivation keeps the three tokens the population carries most, inside the cap", () => {
  const tags = deriveTopicTags(QUOTE, POP);
  assert.deepEqual(tags, ["need", "first", "place"], `derived ${JSON.stringify(tags)}`);
  assert.equal(tags.length, TAG_LIMIT);
  for (const tag of tags) assert.ok(!QUERY_STOP_WORDS.has(tag), `stop word survived as a tag: ${tag}`);
  for (const tag of tags) assert.ok(tag.length >= 4, `tag under four characters: ${tag}`);
  // `opencode` is in six of twenty documents - past the cap - and must be out
  // even though every other single-document token is rarer than nothing.
  assert.ok(!tags.includes("opencode"), "a token past the quarter cap became a tag");
  assert.ok(!tags.includes("subscription"), "a token carried by one document outranked two carried by five");
  // Three-character tokens are never candidates.
  assert.ok(!tags.includes("buy") && !tags.includes("key") && !tags.includes("use"), "short token became a tag");
});

test("ties are broken by first occurrence in the quote", () => {
  // Twelve documents, a quarter of them three: three tokens carried by three
  // documents each are in a tie, and the quote's own order decides.
  const even = population([
    ...Array.from({ length: 3 }, () => "alpha beta gamma"),
    ...Array.from({ length: 9 }, () => "delta epsilon"),
  ]);
  assert.deepEqual(deriveTopicTags("beta gamma alpha", even), ["beta", "gamma", "alpha"]);
});

// -- (g): the check is load-bearing ---------------------------------------
/**
 * The planted revert: the same filters, ranked the other way - rarest first,
 * which is what a rule written for a scorer that priced tags by rarity would
 * choose. It is here so the assertion above is not a tautology.
 */
function rarityRanking(text, pop) {
  const ceiling = pop.total * 0.25;
  const seen = new Set();
  const candidates = [];
  for (const token of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (QUERY_STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    const count = pop.count(token);
    if (count > ceiling) continue;
    candidates.push({ token, count, first: candidates.length });
  }
  candidates.sort((a, b) => a.count - b.count || a.first - b.first);
  return candidates.slice(0, TAG_LIMIT).map((c) => c.token);
}

test("a planted revert to rarity reddens the derivation check, naming the rule", () => {
  const shipped = deriveTopicTags(QUOTE, POP);
  const reverted = rarityRanking(QUOTE, POP);
  assert.notDeepEqual(
    reverted,
    shipped,
    "the planted rarity revert produced the shipped tags, so the ranking assertion is not load-bearing",
  );
  assert.deepEqual(reverted, ["actually", "today", "soon"], "the revert did not behave as a rarity ranking");
  // The named rule, asserted as a sentence a reader can falsify: the flat tag
  // bonus means rarity buys nothing a later query will say, so the population's
  // most-carried tokens win and the revert loses.
  try {
    assert.deepEqual(
      reverted,
      shipped,
      "tags are the three tokens the population carries most (a tag's bonus is flat, so rarity names nothing a query says)",
    );
    assert.fail("the rarity revert passed the shipped assertion");
  } catch (error) {
    assert.match(String(error.message), /carries most/, "the red did not name the ranking rule");
  }
});

test("the derivation is a pure function of text and population", () => {
  assert.deepEqual(deriveTopicTags(QUOTE, POP), deriveTopicTags(QUOTE, POP));
  assert.deepEqual(deriveTopicTags("", POP), []);
  assert.deepEqual(deriveTopicTags(QUOTE, { total: 1, count: () => 1 }), [], "a one-document population admits no tag");
});

// A mutant is a file the fixture plants and then imports, so the guard can
// judge it before its verdict is read.
test("a planted derivation that drops the cap is parsed, not assumed", () => {
  const mutant = join(SANDBOX, "mutant-derivation.mjs");
  writeFileSync(
    mutant,
    [
      "export function deriveTopicTags(text) {",
      "  return [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])].slice(0, 3);",
      "}",
      "",
    ].join("\n"),
  );
  assertFixtureParses(mutant);
});

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});
