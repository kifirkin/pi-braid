/**
 * Session-recall search cost bounds.
 *
 * Defect: every search ran two full-corpus backend invocations — the
 * occurrence count, then a second PCRE pass that tagged the role signal for
 * every matched file. A multi-word query paid one pass per term plus one for
 * the phrase plus that role pass, so cost scaled with the query while the
 * corpus was scanned from disk each time. Role is a tie-breaker: it only needs
 * the files that can enter the result window.
 *
 * The test instruments the backend from outside. A shim `rg` placed first on
 * PATH records each invocation's argv and stdout, then delegates to the real
 * rg. The instrumentation is independent of the module under test, so on
 * unmodified main these assertions fail for a behavioural reason (two passes,
 * unbounded role), not because an export is missing.
 *
 *  (a) RED/GREEN — a single-term search issues exactly ONE full-corpus backend
 *      invocation. Main: two (count + role).
 *  (b) RED/GREEN — the role pass touches at most ROLE_REFINE_LIMIT files.
 *      Main: every matched file.
 *  (c) a two-term query issues N full-corpus invocations. Main: N+2
 *      (phrase + N terms + role).
 *
 * Run: node test/runtime/memory/test-session-search-cost.mjs
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const search = await import("../../../dist/extensions/memory/session-recall/search.js");
const { searchFiles } = search;
// The bound's value under test; on a build without the change, fall back to the
// intended cap. The fallback only supplies the threshold — the assertions are
// on the observed backend behaviour.
const ROLE_LIMIT = search.ROLE_REFINE_LIMIT ?? 50;

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

/** Absolute path of the real rg, resolved before the shim takes over PATH. */
const REAL_RG = execFileSync("/bin/sh", ["-c", "command -v rg"], { encoding: "utf-8" }).trim();
assert.ok(REAL_RG, "rg must be on PATH for this test");

const root = await mkdtemp(join(tmpdir(), "session-search-cost-"));
const sessionsDir = join(root, "sessions");
const projectDir = join(sessionsDir, "--Users-tester-cost--");
const shimDir = join(root, "bin");
const logDir = join(root, "log");

/** Records argv and stdout per invocation, then runs the real rg. */
const SHIM = `#!/bin/sh
n=0
[ -f "$RG_LOG/n" ] && n=$(cat "$RG_LOG/n")
n=$((n+1))
printf '%s' "$n" > "$RG_LOG/n"
for a in "$@"; do printf '%s\\036' "$a"; done >> "$RG_LOG/args.log"
printf '\\n' >> "$RG_LOG/args.log"
"$RG_REAL" "$@" > "$RG_LOG/out.$n" 2>/dev/null
st=$?
cat "$RG_LOG/out.$n"
exit $st
`;

/** Parse args.log into one argv array per invocation. */
function invocations() {
  let raw;
  try {
    raw = readFileSync(join(logDir, "args.log"), "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line, i) => ({ n: i + 1, args: line.split("\x1e").filter((a) => a !== "") }));
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const M = 200;

try {
  await mkdir(projectDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(shimDir, { recursive: true });

  const line = (text) =>
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  for (let i = 0; i < M; i++) {
    const name = `f${String(i).padStart(3, "0")}.jsonl`;
    await writeFile(join(projectDir, name), line("sentinel alphatoken betatoken probe") + "\n");
  }

  const shimPath = join(shimDir, "rg");
  await writeFile(shimPath, SHIM);
  await chmod(shimPath, 0o755);

  process.env.RG_REAL = REAL_RG;
  process.env.RG_LOG = logDir;
  process.env.PATH = `${shimDir}:${process.env.PATH}`;

  console.log("=== session-recall search cost ===\n");

  await test("(a) single-term search: exactly one full-corpus backend invocation", async () => {
    await rm(join(logDir, "args.log"), { force: true });
    await searchFiles("sentinel", sessionsDir);
    const all = invocations().filter((inv) => !inv.args.includes("--version"));
    const fullCorpus = all.filter((inv) => inv.args.includes(sessionsDir));
    assert.equal(
      fullCorpus.length,
      1,
      `expected 1 full-corpus invocation, saw ${fullCorpus.length} of ${all.length} total`,
    );
  });

  await test("(b) the role pass touches at most ROLE_REFINE_LIMIT files", async () => {
    await rm(join(logDir, "args.log"), { force: true });
    await searchFiles("sentinel", sessionsDir);
    const role = invocations()
      .filter((inv) => !inv.args.includes("--version"))
      .filter((inv) => inv.args.includes("-P"));
    assert.equal(role.length, 1, `expected exactly one role pass, saw ${role.length}`);
    const inv = role[0];
    const operands = inv.args.filter((a) => isFile(a));
    const touched = operands.length > 0 ? operands.length : readRoleOutputLines(inv.n);
    assert.ok(touched > 0, "the role pass must do work");
    assert.ok(
      touched <= ROLE_LIMIT,
      `role pass touched ${touched} files, above the bound ${ROLE_LIMIT}`,
    );
  });

  await test("(c) two-term query: N full-corpus invocations", async () => {
    await rm(join(logDir, "args.log"), { force: true });
    await searchFiles("alphatoken betatoken", sessionsDir);
    const all = invocations().filter((inv) => !inv.args.includes("--version"));
    const fullCorpus = all.filter((inv) => inv.args.includes(sessionsDir));
    assert.equal(
      fullCorpus.length,
      2,
      `expected 2 full-corpus invocations (one per term), saw ${fullCorpus.length}`,
    );
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

/** Files reported by invocation n (its stdout), used when it scanned a dir. */
function readRoleOutputLines(n) {
  try {
    return readFileSync(join(logDir, `out.${n}`), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
