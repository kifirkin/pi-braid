/**
 * Test: recall() tokenization, function-word filtering, rarity weighting, and
 * the configured reserved partition in pruneMemories.
 *
 * Hermetic: BRAID_HOME and PI_CODING_AGENT_DIR are pinned to temp dirs before
 * the dist imports, so both the store and settings.json are this file's own.
 * Fixtures are written straight to the store file rather than stored through
 * the class, so dedup, utility computation and consolidation cannot move a
 * ranking this file is asserting.
 *
 * Three cases carry a control: the shipped scorer is re-implemented below as
 * `legacyRank` and each control asserts the case it used to lose, naming it in
 * the failure message. If a future edit reverts the tokenizer, the stop list
 * or the rarity weight, the control's assertion is what reddens.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BRAID_HOME = mkdtempSync(join(tmpdir(), "short-quote-braid-"));
const AGENT_DIR = mkdtempSync(join(tmpdir(), "short-quote-agent-"));
process.env.BRAID_HOME = BRAID_HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { CognitiveMemory } = await import("../../../dist/lib/memory/index.js");
const { pruneMemories } = await import("../../../dist/lib/memory/lifecycle.js");
const { resolveReservedProvenance } = await import("../../../dist/lib/config/braid-settings.js");
const { MAX_ENTRIES } = await import("../../../dist/lib/memory/constants.js");

const STORE_FILE = join(BRAID_HOME, "memory", "semantic.json");
const SETTINGS_FILE = join(AGENT_DIR, "settings.json");
const PROJECT = "example/project";
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

function writeSettings(block) {
  writeFileSync(SETTINGS_FILE, block === undefined ? "{}\n" : JSON.stringify(block));
}

function entry(overrides) {
  return {
    id: overrides.id,
    content: overrides.content,
    type: overrides.type ?? "semantic",
    tags: overrides.tags ?? [],
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
    accessCount: overrides.accessCount ?? 0,
    lastAccessed: overrides.lastAccessed ?? 1_700_000_000_000,
    source: overrides.source,
    importance: 0.5,
    utility: overrides.utility ?? 0.5,
    projectId: overrides.projectId,
  };
}

function seed(entries) {
  mkdirSync(join(BRAID_HOME, "memory"), { recursive: true });
  writeFileSync(
    STORE_FILE,
    JSON.stringify({
      version: 1,
      memories: entries,
      lastConsolidation: 0,
      turnCount: 0,
      migratedAt: 1,
    }),
  );
}

async function recallRanking(entries, query, options = {}) {
  seed(entries);
  const cm = new CognitiveMemory();
  await cm.init();
  return cm.recall(query, { limit: 100, ...options });
}

/**
 * The shipped scorer, transcribed so each control can name the case it used to
 * lose: whitespace split, a substring test per word, the raw query as the
 * phrase, +2 per query-named tag, and the same utility, freshness and boost
 * factors recall() applies. Ranks only; the shipped recall() also bumps
 * accessCount, which this copy deliberately does not.
 */
function legacyRank(entries, query, options = {}) {
  const now = Date.now();
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const scored = [];
  for (const memory of entries) {
    const content = memory.content.toLowerCase();
    let matches = 0;
    for (const word of words) if (content.includes(word)) matches++;
    if (content.includes(lower)) matches += words.length;
    for (const tag of memory.tags) if (lower.includes(tag.toLowerCase())) matches += 2;
    const relevance = matches * (0.5 + memory.utility * 0.5);
    if (relevance <= 0) continue;
    const freshness = Math.pow(0.5, (now - memory.timestamp) / HALF_LIFE_MS);
    let adjusted = relevance * (0.4 + 0.6 * freshness);
    if (options.currentProject && memory.projectId === options.currentProject) adjusted *= 1.3;
    if (memory.accessCount > 5) adjusted *= 1.15;
    if (memory.type === "error" || memory.type === "goal") adjusted *= 1.1;
    scored.push({ memory, relevance: adjusted });
  }
  return scored.sort((a, b) => b.relevance - a.relevance).map((r) => r.memory);
}

