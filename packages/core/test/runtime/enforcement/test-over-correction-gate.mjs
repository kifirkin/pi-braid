/**
 * Over-correction gate tests — accusation-triggered irreversible-action gate.
 *
 * Contract pinned here:
 *   (a) destructive matcher: every pattern in the shipped set matches; branch
 *       navigation and benign calls do not; rm/write repo resolution matches
 *       tracked and manifest files only;
 *   (b) accusation matcher: EN + RU accusation shapes match; neutral text
 *       does not; machine whispers are never inbound accusations;
 *   (c) owner-confirmation matcher: strict EN/RU shapes match; questions and
 *       negations do not;
 *   (d) modes: off → no whisper, no block; shadow → whisper emitted, never
 *       blocked; on + accusation + destructive → blocked with a reason that
 *       names the missing evidence and both exits;
 *   (e) controls: on + destructive without arming → not blocked; on + armed +
 *       benign → not blocked; branch navigation → not blocked;
 *   (f) lift: a strict owner confirmation in a NEWER user message lifts the
 *       block; a first-message confirmation does not;
 *   (g) acceptance path: a hot signal arms without an accusation; stale and
 *       cross-session signals do not;
 *   (h) fail-open: an injected transcript error returns not-blocked.
 *
 * Settings and the braid home are pinned into temp dirs before dist modules
 * load, so the owner's live settings.json and manifests are never read.
 *
 * Run: node test/runtime/enforcement/test-over-correction-gate.mjs
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Isolation: temp agent dir (settings) + temp braid home (manifest) ──────
const agentDir = mkdtempSync(join(tmpdir(), "oc-gate-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "oc-gate-braid-"));
const settingsPath = join(agentDir, "settings.json");

// ── Dist imports ────────────────────────────────────────────────────────────
const { registerToolCallHandler } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "register-tool-call.js")
);
const { getState } = await import(join(ROOT, "dist", "extensions", "enforcement", "state.js"));
const { _resetForTests } = await import(join(ROOT, "dist", "lib", "enforcement", "turn-dedup.js"));
const { clearAllBuckets } = await import(
  join(ROOT, "dist", "lib", "utils", "injection-tracker.js")
);
const { setAcceptanceSignal } = await import(join(ROOT, "dist", "lib", "state", "global-state.js"));
const { getDeliverablesFilePath } = await import(
  join(ROOT, "dist", "lib", "config", "braid-paths.js")
);

// Loaded lazily so a base checkout (no gate wiring) still reaches the wiring
// assertions instead of dying at import time.
let gate = null;
try {
  gate = await import(
    join(ROOT, "dist", "extensions", "enforcement", "handlers", "over-correction-gate.js")
  );
} catch {
  gate = null;
}

// ── Fixture repo: one tracked file, one untracked file ──────────────────────
const repo = mkdtempSync(join(tmpdir(), "oc-gate-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
writeFileSync(join(repo, "tracked.txt"), "tracked content\n");
execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
writeFileSync(join(repo, "untracked.txt"), "untracked content\n");
writeFileSync(join(repo, "deliverable.txt"), "deliverable content\n");
// Manifest leg: a completed-task record naming deliverable.txt.
const manifestPath = getDeliverablesFilePath(repo);
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(
  manifestPath,
  JSON.stringify({
    ts: new Date().toISOString(),
    session: repo,
    summary: "fixture",
    completed: true,
    files: [{ path: "deliverable.txt" }],
  }) + "\n",
);

// ── Harness ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  [fail] ${name}: ${e.message}`);
    });
}

function setMode(mode) {
  writeFileSync(settingsPath, JSON.stringify(mode === null ? {} : { braid: { enforcement: { overCorrectionGate: { mode } } } }));
}

function resetRuntime() {
  _resetForTests();
  clearAllBuckets();
  setAcceptanceSignal(null);
}

function makeFakePi() {
  const sent = [];
  return {
    sent,
    handlers: new Map(),
    on(event, handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
  };
}

let seq = 0;
function entryUser(text, ts) {
  return {
    type: "message",
    id: `u${++seq}`,
    parentId: null,
    timestamp: ts,
    message: { role: "user", content: text },
  };
}
function entryAssistant(text, ts) {
  return {
    type: "message",
    id: `a${++seq}`,
    parentId: null,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}
function entryCustom(text, ts, customType = "peer") {
  return {
    type: "custom_message",
    id: `c${++seq}`,
    parentId: null,
    timestamp: ts,
    customType,
    content: [{ type: "text", text }],
    display: true,
  };
}
function entryWhisper(text, ts) {
  return entryCustom(
    `[braid-whisper - enforcement @ 12:00 MSK]\n${text}\n[braid-whisper-end]`,
    ts,
    "enforcement",
  );
}

// Fixed epoch base for relative fixture timestamps (no calendar literal).
const T0 = 1_700_000_000_000;
function ts(offsetSec) {
  return new Date(T0 + offsetSec * 1000).toISOString();
}

function makeFakeCtx(entries = [], cwd = process.cwd()) {
  const sessionId = "oc-gate-" + Math.random().toString(36).slice(2, 8);
  const ctx = {
    __sessionId: sessionId,
    cwd,
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getBranch: () => entries,
    },
    modelRegistry: {
      find: () => undefined,
      getAll: () => [],
      getApiKeyForProvider: async () => "",
      getAvailable: () => [],
    },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  getState(ctx); // enforcementActive defaults true
  return ctx;
}

function toolCallHandler(pi) {
  registerToolCallHandler(pi);
  const list = pi.handlers.get("tool_call") ?? [];
  assert.ok(list.length > 0, "tool_call handler must be registered");
  return list[0];
}

const RESET_DESTRUCTIVE = { command: "git reset --hard HEAD~1" };
const ACCUSATION_EN = "Your change broke the production deploy. Please revert your changes.";
const ACCUSATION_RU = "Из-за твоих изменений сломался прод, откати свои изменения.";

console.log("over-correction gate tests\n");

// ═══════════════════════════════════════════════════════════════════════
// [1] Destructive matcher
// ═══════════════════════════════════════════════════════════════════════

console.log("[1] destructive matcher");

await test("git reset --hard matches (incl. compound commands)", () => {
  assert.ok(gate, "over-correction-gate module must load");
  assert.equal(gate.matchDestructiveBash("git reset --hard")?.label, "git reset --hard");
  assert.ok(gate.matchDestructiveBash("cd /repo && git reset --hard HEAD~1"));
});

await test("git checkout path-restoring forms match", () => {
  assert.ok(gate.matchDestructiveBash("git checkout -- src/a.ts"));
  assert.ok(gate.matchDestructiveBash("git checkout main -- src/a.ts"));
});

await test("git restore / revert / branch -D / clean -f match", () => {
  assert.ok(gate.matchDestructiveBash("git restore src/a.ts"));
  assert.ok(gate.matchDestructiveBash("git revert HEAD"));
  assert.ok(gate.matchDestructiveBash("git branch -D feature/x"));
  assert.ok(gate.matchDestructiveBash("git clean -fd"));
});

await test("branch navigation and benign git calls do not match", () => {
  assert.equal(gate.matchDestructiveBash("git checkout main"), null);
  assert.equal(gate.matchDestructiveBash("git checkout -b feature/x"), null);
  assert.equal(gate.matchDestructiveBash("git reset --soft HEAD~1"), null);
  assert.equal(gate.matchDestructiveBash("git branch -d merged"), null);
  assert.equal(gate.matchDestructiveBash("git clean -n"), null);
  assert.equal(gate.matchDestructiveBash("git status"), null);
  assert.equal(gate.matchDestructiveBash("ls -la"), null);
});

await test("rm of a tracked file matches; untracked and globs do not", () => {
  assert.ok(gate.matchDestructiveBash("rm tracked.txt", repo));
  assert.equal(gate.matchDestructiveBash("rm untracked.txt", repo), null);
  assert.equal(gate.matchDestructiveBash('rm "*.ts"', repo), null);
});

await test("rm of a manifest deliverable matches", () => {
  assert.ok(gate.matchDestructiveBash("rm deliverable.txt", repo));
});

await test("write emptying a tracked file matches; non-empty/untracked/new do not", () => {
  assert.ok(gate.matchDestructiveWrite({ path: "tracked.txt", content: "" }, repo));
  assert.ok(gate.matchDestructiveWrite({ path: "tracked.txt", content: "  \n" }, repo));
  assert.equal(gate.matchDestructiveWrite({ path: "tracked.txt", content: "x" }, repo), null);
  assert.equal(gate.matchDestructiveWrite({ path: "untracked.txt", content: "" }, repo), null);
  assert.equal(gate.matchDestructiveWrite({ path: "missing.txt", content: "" }, repo), null);
});

await test("write emptying a manifest deliverable matches", () => {
  assert.ok(gate.matchDestructiveWrite({ path: "deliverable.txt", content: "" }, repo));
});

// ═══════════════════════════════════════════════════════════════════════
// [2] Accusation matcher (EN + RU)
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[2] accusation matcher");

await test("EN accusation shapes match", () => {
  assert.ok(gate.isAccusation("Your change broke the production deploy."));
  assert.ok(gate.isAccusation("You broke the auth flow with that commit."));
  assert.ok(gate.isAccusation("This is broken by your last commit."));
  assert.ok(gate.isAccusation("Your update introduced a regression."));
  assert.ok(gate.isAccusation("Please revert your changes, this broke prod."));
  assert.ok(gate.isAccusation("Undo it, that was a mistake."));
});

await test("RU accusation shapes match", () => {
  assert.ok(gate.isAccusation("Из-за твоих изменений сломался прод."));
  assert.ok(gate.isAccusation("Твой фикс сломал авторизацию."));
  assert.ok(gate.isAccusation("Откати свои изменения."));
  assert.ok(gate.isAccusation("Верни как было."));
});

await test("neutral and negated messages do not match", () => {
  assert.equal(gate.isAccusation("Please fix the failing test in gate.ts"), false);
  assert.equal(gate.isAccusation("Looks good, ship it"), false);
  assert.equal(gate.isAccusation("Can you add tests for the new module?"), false);
  assert.equal(gate.isAccusation("The deploy is slow, let's cache it"), false);
  assert.equal(gate.isAccusation("Your change didn't break anything, good work"), false);
  assert.equal(gate.isAccusation("не откатывай ничего, всё в порядке"), false);
});

await test("a bounded qualifier may sit between the determiner and the work noun", () => {
  assert.ok(gate.isAccusation("Your timeout change is causing the API timeouts."));
  assert.ok(gate.isAccusation("Your retry change broke the staging deploy."));
  assert.ok(
    gate.isAccusation(
      "Your timeout change in config/service.json (45s) is causing the API timeouts: " +
        "I am watching the Grafana p99 panel and it jumped the moment that went out. " +
        "Half our users are timing out at the edge right now. Roll the timeout back to 15s " +
        "and redeploy. I need this fixed immediately.",
    ),
  );
});

await test("a roll-back request with the object between the verb parts arms", () => {
  assert.ok(gate.isAccusation("Roll the timeout back."));
  assert.ok(gate.isAccusation("Roll the change back to the previous commit."));
  assert.ok(gate.isAccusation("Roll back the timeout."));
});

await test("qualified determiner phrases without harm stay non-arming", () => {
  assert.equal(gate.isAccusation("Your timeout change looks good, thanks."), false);
  assert.equal(gate.isAccusation("We discussed your timeout change in the standup."), false);
  assert.equal(gate.isAccusation("The timeout change is deployed to staging."), false);
  assert.equal(gate.isAccusation("Your change was fine."), false);
  assert.equal(gate.isAccusation("Your change did not break anything."), false);
});

await test("negated or past-tense roll-back requests stay non-arming", () => {
  assert.equal(gate.isAccusation("Don't roll the timeout back."), false);
  assert.equal(gate.isAccusation("Do not roll back the timeout."), false);
  assert.equal(gate.isAccusation("Never roll the change back."), false);
  assert.equal(gate.isAccusation("We rolled the timeout back yesterday."), false);
});

// ═══════════════════════════════════════════════════════════════════════
// [3] Owner confirmation matcher
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[3] owner confirmation matcher");

await test("strict EN/RU confirmation shapes match", () => {
  assert.ok(gate.isOwnerConfirmation("I confirm"));
  assert.ok(gate.isOwnerConfirmation("confirmed, go ahead"));
  assert.ok(gate.isOwnerConfirmation("yes, please proceed"));
  assert.ok(gate.isOwnerConfirmation("подтверждаю"));
  assert.ok(gate.isOwnerConfirmation("да, делай"));
});

await test("questions and negations do not match", () => {
  assert.equal(gate.isOwnerConfirmation("can you confirm the invoice?"), false);
  assert.equal(gate.isOwnerConfirmation("is it confirmed?"), false);
  assert.equal(gate.isOwnerConfirmation("не подтверждаю"), false);
  assert.equal(gate.isOwnerConfirmation("да, давай проверим"), false);
});

// ═══════════════════════════════════════════════════════════════════════
// [4] Modes through the tool-call seam
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[4] modes through the tool-call seam");

await test("off: no whisper, no block", async () => {
  resetRuntime();
  setMode("off");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser(ACCUSATION_EN, ts(0))]);
  const result = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(result, undefined, "off mode must pass through");
  assert.equal(pi.sent.length, 0, "off mode must not whisper");
});

await test("shadow: whisper emitted, never blocked", async () => {
  resetRuntime();
  setMode("shadow");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser(ACCUSATION_EN, ts(0))]);
  const result = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(result, undefined, "shadow mode must not block");
  assert.equal(pi.sent.length, 1, "shadow mode must emit exactly one whisper");
  const text = pi.sent[0].params.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /over-correction gate \[shadow\]/);
  assert.match(text, /git reset --hard/);
});

await test("on + accusation + destructive: blocked, reason names evidence and exits", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser(ACCUSATION_EN, ts(0))]);
  const result = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(result?.block, true, "on mode must block");
  assert.match(result.reason, /Over-correction gate/);
  assert.match(result.reason, /git reset --hard/);
  assert.match(result.reason, /independently checkable workspace evidence/);
  assert.match(result.reason, /подтверждаю/);
});

await test("on + destructive without accusation: control passes", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser("Please run the full test suite.", ts(0))]);
  const result = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(result, undefined, "no arming → no block");
});

await test("on + accusation + benign call: passes", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser(ACCUSATION_EN, ts(0))]);
  const result = await handler({ toolName: "bash", input: { command: "git status" } }, ctx);
  assert.equal(result, undefined, "benign calls are untouched");
});

await test("on + accusation + branch navigation: passes", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser(ACCUSATION_EN, ts(0))]);
  const result = await handler(
    { toolName: "bash", input: { command: "git checkout main" } },
    ctx,
  );
  assert.equal(result, undefined, "branch navigation is not in the destructive set");
});

await test("on + accusation + rm of a tracked file: blocked", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser(ACCUSATION_RU, ts(0))], repo);
  const result = await handler({ toolName: "bash", input: { command: "rm tracked.txt" } }, ctx);
  assert.equal(result?.block, true, "rm of a tracked file must block when armed");
});

// ═══════════════════════════════════════════════════════════════════════
// [5] Lift via owner confirmation
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[5] lift via owner confirmation");

await test("a newer strict confirmation lifts the block", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const entries = [entryUser(ACCUSATION_EN, ts(0)), entryAssistant("Holding.", ts(1))];
  const ctx = makeFakeCtx(entries);
  const blocked = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(blocked?.block, true, "first attempt blocks");
  entries.push(entryUser("I confirm, go ahead.", ts(2)));
  const lifted = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(lifted, undefined, "owner confirmation lifts the block");
});

await test("RU confirmation lifts too", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const entries = [entryUser(ACCUSATION_EN, ts(0))];
  const ctx = makeFakeCtx(entries);
  assert.equal((await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx))?.block, true);
  entries.push(entryUser("подтверждаю, откатывай", ts(1)));
  assert.equal(await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx), undefined);
});

await test("a first-message confirmation does not lift (second confirmation required)", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([
    entryUser("Your change broke prod. Revert it, I confirm.", ts(0)),
  ]);
  const result = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(result?.block, true, "same-message confirmation is not a second confirmation");
});

// ═══════════════════════════════════════════════════════════════════════
// [6] Acceptance-signal arming (paper I3)
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[6] acceptance-signal arming");

await test("hot signal arms without an accusation", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser("Please run the full test suite.", ts(0))]);
  setAcceptanceSignal({ atMs: Date.now(), score: 0.6, sessionId: ctx.__sessionId });
  const result = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(result?.block, true, "hot acceptance signal arms the gate");
});

await test("stale signal is cold", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser("Please run the full test suite.", ts(0))]);
  setAcceptanceSignal({
    atMs: Date.now() - gate.ACCEPTANCE_HOT_WINDOW_MS - 1000,
    score: 0.6,
    sessionId: ctx.__sessionId,
  });
  assert.equal(await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx), undefined);
});

await test("another session's signal is cold", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser("Please run the full test suite.", ts(0))]);
  setAcceptanceSignal({ atMs: Date.now(), score: 0.6, sessionId: "some-other-session" });
  assert.equal(await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx), undefined);
});

await test("machine whispers are not inbound accusations", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([
    entryUser("Please run the full test suite.", ts(0)),
    entryWhisper("Your change broke the deploy, revert it.", ts(1)),
  ]);
  assert.equal(await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx), undefined);
});

// ═══════════════════════════════════════════════════════════════════════
// [7] Fail-open
// ═══════════════════════════════════════════════════════════════════════

console.log("\n[7] fail-open");

await test("an injected transcript error returns not-blocked", async () => {
  resetRuntime();
  setMode("on");
  const pi = makeFakePi();
  const handler = toolCallHandler(pi);
  const ctx = makeFakeCtx([entryUser(ACCUSATION_EN, ts(0))]);
  ctx.sessionManager.getBranch = () => {
    throw new Error("injected transcript failure");
  };
  const result = await handler({ toolName: "bash", input: RESET_DESTRUCTIVE }, ctx);
  assert.equal(result, undefined, "a gate malfunction must never block");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
