/**
 * The active tool set a session actually comes up with.
 *
 * WHY THIS EXISTS:
 *   `context-management` shipped a curated profile as the born default, and a
 *   curated dozen cannot hold the tool families a session was started to use.
 *   A dispatch session came up on `lean` with `orchestrate`, the Telegram and
 *   herdr families, `timer`, `session` and the context tools all missing, so
 *   it could not open the poller, dispatch a worker or set a timer, and no
 *   profile could give those back. The intent that produced the default was
 *   "every session starts reduced" (README, Design Decisions); the intent the
 *   seat's own contract states is the opposite.
 *
 * WHAT THIS GATES:
 *   The number of ACTIVE tools after the runtime is fully built - the set the
 *   system prompt and every provider request carry. A fresh session is
 *   un-narrowed: pi-core's default builtins plus every extension tool that
 *   activates on registration, and no braid tool is missing from that set
 *   except the ones braid registers deferred on purpose (pi does not activate
 *   those; their discovery path is asserted in test-tool-exposure-deferral.mjs).
 *   A session that asks for a profile gets exactly that profile, and keeps it
 *   across a runtime rebuild. It does not assert that any function ran: a test
 *   for the call would have passed for months while the applied set was wrong.
 *
 * HOW IT DRIVES THE REAL RUNTIME:
 *   A real pi-core `DefaultResourceLoader` loads the real built braid
 *   extension (and, in the production-shaped case, the real contrib package
 *   the same way ~/.pi/agent/settings.json does), a real `AgentSession` is
 *   created over it, and `bindExtensions()` fires session_start exactly as
 *   the interactive/print/rpc modes do. Nothing is faked except the agent
 *   directory, the session file, and the model catalog entry.
 *
 * Run: node test/runtime/core/test-tool-profile-runtime-load.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIST = join(HERE, "..", "..", "..", "dist");
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const CONTRIB_ENTRY = join(HERE, "..", "..", "..", "..", "contrib", "index.ts");
const PICORE_DIST = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
const PI_AI_COMPAT = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js");

// Relocate pi's and braid's settings reads before any dist module evaluates a
// path. PI_CODING_AGENT_DIR is the relocation that pi's own getAgentDir honors.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "tool-profile-agent-"));
process.env.HOME = AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const CWD = mkdtempSync(join(tmpdir(), "tool-profile-cwd-"));
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(CWD, { recursive: true });

const {
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  createAgentSession,
} = await import(`file://${join(PICORE_DIST, "index.js")}`);
const { getModel } = await import(`file://${PI_AI_COMPAT}`);
const profileMod = await import(
  `file://${join(REPO_DIST, "extensions", "context-management", "index.js")}`
);

const { PROFILES, applyProfile } = profileMod;
const MODEL = getModel("anthropic", "claude-sonnet-4-5");

/**
 * Tools a dispatch session must hold to follow its boot contract. Registered
 * names outside this list are what a curated profile would silently drop, so
 * the born set is asserted against the whole registry below; this list names
 * the failure so a regression reads as itself and not as a count.
 */
const DISPATCH_TOOLS = [
  "orchestrate",
  "timer",
  "list_skills",
  "memory_store",
  "session",
  "context_compress",
];

/** pi-native builtins (settings.md, "Available built-in tools"). */
const PI_BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/**
 * The builtins pi-core activates on its own: the `defaultTools` setting, whose
 * documented default this agent directory does not override. An extension's
 * tools are active as they register, so the born set is this plus the
 * registry's extension tools, and never the whole registry.
 */
const PI_DEFAULT_BUILTINS = ["read", "bash", "edit", "write"];

/**
 * The tools braid registers deferred. pi does not activate those on
 * registration, so their absence from the born set is the intended state, not
 * a narrowing: `test-tool-exposure-deferral.mjs` asserts that inventory and the
 * discovery path back to it.
 */
function deferredNames(tools) {
  return tools.filter((tool) => tool.exposure === "deferred").map((tool) => tool.name);
}

/** What a fresh session has to hold: builtins by pi's default, extensions all but the deferred. */
function expectedBornSet(registered, deferred) {
  return registered.filter(
    (name) =>
      !deferred.includes(name) &&
      (!PI_BUILTINS.includes(name) || PI_DEFAULT_BUILTINS.includes(name)),
  );
}

console.log("=== the active tool set a session actually comes up with ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

function writeSettings(settings) {
  writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify(settings ?? {}));
}

/**
 * Build a session the way a real install does: the extension set from the
 * agent's package list, the runtime built, then bindExtensions -> session_start.
 * Returns the active names and the registry names as the session sees them.
 */
