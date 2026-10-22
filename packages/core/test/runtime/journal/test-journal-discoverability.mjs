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
 * Run: node test/runtime/journal/test-journal-discoverability.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const { getState } = await import(
  new URL("../../../dist/extensions/enforcement/state.js", import.meta.url).href
);
const { _resetForTests: resetWhisperTurn } = await import(
  new URL("../../../dist/lib/enforcement/turn-dedup.js", import.meta.url).href
);
const { setActiveSessionId } = await import(
  new URL("../../../dist/lib/utils/injection-tracker.js", import.meta.url).href
);

console.log("journal discoverability test\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (err) {
    console.log(` [x] ${name}: ${err.message}`);
    failed++;
  }
}

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
  // the second. One process, three synthetic sessions: say which one is live.
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

async function runHandler(branch) {
  // Three synthetic session starts share one process, and the whisper layer
  // caps deliveries per turn: without a boundary each case would spend the
  // previous case's budget. In a real run, a session start is its own turn.
  resetWhisperTurn();
  const pi = makeFakePi();
  registerSessionStartDiscoverability(pi);
  const ctx = makeFakeCtx(PROJECT, branch);
  const handler = (pi.handlers.get("session_start") ?? [])[0];
  assert.ok(handler, "the discoverability handler must be registered");
  await handler({ type: "session_start" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return pi.sent.map((entry) => JSON.stringify(entry.params ?? "")).join("\n");
}

const SLUG = projectSlugFromCwd(PROJECT);
const JOURNAL = paths.journalFilePath(SLUG);

/** Append one honest entry through the real writer, so the pointer's count and
 *  path are the writer's, not the fixture's. Each case adds a line: an
 *  identical bundle would be fingerprinted by the whisper layer's own dedupe
 *  and the case would pass for the wrong reason. */
let entries = 0;
function appendEntry(text) {
  const written = spawnSync(process.execPath, [APPEND, "--cwd", PROJECT, "--project", SLUG], {
    input: JSON.stringify({
      kind: "intent",
      subject: "journal",
      status: "open",
      text,
      evidence: [],
      unverified: true,
    }),
    env: { ...process.env, PI_SESSION_FILE: "", PI_SESSION_ID: "journal-disc-seat" },
    encoding: "utf8",
  });
  assert.equal(written.status, 0, `writer must accept the fixture entry: ${written.stderr}`);
  entries++;
}

appendEntry("A replacement seat on this project reads this pointer before it acts on the program.");

function pointerPattern() {
  const escaped = JOURNAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`The project journal holds ${entries} entr(?:y|ies) at ${escaped}`);
}

await test("the pointer names the exact file the writer appended to", async () => {
  const whisper = await runHandler([]);
  assert.match(whisper, pointerPattern(), whisper.slice(0, 600));
});

await test("a journal_prior mark on the active branch does not suppress the pointer", async () => {
  appendEntry("A second entry changes the announcement, so a duplicate-bundle dedupe cannot fake this case.");
  const whisper = await runHandler([shownMarker(SLUG, "journal_prior"), shownMarker(SLUG, "tags_prior")]);
  assert.match(whisper, pointerPattern(), whisper.slice(0, 600));
});

await test("the control: the same seeded branch suppresses a non-exempt signal", async () => {
  const tagsFile = join(process.env.BRAID_HOME, "tags", `${paths.tagsSlugFromCwd(PROJECT)}.json`);
  mkdirSync(dirname(tagsFile), { recursive: true });
  writeFileSync(tagsFile, JSON.stringify({ "control-tag": { turn: 1 } }));
  appendEntry("A third entry keeps the control's bundle distinct from the case above it.");
  const whisper = await runHandler([shownMarker(SLUG, "journal_prior"), shownMarker(SLUG, "tags_prior")]);
  assert.doesNotMatch(
    whisper,
    /Cross-session tags available/,
    "a non-exempt signal already marked on this branch must stay suppressed",
  );
  assert.match(whisper, pointerPattern(), whisper.slice(0, 600));
});

console.log(`\n Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
