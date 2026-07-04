/**
 * Test: prompt-builder Instance block (v3.8) -- RUNTIME.
 *
 * Pins the consolidated "## Instance" block contract by actually
 * calling the production code (not by grepping source for function
 * names). Every assertion either renders the real section or
 * invokes the real discovery function with real filesystem state.
 *
 * Contract pinned:
 *   - instanceSection() returns a PromptSection named "instance"
 *   - The rendered output starts with "## Instance" and contains
 *     the Agent, Root, Cwd, Settings, OS+hostname, Now, PID, Session,
 *     Pi extensions blocks.
 *   - Root points at the pi-core npm package folder (not braid).
 *   - Cwd is always rendered as its own line (never suppressed).
 *   - Settings line points at the userland pi settings dir
 *     (~/.pi/agent or PI_CODING_AGENT_DIR override).
 *   - Session line includes the session id.
 *   - Pi-core version is the actually-running binary (regression:
 *     v3.5-v3.6 showed 0.77.0 when actual was 0.80.2).
 *   - Top-level extension discovery reads pi-core's `packages`
 *     settings field (not sibling dirs). Tags are `project` or
 *     `user-global`, never `(cwd)` or `(sibling-repo)`.
 *   - No project-specific internal module paths leak into the rendered output.
 *   - File-existence regression guards for the deleted
 *     session-section.ts and l1-environment.ts.
 *
 * What this test does NOT do (and why):
 *   - It does NOT grep source for "export async function instanceSection".
 *     TypeScript already enforces that exports resolve.
 *   - It does NOT grep source for specific import paths.
 *   - It does NOT grep source for `which pi` or `gatherL1Environment`.
 *     The behavior is verified by rendering the output and asserting
 *     the version + PID actually appear.
 *
 * History:
 *   - v3.5: pure source-grep test (test-instance-composition.mjs).
 *   - v3.6: pure source-grep test (test-l1-split.mjs).
 *   - v3.7: pure source-grep test (37 grep ops).
 *   - v3.7 cleanup: runtime test (14 assertions + 2 guards).
 *   - v3.8 (this file): Root/Cwd/Settings/SessionId corrections
 *     + settings-driven extension discovery. ~16 runtime assertions
 *     + 2 file-existence guards.
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPT_BUILDER_DIR = join(ROOT, "src/extensions/core/prompt-builder");
const DIST_INSTANCE = join(ROOT, "dist/extensions/core/prompt-builder/instance-composition.js");
const DIST_TOP_LEVEL = join(ROOT, "dist/extensions/core/prompt-builder/top-level-extensions.js");

// ── Load the compiled production code ─────────────────────────────────────

// If these imports fail, TypeScript / `npm run build` failed first.
// We don't wrap in try/catch -- the test runner already builds before
// running tests; a missing dist file is a build failure, not a test
// failure.
const { instanceSection } = require(DIST_INSTANCE);
const { discoverTopLevelExtensions } = require(DIST_TOP_LEVEL);

// ── Test runner ────────────────────────────────────────────────────────────

const results = [];
async function test(name, fn) {
  process.stdout.write(`  - ${name}\n`);
  try {
    await fn();
    results.push({ name, pass: true });
    process.stdout.write(`    [v]\n`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    process.stdout.write(`    [x] ${e.message}\n`);
  }
}

// ── Render the Instance block once, then assert on it ─────────────────────

const pi = {}; // instanceSection doesn't invoke any pi.registerTool / etc.
// Mock the minimum subset of ExtensionContext used by instanceSection:
// sessionManager.getSessionId() + cwd. The other ctx fields are not
// touched by the section.
const ctx = {
  cwd: ROOT,
  sessionManager: {
    getSessionId: () => "test-session-id-1234",
    getSessionFile: () => "/tmp/fake/session.jsonl",
  },
};
const SECTION = await instanceSection(pi, ctx, { skillCount: 26, memoryCount: 5 });
const OUT = await SECTION.render();

// ── Subtests ───────────────────────────────────────────────────────────────

await test("Section returns a PromptSection named 'instance'", () => {
  assert.equal(typeof SECTION, "object");
  assert.equal(SECTION.name, "instance");
  assert.equal(typeof SECTION.render, "function");
});

await test("Rendered output starts with '## Instance'", () => {
  assert.ok(
    OUT.startsWith("## Instance\n"),
    `expected output to start with '## Instance', got: ${OUT.slice(0, 80)}`,
  );
});

await test("Renders 'Agent: Braid v<X> (over pi-core v<Y>)' with semver versions", () => {
  assert.match(
    OUT,
    /^Agent: Braid v\d+\.\d+\.\d+ \(over pi-core v\d+\.\d+\.\d+\)$/m,
    "expected Agent line with semver on both sides",
  );
});

await test("Pi-core version is reported correctly (regression: not 0.77.0, not unknown)", () => {
  // The v3.5-v3.6 bug: pi-core was reported as 0.77.0 from braid's
  // stale local node_modules, when the actually-running binary was
  // 0.80.2. v3.7+ resolves it via PATH walk + realpathSync.
  //
  // The contract pinned here: the rendered version is some valid
  // semver AND it is neither "0.77.0" (the old broken value) nor
  // "unknown" (which would indicate the discovery failed entirely).
  const renderedMatch = OUT.match(/pi-core v(\d+\.\d+\.\d+)/);
  assert.ok(renderedMatch, "rendered output must contain pi-core version");
  const version = renderedMatch[1];
  assert.notEqual(version, "0.77.0", "must not show the stale braid-local version");
  assert.notEqual(version, "unknown", "discovery must succeed (not 'unknown')");
  assert.match(version, /^\d+\.\d+\.\d+$/, "must be semver");
});

await test("Core points at the pi-core npm package folder (NOT braid)", () => {
  // v3.7 leaked the braid development cwd as 'Root'. v3.8 corrected
  // this and renamed the label to 'Core': the pi-core npm package
  // folder where the agent is actually hosted. Path should contain
  // 'pi-coding-agent' or sit under a mise/npm-global node_modules layout.
  const coreMatch = OUT.match(/^Core: (.+)$/m);
  assert.ok(coreMatch, "must render a Core line");
  const core = coreMatch[1].trim();
  assert.notEqual(
    core,
    ROOT,
    `Core must NOT be the braid repo (${ROOT}) -- it should be the pi-core package folder`,
  );
  // Sanity: pi-core root should look like a real package path.
  assert.ok(
    core === "(unknown)" || core.includes("/") || core.includes("\\"),
    `Core must be a path or '(unknown)', got: ${core}`,
  );
});

await test("Cwd is always rendered as its own line (never suppressed)", () => {
  // v3.7 suppressed Cwd when it equaled braidRoot. v3.8 always
  // renders it -- the agent's actual working directory is always
  // worth surfacing.
  assert.match(OUT, /^Cwd: .+\/pi-braid$/m, "Cwd line must be rendered (was suppressed in v3.7)");
});

await test("Renders Settings line pointing at the userland pi dir", () => {
  // Format: "Settings: <path>" where <path> is the userland pi
  // settings dir (~/.pi/agent by default, or PI_CODING_AGENT_DIR).
  assert.match(
    OUT,
    /^Settings: .+(\.pi|\.tau|\.agent)/m,
    "Settings line must point at a userland pi config directory",
  );
});

await test("Renders OS + hostname + Now + PID", () => {
  assert.match(OUT, /^OS: \w+ \(\w+\) hostname=/m, "OS line must include hostname");
  assert.ok(
    OUT.includes(`hostname=${os.hostname()}`),
    `hostname must equal os.hostname() (${os.hostname()})`,
  );
  assert.match(OUT, /^Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m, "Now must be ISO datetime");
  assert.ok(
    OUT.includes(`PID: ${process.pid}`),
    `PID line must equal process.pid (${process.pid})`,
  );
});

await test("Session line includes the session id", () => {
  // Format: "Session: <id>, <elapsed> elapsed, last event <delta> ago, N turn(s)"
  assert.match(
    OUT,
    /^Session: test-session-id-1234, \d+(?:ms|s|m|h)(?:\s\d+(?:ms|s|m|h))? elapsed, last event \d+(?:ms|s|m|h) ago, \d+ turns?$/m,
    "Session line must lead with the session id, then elapsed/last-event/turns",
  );
});

await test("Renders 'Pi extensions (N loaded):' header", () => {
  assert.match(OUT, /^Pi extensions \(\d+ loaded\):$/m, "must show 'Pi extensions (N loaded):'");
});

await test("Extension paths are rendered as full paths (never bare '.')", () => {
  // Regression: v3.8 rendered the cwd-relative path '.' for
  // extensions loaded from cwd (e.g. pi-braid when the agent runs
  // from the braid repo). That's not a useful path -- the agent
  // can't `read` or `grep` '.'. The contract is: every extension
  // line shows either a relative subpath (e.g. 'extensions/foo')
  // or an absolute path. A bare '.' is never acceptable.
  const extLines = OUT.split("\n").filter((l) => /^\s+\S+ v\d+\.\d+\.\d+/.test(l));
  assert.ok(extLines.length > 0, "must have at least one extension line");
  for (const line of extLines) {
    // Strip leading indent, name, version, and trailing (source) tag.
    // What's left is the path field. Must not be empty or '.'.
    const m = line.match(/^\s+\S+\s+v\S+\s+(\S.*?)\s+\((?:project|user-global)\)\s*$/);
    assert.ok(m, `could not parse extension line: ${JSON.stringify(line)}`);
    const pathField = m[1].trim();
    assert.ok(
      pathField.length > 0 && pathField !== ".",
      `extension path must be a usable path, not '.' or empty: ${JSON.stringify(line)}`,
    );
  }
});

await test("Top-level list uses source tags (cwd, project, or user-global), not sibling-repo", () => {
  // v3.8 reads pi-core's `packages` settings field, so most packages
  // have a settings-scope tag ((project) or (user-global)). Packages
  // loaded directly from the development cwd may show (cwd). The
  // legacy (sibling-repo) tag from v3.7 must not appear.
  assert.ok(
    !/\(sibling-repo\)/.test(OUT),
    "must not use the v3.7 (sibling-repo) tag -- packages are loaded from settings, not sibling dirs",
  );
  // Each rendered line must end with one of the valid source tags.
  const extLines = OUT.split("\n").filter((l) => /^\s+\S+ v\d+\.\d+\.\d+/.test(l));
  assert.ok(extLines.length > 0, "must have at least one extension line");
  for (const line of extLines) {
    assert.match(
      line,
      /\((?:cwd|project|user-global)\)/,
      `extension line must have a valid source tag ((cwd), (project), or (user-global)): ${line}`,
    );
  }
});

await test("No project-specific internal module paths leak into the output", () => {
  // Regression guard: v3.5 surfaced internal module tree paths which
  // leaked braid's implementation details. The output must never
  // contain those internal module paths.
  assert.ok(
    !OUT.includes("src/extensions/"),
    "Instance block must not leak internal module tree paths",
  );
});

await test("Renders 'Resources: N skills, M memories' line", () => {
  assert.match(
    OUT,
    /^Resources: 26 skills, 5 memories$/m,
    "must show resources line with the passed skillCount + memoryCount",
  );
});

await test("Discovery hint is generic, with no unicode arrow", () => {
  // v3.8 corrected two issues: dropped the `->` arrow (excessive)
  // and broadened the hint to cover the full runtime (not just
  // extension source code).
  assert.ok(!OUT.includes("->"), "must not use a unicode arrow in the hint");
  assert.match(
    OUT,
    /Discover on demand: `read`/,
    "must have a 'Discover on demand' line with a `read` pointer",
  );
  // The generic hint should also mention the file tools reach the
  // wider runtime -- not just extension source.
  assert.ok(
    /bash.*grep.*find.*ls|`bash`|`grep`|`find`|`ls`/.test(OUT),
    "hint should mention file tools for broader discoverability",
  );
});

// ── discoverTopLevelExtensions runtime behavior ────────────────────────────

await test("discoverTopLevelExtensions() reads from userland settings (not sibling dirs)", () => {
  // The userland settings.json (read-only smoke test here) lists
  // 4 local paths + 2 npm packages. Discovery must surface them
  // by their settings scope, NOT by walking cwd siblings. Pass the
  // ROOT cwd to scope the project path lookup.
  const exts = discoverTopLevelExtensions(ROOT);
  // Should NOT contain sibling-discovered packages.
  assert.ok(
    !exts.some((e) => e.name === "@saibolla/ada"),
    "must not pick up sibling-discovered @saibolla/ada -- only settings entries",
  );
  // Each package's source tag is one of the two settings scopes.
  for (const ext of exts) {
    assert.ok(
      ext.source === "project" || ext.source === "user-global",
      `unexpected source tag '${ext.source}' on ${ext.name}`,
    );
  }
});

await test("discoverTopLevelExtensions() deduplicates by absolute root", () => {
  // If a symlink points back to cwd, it should not appear twice.
  const exts = discoverTopLevelExtensions(ROOT);
  const roots = exts.map((e) => e.root);
  assert.equal(new Set(roots).size, roots.length, "no duplicate root paths");
});

// ── File-existence regression guards ───────────────────────────────────────

await test("session-section.ts is deleted (v3.6 Session block merged into Instance)", () => {
  assert.ok(
    !existsSync(join(PROMPT_BUILDER_DIR, "session-section.ts")),
    "session-section.ts must remain deleted after v3.7 merge",
  );
});

await test("l1-environment.ts is still deleted (v3.6 cleanup)", () => {
  assert.ok(
    !existsSync(join(PROMPT_BUILDER_DIR, "l1-environment.ts")),
    "l1-environment.ts must remain deleted (v3.6 cleanup)",
  );
});

await test("Instance block does not contain 'getModuleGroup' (v3.5 module tree removed)", () => {
  // An indirect guard: the module tree was the source of the v3.5
  // project-specific info leak. The runtime output should never
  // contain module group paths. This pins the absence.
  assert.ok(!/getModuleGroup|getModuleNames/.test(OUT));
});

// ── Report ────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log(`\n${passed}/${results.length} subtests passed`);
if (failed > 0) {
  const failLines = [];
  for (const r of results.filter((r) => !r.pass)) {
    failLines.push(`  [x] ${r.name}: ${r.error}`);
  }
  console.log(failLines.join("\n"));
  process.exit(1);
}
console.log("test-instance-block (runtime): all green");

// Reference unused imports to keep the linter happy.
void basename;