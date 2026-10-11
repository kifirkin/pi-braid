#!/usr/bin/env node
/**
 * ring-health.test.mjs
 *
 * Behavior pins for packages/providers/ring-health.ts, offline: the read-only
 * health surface over the two state files. The reader's contract is narrow, so
 * the suite pins it tightly:
 *
 *   1. Absent file = `present: false` and SILENCE; a malformed, partial or
 *      wrong-version file = `present: false` plus exactly ONE diagnostic, never
 *      a throw. Each corruption case runs in its own process so the diagnostic
 *      throttle cannot mask a case; a repeat-read case pins that the throttle
 *      holds the line at one.
 *   2. A well-formed ring file carries its envelope through and maps all five
 *      entry fields; a clear entry reports `exhaustedBy: null`.
 *   3. Hash-only: the output carries `keyHash` and never a sibling key value,
 *      even when the file (hypothetically) holds one - the reader copies named
 *      fields and nothing else.
 *   4. Entries are normalized leniently: one entry without a hash is dropped,
 *      the rest survive.
 *   5. `routeHealth` reports the union of the ids the caller names, the routes
 *      the route document carries and the providers with a ring file; a route
 *      with only one of the two sources still reports what it has.
 *   6. Paths: with no path given the reader looks in `<HOME>/.pi/agent`, where
 *      the writers put the files; and a real key-ring exhaustion is read back
 *      through this reader hash-only, which is the writer/reader schema check.
 *   7. Read-only: after reads the file bytes, its mtime and the directory
 *      listing are unchanged - no lock, no temp file, no write.
 *
 *   7. Rendering: the text the `ring_health` tool hands the model renders one
 *      line per provider plus a summary line - revision, save time, active
 *      index, usable/total, each key's state - and reports a missing or
 *      malformed file as "no ring state" without throwing; the summary handed
 *      to `details` and that text both drop every hash, so neither can carry
 *      key material into a session log.
 *
 *   9. A recorded death with no probe is still printed: the shape walk is that
 *      record's only writer, so the operator surface must show it.
 *
 *   9. Death currency: a recorded death is marked `(expired)` exactly when the
 *      router's own gate would ignore it (`deathInForce`) - inside the window
 *      the line is unchanged, a death exactly AT the bound is out, an untimed
 *      death is out, and the off switch (`freshnessMs <= 0`) expires all of
 *      them. The marker is checked against the gate itself, so a re-derived age
 *      test in the renderer fails here.
 *
 *  10. Route order line: the text's first line is the configured preference
 *      order handed in by the caller (the same order the rotation engine
 *      walks), first to last - one name for a one-route config, an explicit
 *      "none configured" for an empty one, and never an order derived from
 *      the report's own route list.
 *
 * Harness: the REAL modules (ring-health, route-state, key-ring, log) are
 * compiled with the package's local tsc (CJS emit) into
 * <repoRoot>/.ring-health-build/ (removed again on the way out). Cases
 * select files by an explicit `stateDir`, so nothing touches the real
 * ~/.pi/agent; the one default-path case points HOME at a scratch directory.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".ring-health-build");

let failures = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? " (" + extra + ")" : ""}`);
  }
}

function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "ring-health.ts"),
    join(pkgRoot, "route-state.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "virtual-router.ts"),
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
    console.error(
      "tsc emit failed:\n" + (tsc.stdout || "") + (tsc.stderr || ""),
    );
    process.exit(1);
  }
  if (!process.env.PI_BRAID_PROVIDER_QUIET && tsc.stdout)
    console.log(tsc.stdout.trim());
  const require = createRequire(import.meta.url);
  return {
    ringHealth: require(join(buildDir, "ring-health.js")),
    log: require(join(buildDir, "log.js")),
    keyRing: require(join(buildDir, "key-ring.js")),
    // The renderer consumes this module's death gate; the currency cases below
    // compare the marker against that gate rather than restating its rule.
    virtualRouter: require(join(buildDir, "virtual-router.js")),
  };
}

/** Duplicate of key-ring.ts hashKey (stable persisted identity). */
function hashKey(key) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Duplicate of ring-health.ts formatLocalTime (local wall clock, deterministic
 * across hosts). The rendering cases compare a timestamp the reader wrote with
 * the same wall clock read back through Date.
 */
function localTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Child that binds the notify sink, reads ONE provider's ring from RH_DIR and
 * prints { out, lines }. A fresh process means a fresh diagnostic throttle, so
 * the "exactly one" claim is per-file rather than per-run.
 */
const READ_CHILD = `
const path = require("node:path");
const rh = require(path.join(process.env.RH_BUILD_DIR, "ring-health.js"));
const log = require(path.join(process.env.RH_BUILD_DIR, "log.js"));
const lines = [];
log.setProvidersLogSink((m) => lines.push(String(m)));
let out;
try {
  out = rh.ringHealth(process.env.RH_PROVIDER, { stateDir: process.env.RH_DIR });
} catch (e) {
  out = { threw: String((e && e.message) || e) };
}
process.stdout.write(JSON.stringify({ out, lines }));
`;

/** Same child, reading twice: pins that a hot loop stays at ONE diagnostic. */
const REREAD_CHILD = `
const path = require("node:path");
const rh = require(path.join(process.env.RH_BUILD_DIR, "ring-health.js"));
const log = require(path.join(process.env.RH_BUILD_DIR, "log.js"));
const lines = [];
log.setProvidersLogSink((m) => lines.push(String(m)));
for (let i = 0; i < 3; i++) rh.ringHealth(process.env.RH_PROVIDER, { stateDir: process.env.RH_DIR });
process.stdout.write(JSON.stringify({ lines }));
`;

function childEnv(extra = {}) {
  return { ...process.env, RH_BUILD_DIR: buildDir, ...extra };
}

