/**
 * Owner speech: the deployment half of the ruling write path, and the CLI that
 * drives both halves into a store.
 *
 * Contract pinned here:
 *   (a) owner speech only: a dispatch prompt and a non-telegram whisper
 *       envelope yield nothing, while a telegram envelope is stripped and
 *       classified, and its quote carries none of the wrapper;
 *   (b) the split is real: the generic classifier sees the same body with and
 *       without the envelope and returns the same class and quote, which is
 *       what it means for the grammar to be channel-blind;
 *   (c) the pointer shape is fixed and it resolves: `owner ruling:
 *       <session path>:<line> (<iso ts>, <project>)` addresses the line whose
 *       text contains the quote;
 *   (d) the fixed handles are the reader's filters, and the quote's own words
 *       are added beside them by the derivation - re-derived here from the
 *       store the CLI wrote, not read back out of the code that wrote it;
 *   (e) the CLI dry-run is a census and writes nothing, `--write` writes the
 *       survivors through saveMemory, and a second `--write` adds zero;
 *   (f) the caps bound the write (per project and globally, newest first);
 *   (g) the refusal checks are load-bearing: a planted classifier that accepts
 *       everything reddens every negative, by name.
 *
 * Isolation: HOME and BRAID_HOME are throwaway temp dirs before any dist
 * import, so the developer's live braid tree is never read or written. The
 * corpus fixture is a shard written by this test, never the real index.
 *
 * Run: node test/runtime/lib/test-owner-speech.mjs
 */
import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFixtureParses } from "./fixture-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const DIST = join(ROOT, "dist");
const SCRIPT = join(ROOT, "scripts", "build-decisions-index.mjs");

// -- Isolation, before any dist import --------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), "owner-speech-"));
process.env.HOME = SANDBOX;
process.env.BRAID_HOME = join(SANDBOX, "braid");
mkdirSync(join(SANDBOX, ".pi", "agent"), { recursive: true });
writeFileSync(join(SANDBOX, ".pi", "agent", "settings.json"), JSON.stringify({}));

const {
  BRAID_VOCABULARY,
  classifyOwnerRuling,
  OWNER_RULING_LABEL,
  projectTag,
  rulingBaseTags,
  rulingDuplicateKey,
  rulingPointer,
  rulingPointerPattern,
} = await import(pathToFileURL(join(DIST, "lib", "orchestrator", "owner-speech.js")).href);
const { classifyRulingBody, QUOTE_LIMIT } = await import(
  pathToFileURL(join(DIST, "lib", "memory", "decision-grammar.js")).href
);
const { QUERY_STOP_WORDS } = await import(
  pathToFileURL(join(DIST, "lib", "memory", "constants.js")).href
);

// -- Fixture: two projects, one session file each ---------------------------
const INDEX = join(SANDBOX, "corpus-index");
const SESSIONS = join(SANDBOX, "sessions");
mkdirSync(INDEX, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });

const TELEGRAM_BODY = "we never post through platform APIs; the logged-in browser session is the only delivery path.";
const TELEGRAM = [
  "[braid-whisper - telegram] from @owner in chat 42/private",
  "",
  TELEGRAM_BODY,
  "[braid-whisper-end]",
].join("\n");

const NON_TELEGRAM = [
  "[braid-whisper - enforcement] Context compacted at turn one. Re-orient, then always read the scratchpad first.",
  "[braid-whisper-end]",
].join("\n");

const DISPATCH =
  "You are an implementation agent on branch fixture/relay. Read your brief in full, then commit. " +
  "Do not push, do not tag, and never touch the primary checkout.";

const TOOL_PASTE = Array.from(
  { length: 60 },
  (_, i) => `2026-10-30T12:${String(i % 60).padStart(2, "0")}:00Z INFO gate step ${i} passed with 0 findings`,
).join("\n");

