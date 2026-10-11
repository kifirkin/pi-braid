/**
 * regression test: third-party tool-description
 * trim on the provider payload tools channel. The pi-herdr npm extension
 * registers 3 tools whose registered descriptions are long (1451 chars
 * combined); the
 * lines per tool with the deep form moved to the herdr-topology skill.
 * Mechanism: a before_provider_request handler in the prompt-builder
 * rewrites ONLY the description field of trimmed tools — the only official
 * interception point pi-core 0.85.1 exposes for registered descriptions
 * (getAllTools returns copies; same-name re-registration is
 * first-registration-wins and would shadow the real tool's execute).
 *
 * Pinned here:
 * 1. OpenAI-compat payload: curated trim replaces the description;
 * names/parameters/other fields byte-passthrough; originals not mutated.
 * 2. Flat (Anthropic-style) tool shape is trimmed identically.
 * 3. Non-herdr tools pass through; unchanged payloads return undefined
 * (runner contract: undefined = keep the payload as built).
 * 4. The when-gate string appears in every curated trim (gate is
 * load-bearing) and in fallback trims.
 * 5. Fallback: an unlisted herdr_-prefixed tool with a long description is
 * capped to the leading sentences + gate + skill pointer; an
 * already-short herdr description passes through untouched.
 * 6. Garbage payloads (null, missing/non-array/empty tools, weird entries)
 * return undefined without throwing.
 *
 * Run: node test/runtime/core/test-tool-description-trim.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { TRIM_TOOL_DESCRIPTIONS, trimToolDescription, trimProviderTools } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "tool-description-trim.js")
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(` [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  [FAIL] ${name}\n    ${e?.message ?? e}`);
    });
}

const LONG_LAYOUT =
  "Create and inspect Herdr terminal topology. Workspaces contain tabs; tabs contain panes. Creating a workspace or tab also creates a root pane, while splitting creates another pane. Layout actions never start an agent or ordinary command. Read pane IDs from results and pass them to herdr_pane or herdr_agent. Creation defaults to the caller's cwd and preserves UI focus. pane_split defaults to the caller's pane and chooses right or down from its geometry.";

const GATE = "only when the user explicitly mentions Herdr";

console.log("tool-description-trim ");

await test("curated map covers the three herdr tools, each 1-2 lines with the when-gate", () => {
  for (const name of ["herdr_layout", "herdr_pane", "herdr_agent"]) {
    const desc = TRIM_TOOL_DESCRIPTIONS[name];
    assert.ok(typeof desc === "string" && desc.length > 0, `${name} present`);
    assert.ok(desc.includes(GATE), `${name} carries the when-gate`);
    assert.ok(!desc.includes("\n"), `${name} is a single line (no newlines)`);
    assert.ok(desc.length <= 260, `${name} is 1-2 lines (${desc.length} chars)`);
  }
});

await test("OpenAI-compat payload: description replaced, other fields passthrough, no mutation", () => {
  const fn = { name: "herdr_layout", description: LONG_LAYOUT, parameters: { type: "object" } };
  const other = { type: "function", function: { name: "read", description: "Read a file." } };
  const payload = { model: "m", messages: [], tools: [{ type: "function", function: fn }, other] };
  const out = trimProviderTools(payload);
  assert.ok(out && typeof out === "object", "returns a payload");
  assert.notEqual(out, payload, "returns a NEW payload object");
  const tools = out.tools;
  assert.equal(tools.length, 2);
  assert.equal(tools[0].function.description, TRIM_TOOL_DESCRIPTIONS.herdr_layout);
  assert.equal(tools[0].function.name, "herdr_layout");
  assert.deepEqual(tools[0].function.parameters, { type: "object" }, "parameters untouched");
  assert.equal(tools[1], other, "non-herdr tool passes through by reference");
  // originals not mutated
  assert.equal(fn.description, LONG_LAYOUT, "original definition not mutated");
  assert.equal(payload.tools[0].function.description, LONG_LAYOUT, "original payload not mutated");
  assert.equal(payload.model, "m", "rest of payload preserved");
});

await test("flat (Anthropic-style) shape is trimmed identically", () => {
  const payload = { tools: [{ name: "herdr_pane", description: LONG_LAYOUT, input_schema: {} }] };
  const out = trimProviderTools(payload);
  assert.ok(out, "payload replaced");
  assert.equal(out.tools[0].description, TRIM_TOOL_DESCRIPTIONS.herdr_pane);
  assert.deepEqual(out.tools[0].input_schema, {});
});

await test("unchanged payloads return undefined (runner keeps the built payload)", () => {
  const short = { tools: [{ name: "herdr_thing", description: "Compact owner text." }] };
  assert.equal(
    trimProviderTools(short),
    undefined,
    "already-short unlisted herdr desc passes through",
  );
  const noHerdr = {
    tools: [{ type: "function", function: { name: "read", description: "Read a file." } }],
  };
  assert.equal(trimProviderTools(noHerdr), undefined, "no herdr tools -> undefined");
});

await test("fallback: unlisted herdr_* tool with a long description is capped + gated", () => {
  const long = LONG_LAYOUT + " Extra padding sentence to push past the cap. ".repeat(3);
  const desc = trimToolDescription("herdr_future", long);
  assert.ok(desc, "fallback trim produced");
  assert.ok(desc.length <= 400, `fallback is short (${desc.length} chars)`);
  assert.ok(desc.includes(GATE), "fallback carries the when-gate");
  assert.ok(desc.includes("herdr-topology skill"), "fallback points at the skill");
});

await test("fallback does not touch already-short herdr descriptions or non-herdr names", () => {
  assert.equal(trimToolDescription("herdr_thing", "Compact owner text."), undefined);
  assert.equal(trimToolDescription("read", LONG_LAYOUT), undefined, "non-herdr name ignored");
  assert.equal(
    trimToolDescription("herdr_layout", LONG_LAYOUT),
    TRIM_TOOL_DESCRIPTIONS.herdr_layout,
  );
});

await test("garbage payloads return undefined without throwing", () => {
  assert.equal(trimProviderTools(null), undefined);
  assert.equal(trimProviderTools(undefined), undefined);
  assert.equal(trimProviderTools("nope"), undefined);
  assert.equal(trimProviderTools({}), undefined);
  assert.equal(trimProviderTools({ tools: [] }), undefined);
  assert.equal(trimProviderTools({ tools: "not-an-array" }), undefined);
  assert.equal(trimProviderTools({ tools: [null, 42, {}, { name: "herdr_x" }] }), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
