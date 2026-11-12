#!/usr/bin/env node
/**
 * rotation-census.test.mjs
 *
 * Behavior pins for packages/providers/rotation-census.ts, offline: the
 * bounded rotation counter the walk writes one row to per rotation, and the
 * `ring_health` section it renders. Six arms:
 *
 *   1. Counts: five shape rotations, three transport rotations and no key
 *      rotation across a few route pairs produce exactly those counters and
 *      exactly those per-pair counts, and the section text states them. The
 *      same arm pins the store's location (the providers state directory, with
 *      no second convention) and the section's place in the `ring_health` text
 *      (before the summary line, which stays last).
 *   2. Class fidelity: the stored class is the one the walk passed. The
 *      classifier is run on a message that names a port (`:443`), which the
 *      walk reads as `transport`; the row keeps that class. A row recorded with
 *      a class a pre-fix build would have passed (`shape`, status `443`) reads
 *      back unchanged, so the reader never re-labels a stored row from any
 *      text.
 *   3. Bounded growth: the two bounds are pinned as literals (14 days, 200
 *      rows per day); 250 rows in one day keep the newest 200 with the oldest
 *      gone, and 20 days keep the newest 14.
 *   4. Atomicity: a write that cannot complete (a directory occupying the temp
 *      path; a read-only state directory) throws nothing, leaves the previous
 *      record readable and unchanged, and the next write resumes normally. A
 *      diagnostic sink that throws cannot turn either into a throw, checked in
 *      a fresh process so a throttle cannot make the check vacuous.
 *   5. Corrupt record: a truncated JSON file reads as `no record`, names the
 *      file in exactly ONE diagnostic, and the next rotation replaces it, after
 *      which nothing is diagnosed as corruption.
 *   6. The control: a host that recorded nothing prints the zero table with one
 *      line saying so (not an error, not `no record`), and the case asserts
 *      what such a run leaves behind: no file at all, because the recorder
 *      writes only when it has a row.
 *
 * Harness: the REAL modules (rotation-census, ring-health, ring-lifecycle,
 * route-state, key-ring, virtual-router, log, state-paths) are compiled with
 * the package's own local tsc (CJS emit) into a temp dir OUTSIDE the repo and
 * driven with no network. Every case selects its own file or directory, so no
 * state file outside the scratch tree is touched; the one default-path case
 * points HOME at the scratch tree.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

/** Fixture clock: local noon, so every case is far from a day boundary. */
const BASE = new Date(2024, 0, 1, 12, 0, 0).getTime();
const MINUTE = 60_000;

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

/** Compile the real modules to CJS and load them. */
function loadModules(buildDir) {
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "rotation-census.ts"),
    join(pkgRoot, "state-paths.ts"),
    join(pkgRoot, "ring-health.ts"),
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "outage-watch.ts"),
    join(pkgRoot, "route-state.ts"),
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
    census: require(join(buildDir, "rotation-census.js")),
    ringHealth: require(join(buildDir, "ring-health.js")),
    lifecycle: require(join(buildDir, "ring-lifecycle.js")),
    log: require(join(buildDir, "log.js")),
  };
}

/**
 * Child that binds a log sink which throws, forces a census write to fail, and
 * reports what escaped. A fresh process means fresh throttle state, so the
 * loud-first occurrence really is loud here.
 */
const THROWING_SINK_CHILD = `
const path = require("node:path");
const fs = require("node:fs");
const rc = require(path.join(process.env.RC_BUILD_DIR, "rotation-census.js"));
const log = require(path.join(process.env.RC_BUILD_DIR, "log.js"));
log.setProvidersLogSink(() => {
  throw new Error("sink down");
});
const file = process.env.RC_FILE;
fs.mkdirSync(file + ".tmp." + process.pid, { recursive: true });
let threw = null;
try {
  rc.recordRotation(
    { from: "route-c", to: "route-d", class: "shape", status: 400, at: 1 },
    { file },
  );
} catch (e) {
  threw = String((e && e.message) || e);
}
const read = rc.readRotationCensus({ file });
const rows = Object.values(read.days).flat();
process.stdout.write(
  JSON.stringify({ threw, rows: rows.length, first: rows[0] || null }),
);
`;