/** One turn per line, in the shape pi writes: a user message with a text block. */
function sessionFile(name, turns) {
  const path = join(SESSIONS, name);
  const lines = turns.map((text) =>
    JSON.stringify({
      type: "message",
      id: `m${Math.random().toString(16).slice(2, 8)}`,
      timestamp: "2026-10-30T12:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text }] },
    }),
  );
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const POSITIVES = {
  prohibition: "we never post through platform APIs; the browser session is the delivery path.",
  preference: "we prefer the browser session over the API route, always.",
  requirement: "from now our reports should carry the exact command a reviewer can run.",
  policy: "the rule is: one writer, up to two readers.",
};

const NEGATIVES = {
  question: "May a contact reach the owner directly?",
  "pasted shell command": "$ npm run ci:check\n$ git commit -am wip\n",
  "tool-output paste": TOOL_PASTE,
  "short log paste": Array.from({ length: 8 }, (_, i) => `2026-10-30T12:0${i}:00Z step ${i} ok`).join("\n"),
  "unadopted recommendation": "perhaps we should consider preferring the browser session over APIs.",
  "status report": "done: merged and pushed, all gates green.",
  "seat dispatch prompt": DISPATCH,
  "non-telegram whisper envelope": NON_TELEGRAM,
};

const alphaPath = sessionFile("alpha-session.jsonl", [
  ...Object.values(POSITIVES),
  ...Object.values(NEGATIVES),
  TELEGRAM,
]);
const betaTurn = "we should always keep reports in braid-docs and never in the repository.";
const betaPath = sessionFile("beta-session.jsonl", [betaTurn]);

const row = (path, id, project, ts, line, text) => ({ session: path, session_id: id, project, ts, line, text });

function writeShard(project, rows) {
  const manifest = { kind: "manifest", format: 1, project, built_at: "2026-10-30T00:00:00.000Z", files: [] };
  const name = `${project.replace(/[^a-z0-9]+/gi, "-")}.jsonl`;
  writeFileSync(
    join(INDEX, name),
    [JSON.stringify(manifest), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n",
  );
}

const ALPHA_TURNS = [...Object.values(POSITIVES), ...Object.values(NEGATIVES), TELEGRAM];
writeShard(
  "fixture/alpha",
  ALPHA_TURNS.map((text, i) =>
    row(alphaPath, "alpha-session", "fixture/alpha", `2026-10-2${9 - Math.floor(i / 12)}T10:0${i % 10}:00.000Z`, i + 1, text),
  ),
);
writeShard("fixture/beta", [row(betaPath, "beta-session", "fixture/beta", "2026-10-30T09:00:00.000Z", 1, betaTurn)]);

/** Run the classifier over one fixture line, straight from the session file. */
function turnAt(path, line, project = "fixture/alpha") {
  const entry = JSON.parse(readFileSync(path, "utf8").split("\n")[line - 1]);
  const text = entry.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  return { session: path, session_id: "x", project, ts: "2026-10-29T10:00:00.000Z", line, text };
}

// -- (a) and (b): owner speech, and a channel-blind grammar -----------------
test("a telegram envelope is stripped, classified, and its wrapper is not quoted", () => {
  const candidate = classifyOwnerRuling(turnAt(alphaPath, ALPHA_TURNS.indexOf(TELEGRAM) + 1));
  assert.ok(candidate, "the owner's telegram message was refused");
  assert.equal(candidate.class, "prohibition");
  assert.ok(!candidate.quote.includes("[braid-whisper"), `quote carries the envelope: ${candidate.quote}`);
  assert.ok(candidate.quote.toLowerCase().includes("browser session"), candidate.quote);
});

test("the generic classifier returns the same shape for the body with or without the envelope", () => {
  const candidate = classifyOwnerRuling(turnAt(alphaPath, ALPHA_TURNS.indexOf(TELEGRAM) + 1));
  assert.ok(candidate, "the owner's telegram message was refused");
  const bare = classifyRulingBody(TELEGRAM_BODY, BRAID_VOCABULARY);
  assert.ok(bare, "the stripped body was refused by the generic classifier");
  assert.deepEqual(
    { class: bare.class, quote: bare.quote },
    { class: candidate.class, quote: candidate.quote },
    "the envelope changed what the grammar saw",
  );
});

test("a dispatch prompt and a foreign envelope stay out, each by its own screen", () => {
  assert.equal(
    classifyOwnerRuling(turnAt(alphaPath, ALPHA_TURNS.indexOf(DISPATCH) + 1)),
    null,
    "a dispatch prompt was filed as an owner ruling",
  );
  assert.equal(
    classifyOwnerRuling(turnAt(alphaPath, ALPHA_TURNS.indexOf(NON_TELEGRAM) + 1)),
    null,
    "a subsystem envelope was filed as an owner ruling",
  );
});

test("the named shapes are classified, and each quote is verbatim", () => {
  for (const [expected, text] of Object.entries(POSITIVES)) {
    const candidate = classifyOwnerRuling(turnAt(alphaPath, ALPHA_TURNS.indexOf(text) + 1));
    assert.ok(candidate, `no candidate for ${expected}: ${text}`);
    assert.equal(candidate.class, expected, `${expected} classified as ${candidate.class}`);
    const quote = candidate.quote.replace(/\.\.\.$/, "");
    assert.ok(text.includes(quote), `quote is not a slice of the turn: ${quote}`);
    assert.ok(candidate.quote.length <= QUOTE_LIMIT, `quote over ${QUOTE_LIMIT} characters`);
  }
});

// -- (c) and (d): pointer, key, handles ------------------------------------
test("the pointer has the fixed shape and resolves to the quoted line", () => {
  const candidate = classifyOwnerRuling(turnAt(alphaPath, 1));
  const pointer = rulingPointer(candidate);
  assert.match(pointer, /^owner ruling: \/.+:\d+ \(\d{4}-\d{2}-\d{2}T[^)]+, .+\)$/);
  const [, path, line] = /^owner ruling: (.+):(\d+) \(/.exec(pointer);
  const raw = readFileSync(path, "utf8").split("\n")[Number(line) - 1];
  const text = JSON.parse(raw).message.content.map((block) => block.text).join(" ");
  assert.ok(text.includes(candidate.quote.replace(/\.\.\.$/, "")), "reading the line back does not carry the quote");
  assert.equal(rulingDuplicateKey(candidate), `${candidate.session_id}:${candidate.line}`);
  assert.deepEqual(rulingBaseTags(candidate), ["owner-ruling", candidate.class, "fixture-alpha"]);
  assert.equal(projectTag("Projects/Agents/pi-braid"), "projects-agents-pi-braid");
  // The label the writer stamps is the same one the scanner reads.
  assert.equal(OWNER_RULING_LABEL, "owner ruling");
  assert.ok(rulingPointerPattern().test(rulingPointer(candidate)), "the pointer pattern does not match its own pointer");
});

// -- (e) and (f): the CLI ------------------------------------------------
function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, "--index", INDEX, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: SANDBOX, BRAID_HOME: join(SANDBOX, "braid") },
  });
  assert.equal(result.status, 0, `cli failed (${args.join(" ")}): ${result.stderr}`);
  return result.stdout;
}

