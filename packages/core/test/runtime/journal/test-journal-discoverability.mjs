/**
 * The session-start journal pointer, and the dedupe exemption it needs.
 *
 * A journal that no replacement seat is told about is a diary. So the
 * discoverability handler names the journal file and the digest command, and
 * it must do so on a seat that has NEVER seen this project -- which is the
 * opposite of what the per-project dedupe is for. The dedupe (and the branch
 * entries it writes) exists so a resumed session is not re-told; a mark left
 * by an earlier seat is exactly the one-shot failure the pointer repairs.
 *
 * Case 1 pairs the writer with the pointer: the path in the whisper is the
 * file the writer actually appended to, both derived from the one constant, so
 * a second spelling of the journal path fails here first.
 *
 * Case 2 seeds the active branch with a `journal_prior` mark -- the suppression
 * source the handler consults today -- and requires the pointer anyway.
 *
 * Case 3 is the control, and without it case 2 proves nothing: the same seeded
 * branch suppresses a non-exempt signal (the cross-session tags pointer). If
 * the seeding were broken, case 3 would fail instead of case 2 passing
 * vacuously.
 *
 * The rest cover what the pointer says about work still open. A journal holding
 * a pending install used to print the same count sentence as one holding forty
 * closed outcomes, so the pointer now names the intents whose status says open,
 * calls an expired one EXPIRED, and keeps the whole text under a fixed ceiling.
 * The assertions are equality on the whole pointer, never a substring of it: a
 * substring of the old sentence would pass on a pointer that says nothing about
 * what is waiting.
 *
 * Those cases write their journal lines by hand, which proves the reader and
 * nothing about the writer. One case near the end drives the real writer and
 * reads its line back through the same function the signal calls, so the shape
 * the writer emits is the shape the pointer parses, and the EXPIRED branch is
 * reached the only way it can be now: a stamp that was ahead at write time and
 * has since passed.
 *
 * Run: node --test test/runtime/journal/test-journal-discoverability.mjs
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..", "..", "..");
const APPEND = join(PKG, "scripts", "journal-append.mjs");

// Isolation before any dist import: HOME, BRAID_HOME and pi's agent dir are
// throwaway, so this fixture cannot read or write a live seat's state.
process.env.HOME = mkdtempSync(join(tmpdir(), "journal-disc-home-"));
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "journal-disc-braid-"));
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "journal-disc-agent-"));
const PROJECT = mkdtempSync(join(tmpdir(), "journal-disc-proj-"));

const paths = await import(
  new URL("../../../dist/lib/config/braid-paths.js", import.meta.url).href
);
const { projectSlugFromCwd } = await import(
  new URL(
    "../../../dist/extensions/memory/scratchpad/persistence.js",
    import.meta.url,
  ).href
);
const { SHOWN_SIGNAL_ENTRY_TYPE } = await import(
  new URL("../../../dist/lib/state/global-state.js", import.meta.url).href
);
const { registerSessionStartDiscoverability } = await import(
  new URL(
    "../../../dist/extensions/enforcement/handlers/register-session-start-discoverability.js",
    import.meta.url,
  ).href
);
const { JOURNAL_PRIOR_BUDGET, journalPriorText } = await import(
  new URL(
    "../../../dist/extensions/enforcement/handlers/open-intents.js",
    import.meta.url,
  ).href
);
const { getState } = await import(
  new URL("../../../dist/extensions/enforcement/state.js", import.meta.url).href
);
const { _resetForTests: resetWhisperTurn } = await import(
  new URL("../../../dist/lib/enforcement/turn-dedup.js", import.meta.url).href
);
const { setActiveSessionId } = await import(
  new URL("../../../dist/lib/utils/injection-tracker.js", import.meta.url).href
);

// ── The sentence the pointer has always printed ────────────────────────────
//
// Spelled out here rather than imported: the closing words are the thing
// requirement "nothing open means nothing new" protects, and a test that
// imported them would move with the code it is meant to hold still. The two
// data slots (count, path) are the fixture's, the words are not.

const DIGEST_SENTENCE =
  "Read the open program before acting (digest printer: packages/core/scripts/check-journal.mjs --digest), " +
  "so a decision gets superseded, not rediscovered.";
const DIGEST_SENTENCE_SHORT = "Full program: packages/core/scripts/check-journal.mjs --digest.";
const CLOSE_SINGLE = "Run the install it names, or close it with the reason it will not run.";
const CLOSE_PLURAL = "Run the install each names, or close it with the reason it will not run.";

function introFor(count, journalFile) {
  return (
    `The project journal holds ${count} entr${count === 1 ? "y" : "ies"} at ${journalFile} -- ` +
    "what earlier seats decided and why, readable without their sessions."
  );
}

function todayFor(count, journalFile) {
  return `${introFor(count, journalFile)} ${DIGEST_SENTENCE}`;
}

// ── Harness ────────────────────────────────────────────────────────────────

function makeFakePi() {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    appendEntry() {},
    getAllTools: () => [],
  };
}

function makeFakeCtx(cwd, branch) {
  const sessionId = `journaldisc-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    __sessionId: sessionId,
    cwd,
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(tmpdir(), `${sessionId}.jsonl`),
      getBranch: () => branch,
    },
    modelRegistry: {
      find: () => undefined,
      getAll: () => [],
      getApiKeyForProvider: async () => "",
      getAvailable: () => [],
    },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  // Real session starts set this pointer; without it every case shares the
  // injection tracker's "default" bucket, whose body de-bloat collapses
  // standalone digits and would hold the third announcement as a re-prime of
  // the second. One process, many synthetic sessions: say which one is live.
  setActiveSessionId(sessionId);
  getState(ctx);
  return ctx;
}

function shownMarker(slug, type) {
  return {
    type: "custom",
    customType: SHOWN_SIGNAL_ENTRY_TYPE,
    data: { slug, type, timestamp: 1 },
  };
}

/** The journal pointer out of a delivered bundle: signals are joined one per
 *  line, so the line the intro opens is the pointer whole. */