/** Local `YYYY-MM-DD`, the census's own day key (duplicated from the module). */
function dayKey(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every stored row, oldest day first, for order-independent assertions. */
function rowsOf(census) {
  const rows = [];
  for (const key of Object.keys(census.days).sort())
    rows.push(...census.days[key]);
  return rows;
}

/** `[from -> to, n]` pairs, sorted, for exact counter comparisons. */
function pairsOf(rows) {
  const counts = new Map();
  for (const row of rows) {
    const pair = `${row.from} -> ${row.to}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Class tallies, sorted, for exact counter comparisons. */
function classesOf(rows) {
  const counts = new Map();
  for (const row of rows)
    counts.set(row.class, (counts.get(row.class) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function run() {
  const scratch = mkdtempSync(join(tmpdir(), "rotation-census-"));
  const buildDir = mkdtempSync(join(tmpdir(), "rotation-census-build-"));
  const mods = loadModules(buildDir);
  const { census, ringHealth, lifecycle, log } = mods;
  const caseDir = (name) => {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  try {
    // ── 1. Counts, default path, and the section's place in the tool text ──
    {
      const dir = caseDir("counts");
      const file = join(dir, "census.json");
      const rows = [
        ["opencode-go", "agent-zero", "shape", 400],
        ["opencode-go", "agent-zero", "shape", 400],
        ["opencode-go", "agent-zero", "shape", 400],
        ["opencode-go", "agent-zero", "shape", 400],
        ["opencode-go", "openrouter", "shape", 400],
        ["agent-zero", "opencode-go", "transport", null],
        ["agent-zero", "opencode-go", "transport", null],
        ["agent-zero", "opencode-go", "transport", null],
      ];
      let threw = null;
      try {
        rows.forEach(([from, to, cls, status], i) =>
          census.recordRotation(
            { from, to, class: cls, status, at: BASE + i * MINUTE },
            { file },
          ),
        );
      } catch (e) {
        threw = String((e && e.message) || e);
      }
      const read = census.readRotationCensus({ file });
      const stored = rowsOf(read);
      check(
        "recording eight rotations throws nothing and reads back the same rows",
        threw === null && read.state === "ok" && stored.length === 8,
        JSON.stringify({ threw, state: read.state, stored: stored.length }),
      );
      check(
        "the class counters are exactly the ones recorded",
        JSON.stringify(classesOf(stored)) ===
          JSON.stringify([
            ["shape", 5],
            ["transport", 3],
          ]),
        JSON.stringify(classesOf(stored)),
      );
      check(
        "the per-pair counters are exactly the ones recorded",
        JSON.stringify(pairsOf(stored)) ===
          JSON.stringify([
            ["agent-zero -> opencode-go", 3],
            ["opencode-go -> agent-zero", 4],
            ["opencode-go -> openrouter", 1],
          ]),
        JSON.stringify(pairsOf(stored)),
      );
      const text = census.formatRotationSection(read, {
        now: BASE + 2 * MINUTE,
      });
      check(
        "the section states the total, every class (a key zero included) and every pair count",
        text ===
          "rotations, last 7 day(s): 8 total\n" +
            "  shape       5   opencode-go -> agent-zero (4), opencode-go -> openrouter (1)\n" +
            "  transport   3   agent-zero -> opencode-go (3)\n" +
            "  capacity    0\n" +
            "  key         0\n" +
            "  waf         0",
        text,
      );

      // The census rides in the tool's own report: the section sits between the
      // per-route lines and the summary, so the summary line stays last. The
      // section's window is the wall clock the tool reads (the renderer takes
      // its clock from the caller, and the tool passes none), so this fixture
      // is stamped now rather than at the case clock.
      const recentFile = join(dir, "recent.json");
      census.recordRotation(
        {
          from: "opencode-go",
          to: "agent-zero",
          class: "key",
          status: null,
          at: Date.now(),
        },
        { file: recentFile },
      );
      census.recordRotation(
        {
          from: "opencode-go",
          to: "agent-zero",
          class: "key",
          status: null,
          at: Date.now(),
        },
        { file: recentFile },
      );
      const report = ringHealth
        .formatRingHealth(
          [],
          { freshnessMs: 0 },
          [],
          census.readRotationCensus({ file: recentFile }),
        )
        .split("\n");
      check(
        "the ring_health text carries the section and still ends on the summary line",
        report.includes("rotations, last 7 day(s): 2 total") &&
          report[report.length - 1] ===
            "summary: routes 0, with ring state 0, keys usable 0/0",
        JSON.stringify(report),
      );

      // The default path is route-state.ts's directory, with no second
      // convention: with no path given the record lands in `<HOME>/.pi/agent`.
      const home = caseDir("home");
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      let defaultThrew = null;
      try {
        census.recordRotation({
          from: "opencode-go",
          to: "agent-zero",
          class: "shape",
          status: 400,
          at: BASE,
        });
      } catch (e) {
        defaultThrew = String((e && e.message) || e);
      }
      const defaultFile = join(
        home,
        ".pi",
        "agent",
        ".provider-rotation-census.json",
      );
      const defaultRows = existsSync(defaultFile)
        ? rowsOf(census.readRotationCensus())
        : [];
      process.env.HOME = prevHome;
      check(
        "with no path given the record lands in the providers state directory",
        defaultThrew === null &&
          defaultRows.length === 1 &&
          defaultRows[0].from === "opencode-go",
        JSON.stringify({ defaultThrew, defaultRows }),
      );
    }

    // ── 2. Class fidelity ──
    // The recorder is handed the class; it never sees the message. The
    // classifier is the walk's own, run here on a text whose "port" a
    // pre-fix build read as a status.
    {
      const dir = caseDir("class-fidelity");
      const file = join(dir, "census.json");
      const signal = lifecycle.classifyFailure(
        "connect timeout to gw.example.test:443 while streaming",
      );
      check(
        "the walk reads a connect timeout as transport, with no status",
        signal.class === "transport" && signal.status === null,
        JSON.stringify(signal),
      );
      census.recordRotation(
        {
          from: "opencode-go",
          to: "agent-zero",
          class: signal.class,
          status: signal.status,
          at: BASE,
        },
        { file },
      );
      const stored = rowsOf(census.readRotationCensus({ file }));
      check(
        "the stored class is the one the walk passed, not a reading of the text",
        stored.length === 1 &&
          stored[0].class === "transport" &&
          stored[0].status === null,
        JSON.stringify(stored),
      );

      // The other direction: a row that carries a status a later build would
      // not produce reads back exactly as stored. A reader that re-derived the
      // class from its text would rewrite this row.
      census.recordRotation(
        {
          from: "opencode-go",
          to: "route-b",
          class: "shape",
          status: 443,
          at: BASE + MINUTE,
        },
        { file },
      );
      const second = rowsOf(census.readRotationCensus({ file }))[1];
      check(
        "a stored row is never re-labelled by the reader",
        second.class === "shape" && second.status === 443,
        JSON.stringify(second),
      );
    }

    // ── 3. Bounded growth ──
    {
      const dir = caseDir("bounded");
      const file = join(dir, "census.json");
      check(
        "the record keeps a fortnight and 200 rows per day",
        census.CENSUS_DAYS === 14 && census.CENSUS_ROWS_PER_DAY === 200,
        JSON.stringify({
          days: census.CENSUS_DAYS,
          rows: census.CENSUS_ROWS_PER_DAY,
        }),
      );

      const day = new Date(2024, 2, 1, 12, 0, 0).getTime();
      for (let i = 0; i < 250; i++) {
        census.recordRotation(
          {
            from: "route-a",
            to: "route-b",
            class: "shape",
            status: 400,
            at: day + i * 1000,
          },
          { file },
        );
      }
      const storm = census.readRotationCensus({ file });
      const buckets = Object.values(storm.days);
      const bucket = buckets[0] ?? [];
      check(
        "250 rows in one day keep the newest 200, oldest gone, newest present",
        buckets.length === 1 &&
          bucket.length === 200 &&
          bucket[0].at === day + 50 * 1000 &&
          bucket[199].at === day + 249 * 1000 &&
          !bucket.some((row) => row.at === day),
        JSON.stringify({
          days: buckets.length,
          rows: bucket.length,
          first: bucket[0] && bucket[0].at - day,
          last: bucket[199] && bucket[199].at - day,
        }),
      );

      for (let d = 0; d < 20; d++) {
        census.recordRotation(
          {
            from: "route-a",
            to: "route-b",
            class: "shape",
            status: 400,
            at: new Date(2024, 2, 1 + d, 12, 0, 0).getTime(),
          },
          { file },
        );
      }
      const many = census.readRotationCensus({ file });
      const keys = Object.keys(many.days).sort();
      check(
        "20 days keep the newest 14 and drop the oldest six",
        keys.length === 14 &&
          keys[13] === dayKey(new Date(2024, 2, 20, 12, 0, 0).getTime()) &&
          keys[0] === dayKey(new Date(2024, 2, 7, 12, 0, 0).getTime()) &&
          !keys.includes(dayKey(new Date(2024, 2, 1, 12, 0, 0).getTime())),
        JSON.stringify({ keys: keys.length, first: keys[0], last: keys[13] }),
      );
    }

    // ── 4. Atomicity: a failed write changes nothing and throws nothing ──
    {
      const dir = caseDir("atomic");
      const file = join(dir, "census.json");
      census.recordRotation(
        {
          from: "route-a",
          to: "route-b",
          class: "key",
          status: null,
          at: BASE,
        },
        { file },
      );
      const before = readFileSync(file, "utf8");

      // A directory occupies the name the writer renames FROM, so the write
      // cannot complete and the previous record must survive it.
      const blockedTemp = `${file}.tmp.${process.pid}`;
      mkdirSync(blockedTemp);
      let threw = null;
      try {
        census.recordRotation(
          {
            from: "route-c",
            to: "route-d",
            class: "shape",
            status: 400,
            at: BASE + 1,
          },
          { file },
        );
      } catch (e) {
        threw = String((e && e.message) || e);
      }
      const after = readFileSync(file, "utf8");
      const read = census.readRotationCensus({ file });
      check(
        "a write that cannot complete returns without throwing and keeps the previous record",
        threw === null &&
          after === before &&
          rowsOf(read).length === 1 &&
          rowsOf(read)[0].from === "route-a",
        JSON.stringify({ threw, rows: rowsOf(read).length }),
      );
      rmSync(blockedTemp, { recursive: true, force: true });

      // The same file resumes writing once the obstruction is gone.
      census.recordRotation(
        {
          from: "route-c",
          to: "route-d",
          class: "shape",
          status: 400,
          at: BASE + 2,
        },
        { file },
      );
      check(
        "the next write after a failure lands normally",
        rowsOf(census.readRotationCensus({ file })).length === 2,
        JSON.stringify(rowsOf(census.readRotationCensus({ file }))),
      );

      // A read-only state directory: the write is refused by the filesystem
      // itself. Skipped as root, where the mode bits do not bind.
      if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
        const locked = caseDir("read-only");
        const lockedFile = join(locked, "census.json");
        census.recordRotation(
          {
            from: "route-a",
            to: "route-b",
            class: "waf",
            status: 503,
            at: BASE,
          },
          { file: lockedFile },
        );
        const lockedBefore = readFileSync(lockedFile, "utf8");
        chmodSync(locked, 0o500);
        let roThrew = null;
        try {
          census.recordRotation(
            {
              from: "route-c",
              to: "route-d",
              class: "shape",
              status: 400,
              at: BASE + 1,
            },
            { file: lockedFile },
          );
        } catch (e) {
          roThrew = String((e && e.message) || e);
        } finally {
          chmodSync(locked, 0o700);
        }
        check(
          "a read-only state directory keeps the previous record and throws nothing",
          roThrew === null &&
            readFileSync(lockedFile, "utf8") === lockedBefore &&
            rowsOf(census.readRotationCensus({ file: lockedFile })).length ===
              1,
          JSON.stringify({ roThrew }),
        );
      } else {
        console.log(
          "  note - read-only directory case skipped (running as root)",
        );
      }

      // A sink that throws must not turn the report of a failed write into a
      // throw. Run in a fresh process so the throttle is loud there.
      const child = spawnSync(process.execPath, ["-e", THROWING_SINK_CHILD], {
        cwd: pkgRoot,
        encoding: "utf-8",
        env: { ...process.env, RC_BUILD_DIR: buildDir, RC_FILE: file },
      });
      let childOut = null;
      try {
        childOut = JSON.parse(child.stdout || "null");
      } catch {
        childOut = null;
      }
      check(
        "a diagnostic sink that throws cannot break the recorder",
        child.status === 0 &&
          childOut !== null &&
          childOut.threw === null &&
          childOut.rows === 2 &&
          childOut.first &&
          childOut.first.from === "route-a",
        JSON.stringify({
          status: child.status,
          childOut,
          stderr: child.stderr,
        }),
      );
    }

    // ── 5. Corrupt record ──
    {
      const dir = caseDir("corrupt");
      const file = join(dir, "census.json");
      writeFileSync(
        file,
        '{"version":1,"savedAt":1,"days":{"2024-01-01":[{"from":"opencode-go","to":"ag',
      );
      const lines = [];
      log.setProvidersLogSink((message) => lines.push(String(message)));
      let threw = null;
      let read = null;
      let text = null;
      try {
        read = census.readRotationCensus({ file });
        text = census.formatRotationSection(read, { now: BASE });
      } catch (e) {
        threw = String((e && e.message) || e);
      }
      check(
        "a truncated record reads as unavailable and prints no record",
        threw === null &&
          read.state === "unavailable" &&
          rowsOf(read).length === 0 &&
          text === "rotations, last 7 day(s): no record",
        JSON.stringify({ threw, state: read && read.state, text }),
      );
      check(
        "the corrupt record is named in exactly one diagnostic",
        lines.length === 1 &&
          lines[0].includes("ignoring unreadable census file") &&
          lines[0].includes(file),
        JSON.stringify(lines),
      );
      census.readRotationCensus({ file });
      check(
        "a repeat read inside the throttle window stays silent",
        lines.length === 1,
        JSON.stringify(lines),
      );

      let writeThrew = null;
      try {
        census.recordRotation(
          {
            from: "opencode-go",
            to: "agent-zero",
            class: "shape",
            status: 400,
            at: BASE,
          },
          { file },
        );
      } catch (e) {
        writeThrew = String((e && e.message) || e);
      }
      const after = census.readRotationCensus({ file });
      check(
        "the next rotation replaces the corrupt record",
        writeThrew === null &&
          after.state === "ok" &&
          rowsOf(after).length === 1 &&
          rowsOf(after)[0].from === "opencode-go",
        JSON.stringify({ writeThrew, state: after.state, rows: rowsOf(after) }),
      );
      check(
        "the replacement is not diagnosed as corruption",
        lines.length === 1,
        JSON.stringify(lines),
      );
      log.setProvidersLogSink(undefined);
    }

    // ── 6. The control: a host that recorded nothing ──
    {
      const dir = caseDir("quiet");
      const file = join(dir, "census.json");
      const lines = [];
      log.setProvidersLogSink((message) => lines.push(String(message)));
      let threw = null;
      let read = null;
      let text = null;
      try {
        read = census.readRotationCensus({ file });
        text = census.formatRotationSection(read, { now: BASE });
      } catch (e) {
        threw = String((e && e.message) || e);
      } finally {
        log.setProvidersLogSink(undefined);
      }
      check(
        "a host with nothing recorded reads as absent, silently",
        threw === null && read.state === "absent" && lines.length === 0,
        JSON.stringify({ threw, state: read && read.state, lines }),
      );
      check(
        "the zero table says there were no rotations instead of no record",
        text ===
          "rotations, last 7 day(s): 0 total\n  no rotations in this window",
        text,
      );
      check(
        "and that run left no file behind: the recorder writes only when it has a row",
        !existsSync(file),
        String(existsSync(file)),
      );
      // A present but empty document renders the same zero table, so a file
      // that exists with nothing inside it cannot read as a broken instrument.
      const emptyFile = join(dir, "empty.json");
      writeFileSync(
        emptyFile,
        JSON.stringify({ version: 1, savedAt: 1, days: {} }),
      );
      const emptyText = census.formatRotationSection(
        census.readRotationCensus({ file: emptyFile }),
        { now: BASE },
      );
      check(
        "an empty document prints the same zero table",
        emptyText ===
          "rotations, last 7 day(s): 0 total\n  no rotations in this window",
        emptyText,
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