function readViaChild(provider, dir, script = READ_CHILD) {
  const res = spawnSync("node", ["-e", script], {
    env: childEnv({ RH_PROVIDER: provider, RH_DIR: dir }),
    encoding: "utf-8",
  });
  if (res.status !== 0)
    throw new Error(`ring-health child failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-ring-health-"));
  try {
    const caseDir = (name) => {
      const dir = join(scratch, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const writeRing = (dir, provider, doc) => {
      const file = join(dir, `.key-ring-state-${provider}.json`);
      writeFileSync(
        file,
        typeof doc === "string" ? doc : JSON.stringify(doc, null, 2),
      );
      return file;
    };

    const mods = loadModules();
    const { ringHealth, routeHealth, formatRingHealth, summarizeRouteHealth } =
      mods.ringHealth;
    const { deathInForce } = mods.virtualRouter;
    const { keyRing } = mods;

    // The death window as index.ts resolves it (no `braid.providers.probeFreshnessMs`
    // in settings ⇒ the default) plus a fixed clock, so the currency cases
    // below are exact instead of wall-clock dependent.
    const FRESHNESS_MS = 900_000;

    // ── 1. Read tolerance ───────────────────────────────────────────────
    {
      const dir = caseDir("absent");
      const { out, lines } = readViaChild("route-absent", dir);
      check(
        "absent ring file ⇒ present:false, no diagnostic and no throw",
        out.threw === undefined &&
          out.provider === "route-absent" &&
          out.present === false &&
          lines.length === 0,
        JSON.stringify({ out, lines }),
      );
    }
    for (const [name, content] of [
      ["malformed", "{not json at all"],
      ["partial", '{"version":1,"rev":1,"savedAt":1,"entries":['],
      ["wrong-version", '{"version":2,"rev":1,"savedAt":1,"entries":[]}'],
      [
        "entries-not-array",
        '{"version":1,"rev":1,"savedAt":1,"entries":"nope"}',
      ],
      ["json-null", "null"],
      ["json-array", "[]"],
      ["json-string", '"just a string"'],
    ]) {
      const dir = caseDir(`corrupt-${name}`);
      writeRing(dir, "route-corrupt", content);
      const { out, lines } = readViaChild("route-corrupt", dir);
      check(
        `${name} ring file ⇒ present:false, exactly ONE diagnostic, no throw`,
        out.threw === undefined &&
          out.present === false &&
          out.provider === "route-corrupt" &&
          lines.length === 1 &&
          lines[0].includes("ignoring unreadable key-ring state file"),
        JSON.stringify({ out, lines }),
      );
    }
    {
      const dir = caseDir("throttle");
      writeRing(dir, "route-throttle", "{broken");
      const { lines } = readViaChild("route-throttle", dir, REREAD_CHILD);
      check(
        "three reads of the same bad file stay at ONE diagnostic",
        lines.length === 1,
        JSON.stringify(lines),
      );
    }

    // ── 2. Envelope and entry mapping ───────────────────────────────────
    {
      const dir = caseDir("present");
      const key = ["sk", "ring", "identity", "abcdefghijklmnop"].join("-");
      const hash = hashKey(key);
      writeRing(dir, "route-live", {
        version: 1,
        rev: 7,
        savedAt: 1700000000000,
        activeIndex: 1,
        entries: [
          {
            hash,
            exhausted: true,
            exhaustedAt: 1700000000000,
            retryCount: 2,
            exhaustedBy: process.pid,
            key,
          },
          {
            hash: "hash-clear",
            exhausted: false,
            exhaustedAt: 0,
            retryCount: 0,
          },
        ],
      });
      const out = ringHealth("route-live", { stateDir: dir });
      check(
        "present ring file ⇒ the envelope is carried through",
        out.present === true &&
          out.provider === "route-live" &&
          out.rev === 7 &&
          out.savedAt === 1700000000000 &&
          out.activeIndex === 1 &&
          out.entries.length === 2,
        JSON.stringify(out),
      );
      check(
        "an exhausted entry maps all five fields",
        out.entries[0].exhausted === true &&
          out.entries[0].exhaustedAt === 1700000000000 &&
          out.entries[0].retryCount === 2 &&
          out.entries[0].exhaustedBy === process.pid &&
          out.entries[0].keyHash === hash,
        JSON.stringify(out.entries[0]),
      );
      check(
        "a clear entry reports exhausted:false and exhaustedBy:null",
        out.entries[1].exhausted === false &&
          out.entries[1].exhaustedBy === null &&
          out.entries[1].exhaustedAt === 0 &&
          out.entries[1].keyHash === "hash-clear",
        JSON.stringify(out.entries[1]),
      );
      const text = JSON.stringify(out);
      check(
        "the reader copies named fields only - the sibling key value never surfaces",
        text.includes(hash) && !text.includes(key),
        text,
      );
    }

    // ── 3. Lenient per-entry normalization ──────────────────────────────
    {
      const dir = caseDir("partial-entry");
      writeRing(dir, "route-partial", {
        version: 1,
        rev: 1,
        savedAt: 1,
        activeIndex: 0,
        entries: [
          { exhausted: true, exhaustedAt: 5, retryCount: 1 },
          { hash: "keep-me", exhausted: false, exhaustedAt: 0, retryCount: 0 },
          "not an object",
        ],
      });
      const out = ringHealth("route-partial", { stateDir: dir });
      check(
        "an entry without a hash is dropped; the rest survive",
        out.present === true &&
          out.entries.length === 1 &&
          out.entries[0].keyHash === "keep-me",
        JSON.stringify(out),
      );
    }

    // ── 4. routeHealth: union, facts, and per-route absence ─────────────
    {
      const dir = caseDir("route-health");
      writeRing(dir, "route-only-ring", {
        version: 1,
        rev: 3,
        savedAt: 30,
        activeIndex: 0,
        entries: [
          { hash: "h1", exhausted: false, exhaustedAt: 0, retryCount: 0 },
        ],
      });
      const routeState = {
        version: 1,
        rev: 9,
        savedAt: 90,
        routes: {
          "route-with-state": {
            lastProbe: { state: "degraded", at: 42, headroomPct: 7 },
            deathClass: "quota",
            deathAt: 41,
            deathKeyHash: "death-hash",
            failback: { target: "route-other", at: 43 },
            warmModels: ["m-1", "m-2"],
          },
        },
      };
      const out = routeHealth({
        stateDir: dir,
        providers: ["route-explicit"],
        routeState,
      });
      const byId = Object.fromEntries(out.map((r) => [r.provider, r]));
      check(
        "routeHealth reports the union: named + recorded + ring-file providers",
        Object.keys(byId).sort().join(",") ===
          "route-explicit,route-only-ring,route-with-state",
        Object.keys(byId).join(","),
      );
      check(
        "a route's recorded facts are carried through",
        byId["route-with-state"].lastProbe.state === "degraded" &&
          byId["route-with-state"].lastProbe.headroomPct === 7 &&
          byId["route-with-state"].deathClass === "quota" &&
          byId["route-with-state"].deathAt === 41 &&
          byId["route-with-state"].failback.target === "route-other" &&
          byId["route-with-state"].warmModels.join(",") === "m-1,m-2",
        JSON.stringify(byId["route-with-state"]),
      );
      check(
        "a route with a ring but no recorded facts reports the ring and empty facts",
        byId["route-only-ring"].ring.present === true &&
          byId["route-only-ring"].ring.rev === 3 &&
          byId["route-only-ring"].lastProbe === null &&
          byId["route-only-ring"].deathClass === null &&
          byId["route-only-ring"].deathAt === 0 &&
          byId["route-only-ring"].failback === null &&
          byId["route-only-ring"].warmModels.length === 0,
        JSON.stringify(byId["route-only-ring"]),
      );
      check(
        "a route with recorded facts but no ring file reports present:false",
        byId["route-with-state"].ring.present === false,
        JSON.stringify(byId["route-with-state"].ring),
      );
      check(
        "a named route with nothing recorded is reported empty",
        byId["route-explicit"].ring.present === false &&
          byId["route-explicit"].lastProbe === null &&
          byId["route-explicit"].deathAt === 0,
        JSON.stringify(byId["route-explicit"]),
      );
      check(
        "the reported route set is deterministic (sorted ring discovery)",
        JSON.stringify(out.map((r) => r.provider)) ===
          JSON.stringify([
            "route-explicit",
            "route-with-state",
            "route-only-ring",
          ]),
        JSON.stringify(out.map((r) => r.provider)),
      );
    }
    {
      const dir = caseDir("empty");
      const out = routeHealth({
        stateDir: dir,
        routeState: { version: 1, rev: 0, savedAt: 0, routes: {} },
      });
      check(
        "nothing recorded and no ring files ⇒ an empty report",
        Array.isArray(out) && out.length === 0,
        JSON.stringify(out),
      );
    }

    // ── 5. Default path and writer/reader agreement ─────────────────────
    {
      const dir = caseDir("home-default");
      const agentDir = join(dir, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeRing(agentDir, "route-home", {
        version: 1,
        rev: 5,
        savedAt: 55,
        activeIndex: 0,
        entries: [],
      });
      const prevHome = process.env.HOME;
      process.env.HOME = dir;
      let out;
      try {
        out = ringHealth("route-home");
      } finally {
        process.env.HOME = prevHome;
      }
      check(
        "with no path given, the reader looks where the writer writes",
        out.present === true && out.rev === 5 && out.entries.length === 0,
        JSON.stringify(out),
      );
    }
    {
      const dir = caseDir("writer-reader");
      mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
      const prefix = "RH_TEST_KEY";
      const key = ["sk", "ring", "value", "zzzzzzzzzzzzzzzzzzzz"].join("-");
      const prevHome = process.env.HOME;
      process.env.HOME = dir;
      process.env[`${prefix}_P0`] = key;
      let out;
      try {
        const ring = keyRing.createKeyRing({
          prefix,
          stateFile: "route-e2e",
        });
        ring.exhaustActiveKey();
        out = ringHealth("route-e2e");
      } finally {
        process.env.HOME = prevHome;
        delete process.env[`${prefix}_P0`];
      }
      check(
        "a real ring exhaustion is read back: envelope, hash-only entry, writer's pid",
        out.present === true &&
          out.entries.length === 1 &&
          out.entries[0].exhausted === true &&
          out.entries[0].keyHash === hashKey(key) &&
          out.entries[0].exhaustedBy === process.pid &&
          !JSON.stringify(out).includes(key),
        JSON.stringify(out),
      );
    }

    // ── 6. Read-only ────────────────────────────────────────────────────
    {
      const dir = caseDir("read-only");
      const file = writeRing(dir, "route-ro", {
        version: 1,
        rev: 4,
        savedAt: 4,
        activeIndex: 0,
        entries: [
          { hash: "h", exhausted: true, exhaustedAt: 4, retryCount: 1 },
        ],
      });
      const before = readFileSync(file, "utf8");
      const beforeMtime = statSync(file).mtimeMs;
      const beforeDir = readdirSync(dir).sort().join(",");
      ringHealth("route-ro", { stateDir: dir });
      routeHealth({
        stateDir: dir,
        providers: ["route-ro"],
        routeState: { version: 1, rev: 1, savedAt: 1, routes: {} },
      });
      const after = readFileSync(file, "utf8");
      const afterDir = readdirSync(dir).sort().join(",");
      check(
        "the reader mutates nothing: bytes, mtime and directory listing unchanged",
        before === after &&
          statSync(file).mtimeMs === beforeMtime &&
          beforeDir === afterDir,
        JSON.stringify({ beforeDir, afterDir }),
      );
    }

    // ── 7. Rendering ─────────────���──────────────────────────────────────
    // The line the `ring_health` tool hands the model and the hash-free
    // summary it hands `details`. Both are pure over a routeHealth report, so
    // they are pinned here with no pi runtime: the text is the observable
    // contract, and "no key material" is checked on both outputs. The window
    // these cases pass keeps every fixture death in force, so the pre-marker
    // text is pinned byte for byte (the currency cases are section 9).
    const inForce = { freshnessMs: FRESHNESS_MS, now: 5 };
    {
      const dir = caseDir("render");
      const key = ["sk", "ring", "render", "aaaaaaaaaaaaaaaa"].join("-");
      const hash = hashKey(key);
      writeRing(dir, "route-render", {
        version: 1,
        rev: 12,
        savedAt: 1700000000000,
        activeIndex: 0,
        entries: [
          {
            hash,
            exhausted: true,
            exhaustedAt: 1700000001000,
            retryCount: 3,
            exhaustedBy: process.pid,
            key,
          },
          {
            hash: "hash-usable",
            exhausted: false,
            exhaustedAt: 0,
            retryCount: 0,
          },
        ],
      });
      writeRing(dir, "route-bad", "{broken");

      const diagnosed = [];
      mods.log.setProvidersLogSink((m) => diagnosed.push(String(m)));
      let text;
      let summaries;
      let threw = null;
      try {
        const out = routeHealth({
          stateDir: dir,
          providers: ["route-missing"],
          routeState: {
            version: 1,
            rev: 1,
            savedAt: 1,
            routes: {
              "route-render": {
                lastProbe: {
                  state: "degraded",
                  at: 5,
                  headroomPct: 7,
                  remainingUsd: 0.8,
                  resetAt: 1700003600000,
                },
                deathClass: "quota",
                deathAt: 4,
                deathKeyHash: "death-hash",
                failback: null,
                warmModels: [],
              },
              "route-sparse": {
                lastProbe: { state: "unavailable", at: 6, reason: "http 429" },
                deathClass: null,
                deathAt: 0,
                deathKeyHash: null,
                failback: null,
                warmModels: [],
              },
            },
          },
        });
        text = formatRingHealth(out, inForce, ["route-render", "route-sparse"]);
        summaries = summarizeRouteHealth(out, inForce);
      } catch (e) {
        threw = String((e && e.message) || e);
      } finally {
        mods.log.setProvidersLogSink(undefined);
      }

      const raw = text === undefined ? [] : text.split("\n");
      // The order line leads the text; splitting it off keeps the per-line pins
      // below addressing the body positions they always did (section 10 pins
      // the order line itself).
      const [orderLine, ...lines] = raw;
      check(
        "rendering a mixed report throws nothing",
        threw === null && lines.length === 6,
        JSON.stringify({ threw, lines }),
      );
      check(
        "the configured order leads the text",
        orderLine ===
          "route order (preference): route-render > route-sparse; a fresh session starts at the first healthy route",
        orderLine,
      );
      check(
        "the header states the surface is read-only",
        lines[0] ===
          "ring health (read-only: no probe, no rotation, no provider request, no write)",
        lines[0],
      );
      check(
        "a provider with no ring file renders as no ring state",
        lines[1] === "route-missing  ring: no ring state",
        lines[1],
      );
      check(
        "a malformed ring file renders as no ring state, with exactly ONE diagnostic",
        lines[4] === "route-bad  ring: no ring state" &&
          diagnosed.length === 1 &&
          diagnosed[0].includes("ignoring unreadable key-ring state file"),
        JSON.stringify({ line: lines[4], diagnosed }),
      );
      check(
        "a live ring renders its revision, save time, active index and usable/total",
        lines[2].startsWith(
          `route-render  ring: rev 12 saved ${localTime(1700000000000)} active #0 usable 1/2 keys [`,
        ),
        lines[2],
      );
      check(
        "each key renders as #i usable, or exhausted with its time and retries",
        lines[2].includes(
          `#0 exhausted ${localTime(1700000001000)} retries 3 | #1 usable`,
        ),
        lines[2],
      );
      check(
        "the route facts render state, headroom, balance, reset time and the recorded death",
        lines[2].endsWith(
          `route: degraded headroom 7% remaining $0.80 reset ${localTime(1700003600000)}` +
            ` death quota ${localTime(4)}`,
        ),
        lines[2],
      );
      check(
        "a probe lacking headroom, balance and reset renders placeholders and its reason",
        lines[3] ===
          'route-sparse  ring: no ring state  route: unavailable headroom - remaining - reset none reason "http 429"',
        lines[3],
      );
      check(
        "the summary line counts routes, rings and keys",
        lines[5] === "summary: routes 4, with ring state 1, keys usable 1/2",
        lines[5],
      );
      check(
        "the rendered text carries no key hash and no key value",
        !text.includes(hash) &&
          !text.includes(key) &&
          !text.includes("hash-usable") &&
          !text.includes("death-hash"),
        text,
      );
      check(
        "the summary carries the counts and drops every hash",
        summaries.length === 4 &&
          summaries[1].provider === "route-render" &&
          summaries[1].ring.present === true &&
          summaries[1].ring.rev === 12 &&
          summaries[1].ring.savedAt === 1700000000000 &&
          summaries[1].ring.activeIndex === 0 &&
          summaries[1].ring.usable === 1 &&
          summaries[1].ring.total === 2 &&
          summaries[1].ring.entries.length === 2 &&
          summaries[1].ring.entries[0].exhausted === true &&
          summaries[1].ring.entries[0].exhaustedAt === 1700000001000 &&
          summaries[1].ring.entries[0].retryCount === 3 &&
          summaries[1].route.state === "degraded" &&
          summaries[1].route.headroomPct === 7 &&
          summaries[1].route.remainingUsd === 0.8 &&
          summaries[1].route.resetAt === 1700003600000 &&
          summaries[1].route.reason === null &&
          summaries[1].route.deathClass === "quota" &&
          summaries[1].route.deathAt === 4 &&
          summaries[1].route.deathExpired === false &&
          summaries[2].route.deathClass === null &&
          summaries[2].route.reason === "http 429" &&
          summaries[2].route.headroomPct === null &&
          summaries[2].route.remainingUsd === null &&
          summaries[2].route.resetAt === null &&
          summaries[0].route === null &&
          summaries[3].ring.present === false &&
          !JSON.stringify(summaries).includes(hash) &&
          !JSON.stringify(summaries).includes(key),
        JSON.stringify(summaries),
      );
      const empty = formatRingHealth([], inForce, []);
      check(
        "an empty report renders the empty order, the header and a zeroed summary",
        empty ===
          "route order (preference): none configured\n" +
            "ring health (read-only: no probe, no rotation, no provider request, no write)\n" +
            "summary: routes 0, with ring state 0, keys usable 0/0",
        empty,
      );
    }

    // ── 8. A recorded death with no probe is still printed ──────────────────
    // The operator surface must show a recorded shape death even when the
    // route has no probe snapshot: the shape walk is that record's only writer.
    {
      const dir = caseDir("render-death-only");
      const out = routeHealth({
        stateDir: dir,
        providers: ["route-death-only"],
        routeState: {
          version: 1,
          rev: 1,
          savedAt: 1,
          routes: {
            "route-death-only": {
              lastProbe: null,
              deathClass: "request-shape",
              deathAt: 1700000002000,
              deathKeyHash: null,
              failback: null,
              warmModels: [],
            },
          },
        },
      });
      // One tick after the death: in force, so the death-only line renders
      // without the expiry marker.
      const inForceHere = { freshnessMs: FRESHNESS_MS, now: 1700000002001 };
      const [summary] = summarizeRouteHealth(out, inForceHere);
      check(
        "a recorded death without a probe appears in the printed summary",
        summary.route !== null &&
          summary.route.deathClass === "request-shape" &&
          summary.route.deathAt === 1700000002000 &&
          summary.route.state === "no probe" &&
          summary.route.deathExpired === false,
        JSON.stringify(summary),
      );
      const line = formatRingHealth(out, inForceHere, [
        "route-death-only",
      ]).split("\n")[2];
      check(
        "the death-only line names the class and the death time",
        line ===
          `route-death-only  ring: no ring state  route: no probe headroom - ` +
            `remaining - reset none death request-shape ${localTime(1700000002000)}`,
        line,
      );
    }

    // ── 9. Death currency ───────────────────────────────────────────────────
    // The operator surface must not report a death the router has stopped
    // acting on: a route that died days ago and has served every turn since
    // would otherwise read as down. The marker is the gate's own verdict, so
    // this section checks the text against `deathInForce` itself - a second
    // age test in the renderer cannot pass here. The bound is the router's
    // (`now - deathAt < freshnessMs`): a death exactly AT the bound is out.
    {
      const dir = caseDir("render-currency");
      const NOW = 1_700_000_000_000;
      const deathAtOf = {
        "route-in-window": NOW - 1,
        "route-at-bound": NOW - FRESHNESS_MS,
        "route-past": NOW - FRESHNESS_MS - 1,
        "route-untimed": 0,
      };
      const entry = (deathAt) => ({
        lastProbe: null,
        deathClass: "request-shape",
        deathAt,
        deathKeyHash: null,
        deathModelId: null,
        failback: null,
        warmModels: [],
      });
      const probeOnly = {
        lastProbe: { state: "ok", at: NOW },
        deathClass: null,
        deathAt: 0,
        deathKeyHash: null,
        deathModelId: null,
        failback: null,
        warmModels: [],
      };
      const out = routeHealth({
        stateDir: dir,
        providers: [...Object.keys(deathAtOf), "route-probe-only"],
        routeState: {
          version: 1,
          rev: 1,
          savedAt: 1,
          routes: {
            ...Object.fromEntries(
              Object.entries(deathAtOf).map(([id, at]) => [id, entry(at)]),
            ),
            // A probe with no death: nothing to expire, so no marker.
            "route-probe-only": probeOnly,
          },
        },
      });

      const window = { freshnessMs: FRESHNESS_MS, now: NOW };
      const order = [...Object.keys(deathAtOf), "route-probe-only"];
      const lineOf = (id) =>
        formatRingHealth(out, window, order)
          .split("\n")
          .find((l) => l.startsWith(`${id}  `));
      const gate = (deathAt) =>
        deathInForce("request-shape", deathAt, {
          freshnessMs: FRESHNESS_MS,
          now: NOW,
        });
      const marked = (line) => line.includes(" (expired)");

      const inWindow = lineOf("route-in-window");
      check(
        "a death inside the window renders unmarked, byte for byte",
        inWindow ===
          `route-in-window  ring: no ring state  route: no probe headroom - ` +
            `remaining - reset none death request-shape ${localTime(NOW - 1)}`,
        inWindow,
      );

      const atBound = lineOf("route-at-bound");
      check(
        "a death exactly at the bound is marked expired, like the gate it mirrors",
        atBound ===
          `route-at-bound  ring: no ring state  route: no probe headroom - ` +
            `remaining - reset none death request-shape ${localTime(NOW - FRESHNESS_MS)} (expired)` &&
          gate(NOW - FRESHNESS_MS) === false,
        atBound,
      );

      const past = lineOf("route-past");
      check(
        "a death past the window is marked expired",
        past ===
          `route-past  ring: no ring state  route: no probe headroom - ` +
            `remaining - reset none death request-shape ${localTime(NOW - FRESHNESS_MS - 1)} (expired)`,
        past,
      );

      const untimed = lineOf("route-untimed");
      check(
        "a recorded death with no time is marked expired",
        untimed ===
          "route-untimed  ring: no ring state  route: no probe headroom - " +
            "remaining - reset none death request-shape unknown (expired)",
        untimed,
      );

      check(
        "a route with a probe and no death is never marked expired",
        lineOf("route-probe-only") ===
          "route-probe-only  ring: no ring state  " +
            "route: ok headroom - remaining - reset none",
        lineOf("route-probe-only"),
      );

      // The anti-drift check: the marker is the gate's verdict for the same
      // record, not a rule of its own.
      check(
        "every line's marker agrees with the router's own gate",
        Object.entries(deathAtOf).every(
          ([id, at]) => marked(lineOf(id)) === !gate(at),
        ) && gate(NOW - 1) === true,
        JSON.stringify(
          Object.entries(deathAtOf).map(([id]) => [id, lineOf(id)]),
        ),
      );

      const summaries = summarizeRouteHealth(out, window);
      const summaryOf = (id) => summaries.find((s) => s.provider === id).route;
      check(
        "the details summary carries the same verdict",
        summaryOf("route-in-window").deathExpired === false &&
          summaryOf("route-at-bound").deathExpired === true &&
          summaryOf("route-past").deathExpired === true &&
          summaryOf("route-untimed").deathExpired === true &&
          summaryOf("route-probe-only").deathExpired === false,
        JSON.stringify(summaries.map((s) => [s.provider, s.route])),
      );

      const offLine = (id) =>
        formatRingHealth(out, { freshnessMs: 0, now: NOW }, order)
          .split("\n")
          .find((l) => l.startsWith(`${id}  `));
      check(
        "the off switch expires every recorded death, in-window ones included",
        marked(offLine("route-in-window")) &&
          marked(offLine("route-at-bound")) &&
          marked(offLine("route-past")) &&
          marked(offLine("route-untimed")) &&
          !marked(offLine("route-probe-only")),
        JSON.stringify(offLine("route-in-window")),
      );
    }

    // ── 10. Route order line ────────────────────────────────────────────────
    // The text's first line states the configured preference order, handed in
    // by the caller that owns the route table (the same array the rotation
    // engine walks). The report's own order is the union of route-state keys
    // and ring files, so a line derived from the report instead of the argument
    // shows up here: the fixture rings are discovered in an order the configured
    // order does not share.
    {
      const dir = caseDir("render-order");
      for (const id of ["route-a", "route-b", "route-c"]) {
        writeRing(dir, id, {
          version: 1,
          rev: 1,
          savedAt: 1,
          activeIndex: 0,
          entries: [
            {
              hash: `hash-${id}`,
              exhausted: false,
              exhaustedAt: 0,
              retryCount: 0,
            },
          ],
        });
      }
      const report = routeHealth({
        stateDir: dir,
        routeState: { version: 1, rev: 1, savedAt: 1, routes: {} },
      });
      const reported = report.map((route) => route.provider);
      check(
        "the fixture separates the configured order from the reported order",
        reported.join(",") === "route-a,route-b,route-c",
        JSON.stringify(reported),
      );

      const text = formatRingHealth(report, inForce, ["route-c", "route-a"]);
      const [first, header, ...rest] = text.split("\n");
      check(
        "the text's first line is the configured order, first to last",
        first ===
          "route order (preference): route-c > route-a; a fresh session starts at the first healthy route",
        first,
      );
      // The same report rendered with the report's own order as the argument
      // yields that order: the line is the argument's, and a renderer that read
      // the order off the ring list would fail one of these two.
      const asReportOrder = formatRingHealth(report, inForce, reported).split(
        "\n",
      )[0];
      check(
        "the order line follows the configured order, not the report's",
        first !== asReportOrder &&
          asReportOrder ===
            "route order (preference): route-a > route-b > route-c; a fresh session starts at the first healthy route",
        JSON.stringify({ configured: first, asReportOrder }),
      );
      check(
        "the per-route lines keep the report's own order and the header its wording",
        header ===
          "ring health (read-only: no probe, no rotation, no provider request, no write)" &&
          rest
            .slice(0, reported.length)
            .every((line, i) => line.startsWith(`${reported[i]}  `)),
        JSON.stringify({ header, rest }),
      );

      const single = formatRingHealth(report, inForce, ["route-b"]);
      check(
        "a one-route config prints the one name it was given",
        single.split("\n")[0] ===
          "route order (preference): route-b; a fresh session starts at the first healthy route",
        single.split("\n")[0],
      );

      const noneFirst = formatRingHealth(report, inForce, []).split("\n")[0];
      check(
        "an empty order says so rather than naming a reported route",
        noneFirst === "route order (preference): none configured" &&
          !["route-a", "route-b", "route-c"].some((id) =>
            noneFirst.includes(id),
          ),
        noneFirst,
      );
    }

    if (failures > 0) {
      console.error(`\n${total - failures}/${total} checks passed`);
      process.exit(1);
    }
    console.log(`\n${total}/${total} checks passed`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }
}

run();
