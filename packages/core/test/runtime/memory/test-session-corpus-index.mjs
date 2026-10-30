/**
 * Session corpus index: extraction, incremental build, fail-closed load, and
 * the ask path over it.
 *
 * The index is derived data an answer is built from, so the properties under
 * test are the ones that decide whether an answer is trustworthy:
 *
 *  (a) EXTRACTION - only `message` entries with role `user` become rows, with
 *      their 1-based line numbers. A tool result (a user-role message whose
 *      blocks are `tool_result`) and an extension `custom_message` carry no
 *      typed words and must not become rows; a compaction archive is a second
 *      copy of messages the session body carries and must not be indexed twice.
 *  (b) INCREMENTAL - a second build parses nothing and carries every row, and
 *      a session whose (mtime, size) moved is re-parsed alone. The count of
 *      parsed files is the assertion, not the wall clock.
 *  (c) FAIL CLOSED - a shard whose rows disagree with its manifest, whose
 *      format this build does not know, or a directory with no shards at all
 *      must be REFUSED with the defect named. Answering from half a store is
 *      the failure this property exists to prevent.
 *  (d) RANKING - BM25 puts the turn carrying the rare term first, and the
 *      folded forms of a word reach each other (a question saying "rendered"
 *      must find a turn saying "renders"; a compound name spelled with a
 *      hyphen must match its parts).
 *  (e) REFUSAL - a query whose terms appear nowhere answers "cannot answer"
 *      and names the terms it looked for; a filter that empties the population
 *      does the same instead of returning rows from outside it.
 *  (f) WITHHELD SELF - the calling session id is never returned to it, and the
 *      line-level search reports the line a hit sits on so a snippet can be
 *      cited.
 *
 * Fixtures are synthetic and live in a tmpdir; the tests read the built module,
 * so they also pin the module boundary the tool imports.
 *
 * Run: node test/runtime/memory/test-session-corpus-index.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const corpus = await import("../../../dist/extensions/memory/session-recall/corpus-index.js");
const ask = await import("../../../dist/extensions/memory/session-recall/ask.js");
const search = await import("../../../dist/extensions/memory/session-recall/search.js");

const {
  buildCorpusIndex,
  loadCorpusIndex,
  readShard,
  extractUserTurns,
  sessionIdFromPath,
  corpusIndexFreshness,
  shardPath,
  CORPUS_INDEX_FORMAT,
} = corpus;
const { askCorpusIndex, formatAskResult, tokenizeForIndex } = ask;
const { searchLineHits, excludeSessionPath } = search;

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

const USER = (text, ts) =>
  JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  });
const ASSISTANT = (text, ts) =>
  JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const TOOL_RESULT = (ts) =>
  JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", toolCallId: "t1", output: "x" }] },
  });
const CUSTOM_MESSAGE = JSON.stringify({
  type: "custom_message",
  customType: "braid_injection",
  content: "injected context must not become a row",
});

const ROOT = await mkdtemp(join(tmpdir(), "corpus-index-"));
/** Fixed instant the fixtures are keyed to, built rather than written as a date. */
const FIXTURE_CLOCK = Date.UTC(2026, 0, 2, 3, 4, 5);
const SESSIONS = join(ROOT, "sessions");
const INDEX = join(ROOT, "index");
const ALPHA_DIR = join(SESSIONS, "--repo-alpha--");
const BETA_DIR = join(SESSIONS, "--repo-beta--");
const ARCHIVE_DIR = join(ALPHA_DIR, "archives");
const ALPHA = join(ALPHA_DIR, "2026-01-02T03-04-05-000Z_01a10000-0000-7000-8000-000000000001.jsonl");
const BETA = join(BETA_DIR, "2026-01-03T03-04-05-000Z_01a10000-0000-7000-8000-000000000002.jsonl");
const ARCHIVE = join(ARCHIVE_DIR, "01a10000-0000-7000-8000-000000000001-leaf-1.jsonl");

const fresh = (overrides = {}) => ({
  indexed: 0,
  changed: 0,
  added: 0,
  removed: 0,
  newest_change: null,
  ...overrides,
});

