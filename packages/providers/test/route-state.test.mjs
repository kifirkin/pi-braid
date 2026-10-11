#!/usr/bin/env node
/**
 * route-state.test.mjs
 *
 * Persistence regression suite for packages/providers/route-state.ts, offline:
 * the cross-session route store's read tolerance, hash-only identity, and the
 * lock + compare-and-swap write protocol it copies from the key ring.
 *
 * Covers:
 *   1. Reads never throw. An absent file is the silent empty state (a fresh
 *      install is not a fault); a corrupt, truncated or wrong-version file is
 *      the empty state plus exactly ONE diagnostic. Each corruption case runs
 *      in its own process so the diagnostic throttle cannot mask a case.
 *   2. A recorded probe, death, fail-back and warmed-model list survive a
 *      FRESH read (a child process reads only the file), which is the
 *      "restart inherits the observation" claim.
 *   3. Identity is hash-only: a death is written with a canary-derived hash and
 *      the file text contains the hash but neither the canary nor a plain
 *      encoding of it — the store cannot persist a key it was never given.
 *   4. No lost update. A mutation built on a stale in-memory view folds in a
 *      NEWER peer snapshot before writing (both routes survive, rev advances
 *      past the peer's), and two concurrent writer PROCESSES on distinct routes
 *      both survive with a monotonic rev.
 *   5. A no-op mutation (clearing an already-clear fail-back) does not bump the
 *      rev, and the lock file never lingers.
 *
 * Harness: the REAL module (route-state, log) is compiled with the package's
 * local tsc (CJS emit) into <repoRoot>/.route-state-build/. Every case gets its
 * own HOME, which is what selects the store's file — so no test-only seam is
 * needed and nothing touches the real ~/.pi/agent.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
const buildDir = join(repoRoot, ".route-state-build");

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
    join(pkgRoot, "route-state.ts"),
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
  return require(join(buildDir, "route-state.js"));
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
 * Child that binds the notify sink, reads the state from THIS process's HOME
 * and prints { routes, rev, lines }. Used for the corruption cases (a fresh
 * process means a fresh diagnostic throttle) and for the fresh-read claim.
 */
const READ_CHILD = `
const path = require("node:path");
const rs = require(path.join(process.env.RS_BUILD_DIR, "route-state.js"));
const log = require(path.join(process.env.RS_BUILD_DIR, "log.js"));
const lines = [];
log.setProvidersLogSink((m) => lines.push(String(m)));
const state = rs.readRouteState();
process.stdout.write(JSON.stringify({ routes: state.routes, rev: state.rev, lines }));
`;

/** Child that records one death on RS_PROVIDER against its own HOME. */
const WRITE_CHILD = `
const path = require("node:path");
const rs = require(path.join(process.env.RS_BUILD_DIR, "route-state.js"));
rs.recordDeath(process.env.RS_PROVIDER, { class: "quota", keyHash: "peer-hash", at: 7 });
process.stdout.write("ok");
`;

function childEnv(extra = {}) {
  return { ...process.env, RS_BUILD_DIR: buildDir, ...extra };
}

