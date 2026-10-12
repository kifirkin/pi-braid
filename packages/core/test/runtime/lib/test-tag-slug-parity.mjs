/**
 * Tag files: one slug rule for the writer and the readers.
 *
 * The tag writer keyed its file by `cwd.split("/").filter(Boolean).join("-")`
 * while the session-start discoverability reader looked for the scratchpad /
 * sessions slug (`--cwd-with-dashes--`): the reader read a name the writer
 * never wrote, so the `tags_prior` signal could never fire. The rule now lives
 * in one place (`tagsSlugFromCwd`) and this case pins the end-to-end pair:
 * write a tag through the tool_call handler, then run the session_start
 * handler and require the whisper that only a found file produces. Reverting
 * either side to a spelling of its own breaks it.
 *
 * Isolation: HOME, BRAID_HOME and pi's agent dir are throwaway temp dirs set
 * before any dist import, and the project the session runs in is one too.
 *
 * Run: node test/runtime/lib/test-tag-slug-parity.mjs
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Isolation, before any dist import ──────────────────────────────────────
process.env.HOME = mkdtempSync(join(tmpdir(), "tag-slug-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "tag-slug-braid-"));
process.env.BRAID_HOME = BRAID_HOME;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "tag-slug-agent-"));
const PROJECT = mkdtempSync(join(tmpdir(), "tag-slug-proj-"));

const paths = await import(join(ROOT, "dist", "lib", "config", "braid-paths.js"));
const { registerToolCallHandler } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "register-tool-call.js")
);
const { registerSessionStartDiscoverability } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "register-session-start-discoverability.js")
);
const { getState } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "state.js")
);

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

function makeFakeCtx(pi, cwd) {
  const sessionId = `tagslug-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    __sessionId: sessionId,
    cwd,
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(tmpdir(), `${sessionId}.jsonl`),
      getBranch: () => [],
    },
    modelRegistry: {
      find: () => undefined,
      getAll: () => [],
      getApiKeyForProvider: async () => "",
      getAvailable: () => [],
    },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  getState(ctx);
  return ctx;
}

function firstHandler(pi, event) {
  const list = pi.handlers.get(event) ?? [];
  assert.ok(list.length > 0, `${event} handler must be registered`);
  return list[0];
}

console.log("tag slug parity test\n");

const pi = makeFakePi();
registerToolCallHandler(pi);
registerSessionStartDiscoverability(pi);
const ctx = makeFakeCtx(pi, PROJECT);

// The writer: a context_navigate tag, exactly as the tool_call handler sees it.
await firstHandler(pi, "tool_call")(
  { toolName: "context_navigate", input: { action: "tag", name: "parity-tag" } },
  ctx,
);

const tagFile = join(BRAID_HOME, "tags", `${paths.tagsSlugFromCwd(PROJECT)}.json`);
assert.ok(
  existsSync(tagFile),
  `the tag writer must key the file the readers look for: ${tagFile}`,
);
assert.deepEqual(
  Object.keys(JSON.parse(readFileSync(tagFile, "utf-8"))),
  ["parity-tag"],
  "the written tag must be readable back from that file",
);

// The reader: the session_start handler must find that same file and emit the
// tags_prior signal (the whisper is the only observable it produces).
await firstHandler(pi, "session_start")({ type: "session_start" }, ctx);
await new Promise((r) => setTimeout(r, 400));
const whispers = pi.sent.map((s) => JSON.stringify(s.params ?? "")).join("\n");
assert.match(
  whispers,
  /Cross-session tags available: parity-tag/,
  `the discoverability reader must find the writer's tag file: ${whispers.slice(0, 400)}`,
);

console.log("  [ok] the tag writer's file is the file the discoverability reader reads");
console.log("\n📊 Results: 1 passed, 0 failed");
