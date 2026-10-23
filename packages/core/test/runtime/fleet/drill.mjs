/**
 * The fleet crash drill and its companions.
 *
 * One question decides the fleet: after a SIGKILL, is any completed effect
 * repeated, and is any node silently lost? Every arm here answers it with two
 * instruments that cannot be satisfied by editing each other - the world file
 * the node writes, and the journal the supervisor keeps.
 *
 * Arms:
 *   crash    kill the supervisor mid-turn, restart, compare (scripted driver by
 *            default; `--driver rpc` uses a real pi session and a real model)
 *   steer    measure where a Tier A steer lands inside a live turn
 *   rss      resident set of the supervisor plus three open sessions
 *   nonstall one node parked on a question, the other two still turning
 *
 * With no arguments the scripted `crash` arms run, both the guarded and the
 * naive one; the others are opt-in because they cost a real model call and a
 * real wait.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { groupIsAlive, residentMb } from "../../../scripts/fleet/procs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = resolve(HERE, "../../../scripts/fleet/supervisor.mjs");
const CLI = resolve(HERE, "../../../scripts/fleet/cli.mjs");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  [ok] ${name}${detail ? ` (${detail})` : ""}`);
    return true;
  }
  failed += 1;
  console.log(`  [fail] ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function freshRoot(label) {
  return mkdtempSync(join(tmpdir(), `fleet-${label}-`));
}

function extensionPath() {
  if (process.env.PI_FLEET_EXTENSION) return process.env.PI_FLEET_EXTENSION;
  const home = process.env.HOME;
  if (!home) return null;
  const candidate = join(home, ".pi/agent/npm/node_modules/pi-braid-providers/index.ts");
  try {
    readFileSync(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const MODEL = process.env.PI_FLEET_MODEL ?? "opencode-go/deepseek-v4.1-flash";

const spawnedSupervisors = new Set();

/** Never leave a supervisor behind when an arm throws. */
function killSpawned() {
  for (const child of spawnedSupervisors) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  spawnedSupervisors.clear();
}

function startSupervisor(root, extraArgs = []) {
  const logPath = join(root, "supervisor.log");
  const out = spawn(process.execPath, [SUPERVISOR, "--root", root, ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  // The log is rewritten on every chunk, not on exit: a supervisor killed by
  // the drill never reaches an exit handler, and its last words are the ones
  // worth reading.
  const chunks = [];
  const flush = () => writeFileSync(logPath, chunks.join(""));
  out.stdout.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
    flush();
  });
  out.stderr.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
    flush();
  });
  spawnedSupervisors.add(out);
  out.once("exit", () => spawnedSupervisors.delete(out));
  return out;
}

