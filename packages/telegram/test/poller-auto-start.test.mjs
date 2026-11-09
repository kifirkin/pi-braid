/**
 * test-poller-auto-start.mjs — a working directory can opt the inbound poller in
 * by settings, and nothing about that decision is guessed.
 *
 * Why this exists: the owner restarted the machine, started a session by hand in
 * the orchestrator directory, and had no channel at all, because auto-start was
 * reachable only through an environment variable that the shell happened to lack.
 * A setting that names the directory fixes that for good, so the two ways it can
 * go wrong are worth pinning: an entry that is not an absolute path must be
 * dropped rather than matched loosely, and a listed directory must NOT hand the
 * channel to every worktree beneath it — a worker in /private/tmp must never
 * start a second poller against the same bot.
 *
 * Run: node test/poller-auto-start.mjs
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readPollerAutoStart, pollerAutoStartFor } = await import(
  "../dist/lib/telegram-settings.js"
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(` [v] ${name}`);
  } catch (error) {
    failed++;
    console.log(` [x] ${name}: ${error.message}`);
  }
}

const TMP = mkdtempSync(join(tmpdir(), "pollauto-"));

/** Write a settings file carrying one `braid.telegram` value. */
function settings(value) {
  const path = join(TMP, `settings-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ braid: { telegram: value } }), "utf8");
  return path;
}

test("no setting means no directory starts the poller", () => {
  const path = join(TMP, "missing.json");
  assert.equal(readPollerAutoStart(path), false);
  assert.equal(pollerAutoStartFor("/opt/seat/work", path), false);
});

test("true starts it everywhere", () => {
  const path = settings({ pollerAutoStart: true });
  assert.equal(readPollerAutoStart(path), true);
  assert.equal(pollerAutoStartFor("/anywhere", path), true);
});

test("an array starts it only in the named directory, compared exactly", () => {
  const listed = "/opt/seat/work";
  const path = settings({ pollerAutoStart: [listed] });
  assert.equal(pollerAutoStartFor(listed, path), true);
  assert.equal(pollerAutoStartFor(listed + "/", path), true, "a trailing slash is the same directory");
  assert.equal(pollerAutoStartFor("/private/tmp/wt-worker", path), false);
});

test("a worktree beneath a listed directory does NOT inherit the channel", () => {
  const listed = "/opt/seat/work";
  const path = settings({ pollerAutoStart: [listed] });
  assert.equal(
    pollerAutoStartFor(listed + "/briefs", path),
    false,
    "exact match only: a subdirectory must not start a second poller against the same bot",
  );
});

test("a relative or empty entry is dropped, never matched loosely", () => {
  const path = settings({ pollerAutoStart: ["", "orchestrator", "/opt/seat/work"] });
  assert.deepEqual(readPollerAutoStart(path), ["/opt/seat/work"]);
  assert.equal(pollerAutoStartFor("/orchestrator", path), false);
});

test("a malformed value is off, not a crash", () => {
  for (const value of [{}, "yes", 1, null]) {
    const path = settings({ pollerAutoStart: value });
    assert.equal(readPollerAutoStart(path), false, `pollerAutoStart: ${JSON.stringify(value)}`);
  }
  const broken = join(TMP, "broken.json");
  writeFileSync(broken, "{not json", "utf8");
  assert.equal(readPollerAutoStart(broken), false);
});

try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  /* a leftover temp dir is not a test failure */
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
