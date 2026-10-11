/**
 * Deferred tool exposure and the discovery path back to it.
 *
 * WHY THIS EXISTS:
 *   braid registers its cold tools with `exposure: "deferred"` so their whole
 *   declaration (name + description + JSON schema) leaves every provider
 *   request. pi declares a deferred tool to the model only once something
 *   activates it, and the only thing that can is `tool_search`, which pi's
 *   built-in tool-search extension registers INACTIVE. The deferral is
 *   therefore only half a change on its own: a session that does not carry the
 *   discovery tool has every deferred family registered, callable from a
 *   codemode script, and invisible to the agent.
 *
 * WHAT THIS GATES:
 *   - the deferred inventory: those tools are registered, are not active (so
 *     they are not declared), and nothing outside the list was deferred by
 *     accident;
 *   - the discovery guard in both directions: it activates `tool_search` when
 *     the active set lacks it, and leaves the set alone when the tool is
 *     already there or the registry does not hold it;
 *   - every profile still reaches the deferred tools, and applying one keeps
 *     the discovery tool active;
 *   - the contrib `/tools` restore keeps the discovery tool: it replaces the
 *     active set in a later session-start handler, after the guard ran.
 *
 * HOW IT DRIVES THE REAL RUNTIME:
 *   A real pi-core `DefaultResourceLoader` loads the real built braid
 *   extension, the real contrib package (the way ~/.pi/agent/settings.json
 *   does) and pi's own built-in tool-search extension over the same
 *   `builtin:` path its CLI uses; a real `AgentSession` is created over it and
 *   `bindExtensions()` fires session_start exactly as the interactive/print/rpc
 *   modes do. Nothing is faked except the agent directory, the session file,
 *   and the model catalog entry.
 *
 * Run: node test/runtime/core/test-tool-exposure-deferral.mjs
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
const AGENT_DIR = mkdtempSync(join(tmpdir(), "tool-exposure-agent-"));
process.env.HOME = AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const CWD = mkdtempSync(join(tmpdir(), "tool-exposure-cwd-"));
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(CWD, { recursive: true });

const {
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  createAgentSession,
} = await import(`file://${join(PICORE_DIST, "index.js")}`);
const { getModel } = await import(`file://${PI_AI_COMPAT}`);
// pi's CLI hands its built-in extensions to the loader as inline factories and
// requests the enabled ones over `builtin:<name>` paths. Both halves are needed
// here too: without the factories the path is unknown, without the path nothing
// is registered.
const { builtInExtensions } = await import(
  `file://${join(PICORE_DIST, "extensions", "index.js")}`
);
const profileMod = await import(
  `file://${join(REPO_DIST, "extensions", "context-management", "index.js")}`
);

const { PROFILES, PROFILE_NAMES, applyProfile, ensureDiscoveryTool } = profileMod;
const MODEL = getModel("anthropic", "claude-sonnet-4-5");

/** The discovery tool every braid session has to carry. */
const DISCOVERY_TOOL = "tool_search";

/**
 * The deferred inventory. Deferring a tool is a statement about its use: it has
 * no rendered prompt row, the agent reaches it by searching for it, so the list
 * is deliberate and the count is part of the assertion. A tool added here
 * without adding the name fails; so does a name added without deferring it.
 */
const DEFERRED_TOOLS = [
  "browser_eval",
  "browser_navigate",
  "browser_screenshot",
  "browser_snapshot",
  "codebase",
  "context_inspect",
  "context_proposals",
  "file_diff",
  "healthcheck",
  "observatory",
  "offload_recover",
  "repl",
  "skill_stats",
  "system_monitor",
  "topic_drift",
  "v2raytun_reconnect",
  "v2raytun_status",
];

/**
 * Tools the deferral must never touch: the owner channel's liveness tools (the
 * seat's boot contract opens the poller first), the dispatch and memory
 * families, and the reasoning core. Named so a widened deferral reads as the
 * regression it is instead of only breaking a count.
 */
