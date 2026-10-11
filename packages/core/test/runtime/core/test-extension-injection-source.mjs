/**
 * Injected input reaches pi-core's input chain with the source label its
 * consumers branch on.
 *
 * Drives REAL pi-core AgentSessions (built through the SDK) with inline probe
 * extensions, and injects through the same `pi.sendUserMessage(...)` an
 * extension-side caller uses (Telegram owner message, timer wake, any wired
 * channel). No braid extension internals are called.
 *
 * Subjects:
 *
 *   1. The seam. `pi.sendUserMessage` must deliver an `input` event whose
 *      `source` is "extension"; the TUI prompt path must deliver "interactive";
 *      the RPC path must deliver "rpc". These are pi-core's own labels
 *      (dist/core/agent-session.js: `sendUserMessage` calls `prompt(..., source:
 *      "extension")`, `prompt` calls `_runInputHandlers(text, images,
 *      options?.source ?? "interactive", ...)`). Asserted here so a dependency
 *      bump that drops a label fails loudly - input-handler consumers branch on
 *      it (enforcement's input handler skips `source === "extension"`).
 *
 *   2. The boundary. `pi.sendMessage` routes to `sendCustomMessage`, which
 *      appends the entry directly and never calls the input handlers.
 *
 * Hermetic: temp cwd + temp agent dir (no settings.json), in-memory session and
 * settings managers, probe handlers answer "handled" so `prompt()` stops before
 * model validation. No model, no API key, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIST = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
);

// The agent dir is fixed before any session is built, so settings resolve
// into the temp dir rather than the operator's real one.
const agentDir = join(mkdtempSync(join(tmpdir(), "injected-source-agent-")), "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const cwd = mkdtempSync(join(tmpdir(), "injected-source-cwd-"));

const { createAgentSession } = await import(`${CORE_DIST}/core/sdk.js`);
const { loadExtensionFromFactory, createExtensionRuntime } = await import(
  `${CORE_DIST}/core/extensions/loader.js`
);
const { SessionManager } = await import(`${CORE_DIST}/core/session-manager.js`);
const { SettingsManager } = await import(`${CORE_DIST}/core/settings-manager.js`);

/** A resource loader returning exactly the inline extensions we hand it. */
function inlineLoader(extensions, runtime) {
  return {
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function buildSession(factories) {
  const runtime = createExtensionRuntime();
  const extensions = [];
  for (const [name, factory] of factories) {
    extensions.push(await loadExtensionFromFactory(factory, cwd, undefined, runtime, name));
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: inlineLoader(extensions, runtime),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(cwd, agentDir),
  });
  return session;
}

/** Poll until `predicate()` holds, so assertions never race the async delivery. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ── What pi-core labels each entry path ────────────────────────────────────
// A lone probe extension, so nothing downstream can short-circuit the record.

const labels = [];
const labelSession = await buildSession([
  [
    "<inline:label-probe>",
    (pi) => {
      pi.on("input", async (event) => {
        labels.push(event.source);
        return { action: "handled" };
      });
    },
  ],
]);

/** Submit, then await the single label pi-core records for it. */
async function labelAfter(submit) {
  const index = labels.length;
  await submit();
  await waitFor(() => labels.length > index);
  assert.equal(labels.length, index + 1, "one input event per submission");
  return labels[index];
}

test("pi.sendUserMessage delivers an input event labelled extension", async () => {
  const source = await labelAfter(() =>
    labelSession.sendUserMessage("injected over an extension channel", { deliverAs: "steer" }),
  );
  assert.equal(source, "extension");
});

test('a TUI prompt submission is labelled interactive', async () => {
  // No source argument: the interactive-mode call site passes none, and
  // pi-core defaults to "interactive".
  const source = await labelAfter(() =>
    labelSession.prompt("typed by a human at the editor").catch(() => {}),
  );
  assert.equal(source, "interactive");
});

test("the RPC entry path is labelled rpc", async () => {
  const source = await labelAfter(() =>
    labelSession.steer("an rpc caller", undefined, { source: "rpc" }),
  );
  assert.equal(source, "rpc");
});

test("a custom message never enters the input chain at all", async () => {
  // The boundary that keeps every whisper-style delivery (enforcement, memory
  // nudges, heartbeat, skills auto-inject, timer wakes) out of the input
  // handlers: pi.sendMessage routes to sendCustomMessage, which appends the
  // entry directly and never calls them.
  const before = labels.length;
  labelSession.sendCustomMessage(
    {
      customType: "braid-test-whisper",
      content: [{ type: "text", text: "a system whisper" }],
      display: false,
      details: {},
    },
    { triggerTurn: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(labels.length, before, "no input event fired for a custom message");
});
