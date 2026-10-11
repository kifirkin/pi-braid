/**
 * Structured tool-result formatting: the opt-in flag is read from the
 * extension API's settings accessor, not from a phantom ctx field.
 *
 * Contract:
 *   (a) with `structuredToolOutput: true` in the effective settings, the
 *       tool_result handler formats read/grep/find/ls output and the settings
 *       were read through pi.getSettings();
 *   (b) an absent or false flag passes the event through untouched;
 *   (c) a tool outside TOOLS_TO_FORMAT never reaches the settings read.
 *
 * Run: node test/runtime/enforcement/test-tool-result-formatting-settings.mjs
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { registerToolResultFormatting } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "register-tool-result-formatting.js")
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  [fail] ${name}: ${e.message}`);
    });
}

/** ExtensionAPI double: captures handlers, counts settings reads. */
function fakePi(settings) {
  const handlers = new Map();
  let settingsReads = 0;
  return {
    handlers,
    get settingsReads() {
      return settingsReads;
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    getSettings() {
      settingsReads++;
      return settings;
    },
  };
}

const readEvent = () => ({
  toolName: "read",
  content: [{ type: "text", text: "file body" }],
  isError: false,
});

console.log("tool-result formatting settings test\n");

await test("enabled: settings are read through the API and output is formatted", async () => {
  const pi = fakePi({ structuredToolOutput: true });
  registerToolResultFormatting(pi);
  const handler = pi.handlers.get("tool_result");
  assert.equal(typeof handler, "function", "handler must be registered for tool_result");

  const result = await handler(readEvent(), {});
  assert.ok(result && Array.isArray(result.content), "handler must return formatted content");
  assert.match(
    result.content[0].text,
    /^TOOL: read\nSTATUS: success\nRESULT: file body\n---/,
    `formatted header expected, got: ${JSON.stringify(result.content[0].text)}`,
  );
  assert.ok(pi.settingsReads >= 1, "the settings read must happen through pi.getSettings()");
});

await test("absent flag: passthrough", async () => {
  const pi = fakePi({});
  registerToolResultFormatting(pi);
  const result = await pi.handlers.get("tool_result")(readEvent(), {});
  assert.equal(result, undefined, "no flag means no formatting");
});

await test("false flag: passthrough", async () => {
  const pi = fakePi({ structuredToolOutput: false });
  registerToolResultFormatting(pi);
  const result = await pi.handlers.get("tool_result")(readEvent(), {});
  assert.equal(result, undefined, "an explicit false must not enable formatting");
});

await test("non-target tool: passthrough without a settings read", async () => {
  const pi = fakePi({ structuredToolOutput: true });
  registerToolResultFormatting(pi);
  const result = await pi.handlers.get("tool_result")(
    { toolName: "bash", content: [{ type: "text", text: "out" }], isError: false },
    {},
  );
  assert.equal(result, undefined, "only read/grep/find/ls are formatted");
  assert.equal(pi.settingsReads, 0, "the settings read is gated behind the tool filter");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
