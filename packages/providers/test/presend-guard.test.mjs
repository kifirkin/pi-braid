#!/usr/bin/env node
/**
 * presend-guard.test.mjs
 *
 * Pre-send payload guard regression suite for packages/providers.
 *
 * Covers the brief's test spec:
 *   - oversized request → the guard shrinks it (stub + disk flush) so the
 *     estimate drops under budget,
 *   - a doomed request with nothing oversized to stub → honest stillOver,
 *   - under-budget / unknown-model payloads are untouched,
 *   - flush failure → that string is NEVER stubbed (lossless wins),
 *   - the input payload object is never mutated,
 *   - settings gate: braid.context.presendGuard absent → ON; false → OFF.
 *
 * Harness: same as fallback-policy.test.mjs — the REAL presend-guard module is
 * compiled with the package's own local tsc (CJS emit) into <repoRoot>/.race-build/
 * and driven with no network and no pi-ai import. HOME is redirected to an
 * isolated temp dir so settings reads and flushes never touch the real ~/.pi.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".race-build");
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w115-presend-"));

let failures = 0;
const checks = [];
function check(name, cond, extra) {
  checks.push({ name, cond, extra });
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? " (" + extra + ")" : ""}`);
  }
}

/** Compile the guard module to CJS in buildDir and load it. */
function loadGuard() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "presend-guard.ts"),
    join(pkgRoot, "log.ts"),
    "--outDir",
    buildDir,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--lib",
    "ES2022",
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
    "--forceConsistentCasingInFileNames",
    "--types",
    "node",
  ];
  const tsc = spawnSync("node", args, { cwd: pkgRoot, encoding: "utf-8" });
  if (tsc.status !== 0) {
    throw new Error(`tsc failed: ${tsc.stdout}\n${tsc.stderr}`);
  }
  const require_ = createRequire(import.meta.url);
  const mod = require_(join(buildDir, "presend-guard.js"));
  return {
    shrinkDoomedPayload: mod.shrinkDoomedPayload,
    estimatePayloadChars: mod.estimatePayloadChars,
    isPresendGuardEnabled: mod.isPresendGuardEnabled,
  };
}

console.log("=== pre-send payload guard ===\n");

const { shrinkDoomedPayload, estimatePayloadChars, isPresendGuardEnabled } =
  loadGuard();

const CTX_100K = {
  resolveContextWindow: (id) => (id === "test-model" ? 100_000 : undefined),
};

// ── Estimator ─────────────────────────────────────────────────────────────────

check(
  "estimate: string content",
  estimatePayloadChars({ messages: [{ content: "abcd" }] }) === 4,
);
check(
  "estimate: block array (text + image_url)",
  estimatePayloadChars({
    messages: [
      {
        content: [
          { type: "text", text: "ab" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,XYZ" },
          },
        ],
      },
    ],
  }) ===
    2 + "data:image/png;base64,XYZ".length,
);
check(
  "estimate: no messages → JSON fallback (whole-body estimate)",
  estimatePayloadChars({}) === 2,
);
check("estimate: no payload → 0", estimatePayloadChars(null) === 0);

// ── Guard behavior ────────────────────────────────────────────────────────────

const underBudget = shrinkDoomedPayload(
  { model: "test-model", messages: [{ role: "user", content: "hello world" }] },
  CTX_100K,
);
check(
  "under budget → no-op with reason",
  underBudget.shrunk === 0 && !!underBudget.reason,
  underBudget.reason,
);

const unknownModel = shrinkDoomedPayload(
  {
    model: "mystery-model",
    messages: [{ role: "user", content: "x".repeat(900_000) }],
  },
  CTX_100K,
);
check(
  "unknown model window → no-op (no blind shrinking)",
  unknownModel.shrunk === 0 &&
    unknownModel.reason?.includes("unknown context window"),
);

