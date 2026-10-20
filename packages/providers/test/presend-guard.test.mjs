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
 * Window index: a catalog id spelled with dashes resolves the request id a
 * route spells with dots, an ambiguous normalized key resolves neither way,
 * and a two-model collision still leaves both exact ids resolving.
 *
 * Byte arm: a declared cap stops a payload the token arm passes; the floor is
 * not the token arm's 256KB; the payload path is untouched without a cap; the
 * report line fires once per request above its threshold, carries the byte
 * count, and never alters the payload; a throwing flush keeps the string.
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
  const log = require_(join(buildDir, "log.js"));
  return {
    shrinkDoomedPayload: mod.shrinkDoomedPayload,
    estimatePayloadChars: mod.estimatePayloadChars,
    isPresendGuardEnabled: mod.isPresendGuardEnabled,
    readPresendPolicy: mod.readPresendPolicy,
    buildContextWindowIndex: mod.buildContextWindowIndex,
    normalizeModelId: mod.normalizeModelId,
    REPORT_BYTES_ABOVE_DEFAULT: mod.REPORT_BYTES_ABOVE_DEFAULT,
    setProvidersLogSink: log.setProvidersLogSink,
  };
}

console.log("=== pre-send payload guard ===\n");

const {
  shrinkDoomedPayload,
  estimatePayloadChars,
  isPresendGuardEnabled,
  readPresendPolicy,
  buildContextWindowIndex,
  normalizeModelId,
  REPORT_BYTES_ABOVE_DEFAULT,
  setProvidersLogSink,
} = loadGuard();

const CTX_100K = {
  resolveContextWindow: (id) => (id === "test-model" ? 100_000 : undefined),
};

/** Capture providerLog lines for the duration of one case. */
const captured = [];
function captureLogs() {
  captured.length = 0;
  setProvidersLogSink((message, type) => captured.push({ message, type }));
}
function releaseLogs() {
  setProvidersLogSink(undefined);
}

/** The UTF-8 JSON byte count, the number the transport sees. Null-safe so a
 *  guard result with no payload (a no-op or a total flush failure) still lets
 *  the assertion fail on the number instead of crashing the run. */
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

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

// ── Window index (the id the catalog spells vs the id the route sends) ───────

const CATALOG = [{ id: "deepseek-v4-1-flash", contextWindow: 1_000_000 }];
const index = buildContextWindowIndex(CATALOG);
check(
  "index: exact catalog id resolves",
  index.resolve("deepseek-v4-1-flash") === 1_000_000,
);
check(
  "index: the dot-form request id resolves to the same window",
  index.resolve("deepseek-v4.1-flash") === 1_000_000,
);
check(
  "index: an id neither spelling knows stays unresolved",
  index.resolve("mystery-model.v2") === undefined,
);
check(
  "normalize: lowercase and dots → dashes",
  normalizeModelId("DeepSeek-V4.1-Flash") === "deepseek-v4-1-flash",
);

// Ambiguity: two models whose ids normalize to the same key with different
// windows. Neither may answer the normalized lookup; both exact ids still do.
const AMBIGUOUS = buildContextWindowIndex([
  { id: "alpha-1-flash", contextWindow: 1_000_000 },
  { id: "alpha.1.flash", contextWindow: 200_000 },
]);
check(
  "index: colliding normalized key resolves neither window",
  AMBIGUOUS.resolve("ALPHA-1-FLASH") === undefined,
  String(AMBIGUOUS.resolve("ALPHA-1-FLASH")),
);
check(
  "index: both exact ids of a collision still resolve",
  AMBIGUOUS.resolve("alpha-1-flash") === 1_000_000 &&
    AMBIGUOUS.resolve("alpha.1.flash") === 200_000,
);
const AGREEING = buildContextWindowIndex([
  { id: "beta-2-pro", contextWindow: 500_000 },
  { id: "beta.2.pro", contextWindow: 500_000 },
]);
check(
  "index: a normalized key both models agree on resolves",
  AGREEING.resolve("BETA.2.PRO") === 500_000,
);

