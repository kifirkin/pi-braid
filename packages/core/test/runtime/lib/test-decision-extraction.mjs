/**
 * Owner-ruling extraction: the decision backfill's classifier and write path.
 *
 * Contract pinned here:
 *   (a) the four ruling shapes are named: a prohibition, a preference, a
 *       requirement, a policy - each with the class the marker table assigns;
 *   (b) the quote is verbatim: a contiguous slice of the owner's turn, capped
 *       at 400 characters with a trailing ellipsis, never a paraphrase;
 *   (c) the pointer shape is fixed and it resolves: `owner ruling:
 *       <session path>:<line> (<iso ts>, <project>)` addresses the line whose
 *       text contains the quote;
 *   (d) the four named negatives stay out: a question, a pasted shell command,
 *       a multi-kilobyte tool-output paste, and a recommendation the owner
 *       floated but did not adopt;
 *   (e) owner speech only: a seat dispatch prompt and a non-telegram whisper
 *       envelope yield nothing, while a telegram envelope is stripped and
 *       classified;
 *   (f) the CLI dry-run is a census and writes nothing, `--write` writes the
 *       survivors through saveMemory, and a second `--write` adds zero;
 *   (g) the caps bound the write (per project and globally, newest first);
 *   (h) the checks are load-bearing: a planted classifier that accepts
 *       everything reddens every negative assertion, by name.
 *
 * Isolation: HOME and BRAID_HOME are throwaway temp dirs before any dist
 * import, so the developer's live braid tree is never read or written. The
 * corpus fixture is a shard written by this test, never the real index.
 *
 * Run: node test/runtime/lib/test-decision-extraction.mjs
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
const SANDBOX = mkdtempSync(join(tmpdir(), "decision-extraction-"));
process.env.HOME = SANDBOX;
process.env.BRAID_HOME = join(SANDBOX, "braid");
mkdirSync(join(SANDBOX, ".pi", "agent"), { recursive: true });
writeFileSync(join(SANDBOX, ".pi", "agent", "settings.json"), JSON.stringify({}));

const {
  classifyOwnerRuling,
  projectTag,
  rulingDuplicateKey,
  rulingPointer,
  rulingTags,
  QUOTE_LIMIT,
} = await import(pathToFileURL(join(DIST, "lib", "memory", "decision-extraction.js")).href);

// -- Fixture: two projects, one session file each ---------------------------
const INDEX = join(SANDBOX, "corpus-index");
const SESSIONS = join(SANDBOX, "sessions");
mkdirSync(INDEX, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });

const TELEGRAM = [
  "[braid-whisper - telegram] from @kifir (owner) in chat 42/private",
  "",
  "we never post through platform APIs; the logged-in browser session is the only delivery path.",
  "[braid-whisper-end]",
].join("\n");

const NON_TELEGRAM = [
  "[braid-whisper - enforcement] Context compacted at turn 1. Re-orient, then always read the scratchpad first.",
  "[braid-whisper-end]",
].join("\n");

const DISPATCH =
  "You are worker w42, an implementation worker. Read your brief in full, then commit. " +
  "Do not push, do not tag, and never touch the primary checkout.";

const TOOL_PASTE = Array.from(
  { length: 60 },
  (_, i) =>
    `2026-10-30T12:${String(i % 60).padStart(2, "0")}:00Z INFO gate step ${i} passed with 0 findings`,
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
  question: "May a worker contact the owner directly?",
  "pasted shell command": "$ npm run ci:check\n$ git commit -am wip\n",
  "tool-output paste": TOOL_PASTE,
  "short log paste": Array.from({ length: 8 }, (_, i) => `2026-10-30T12:0${i}:00Z step ${i} ok`).join("\n"),
  "unadopted recommendation": "perhaps we should consider preferring the browser session over APIs.",
  "status report": "done: merged and pushed, all gates green.",
  "seat dispatch prompt": DISPATCH,
  "non-telegram whisper envelope": NON_TELEGRAM,
};

const alphaTurns = [
  POSITIVES.prohibition,
  POSITIVES.preference,
  POSITIVES.requirement,
  POSITIVES.policy,
  NEGATIVES.question,
  NEGATIVES["pasted shell command"],
  NEGATIVES["tool-output paste"],
  NEGATIVES["unadopted recommendation"],
  NEGATIVES["status report"],
  NEGATIVES["seat dispatch prompt"],
  NEGATIVES["non-telegram whisper envelope"],
  TELEGRAM,
];
const betaTurns = ["we should always keep reports in braid-docs and never in the repository."];

const alphaPath = sessionFile("alpha-session.jsonl", alphaTurns);
const betaPath = sessionFile("beta-session.jsonl", betaTurns);

const row = (path, id, project, ts, line, text) => ({ session: path, session_id: id, project, ts, line, text });

function writeShard(project, rows) {
  const manifest = { kind: "manifest", format: 1, project, built_at: "2026-10-31T00:00:00.000Z", files: [] };
  const name = `${project.replace(/[^a-z0-9]+/gi, "-")}.jsonl`;
  writeFileSync(
    join(INDEX, name),
    [JSON.stringify(manifest), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n",
  );
}

writeShard(
  "fixture/alpha",
  alphaTurns.map((text, i) =>
    row(alphaPath, "alpha-session", "fixture/alpha", `2026-10-2${9 - Math.floor(i / 12)}T10:0${i % 10}:00.000Z`, i + 1, text),
  ),
);
writeShard("fixture/beta", [
  row(betaPath, "beta-session", "fixture/beta", "2026-10-30T09:00:00.000Z", 1, betaTurns[0]),
]);

/** Run the classifier over one fixture line, straight from the session file. */
function turnAt(path, line) {
  const entry = JSON.parse(readFileSync(path, "utf8").split("\n")[line - 1]);
  const text = entry.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  return { session: path, session_id: "x", project: "fixture/alpha", ts: "2026-10-29T10:00:00.000Z", line, text };
}