function pointerIn(pi) {
  const delivered = pi.sent.flatMap((entry) =>
    (entry.params?.content ?? []).map((part) => part.text ?? ""),
  );
  const lines = delivered.join("\n").split("\n");
  return lines.find((line) => line.startsWith("The project journal holds")) ?? null;
}

async function runHandler({ project = PROJECT, branch = [] } = {}) {
  // Synthetic session starts share one process, and the whisper layer caps
  // deliveries per turn: without a boundary each case would spend the previous
  // case's budget. In a real run, a session start is its own turn.
  resetWhisperTurn();
  const pi = makeFakePi();
  registerSessionStartDiscoverability(pi);
  const ctx = makeFakeCtx(project, branch);
  const handler = (pi.handlers.get("session_start") ?? [])[0];
  assert.ok(handler, "the discoverability handler must be registered");
  await handler({ type: "session_start" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    bundle: pi.sent.map((entry) => JSON.stringify(entry.params ?? "")).join("\n"),
    pointer: pointerIn(pi),
  };
}

const SLUG = projectSlugFromCwd(PROJECT);
const JOURNAL = paths.journalFilePath(SLUG);

/** Append one entry through the real writer, so the pointer's count and path
 *  are the writer's, not the fixture's. */
function appendThroughWriter(project, slug, payload) {
  const written = spawnSync(process.execPath, [APPEND, "--cwd", project, "--project", slug], {
    input: JSON.stringify({ evidence: [], unverified: true, ...payload }),
    env: { ...process.env, PI_SESSION_FILE: "", PI_SESSION_ID: "journal-disc-seat" },
    encoding: "utf8",
  });
  assert.equal(written.status, 0, `writer must accept the fixture entry: ${written.stderr}`);
}

/** Each case adds a line to the shared project: an identical bundle would be
 *  fingerprinted by the whisper layer's own dedupe and the case would pass for
 *  the wrong reason. */
let entries = 0;
function appendEntry(text) {
  appendThroughWriter(PROJECT, SLUG, {
    kind: "intent",
    subject: "journal",
    status: "open",
    text,
  });
  entries++;
}

// ── Journals for the open-intent cases ─────────────────────────────────────
//
// These fixtures write the lines themselves instead of going through the
// writer. A stamp already past is refused at write time, so an expired intent
// is a line the writer cannot produce in one go: it gets there by ageing, or by
// a hand edit, and the reader must survive both -- a journal is edited by hand,
// and the seat that inherits the edit is the one that needs the pointer. The
// roots are short on purpose -- the path is charged against the pointer's
// ceiling, and a fixture that spends most of the budget on its own temp
// directory would pin a number no live seat ever sees.

const HOUR = 3_600_000;
const FIXED_NOW = 1_800_000_000_000;
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot() {
  const root = mkdtempSync("/tmp/journal-pointer-");
  roots.push(root);
  const home = join(root, "braid");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { home, project };
}

/** Swap the state root for the duration of the work and put it back after.
 *  The callback is awaited: the handler resolves the journal path on every
 *  call, so a restore that ran when the promise was created would hand it back
 *  the previous root and the fixture would read a file it never seeded. */
async function withBraidHome(home, run) {
  const previous = process.env.BRAID_HOME;
  process.env.BRAID_HOME = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.BRAID_HOME;
    else process.env.BRAID_HOME = previous;
  }
}

