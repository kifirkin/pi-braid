/**
 * The polyfill registers one model command, and the retired aliases are not it.
 *
 * WHY THIS TEST EXISTS:
 *   Two role aliases shipped with a one-release deprecation warning and were
 *   removed after it. A removed command returns by a merge that resurrects the
 *   wrong side of a conflict, or by a re-add nobody re-checks, and the failure a
 *   user meets is a command in the palette whose handler answers with a
 *   deprecation notice. The registered set is asserted exactly, so the return of
 *   a retired name and an unintended additional command both fail here instead of
 *   in a session.
 *
 * WHAT IS PINNED HERE:
 *   1. The exact set of command names the polyfill registers on a stub pi.
 *   2. Each retired name is asserted absent on its own, so a failure names the
 *      command that came back.
 *
 * PI_CODING_AGENT_DIR points at a temp dir before the dist modules load, so the
 * startup settings read cannot touch the real agent directory.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const SETTINGS_DIR = mkdtempSync(join(tmpdir(), "polyfill-command-set-"));
mkdirSync(SETTINGS_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = SETTINGS_DIR;

const { default: polyfillExtension } = await import(
  join(ROOT, "dist", "extensions", "core", "polyfill", "index.js")
);

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
function loadExtension() {
  const commands = new Map();
  const pi = {
    on() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  polyfillExtension(pi);
  return commands;
}

console.log("=== polyfill command set ===\n");

await test("the registered command set is exactly the utility role", () => {
  const names = [...loadExtension().keys()].sort();
  assert.deepEqual(
    names,
    ["utility-model"],
    "the polyfill must register the utility role command and nothing else",
  );
});

await test("/vision-model is not registered", () => {
  assert.equal(
    loadExtension().has("vision-model"),
    false,
    "the retired vision alias must not come back",
  );
});

await test("/max-power-model is not registered", () => {
  assert.equal(
    loadExtension().has("max-power-model"),
    false,
    "the retired max-power alias must not come back",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== polyfill command set tests passed ===");