const NEVER_DEFERRED = [
  "read",
  "edit",
  "write",
  "bash",
  "think",
  "verify",
  "finalize",
  "scratchpad",
  "memory",
  "memory_store",
  "list_skills",
  "orchestrate",
  "set_tool_profile",
  "context_navigate",
  "context_compress",
];

/** pi-native builtins (settings.md, "Available built-in tools"). */
const PI_BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/**
 * The builtins pi-core activates on its own: the `defaultTools` setting, whose
 * documented default this agent directory does not override.
 */
const PI_DEFAULT_BUILTINS = ["read", "bash", "edit", "write"];

/**
 * What a fresh, un-narrowed session has to hold: builtins by pi's default,
 * every extension tool that activates on registration, and (the guard's own
 * claim) the discovery tool.
 */
function expectedBootSet(registered) {
  return registered.filter(
    (name) =>
      DEFERRED_TOOLS.includes(name) === false &&
      (!PI_BUILTINS.includes(name) || PI_DEFAULT_BUILTINS.includes(name)),
  );
}

console.log("=== deferred tool exposure and the discovery path back ===\n");

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
 * agent's package list, pi's built-in tool-search extension over its own
 * `builtin:` path, the runtime built, then bindExtensions -> session_start.
 */
async function buildSession({ withContrib = true, withToolSearch = true } = {}) {
  const settingsManager = SettingsManager.create(CWD, AGENT_DIR);
  const extensionPaths = [join(REPO_DIST, "index.js")];
  if (withToolSearch) extensionPaths.push("builtin:tool-search");
  if (withContrib) extensionPaths.push(CONTRIB_ENTRY);

  const loader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    settingsManager,
    extensionFactories: builtInExtensions,
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
  // The bindings a mode passes: reload() only re-emits session_start when
  // bindings are present.
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

/** The ExtensionAPI surface the guard uses, over a real session. */
function sessionApi(session) {
  return {
    getAllTools: () => session.getAllTools(),
    getActiveTools: () => session.getActiveToolNames(),
    setActiveTools: (names) => session.setActiveToolsByName(names),
  };
}

/** Unordered equality, so a set comparison does not depend on list order. */
function assertSameSet(actual, expected, label) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert.deepEqual(
    a,
    e,
    `${label}: tool set drifted\n  actual (${a.length}): ${a.join(", ")}\n  expected (${e.length}): ${e.join(", ")}`,
  );
}

let boot = null;

await test("the deferred inventory is registered, undeclared, and exactly the list", async () => {
  writeSettings({});
  boot = await buildSession();
  const deferred = boot.tools
    .filter((t) => t.exposure === "deferred")
    .map((t) => t.name)
    .sort();
  assert.deepEqual(
    deferred,
    [...DEFERRED_TOOLS].sort(),
    "the deferred set in the registry must equal the inventory",
  );
  for (const name of DEFERRED_TOOLS) {
    assert.ok(boot.registered.includes(name), `${name} must be registered`);
    assert.ok(
      !boot.active.includes(name),
      `${name} is deferred, so it must not be active (and therefore not declared)`,
    );
  }
  console.log(`   deferred ${deferred.length}, registered ${boot.registered.length}`);
});