/** Write the journal lines for a case and return the file the handler reads.
 *  The path comes from the same constant the writer uses, never a hand-built
 *  shape: a second spelling would let this fixture pass against a file the
 *  handler never opens. */
function seedJournal(home, project, lines) {
  return withBraidHome(home, () => {
    const file = paths.journalFilePath(projectSlugFromCwd(project));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
    return file;
  });
}
const hoursAgo = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const hoursAhead = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

function intentLine({ subject, ageHours, expiresAt, seq = 1 }) {
  return JSON.stringify({
    seq,
    at: hoursAgo(ageHours),
    kind: "intent",
    subject,
    status: "open",
    text: `A pending install that a seat must run or close, keyed ${subject}.`,
    evidence: [],
    seat: null,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  });
}

function outcomeLine() {
  return JSON.stringify({
    seq: 90,
    at: hoursAgo(1),
    kind: "outcome",
    subject: "closed-install",
    text: "An install that ran to completion and must not be named as waiting.",
    evidence: [],
    seat: null,
  });
}

/** Run the handler against a seeded journal and return the pointer it emits. */
async function pointerFor(lines) {
  const { home, project } = newRoot();
  const file = await seedJournal(home, project, lines);
  const result = await withBraidHome(home, () => runHandler({ project }));
  assert.ok(result.pointer, `no journal pointer in the emitted bundle: ${result.bundle}`);
  return { pointer: result.pointer, file };
}

// ── The pointer and its dedupe exemption ───────────────────────────────────

appendEntry("A replacement seat on this project reads this pointer before it acts on the program.");

function pointerPattern() {
  const escaped = JOURNAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`The project journal holds ${entries} entr(?:y|ies) at ${escaped}`);
}

test("the pointer names the exact file the writer appended to", async () => {
  const { bundle } = await runHandler();
  assert.match(bundle, pointerPattern(), bundle.slice(0, 600));
});

test("a journal_prior mark on the active branch does not suppress the pointer", async () => {
  appendEntry("A second entry changes the announcement, so a duplicate-bundle dedupe cannot fake this case.");
  const { bundle } = await runHandler({
    branch: [shownMarker(SLUG, "journal_prior"), shownMarker(SLUG, "tags_prior")],
  });
  assert.match(bundle, pointerPattern(), bundle.slice(0, 600));
});

test("the control: the same seeded branch suppresses a non-exempt signal", async () => {
  const tagsFile = join(process.env.BRAID_HOME, "tags", `${paths.tagsSlugFromCwd(PROJECT)}.json`);
  mkdirSync(dirname(tagsFile), { recursive: true });
  writeFileSync(tagsFile, JSON.stringify({ "control-tag": { turn: 1 } }));
  appendEntry("A third entry keeps the control's bundle distinct from the case above it.");
  const { bundle } = await runHandler({
    branch: [shownMarker(SLUG, "journal_prior"), shownMarker(SLUG, "tags_prior")],
  });
  assert.doesNotMatch(
    bundle,
    /Cross-session tags available/,
    "a non-exempt signal already marked on this branch must stay suppressed",
  );
  assert.match(bundle, pointerPattern(), bundle.slice(0, 600));
});

// ── What the pointer says about work still open ────────────────────────────

test("nothing open: the pointer is the sentence it has always printed", async () => {
  const { pointer, file } = await pointerFor([outcomeLine()]);
  assert.equal(pointer, todayFor(1, file));
});

test("an open intent is named with its subject and age, and a closed entry is not", async () => {
  const { pointer, file } = await pointerFor([
    outcomeLine(),
    intentLine({ subject: "newspaper-install", ageHours: 5, seq: 2 }),
    intentLine({ subject: "docs-pass", ageHours: 3, seq: 3 }),
  ]);
  assert.equal(
    pointer,
    `${introFor(3, file)} ` +
      'Open intents: "newspaper-install" 5h old; "docs-pass" 3h old. ' +
      `${CLOSE_PLURAL} ${DIGEST_SENTENCE_SHORT}`,
  );
  assert.doesNotMatch(pointer, /closed-install/);
});