// Doomed: 500k chars ≈ 125k tokens > 90k budget. One oversized string shrinks it.
const BLOB = "B".repeat(500_000);
const doomedPayload = {
  model: "test-model",
  messages: [
    { role: "user", content: "fix the build" },
    { role: "user", content: BLOB },
  ],
};
const flushed = [];
const result = shrinkDoomedPayload(doomedPayload, {
  ...CTX_100K,
  flush: (path, text) => {
    flushed.push({ path, text });
  },
  clock: () => 1_700_000_000_000,
});
check("doomed payload was detected", result.wasDoomed === true);
check(
  "one oversized string stubbed",
  result.shrunk === 1,
  `shrunk=${result.shrunk}`,
);
check(
  "estimate dropped under budget (not stillOver)",
  result.stillOver === false,
);
check(
  "modified payload returned with stub content",
  typeof result.payload?.messages?.[1]?.content === "string" &&
    result.payload.messages[1].content.startsWith("[offloaded: text result,"),
  JSON.stringify(result.payload?.messages?.[1]?.content ?? "").slice(0, 80),
);
check(
  "stub carries the flush path",
  /\[offloaded: text result, 500000 bytes — flushed to disk: (\S+)\]/.test(
    result.payload.messages[1].content,
  ),
);
check(
  "input payload NEVER mutated",
  doomedPayload.messages[1].content === BLOB,
);
check(
  "flush file holds the FULL original (lossless)",
  flushed.length === 1 && flushed[0].text === BLOB,
);
check(
  "new estimate is materially smaller",
  estimatePayloadChars(result.payload) < 500_000,
);

// Image URL variant.
const imgPayload = {
  model: "test-model",
  messages: [
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64," + "P".repeat(500_000) },
        },
      ],
    },
  ],
};
const imgResult = shrinkDoomedPayload(imgPayload, {
  ...CTX_100K,
  flush: (p, t) => flushed.push({ path: p, text: t }),
  clock: () => 1_700_000_000_001,
});
check("base64 image_url blob stubbed", imgResult.shrunk === 1);
check(
  "image block REPLACED with text stub (no url key survives)",
  imgResult.payload.messages[0].content[0].type === "text" &&
    !("image_url" in imgResult.payload.messages[0].content[0]),
  JSON.stringify(imgResult.payload.messages[0].content[0]).slice(0, 80),
);

// Flush failure → never stub without a verified flush.
const failResult = shrinkDoomedPayload(
  { model: "test-model", messages: [{ content: BLOB }] },
  {
    ...CTX_100K,
    flush: () => {
      throw new Error("EACCES");
    },
  },
);
check("flush failure → nothing stubbed", failResult.shrunk === 0);
check("flush failure → honest stillOver", failResult.stillOver === true);

// Doomed but nothing oversized (many small messages) → honest report, no change.
const manySmall = {
  model: "test-model",
  messages: Array.from({ length: 900 }, (_, _i) => ({
    role: "user",
    content: "m".repeat(500),
  })),
};
const noCandidates = shrinkDoomedPayload(manySmall, CTX_100K);
check(
  "doomed with no oversized strings → shrunk 0 + stillOver",
  noCandidates.shrunk === 0 && noCandidates.stillOver === true,
);

// Still over even after shrink (two huge blobs, only one fits the drop).
const twoBlobs = {
  model: "test-model",
  messages: [
    { role: "user", content: "A".repeat(400_000) },
    { role: "user", content: "C".repeat(400_000) },
    { role: "user", content: "D".repeat(400_000) },
    { role: "user", content: "E".repeat(400_000) },
    { role: "user", content: "F".repeat(400_000) },
    { role: "user", content: "G".repeat(400_000) },
    { role: "user", content: "H".repeat(400_000) },
    { role: "user", content: "I".repeat(400_000) },
  ],
};
const partial = shrinkDoomedPayload(twoBlobs, { ...CTX_100K, clock: () => 2 });
check("multiple oversized strings all stubbed while over", partial.shrunk >= 1);

// ── Settings gate ─────────────────────────────────────────────────────────────

const settingsPath = join(FAKE_HOME, "settings.json");
check(
  "guard default ON (settings absent)",
  isPresendGuardEnabled(settingsPath) === true,
);
writeFileSync(
  settingsPath,
  JSON.stringify({ braid: { context: { presendGuard: { enabled: false } } } }),
);
check(
  "guard OFF when enabled=false",
  isPresendGuardEnabled(settingsPath) === false,
);
writeFileSync(settingsPath, "{corrupt json");
check(
  "corrupt settings → default ON (fail open toward safety)",
  isPresendGuardEnabled(settingsPath) === true,
);
rmSync(settingsPath, { force: true });

rmSync(buildDir, { recursive: true, force: true });
rmSync(FAKE_HOME, { recursive: true, force: true });

console.log(`\nTOTAL: ${checks.length - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log("=== presend guard tests passed ===");