await test("the deferral left the hot and dispatch families alone", async () => {
  for (const name of NEVER_DEFERRED) {
    const tool = boot.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} must be registered`);
    assert.notEqual(tool.exposure, "deferred", `${name} must stay declared`);
    assert.ok(boot.active.includes(name), `${name} must be active`);
  }
});

await test("a fresh session carries the discovery tool (the guard activated it)", async () => {
  assert.ok(boot.registered.includes(DISCOVERY_TOOL), "the built-in tool-search extension is loaded");
  assert.ok(
    boot.active.includes(DISCOVERY_TOOL),
    `${DISCOVERY_TOOL} must be active or no deferred tool is reachable`,
  );
  assertSameSet(boot.active, expectedBootSet(boot.registered), "born set");
});

await test("the guard is additive when the tool is missing", async () => {
  const api = sessionApi(boot.session);
  const without = boot.session.getActiveToolNames().filter((n) => n !== DISCOVERY_TOOL);
  boot.session.setActiveToolsByName(without);
  assert.ok(!boot.session.getActiveToolNames().includes(DISCOVERY_TOOL), "precondition: absent");

  const added = ensureDiscoveryTool(api);
  assert.deepEqual(added, [DISCOVERY_TOOL], "the guard reports what it added");
  assertSameSet(boot.session.getActiveToolNames(), [...without, DISCOVERY_TOOL], "after the guard");
  assert.equal(
    boot.session.getActiveToolNames().filter((n) => n === DISCOVERY_TOOL).length,
    1,
    "activated once, not duplicated",
  );
});

await test("the guard is a no-op when the tool is already active", async () => {
  const api = sessionApi(boot.session);
  const before = boot.session.getActiveToolNames();
  assert.ok(before.includes(DISCOVERY_TOOL), "precondition: present");

  const added = ensureDiscoveryTool(api);
  assert.deepEqual(added, [], "nothing to add");
  assert.deepEqual(boot.session.getActiveToolNames(), before, "the set is untouched, in order");
});

await test("the guard writes nothing when the registry does not hold the tool", async () => {
  const { session, active, registered } = await buildSession({ withContrib: false, withToolSearch: false });
  assert.ok(!registered.includes(DISCOVERY_TOOL), "precondition: the registry lacks it");

  const added = ensureDiscoveryTool(sessionApi(session));
  assert.deepEqual(added, [], "no unknown name is injected");
  assertSameSet(active, expectedBootSet(registered), "born set without the tool-search extension");
  assert.ok(!session.getActiveToolNames().includes(DISCOVERY_TOOL), "still absent");
});

await test("every profile names the discovery tool", async () => {
  for (const name of PROFILE_NAMES) {
    assert.ok(
      PROFILES[name].includes(DISCOVERY_TOOL),
      `profile "${name}" must carry ${DISCOVERY_TOOL}: applying a profile replaces the whole active set`,
    );
  }
  console.log(`   profiles checked: ${PROFILE_NAMES.join(", ")}`);
});

await test("the /tools restore keeps the discovery tool", async () => {
  // The operator's saved list is the regression path: the contrib restore
  // replaces the active set in a later session-start handler, after the guard.
  const saved = boot.registered.filter((name) => name !== "bash" && name !== DISCOVERY_TOOL);
  writeSettings({ braid: { contrib: { _global: { enabled: saved } } } });
  const { active } = await buildSession();
  assertSameSet(active, [...saved, DISCOVERY_TOOL], "restored operator list");
  assert.ok(active.includes(DISCOVERY_TOOL), "a saved list must not turn discovery dark");
});

await test("a profile re-declares the deferred tools it names, and keeps discovery", async () => {
  writeSettings({});
  const { session, tools, registered } = await buildSession();
  const active = applyProfile(sessionApi(session), "browser");
  const expected = PROFILES.browser.filter((name) => registered.includes(name));

  assertSameSet(active, expected, "browser after set_tool_profile");
  assert.ok(
    active.includes(DISCOVERY_TOOL),
    "a narrowed session still finds its deferred tools",
  );
  const deferredActive = active.filter(
    (name) => tools.find((t) => t.name === name)?.exposure === "deferred",
  );
  assert.ok(
    deferredActive.length > 0,
    "this profile names a deferred tool, which is how a profile declares one on demand",
  );
  console.log(
    `   browser profile ${active.length} tools, deferred among them: ${deferredActive.join(", ")}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== tool exposure deferral tests passed ===");
process.exit(0);
