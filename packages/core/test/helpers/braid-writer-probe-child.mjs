/**
 * braid-writer-probe-child.mjs — child driver for test-braid-home-containment.mjs.
 *
 * Drives one durable write per census family against the built dist and prints
 * one JSON line: per family, whether the attempt threw and whether it logged a
 * warning or an error, plus every unhandled rejection the run produced. The
 * parent owns the tree assertions (project, pinned root, default root); this
 * driver only performs the writes.
 *
 * The families are the census sweep of the precomputed path constants: the
 * write-decision log, the episode store, the scratchpad, the semantic store,
 * the orchestrator lock and worker registries, checkpoints, the error log, the
 * evidence pool, the degradation state, the analytics metrics, the consolidated
 * hints, the workspace snapshots and the two skills adoption stores.
 *
 * The workspace-snapshot drive needs one touched file: it is created in a
 * throwaway directory the parent hands over as the workspace root, never in the
 * project the child runs in, so "the project gained nothing" stays exact.
 *
 * Not a test: lives outside test/runtime so the runner does not execute it.
 *
 * Usage: node braid-writer-probe-child.mjs <distRoot> <fixtureRoot>
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The bus never awaits a listener, so a listener that drops its promise turns
// a refused write into an unhandled rejection. Collect them so the parent can
// assert the refusal was reported, not thrown past every handler.
const unhandled = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
});

const [distRoot, fixtureRoot] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(distRoot, rel)).href);
const logger = await load("lib/core/logger.js");

const cwd = process.cwd();
const ctx = {
  cwd,
  mode: "probe",
  hasUI: false,
  sessionManager: {
    getSessionId: () => "writer-probe-session",
    getSessionFile: () => join(tmpdir(), "writer-probe-session.jsonl"),
    getBranch: () => [],
  },
};

const FAMILIES = {
  async "write-log"() {
    const { logWriteDecision } = await load("lib/memory/write-log.js");
    logWriteDecision({
      site: "probe",
      decision: { action: "accept" },
      task: "writer probe",
      solution: "drive one durable write per family",
      mode: "enforce",
    });
  },
  async episodes() {
    const m = await load("extensions/memory/three-memory-stores/episodes-disk.js");
    m.queueEpisodeAppend({
      id: "ep_probe",
      ts: Date.now(),
      task: "writer probe",
      solution: "drive the episode store",
      outcome: "success",
    });
    await m.flushEpisodeAppends();
  },
  async scratchpad() {
    const m = await load("extensions/memory/scratchpad/persistence.js");
    const slug = m.projectSlugFromCwd(cwd);
    await m.saveScratchpadToDisk(m.createScratchpad("writer probe", slug));
  },
  async semantic() {
    const { saveMemory } = await load("lib/memory/storage.js");
    await saveMemory({ version: 1, memories: [], lastConsolidation: 0, turnCount: 0 });
  },
  async locks() {
    const { acquireLock } = await load("lib/orchestrator/locks.js");
    acquireLock(["probe.ts"], "w1", "probe-branch", cwd);
  },
  async workers() {
    const { writeWorkers } = await load("lib/orchestrator/workers.js");
    writeWorkers({ version: 1, workers: {} }, cwd);
  },
  async checkpoint() {
    const { createCheckpoint } = await load("lib/state/state-checkpoint.js");
    await createCheckpoint(ctx, 999, "writer-probe-session");
  },
  async errors() {
    const mod = await load("extensions/self/error-tracking/index.js");
    const handlers = [];
    const pi = {
      on: (event, handler) => handlers.push([event, handler]),
      registerTool: () => {},
      sendMessage: () => {},
    };
    mod.default(pi);
    const turnEnd = handlers.find(([event]) => event === "turn_end");
    if (!turnEnd) throw new Error("no turn_end handler registered");
    // The bus entry point first: its listener must drain the capture promise
    // (a rejection here is the silent crash shape, not a refusal), and the
    // refusal must reach the log. Driven before the awaited turn_end path so
    // a throw there cannot skip it.
    const { eventBus } = await load("lib/events/event-bus.js");
    eventBus.emit({
      type: "tool_error",
      toolName: "bash",
      error: "writer probe failure",
      turn: 1,
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The awaited entry point (the family's loud path on a refused store).
    await turnEnd[1]({ toolResults: [{ isError: true, toolName: "bash" }] });
  },
  async "evidence-pool"() {
    const { addEvidence } = await load("lib/store/evidence-pool.js");
    addEvidence(ctx, "writer probe claim", "retrieved", "writer probe evidence");
  },
  async degradation() {
    const m = await load("lib/detection/degradation-detector.js");
    m.recordTurnMetrics({ healthcheckScore: 90, errorRate: 0, toolSuccessRate: 1 });
    await m.saveMetrics();
  },
  async metrics() {
    const mod = await load("extensions/heartbeat/analytics/index.js");
    const handlers = [];
    const pi = {
      on: (event, handler) => handlers.push([event, handler]),
      registerCommand: () => {},
      registerTool: () => {},
      sendMessage: () => {},
    };
    mod.default(pi);
    const call = (event, payload) => handlers.find(([e]) => e === event)?.[1](payload, ctx);
    await call("session_start", {});
    await call("tool_execution_start", { toolCallId: "probe", toolName: "bash" });
    await call("tool_execution_end", { toolCallId: "probe", toolName: "bash", isError: false });
    await call("session_shutdown", {});
    await new Promise((resolve) => setTimeout(resolve, 250));
  },
  async hints() {
    const m = await load("lib/events/consolidation-channel.js");
    m.enqueueCandidate({
      episodeId: "ep_probe",
      task: "probe the consolidation hint write path",
      outcome: "success",
      quality: 0.9,
      valueScore: 0.9,
      confidenceScore: 0.9,
      noveltyScore: 0.9,
      consolidationScore: 0.95,
      functionalSOP: ["read the file", "patch the call site", "run the suite"],
      strategicSOP: "drive the family",
      queuedAt: Date.now(),
      status: "pending",
    });
    await m.processConsolidationTick(ctx);
  },
  async snapshot() {
    const m = await load("lib/state/workspace-snapshot.js");
    const workspaceRoot = fixtureRoot ? mkdtempSync(join(fixtureRoot, "probe-")) : cwd;
    const touched = join(workspaceRoot, "touched.txt");
    writeFileSync(touched, "probe\n");
    await m.captureSnapshot(ctx, "writer probe", [touched], workspaceRoot, undefined);
  },
  async "skills-sessions"() {
    const m = await load("extensions/core/skills-tool/session-records.js");
    m.recordSessionStart(ctx);
  },
  async "skills-usage"() {
    const m = await load("extensions/core/skills-tool/auto-inject.js");
    m.recordSkillLoad(ctx, "probe-skill");
  },
  async tags() {
    const { registerToolCallHandler } = await load(
      "extensions/enforcement/handlers/register-tool-call.js",
    );
    const handlers = [];
    const pi = {
      on: (event, handler) => handlers.push([event, handler]),
      registerTool: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
    };
    registerToolCallHandler(pi);
    const toolCall = handlers.find(([event]) => event === "tool_call");
    if (!toolCall) throw new Error("no tool_call handler registered");
    await toolCall[1](
      { toolName: "context_navigate", input: { action: "tag", name: "probe-tag" } },
      ctx,
    );
  },
};

const rows = [];
for (const [family, drive] of Object.entries(FAMILIES)) {
  const before = logger.getLogBuffer().length;
  let threw = false;
  let error = null;
  try {
    await drive();
  } catch (err) {
    threw = true;
    error = err instanceof Error ? err.message : String(err);
  }
  const emitted = logger
    .getLogBuffer()
    .slice(before)
    .filter((entry) => entry.level === "warn" || entry.level === "error");
  rows.push({
    family,
    threw,
    error,
    refused: threw || emitted.length > 0,
    level: emitted[0]?.level ?? null,
  });
}

process.stdout.write(JSON.stringify({ cwd, rows, unhandled }) + "\n");