test("an intent whose window closed reads as EXPIRED, with its age and the moment", async () => {
  const expiresAt = hoursAgo(2);
  const { pointer, file } = await pointerFor([
    outcomeLine(),
    intentLine({ subject: "newspaper-install", ageHours: 5, expiresAt, seq: 2 }),
  ]);
  assert.equal(
    pointer,
    `${introFor(2, file)} ` +
      `One intent is still open and EXPIRED: "newspaper-install" 5h old (expires_at ${expiresAt}). ` +
      `${CLOSE_SINGLE} ${DIGEST_SENTENCE_SHORT}`,
  );
});

test("a live deadline is carried as well, without the EXPIRED word", async () => {
  const expiresAt = hoursAhead(3);
  const { pointer, file } = await pointerFor([
    intentLine({ subject: "newspaper-install", ageHours: 5, expiresAt }),
  ]);
  assert.equal(
    pointer,
    `${introFor(1, file)} ` +
      `One intent is still open: "newspaper-install" 5h old (expires ${expiresAt}). ` +
      `${CLOSE_SINGLE} ${DIGEST_SENTENCE_SHORT}`,
  );
});

test("four open intents: three named, the rest counted, under the ceiling", async () => {
  const { pointer, file } = await pointerFor([
    intentLine({ subject: "newspaper-install", ageHours: 5 }),
    intentLine({ subject: "docs-pass", ageHours: 3, seq: 2 }),
    intentLine({ subject: "journal-pointer", ageHours: 1, seq: 3 }),
    intentLine({ subject: "fourth-install", ageHours: 9, seq: 4 }),
  ]);
  assert.equal(
    pointer,
    `${introFor(4, file)} ` +
      'Open intents: "newspaper-install" 5h old; "docs-pass" 3h old; "journal-pointer" 1h old; ' +
      `+1 more open. ${CLOSE_PLURAL} ${DIGEST_SENTENCE_SHORT}`,
  );
  assert.ok(
    pointer.length < JOURNAL_PRIOR_BUDGET,
    `the pointer must stay under ${JOURNAL_PRIOR_BUDGET} characters, was ${pointer.length}`,
  );
});

test("an expired intent is named even when three fresher ones came first", async () => {
  const expiresAt = hoursAgo(4);
  const { pointer } = await pointerFor([
    intentLine({ subject: "newspaper-install", ageHours: 1 }),
    intentLine({ subject: "docs-pass", ageHours: 2, seq: 2 }),
    intentLine({ subject: "journal-pointer", ageHours: 3, seq: 3 }),
    intentLine({ subject: "stale-install", ageHours: 9, expiresAt, seq: 4 }),
  ]);
  assert.match(pointer, /"stale-install" 9h old, EXPIRED/);
});

test("a malformed line and an unusable stamp neither throw nor hide the intent", async () => {
  const { pointer, file } = await pointerFor([
    "{not json at all",
    JSON.stringify({ seq: 2, kind: undefined, subject: "kindless" }),
    outcomeLine(),
    intentLine({ subject: "broken-stamp", ageHours: 4, expiresAt: "not a timestamp", seq: 4 }),
  ]);
  // The count is the line count the pointer has always printed, malformed line
  // included: that is the reader's existing contract, not this change's.
  assert.equal(
    pointer,
    `${introFor(4, file)} ` +
      'One intent is still open: "broken-stamp" 4h old. ' +
      `${CLOSE_SINGLE} ${DIGEST_SENTENCE_SHORT}`,
  );
});

test("a journal path that spends the ceiling yields a leaner sentence, never a longer one", async () => {
  // A temp root this deep can leave the named list without room; whichever rung
  // it lands on, the pointer says less rather than crossing the ceiling.
  const home = mkdtempSync(join(tmpdir(), "journal-pointer-long-"));
  roots.push(home);
  const project = mkdtempSync(join(tmpdir(), "journal-pointer-long-"));
  roots.push(project);
  await seedJournal(home, project, [
    intentLine({ subject: "newspaper-install", ageHours: 5 }),
    intentLine({ subject: "docs-pass", ageHours: 3, seq: 2 }),
    intentLine({ subject: "journal-pointer", ageHours: 1, seq: 3 }),
    intentLine({ subject: "fourth-install", ageHours: 9, seq: 4 }),
  ]);
  const result = await withBraidHome(home, () => runHandler({ project }));
  assert.ok(result.pointer, `no journal pointer in the emitted bundle: ${result.bundle}`);
  assert.ok(
    result.pointer.length < JOURNAL_PRIOR_BUDGET,
    `the pointer must stay under ${JOURNAL_PRIOR_BUDGET} characters, was ${result.pointer.length}`,
  );
  // Which rung this lands on follows the temp root the runner hands the file,
  // so the guarantee is the invariant, not the rung: never longer than the
  // ceiling, and never silent about the work that is waiting. The rungs
  // themselves are pinned exactly in the cheap case below, where the path is
  // the fixture's own.
  assert.match(result.pointer, /open intent/i, result.pointer);
});

