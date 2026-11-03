/**
 * coldstart healthcheck category: the rehearsal must measure, and must not
 * touch the machine it measures.
 *
 * Why this fixture exists: the category spawns a process, so a bug in it is
 * expensive in exactly the two ways that matter. It can report a green from a
 * probe that never ran (no verdict, no check), and it can write into the live
 * braid home while pretending to be a sandbox. Both are tested here with an
 * injected child runner, so the fixture stays offline and spawns nothing.
 *
 * Legs:
 *   1. parseVerdict reads model output wherever the marker appears, and refuses
 *      garbage instead of inventing a verdict.
 *   2. copyConfigManifest copies what exists and reports what does not.
 *   3. buildColdStartEnv points every root inside the throwaway tree and clears
 *      the session role.
 *   4. a happy run yields subsystem passes; a timed-out run fails `boot` by
 *      name; a child that writes into the live home fails `isolation`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("../healthcheck/checks/coldstart.ts");
const {
  parseVerdict,
  copyConfigManifest,
  buildColdStartEnv,
  testColdStart,
  CONFIG_MANIFEST,
} = mod;

const statusOf = (results, name) =>
  results.find((r) => r.name === name)?.status;

// ── 1. verdict parsing ─────────────────────────────────────────────────────
{
  const plain = 'COLD_RESULT {"memory":"ok","bash":"ok"}';
  assert.deepEqual(
    parseVerdict(plain),
    { memory: "ok", bash: "ok" },
    "plain marker must parse",
  );

  const fenced =
    'Some prose first.\n```json\nCOLD_RESULT {"memory":"ok"}\n```\n';
  assert.deepEqual(
    parseVerdict(fenced),
    { memory: "ok" },
    "a fenced marker must parse",
  );

  const prefixed = '  COLD_RESULT   {"memory": "fail: store unreadable"}  ';
  assert.deepEqual(
    parseVerdict(prefixed),
    { memory: "fail: store unreadable" },
    "a prefixed marker must parse",
  );

  assert.equal(
    parseVerdict("no marker here"),
    null,
    "absent marker must not invent a verdict",
  );
  assert.equal(
    parseVerdict('COLD_RESULT {"broken": '),
    null,
    "truncated JSON must not invent a verdict",
  );
}

// ── 2. manifest copying ───────────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "coldstart-fixture-"));
  const from = join(root, "agent");
  const to = join(root, "cold", "agent");
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, "settings.json"), '{"extensions":[]}');

  const { copied, missing } = copyConfigManifest(from, to);
  assert.deepEqual(
    copied,
    ["settings.json"],
    "only the present config file is copied",
  );
  assert.equal(
    missing.length,
    CONFIG_MANIFEST.length - 1,
    "every absent file is reported, not invented",
  );
  assert.equal(
    readFileSync(join(to, "settings.json"), "utf8"),
    '{"extensions":[]}',
    "the copy carries the source content",
  );
}

// ── 3. environment isolation ──────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "coldstart-env-"));
  const env = buildColdStartEnv(root, {
    PATH: "/usr/bin",
    BRAID_SESSION_ROLE: "seat",
    HOME: "/live/home",
  });
  assert.ok(
    env.HOME.startsWith(root),
    "HOME must be inside the throwaway tree",
  );
  assert.ok(
    env.BRAID_HOME.startsWith(root),
    "BRAID_HOME must be inside the throwaway tree",
  );
  assert.equal(
    env.BRAID_SESSION_ROLE,
    "",
    "the probe must not register the seat's outbound surfaces",
  );
  assert.equal(
    env.PATH,
    "/usr/bin",
    "the rest of the environment passes through",
  );
}

// ── 4. injected runs: green, timeout, and an isolation breach ─────────────
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "coldstart-case-"));
  const agentDir = join(root, "live", "agent");
  const liveBraid = join(agentDir, "braid");
  mkdirSync(liveBraid, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), '{"extensions":[]}');
  process.env.BRAID_HOME = liveBraid;
  return { root, liveBraid };
}

{
  sandbox();
  const results = testColdStart({
    runChild: () => ({
      status: 0,
      stdout:
        'COLD_RESULT {"memory":"ok","scratchpad":"ok","orchestrate":"ok","bash":"ok"}',
      stderr: "",
      timedOut: false,
    }),
  });
  assert.equal(statusOf(results, "verdict"), "pass", "a parsed verdict passes");
  for (const key of ["memory", "scratchpad", "orchestrate", "bash"]) {
    assert.equal(
      statusOf(results, `subsystem-${key}`),
      "pass",
      `${key} ok must pass`,
    );
  }
  assert.equal(statusOf(results, "boot"), "pass", "a clean exit passes boot");
  assert.equal(
    statusOf(results, "first-boot-installs"),
    "pass",
    "no install lines must not warn",
  );
  assert.equal(
    statusOf(results, "isolation"),
    "pass",
    "an inert child must not fail isolation",
  );
  assert.ok(
    results.every((r) => r.category === "coldstart"),
    "every result carries the coldstart category",
  );
}

{
  sandbox();
  const results = testColdStart({
    timeoutMs: 1234,
    runChild: () => ({
      status: -1,
      stdout: "",
      stderr: "waiting on a lock",
      timedOut: true,
    }),
  });
  const boot = results.find((r) => r.name === "boot");
  assert.equal(boot.status, "fail", "a killed rehearsal must fail");
  assert.match(
    boot.message,
    /1234ms/,
    "the failure names the window it was given",
  );
  assert.equal(
    statusOf(results, "verdict"),
    "warn",
    "no verdict is a warning, not a green",
  );
}

{
  const { liveBraid } = sandbox();
  const results = testColdStart({
    runChild: () => {
      writeFileSync(join(liveBraid, "leaked-state.json"), "{}");
      return {
        status: 0,
        stdout: 'COLD_RESULT {"memory":"ok"}',
        stderr: "added 3 packages in 2s",
        timedOut: false,
      };
    },
  });
  const isolation = results.find((r) => r.name === "isolation");
  assert.equal(
    isolation.status,
    "fail",
    "a write into the live home must fail isolation",
  );
  assert.match(
    isolation.message,
    /leaked-state/,
    "the failure names what appeared",
  );
  const installs = results.find((r) => r.name === "first-boot-installs");
  assert.equal(
    installs.status,
    "warn",
    "an install pass during boot is a warning",
  );
  assert.match(installs.message, /network/, "the warning says why it matters");
}

// ── 5. the spawn is inside the timed region, and an empty run is evidenced ──
{
  sandbox();
  const results = testColdStart({
    runChild: () => {
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // A child that takes time is the case a 0ms report hides.
      }
      return {
        status: 0,
        stdout: 'COLD_RESULT {"memory":"ok"}',
        stderr: "",
        timedOut: false,
      };
    },
  });
  const boot = results.find((r) => r.name === "boot");
  assert.ok(
    boot.durationMs >= 25,
    `boot must time the child it runs, got ${boot.durationMs}ms`,
  );
}

{
  sandbox();
  const results = testColdStart({
    runChild: () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
  });
  const verdict = results.find((r) => r.name === "verdict");
  assert.equal(
    verdict.status,
    "warn",
    "an empty run is a warning, never a pass",
  );
  assert.match(
    verdict.details ?? "",
    /stdout 0B/,
    "the warning carries what the child actually produced, so a silent run is visible",
  );
}

// ── 6. a silent first run buys one retry, and the retry's verdict is the one used ──
{
  sandbox();
  let call = 0;
  const results = testColdStart({
    runChild: () => {
      call += 1;
      if (call === 1)
        return {
          status: 0,
          stdout: "",
          stderr: "added 2 packages in 1s",
          timedOut: false,
        };
      return {
        status: 0,
        stdout: 'COLD_RESULT {"memory":"fail: No API key found","bash":"ok"}',
        stderr: "",
        timedOut: false,
      };
    },
  });
  assert.equal(call, 2, "a silent attempt must be retried exactly once");
  assert.equal(
    statusOf(results, "silent-run-retry"),
    "pass",
    "the retry that runs the probe passes",
  );
  const memory = results.find((r) => r.name === "subsystem-memory");
  assert.equal(
    memory.status,
    "fail",
    "the retry's refusal is the finding, not a warning",
  );
  assert.match(
    memory.message,
    /No API key/,
    "the refusal keeps the cause it named",
  );
}

console.log("coldstart healthcheck: 7 legs passed");
