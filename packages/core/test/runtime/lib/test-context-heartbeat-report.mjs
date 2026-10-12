/**
 * context-heartbeat-report.mjs — the reader for the context-heartbeat sink.
 *
 * The fixture is written to a throwaway temp dir; the production sink under
 * $HOME is never read (except by the one drift-guard case, which reads the
 * producer's source text, not its output).
 *
 * Cases:
 *   1. text render — per-session tick count, context trend, drop count, and a
 *      field the producer never wrote shown as n/a
 *   2. malformed lines are counted and skipped
 *   3. --session filters, --limit bounds the render, --json is parseable
 *   4. a missing sink is reported, exit 0 (a fresh install has not ticked)
 *   5. bad usage exits 2
 *   6. the default sink path matches the producer's accessor, in the default
 *      tree and under a pinned BRAID_HOME, so the mirrored resolution cannot
 *      drift silently
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "context-heartbeat-report.mjs");
const PRODUCER_ACCESSOR = join(ROOT, "dist", "lib", "telemetry", "context-heartbeat.js");
const BRAID_PATHS_PATH = join(ROOT, "dist", "lib", "config", "braid-paths.js");

const reader = await import(pathToFileURL(SCRIPT).href);

function tick(ts, sessionId, over = {}) {
  return {
    ts,
    source: "heartbeat",
    sessionId,
    model: "test-model",
    contextTokens: 100000,
    contextWindow: 256000,
    contextPercent: 39.06,
    rssBytes: 200 * 1048576,
    heapUsed: 100 * 1048576,
    sessionFileSizeBytes: 400000,
    tokensPerSec: 50,
    tpsEma: 45,
    cacheHitShare: 0.9,
    contextTokensDelta: null,
    whisperCountTotal: 3,
    whisperCharsDelta: 100,
    assistantCharsDelta: 1000,
    messageCount: 20,
    healthMode: "healthy",
    ...over,
  };
}

/** Fixture: alpha has three ticks and one context drop; beta has one tick. */
const ALPHA = "sess-alpha";
const BETA = "sess-beta";
const FIXTURE = [
  JSON.stringify(tick(1000000, ALPHA)),
  JSON.stringify(tick(1060000, ALPHA, { contextTokens: 120000, contextTokensDelta: 20000 })),
  JSON.stringify(tick(1120000, ALPHA, { contextTokens: 50000, contextTokensDelta: -70000 })),
  "{ this line is not json",
  JSON.stringify([1, 2, 3]),
  JSON.stringify(tick(1100000, BETA, { tpsEma: undefined, source: "watchdog" })),
].join("\n");

function run(args, fixture = FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), "hbreport-"));
  const file = join(dir, "context-heartbeat.jsonl");
  try {
    if (fixture !== null) writeFileSync(file, `${fixture}\n`);
    const r = spawnSync("node", [SCRIPT, "--file", file, ...args], { encoding: "utf8" });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("text render summarizes each session", () => {
  const { status, out } = run([]);
  assert.equal(status, 0, out);
  assert.match(out, /lines: 4 in 2 session\(s\), malformed: 2/);
  assert.match(out, /session sess-alpha/);
  assert.match(out, /ticks: 3 \(heartbeat 3\)/);
  assert.match(out, /context: 100.0k -> 50.0k, peak 120.0k, window 256.0k/);
  assert.match(out, /context drops \(compaction\/archive\): 1, largest -70.0k/);
  assert.match(out, /cadence median 60.0s/);
  // A tick count with a never-written field is n/a, not a fabricated zero.
  assert.match(out, /throughput: last 50.0 tok\/s, ema n\/a/);
});

test("--session narrows the report and --limit bounds the render", () => {
  const filtered = run(["--session", BETA]);
  assert.equal(filtered.status, 0, filtered.out);
  assert.match(filtered.out, /session sess-beta/);
  assert.doesNotMatch(filtered.out, /session sess-alpha/);
  assert.match(filtered.out, /ticks: 1 \(watchdog 1\)/);

  const limited = run(["--limit", "1"]);
  assert.match(limited.out, /session sess-alpha/);
  assert.match(limited.out, /showing 1 of 2 session\(s\) by last heartbeat/);
});

test("--json is a machine-readable summary", () => {
  const { status, out } = run(["--json"]);
  assert.equal(status, 0, out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.lines, 4);
  assert.equal(parsed.malformedLines, 2);
  assert.equal(parsed.fileExists, true);
  assert.equal(parsed.sessions.length, 2);
  const [first, second] = parsed.sessions;
  assert.equal(first.sessionId, ALPHA);
  assert.equal(first.ticks, 3);
  assert.equal(first.drops.count, 1);
  assert.equal(first.drops.largestDrop, -70000);
  assert.deepEqual(first.drops.at, [1120000]);
  assert.equal(second.sessionId, BETA);
  assert.equal(second.tpsEmaLast, null);
  assert.equal(second.contextTokens.last, 100000);
});

test("a missing sink is reported without failing", () => {
  const { status, out } = run([], null);
  assert.equal(status, 0, out);
  assert.match(out, /no heartbeat file at this path/);
});

test("bad usage exits 2", () => {
  const { status, out } = run(["--limit", "lots"]);
  assert.equal(status, 2, out);
  assert.match(out, /--limit needs a non-negative integer/);
});

test("the default sink path matches the producer's accessor (pinned and unpinned)", async () => {
  // The mirror in this script and the producer must resolve one file: equality
  // is asserted against the producer's own accessor in this process, and
  // against a pinned BRAID_HOME in a child (this process imported its reader
  // const unpinned, so the pinned run cannot be faked here).
  const producer = await import(pathToFileURL(PRODUCER_ACCESSOR).href);
  const expectedDefault = join(
    homedir(),
    ".pi",
    "agent",
    "braid",
    "telemetry",
    "context-heartbeat.jsonl",
  );
  assert.equal(
    reader.CONTEXT_HEARTBEAT_FILE,
    producer.contextHeartbeatFilePath(),
    "the reader's default path drifted from the producer's sink",
  );
  assert.equal(reader.CONTEXT_HEARTBEAT_FILE, expectedDefault, "the default sink location must not move");

  const dir = mkdtempSync(join(tmpdir(), "hbpin-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    [
      'import { pathToFileURL } from "node:url";',
      'const reader = await import(pathToFileURL(process.env.READER).href);',
      'const paths = await import(pathToFileURL(process.env.BRAID_PATHS).href);',
      "console.log(JSON.stringify({",
      "  reader: reader.CONTEXT_HEARTBEAT_FILE,",
      '  braidDir: paths.braidDir(),',
      "}));",
    ].join("\n"),
  );
  const pin = join(dir, "braid");
  const r = spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    env: { ...process.env, BRAID_HOME: pin, READER: SCRIPT, BRAID_PATHS: BRAID_PATHS_PATH },
  });
  assert.equal(r.status, 0, `pinned probe failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  const pinned = JSON.parse(r.stdout.trim());
  assert.equal(pinned.braidDir, pin, "braidDir() must follow the pinned BRAID_HOME");
  assert.equal(
    pinned.reader,
    join(pin, "telemetry", "context-heartbeat.jsonl"),
    "a pinned BRAID_HOME must relocate the sink the reader defaults to",
  );
  rmSync(dir, { recursive: true, force: true });
});