function readViaChild() {
  const res = spawnSync("node", ["-e", READ_CHILD], {
    env: childEnv(),
    encoding: "utf-8",
  });
  if (res.status !== 0) throw new Error(`read child failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function writeViaChild(provider) {
  return new Promise((done, fail) => {
    const child = spawn("node", ["-e", WRITE_CHILD], {
      env: childEnv({ RS_PROVIDER: provider }),
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`write child exit ${code}`)),
    );
  });
}

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-route-state-"));
  try {
    /**
     * Select the store's file by pointing HOME at a per-case directory: the
     * module resolves its path from HOME, and a changed path rebinds the
     * in-memory document, so cases stay isolated without a test-only seam.
     */
    const useCase = (name) => {
      const dir = join(scratch, name);
      const agentDir = join(dir, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      process.env.HOME = dir;
      return join(agentDir, ".provider-route-state.json");
    };

    const rs = loadModules();

    // ── 1. Read tolerance ───────────────────────────────────────────────
    {
      useCase("absent");
      const out = readViaChild();
      check(
        "absent file ⇒ empty state and NO diagnostic (a fresh install is not a fault)",
        out.lines.length === 0 && Object.keys(out.routes).length === 0,
        JSON.stringify(out),
      );
    }
    for (const [name, content] of [
      ["corrupt", "{not json at all"],
      ["partial", '{"version":1,"rev":1,"savedAt":1,"routes":{"a":'],
      ["version", '{"version":2,"rev":1,"savedAt":1,"routes":{}}'],
    ]) {
      const file = useCase(name);
      writeFileSync(file, content);
      const out = readViaChild();
      check(
        `${name} file ⇒ empty state and exactly ONE diagnostic, no throw`,
        out.lines.length === 1 &&
          Object.keys(out.routes).length === 0 &&
          out.lines[0].includes("ignoring unreadable state file"),
        JSON.stringify(out),
      );
    }

    // ── 2. What is recorded is readable by a fresh read ─────────────────
    {
      useCase("persist");
      rs.recordProbe("route-alpha", {
        state: "degraded",
        at: 1700,
        headroomPct: 7,
        spendUsd: 9.3,
        capUsd: 10,
        remainingUsd: 0.7,
      });
      rs.recordDeath("route-alpha", {
        class: "quota",
        keyHash: "abc123",
        at: 1701,
      });
      rs.recordFailback("route-alpha", { target: "route-beta", at: 1702 });
      rs.setWarmModels("route-alpha", ["m-1", "m-2", "m-1", " "]);

      const out = readViaChild();
      const entry = out.routes["route-alpha"];
      check(
        "a fresh read recovers the probe, death, fail-back and warm models",
        entry.lastProbe.state === "degraded" &&
          entry.lastProbe.headroomPct === 7 &&
          entry.lastProbe.remainingUsd === 0.7 &&
          entry.deathClass === "quota" &&
          entry.deathKeyHash === "abc123" &&
          entry.deathAt === 1701 &&
          entry.failback.target === "route-beta" &&
          entry.failback.at === 1702 &&
          entry.warmModels.join(",") === "m-1,m-2",
        JSON.stringify(entry),
      );
      check(
        "the versioned envelope carries a monotonic rev",
        out.rev === 4,
        `rev=${out.rev}`,
      );
    }

    // ── 3. Identity is hash-only ────────────────────────────────────────
    {
      const file = useCase("canary");
      // Assembled from fragments so the tree carries no key-shaped literal;
      // the value the store is handed is unchanged, so the assertions below
      // still pin the same identity.
      const canary = ["sk", "canary", "SECRET", "8c21f0"].join("-");
      const canaryHash = hashKey(canary);
      rs.recordDeath("route-canary", {
        class: "auth",
        keyHash: canaryHash,
        at: 5,
      });

      const text = readFileSync(file, "utf8");
      const hex = Buffer.from(canary, "utf8").toString("hex");
      const b64 = Buffer.from(canary, "utf8").toString("base64");
      check(
        "the hashed identity is persisted",
        text.includes(canaryHash),
        canaryHash,
      );
      check(
        "the canary key value and its plain encodings never reach the file",
        !text.includes(canary) && !text.includes(hex) && !text.includes(b64),
      );
    }

    // ── 4. No lost update ───────────────────────────────────────────────
    {
      const file = useCase("merge");
      rs.recordProbe("route-a", { state: "ok", at: 1 });
      // A peer process commits a NEWER snapshot while this process still holds
      // the older in-memory view.
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          rev: 5,
          savedAt: Date.now() + 1000,
          routes: {
            "route-a": {
              lastProbe: { state: "ok", at: 1 },
              deathClass: null,
              deathAt: 0,
              deathKeyHash: null,
              failback: null,
              warmModels: [],
            },
            "route-peer": {
              lastProbe: null,
              deathClass: "rate",
              deathAt: 9,
              deathKeyHash: "peer",
              failback: null,
              warmModels: [],
            },
          },
        }),
      );
      rs.recordDeath("route-c", { class: "transport", keyHash: "h", at: 3 });

      const state = rs.readRouteState();
      check(
        "a stale writer folds in the peer snapshot — no route is lost",
        ["route-a", "route-peer", "route-c"].every((id) => id in state.routes),
        Object.keys(state.routes).join(","),
      );
      check(
        "the merge writes past the peer rev (monotonic compare-and-swap)",
        state.rev === 6,
        `rev=${state.rev}`,
      );
      check(
        "the peer's own record survives unchanged",
        state.routes["route-peer"].deathClass === "rate",
      );
    }
    {
      useCase("concurrent");
      await Promise.all([writeViaChild("route-x"), writeViaChild("route-y")]);
      const state = rs.readRouteState();
      check(
        "two concurrent writer processes: both routes survive",
        "route-x" in state.routes && "route-y" in state.routes,
        Object.keys(state.routes).join(","),
      );
      check(
        "two concurrent writer processes: the rev is monotonic",
        state.rev >= 2,
        `rev=${state.rev}`,
      );
    }

    // ── 5. No-op mutations are not writes; the lock does not linger ─────
    {
      const file = useCase("noop");
      rs.recordProbe("route-n", { state: "ok", at: 1 });
      const before = JSON.parse(readFileSync(file, "utf8")).rev;
      rs.clearFailback("route-n");
      const after = JSON.parse(readFileSync(file, "utf8")).rev;
      check(
        "clearing an already-clear fail-back does not bump the rev",
        before === after,
        `${before} -> ${after}`,
      );
      check(
        "the state lock file is released after every mutation",
        !existsSync(`${file}.lock`),
      );
      check(
        "no temp file is left behind",
        !existsSync(`${file}.tmp.${process.pid}`),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