// Through the guard: the dot-form route id is what before_provider_request
// sees, so the token arm must act on it — and not answer "unknown context
// window".
const DOT_BLOB = "D".repeat(4_000_000); // ~1M tokens, past a 1M window's 90%
const dotFlushed = [];
const dotResult = shrinkDoomedPayload(
  {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: DOT_BLOB }],
  },
  {
    resolveContextWindow: (id) => index.resolve(id),
    flush: (path, text) => dotFlushed.push({ path, text }),
    clock: () => 1_700_000_000_500,
  },
);
check(
  "index+guard: a dot-form id is guarded, not skipped as unknown",
  dotResult.wasDoomed === true && dotResult.shrunk === 1,
  `wasDoomed=${dotResult.wasDoomed} shrunk=${dotResult.shrunk} reason=${dotResult.reason ?? ""}`,
);
check(
  "index+guard: the flush is lossless for the dot-form request",
  dotFlushed.length === 1 && dotFlushed[0].text === DOT_BLOB,
);

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
check(
  "under budget → no serialization spent (estimate stands)",
  underBudget.measured === false && underBudget.bytes === 11,
  `measured=${underBudget.measured} bytes=${underBudget.bytes}`,
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

// ── Byte arm (a declared cap the token arm never sees) ───────────────────────

const ONE_MB = 1_000_000;
const BIG_WINDOW = { resolveContextWindow: () => 1_000_000 };

/** Eight 200KB messages: 1.6MB on the wire, ~400k estimated tokens — far
 *  inside a 1M window's 900k budget, so only the byte arm can act. */
function eightx200k() {
  return {
    model: "test-model",
    messages: Array.from({ length: 8 }, () => ({
      role: "user",
      content: "y".repeat(200_000),
    })),
  };
}

const bytePayload = eightx200k();
const byteFlushed = [];
const byteShrunk = shrinkDoomedPayload(bytePayload, {
  ...BIG_WINDOW,
  maxRequestBytes: ONE_MB,
  flush: (path, text) => byteFlushed.push({ path, text }),
  clock: () => 1_700_000_000_900,
});
check(
  "byte cap: a payload inside the token budget is still doomed by its bytes",
  byteShrunk.wasDoomed === true && byteShrunk.shrunk > 0,
  `wasDoomed=${byteShrunk.wasDoomed} shrunk=${byteShrunk.shrunk} reason=${byteShrunk.reason ?? ""}`,
);
check(
  "byte cap: the shrunk payload fits the declared cap",
  byteShrunk.bytes <= ONE_MB,
  `bytes=${byteShrunk.bytes} cap=${ONE_MB}`,
);
check(
  "byte cap: the reported size is a serialized measurement, not the estimate",
  byteShrunk.measured === true &&
    byteShrunk.bytes === jsonBytes(byteShrunk.payload),
  `measured=${byteShrunk.measured} bytes=${byteShrunk.bytes} json=${jsonBytes(byteShrunk.payload)}`,
);
check("byte cap: not stillOver once it fits", byteShrunk.stillOver === false);
check(
  "byte cap: sub-256KB results are stubbable (8KB floor, not the token floor)",
  byteShrunk.shrunk >= 4,
  `shrunk=${byteShrunk.shrunk}`,
);
check(
  "byte cap: one flush per stubbed string, each holding the full original",
  byteFlushed.length === byteShrunk.shrunk &&
    byteFlushed.every((f) => f.text.length === 200_000),
  `${byteFlushed.length} flush(es) for ${byteShrunk.shrunk} stub(s)`,
);
check(
  "byte cap: the input payload is never mutated",
  bytePayload.messages.every((m) => m.content.length === 200_000),
);

// A cap it cannot satisfy: nothing in the payload is above the 8KB floor.
const manyTiny = {
  model: "test-model",
  messages: Array.from({ length: 300 }, () => ({
    role: "user",
    content: "z".repeat(4_000),
  })),
};
const tinyResult = shrinkDoomedPayload(manyTiny, {
  ...BIG_WINDOW,
  maxRequestBytes: ONE_MB,
  flush: () => {},
  clock: () => 1_700_000_001_000,
});
check(
  "byte cap: nothing above the floor → shrunk 0 + honest stillOver",
  tinyResult.shrunk === 0 && tinyResult.stillOver === true,
  `shrunk=${tinyResult.shrunk} stillOver=${tinyResult.stillOver}`,
);

// Flush that throws: that string stays in the body, the arm reports honestly.
const noFlushPayload = eightx200k();
const noFlush = shrinkDoomedPayload(noFlushPayload, {
  ...BIG_WINDOW,
  maxRequestBytes: ONE_MB,
  flush: () => {
    throw new Error("EACCES");
  },
  clock: () => 1_700_000_001_100,
});
check(
  "byte cap: a throwing flush stubs nothing",
  noFlush.shrunk === 0 && noFlush.payload === undefined,
);
check(
  "byte cap: a throwing flush leaves stillOver",
  noFlush.stillOver === true,
);
check(
  "byte cap: a throwing flush leaves every string in the body",
  noFlushPayload.messages.every((m) => m.content.length === 200_000),
);

// Contract: no cap means the payload path is unchanged (only the report line).
const noCapPayload = eightx200k();
const noCap = shrinkDoomedPayload(noCapPayload, {
  ...BIG_WINDOW,
  reportBytesAbove: ONE_MB,
});
check(
  "no cap: the payload is untouched",
  noCap.shrunk === 0 &&
    noCap.payload === undefined &&
    noCap.wasDoomed === false,
  `shrunk=${noCap.shrunk} reason=${noCap.reason ?? ""}`,
);
check(
  "no cap: the bytes are still measured and reported",
  noCap.measured === true && noCap.bytes === jsonBytes(noCapPayload),
  `measured=${noCap.measured} bytes=${noCap.bytes}`,
);

// ── Report line ──────────────────────────────────────────────────────────────

captureLogs();
const reportedPayload = eightx200k();
const reported = shrinkDoomedPayload(reportedPayload, {
  ...BIG_WINDOW,
  reportBytesAbove: ONE_MB,
});
releaseLogs();
check(
  "report: exactly one line per request above the threshold",
  captured.length === 1,
  `${captured.length} line(s): ${JSON.stringify(captured.map((c) => c.message))}`,
);
const line = captured[0]?.message ?? "";
const measuredBytes = jsonBytes(reportedPayload);
check(
  "report: the line carries the payload's byte count",
  line.includes(`${measuredBytes} bytes`),
  line,
);
check("report: the line carries the model id", line.includes("test-model"));
check(
  "report: the line says no cap is declared when none is",
  /no byte cap is declared/.test(line),
  line,
);
check("report: the line is a warn", captured[0]?.type === "warning");
check(
  "report: the report never alters the payload",
  reported.payload === undefined && reported.shrunk === 0,
);

// With a cap the same line says the cap exists.
captureLogs();
shrinkDoomedPayload(eightx200k(), {
  ...BIG_WINDOW,
  maxRequestBytes: ONE_MB,
  reportBytesAbove: ONE_MB,
  flush: () => {},
  clock: () => 1_700_000_002_000,
});
releaseLogs();
const capReportLines = captured.filter((c) =>
  c.message.includes("report threshold"),
);
check(
  "report: the line names the declared cap when one exists",
  capReportLines.length === 1 &&
    /declared cap is 1000000 bytes/.test(capReportLines[0].message),
  JSON.stringify(captured.map((c) => c.message)),
);

// Default threshold: 1.6MB stays quiet under the 2MB default.
captureLogs();
shrinkDoomedPayload(eightx200k(), BIG_WINDOW);
releaseLogs();
check(
  "report: below the default threshold → no line",
  captured.length === 0,
  `${captured.length} line(s)`,
);
check(
  "report: the default threshold is 2000000 bytes",
  REPORT_BYTES_ABOVE_DEFAULT === 2_000_000,
  String(REPORT_BYTES_ABOVE_DEFAULT),
);

// Both switches off: reportBytesAbove 0, no cap → an empty log.
captureLogs();
shrinkDoomedPayload(
  {
    model: "test-model",
    messages: [{ role: "user", content: "k".repeat(3_000_000) }],
  },
  { ...BIG_WINDOW, reportBytesAbove: 0 },
);
releaseLogs();
check(
  "report: reportBytesAbove 0 disables the line",
  captured.length === 0,
  `${captured.length} line(s): ${JSON.stringify(captured.map((c) => c.message))}`,
);

// An unknown model still reports: the 413 that motivated the arm had no
// window to consult.
captureLogs();
shrinkDoomedPayload(eightx200k(), {
  resolveContextWindow: () => undefined,
  reportBytesAbove: ONE_MB,
});
releaseLogs();
check(
  "report: an unknown window still writes the line",
  captured.length === 1 &&
    captured[0].message.includes(`${jsonBytes(eightx200k())} bytes`),
  JSON.stringify(captured.map((c) => c.message)),
);

// ── Settings policy ──────────────────────────────────────────────────────────

const settingsPath = join(FAKE_HOME, "settings.json");
check(
  "guard default ON (settings absent)",
  isPresendGuardEnabled(settingsPath) === true,
);
check(
  "policy: absent settings → no cap + default threshold",
  readPresendPolicy(settingsPath).maxRequestBytes === undefined &&
    readPresendPolicy(settingsPath).reportBytesAbove ===
      REPORT_BYTES_ABOVE_DEFAULT,
);
writeFileSync(
  settingsPath,
  JSON.stringify({
    braid: {
      context: {
        presendGuard: { maxRequestBytes: 4_000_000, reportBytesAbove: 0 },
      },
    },
  }),
);
check(
  "policy: maxRequestBytes is read",
  readPresendPolicy(settingsPath).maxRequestBytes === 4_000_000,
  String(readPresendPolicy(settingsPath).maxRequestBytes),
);
check(
  "policy: reportBytesAbove 0 is honoured (not defaulted away)",
  readPresendPolicy(settingsPath).reportBytesAbove === 0,
  String(readPresendPolicy(settingsPath).reportBytesAbove),
);
check(
  "policy: a declared cap leaves enabled at its default",
  readPresendPolicy(settingsPath).enabled === true,
);
writeFileSync(
  settingsPath,
  JSON.stringify({ braid: { context: { presendGuard: { enabled: false } } } }),
);
check(
  "guard OFF when enabled=false",
  isPresendGuardEnabled(settingsPath) === false,
);
writeFileSync(
  settingsPath,
  JSON.stringify({
    braid: {
      context: {
        presendGuard: { maxRequestBytes: 0, reportBytesAbove: -5 },
      },
    },
  }),
);
check(
  "policy: a zero/negative size is refused (no arm from a bad number)",
  readPresendPolicy(settingsPath).maxRequestBytes === undefined &&
    readPresendPolicy(settingsPath).reportBytesAbove ===
      REPORT_BYTES_ABOVE_DEFAULT,
);
writeFileSync(
  settingsPath,
  JSON.stringify({
    braid: { context: { presendGuard: { maxRequestBytes: "1MB" } } },
  }),
);
check(
  "policy: a non-numeric cap is refused",
  readPresendPolicy(settingsPath).maxRequestBytes === undefined,
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
