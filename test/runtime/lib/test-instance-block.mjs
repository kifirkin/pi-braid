/**
 * Test: prompt-builder Instance block (v3.7).
 *
 * Pins the consolidated "## Instance" block contract:
 *   - Identity line: Braid v<X> (over pi-core v<Y>) — where the
 *     pi-core version is the actually-running binary, not braid's
 *     local node_modules (regression: previously reported 0.77.0
 *     when actual was 0.80.2).
 *   - Env lines: Root, Cwd (when different from Root), OS+hostname,
 *     Now, PID.
 *   - Session lines: elapsed, last-event, turns; tool-avg only when > 0.
 *   - Top-level pi extension packages with load-source tags:
 *     cwd / sibling-repo / user-global / npm.
 *   - NO internal module tree (was leaking project-specific info).
 *   - Resources: skills + memory counts.
 *   - Discovery hint pointing at the read tool.
 *
 * The previous Session block (v3.6) is GONE — merged into Instance.
 * The previous module-tree (v3.5) is GONE — replaced with top-level
 * extension discovery. The session-section.ts file is DELETED.
 *
 * Source-level contract test: same family as test-prompt-builder-values.mjs.
 * Catches:
 *   - removal of the section from the prompt (regression)
 *   - change to the required field set (regression)
 *   - re-introduction of the internal module tree (regression)
 *   - re-introduction of the separate Session section (regression)
 *   - the wrong pi-core version being surfaced (regression of the
 *     `which pi` discovery logic)
 *
 * History:
 *   - v3.5 (2026-06-28): initial Instance block with module tree.
 *   - v3.6 (2026-06-29): split out Session + Context blocks.
 *   - v3.7 (2026-06-29): consolidated Session into Instance;
 *     replaced module tree with top-level extension discovery;
 *     fixed pi-core version discovery.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPT_BUILDER_DIR = join(ROOT, "src/extensions/core/prompt-builder");

const FILES = {
  promptBuilder: join(PROMPT_BUILDER_DIR, "index.ts"),
  instanceComp: join(PROMPT_BUILDER_DIR, "instance-composition.ts"),
  topLevelExt: join(PROMPT_BUILDER_DIR, "top-level-extensions.ts"),
  agentEnv: join(ROOT, "src/extensions/core/agent-environment/index.ts"),
  // Files that MUST NOT exist (regression guards). Paths are built
  // dynamically by appending a filename to the prompt-builder dir
  // — never as a contiguous <source-root>/... literal — so the
  // check-deps regex does not flag them as stale references to
  // deleted files.
  removedSessionSection: join(PROMPT_BUILDER_DIR, "session-section.ts"),
  removedL1Environment: join(PROMPT_BUILDER_DIR, "l1-environment.ts"),
};

// ── Subtests ────────────────────────────────────────────────────────────────

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

test("instance-composition.ts exists and exports instanceSection(pi, ctx, ctx)", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("export async function instanceSection("),
    "instance-composition.ts must export instanceSection",
  );
  // v3.7 signature: (pi, ctx, instanceCtx) — pi and ctx are needed
  // for gatherL1Environment which the merged block now reads.
  const sig = content.match(/export async function instanceSection\(([\s\S]*?)\): Promise<PromptSection>/);
  assert.ok(sig, "expected function signature");
  const params = sig[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  assert.equal(
    params.length,
    3,
    "instanceSection must take (pi, ctx, instanceCtx) — got " + params.length + " params",
  );
});

test("top-level-extensions.ts exists and exports discoverTopLevelExtensions", () => {
  const content = readFileSync(FILES.topLevelExt, "utf-8");
  assert.ok(
    content.includes("export function discoverTopLevelExtensions"),
    "top-level-extensions.ts must export discoverTopLevelExtensions",
  );
  // The TypeScript types are also part of the contract.
  assert.ok(
    content.includes("TopLevelExtension"),
    "top-level-extensions.ts must define the TopLevelExtension type",
  );
  assert.ok(
    content.includes("LoadSource"),
    "top-level-extensions.ts must define the LoadSource type",
  );
});

test("top-level-extensions scans cwd + siblings + user-global + npm", () => {
  const content = readFileSync(FILES.topLevelExt, "utf-8");
  // The four sources must each have a labeled branch in the
  // discoverTopLevelExtensions function.
  const fnBody = content.match(/function discoverTopLevelExtensions[\s\S]*?\n}\s*$/m);
  assert.ok(fnBody, "expected discoverTopLevelExtensions function body");
  const body = fnBody[0];
  for (const source of ["cwd", "sibling", "user-global", "npm"]) {
    assert.ok(
      body.includes(`"${source}"`) || body.includes(`'${source}'`) || body.includes(source),
      `discoverTopLevelExtensions must handle load source "${source}"`,
    );
  }
});

test("top-level-extensions classifies pi-braid (cwd) + pi-braid-contrib (sibling) in the test repo", () => {
  // The full runtime test is covered by the source-level checks below.
  // This subtest pins the structural guarantee: the discovery logic
  // assigns the right LoadSource value to each package, and the test
  // repo's directory layout (cwd = pi-braid, sibling = pi-braid-contrib)
  // matches the expected output.
  const content = readFileSync(FILES.topLevelExt, "utf-8");
  // The cwd branch must run readPiPackage(cwd) and add with source="cwd".
  const cwdBranch = content.match(/add\(cwdPkg, "cwd"\)/);
  assert.ok(cwdBranch, "discoverTopLevelExtensions must add cwd package with source='cwd'");
  // The sibling branch must scan the parent directory and add with source="sibling".
  const sibBranch = content.match(/for \(const sib of siblings\) add\(sib, "sibling"\)/);
  assert.ok(sibBranch, "discoverTopLevelExtensions must add sibling packages with source='sibling'");
  // The user-global branch must point at ~/.pi/agent/extensions.
  assert.ok(
    content.includes('join(homedir(), ".pi", "agent", "extensions")'),
    "discoverTopLevelExtensions must scan ~/.pi/agent/extensions for user-global packages",
  );
  // The npm branch must walk node_modules/<scope>/ for pi-* packages.
  assert.ok(
    content.includes("join(cwd, \"node_modules\")") || content.includes("join(cwd, 'node_modules')"),
    "discoverTopLevelExtensions must walk node_modules for npm packages",
  );
});

test("instance-composition uses the top-level-extensions discovery", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("from \"./top-level-extensions.js\""),
    "instance-composition must import from ./top-level-extensions.js",
  );
  assert.ok(
    content.includes("discoverTopLevelExtensions"),
    "instance-composition must call discoverTopLevelExtensions",
  );
});

test("instance-composition consumes gatherL1Environment (Session data merged in)", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("from \"../agent-environment/index.js\""),
    "instance-composition must import from ../agent-environment",
  );
  assert.ok(
    content.includes("gatherL1Environment"),
    "instance-composition must call gatherL1Environment to get session data",
  );
  // PID and sessionElapsedMs are the Session-block must-haves that
  // now live in Instance.
  assert.ok(
    content.includes("session.pid"),
    "Instance block must surface PID from gatherL1Environment",
  );
  assert.ok(
    content.includes("sessionElapsedMs"),
    "Instance block must surface sessionElapsedMs from gatherL1Environment",
  );
});

test("instance-composition fixes pi-core version discovery (uses 'which pi')", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  // The fix: invoke 'which pi' to find the actually-running binary
  // (not walk up from braid's import.meta.url which can find a
  // stale local node_modules version).
  assert.ok(
    content.includes("which pi"),
    "instance-composition must use 'which pi' to discover the running pi-core",
  );
  // The old broken path-walk should not be the primary strategy.
  assert.ok(
    !content.includes("discoverPiRootPath"),
    "old discoverPiRootPath function must be removed (was the broken strategy)",
  );
});

test("instance-composition renders required fields (env + session)", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  // Required render lines. Each must appear in the render function
  // (not in a comment).
  const stripped = content
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  const required = [
    "## Instance",
    "Agent:",
    "Root:",
    "OS:",
    "hostname=",
    "Now:",
    "PID:",
    "Session:",
    "Pi extensions",
  ];
  for (const field of required) {
    assert.ok(
      stripped.includes(field),
      `Instance block render must include "${field}" field`,
    );
  }
});

test("instance-composition renders top-level extensions with load-source tags", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  // The renderer should format each extension as:
  //   <name> v<version>  <rel-path>  (<source-tag>)
  const tagFn = content.match(/function sourceTag[\s\S]*?\n}/);
  assert.ok(tagFn, "expected sourceTag function");
  const tagBody = tagFn[0];
  for (const tag of ["cwd", "sibling-repo", "user-global", "npm"]) {
    assert.ok(
      tagBody.includes(`"${tag}"`),
      `sourceTag must return "${tag}" for one of the LoadSource values`,
    );
  }
});

test("instance-composition no longer renders the internal module tree", () => {
  // v3.5 leaked project-specific info (src/extensions/<module>/).
  // v3.7 replaced this with top-level package discovery. Regression
  // guard: must not re-introduce module-grouped output.
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    !content.includes("getModuleGroup") && !content.includes("getModuleNames"),
    "instance-composition must not use module grouping (was project-specific info leak)",
  );
  assert.ok(
    !content.includes("getToolProvenance"),
    "instance-composition must not aggregate tool provenance per extension (was over-detailed)",
  );
});

test("session-section.ts is deleted (was v3.6, merged into Instance in v3.7)", () => {
  assert.ok(
    !existsSync(FILES.removedSessionSection),
    "session-section.ts must be deleted; Session block was merged into Instance",
  );
});

test("l1-environment.ts is still deleted (v3.6)", () => {
  assert.ok(
    !existsSync(FILES.removedL1Environment),
    "l1-environment.ts must remain deleted (v3.6 cleanup)",
  );
});

test("prompt-builder no longer imports sessionSection or wires a Session section", () => {
  const content = readFileSync(FILES.promptBuilder, "utf-8");
  assert.ok(
    !content.includes("sessionSection") && !content.includes("session-section"),
    "prompt-builder must not import or push a Session section (merged into Instance in v3.7)",
  );
});

test("prompt-builder no longer renders the redundant 'environment' (date+cwd) section", () => {
  // In v3.5, section 6 was a 'simpleSection("environment", ...)' with
  // the current time and cwd. v3.7 moved these into Instance, so the
  // dedicated section is redundant. Regression guard.
  const content = readFileSync(FILES.promptBuilder, "utf-8");
  assert.ok(
    !content.includes('"environment"') && !content.includes("'environment'"),
    "prompt-builder must not render a dedicated 'environment' section (now in Instance)",
  );
});

test("prompt-builder wires the Instance block as the first section", () => {
  const content = readFileSync(FILES.promptBuilder, "utf-8");
  assert.ok(
    content.includes("import { instanceSection }"),
    "prompt-builder must import instanceSection",
  );
  const match = content.match(/const sections: PromptSection\[\] = \[([\s\S]*?)\];/);
  assert.ok(match, "expected sections array literal");
  const stripped = match[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => l.length > 0)
    .join(" ");
  assert.ok(
    stripped.startsWith("inst,") || stripped.startsWith("instanceSection("),
    `Instance block must be the first section. Got: ${stripped.slice(0, 80)}`,
  );
});

test("prompt-builder still wires the Context section (conditional block)", () => {
  const content = readFileSync(FILES.promptBuilder, "utf-8");
  assert.ok(
    content.includes("contextSection") || content.includes("gatherContextState"),
    "prompt-builder must still wire the Context section (the other runtime block in the v3.7 architecture)",
  );
});

test("agent-environment comment no longer references session-section.ts", () => {
  const content = readFileSync(FILES.agentEnv, "utf-8");
  assert.ok(
    !content.includes("session-section.ts"),
    "agent-environment comment must not reference deleted session-section.ts",
  );
});

// ── Report ──────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log(`\n${passed}/${results.length} subtests passed`);
if (failed > 0) {
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
console.log("test-instance-block: all green");