/**
 * Test: prompt-builder Instance block -- RUNTIME.
 *
 * Pins the consolidated "## Instance" block contract by actually
 * calling the production code (not by grepping source for function
 * names). Every assertion either renders the real section or
 * invokes the real discovery function with real filesystem state.
 *
 * Contract pinned:
 * - instanceSection() returns a PromptSection named "instance"
 * - The rendered output starts with "Agent: Braid v<X> (over pi-core v<Y>)"
 * (no heading) and contains the Agent, Core, Cwd, Settings, OS, Started,
 * PID, Session, Pi extensions blocks.
 * - Core points at the pi-core npm package folder (not braid).
 * - Cwd is always rendered as its own line (never suppressed).
 * - Settings line points at the userland pi settings dir
 * (~/.pi/agent or PI_CODING_AGENT_DIR override).
 * - Session line includes the session id.
 * - Pi-core version is the actually-running binary, never a stale
 * braid-local copy ("0.77.0") or "unknown".
 * - Top-level extension discovery reads pi-core's `packages`
 * settings field (not sibling dirs). Tags are `project` or
 * `user-global`, never `(sibling-repo)`.
 * - No project-specific internal module paths leak into the rendered output.
 * - Instance block does NOT contain Resources or discovery hint;
 * the assertions below pin the negative.
 * - The compact prompt line (renderCompactInstance) is one line carrying
 *   the braid install root, model, PID, session id and resource counts;
 *   it repeats no cwd, carries no timestamp or duration, and stays under
 *   the byte cap.
 *
 * What this test does NOT do (and why):
 * - It does NOT grep source for "export async function instanceSection".
 * TypeScript already enforces that exports resolve.
 * - It does NOT grep source for specific import paths.
 * - It does NOT grep source for `which pi` or `gatherL1Environment`.
 * The behavior is verified by rendering the output and asserting
 * the version + PID actually appear.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST_INSTANCE = join(ROOT, "dist/extensions/core/prompt-builder/instance-composition.js");
const DIST_TOP_LEVEL = join(ROOT, "dist/extensions/core/prompt-builder/top-level-extensions.js");

// Hermetic discovery fixture: extension discovery reads the user-global
// settings scope (<homedir()>/.pi/agent/settings.json), so rendering depends
// on the host machine state unless HOME is redirected. Redirect HOME to a
// test-owned temp home (os.homedir() reads $HOME on POSIX - same seam as
// test-context-limit-config.mjs) and write a settings fixture listing one
// REAL repo-local pi package (packages/providers). The discovery contract -
// settings-driven, (user-global) source tags, full usable paths - is then
// provable deterministically; every existing assertion keeps its full
// strength.
const FAKE_HOME = mkdtempSync(join(os.tmpdir(), "w85b-instance-block-"));
const AGENT_DIR_FIXTURE = join(FAKE_HOME, ".pi", "agent");
mkdirSync(AGENT_DIR_FIXTURE, { recursive: true });
writeFileSync(
  join(AGENT_DIR_FIXTURE, "settings.json"),
  JSON.stringify({ packages: [join(ROOT, "..", "providers")] }),
);
process.env.HOME = FAKE_HOME;


// If these imports fail, TypeScript / `npm run build`failed first.
// We don't wrap in try/catch -- the test runner already builds before
// running tests; a missing dist file is a build failure, not a test
// failure.
const { instanceSection, gatherInstanceData, renderCompactInstance } = require(DIST_INSTANCE);
const { discoverTopLevelExtensions } = require(DIST_TOP_LEVEL);


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


const pi = {}; // instanceSection doesn't invoke any pi.registerTool / etc.
// Mock the minimum subset of ExtensionContext used by instanceSection:
// sessionManager.getSessionId() + cwd. The other ctx fields are not
// touched by the section.
const ctx = {
  cwd: ROOT,
  // Session model as ExtensionContext exposes it: the compact prompt line
  // renders these two fields verbatim.
  model: { provider: "test-provider", id: "test-model" },
  sessionManager: {
    getSessionId: () => "test-session-id-1234",
    getSessionFile: () => "/tmp/fake/session.jsonl",
  },
};
const SECTION = await instanceSection(pi, ctx, { skillCount: 26, memoryCount: 5 });
const OUT = await SECTION.render();
const DATA = await gatherInstanceData(pi, ctx, { skillCount: 26, memoryCount: 5 });
const COMPACT = renderCompactInstance(DATA);
// A path that exists nowhere in the gathered data except as cwd. If the
// compact line repeats the working directory, this string shows up.
const SENTINEL_CWD = join(FAKE_HOME, "sentinel-cwd-never-rendered");
const COMPACT_WITH_SENTINEL = renderCompactInstance({ ...DATA, cwd: SENTINEL_CWD });
const COMPACT_BYTES = Buffer.byteLength(COMPACT, "utf8");
// Bounds the prompt line against future field creep. Today's line measures
// well under this; the headroom covers a long install path and a UUID
// session id, not new fields.
const COMPACT_CAP_BYTES = 320;


await test("Section returns a PromptSection named 'instance'", () => {
  assert.equal(typeof SECTION, "object");
  assert.equal(SECTION.name, "instance");
  assert.equal(typeof SECTION.render, "function");
});

await test("Rendered output starts with 'Agent: Braid v<X> (over pi-core v<Y>)' (no heading)", () => {
  assert.ok(
    OUT.startsWith("Agent: Braid v"),
    `expected output to start with 'Agent:', got: ${OUT.slice(0, 80)}`,
  );
});

await test("Renders 'Agent: Braid v<X> (over pi-core v<Y>)' with semver versions", () => {
  assert.match(
    OUT,
    // Optional -<prerelease> suffix (e.g. 0.3.2-main.1) is valid semver and is
    // the canonical local release suffix from publish-local.mjs.
    /^Agent: Braid v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \(over pi-core v\d+\.\d+\.\d+\)$/m,
    "expected Agent line with semver on both sides",
  );
});

await test("Pi-core version is reported correctly (regression: not 0.77.0, not unknown)", () => {
  // The contract pinned here: the rendered version is the actually-running
  // binary's semver, resolved via PATH walk + realpathSync - neither a stale
  // braid-local node_modules version nor "unknown" (which would indicate the
  // discovery failed entirely).
  const renderedMatch = OUT.match(/pi-core v(\d+\.\d+\.\d+)/);
  assert.ok(renderedMatch, "rendered output must contain pi-core version");
  const version = renderedMatch[1];
  assert.notEqual(version, "0.77.0", "must not show the stale braid-local version");
  assert.notEqual(version, "unknown", "discovery must succeed (not 'unknown')");
  assert.match(version, /^\d+\.\d+\.\d+$/, "must be semver");
});

await test("Core points at the pi-core npm package folder (NOT braid)", () => {
  // Core is the pi-core npm package folder where the agent is actually
  // hosted - never the braid development cwd. The path should contain
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
  // Cwd always renders - the agent's actual working directory is
  // always worth surfacing (never suppressed).
  assert.match(OUT, /^Cwd: .+/m, "Cwd line must be rendered (was suppressed in v3.7)");
});

await test("Renders Settings line pointing at the userland pi dir", () => {
  // Format: "Settings: <path>"where <path> is the userland pi
  // settings dir (~/.pi/agent by default, or PI_CODING_AGENT_DIR).
  assert.match(
    OUT,
    /^Settings: .+(\.pi|\.tau|\.agent)/m,
    "Settings line must point at a userland pi config directory",
  );
});

await test("Renders OS + PID (no hostname, no Now line)", () => {
  // The OS line is the platform name only (macOS/Linux/Windows); hostname
  // and a Now timestamp would add tokens without actionable value. Uptime
  // is covered by the Started line + Session elapsed instead.
  assert.match(OUT, /^OS: (macOS|Linux|Windows)/m, "OS line must show platform only");
  assert.ok(!OUT.includes("hostname="), "OS line must not include hostname");
  assert.ok(!OUT.includes("^Now:"), "Now timestamp line must not be rendered");
  assert.ok(
    OUT.includes(`PID: ${process.pid}`),
    `PID line must equal process.pid (${process.pid})`,
  );
});

await test("Renders Started line with ISO session start datetime", () => {
  // The Started line exposes the pi instance/session start wall-clock
  // time so the agent can reason about uptime and session duration
  // from absolute time (not just relative elapsed).
  assert.match(
    OUT,
    /^Started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m,
    "Started line must be an ISO datetime",
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

await test("Compact line: one line, no cwd repeat, under the byte cap", () => {
  assert.ok(!COMPACT.includes("\n"), "compact instance line must be exactly one line");
  assert.ok(!COMPACT.includes("Cwd:"), "compact line must not carry a Cwd field");
  assert.ok(
    !COMPACT_WITH_SENTINEL.includes(SENTINEL_CWD),
    "compact line must not render the working directory (pi injects <cwd> natively)",
  );
  assert.ok(
    COMPACT_BYTES <= COMPACT_CAP_BYTES,
    `compact line is ${COMPACT_BYTES} bytes, over the ${COMPACT_CAP_BYTES}-byte cap: ${COMPACT}`,
  );
});

await test("Compact line carries PID, model, session id and resource counts", () => {
  assert.ok(COMPACT.includes(`PID: ${process.pid}`), `PID must be the running process: ${COMPACT}`);
  assert.ok(
    COMPACT.includes("Model: test-provider/test-model"),
    `model line must render provider/id from ctx.model: ${COMPACT}`,
  );
  assert.ok(
    COMPACT.includes("Session: test-session-id-1234"),
    `session line must carry the session id: ${COMPACT}`,
  );
  assert.ok(
    COMPACT.includes("Resources: 26 skills, 5 memories"),
    `resource counts must render: ${COMPACT}`,
  );
});

await test("Compact line names the loaded braid root, not the cwd", () => {
  const rootMatch = COMPACT.match(/Root: ([^|]+?)(?: \||$)/);
  assert.ok(rootMatch, `compact line must carry a Root field: ${COMPACT}`);
  const root = rootMatch[1].trim();
  assert.notEqual(root, "(unknown)", "braid root must resolve (dist sits inside the package)");
  assert.ok(!root.includes(SENTINEL_CWD), "braid root must not be the cwd fallback");
  // Independent check: the field is the folder whose package.json says
  // pi-braid, i.e. the build actually answering, not some other path.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "pi-braid", `Root must be the loaded pi-braid package, got: ${root}`);
});

await test("Compact line carries no timestamp or duration token", () => {
  // The system prompt is a cached prefix; a clock reading, elapsed time, or
  // turn/tool counter here would rewrite that prefix every request. These
  // patterns are the shapes those fields took when they lived in the block.
  assert.doesNotMatch(COMPACT, /\b(?:19|20)\d{2}-\d{2}-\d{2}T/, "no ISO timestamp");
  assert.doesNotMatch(COMPACT, /\b\d{4}-\d{2}-\d{2}\b/, "no calendar date");
  assert.doesNotMatch(COMPACT, /\b\d+(?:ms|s|m|h)\b/, "no elapsed/duration token");
  assert.doesNotMatch(COMPACT, /\b(?:elapsed|ago|turn|turns)\b/, "no elapsed/turn wording");
});

await test("Renders 'Pi extensions (N loaded):' header", () => {
  assert.match(OUT, /^Pi extensions \(\d+ loaded\):$/m, "must show 'Pi extensions (N loaded):'");
});

await test("Extension paths are rendered as full paths (never bare '.')", () => {
  // Every extension line shows either a relative subpath (e.g.
  // 'extensions/foo') or an absolute path - a bare '.' is not a usable
  // path (the agent can't `read` or `grep` '.').
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
  // Packages are read from pi-core's `packages` settings field, so their
  // source tags are (project) or (user-global); packages loaded directly
  // from the development cwd may show (cwd). The (sibling-repo) tag must
  // not appear.
  assert.ok(
    !/\(sibling-repo\)/.test(OUT),
    "must not use the (sibling-repo) tag -- packages are loaded from settings, not sibling dirs",
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
  // Guard: the rendered output must never contain braid's internal
  // module tree paths.
  assert.ok(
    !OUT.includes("src/extensions/"),
    "Instance block must not leak internal module tree paths",
  );
});

await test("Renders no empty trailing sections (resources moved to separate section)", () => {
  // Skills/memory resources and the discovery hint render elsewhere; the
  // Instance block carries neither.
  assert.ok(
    !OUT.includes("Resources:"),
    "Resources block must not appear in Instance (section deleted)",
  );
  assert.ok(
    !OUT.includes("Discover on demand"),
    "Discovery hint must not appear in Instance (moved out)",
  );
  assert.ok(!OUT.includes("->"), "must not use a unicode arrow");
});


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


await test("Instance block does not contain 'getModuleGroup'", () => {
  // Render-output guard (not file existence): the output pins the absence
  // of module-group paths - the project-specific leak channel of a
  // module-tree render. This pins the absence.
  assert.ok(!/getModuleGroup|getModuleNames/.test(OUT));
});


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
