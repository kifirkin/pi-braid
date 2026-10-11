/**
 * skill adoption counters — session + durable cross-session store.
 *
 * Pins the contract:
 * 1. Session counters (getExtensionState) keep their E3 semantics:
 * `suggested`increments per suggestion, `loaded`increments on BOTH
 * existing triggers (LOADED probe reply, SKILL.md read via tool_result).
 * 2. Both record paths ALSO update a durable store persisted at
 * getSkillsUsageFilePath(), shape
 * { [skillName]: { suggested, loaded, claimed, actual, lastAt } },
 * written atomically-ish (temp + rename, no temp litter left behind).
 * A LOADED probe reply records as a claim; a detected SKILL.md read
 * records as an actual load; both add to `loaded`. Legacy rows without
 * claimed/actual normalize with actual = loaded, claimed = 0.
 * 3. Missing OR corrupt file → fresh start, never throws; every
 * persistence error is swallowed (best-effort on the whisper path —
 * a stats failure must NEVER break suggestions).
 * 4. skill_stats tool output contains BOTH a session section and an
 * all-time section.
 * 5. Session profiles: the braid config home maps cwd → profile
 * { name, cwd, hint? } (see lib/config/session-profiles); adoption
 * records carry the profile name or the neutral default, the monthly
 * rollup buckets by profile name, and legacy role strings keep folding
 * under their original names.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real agent tree is never
 * touched. The persistence round-trip is proven by re-importing the dist
 * module under a fresh URL query (?fresh-*) — a new module instance with
 * empty in-memory state that must read its counters back from disk (a
 * simulated process restart; verified distinct-module-record in Node 22).
 *
 * Tests run strictly sequentially (awaited chain): the durable store is
 * lazily loaded ONCE per module instance, so tests that depend on disk state
 * depend on the ordering too.
 */

import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  chmodSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate braid storage: temp home. MUST precede dist imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-stats-test-"));
process.env.HOME = FAKE_HOME;

const { getSkillsUsageFilePath, getSkillsSessionsFilePath, getBraidConfigFilePath } =
  await import("../../../dist/lib/config/braid-paths.js");
const {
  recordSkillSuggestion,
  recordSkillLoad,
  recordSkillClaim,
  getSkillStats,
  getDurableSkillStats,
  registerAutoInject,
  updateSkillCache,
} = await import("../../../dist/extensions/core/skills-tool/auto-inject.js");
const {
  monthOf,
  appendSessionRecord,
  readSessionRecords,
  foldSessionRecords,
  computeMonthlyRollup,
} = await import("../../../dist/extensions/core/skills-tool/session-records.js");
const {
  NEUTRAL_SESSION_PROFILE,
  parseSessionProfiles,
  readSessionProfiles,
  resolveSessionProfile,
} = await import("../../../dist/lib/config/session-profiles.js");