/** The negative checks, as data, so a mutant can be judged against the same list. */
function negativeChecks(classify) {
  const cases = Object.entries(NEGATIVES).map(([name, text]) => ({
    name,
    verdict: classify({ session: alphaPath, session_id: "x", project: "fixture/alpha", ts: "2026-10-29T10:00:00.000Z", line: 1, text }),
  }));
  return cases;
}

// -- (a) and (b): classes and verbatim quotes -------------------------------
test("each ruling shape is named, and its quote is verbatim", () => {
  for (const [expected, text] of Object.entries(POSITIVES)) {
    const index = alphaTurns.indexOf(text);
    const candidate = classifyOwnerRuling(turnAt(alphaPath, index + 1));
    assert.ok(candidate, `no candidate for ${expected}: ${text}`);
    assert.equal(candidate.class, expected, `${expected} classified as ${candidate.class}`);
    const quote = candidate.quote.replace(/\.\.\.$/, "");
    assert.ok(text.includes(quote), `quote is not a slice of the turn: ${quote}`);
    assert.ok(candidate.quote.length <= QUOTE_LIMIT, `quote over ${QUOTE_LIMIT} characters`);
    if (candidate.quote !== quote) assert.ok(candidate.quote.endsWith("..."), "a cut quote ends with an ellipsis");
  }
});