async function waitFor(label, predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function journalView(root) {
  const journal = openJournal(root, {});
  try {
    const nodes = journal.listNodes();
    return nodes.map((node) => {
      const turns = journal.turnsFor(node.node_id);
      const last = turns.at(-1) ?? null;
      return {
        node,
        turns,
        last,
        effects: last ? journal.effects(last.turn_id) : [],
        // Completed effects across every turn, which is what "no effect is
        // repeated" is actually about.
        allEffects: turns.flatMap((turn) => journal.effects(turn.turn_id)),
        asks: journal.openAsks(node.node_id),
        lease: journal.liveLease(node.node_id),
      };
    });
  } finally {
    journal.close();
  }
}

function worldLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function addScriptedNode(root, { nodeId, charter, steps, worldFile }) {
  const journal = openJournal(root, { driver: "scripted" });
  try {
    const charterPath = join(root, `${nodeId}.charter.md`);
    writeFileSync(charterPath, charter);
    journal.addNode({
      nodeId,
      parentId: null,
      projectRoot: root,
      charterPath,
      driver: "scripted",
      driverConfig: { steps, worldFile },
    });
    return charterPath;
  } finally {
    journal.close();
  }
}

// ── arms ────────────────────────────────────────────────────────────────────

const CRASH_STEPS = [
  { op: "append", text: "effect-1" },
  { op: "append", text: "effect-2" },
  { op: "sleep", ms: 3_000 },
  { op: "done" },
];

/**
 * Kill the supervisor while a third tool call is in flight and two effects are
 * already recorded, then restart it. The guarded arm resumes from the journal;
 * the naive arm reopens the session and replays the turn.
 */
async function crashArm({ naive = false, driver = "scripted" } = {}) {
  const label = `crash-${driver}-${naive ? "naive" : "guarded"}`;
  console.log(`\n== ${label} ==`);
  const root = freshRoot(label);
  const worldFile = join(root, "world.log");
  const charter = "Run the two recorded effects, then hold the turn open.";
  const nodeId = "n1-crash";

  if (driver === "scripted") {
    addScriptedNode(root, { nodeId, charter, steps: CRASH_STEPS, worldFile });
  } else {
    const journal = openJournal(root, { driver: "rpc" });
    try {
      const charterPath = join(root, `${nodeId}.charter.md`);
      writeFileSync(
        charterPath,
        [
          `Run exactly these three bash tool calls, one per call, in this order, and nothing else:`,
          `1) printf 'effect-1\\n' >> ${worldFile}`,
          `2) printf 'effect-2\\n' >> ${worldFile}`,
          `3) sleep 45`,
          `After the third command finishes, reply with the single line FLEET-DONE.`,
        ].join("\n"),
      );
      journal.addNode({ nodeId, parentId: null, projectRoot: root, charterPath, driver: "rpc" });
    } finally {
      journal.close();
    }
  }

  const supArgs = ["--driver", driver];
  if (driver === "rpc") {
    const extension = extensionPath();
    if (extension) supArgs.push("--extension", extension);
    supArgs.push("--model", MODEL);
  }
  let supervisor = startSupervisor(root, supArgs);

  // The kill window: two effects complete, the third call has started.
  const beforeKill = await waitFor(
    "two completed effects and one in flight",
    () => {
      const [view] = journalView(root);
      if (!view?.last) return null;
      const effects = view.effects;
      const completed = effects.filter((effect) => effect.state === "completed").length;
      const attempted = effects.filter((effect) => effect.state === "attempted").length;
      return completed >= 2 && attempted >= 1 ? view : null;
    },
    { timeoutMs: driver === "rpc" ? 180_000 : 20_000, intervalMs: driver === "rpc" ? 250 : 20 },
  );

  const sessionBefore = beforeKill.node.session_id;
  const turnBefore = beforeKill.last.turn_id;
  const effectsBefore = beforeKill.effects.map((effect) => ({
    seq: effect.seq,
    tool: effect.tool_name,
    state: effect.state,
    key: effect.idempotency_key,
  }));
  const worldBefore = worldLines(worldFile);
  const childBefore = beforeKill.last.child_pgid;

  process.kill(supervisor.pid, "SIGKILL");
  await new Promise((resolveExit) => supervisor.once("exit", resolveExit));
  console.log(`  killed supervisor pid ${supervisor.pid} at turn ${turnBefore} (effects ${JSON.stringify(effectsBefore)})`);
  if (driver === "scripted" && childBefore) {
    console.log(`  process group recorded for the turn: ${childBefore}`);
  }

  const restartArgs = [...supArgs];
  if (naive) restartArgs.push("--naive");
  supervisor = startSupervisor(root, restartArgs);

  await waitFor(
    "the node to settle after the restart",
    () => {
      const [view] = journalView(root);
      if (!view) return null;
      const turns = view.turns;
      const last = turns.at(-1);
      if (turns.length < 2) return null;
      if (last.state === "in_progress") return null;
      return view;
    },
    { timeoutMs: driver === "rpc" ? 240_000 : 30_000, intervalMs: 100 },
  );
  await sleep(300);

  const [after] = journalView(root);
  const worldAfter = worldLines(worldFile);
  const recoveryEffects = after.allEffects.filter((effect) => effect.turn_id !== turnBefore);
  const fenced = JSON.parse(
    (() => {
      const journal = openJournal(root, {});
      try {
        return journal.meta().fences ?? "[]";
      } finally {
        journal.close();
      }
    })(),
  );

  console.log(`  session before ${sessionBefore} / after ${after.node.session_id}`);
  console.log(`  turns ${after.turns.map((turn) => `${turn.turn_id}:${turn.kind}:${turn.state}`).join(" ")}`);
  console.log(`  effects per turn ${after.turns.map((turn) => `${turn.turn_id}[${after.allEffects.filter((effect) => effect.turn_id === turn.turn_id).map((effect) => `${effect.seq}:${effect.state}`).join(",")}]`).join(" ")}`);
  console.log(`  world before ${JSON.stringify(worldBefore)} after ${JSON.stringify(worldAfter)}`);
  console.log(
    `  effects after the restart: ${
      recoveryEffects.map((effect) => `seq ${effect.seq} ${effect.tool_name} ${effect.state}: ${String(effect.args_json).slice(0, 120)}`).join(" | ") || "(none)"
    }`,
  );
  if (fenced.length > 0) console.log(`  fences ${JSON.stringify(fenced)}`);

  const completedAfter = after.allEffects.filter((effect) => effect.state === "completed");
  const duplicateWorld = worldAfter.length !== new Set(worldAfter).size;

  const interruptedCompleted = completedAfter.filter((effect) => effect.turn_id === turnBefore);
  const repeatedArguments = completedAfter
    .filter((effect) => effect.turn_id !== turnBefore)
    .filter((effect) =>
      interruptedCompleted.some((original) => original.args_json === effect.args_json && original.tool_name === effect.tool_name),
    );

  if (naive) {
    // The control arm. With the scripted driver the replay is deterministic:
    // the same instruction produces the same effects, so duplication shows up
    // in both instruments. With a real model the reopened session's own
    // history is a second guard the naive path does not remove, so what the
    // model does is measured and reported rather than assumed.
    if (driver === "scripted") {
      check(`${label}: the naive replay duplicates an effect in the world`, duplicateWorld, `world lines ${worldAfter.length}`);
      check(
        `${label}: the naive replay leaves more than the two original effects recorded`,
        completedAfter.length > 2,
        `completed rows ${completedAfter.length}`,
      );
    } else {
      check(
        `${label}: the naive path really did re-send the interrupted turn`,
        after.turns.some((turn) => turn.kind === "naive-replay"),
        after.turns.map((turn) => turn.kind).join(","),
      );
      console.log(
        `  control observation: a real model ${duplicateWorld ? "DID repeat an effect" : "did not repeat an effect"} after the naive re-prompt (world lines ${worldAfter.length})`,
      );
      const agrees = duplicateWorld === (repeatedArguments.length > 0);
      check(
        `${label}: the world file agrees with the journal about repetition`,
        agrees,
        `duplicateWorld ${duplicateWorld}, repeated arguments ${repeatedArguments.length}`,
      );
    }
  } else {
    check(`${label}: no completed effect is repeated in the world`, !duplicateWorld, `world lines ${worldAfter.length}`);
    check(
      `${label}: the interrupted turn still records exactly its two completed effects`,
      interruptedCompleted.length === 2,
      `completed rows ${interruptedCompleted.length}`,
    );
    check(
      `${label}: no later turn repeats a recorded effect's arguments`,
      repeatedArguments.length === 0,
      repeatedArguments.map((effect) => String(effect.args_json).slice(0, 60)).join(" | ") || "none",
    );
    check(`${label}: the node's session id is unchanged`, sessionBefore === after.node.session_id, `${sessionBefore}`);
    check(`${label}: the node is not lost`, after.turns.length >= 2 && after.node.state !== "waiting_on_child", after.node.state);
    check(
      `${label}: the interrupted turn recorded its in-flight effect as unknown`,
      after.allEffects.some((effect) => effect.turn_id === turnBefore && effect.state === "unknown"),
      after.allEffects.filter((effect) => effect.turn_id === turnBefore).map((effect) => effect.state).join(","),
    );
    if (driver === "scripted") {
      check(`${label}: the orphan group is gone`, childBefore ? !groupIsAlive(childBefore) : true, `pgid ${childBefore ?? "-"}`);
    } else {
      check(
        `${label}: the dead predecessor's child was fenced`,
        fenced.length > 0 && fenced.every((fence) => fence.aliveAfter === false),
        JSON.stringify(fenced.map((fence) => ({ pgid: fence.pgid, killed: fence.killed, aliveAfter: fence.aliveAfter }))),
      );
    }
  }

  supervisor.kill("SIGTERM");
  await new Promise((resolveExit) => supervisor.once("exit", resolveExit));
  return { root, worldAfter, effectsBefore, sessionBefore };
}

async function steerArm() {
  console.log("\n== steer ==");
  const root = freshRoot("steer");
  const nodeId = "n1-steer";
  const journal = openJournal(root, { driver: "rpc" });
  try {
    const charterPath = join(root, `${nodeId}.charter.md`);
    writeFileSync(
      charterPath,
      [
        `Run exactly one bash tool call: ls -la ${root} >/dev/null && sleep 10 && echo first-call-done.`,
        `When it finishes, the charter is complete: reply with the single line FIRST-RESULT and stop.`,
      ].join("\n"),
    );
    journal.addNode({ nodeId, parentId: null, projectRoot: root, charterPath, driver: "rpc" });
  } finally {
    journal.close();
  }
  const args = ["--driver", "rpc", "--model", MODEL];
  const extension = extensionPath();
  if (extension) args.push("--extension", extension);
  const supervisor = startSupervisor(root, args);

  const inFlight = await waitFor(
    "a tool call to start",
    () => {
      const [view] = journalView(root);
      const effect = view?.effects?.find((row) => row.state === "attempted");
      return effect ?? null;
    },
    { timeoutMs: 180_000, intervalMs: 100 },
  );
  console.log(`  tool call in flight: seq ${inFlight.seq} ${inFlight.tool_name}`);

  const steerText = "The charter is cancelled. Reply with exactly the token STEER-MARK-77 and nothing else.";
  const sentAt = Date.now();
  const reply = await cliInject(root, nodeId, steerText);
  console.log(`  inject reply ${JSON.stringify(reply)} after ${Date.now() - sentAt} ms`);

  await waitFor(
    "the turn to settle",
    () => {
      const [view] = journalView(root);
      const last = view?.last;
      return last && last.state !== "in_progress" ? view : null;
    },
    { timeoutMs: 240_000, intervalMs: 100 },
  );
  await sleep(500);

  const [view] = journalView(root);
  const delivered = (() => {
    const reopened = openJournal(root, {});
    try {
      return reopened.messages(nodeId);
    } finally {
      reopened.close();
    }
  })();
  const row = delivered.at(-1);
  console.log(`  inbox row ${JSON.stringify({ tier: row?.delivered_tier, turn: row?.delivered_turn_id, afterEffectSeq: row?.delivered_after_effect_seq, beforeRequestSeq: row?.delivered_before_request_seq })}`);

  // Position instrument: read the session file itself and locate the steer
  // message relative to the tool result of the call that was in flight.
  const sessionFile = view.node.session_file;
  const entries = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  const textOf = (message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join(" ");
  const toolResultIndex = messages.findIndex((message) => message.role === "toolResult");
  const steerIndex = messages.findIndex((message) => message.role === "user" && textOf(message).includes("STEER-MARK-77"));
  const markerIndex = messages.findIndex(
    (message, index) => index > steerIndex && message.role === "assistant" && textOf(message).includes("STEER-MARK-77"),
  );
  console.log(
    `  session positions: toolResult ${toolResultIndex}, steer ${steerIndex}, assistant-with-marker ${markerIndex} of ${messages.length} messages`,
  );
  console.log(
    `  messages: ${messages
      .map((message, index) => `${index}:${message.role}@${message.timestamp ?? "?"}:${textOf(message).slice(0, 50).replace(/\n/g, " ")}`)
      .join(" | ")}`,
  );

  const toolResultAt = messages[toolResultIndex]?.timestamp ?? 0;
  const steerAt = messages[steerIndex]?.timestamp ?? 0;
  const afterSteer = messages[steerIndex + 1];

  check("steer: the fleet recorded a Tier A delivery", row?.delivered_tier === "A", String(row?.delivered_tier));
  check(
    "steer: the message lands after the in-flight tool result and inside the same turn",
    toolResultIndex >= 0 && steerIndex > toolResultIndex && row?.delivered_turn_id === view.turns[0]?.turn_id,
    `toolResult ${toolResultIndex} < steer ${steerIndex}, turn ${row?.delivered_turn_id}`,
  );
  // The steer's own timestamp is when the message was created, not when it
  // entered the conversation: it is queued while the tool is still running and
  // delivered after that tool's result. Position is the delivery order, so the
  // gate reads the array; the reply only has to be generated after the steer
  // existed and after the tool finished.
  check(
    "steer: the next assistant message is produced after it, and the model saw it",
    Boolean(afterSteer) &&
      afterSteer.role === "assistant" &&
      toolResultAt > 0 &&
      steerAt > 0 &&
      afterSteer.timestamp >= Math.max(steerAt, toolResultAt),
    `toolResult@${toolResultAt}, steer queued@${steerAt}, reply@${afterSteer?.timestamp ?? "?"}`,
  );
  check(
    "steer: delivery is recorded against the turn that was running",
    row?.delivered_turn_id === view.turns[0]?.turn_id,
    `turn ${row?.delivered_turn_id}`,
  );
  console.log(
    `  observation: the reply after the steer was ${JSON.stringify(textOf(afterSteer ?? {}).slice(0, 120))}${
      markerIndex > steerIndex ? " and it carried the marker" : "; the model kept the charter's answer instead of the override"
    }`,
  );

  supervisor.kill("SIGTERM");
  await new Promise((resolveExit) => supervisor.once("exit", resolveExit));
  return { root, sessionFile };
}

async function cliInject(root, node, text, { token } = {}) {
  return new Promise((resolveReply) => {
    const argv = [CLI, "inject", node, text, "--root", root];
    if (token) argv.push("--token", token);
    const child = spawn(process.execPath, argv, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (out += chunk.toString("utf8")));
    child.once("exit", (code) => resolveReply({ code, out: out.trim() }));
  });
}

async function rssArm() {
  console.log("\n== rss ==");
  const root = freshRoot("rss");
  const nodeIds = ["n1-a", "n2-b", "n3-c"];
  for (const [index, nodeId] of nodeIds.entries()) {
    const journal = openJournal(root, { driver: "rpc" });
    try {
      const charterPath = join(root, `${nodeId}.charter.md`);
      writeFileSync(
        charterPath,
        `Run exactly one bash tool call: sleep 25. Then reply FLEET-DONE. Do not run anything else. (session ${index + 1})`,
      );
      journal.addNode({ nodeId, parentId: null, projectRoot: root, charterPath, driver: "rpc" });
    } finally {
      journal.close();
    }
  }
  const args = ["--driver", "rpc", "--model", MODEL, "--cap", "3"];
  const extension = extensionPath();
  if (extension) args.push("--extension", extension);
  const supervisor = startSupervisor(root, args);

  const samples = [];
  await waitFor(
    "three sessions open at once",
    async () => {
      const reply = await controlStatus(root);
      const childPids = reply?.data?.childPids ?? [];
      return childPids.length >= 3 ? reply.data : null;
    },
    { timeoutMs: 240_000, intervalMs: 1000 },
  );
  // Hold the sample while all three turns are streaming, then report the peak.
  for (let i = 0; i < 5; i += 1) {
    await sleep(1000);
    const reply = await controlStatus(root);
    if (reply?.ok) {
      const resident = residentMb([
        ...(reply.data.supervisors ?? []).map((row) => row.pid),
        ...(reply.data.childPids ?? []),
      ]);
      samples.push(resident.totalMb);
      console.log(`  sample ${i + 1}: ${resident.totalMb} MB over ${resident.pids.length} pids ${JSON.stringify(resident.pids)}`);
    }
  }
  const peak = Math.max(...samples, 0);
  check("rss: supervisor plus three open sessions stays under 700 MB", peak > 0 && peak < 700, `peak ${peak} MB`);
  supervisor.kill("SIGTERM");
  await new Promise((resolveExit) => supervisor.once("exit", resolveExit));
  return { root, peak, samples };
}

async function controlStatus(root) {
  return new Promise((resolveReply) => {
    const child = spawn(process.execPath, [CLI, "status", "--root", root, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (out += chunk.toString("utf8")));
    child.once("exit", () => {
      try {
        const data = JSON.parse(out);
        resolveReply({ ok: true, data, residents: data.resident?.pids });
      } catch {
        resolveReply(null);
      }
    });
  });
}

async function nonstallArm() {
  console.log("\n== nonstall ==");
  const root = freshRoot("nonstall");
  const worldFile = join(root, "world.log");
  addScriptedNode(root, {
    nodeId: "n1-parked",
    charter: "Park on a question.",
    steps: [{ op: "park", question: "Which target should this node write to?", defaultAnswer: "the default target" }],
    worldFile,
  });
  addScriptedNode(root, {
    nodeId: "n2-turning",
    charter: "Take messages and finish.",
    steps: [{ op: "append", text: "n2-work" }, { op: "text", text: "turn complete" }],
    worldFile,
  });
  addScriptedNode(root, {
    nodeId: "n3-turning",
    charter: "Take messages and finish.",
    steps: [{ op: "append", text: "n3-work" }, { op: "text", text: "turn complete" }],
    worldFile,
  });
  const supervisor = startSupervisor(root, ["--driver", "scripted", "--cap", "3"]);

  await waitFor(
    "the parked node to park",
    () => {
      const views = journalView(root);
      const parked = views.find((view) => view.node.node_id === "n1-parked");
      return parked?.asks.length > 0 ? views : null;
    },
    { timeoutMs: 20_000, intervalMs: 20 },
  );

  const turnsBefore = Object.fromEntries(journalView(root).map((view) => [view.node.node_id, view.node.turn_count]));
  for (let round = 0; round < 3; round += 1) {
    await cliInject(root, "n2-turning", `round ${round + 1}: continue`);
    await cliInject(root, "n3-turning", `round ${round + 1}: continue`);
    await sleep(250);
  }
  await waitFor(
    "the turning nodes to finish their extra turns",
    () => {
      const views = journalView(root);
      const n2 = views.find((view) => view.node.node_id === "n2-turning");
      const n3 = views.find((view) => view.node.node_id === "n3-turning");
      return n2?.node.turn_count >= turnsBefore["n2-turning"] + 3 && n3?.node.turn_count >= turnsBefore["n3-turning"] + 3
        ? views
        : null;
    },
    { timeoutMs: 20_000, intervalMs: 20 },
  );

  const views = journalView(root);
  const parked = views.find((view) => view.node.node_id === "n1-parked");
  const turning = views.filter((view) => view.node.node_id !== "n1-parked");
  const turnsAfter = Object.fromEntries(views.map((view) => [view.node.node_id, view.node.turn_count]));
  console.log(`  turns before ${JSON.stringify(turnsBefore)} after ${JSON.stringify(turnsAfter)}`);
  check("nonstall: the parked node stays parked", parked.node.state === "waiting_on_human", parked.node.state);
  check("nonstall: the parked node holds no lease", parked.lease === null, String(parked.lease));
  check(
    "nonstall: the parked node's turn count does not advance",
    turnsAfter["n1-parked"] === turnsBefore["n1-parked"],
    `${turnsBefore["n1-parked"]} -> ${turnsAfter["n1-parked"]}`,
  );
  check(
    "nonstall: the other two keep turning",
    turning.every((view) => view.node.turn_count > turnsBefore[view.node.node_id]),
    turning.map((view) => `${view.node.node_id} ${turnsBefore[view.node.node_id]}->${view.node.turn_count}`).join(", "),
  );

  // Answering the parked node's question is the wake path, and it proves the
  // token a human would type reaches the same node.
  const token = parked.asks[0].token;
  const answer = await cliInject(root, "n1-parked", "write to target B", { token });
  console.log(`  answer reply ${JSON.stringify(answer)}`);
  check("nonstall: the answer is delivered as a Tier A steer or a queued message", answer.code === 0, String(answer.code));
  const woken = await waitFor(
    "the parked node to take the answer",
    () => {
      const view = journalView(root).find((row) => row.node.node_id === "n1-parked");
      return view && view.node.turn_count > turnsAfter["n1-parked"] ? view : null;
    },
    { timeoutMs: 20_000, intervalMs: 50 },
  );
  check("nonstall: the parked node's turn count advances after the answer", woken.node.turn_count > turnsAfter["n1-parked"], String(woken.node.turn_count));

  supervisor.kill("SIGTERM");
  await new Promise((resolveExit) => supervisor.once("exit", resolveExit));
}

// ── argv ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], arms: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split("=");
    const value = inline ?? argv[++i];
    if (key === "arms") args.arms = (value ?? "").split(",").filter(Boolean);
    else args[key] = value ?? true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: drill.mjs [--driver scripted|rpc] [--arms crash,steer,rss,nonstall]");
    return;
  }
  const arms = args.arms ?? ["crash"];
  if (arms.includes("crash")) {
    await crashArm({ naive: false, driver: args.driver ?? "scripted" });
    await crashArm({ naive: true, driver: args.driver ?? "scripted" });
  }
  if (arms.includes("steer")) await steerArm();
  if (arms.includes("rss")) await rssArm();
  if (arms.includes("nonstall")) await nonstallArm();
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`drill: ${error.stack ?? error.message}`);
  killSpawned();
  process.exit(1);
});

process.on("exit", killSpawned);
