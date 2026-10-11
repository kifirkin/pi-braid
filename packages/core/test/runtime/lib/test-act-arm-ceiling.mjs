/**
 * Acting arm: absolute token ceiling.
 *
 * The hygiene ladder is expressed as fractions of the resolved window W
 * (tokenArms). act is the one arm that acts, so it is the one arm held to an
 * absolute token ceiling on large windows; the advisory arms are prose and
 * escalate/backstop are failure-path arms, so they must keep their bare
 * fractions. This fixture pins four properties of the clamp:
 * 1. act is monotonic in W and never exceeds the ceiling;
 * 2. a 196k window stays byte-identical to the pre-ceiling table (inertness:
 *    the clamp must only bind where a bare 0.60W would overshoot);
 * 3. at 256k the clamp actually binds - strictly below the value a bare
 *    0.60W produces and still above the 196k-era act point;
 * 4. no other arm is clamped (per-arm ceiling, not one shared constant).
 *
 * Run: node test/runtime/lib/test-act-arm-ceiling.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings isolation BEFORE the dist import: tokenArms resolves the
// window through braid-settings (SETTINGS_PATH bakes from HOME at
// module-eval time). The empty settings file keeps the configured override
// unset, so every tokenArms(W) below is driven by the W passed in, not by
// the host's live contextLimitTokens.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "act-arm-ceiling-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const { tokenArms } = await import("file://" + join(ROOT, "dist/lib/detection/context-usage.js"));

// Pinned expectations, deliberately not imported from source: a retune of the
// source ceiling must fail this fixture, not follow it.
const ACT_CEILING = 130_000;
const WINDOWS = [160_000, 196_000, 256_000, 400_000];
const ACT_196K = 117_600;
const ACT_256K_BARE = Math.round(256_000 * 0.6); // what 0.60W alone would give

console.log("=== acting arm: absolute token ceiling ===\n");

for (const w of WINDOWS) {
  const a = tokenArms(w);
  console.log(
    `  W=${String(w).padStart(6)}  soft=${String(a.soft).padStart(6)}  advisory=${String(
      a.advisory,
    ).padStart(6)}  warning=${String(a.warning).padStart(6)}  act=${String(a.act).padStart(
      7,
    )}  escalate=${String(a.escalate).padStart(7)}  backstop=${String(a.backstop).padStart(7)}`,
  );
}
console.log();

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

await test("act is monotonic in W and never exceeds the ceiling", () => {
  const acts = WINDOWS.map((w) => tokenArms(w).act);
  for (let i = 1; i < acts.length; i++) {
    assert.ok(
      acts[i] >= acts[i - 1],
      `act must be monotonic: act(${WINDOWS[i]}) = ${acts[i]} < act(${WINDOWS[i - 1]}) = ${
        acts[i - 1]
      }`,
    );
  }
  for (let i = 0; i < acts.length; i++) {
    assert.ok(
      acts[i] <= ACT_CEILING,
      `act(${WINDOWS[i]}) = ${acts[i]} exceeds the ${ACT_CEILING} ceiling`,
    );
  }
  // The clamp is real, not absent: beyond the cap the arm stays put.
  assert.equal(acts[2], ACT_CEILING, "act(256k) must sit at the ceiling");
  assert.equal(acts[3], ACT_CEILING, "act(400k) must sit at the ceiling");
});

await test("196k row is byte-identical to the pre-ceiling table (clamp inert)", () => {
  assert.deepEqual(tokenArms(196_000), {
    W: 196_000,
    soft: 35_280,
    advisory: 58_800,
    warning: 88_200,
    act: ACT_196K,
    escalate: 166_600,
    backstop: 176_400,
  });
});

await test("256k: the clamp binds below the bare 0.60W and above the 196k act point", () => {
  const act = tokenArms(256_000).act;
  assert.ok(
    act < ACT_256K_BARE,
    `act(256k) = ${act} must be strictly below the bare ${ACT_256K_BARE} a 0.60W fraction gives`,
  );
  assert.ok(
    act > ACT_196K,
    `act(256k) = ${act} must stay above the 196k-era act point ${ACT_196K}`,
  );
});

await test("no other arm is clamped (per-arm ceiling, not a shared constant)", () => {
  const arms = tokenArms(256_000);
  assert.deepEqual(
    {
      soft: arms.soft,
      advisory: arms.advisory,
      warning: arms.warning,
      escalate: arms.escalate,
      backstop: arms.backstop,
    },
    {
      soft: 46_080,
      advisory: 76_800,
      warning: 115_200,
      escalate: 217_600,
      backstop: 230_400,
    },
    "every non-act arm keeps its bare fraction at 256k",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