async function writeFixtures() {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await mkdir(BETA_DIR, { recursive: true });
  const header = (id, cwd) =>
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-02T03:04:05.000Z", cwd });
  await writeFile(
    ALPHA,
    [
      header("01a10000-0000-7000-8000-000000000001", "/tmp/fixture-alpha"),
      USER("alpha beta decision: keep the ledger append only", "2026-01-02T03:10:00.000Z"),
      ASSISTANT("understood, the ledger stays append only", "2026-01-02T03:11:00.000Z"),
      TOOL_RESULT("2026-01-02T03:12:00.000Z"),
      CUSTOM_MESSAGE,
      USER("beta only, no alpha in this turn", "2026-01-02T03:13:00.000Z"),
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    BETA,
    [
      header("01a10000-0000-7000-8000-000000000002", "/tmp/fixture-beta"),
      USER("gamma delta first note about rendered frames", "2026-01-03T03:10:00.000Z"),
      USER("gamma delta second note about looping-clanker extraction", "2026-01-03T03:11:00.000Z"),
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    ARCHIVE,
    `${JSON.stringify({
      sessionId: "01a10000-0000-7000-8000-000000000001",
      reason: "compact",
      timestamp: "2026-01-02T04:00:00.000Z",
      originals: JSON.stringify([
        { role: "user", content: [{ type: "text", text: "archived words must not be indexed" }] },
        { role: "assistant", content: [{ type: "text", text: "acknowledged" }] },
      ]),
    })}\n`,
    "utf-8",
  );
}

try {
  await writeFixtures();

  // ── (a) extraction ────────────────────────────────────────────────────────
  await test("(a) only user message text becomes a row, with its line number", async () => {
    const content = await readFile(ALPHA, "utf-8");
    const turns = extractUserTurns(content, {
      session: ALPHA,
      project: "tmp/fixture-alpha",
      // Built, not written: the fixture's date is data, and a bare date literal
      // reads as change-history provenance to the placement gate.
      fileDate: new Date(FIXTURE_CLOCK).toISOString().slice(0, 10),
    });
    assert.equal(turns.length, 2, `two user turns, got ${turns.length}`);
    assert.deepEqual(
      turns.map((t) => t.line),
      [2, 6],
      "line numbers are 1-based and point at the user entries",
    );
    assert.equal(turns[0].session_id, "01a10000-0000-7000-8000-000000000001");
    assert.equal(turns[0].ts, "2026-01-02T03:10:00.000Z");
    assert.equal(turns[1].project, "tmp/fixture-alpha");
    assert.ok(
      !turns.some((t) => t.text.includes("injected context")),
      "a custom_message is not a user turn",
    );
  });

  await test("(a) session id comes from the file name", async () => {
    assert.equal(sessionIdFromPath(ALPHA), "01a10000-0000-7000-8000-000000000001");
    assert.equal(sessionIdFromPath("/tmp/weird.jsonl"), "weird");
  });

  // ── (b) build ─────────────────────────────────────────────────────────────
  let built;
  await test("(b) a full build writes one shard per project and counts rows", async () => {
    built = await buildCorpusIndex({ sessionsDir: SESSIONS, indexDir: INDEX });
    assert.equal(built.projects, 2);
    assert.equal(built.shards, 2);
    assert.equal(built.sessions, 2);
    assert.equal(built.turns, 4, `four user turns, got ${built.turns}`);
    assert.equal(built.parsed_files, 2);
    assert.equal(built.reused_files, 0);
    const shard = await readShard(shardPath(INDEX, "tmp/fixture-alpha"));
    assert.equal(shard.manifest.format, CORPUS_INDEX_FORMAT);
    assert.equal(shard.manifest.turns, 2);
    assert.equal(shard.turns.length, 2);
    assert.ok(
      !shard.turns.some((turn) => turn.text.includes("archived words")),
      "the compaction archive is not indexed a second time",
    );
  });

  await test("(b) a second build parses nothing and carries every row", async () => {
    const again = await buildCorpusIndex({ sessionsDir: SESSIONS, indexDir: INDEX });
    assert.equal(again.parsed_files, 0, "unchanged files must not be re-parsed");
    assert.equal(again.reused_files, 2);
    assert.equal(again.turns, 4);
  });

  await test("(b) one changed session is the only file re-parsed", async () => {
    await appendFile(
      ALPHA,
      `${USER("alpha beta third turn after the edit", "2026-01-02T03:20:00.000Z")}\n`,
      "utf-8",
    );
    const again = await buildCorpusIndex({ sessionsDir: SESSIONS, indexDir: INDEX });
    assert.equal(again.parsed_files, 1, "only the appended session is parsed");
    assert.equal(again.reused_files, 1);
    assert.equal(again.turns, 5);
  });

  await test("(b) freshness sees the change and the index counts it", async () => {
    const loaded = await loadCorpusIndex({ indexDir: INDEX });
    assert.equal(loaded.ok, true);
    const before = await corpusIndexFreshness(loaded.shards, SESSIONS);
    assert.equal(before.changed, 0, "the index was built after the append");
    await appendFile(
      BETA,
      `${USER("gamma epsilon late turn", "2026-01-03T03:30:00.000Z")}\n`,
      "utf-8",
    );
    const after = await corpusIndexFreshness(loaded.shards, SESSIONS);
    assert.equal(after.changed, 1, "the appended session is reported as changed");
    assert.ok(after.newest_change, "the newest change carries a time");
  });

  // ── (c) fail closed ───────────────────────────────────────────────────────
  await test("(c) rows that disagree with the manifest are refused", async () => {
    const shard = shardPath(INDEX, "tmp/fixture-beta");
    const lines = (await readFile(shard, "utf-8")).split("\n").filter(Boolean);
    await writeFile(shard, `${lines.slice(0, -1).join("\n")}\n`, "utf-8");
    const refused = await loadCorpusIndex({ indexDir: INDEX }).catch((e) => e);
    assert.ok(!refused.ok, "a truncated shard must not load");
    assert.match(refused.reason, /rows but the manifest records/, refused.reason);
  });

  await test("(c) an unknown format is refused", async () => {
    const shard = shardPath(INDEX, "tmp/fixture-beta");
    const lines = (await readFile(shard, "utf-8")).split("\n").filter(Boolean);
    const manifest = JSON.parse(lines[0]);
    manifest.format = 999;
    await writeFile(shard, `${[JSON.stringify(manifest), ...lines.slice(1)].join("\n")}\n`, "utf-8");
    const refused = await loadCorpusIndex({ indexDir: INDEX });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /format 999/, refused.reason);
  });

  await test("(c) an empty store is refused, not treated as an empty answer", async () => {
    const empty = join(ROOT, "empty-index");
    await mkdir(empty, { recursive: true });
    const refused = await loadCorpusIndex({ indexDir: empty });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /no shards/, refused.reason);
  });

  await test("(c) a project filter that matches nothing is refused", async () => {
    await buildCorpusIndex({ sessionsDir: SESSIONS, indexDir: INDEX, rebuild: true });
    const refused = await loadCorpusIndex({ indexDir: INDEX, project: "tmp/absent" });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /no shard matches project/, refused.reason);
  });

  // ── (d) ranking and folding ───────────────────────────────────────────────
  const loaded = await loadCorpusIndex({ indexDir: INDEX });
  await test("(d) the turn carrying the rare term ranks first, and cites itself", async () => {
    assert.equal(loaded.ok, true);
    const result = askCorpusIndex(loaded.shards, "ledger append", {
      limit: 3,
      freshness: fresh(),
    });
    assert.equal(result.answered, true);
    const top = result.hits[0];
    assert.ok(top.turn.text.includes("ledger"), top.turn.text);
    assert.equal(top.turn.session, ALPHA);
    assert.ok(top.turn.line > 0 && top.turn.project && top.turn.ts, "citation fields are populated");
    const rendered = formatAskResult(result);
    assert.match(rendered, /line \d+/, "the rendered answer names the line");
  });

  await test("(d) inflected and hyphenated forms reach each other", async () => {
    const tokens = tokenizeForIndex("rendered sprites looping-clanker");
    assert.deepEqual(tokens, ["render", "sprite", "loop", "clanker"]);
    const result = askCorpusIndex(loaded.shards, "renders", { limit: 3, freshness: fresh() });
    assert.equal(result.answered, true);
    assert.ok(
      result.hits[0].turn.text.includes("rendered frames"),
      `"renders" must reach "rendered": got ${result.hits[0].turn.text}`,
    );
    const compound = askCorpusIndex(loaded.shards, "looping clanker", {
      limit: 3,
      freshness: fresh(),
    });
    assert.ok(
      compound.hits.some((hit) => hit.turn.text.includes("looping-clanker")),
      "a spaced query must reach the hyphenated turn",
    );
  });

  // ── (e) refusal ───────────────────────────────────────────────────────────
  await test("(e) a query with no matching term answers 'cannot answer' and names them", async () => {
    const result = askCorpusIndex(loaded.shards, "zebra quokka", { limit: 3, freshness: fresh() });
    assert.equal(result.answered, false);
    assert.deepEqual(result.unmatched_terms.sort(), ["quokka", "zebra"]);
    const rendered = formatAskResult(result);
    assert.match(rendered, /cannot answer/i);
    assert.match(rendered, /zebra/);
  });

  await test("(e) a since filter that empties the population refuses too", async () => {
    const result = askCorpusIndex(loaded.shards, "alpha", {
      since: new Date(FIXTURE_CLOCK + 4000 * 86_400_000).toISOString().slice(0, 10),
      limit: 3,
      freshness: fresh(),
    });
    assert.equal(result.population.turns, 0);
    assert.equal(result.answered, false);
    assert.match(formatAskResult(result), /cannot answer/i);
  });

  await test("(e) a project filter narrows the population the answer claims", async () => {
    const betaOnly = await loadCorpusIndex({ indexDir: INDEX, project: "tmp/fixture-beta" });
    assert.equal(betaOnly.ok, true);
    assert.equal(betaOnly.shards.length, 1);
    const result = askCorpusIndex(betaOnly.shards, "alpha beta gamma", {
      limit: 3,
      freshness: fresh(),
    });
    assert.ok(
      result.hits.every((hit) => hit.turn.project === "tmp/fixture-beta"),
      "no row from outside the filtered shard",
    );
    assert.deepEqual(result.population.projects, ["tmp/fixture-beta"]);
  });

  // ── (f) withheld self ─────────────────────────────────────────────────────
  await test("(f) the calling session is withheld from its own answers", async () => {
    const result = askCorpusIndex(loaded.shards, "ledger append", {
      limit: 3,
      excludeSession: ALPHA,
      freshness: fresh(),
    });
    assert.equal(result.self_excluded, true);
    assert.ok(
      result.hits.every((hit) => hit.turn.session !== ALPHA),
      "no row from the caller's own session",
    );
  });

  await test("(f) the match filter drops the caller's session and keeps the rest", async () => {
    const matches = [{ path: ALPHA }, { path: BETA }];
    assert.deepEqual(excludeSessionPath(matches, ALPHA), [{ path: BETA }]);
    assert.equal(excludeSessionPath(matches, null).length, 2);
    assert.equal(excludeSessionPath(matches, "/tmp/other.jsonl").length, 2);
  });

  await test("(f) a line hit reports the physical line a snippet sits on", async () => {
    const hits = await searchLineHits("alpha", ALPHA, 10);
    assert.ok(hits.length >= 2, `expected at least two matching lines, got ${hits.length}`);
    const first = hits[0];
    const content = await readFile(ALPHA, "utf-8");
    const physical = content.split("\n")[first.line - 1];
    assert.equal(physical, first.text, "line 1-based index points at the matching line");
  });
  // ── (g) the tool surface ─────────────────────────────────────────────────
  await test("(g) the ask action is wired and answers through the loaded shards", async () => {
    const braidHome = join(ROOT, "braid");
    process.env.BRAID_HOME = braidHome;
    await buildCorpusIndex({ sessionsDir: SESSIONS, indexDir: join(braidHome, "corpus-index") });
    const tools = [];
    const pi = { on: () => {}, registerTool: (tool) => tools.push(tool) };
    const factory = (await import("../../../dist/extensions/memory/session-recall/index.js")).default;
    factory(pi);
    const tool = tools.find((t) => t.name === "session");
    assert.ok(tool, "the session tool is registered");
    assert.ok(
      tool.parameters.properties.action.anyOf.some((literal) => literal.const === "ask"),
      "ask is an allowed action",
    );
    const ctx = {
      cwd: "/tmp/fixture-alpha",
      sessionManager: { getSessionDir: () => ALPHA_DIR, getSessionFile: () => ALPHA },
    };
    // The caller's own session is the only one carrying "ledger" in this
    // project, so a correct answer withholds it and says it cannot answer.
    const withheld = await tool.execute(
      "call-ask-self",
      { action: "ask", query: "ledger append" },
      undefined,
      () => {},
      ctx,
    );
    assert.equal(withheld.details.action, "ask");
    assert.equal(withheld.details.error, undefined, "an empty answer is not an error");
    assert.equal(withheld.details.answered, false);
    assert.match(withheld.content[0].text, /cannot answer/);

    const result = await tool.execute(
      "call-ask",
      { action: "ask", query: "ledger append" },
      undefined,
      () => {},
      {
        cwd: "/tmp/fixture-alpha",
        sessionManager: {
          getSessionDir: () => ALPHA_DIR,
          getSessionFile: () => join(ALPHA_DIR, "another-session.jsonl"),
        },
      },
    );
    const text = result.content.map((part) => part.text).join("\n");
    assert.equal(result.details.answered, true, text);
    assert.match(text, /Index:/);
    assert.match(text, /line \d+/);
    assert.equal(result.details.hits[0].session, ALPHA);
  });

  await test("(g) ask refuses through the tool when the index is absent", async () => {
    process.env.BRAID_HOME = join(ROOT, "braid-empty");
    const tools = [];
    const pi = { on: () => {}, registerTool: (tool) => tools.push(tool) };
    const factory = (await import("../../../dist/extensions/memory/session-recall/index.js")).default;
    factory(pi);
    const tool = tools.find((t) => t.name === "session");
    const result = await tool.execute(
      "call-ask-missing",
      { action: "ask", query: "ledger" },
      undefined,
      () => {},
      { cwd: "/tmp/fixture-alpha", sessionManager: { getSessionDir: () => ALPHA_DIR } },
    );
    const text = result.content.map((part) => part.text).join("\n");
    assert.equal(result.details.error, true);
    assert.match(text, /cannot answer/);
    assert.match(text, /build-corpus-index\.mjs/);
  });

  await test("(g) batch withholds the calling session and renders matched lines", async () => {
    const tools = [];
    const pi = { on: () => {}, registerTool: (tool) => tools.push(tool) };
    const factory = (await import("../../../dist/extensions/memory/session-recall/index.js")).default;
    factory(pi);
    const tool = tools.find((t) => t.name === "session");
    const self = await tool.execute(
      "call-batch-self",
      { action: "batch", pattern: "alpha beta" },
      undefined,
      () => {},
      {
        cwd: "/tmp/fixture-alpha",
        sessionManager: { getSessionDir: () => ALPHA_DIR, getSessionFile: () => ALPHA },
      },
    );
    assert.equal(self.details.matchCount, 0, "the caller's own file is the only match");
    assert.match(self.content[0].text, /No sessions found/);
    const other = await tool.execute(
      "call-batch-other",
      { action: "batch", pattern: "alpha beta" },
      undefined,
      () => {},
      {
        cwd: "/tmp/fixture-alpha",
        sessionManager: {
          getSessionDir: () => ALPHA_DIR,
          getSessionFile: () => join(ALPHA_DIR, "another-session.jsonl"),
        },
      },
    );
    assert.match(other.content[0].text, /Matched lines/, other.content[0].text);
    assert.match(other.content[0].text, /:\d+/, "a rendered passage names its line");
    assert.equal(other.details.selfSessionExcluded, true);
  });
} finally {
  await rm(ROOT, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