/** Filler entries that all carry one common word, so its document frequency is high. */
function fillers(commonWord, count) {
  return Array.from({ length: count }, (_, i) =>
    entry({
      id: `filler-${i}`,
      content: `${commonWord} ${`note${i}`} ${`track${i}`} ${`unit${i}`} ${`line${i}`}`,
      tags: [],
    }),
  );
}

describe("recall scoring", () => {
  beforeEach(() => {
    rmSync(STORE_FILE, { force: true });
    writeSettings(undefined);
  });

  it("matches a stored token the query reached through punctuation", async () => {
    const entries = [
      entry({
        id: "browser-route",
        content: "the routing answer: we do not need apis here, the browser stays logged in",
        tags: ["routing"],
      }),
      entry({
        id: "function-words-only",
        content: "which should apply when the settings change, and for how long",
        tags: [],
      }),
    ];
    const query = "Are we allowed to post to social platforms through their APIs?";

    const ranked = await recallRanking(entries, query);
    assert.equal(
      ranked[0]?.memory.id,
      "browser-route",
      "a query ending in 'APIs?' must reach the stored token 'apis'",
    );

    const legacy = legacyRank(entries, query);
    assert.notEqual(
      legacy[0]?.id,
      "browser-route",
      "control: the shipped whitespace split leaves 'APIs?' attached, so this case is lost without tokenization",
    );
  });

  it("drops function words instead of counting them as matches", async () => {
    const entries = [
      entry({
        id: "content-match",
        content: "settings migration note: the retry budget doubles after a failed probe",
        tags: [],
      }),
      entry({
        id: "function-words-only",
        content: "which should when for how and the of to in it is",
        tags: [],
      }),
    ];
    // No punctuation here: the stop list alone must decide this case.
    const query = "which should when the retry for how long";

    const ranked = await recallRanking(entries, query);
    assert.equal(
      ranked[0]?.memory.id,
      "content-match",
      "a question made of function words plus one topic word must rank the topic word first",
    );
    assert.ok(
      !ranked.some((r) => r.memory.id === "function-words-only"),
      "an entry matching only function words must not be returned at all",
    );

    const legacy = legacyRank(entries, query);
    assert.equal(
      legacy[0]?.id,
      "function-words-only",
      "control: counting function words as matches is what ranked the topic-free entry first",
    );
  });

  it("weights a rare matched word above a common one", async () => {
    const entries = [
      ...fillers("deploy", 8),
      entry({ id: "common-word", content: "deploy rollout for the release train", tags: [] }),
      entry({ id: "rare-word", content: "quasar alignment record for the observatory", tags: [] }),
    ];
    const query = "deploy quasar";

    const ranked = await recallRanking(entries, query);
    assert.equal(
      ranked[0]?.memory.id,
      "rare-word",
      "the entry holding the rare term must outrank entries holding only the common one",
    );

    const legacy = legacyRank(entries, query);
    assert.notEqual(
      legacy[0]?.id,
      "rare-word",
      "control: one match each is a tie in the shipped scorer, so rarity is what separates them",
    );
  });

  it("keeps a tag worth about two ordinary terms, not two units of the word scale", async () => {
    const entries = [
      ...fillers("deploy", 8),
      entry({
        id: "tag-only",
        content: "the routing decision recorded earlier today",
        tags: ["quasar"],
      }),
      entry({ id: "word-match", content: "quasar alignment record", tags: [] }),
    ];
    // The tag name is in the query; the tag-only entry's content is not.
    const query = "quasar pipeline";

    const ranked = await recallRanking(entries, query);
    assert.equal(
      ranked[0]?.memory.id,
      "word-match",
      "a rare matched word must outrank a tag whose name the query merely contains",
    );

    const legacy = legacyRank(entries, query);
    assert.equal(
      legacy[0]?.id,
      "tag-only",
      "control: the shipped +2 made the tag outweigh a real word match",
    );
  });

  it("matches a normalized phrase the raw query could not contain", async () => {
    const entries = [
      ...fillers("deploy", 8),
      entry({
        id: "phrase-order",
        content: "keep logged browser session state across restarts",
        tags: [],
      }),
      entry({
        id: "tag-decoy",
        content: "unrelated maintenance note about cookie jar rotation",
        tags: ["browser"],
      }),
    ];
    // The punctuation after "logged" and "session" breaks the raw-phrase test.
    const query = "logged, browser session?";

    const ranked = await recallRanking(entries, query);
    assert.equal(
      ranked[0]?.memory.id,
      "phrase-order",
      "the tokens in order must be worth more than a tag the query happens to name",
    );

    const legacy = legacyRank(entries, query);
    assert.equal(
      legacy[0]?.id,
      "tag-decoy",
      "control: the shipped phrase test compares the raw query, so punctuation hides the phrase and its +2 tag wins",
    );
  });

  it("keeps the project-scoped filter intact", async () => {
    const entries = [
      entry({
        id: "other-project",
        content: "quasar alignment record for the observatory",
        tags: [],
        projectId: "elsewhere/other",
      }),
      entry({
        id: "this-project",
        content: "quasar alignment note for the observatory",
        tags: [],
        projectId: PROJECT,
      }),
    ];
    const ranked = await recallRanking(entries, "quasar alignment", { currentProject: PROJECT });
    assert.equal(ranked[0]?.memory.id, "this-project");
    assert.ok(
      !ranked.some((r) => r.memory.id === "other-project"),
      "an entry from another project must stay out of a project-scoped recall",
    );
  });
});

