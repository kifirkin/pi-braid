/**
 * braid honours PI_CODING_AGENT_DIR for settings.json.
 *
 * WHY THIS TEST EXISTS:
 *   lib/config/per-tool-settings.ts resolved the settings file with a
 *   module-level `join(homedir(), ".pi", "agent", "settings.json")` constant.
 *   When pi relocates its agent directory via PI_CODING_AGENT_DIR, braid kept
 *   reading and writing the default file: a braid setting placed in the
 *   relocated settings.json was invisible, and braid's own writes landed
 *   outside the active config tree.
 *
 * FIX:
 *   The path resolves through pi's getAgentDir() (PI_CODING_AGENT_DIR when set,
 *   else ~/.pi/agent) behind ONE helper, getSettingsPath(), used by every
 *   reader and by the single writer.
 *
 * REVERT-PROOF:
 *   Both directories get a settings.json with a DISTINCT
 *   braid.context.contextLimitTokens. Under the old homedir() constant the
 *   resolver returns the HOME value (111000); the assertion demands the
 *   env-dir value (222000). The write assertion likewise lands in the env dir.
 *
 * Env isolation: HOME and PI_CODING_AGENT_DIR are redirected to temp dirs
 * BEFORE the dist import (getAgentDir reads the env per call, but the point is
 * to never touch the live tree).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_DIR = mkdtempSync(join(tmpdir(), "settings-path-home-"));
const ENV_DIR = mkdtempSync(join(tmpdir(), "settings-path-env-"));
process.env.HOME = HOME_DIR;
process.env.PI_CODING_AGENT_DIR = ENV_DIR;

const HOME_SETTINGS = join(HOME_DIR, ".pi", "agent", "settings.json");
const ENV_SETTINGS = join(ENV_DIR, "settings.json");
mkdirSync(join(HOME_DIR, ".pi", "agent"), { recursive: true });
writeFileSync(HOME_SETTINGS, JSON.stringify({ braid: { context: { contextLimitTokens: 111_000 } } }));
writeFileSync(ENV_SETTINGS, JSON.stringify({ braid: { context: { contextLimitTokens: 222_000 } } }));

const { getSettingsPath, readSettingsFile, updateSettings } = await import(
  "../../../dist/lib/config/per-tool-settings.js"
);
const { getConfiguredContextLimitTokens } = await import(
  "../../../dist/lib/config/braid-settings.js"
);

console.log("=== settings.json honours PI_CODING_AGENT_DIR ===\n");

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

test("getSettingsPath resolves inside PI_CODING_AGENT_DIR, not HOME", () => {
  assert.equal(getSettingsPath(), ENV_SETTINGS);
});

test("braid's settings resolver reads the relocated file", () => {
  assert.equal(getConfiguredContextLimitTokens(), 222_000);
});

test("generic reader reads the relocated file", () => {
  writeFileSync(ENV_SETTINGS, JSON.stringify({ braid: {}, preprocessorEnabled: false }));
  assert.equal(readSettingsFile().preprocessorEnabled, false);
});

test("the one writer writes to the relocated file and leaves the HOME file alone", () => {
  updateSettings((settings) => {
    settings.customKey = "relocated";
  });
  assert.equal(JSON.parse(readFileSync(ENV_SETTINGS, "utf-8")).customKey, "relocated");
  assert.equal(
    JSON.parse(readFileSync(HOME_SETTINGS, "utf-8")).customKey,
    undefined,
    "the default-location settings.json must not be written",
  );
});

rmSync(HOME_DIR, { recursive: true, force: true });
rmSync(ENV_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== settings path env tests passed ===");
