/**
 * workers.mjs session evidence - a session file that exists but cannot be
 * read is a named flag (SESSION-UNREADABLE), not a silent empty catch.
 *
 * The registry and the unreadable session file are built under a temp HOME so
 * the owner's registry is never touched, and the repo under test is a temp
 * dir so git resolution cannot leak into the assertion.
 *
 * Run: node test/runtime/orchestrator/test-workers-session-unreadable.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "skills", "subagent-orchestration", "scripts", "workers.mjs");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

function sanitize(p) {
  return resolve(p).replace(/[/.]/g, "-").replace(/^-/, "");
}

test("an unreadable session file is flagged", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.log("  [skip] running as root: chmod cannot make a file unreadable");
    return;
  }
  assert.ok(existsSync(SCRIPT), `workers.mjs not found at ${SCRIPT}`);

  const home = mkdtempSync(join(tmpdir(), "workers-session-home-"));
  const repo = mkdtempSync(join(tmpdir(), "workers-session-repo-"));
  try {
    const sessionFile = join(repo, "session.jsonl");
    writeFileSync(sessionFile, '{"type":"message"}\n');
    chmodSync(sessionFile, 0o000);

    const registryDir = join(home, ".pi", "agent", "braid", "projects", sanitize(repo));
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, "workers.json"),
      JSON.stringify({
        version: 1,
        workers: {
          "w-unreadable": {
            workerId: "w-unreadable",
            spec: "impl",
            status: "working",
            cwd: repo,
            workerSession: sessionFile,
            outputFile: null,
            branch: null,
            files: [],
          },
        },
      }),
    );

    const result = spawnSync(process.execPath, [SCRIPT, "--json", "--repo", repo], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `workers.mjs exited ${result.status}: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    const worker = parsed.workers.find((w) => w.id === "w-unreadable");
    assert.ok(worker, "the worker must be present in --json output");
    assert.ok(
      worker.flags.includes("SESSION-UNREADABLE"),
      `expected SESSION-UNREADABLE; flags: ${JSON.stringify(worker.flags)}`,
    );
  } finally {
    const sessionFile = join(repo, "session.jsonl");
    if (existsSync(sessionFile)) chmodSync(sessionFile, 0o644);
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

console.log(`\ntest-workers-session-unreadable: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
