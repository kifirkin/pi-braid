/**
 * settings.json has a single atomic write owner.
 *
 * WHY THIS TEST EXISTS:
 *   Two writers rewriting the whole file from their own async
 *   read-modify-write can interleave: the later write replaces the file with
 *   its own read snapshot and drops the other's key - a `/utility-model` set
 *   lost to a concurrent toggle.
 *
 * FIX:
 *   lib/config/per-tool-settings.ts is the ONE writer. updateSettings() keeps
 *   read-modify-write in a single synchronous transaction and installs the
 *   result with temp-file-plus-rename, so concurrent writers cannot interleave
 *   and no reader ever sees a half-written file. It also refuses to clobber an
 *   unparseable settings.json; the refusal is a returned outcome, not a throw
 *   (a throw escaping the TUI input callback that calls it exits pi).
 *
 * REVERT-PROOF:
 *   The concurrency case drives two updates across an await boundary (the
 *   shape that used to lose a key) and asserts BOTH keys are present. A
 *   read/await/write implementation without serialization fails it.
 *
 * Env isolation: PI_CODING_AGENT_DIR is redirected to a temp dir before the
 * dist import.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_DIR = mkdtempSync(join(tmpdir(), "settings-writer-"));
process.env.PI_CODING_AGENT_DIR = ENV_DIR;

const { getSettingsPath, updateSettings, writeGlobalEnabledTools } = await import(
  "../../../dist/lib/config/per-tool-settings.js"
);

const SETTINGS_PATH = getSettingsPath();
mkdirSync(ENV_DIR, { recursive: true });

console.log("=== settings.json single atomic writer ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

function seed() {
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      theme: "dark",
      braid: { contrib: { _global: { enabled: ["read"] } } },
      utilityModel: "keep/original",
    }),
  );
}

function onDisk() {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

await test("concurrent read-modify-write updates both land", async () => {
  seed();
  await Promise.all([
    (async () => {
      await Promise.resolve();
      updateSettings((settings) => {
        settings.utilityModel = "sample/qwen3-vl";
      });
    })(),
    (async () => {
      await Promise.resolve();
      updateSettings((settings) => {
        settings.preprocessorEnabled = false;
      });
    })(),
  ]);
  const settings = onDisk();
  assert.equal(settings.utilityModel, "sample/qwen3-vl", "the first writer's key survived");
  assert.equal(settings.preprocessorEnabled, false, "the second writer's key survived");
  assert.equal(settings.theme, "dark", "keys owned by neither writer were preserved");
  assert.deepEqual(settings.braid.contrib._global.enabled, ["read"], "braid.contrib preserved");
});

await test("atomic replace leaves no temp file behind", () => {
  const stray = readdirSync(ENV_DIR).filter((f) => f.includes(".tmp"));
  assert.deepEqual(stray, [], `stray temp files: ${stray.join(", ")}`);
});

await test("writeGlobalEnabledTools merges without dropping unrelated keys", () => {
  seed();
  writeGlobalEnabledTools(["read", "write"]);
  const settings = onDisk();
  assert.deepEqual(settings.braid.contrib._global.enabled, ["read", "write"]);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.utilityModel, "keep/original");
});

await test("an unparseable settings.json is not clobbered", () => {
  const garbage = "{ this is not json";
  writeFileSync(SETTINGS_PATH, garbage);
  const result = updateSettings((settings) => (settings.x = 1));
  assert.equal(result.ok, false, "the write reports refusal as a value, not a throw");
  assert.equal(result.reason, "existing-file-invalid");
  assert.equal(readFileSync(SETTINGS_PATH, "utf-8"), garbage, "the file was left untouched");
});

rmSync(ENV_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== settings writer tests passed ===");
