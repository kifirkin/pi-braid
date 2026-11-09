/**
 * The module surface is one `modules` command and its six forwarding aliases.
 *
 * WHY THIS TEST EXISTS:
 *   Six command names were folded into one command with verbs, and the old
 *   names stay registered for one release so scripts keep working. The set is
 *   what a user sees in the palette and what a subagent types, so it is
 *   asserted exactly: a missing alias breaks a script, and an extra command
 *   nobody intended is a surface drift the exact-set assertion catches. The
 *   retired names are not in this set, so a re-add of one has to change this
 *   test on purpose.
 *
 * WHAT IS PINNED HERE:
 *   1. The exact sorted set: `modules` plus the six former names.
 *   2. Each alias is present on its own, so a failure names the command that
 *      went missing.
 *   3. Every entry carries a handler.
 *
 * HOME and BRAID_HOME point at temp dirs before the dist modules load: the
 * loader resolves its settings sources at module load, and the command must
 * not read or write the real agent tree from a test.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

process.env.HOME = mkdtempSync(join(tmpdir(), "modules-command-set-home-"));
process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, ".pi", "agent");
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "modules-command-set-braid-"));

const { default: modulesApiExtension } = await import(join(ROOT, "dist", "loader", "api.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

/** Load the extension the way pi does, capturing the commands it registers. */
async function loadExtension() {
  const commands = new Map();
  const pi = {
    on() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  await modulesApiExtension(pi);
  return commands;
}

console.log("=== modules command set ===\n");

await test("the registered command set is modules plus the six forwarding aliases", async () => {
  const names = [...(await loadExtension()).keys()].sort();
  assert.deepEqual(
    names,
    [
      "modules",
      "modules-disable",
      "modules-enable",
      "modules-list",
      "modules-reset",
      "modules-status",
      "modules-toggle",
    ],
    "the module surface must be one command plus the six former names",
  );
});

await test("every forwarding alias is registered on its own", async () => {
  const commands = await loadExtension();
  for (const name of [
    "modules-enable",
    "modules-disable",
    "modules-toggle",
    "modules-reset",
    "modules-list",
    "modules-status",
  ]) {
    assert.equal(commands.has(name), true, `${name} must stay registered for one release`);
  }
});

await test("every registered entry carries a handler", async () => {
  for (const [name, definition] of await loadExtension()) {
    assert.equal(typeof definition.handler, "function", `${name} must have a handler`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== modules command set tests passed ===");