async function buildSession({ withContrib }) {
  const settingsManager = SettingsManager.create(CWD, AGENT_DIR);
  const extensionPaths = [join(REPO_DIST, "index.js")];
  if (withContrib) extensionPaths.push(CONTRIB_ENTRY);

  const loader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: extensionPaths,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  assert.equal(errors.length, 0, `extensions loaded cleanly (${JSON.stringify(errors)})`);

  const { session } = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(CWD),
    settingsManager,
    model: MODEL,
  });
  // The bindings a mode passes. onError/commandContextActions are not
  // decoration: reload() only re-emits session_start when bindings are present.
  await session.bindExtensions({
    mode: "print",
    commandContextActions: { waitForIdle: () => session.waitForIdle() },
    onError: () => {},
  });

  return {
    session,
    active: session.getActiveToolNames(),
    tools: session.getAllTools(),
    registered: session.getAllTools().map((t) => t.name),
  };
}

/** The profile as it can apply here: names the registry actually holds. */
function profileOf(registered, name) {
  const registeredSet = new Set(registered);
  return PROFILES[name].filter((tool) => registeredSet.has(tool));
}

/** The ExtensionAPI surface `applyProfile` uses, over a real session. */
function sessionApi(session) {
  return {
    getAllTools: () => session.getAllTools(),
    setActiveTools: (names) => session.setActiveToolsByName(names),
  };
}

/** Unordered equality, so a profile edit does not depend on list order. */
function assertSameSet(actual, expected, label) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert.deepEqual(
    a,
    e,
    `${label}: active set drifted\n  active (${a.length}): ${a.join(", ")}\n  expected (${e.length}): ${e.join(", ")}`,
  );
}

let contribRegistered = [];

await test("a fresh session comes up un-narrowed: every extension tool is active", async () => {
  writeSettings({});
  const { active, registered, tools } = await buildSession({ withContrib: false });
  console.log(`   registered ${registered.length}, active ${active.length}`);
  const missing = DISPATCH_TOOLS.filter((name) => !registered.includes(name));
  assert.deepEqual(missing, [], `the dispatch tools are registered (missing: ${missing.join(", ")})`);
  assertSameSet(
    active,
    expectedBornSet(registered, deferredNames(tools)),
    "core-only runtime",
  );
});

await test("the full install comes up un-narrowed too (contrib loads after core)", async () => {
  writeSettings({});
  const { active, registered, tools } = await buildSession({ withContrib: true });
  contribRegistered = registered;
  console.log(`   registered ${registered.length}, active ${active.length}`);
  assertSameSet(
    active,
    expectedBornSet(registered, deferredNames(tools)),
    "core+contrib runtime",
  );
});

await test("an explicit /tools list is not overwritten", async () => {
  const enabled = contribRegistered.filter((name) => name !== "bash");
  writeSettings({ braid: { contrib: { _global: { enabled } } } });
  const { active } = await buildSession({ withContrib: true });
  assertSameSet(active, enabled, "explicit operator tool list");
});

await test("an asked-for profile is exactly that profile", async () => {
  writeSettings({});
  const { session, registered } = await buildSession({ withContrib: true });
  const lean = applyProfile(sessionApi(session), "lean");
  const expected = profileOf(registered, "lean");
  console.log(`   registered ${registered.length}, lean ${lean.length}`);
  assertSameSet(session.getActiveToolNames(), expected, "lean after set_tool_profile");
  assert.equal(profileMod._currentProfile, "lean", "the chosen profile is remembered");
});

await test("the asked-for profile survives a runtime rebuild (/reload)", async () => {
  writeSettings({});
  const { session } = await buildSession({ withContrib: true });
  applyProfile(sessionApi(session), "lean");
  // reload() rebuilds the runner and activates every registered tool again
  // before re-emitting session_start; the asked-for profile is re-asserted there.
  await session.reload();
  const registered = session.getAllTools().map((t) => t.name);
  assertSameSet(session.getActiveToolNames(), profileOf(registered, "lean"), "after reload");
});

await test("a fresh session does not inherit the profile the last one asked for", async () => {
  writeSettings({});
  const first = await buildSession({ withContrib: true });
  applyProfile(sessionApi(first.session), "deep");
  const { active, registered, tools } = await buildSession({ withContrib: true });
  assertSameSet(
    active,
    expectedBornSet(registered, deferredNames(tools)),
    "second session, same process",
  );
});

await test("the profiles stay narrowings: lean holds no dispatch tool", async () => {
  const leaked = DISPATCH_TOOLS.filter((name) => PROFILES.lean.includes(name));
  assert.deepEqual(leaked, [], `lean must not be widened to carry the dispatch tools (${leaked.join(", ")})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== tool profile runtime-load tests passed ===");
process.exit(0);
