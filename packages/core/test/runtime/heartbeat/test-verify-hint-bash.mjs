/**
 * The verification counter counts bash inspection, and still refuses to count
 * mutations.
 *
 * The hint policy ("No verification in 10+ turns") reads a tool-NAME set, so a
 * session whose whole investigation ran through bash (`grep -rn`, `git diff`,
 * `node -e` probes) counted as zero verification and the hint told the agent it
 * had not verified while it was verifying. The fix is a command-shape
 * recogniser, and both directions are pinned here:
 *
 *   1. inspecting commands count (search, diff, read, probe, pipelines,
 *      quoted operators, /dev/null redirects);
 *   2. mutating commands do not (in-place edits, redirects into a file, git
 *      write verbs, rm/mv/tee, an interpreter script that writes, xargs of a
 *      mutator);
 *   3. the CONTROL the brief demands: a session that really did not verify
 *      still trips the hint. The policy's trigger and its whisper are driven
 *      through the real createDefaultPolicies factory, so a counter that
 *      counts everything would go green on (1) and red on (3).
 *
 * The TOOL_CALL wiring is asserted on the built handler: the handler lives
 * inside the extension registration (driving the whole extension would start
 * its timers), so the claim "the counter routes bash through the recogniser"
 * is checked where it is written.
 *
 * Run: node test/runtime/heartbeat/test-verify-hint-bash.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const {
  bashCommandIsVerification,
  isVerificationToolCall,
  createDefaultPolicies,
  VERIFICATION_TOOLS,
} = await import("file://" + join(D, "extensions/heartbeat/heartbeat-scheduler/policies.js"));

console.log("=== verification shape: bash ===\n");

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

/** Commands that ARE verification (the counter must see them). */
const INSPECTING = [
  'grep -rn "DialogProvider" packages/core/src',
  "rg --files -g '*.ts' | head -20",
  "git diff main...HEAD --stat",
  "git log --oneline -5",
  "git status --short",
  "cat package.json",
  "head -40 AGENTS.md",
  "diff -u a.txt b.txt",
  "find . -name '*.mjs' | wc -l",
  "jq '.scripts' package.json",
  "sed -n '1,20p' README.md",
  "awk '{print $1}' /etc/hosts",
  "node -e \"import('./dist/x.js').then(m=>console.log(Object.keys(m)))\"",
  "python3 -c \"print(open('x').read())\"",
  'FOO=1 grep -n needle file.txt',
  'grep -n "a|b" file.txt',
  "grep -rn needle . > /dev/null 2>&1",
  "git -C /tmp/repo show HEAD:README.md",
  "sudo cat /etc/hosts",
  "ls -la packages",
];

/** Commands that are NOT verification (edits, builds, mutations). */
const MUTATING = [
  "sed -i '' 's/a/b/' file.txt",
  "perl -i -pe 's/a/b/' file.txt",
  "rm -rf dist",
  "mv a b",
  "cp a b",
  "mkdir -p out",
  "tee out.txt",
  "git add -A",
  'git commit -m "fix"',
  "git checkout -- file.txt",
  "git push origin main",
  "grep -rn needle . > out.txt",
  "printf 'x' >> log.txt",
  "grep -rn needle . | xargs rm",
  "node -e \"require('fs').writeFileSync('x','y')\"",
  "python3 -c \"open('x','w').write('y')\"",
  "npm install",
  "npm run build",
  "tsc --noEmit",
  "echo hello",
  "",
  "   ",
];

await test("the defect this replaces: bash was never in the name set", () => {
  // Membership is the whole of the old recognition rule, and `bash` is not a
  // member: a session that searched through bash counted as zero verification.
  assert.equal(VERIFICATION_TOOLS.has("bash"), false);
  assert.equal(VERIFICATION_TOOLS.has("grep"), true);
});

await test("inspecting bash commands count as verification", () => {
  for (const command of INSPECTING) {
    assert.equal(
      bashCommandIsVerification(command),
      true,
      `should count: ${JSON.stringify(command)}`,
    );
  }
});

await test("mutating bash commands do not count", () => {
  for (const command of MUTATING) {
    assert.equal(
      bashCommandIsVerification(command),
      false,
      `should not count: ${JSON.stringify(command)}`,
    );
  }
});

await test("the tool-call predicate keeps the name set and adds bash only", () => {
  assert.equal(isVerificationToolCall("read", { path: "x" }), true, "read stays in the set");
  assert.equal(isVerificationToolCall("grep", { pattern: "x" }), true, "grep stays in the set");
  assert.equal(
    isVerificationToolCall("bash", { command: "grep -rn x ." }),
    true,
    "bash inspection counts",
  );
  assert.equal(
    isVerificationToolCall("bash", { command: "sed -i 's/a/b/' f" }),
    false,
    "bash mutation does not",
  );
  assert.equal(isVerificationToolCall("bash", undefined), false, "no input, no claim");
  assert.equal(isVerificationToolCall("write", { path: "x" }), false, "write is not verification");
  assert.equal(
    isVerificationToolCall("list_skills", {}),
    false,
    "an unrelated tool is not verification",
  );
});

await test("wiring: the TOOL_CALL handler routes bash through the recogniser", () => {
  const built = readFileSync(
    join(D, "extensions/heartbeat/heartbeat-scheduler/index.js"),
    "utf8",
  );
  assert.match(
    built,
    /isVerificationToolCall\(toolName, event\?\.input\)/,
    "the handler must call the recogniser with the call's input",
  );
});

// ── the control: a session that did not verify still gets the hint ─────────

/** Drive the real verify-hint policy with a tracking snapshot. */
async function runVerifyHint(tracking) {
  const whispers = [];
  const policies = createDefaultPolicies(
    () => tracking,
    () => {},
    (msg) => whispers.push(msg),
    () => {},
  );
  const policy = policies.find((p) => p.id === "verify-hint");
  assert.ok(policy, "verify-hint policy exists");
  const ctx = { turnNumber: 15, signals: {} };
  const fires = await policy.trigger({}, ctx);
  if (fires) await policy.action(ctx);
  return { fires, whispers };
}

await test("control: no verification for 10+ turns still trips the hint", async () => {
  const { fires, whispers } = await runVerifyHint({
    totalToolsUsed: 12,
    lastVerificationTurn: 0,
    lastToolCallTurn: 14,
    lastWebFetchTurn: 0,
    lastCodeExecutionTurn: 0,
  });
  assert.equal(fires, true, "the hint must still fire when nothing verified");
  assert.match(
    whispers[0] ?? "",
    /No verification \(grep\/read\/search\) in 10\+ turns/,
    "and it must still say so",
  );
});

await test("control: a bash search this turn silences the hint", async () => {
  const tracking = {
    totalToolsUsed: 12,
    lastVerificationTurn: 0,
    lastToolCallTurn: 14,
    lastWebFetchTurn: 0,
    lastCodeExecutionTurn: 0,
  };
  // What the handler does for `bash grep -rn needle .`: the recogniser says
  // yes, so the count and the turn stamp advance.
  if (isVerificationToolCall("bash", { command: "grep -rn needle ." })) {
    tracking.lastVerificationTurn = 15;
  }
  const { fires, whispers } = await runVerifyHint(tracking);
  assert.equal(fires, false, "a session that verified through bash must not be told it did not");
  assert.equal(whispers.length, 0, "and no whisper is sent");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