const STORE = join(SANDBOX, "braid", "memory", "semantic.json");
const readStore = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")).memories : []);

/** The derivation, re-implemented here so the store's tags are checked, not echoed. */
function expectedDerivedTags(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const token of new Set(entry.content.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const ceiling = entries.length * 0.25;
  const byId = new Map();
  for (const entry of entries) {
    const seen = new Set();
    const candidates = [];
    for (const token of entry.content.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
      if (seen.has(token) || QUERY_STOP_WORDS.has(token)) continue;
      seen.add(token);
      const count = counts.get(token) ?? 0;
      if (count > ceiling) continue;
      candidates.push({ token, count, first: candidates.length });
    }
    candidates.sort((a, b) => b.count - a.count || a.first - b.first);
    byId.set(entry.id, candidates.slice(0, 3).map((candidate) => candidate.token));
  }
  return byId;
}

test("dry-run is a census and writes nothing", () => {
  const census = JSON.parse(runCli("--json"));
  assert.equal(census.mode, "dry-run");
  assert.equal(census.totals.turns, ALPHA_TURNS.length + 1);
  assert.ok(census.totals.candidates >= 5, `candidates: ${census.totals.candidates}`);
  assert.equal(census.totals.kept, census.totals.survivors - census.totals.duplicates);
  assert.equal(census.store.before, 0);
  assert.equal(census.store.written, 0);
  assert.equal(existsSync(STORE), false, "dry-run wrote the store");
});

test("--write lands the survivors with derived tags, and a second --write adds zero", () => {
  const first = JSON.parse(runCli("--write", "--json"));
  const written = readStore();
  assert.equal(written.length, first.store.written);
  assert.ok(written.length >= 5, `wrote ${written.length}`);
  assert.ok(first.store.backup, "a write without a backup is not reversible");
  const derived = expectedDerivedTags(written);
  for (const entry of written) {
    assert.equal(entry.type, "preference");
    assert.equal(entry.tags[0], "owner-ruling");
    assert.ok(
      ["prohibition", "preference", "requirement", "policy"].includes(entry.tags[1]),
      `class tag missing: ${entry.tags[1]}`,
    );
    assert.match(entry.source, new RegExp(`^${OWNER_RULING_LABEL}: /`));
    assert.equal(entry.projectId, undefined, "a scoped entry is invisible to another project's recall");
    assert.ok(entry.utility > 0 && entry.utility <= 1);
    const expected = derived.get(entry.id);
    assert.deepEqual(entry.tags.slice(3), expected, `tags for ${entry.content.slice(0, 40)}`);
    for (const tag of expected) {
      assert.ok(tag.length >= 4, `tag under four characters: ${tag}`);
      assert.ok(!QUERY_STOP_WORDS.has(tag), `stop word survived as a tag: ${tag}`);
    }
  }
  const second = JSON.parse(runCli("--write", "--json"));
  assert.equal(second.store.written, 0, "second run wrote entries");
  assert.equal(readStore().length, written.length, "second run changed the store");
  assert.ok(second.totals.duplicates >= written.length);
});

test("the caps bound the write, newest first", () => {
  rmSync(STORE, { force: true });
  const capped = JSON.parse(runCli("--write", "--json", "--max-per-project", "1", "--max-total", "1"));
  assert.equal(capped.store.written, 1, JSON.stringify(capped.totals));
  const [entry] = readStore();
  assert.ok(entry.source.includes("fixture/beta"), `kept ${entry.source}`);
});

test("--project and --since bound the population", () => {
  const byProject = JSON.parse(runCli("--json", "--project", "fixture/beta"));
  assert.equal(byProject.totals.turns, 1);
  assert.equal(byProject.totals.candidates, 1);
  assert.equal(byProject.totals.survivors, 1);
  const bySince = JSON.parse(runCli("--json", "--since", "2026-10-30T23:00:00.000Z"));
  assert.equal(bySince.totals.turns, 0);
  assert.equal(bySince.totals.candidates, 0);
});

// -- (g): the checks are load-bearing ------------------------------------
test("a planted permissive classifier reddens every refusal, by name", async () => {
  const mutantPath = join(SANDBOX, "mutant-classifier.mjs");
  const real = pathToFileURL(join(DIST, "lib", "orchestrator", "owner-speech.js")).href;
  writeFileSync(
    mutantPath,
    [
      `import { classifyOwnerRuling as real } from ${JSON.stringify(real)};`,
      `export function classifyOwnerRuling(turn) {`,
      `  return real(turn) ?? { class: "policy", quote: String(turn.text).slice(0, 40),`,
      `    session: turn.session, session_id: turn.session_id, project: turn.project,`,
      `    ts: turn.ts, line: turn.line };`,
      `}`,
      "",
    ].join("\n"),
  );
  assertFixtureParses(mutantPath);
  const { classifyOwnerRuling: mutant } = await import(pathToFileURL(mutantPath).href);
  const reddened = Object.entries(NEGATIVES).filter(
    ([, text]) => mutant({ ...turnAt(alphaPath, 1), text }) !== null,
  );
  for (const name of Object.keys(NEGATIVES)) {
    assert.ok(
      reddened.some(([reddenedName]) => reddenedName === name),
      `mutant did not redden the "${name}" assertion, so that assertion is not load-bearing`,
    );
  }
});

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});