const USAGE_FILE = getSkillsUsageFilePath();
const SESSIONS_FILE = getSkillsSessionsFilePath();
const CONFIG_PATH = getBraidConfigFilePath();
const BRAID_DIR = join(FAKE_HOME, ".pi", "agent", "braid");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(` [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(` [fail] ${name}: ${e.message}`);
  }
}

/** Fresh fake ctx per test: getExtensionState falls back to a per-object WeakMap bucket. */
const fakeCtx = () => ({});

/** Import the auto-inject module again under a fresh URL query → fresh module state. */
async function freshAutoInject(tag) {
  return import(`../../../dist/extensions/core/skills-tool/auto-inject.js?fresh-${tag}`);
}

/** Minimal ExtensionAPI double that captures registered handlers and tools. */
function fakePi() {
  const handlers = {};
  const tools = [];
  const sent = [];
  return {
    handlers,
    tools,
    sent,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerTool: (def) => {
      tools.push(def);
    },
    // Delivery stub: the tracked send path hands the message here, which is
    // what a session stream does. A stub without this cannot deliver, and the
    // suggestion counter must then stay put.
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
  };
}

function readUsageFile() {
  return JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
}

console.log("skill-stats test (durable adoption counters)\n");

// ── path resolution ──────────────────────────────────────────────────────────

await test("getSkillsUsageFilePath resolves under the (temp) HOME braid dir", async () => {
  assert.equal(
    USAGE_FILE,
    join(FAKE_HOME, ".pi", "agent", "braid", "skills-usage.json"),
    "usage file must live at <braid>/skills-usage.json",
  );
});

// ── durable store is file-backed (must run before any in-memory record) ─────

await test("skill_stats all-time section surfaces the durable file content", async () => {
  mkdirSync(BRAID_DIR, { recursive: true });
  writeFileSync(
    USAGE_FILE,
    JSON.stringify({
      filebacked: { suggested: 11, loaded: 4, lastAt: "2026-09-05T01:02:03.000Z" },
    }),
    "utf-8",
  );
  const { default: skillsToolExtension } =
    await import("../../../dist/extensions/core/skills-tool/index.js");
  const pi = fakePi();
  skillsToolExtension(pi);
  const def = pi.tools.find((t) => t.name === "skill_stats");
  assert.ok(def, "skill_stats tool registered");
  const result = await def.execute("id", {}, undefined, undefined, fakeCtx());
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.allTime, "all-time section present");
  // Legacy row (no claimed/actual): loads normalize to actual, claimed 0.
  assert.deepEqual(
    parsed.allTime.filebacked,
    {
      suggested: 11,
      loaded: 4,
      claimed: 0,
      actual: 4,
      lastAt: "2026-09-05T01:02:03.000Z",
      epoch: "mixed",
    },
    "tool must surface the durable store normalized (legacy row → actual = loaded, epoch = mixed)",
  );
  assert.deepEqual(
    parsed.allTimeTotals,
    {
      suggested: 11,
      loaded: 4,
      claimed: 0,
      actual: 0 + 4,
      suggestedDelivered: 0,
      suggestedMixed: 11,
      suggestedEpoch: "mixed",
    },
    "all-time totals sum the store and state the suggested epoch",
  );
  assert.equal(typeof parsed.sessionHasSkillLoad, "boolean", "session section still present");
  assert.deepEqual(parsed.skills, {}, "session skills empty for a fresh ctx");
});

// ── session counters keep their semantics (contract 1 + 2) ──────────────────

await test("recordSkillSuggestion increments suggested in session state and durable store", async () => {
  const ctx = fakeCtx();
  recordSkillSuggestion(ctx, ["counter-a"]);
  assert.equal(getSkillStats(ctx)["counter-a"].suggested, 1, "session suggested");
  const durable = getDurableSkillStats()["counter-a"];
  assert.equal(durable.suggested, 1, "durable suggested");
  assert.match(durable.lastAt, /^\d{4}-\d{2}-\d{2}T/, "lastAt is an ISO timestamp");
});

await test("recordSkillLoad increments loaded on both session and durable stores", async () => {
  const ctx = fakeCtx();
  recordSkillLoad(ctx, "counter-a");
  recordSkillLoad(ctx, "counter-a");
  assert.equal(getSkillStats(ctx)["counter-a"].loaded, 2, "session loaded");
  assert.equal(getSkillStats(ctx)["counter-a"].actual, 2, "session actual");
  assert.equal(getSkillStats(ctx)["counter-a"].claimed, 0, "no claims yet");
  assert.equal(getDurableSkillStats()["counter-a"].loaded, 2, "durable loaded");
  assert.equal(getDurableSkillStats()["counter-a"].actual, 2, "durable actual");
});

await test("a probe claim records claimed+loaded without touching actual", async () => {
  const ctx = fakeCtx();
  recordSkillClaim(ctx, "claim-only");
  assert.equal(getSkillStats(ctx)["claim-only"].claimed, 1, "session claim");
  assert.equal(getDurableSkillStats()["claim-only"].claimed, 1, "durable claim");
  assert.equal(getDurableSkillStats()["claim-only"].loaded, 1, "durable loaded sums");
  assert.equal(getDurableSkillStats()["claim-only"].actual, 0, "no detected read");
});

await test("claims and reads sum into loaded in the durable store", async () => {
  const ctx = fakeCtx();
  recordSkillClaim(ctx, "mixed-skill");
  recordSkillClaim(ctx, "mixed-skill");
  recordSkillLoad(ctx, "mixed-skill");
  const d = getDurableSkillStats()["mixed-skill"];
  assert.equal(d.claimed, 2);
  assert.equal(d.actual, 1);
  assert.equal(d.loaded, 3, "loaded = claimed + actual");
  assert.equal(d.suggested, 0);
});

await test("recordSkillLoad ignores an empty name (no session, no durable entry)", async () => {
  const ctx = fakeCtx();
  recordSkillLoad(ctx, "");
  assert.deepEqual(getSkillStats(ctx), {});
  assert.equal(getDurableSkillStats()[""], undefined);
});

// ── durable file shape + atomic-ish write ────────────────────────────────────

await test("usage file exists after recording with the full counter shape", async () => {
  const file = readUsageFile();
  assert.ok(file["counter-a"], "counter-a entry present on disk");
  assert.equal(typeof file["counter-a"].suggested, "number");
  assert.equal(typeof file["counter-a"].loaded, "number");
  assert.equal(typeof file["counter-a"].claimed, "number");
  assert.equal(typeof file["counter-a"].actual, "number");
  assert.equal(typeof file["counter-a"].lastAt, "string");
});

await test("write is atomic-ish: no temp files left behind in the braid dir", async () => {
  recordSkillSuggestion(fakeCtx(), ["counter-b"]);
  const leftovers = readdirSync(BRAID_DIR).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], "temp write file must be renamed away");
});

// ── persistence round-trip: fresh module state reads back from disk ─────────

await test("round-trip: fresh module state reads persisted counters from disk", async () => {
  const fresh = await freshAutoInject("roundtrip");
  const durable = fresh.getDurableSkillStats();
  assert.equal(durable["counter-a"].suggested, 1, "suggested survives restart");
  assert.equal(durable["counter-a"].loaded, 2, "loaded survives restart");
  assert.equal(durable["counter-a"].actual, 2, "actual survives restart");
  assert.equal(durable["counter-a"].claimed, 0, "claimed survives restart");
  assert.ok(durable["counter-a"].lastAt, "lastAt survives restart");
  assert.equal(durable["counter-a"].epoch, "delivered", "epoch survives restart");
});

await test("round-trip: fresh module state writes through to the same file", async () => {
  const fresh = await freshAutoInject("writethrough");
  fresh.recordSkillLoad(fakeCtx(), "roundtrip-skill");
  const onDisk = readUsageFile();
  assert.equal(onDisk["roundtrip-skill"].loaded, 1, "fresh-process write landed on disk");
});

await test("session and durable scopes coexist for a new session", async () => {
  const ctx = fakeCtx();
  assert.deepEqual(getSkillStats(ctx), {}, "session counters start empty for a new session");
  assert.ok(getDurableSkillStats()["counter-a"], "durable history retained");
});

// ── corrupt / malformed file → fresh start, never throw (contract 3) ────────

await test("corrupt file → fresh start, then repair on next write", async () => {
  writeFileSync(USAGE_FILE, "{{{not json at all", "utf-8");
  const fresh = await freshAutoInject("corrupt");
  assert.deepEqual(fresh.getDurableSkillStats(), {}, "corrupt file must read as fresh");
  // Next recording must not throw AND must repair the file.
  fresh.recordSkillSuggestion(fakeCtx(), ["repaired"]);
  const onDisk = readUsageFile(); // throws if not valid JSON
  assert.equal(onDisk["repaired"].suggested, 1, "repair write landed as valid JSON");
});

await test("valid-but-wrong JSON shapes → fresh start, no throw", async () => {
  const bads = ["[]", '"string"', "42", "null"];
  for (let i = 0; i < bads.length; i++) {
    writeFileSync(USAGE_FILE, bads[i], "utf-8");
    const fresh = await freshAutoInject(`shape-${i}`);
    assert.deepEqual(fresh.getDurableSkillStats(), {}, `input ${bads[i]} must start fresh`);
  }
});

await test("per-entry garbage is dropped, valid entries kept, no throw", async () => {
  writeFileSync(
    USAGE_FILE,
    JSON.stringify({
      good: { suggested: 3, loaded: 1, lastAt: "2026-09-05T00:00:00.000Z" },
      arr: [1, 2],
      num: 7,
      nul: null,
      partial: { suggested: "nope" },
    }),
    "utf-8",
  );
  const fresh = await freshAutoInject("sanitized");
  const durable = fresh.getDurableSkillStats();
  // legacy `good`row: loads normalize to actual, claimed 0, epoch mixed
  assert.deepEqual(durable.good, {
    suggested: 3,
    loaded: 1,
    claimed: 0,
    actual: 1,
    lastAt: "2026-09-05T00:00:00.000Z",
    epoch: "mixed",
  });
  assert.equal(durable.arr, undefined);
  assert.equal(durable.num, undefined);
  assert.equal(durable.nul, undefined);
  // partial: fields coerced to defaults rather than trusted
  assert.deepEqual(durable.partial, {
    suggested: 0,
    loaded: 0,
    claimed: 0,
    actual: 0,
    lastAt: "",
    epoch: "mixed",
  });
  // writing still works from the sanitized state
  fresh.recordSkillLoad(fakeCtx(), "good");
  assert.equal(readUsageFile()["good"].loaded, 2);
});

await test("legacy rows load without migration errors: actual defaults to loaded, claimed to 0", async () => {
  writeFileSync(
    USAGE_FILE,
    JSON.stringify({
      legacy: { suggested: 20, loaded: 9, lastAt: "2026-09-01T00:00:00.000Z" },
    }),
    "utf-8",
  );
  const fresh = await freshAutoInject("legacy");
  const durable = fresh.getDurableSkillStats();
  assert.deepEqual(durable.legacy, {
    suggested: 20,
    loaded: 9,
    claimed: 0,
    actual: 9,
    lastAt: "2026-09-01T00:00:00.000Z",
    epoch: "mixed",
  });
  // a new claim on top of a legacy row keeps the counters consistent
  fresh.recordSkillClaim(fakeCtx(), "legacy");
  const onDisk = readUsageFile()["legacy"];
  assert.equal(onDisk.claimed, 1);
  assert.equal(onDisk.actual, 9);
  assert.equal(onDisk.loaded, 10);
});

await test("unwritable braid dir → persistence error swallowed, record still succeeds", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.log(" [skip] running as root — chmod isolation not effective");
    return;
  }
  const fresh = await freshAutoInject("eacces");
  chmodSync(BRAID_DIR, 0o500); // r-x: creating the temp write file must fail
  try {
    // Must NOT throw — best-effort persistence on the whisper path.
    fresh.recordSkillSuggestion(fakeCtx(), ["eacces-skill"]);
  } finally {
    chmodSync(BRAID_DIR, 0o755);
  }
  // In-memory store still recorded the event even though the flush failed.
  assert.equal(fresh.getDurableSkillStats()["eacces-skill"].suggested, 1);
});

// ── handler-level wiring: suggestion + read load trigger ────────────────────

await test("before_agent_start suggestion increments the durable counter end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-stats-handler-test-"));
  mkdirSync(join(dir, "handler-skill"), { recursive: true });
  const realPath = join(dir, "handler-skill", "SKILL.md");
  writeFileSync(
    realPath,
    "---\nname: handler-skill\ndescription: handler test skill\n---\n\nbody instructions",
    "utf-8",
  );

  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([
    { name: "handler-skill", filePath: realPath, description: "handler test skill", baseDir: dir },
  ]);

  const before = getDurableSkillStats()["handler-skill"]?.suggested ?? 0;
  await pi.handlers.before_agent_start(
    { prompt: "please follow the handler-skill instructions for this task" },
    fakeCtx(),
  );
  const after = getDurableSkillStats()["handler-skill"]?.suggested ?? 0;
  const delivered = pi.sent.filter((m) => m.params.customType === "skills-suggestion");
  assert.equal(delivered.length, 1, "handler delivered the suggestion");
  assert.equal(after, before + 1, "durable suggested incremented by the handler");

  rmSync(dir, { recursive: true, force: true });
});

await test("tool_result SKILL.md read counts a durable load (list→read path)", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  const before = getDurableSkillStats()["read-trigger"]?.loaded ?? 0;
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: "/tmp/whatever/read-trigger/SKILL.md" },
      content: [{ type: "text", text: "---\nname: read-trigger\ndescription: x\n---\n\nbody" }],
    },
    fakeCtx(),
  );
  const after = getDurableSkillStats()["read-trigger"]?.loaded ?? 0;
  assert.equal(after, before + 1, "durable loaded incremented via tool_result read");
});

await test("a FAILED read (isError) is not a load — no phantom counter", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  const before = getDurableSkillStats()["phantom-skill"]?.loaded ?? 0;
  pi.handlers.tool_result(
    {
      toolName: "read",
      isError: true,
      input: { path: "/tmp/whatever/phantom-skill/SKILL.md" },
      content: [{ type: "text", text: "Error: ENOENT: no such file or directory" }],
    },
    fakeCtx(),
  );
  const after = getDurableSkillStats()["phantom-skill"]?.loaded ?? 0;
  assert.equal(after, before, "an error result never counts as a load");
  assert.equal(getSkillStats(fakeCtx())["phantom-skill"], undefined, "no session entry either");
});

await test("a fresh durable row carries epoch delivered; a legacy row stays mixed", async () => {
  const ctx = fakeCtx();
  recordSkillSuggestion(ctx, ["epoch-fresh"]);
  assert.equal(getDurableSkillStats()["epoch-fresh"].epoch, "delivered");
  // Seed a legacy row (pre-epoch shape) and land a delivered-regime increment
  // on it: the inflation cannot be split out, so the row must stay mixed.
  writeFileSync(
    USAGE_FILE,
    JSON.stringify({ legacy: { suggested: 20, loaded: 9, lastAt: "2026-09-01T00:00:00.000Z" } }),
    "utf-8",
  );
  const fresh = await freshAutoInject("epoch-mixed");
  fresh.recordSkillSuggestion(fakeCtx(), ["legacy"]);
  assert.equal(fresh.getDurableSkillStats()["legacy"].epoch, "mixed");
});

await test("skill_stats allTimeTotals splits suggested by epoch", async () => {
  const { default: skillsToolExtension } =
    await import("../../../dist/extensions/core/skills-tool/index.js?epoch-split");
  const pi = fakePi();
  skillsToolExtension(pi);
  const def = pi.tools.find((t) => t.name === "skill_stats");
  const parsed = JSON.parse(
    (await def.execute("id", {}, undefined, undefined, fakeCtx())).content[0].text,
  );
  const t = parsed.allTimeTotals;
  assert.equal(
    t.suggested,
    t.suggestedDelivered + t.suggestedMixed,
    "suggested = delivered + mixed",
  );
  assert.ok(t.suggestedDelivered > 0, "this run wrote delivered-regime rows");
  assert.equal(t.suggestedEpoch, "mixed", "legacy rows keep the whole store mixed");
  assert.ok(parsed.discovery, "discovery section present");
  assert.ok(["suppressed", "rebuilt"].includes(parsed.discovery.catalog), "catalog state named");
});

await test("a detected load releases the skill's slot and extends its cooldown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-slot-release-"));
  const mkSkill = (name, body) => {
    mkdirSync(join(dir, name), { recursive: true });
    const p = join(dir, name, "SKILL.md");
    writeFileSync(p, `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}`, "utf-8");
    return { name, filePath: p, description: `${name} fixture`, baseDir: dir };
  };
  const alpha = mkSkill("alpha", "alpha instructions");
  const beta = mkSkill("beta", "beta instructions");
  const gamma = mkSkill("gamma", "gamma instructions");
  const delta = mkSkill("delta", "delta instructions");
  const promptFor = (s) => `please follow the ${s} instructions now`;

  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([alpha, beta, gamma, delta]);
  const ctx = { sessionManager: { getSessionId: () => "slot-release" }, cwd: "/tmp" };
  const suggestions = () => pi.sent.filter((m) => m.params.customType === "skills-suggestion");
  const suggestedNames = () => suggestions().flatMap((m) => m.params.details.skills);

  // Turns 1-2 fill the two slots (alpha, beta).
  for (const s of [alpha, beta]) {
    await pi.handlers.before_agent_start({ prompt: promptFor(s.name) }, ctx);
  }
  assert.deepEqual(suggestedNames(), ["alpha", "beta"], "two slots filled");

  // A detected read of alpha marks it loaded: its slot frees, its cooldown extends.
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: alpha.filePath },
      content: [{ type: "text", text: `---\nname: alpha\ndescription: x\n---\n\nbody` }],
    },
    ctx,
  );

  // Turn 3: delta matches — possible ONLY because alpha's slot was released.
  await pi.handlers.before_agent_start({ prompt: promptFor("delta") }, ctx);
  assert.deepEqual(
    suggestedNames(),
    ["alpha", "beta", "delta"],
    "loaded skill's slot released for the next match",
  );

  // Turns 4-10: filler prompts that match nothing, so the floor cooldown on
  // alpha (injected turn 1) expires at turn 11.
  for (let t = 0; t < 7; t++) {
    await pi.handlers.before_agent_start({ prompt: "just talk about the weather briefly" }, ctx);
  }
  // Turn 11: alpha's floor expired but only 9 turns passed since its load
  // (< LOADED_COOLDOWN_TURNS) — the per-skill extension keeps it blocked.
  await pi.handlers.before_agent_start({ prompt: promptFor("alpha") }, ctx);
  assert.equal(suggestedNames().length, 3, "no re-suggestion of an in-context skill");

  // Turns 12-39: filler until both cooldowns expire (floor at turn 11,
  // loaded window at turn 32; keep filling to 39 for margin).
  for (let t = 0; t < 28; t++) {
    await pi.handlers.before_agent_start({ prompt: "just talk about the weather briefly" }, ctx);
  }
  // Turn 40: alpha is eligible again (both cooldowns expired) — but beta and
  // delta still hold the two slots, and a full board without eviction stays
  // full: eligibility alone does not re-suggest.
  await pi.handlers.before_agent_start({ prompt: promptFor("alpha") }, ctx);
  assert.equal(
    suggestedNames().length,
    3,
    "eligibility without a free slot does not re-suggest",
  );

  rmSync(dir, { recursive: true, force: true });
});

await test("a read that matches no injected skill still counts its load", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  const before = getDurableSkillStats()["uninjected-skill"]?.loaded ?? 0;
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: "/tmp/whatever/uninjected-skill/SKILL.md" },
      content: [{ type: "text", text: "---\nname: uninjected-skill\ndescription: x\n---\n\nbody" }],
    },
    fakeCtx(),
  );
  assert.equal(
    getDurableSkillStats()["uninjected-skill"].loaded,
    before + 1,
    "loads outside the suggestion flow still count",
  );
});

// ── skill_stats output accumulates session + all-time ───────────────────────

await test("skill_stats output contains both sections and accumulates all-time", async () => {
  const { default: skillsToolExtension } =
    await import("../../../dist/extensions/core/skills-tool/index.js");
  const pi = fakePi();
  skillsToolExtension(pi);
  const def = pi.tools.find((t) => t.name === "skill_stats");
  assert.ok(def, "skill_stats tool registered");

  const ctx = fakeCtx();
  recordSkillSuggestion(ctx, ["stats-skill"]);
  recordSkillClaim(ctx, "stats-skill");

  const result = await def.execute("id", {}, undefined, undefined, ctx);
  const parsed = JSON.parse(result.content[0].text);

  // The session saw a claim but no detected read — not an adoption session.
  assert.equal(parsed.sessionHasSkillLoad, false, "claim-only session is not a skill-load session");
  assert.ok(parsed.skills && parsed.skills["stats-skill"], "session skills present");
  assert.ok(parsed.allTime["stats-skill"], "all-time entry for the recorded skill");
  assert.equal(parsed.allTime.filebacked.suggested, 11, "earlier durable entry preserved");
  assert.equal(typeof parsed.allTime["stats-skill"].lastAt, "string");
  assert.equal(typeof parsed.allTimeTotals.actual, "number", "totals expose the actual split");
  assert.equal(result.details.allTimeSkills >= 2, true, "details carry the all-time count");
  assert.equal(result.details.trackedSkills >= 1, true, "details still carry trackedSkills");

  recordSkillLoad(ctx, "stats-skill");
  const after = await def.execute("id", {}, undefined, undefined, ctx);
  const afterParsed = JSON.parse(after.content[0].text);
  assert.equal(
    afterParsed.sessionHasSkillLoad,
    true,
    "a detected read makes the session an adoption session",
  );
});

// ── per-session adoption records: role signal, store, monthly rollup ───────

/** Build one record with a sensible updatedAt (pure helper for the tests below). */
const rec = (sessionId, role, month, hadSkillLoad) => ({
  sessionId,
  role,
  month,
  hadSkillLoad,
  updatedAt: `${month}-01T00:00:00.000Z`,
});

await test("per-session records path resolves under the (temp) HOME braid dir", async () => {
  assert.equal(
    SESSIONS_FILE,
    join(FAKE_HOME, ".pi", "agent", "braid", "skills-sessions.jsonl"),
    "records file must live at <braid>/skills-sessions.jsonl",
  );
});

// ── session profiles: cwd → {name, hint} from the braid config home ─────────

/** Write the profile config the wiring tests below expect. */
function writeProfileConfig() {
  mkdirSync(BRAID_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      sessionProfiles: [{ name: "worker", cwd: join(FAKE_HOME, "projects") }],
    }),
    "utf-8",
  );
}

await test("braid config path resolves under the (temp) HOME braid dir", async () => {
  assert.equal(
    CONFIG_PATH,
    join(FAKE_HOME, ".pi", "agent", "braid", "config.json"),
    "session profile config must live at <braid>/config.json",
  );
});

await test("profile parsing: name gate, cwd shape, ~ expansion, invalid entries dropped", async () => {
  const profiles = parseSessionProfiles([
    { name: "alpha", cwd: join(FAKE_HOME, "ws", "alpha"), hint: "alpha hint" },
    { name: "beta", cwd: "~/ws/beta" },
    { name: "quiet", cwd: join(FAKE_HOME, "ws", "quiet") },
    { name: "bad name", cwd: join(FAKE_HOME, "ws", "nope") }, // spaces in name → dropped
    { name: "rel", cwd: "relative/path" }, // not absolute → dropped
    { name: "blank-hint", cwd: join(FAKE_HOME, "ws", "blank"), hint: "   " }, // blank hint → dropped
    { name: "typed-hint", cwd: join(FAKE_HOME, "ws", "typed"), hint: 7 }, // non-string hint → dropped
    null,
  ]);
  assert.deepEqual(
    profiles.map((p) => p.name),
    ["alpha", "beta", "quiet"],
    "only well-shaped entries survive",
  );
  assert.equal(profiles[1].cwd, join(FAKE_HOME, "ws", "beta"), "~ expands against HOME");
  assert.equal(profiles[0].hint, "alpha hint", "hint passes through byte-for-byte");
  assert.equal(profiles[2].hint, undefined, "hintless profile stays hintless");
  assert.deepEqual(parseSessionProfiles("nope"), [], "non-array input → no rules");
  assert.deepEqual(parseSessionProfiles(undefined), []);
});

await test("profile resolution: first match wins, boundary-safe, neutral default", async () => {
  const profiles = parseSessionProfiles([
    { name: "alpha", cwd: join(FAKE_HOME, "ws", "alpha"), hint: "A" },
    { name: "beta", cwd: "~/ws/beta" },
  ]);
  assert.deepEqual(resolveSessionProfile(join(FAKE_HOME, "ws", "alpha"), profiles), {
    name: "alpha",
    hint: "A",
  });
  assert.deepEqual(
    resolveSessionProfile(join(FAKE_HOME, "ws", "alpha", "briefs"), profiles),
    { name: "alpha", hint: "A" },
    "subdirs of a profile root match",
  );
  assert.deepEqual(
    resolveSessionProfile(join(FAKE_HOME, "ws", "alpha-lookalike"), profiles),
    { name: NEUTRAL_SESSION_PROFILE },
    "sibling directory must not match by prefix accident",
  );
  assert.deepEqual(
    resolveSessionProfile(join(FAKE_HOME, "ws", "beta", "sub"), profiles),
    { name: "beta" },
    "a hintless match carries no hint",
  );
  assert.deepEqual(resolveSessionProfile(join(FAKE_HOME, "somewhere", "else"), profiles), {
    name: NEUTRAL_SESSION_PROFILE,
  });
  assert.deepEqual(resolveSessionProfile(undefined, profiles), {
    name: NEUTRAL_SESSION_PROFILE,
  });
  assert.deepEqual(resolveSessionProfile("", []), { name: NEUTRAL_SESSION_PROFILE });
  assert.deepEqual(
    resolveSessionProfile(join(FAKE_HOME, "ws", "alpha"), []),
    { name: NEUTRAL_SESSION_PROFILE },
    "defaults: no profiles → everyone neutral",
  );
});

await test("the config home is read fresh; missing or malformed → no profiles", async () => {
  mkdirSync(BRAID_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      sessionProfiles: [{ name: "alpha", cwd: join(FAKE_HOME, "ws", "alpha"), hint: "A" }],
    }),
    "utf-8",
  );
  assert.equal(readSessionProfiles().length, 1, "config home read");
  writeFileSync(CONFIG_PATH, "{ not json", "utf-8");
  assert.deepEqual(readSessionProfiles(), [], "malformed → no profiles");
  rmSync(CONFIG_PATH, { force: true });
  assert.deepEqual(readSessionProfiles(), [], "missing → no profiles");
});

await test("monthOf is local-time YYYY-MM; rollup window rolls over the year", async () => {
  assert.equal(monthOf(new Date(2026, 0, 15)), "2026-01");
  assert.equal(monthOf(new Date(2026, 10, 3)), "2026-11");
  const rollup = computeMonthlyRollup([], new Date(2026, 0, 15));
  assert.deepEqual(
    Object.keys(rollup),
    ["2026-01", "2025-12", "2025-11"],
    "current month first, then the two previous",
  );
});

await test("append-only store upserts by sessionId at fold time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sr-store-"));
  const store = join(dir, "skills-sessions.jsonl");
  appendSessionRecord(rec("s1", "worker", "2026-08", false), store);
  appendSessionRecord(rec("s2", "orchestrator", "2026-08", false), store);
  // same session later: a load happened, month rolled over
  appendSessionRecord(rec("s1", "worker", "2026-09", true), store);

  const raw = readSessionRecords(store);
  assert.equal(raw.length, 3, "append-only file keeps every line");
  const folded = foldSessionRecords(raw);
  assert.equal(folded.length, 2, "one logical record per session");
  const s1 = folded.find((r) => r.sessionId === "s1");
  assert.equal(s1.hadSkillLoad, true, "hadSkillLoad ORs across appends");
  assert.equal(s1.month, "2026-09", "latest month wins (the load month)");
  assert.equal(s1.updatedAt, "2026-09-01T00:00:00.000Z", "newest timestamp kept");
  const s2 = folded.find((r) => r.sessionId === "s2");
  assert.equal(s2.hadSkillLoad, false);
  assert.equal(s2.month, "2026-08");
  rmSync(dir, { recursive: true, force: true });
});

await test("record normalization: names pass, legacy role strings keep folding, junk → neutral", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sr-normalize-"));
  const store = join(dir, "skills-sessions.jsonl");
  appendFileSync(
    store,
    [
      JSON.stringify(rec("n-alpha", "alpha", "2026-09", false)),
      JSON.stringify(rec("n-legacy-worker", "worker", "2026-09", false)),
      JSON.stringify(rec("n-legacy-orch", "orchestrator", "2026-09", false)),
      JSON.stringify(rec("n-garbage-num", 123, "2026-09", false)),
      JSON.stringify(rec("n-garbage-text", "two words", "2026-09", false)),
      JSON.stringify(rec("n-empty", "", "2026-09", false)),
      JSON.stringify({ sessionId: "n-missing", month: "2026-09", hadSkillLoad: false }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const byId = new Map(
    foldSessionRecords(readSessionRecords(store)).map((r) => [r.sessionId, r.role]),
  );
  assert.equal(byId.get("n-alpha"), "alpha", "profile names pass through");
  assert.equal(byId.get("n-legacy-worker"), "worker", "legacy role strings keep folding as-is");
  assert.equal(byId.get("n-legacy-orch"), "orchestrator", "legacy role strings keep folding as-is");
  assert.equal(byId.get("n-garbage-num"), NEUTRAL_SESSION_PROFILE);
  assert.equal(byId.get("n-garbage-text"), NEUTRAL_SESSION_PROFILE);
  assert.equal(byId.get("n-empty"), NEUTRAL_SESSION_PROFILE);
  assert.equal(byId.get("n-missing"), NEUTRAL_SESSION_PROFILE);
  rmSync(dir, { recursive: true, force: true });
});

await test("store reader is tolerant: torn lines, blank lines, garbage files, missing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sr-tolerant-"));
  const store = join(dir, "skills-sessions.jsonl");
  appendSessionRecord(rec("ok1", "worker", "2026-09", false), store);
  appendFileSync(store, "{ torn line\n", "utf-8");
  appendFileSync(store, "\n", "utf-8");
  appendSessionRecord(rec("ok2", "orchestrator", "2026-09", true), store);
  assert.equal(readSessionRecords(store).length, 2, "corrupt/blank lines skipped, valid kept");

  const garbage = join(dir, "garbage.jsonl");
  writeFileSync(garbage, "not json at all\n", "utf-8");
  assert.deepEqual(readSessionRecords(garbage), [], "garbage file reads as empty");
  assert.deepEqual(
    readSessionRecords(join(dir, "does-not-exist.jsonl")),
    [],
    "missing file reads as empty",
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("monthly rollup math: 3-month window, profile buckets, rate rounding, neutral excluded", async () => {
  const now = new Date(2026, 8, 9, 12, 0, 0); // Sep 9 2026, local
  const records = [
    rec("w1", "alpha", "2026-09", true),
    rec("w2", "alpha", "2026-09", false),
    rec("o1", "beta", "2026-09", true),
    rec("w3", "alpha", "2026-08", true),
    rec("o2", "beta", "2026-08", false),
    rec("w4", "alpha", "2026-07", true),
    rec("w5", "alpha", "2026-07", false),
    rec("w5b", "alpha", "2026-07", false),
    rec("w6", "alpha", "2026-06", true), // outside the window
    rec("x1", NEUTRAL_SESSION_PROFILE, "2026-09", true), // excluded from the rollup
  ];
  const rollup = computeMonthlyRollup(records, now);
  assert.deepEqual(rollup["2026-09"].alpha, {
    sessions: 2,
    sessionsWithLoad: 1,
    adoptionRate: 0.5,
  });
  assert.deepEqual(rollup["2026-09"].beta, {
    sessions: 1,
    sessionsWithLoad: 1,
    adoptionRate: 1,
  });
  assert.deepEqual(rollup["2026-08"].alpha, { sessions: 1, sessionsWithLoad: 1, adoptionRate: 1 });
  assert.deepEqual(rollup["2026-08"].beta, {
    sessions: 1,
    sessionsWithLoad: 0,
    adoptionRate: 0,
  });
  assert.deepEqual(
    rollup["2026-07"].alpha,
    { sessions: 3, sessionsWithLoad: 1, adoptionRate: 0.33 },
    "rate rounds to 2 decimals",
  );
  assert.equal(rollup["2026-06"], undefined, "months outside the window are not reported");
  assert.equal(
    rollup["2026-09"][NEUTRAL_SESSION_PROFILE],
    undefined,
    "neutral bucket excluded from the rollup",
  );

  const up = computeMonthlyRollup(
    [
      rec("a", "alpha", "2026-09", true),
      rec("b", "alpha", "2026-09", true),
      rec("c", "alpha", "2026-09", false),
    ],
    now,
  );
  assert.equal(up["2026-09"].alpha.adoptionRate, 0.67, "2/3 rounds up");
});

await test("agent-loop wiring: start record once per session, detected read flips hadSkillLoad", async () => {
  writeProfileConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = {
    sessionManager: { getSessionId: () => "sess-e2e-worker" },
    cwd: join(FAKE_HOME, "projects", "agents", "pi-braid"),
  };
  await pi.handlers.before_agent_start({ prompt: "just talk" }, ctx);
  let mine = readSessionRecords(SESSIONS_FILE).filter((r) => r.sessionId === "sess-e2e-worker");
  assert.equal(mine.length, 1, "start record written on the first turn");
  assert.equal(mine[0].role, "worker", "project checkout cwd → worker");
  assert.equal(mine[0].hadSkillLoad, false, "no load yet");

  await pi.handlers.before_agent_start({ prompt: "talk again" }, ctx);
  mine = readSessionRecords(SESSIONS_FILE).filter((r) => r.sessionId === "sess-e2e-worker");
  assert.equal(mine.length, 1, "second turn does not duplicate the start record");

  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: "/tmp/e2e-skill/SKILL.md" },
      content: [{ type: "text", text: "---\nname: e2e-skill\n---\nbody" }],
    },
    ctx,
  );
  mine = readSessionRecords(SESSIONS_FILE).filter((r) => r.sessionId === "sess-e2e-worker");
  assert.equal(mine.length, 2, "detected read appends a load record");
  assert.equal(mine[1].hadSkillLoad, true, "load record carries hadSkillLoad");
  const folded = foldSessionRecords(readSessionRecords(SESSIONS_FILE)).find(
    (r) => r.sessionId === "sess-e2e-worker",
  );
  assert.equal(folded.hadSkillLoad, true, "folded record counts the session as an adoption");
});

await test("a LOADED probe claim never marks the session as an adoption", async () => {
  writeProfileConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = {
    sessionManager: { getSessionId: () => "sess-claim-only" },
    cwd: join(FAKE_HOME, ".pi", "agent", "braid", "orchestrator"),
  };
  await pi.handlers.before_agent_start({ prompt: "hello there" }, ctx);
  recordSkillClaim(ctx, "some-skill");
  const folded = foldSessionRecords(readSessionRecords(SESSIONS_FILE)).find(
    (r) => r.sessionId === "sess-claim-only",
  );
  assert.ok(folded, "start record exists");
  assert.equal(folded.role, NEUTRAL_SESSION_PROFILE, "cwd outside every profile → neutral");
  assert.equal(folded.hadSkillLoad, false, "verbal claim alone must not flip the flag");
});

await test("a ctx without session data records nothing and never throws", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  const before = readSessionRecords(SESSIONS_FILE).length;
  await pi.handlers.before_agent_start({ prompt: "no session manager here" }, fakeCtx());
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: "/tmp/orphan/SKILL.md" },
      content: [{ type: "text", text: "---\nname: orphan-skill\n---\nbody" }],
    },
    fakeCtx(),
  );
  assert.equal(readSessionRecords(SESSIONS_FILE).length, before, "no records without a session id");
});

await test("skill_stats surfaces the monthly rollup additively", async () => {
  const { default: skillsToolExtension } =
    await import("../../../dist/extensions/core/skills-tool/index.js?sr-monthly");
  const pi = fakePi();
  skillsToolExtension(pi);
  const def = pi.tools.find((t) => t.name === "skill_stats");
  assert.ok(def, "skill_stats tool registered");

  const before = JSON.parse(
    (await def.execute("id", {}, undefined, undefined, fakeCtx())).content[0].text,
  );
  // Shape: 3 months, current first, per-profile buckets with the 3 fields; legacy fields untouched.
  assert.ok(before.monthly, "monthly section present");
  const monthKeys = Object.keys(before.monthly);
  assert.equal(monthKeys.length, 3, "current + previous 2 months");
  assert.equal(monthKeys[0], monthOf(new Date()), "current month is the first key");
  for (const key of monthKeys) {
    for (const profile of Object.keys(before.monthly[key])) {
      assert.notEqual(profile, NEUTRAL_SESSION_PROFILE, "neutral bucket stays out of the rollup");
      assert.deepEqual(
        Object.keys(before.monthly[key][profile]).sort(),
        ["adoptionRate", "sessions", "sessionsWithLoad"],
        "profile bucket fields",
      );
    }
  }
  for (const key of ["sessionHasSkillLoad", "skills", "allTime", "allTimeTotals"]) {
    assert.ok(key in before, `backward-compat field ${key} still present`);
  }

  // Deltas: one alpha-with-load, one beta-without, one neutral in the current month.
  const current = monthOf(new Date());
  const beforeAlpha = before.monthly[current].alpha ?? { sessions: 0, sessionsWithLoad: 0 };
  const beforeBeta = before.monthly[current].beta ?? { sessions: 0, sessionsWithLoad: 0 };
  appendSessionRecord(rec("roll-alpha", "alpha", current, true), SESSIONS_FILE);
  appendSessionRecord(rec("roll-beta", "beta", current, false), SESSIONS_FILE);
  appendSessionRecord(rec("roll-neutral", NEUTRAL_SESSION_PROFILE, current, true), SESSIONS_FILE);
  const result = await def.execute("id", {}, undefined, undefined, fakeCtx());
  const after = JSON.parse(result.content[0].text);
  assert.equal(after.monthly[current].alpha.sessions, beforeAlpha.sessions + 1);
  assert.equal(after.monthly[current].alpha.sessionsWithLoad, beforeAlpha.sessionsWithLoad + 1);
  assert.equal(after.monthly[current].beta.sessions, beforeBeta.sessions + 1);
  assert.equal(after.monthly[current].beta.sessionsWithLoad, beforeBeta.sessionsWithLoad);
  assert.equal(
    after.monthly[current][NEUTRAL_SESSION_PROFILE],
    undefined,
    "neutral bucket stays out",
  );
  assert.ok(result.details.monthly, "details carry the monthly rollup too");
});

// ── cleanup ───────────────────────────────────────────────────────────────────

try {
  chmodSync(BRAID_DIR, 0o755);
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