// ── The writer's line, read back by the pointer ────────────────────────────
//
// One window, read twice: while the stamp is ahead the pointer prints it, and
// once the clock passes it the same line reads EXPIRED. Both readings come from
// `journalPriorText`, the function the session-start handler calls, over the
// file the writer actually appended to -- so a writer that stopped emitting the
// field, or a pointer that stopped parsing it, reddens here rather than on a
// live journal.

test("an intent the writer accepted reads back with its expiry, then as EXPIRED", async () => {
  const { home, project } = newRoot();
  const expiresAt = new Date(Date.now() + 2 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
  const file = await withBraidHome(home, () => {
    appendThroughWriter(project, projectSlugFromCwd(project), {
      kind: "intent",
      subject: "writer-handoff",
      status: "open",
      text: "A pending install the writer accepted together with the moment its window closes.",
      expires_at: expiresAt,
    });
    return paths.journalFilePath(projectSlugFromCwd(project));
  });

  const journal = readFileSync(file, "utf8");
  const written = JSON.parse(journal.trim());
  assert.equal(written.expires_at, expiresAt, "the writer must land the field on the line");
  const facts = { count: 1, journalFile: file };
  // Offsets measured from the line's own `at`, so the two readings are decided
  // by the stamps and not by how long the fixture took to run.
  const sinceWritten = (minutes) => new Date(Date.parse(written.at) + minutes * 60_000);

  const live = journalPriorText(facts, journal, sinceWritten(90));
  assert.ok(
    live.includes(`(expires ${expiresAt})`),
    `the live stamp must be printed: ${live}`,
  );
  assert.doesNotMatch(live, /EXPIRED/, live);

  const lapsed = journalPriorText(facts, journal, sinceWritten(180));
  assert.match(
    lapsed,
    new RegExp(`One intent is still open and EXPIRED: "writer-handoff" 3h old \\(expires_at ${expiresAt}\\)`),
    lapsed,
  );
});

// ── The ceiling, pinned ────────────────────────────────────────────────────
//
// The handler's ceiling is only as good as a number a reader can check, and a
// fixture whose path changes between runs cannot pin one. These cases spend a
// fixed path each and state the exact length, so a change that spends more of
// the ceiling shows up as a number. Three paths, three rungs: a short one that
// carries names and the standing pointer, a long one that keeps the names and
// gives up the pointer, and one long enough that only the count survives.

test("the pointer's cost at each rung is a number this test can name", () => {
  const at = (hours) => new Date(FIXED_NOW - hours * HOUR).toISOString();
  const line = (subject, ageHours, seq) =>
    JSON.stringify({
      seq,
      at: at(ageHours),
      kind: "intent",
      subject,
      status: "open",
      text: `A pending install that a seat must run or close, keyed ${subject}.`,
      evidence: [],
      seat: null,
    });
  const journal = [
    line("newspaper-install", 5, 1),
    line("docs-pass", 3, 2),
    line("journal-pointer", 1, 3),
    line("fourth-install", 9, 4),
  ].join("\n");
  const cost = (journalFile) =>
    journalPriorText({ count: 4, journalFile }, journal, new Date(FIXED_NOW));

  const shortPath = "/tmp/journal-pointer-fixture/journal/--fixture--/journal.jsonl";
  const longPath = `/tmp/${"journal-pointer-fixture-root/".repeat(5)}journal/--fixture--/journal.jsonl`;
  const vastPath = `/tmp/${"journal-pointer-fixture-root/".repeat(9)}journal/--fixture--/journal.jsonl`;

  const short = cost(shortPath);
  assert.equal(short.length, 412);
  assert.match(short, /"newspaper-install" 5h old; "docs-pass" 3h old; "journal-pointer" 1h old; \+1 more open/);
  assert.match(short, /Full program: packages\/core\/scripts\/check-journal\.mjs --digest\.$/);

  const long = cost(longPath);
  assert.equal(long.length, 469);
  assert.match(long, /"newspaper-install" 5h old/);
  assert.doesNotMatch(long, /Full program:/);

  const vast = cost(vastPath);
  assert.equal(vast.length, 426);
  assert.match(vast, /4 open intents\.$/);
  assert.doesNotMatch(vast, /newspaper-install/);

  for (const text of [short, long, vast]) assert.ok(text.length < JOURNAL_PRIOR_BUDGET);
});