// -- (c): pointer shape and resolution -------------------------------------
test("the pointer has the fixed shape and resolves to the quoted line", () => {
  const candidate = classifyOwnerRuling(turnAt(alphaPath, 1));
  const pointer = rulingPointer(candidate);
  assert.match(pointer, /^owner ruling: \/.+:\d+ \(\d{4}-\d{2}-\d{2}T[^)]+, .+\)$/);
  const [, path, line] = /^owner ruling: (.+):(\d+) \(/.exec(pointer);
  const raw = readFileSync(path, "utf8").split("\n")[Number(line) - 1];
  const text = JSON.parse(raw).message.content.map((block) => block.text).join(" ");
  assert.ok(text.includes(candidate.quote.replace(/\.\.\.$/, "")), "sed -n '<line>p' does not carry the quote");
  assert.equal(rulingDuplicateKey(candidate), `${candidate.session_id}:${candidate.line}`);
  assert.deepEqual(rulingTags(candidate), [
    "owner-ruling",
    "decision",
    candidate.class,
    projectTag(candidate.project),
  ]);
  assert.equal(projectTag("Projects/Agents/pi-braid"), "projects-agents-pi-braid");
});

// -- (d) and (e): the named negatives -------------------------------------
test("the named negatives stay out, each by its own screen", () => {
  for (const { name, verdict } of negativeChecks(classifyOwnerRuling)) {
    assert.equal(verdict, null, `${name} produced a candidate: ${verdict && verdict.quote}`);
  }
});

test("a telegram envelope is stripped and classified; its wrapper is not quoted", () => {
  const candidate = classifyOwnerRuling(turnAt(alphaPath, alphaTurns.indexOf(TELEGRAM) + 1));
  assert.ok(candidate, "the owner's telegram message was refused");
  assert.ok(!candidate.quote.includes("[braid-whisper"), `quote carries the envelope: ${candidate.quote}`);
  assert.ok(candidate.quote.toLowerCase().includes("browser session"), candidate.quote);
});

// -- (h): the checks are load-bearing -------------------------------------
test("a planted permissive classifier reddens every negative, and still parses", async () => {
  const mutantPath = join(SANDBOX, "mutant-classifier.mjs");
  const real = pathToFileURL(join(DIST, "lib", "memory", "decision-extraction.js")).href;
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
  const reddened = negativeChecks(mutant).filter((check) => check.verdict !== null);
  for (const { name } of negativeChecks(classifyOwnerRuling)) {
    assert.ok(
      reddened.some((check) => check.name === name),
      `mutant did not redden the "${name}" assertion, so that assertion is not load-bearing`,
    );
  }
});

// -- (f) and (g): the CLI --------------------------------------------------
function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, "--index", INDEX, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: SANDBOX, BRAID_HOME: join(SANDBOX, "braid") },
  });
  assert.equal(result.status, 0, `cli failed (${args.join(" ")}): ${result.stderr}`);
  return result.stdout;
}

const STORE = join(SANDBOX, "braid", "memory", "semantic.json");
const readStore = () =>
  existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")).memories : [];

test("dry-run is a census and writes nothing", () => {
  const census = JSON.parse(runCli("--json"));
  assert.equal(census.mode, "dry-run");
  assert.equal(census.totals.turns, alphaTurns.length + 1);
  assert.ok(census.totals.candidates >= 5, `candidates: ${census.totals.candidates}`);
  assert.equal(census.totals.kept, census.totals.survivors - census.totals.duplicates);
  assert.equal(census.store.before, 0);
  assert.equal(census.store.written, 0);
  assert.equal(existsSync(STORE), false, "dry-run wrote the store");
});

test("--write lands the survivors, and a second --write adds zero", () => {
  const first = JSON.parse(runCli("--write", "--json"));
  const written = readStore();
  assert.equal(written.length, first.store.written);
  assert.ok(written.length >= 5, `wrote ${written.length}`);
  for (const entry of written) {
    assert.equal(entry.type, "preference");
    assert.equal(entry.tags[0], "owner-ruling");
    assert.match(entry.source, /^owner ruling: \//);
    assert.equal(entry.projectId, undefined, "a scoped entry is invisible to another project's recall");
    assert.ok(entry.utility > 0 && entry.utility <= 1);
  }
  assert.ok(first.store.backup, "a write without a backup is not reversible");
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

// -- Cleanup ---------------------------------------------------------------
after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});