describe("reserved partition", () => {
  const now = Date.now();
  const prefix = "decision: ";

  function partitionPopulation() {
    const ordinary = Array.from({ length: 205 }, (_, i) =>
      entry({
        id: `ordinary-${i}`,
        content: `ordinary note ${i}`,
        utility: 0.9,
        timestamp: 1_700_000_000_000 + i,
        lastAccessed: now - 10 * 60 * 1000,
      }),
    );
    const reserved = Array.from({ length: 3 }, (_, i) =>
      entry({
        id: `class-${i}`,
        content: `class note ${i}`,
        utility: 0.4,
        source: `${prefix}ruling ${i}`,
        timestamp: 1_700_000_500_000 + i,
        lastAccessed: now - 10 * 60 * 1000,
      }),
    );
    return { ordinary, reserved, all: [...ordinary, ...reserved] };
  }

  beforeEach(() => writeSettings(undefined));

  it("holds configured slots for the configured class, and evicts ordinary entries to pay for them", () => {
    const { ordinary, reserved, all } = partitionPopulation();
    writeSettings({ braid: { memory: { reservedProvenance: { prefix, slots: 3 } } } });

    const kept = pruneMemories(all);
    const keptIds = new Set(kept.map((m) => m.id));
    assert.equal(kept.length, MAX_ENTRIES);
    for (const m of reserved) assert.ok(keptIds.has(m.id), `${m.id} must hold its reserved slot`);
    const keptOrdinary = kept.filter((m) => m.id.startsWith("ordinary-"));
    assert.equal(
      keptOrdinary.length,
      MAX_ENTRIES - reserved.length,
      "the general pool fills exactly the slots the partition did not take",
    );
    const evicted = ordinary.filter((m) => !keptIds.has(m.id));
    assert.equal(evicted.length, 205 - keptOrdinary.length, "every evicted entry is accounted for");
  });

  it("is the shipped prune when no class is configured", () => {
    const { reserved, all } = partitionPopulation();
    const kept = pruneMemories(all);
    assert.equal(kept.length, MAX_ENTRIES);
    assert.ok(
      !kept.some((m) => reserved.some((r) => r.id === m.id)),
      "with no prefix configured a low-utility entry is evicted exactly as before",
    );
  });

  it("refuses a slot count the store cannot honour", () => {
    assert.deepEqual(resolveReservedProvenance(undefined), { prefix: "", slots: 0 });
    assert.equal(resolveReservedProvenance({ prefix: "x: ", slots: MAX_ENTRIES + 500 }).slots, MAX_ENTRIES);
    assert.equal(resolveReservedProvenance({ prefix: "x: ", slots: -1 }).slots, 0);
    assert.equal(resolveReservedProvenance({ prefix: "   ", slots: 5 }).prefix, "");
    assert.equal(resolveReservedProvenance({ prefix: 7, slots: 2.5 }).slots, 0);
  });
});
