/**
 * A settings.json write refusal is a value, not a process-ending throw.
 *
 * WHY THIS TEST EXISTS:
 *   The one-writer change made updateSettings() throw when settings.json is
 *   present but unparseable. The /tools command writes from inside a TUI input
 *   callback;
 *   an exception escaping that callback reaches pi's uncaughtException
 *   handler, which exits the process with code 1. A corrupt or zero-byte
 *   settings.json plus one /tools toggle therefore killed the session - the
 *   correct refusal became a crash.
 *
 * FIX:
 *   updateSettings() returns a SettingsWriteOutcome. A refusal
 *   ({ ok: false, reason: "existing-file-invalid" }) and an I/O failure
 *   ({ ok: false, reason: "io" }) are values; the atomic temp-file+rename path
 *   is unchanged and the existing file is left byte-for-byte untouched.
 *   readSettingsFileOutcome() separates a genuinely missing file from an
 *   unreadable one, so a caller can report the latter instead of silently
 *   defaulting.
 *
 * REVERT-PROOF:
 *   Restoring the throw makes updateSettings() return undefined and every
 *   `.ok` assertion below fail. A caller that ignores the outcome no longer
 *   has a way to terminate the process. readSettingsFile() must still degrade
 *   to {} so existing consumers are unaffected.
 *
 * Env isolation: PI_CODING_AGENT_DIR points at a temp dir before the dist
 * import, so the live ~/.pi/agent/settings.json is never touched.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "settings-corrupt-resilience-"));
process.env.PI_CODING_AGENT_DIR = DIR;
const SETTINGS_PATH = join(DIR, "settings.json");
const CORRUPT = "{ this is not json";

const { readSettingsFile, readSettingsFileOutcome, updateSettings, writeGlobalEnabledTools } =
  await import("../../../dist/lib/config/per-tool-settings.js");

console.log("=== settings.json corrupt-file resilience ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

const tmpFiles = () => readdirSync(DIR).filter((f) => f.endsWith(".tmp"));

function seed(contents) {
  writeFileSync(SETTINGS_PATH, contents);
}

test("a corrupt existing file: the write is refused as a value, not an exception", () => {
  seed(CORRUPT);
  let result;
  assert.doesNotThrow(() => {
    result = updateSettings((s) => {
      s.injected = true;
    });
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "existing-file-invalid");
  assert.equal(result.path, SETTINGS_PATH);
});

test("a corrupt existing file is left byte-for-byte untouched, with no temp left behind", () => {
  seed(CORRUPT);
  updateSettings((s) => {
    s.injected = true;
  });
  assert.equal(readFileSync(SETTINGS_PATH, "utf-8"), CORRUPT);
  assert.deepEqual(tmpFiles(), []);
});

test("a zero-byte existing file is refused the same way", () => {
  seed("");
  const result = updateSettings((s) => {
    s.injected = true;
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "existing-file-invalid");
  assert.equal(readFileSync(SETTINGS_PATH, "utf-8"), "");
});

test("writeGlobalEnabledTools propagates the refusal and does not touch the file", () => {
  seed(CORRUPT);
  const result = writeGlobalEnabledTools(["read"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "existing-file-invalid");
  assert.equal(readFileSync(SETTINGS_PATH, "utf-8"), CORRUPT);
});

test("a missing file is not corruption: the write succeeds and creates the file", () => {
  rmSync(SETTINGS_PATH, { force: true });
  const result = updateSettings((s) => {
    s.created = true;
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")).created, true);
});

test("readSettingsFileOutcome: ok / missing / invalid are distinct", () => {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ a: 1 }));
  const ok = readSettingsFileOutcome();
  assert.equal(ok.state, "ok");
  assert.equal(ok.settings.a, 1);

  rmSync(SETTINGS_PATH, { force: true });
  assert.equal(readSettingsFileOutcome().state, "missing");

  seed(CORRUPT);
  const invalid = readSettingsFileOutcome();
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.path, SETTINGS_PATH);
  assert.ok(invalid.error instanceof Error);
});

test("readSettingsFile still degrades missing and invalid to {}", () => {
  rmSync(SETTINGS_PATH, { force: true });
  assert.deepEqual(readSettingsFile(), {});
  seed("");
  assert.deepEqual(readSettingsFile(), {});
  seed(CORRUPT);
  assert.deepEqual(readSettingsFile(), {});
});

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== settings corrupt-file resilience tests passed ===");
