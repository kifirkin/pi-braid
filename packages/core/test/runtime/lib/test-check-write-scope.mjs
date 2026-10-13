/**
 * test-check-write-scope.mjs — the production scan refuses a write whose
 * target can resolve into the session's project.
 *
 * The check reads the working tree of its own repo root, so each case runs a
 * copy of the script against a throwaway tree it owns and removes afterward.
 * The real checkout is never touched.
 *
 * Cases:
 *   1. a target resolved through a helper call is neutral -> exit 0
 *   2. `process.cwd()` in the target expression -> exit 1, naming file + line
 *   3. a bare relative literal target -> exit 1
 *   4. a `HOME || "."` fallback chain -> exit 1 (cwd-relative when unset)
 *   5. the same cwd base laundered through a local `const` -> exit 1
 *   6. `openSync(path, "r")` is a read -> exit 0; a write mode -> exit 1
 *   7. a test-tree file under a *scanned* root is out of scope -> exit 0
 *   8. a write-family call through a named import alias -> exit 1 naming the line
 *   9. an aliased `openSync` with a read mode is not a write -> exit 0
 *  10. namespace bracket access (`fs["writeFileSync"]`) -> exit 1
 *  11. a capture (`const wf = fs.writeFileSync`) -> exit 1
 *  12. a destructured capture (`const { writeFileSync: wf } = fs`) -> exit 1
 *  13. `process.env.PWD` is a cwd source -> exit 1
 *  14. a relative target built without `path.join` (`["out","x"].join("/")`) -> exit 1
 *  15. a write-family name only in a comment or a string is not a site -> exit 0
 *  16. a non-fs method with a write-family name (`new Widget().mkdir(...)`) -> exit 0
 *  17. the allowlist sanctions a call, not a file: the sanctioned call alone is
 *      allowlisted -> exit 0; a second cwd write in the same file -> exit 1
 *  18. the flat package trees are scanned: a plant under `packages/contrib`,
 *      `packages/providers` or `packages/skills` is reported -> exit 1
 *  19. an alias from `node:fs/promises` (absolute and relative targets) -> exit 1
 *  20. a write bound from a dynamic import (destructured and namespace) -> exit 1
 *  21. a template based at an interpolated relative literal -> exit 1, while a
 *      genuinely dynamic base stays out of reach -> exit 0
 *  22. a write-family alias re-exported from a scanned local module -> exit 1
 *  23. an alias named only in a comment (a local function of the same name) is
 *      not a site -> exit 0
 *  24. a write inside `${…}` after a regex carrying `}` -> exit 1
 *  25. the same after a block comment carrying `}` -> exit 1
 *  26. `return /['"]/` followed by a cwd write -> exit 1 (the regex is a
 *      literal, not the division its last letter suggested)
 *  27. a call-shaped regex after a statement head's `)` -> exit 0, while one
 *      after a block-closing `}` is still reported (a documented residual)
 *  28. the remaining binding spellings resolve: `import fs = require(...)`,
 *      `const { promises: p } = require(...)`, `const { wf } = fs.promises`,
 *      `let wf; wf = fs.writeFileSync`, a second declarator and
 *      `.bind(receiver)` -> exit 1 each
 *  29. shapes the header names as out of reach stay out of reach and stay
 *      counted rather than reported: `fs[key]`, `fs["write" + "FileSync"]`,
 *      `require("node:fs").writeFileSync(...)`, `writeFileSync.call(…)`, an
 *      `export *` shim, an unscanned specifier, a template base that starts
 *      at an interpolation, and an `execSync` shell write -> exit 0
 *  30. the allowlist matches the whole target, not a substring: a cwd write
 *      naming `braid.schema.json` is a finding, and so is the workers call
 *      with a different argument, while the sanctioned calls stay allowlisted
 *  31. a name declared twice in one file is judged against its LAST
 *      declaration -> exit 0 when the hazardous declaration comes first, exit 1
 *      when it comes last (a documented bound, pinned in both directions)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-write-scope.mjs");
const COLLECT = join(ROOT, "scripts", "lib", "collect-files.mjs");

/** Build a throwaway repo with one planted file, run the check, remove it. */
function runCase(relPath, content, extras = {}) {
  const tree = mkdtempSync(join(tmpdir(), "writescan-"));
  try {
    const scriptsDir = join(tree, "packages/core/scripts");
    mkdirSync(join(scriptsDir, "lib"), { recursive: true });
    copyFileSync(SCRIPT, join(scriptsDir, "check-write-scope.mjs"));
    copyFileSync(COLLECT, join(scriptsDir, "lib", "collect-files.mjs"));
    for (const [path, text] of Object.entries(extras)) {
      const extra = join(tree, path);
      mkdirSync(dirname(extra), { recursive: true });
      writeFileSync(extra, text + "\n");
    }
    if (relPath) {
      const planted = join(tree, relPath);
      mkdirSync(dirname(planted), { recursive: true });
      writeFileSync(planted, content + "\n");
    }

    const r = spawnSync(
      "node",
      [join(scriptsDir, "check-write-scope.mjs")],
      { cwd: tree, encoding: "utf8" },
    );
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const CLEAN = `import { writeFileSync } from "node:fs";
export function save(path: string, text: string): void {
  writeFileSync(path, text);
}`;

test("a caller-supplied path is neutral (exit 0, counts reported)", () => {
  const { status, out } = runCase("packages/core/src/clean.ts", CLEAN);
  assert.equal(status, 0, out);
  assert.match(out, /check-write-scope: clean/);
  assert.match(out, /write sites/);
});

test("a process.cwd() target is reported with file and line", () => {
  const content = `import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
const projectPath = join(process.cwd(), ".pi", "settings.json");
mkdirSync(dirname(projectPath), { recursive: true });`;
  const { status, out } = runCase("packages/core/src/leak.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/leak\.ts:4/);
  assert.match(out, /process\.cwd\(\)/);
  assert.match(out, /1 write\(s\) can resolve into the project/);
});

test("a bare relative literal target is reported", () => {
  const content = `import { writeFileSync } from "node:fs";
writeFileSync("settings.json", "{}");`;
  const { status, out } = runCase("packages/core/src/relative.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /relative-literal/);
  assert.match(out, /settings\.json/);
});

test('a HOME fallback chain ending in "." is reported', () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME || process.env.USERPROFILE || ".";
writeFileSync(join(home, ".key-ring-state.json"), "{}");`;
  const { status, out } = runCase("packages/core/src/fallback.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /dot-fallback/);
});

test("a cwd base laundered through a local const is still reported", () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const out = join(process.cwd(), "stats.json");
writeFileSync(out, "{}");`;
  const { status, out } = runCase("packages/core/src/laundered.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/laundered\.ts:4/);
});

test('openSync with a read mode is not a write; a write mode is', () => {
  const readCase = `import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
const fd = openSync(join(process.cwd(), "log.txt"), "r");
closeSync(fd);`;
  const read = runCase("packages/core/src/read-only.ts", readCase);
  assert.equal(read.status, 0, read.out);

  const writeCase = `import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
const fd = openSync(join(process.cwd(), "log.txt"), "w");
closeSync(fd);`;
  const write = runCase("packages/core/src/write-mode.ts", writeCase);
  assert.equal(write.status, 1, write.out);
  assert.match(write.out, /packages\/core\/src\/write-mode\.ts:3/);
});

test("a test-tree file under a scanned root is out of the production scope", () => {
  // `packages/contrib/**` is inside a scan root, so this case is decided by
  // the test-tree exclusion and by nothing else.
  const { status, out } = runCase(
    "packages/contrib/test/leak.test.mjs",
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "x.json"), "{}");`,
  );
  assert.equal(status, 0, out);
  assert.match(out, /check-write-scope: clean/);
});

test("a write-family call through a named import alias is still the write it is", () => {
  const content = `import { writeFileSync as wf } from "node:fs";
import { join as j } from "node:path";
export function probe() { wf(j(process.cwd(), "x.json"), "x"); }`;
  const { status, out } = runCase("packages/core/src/alias.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/alias\.ts:3/, out);
  assert.match(out, /process\.cwd\(\)/);
  assert.match(out, /1 write\(s\) can resolve into the project/);
});

test("an aliased openSync keeps its read mode (a read is not a write)", () => {
  const content = `import { openSync as o, closeSync as c } from "node:fs";
import { join as j } from "node:path";
const fd = o(j(process.cwd(), "log.txt"), "r");
c(fd);`;
  const { status, out } = runCase("packages/core/src/alias-read.ts", content);
  assert.equal(status, 0, out);
  assert.match(out, /check-write-scope: clean/);
});

test("namespace bracket access, a capture and a destructured capture all resolve", () => {
  const bracket = `import * as fs from "node:fs";
import { join } from "node:path";
fs["writeFileSync"](join(process.cwd(), "leak.json"), "{}");`;
  const b = runCase("packages/core/src/bracket.ts", bracket);
  assert.equal(b.status, 1, b.out);
  assert.match(b.out, /packages\/core\/src\/bracket\.ts:3/);
  assert.match(b.out, /process\.cwd\(\)/);

  const capture = `import * as fs from "node:fs";
import { join } from "node:path";
const wf = fs.writeFileSync;
wf(join(process.cwd(), "leak.json"), "{}");`;
  const c = runCase("packages/core/src/capture.ts", capture);
  assert.equal(c.status, 1, c.out);
  assert.match(c.out, /packages\/core\/src\/capture\.ts:4/);

  const destructured = `import * as fs from "node:fs";
import { join } from "node:path";
const { writeFileSync: wf } = fs;
wf(join(process.cwd(), "leak.json"), "{}");`;
  const d = runCase("packages/core/src/destructured.ts", destructured);
  assert.equal(d.status, 1, d.out);
  assert.match(d.out, /packages\/core\/src\/destructured\.ts:4/);
});

test("optional chaining, a template bracket key and require captures resolve", () => {
  const optional = `import * as fs from "node:fs";
import { join } from "node:path";
fs?.writeFileSync(join(process.cwd(), "leak.json"), "{}");`;
  const o = runCase("packages/core/src/optional.ts", optional);
  assert.equal(o.status, 1, o.out);
  assert.match(o.out, /packages\/core\/src\/optional\.ts:3/);

  const templateKey = `import * as fs from "node:fs";
import { join } from "node:path";
fs[\`writeFileSync\`](join(process.cwd(), "leak.json"), "{}");`;
  const k = runCase("packages/core/src/template-key.ts", templateKey);
  assert.equal(k.status, 1, k.out);
  assert.match(k.out, /packages\/core\/src\/template-key\.ts:3/);

  const promises = `import * as fs from "node:fs";
import { join } from "node:path";
const { promises: fsp } = fs;
fsp.writeFile(join(process.cwd(), "leak.json"), "{}");`;
  const p = runCase("packages/core/src/promises.ts", promises);
  assert.equal(p.status, 1, p.out);
  assert.match(p.out, /packages\/core\/src\/promises\.ts:4/);

  const requireCase = `const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(process.cwd(), "leak.json"), "{}");`;
  const r = runCase("packages/core/src/require.ts", requireCase);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /packages\/core\/src\/require\.ts:3/);
});

test("process.env.PWD is a cwd source", () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.PWD, "leak.json"), "{}");`;
  const { status, out } = runCase("packages/core/src/pwd.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /process\.env\.PWD/);
});

test("a relative target built without path.join is reported", () => {
  const content = `import { writeFileSync } from "node:fs";
writeFileSync(["out", "leak.json"].join("/"), "{}");`;
  const { status, out } = runCase("packages/core/src/array-join.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /relative-literal/);
  assert.match(out, /out/);
});

test("a write-family name only in a comment or a string is not a site", () => {
  const comment = `export const NOTE = "do not";
// never do this: writeFileSync("out.json", "{}")
export function noop(): void {}`;
  const c = runCase("packages/core/src/comment.ts", comment);
  assert.equal(c.status, 0, c.out);
  assert.match(c.out, /0 write sites/);

  const stringCase = `export const doc = 'call writeFileSync("out.json") only in tests';`;
  const s = runCase("packages/core/src/string.ts", stringCase);
  assert.equal(s.status, 0, s.out);
  assert.match(s.out, /0 write sites/);
});

test("a non-fs method with a write-family name is not a write", () => {
  const content = `export class Widget { mkdir(target: string): void { void target; } }
new Widget().mkdir("relative/dir");`;
  const { status, out } = runCase("packages/core/src/widget.ts", content);
  assert.equal(status, 0, out);
  assert.match(out, /0 write sites/);
});

test("the allowlist sanctions a call, not a file", () => {
  const sanctioned = `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const __dirname = "/repo";
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const artifactPath = join(REPO_ROOT, "packages/core/schema/braid.schema.json");
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, "{}", "utf8");`;
  const clean = runCase("packages/core/scripts/gen-braid-schema.mjs", sanctioned);
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /2 allowlisted/);

  // The reviewer's plant: a new cwd write appended to an allowlisted file.
  const planted = `${sanctioned}
writeFileSync(join(process.cwd(), "schema-leak.json"), "{}");`;
  const dirty = runCase("packages/core/scripts/gen-braid-schema.mjs", planted);
  assert.equal(dirty.status, 1, dirty.out);
  assert.match(dirty.out, /gen-braid-schema\.mjs:8/);
  assert.match(dirty.out, /source-dir/);
});

test("a plant under a flat package tree is reported", () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "leak.json"), "{}");`;
  for (const pkg of ["contrib", "providers", "skills"]) {
    const { status, out } = runCase(`packages/${pkg}/leak.ts`, content);
    assert.equal(status, 1, `${pkg}: ${out}`);
    assert.match(out, new RegExp(`packages/${pkg}/leak\\.ts:3`));
  }
});

test("an aliased write from node:fs/promises resolves like its node:fs twin", () => {
  const absolute = `import { writeFile as wf } from "node:fs/promises";
import { join } from "node:path";
export async function save(): Promise<void> {
  await wf(join(process.cwd(), "leak.json"), "{}");
}`;
  const a = runCase("packages/core/src/promises-alias.ts", absolute);
  assert.equal(a.status, 1, a.out);
  assert.match(a.out, /packages\/core\/src\/promises-alias\.ts:4/);
  assert.match(a.out, /process\.cwd\(\)/);

  const relative = `import { appendFile as af } from "node:fs/promises";
export async function save(): Promise<void> {
  await af("out.json", "{}");
}`;
  const r = runCase("packages/core/src/promises-relative.ts", relative);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /relative-literal/);
  assert.match(r.out, /out\.json/);
});

test("a write bound from a dynamic import resolves", () => {
  const destructured = `import { join } from "node:path";
export async function save(): Promise<void> {
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(join(process.cwd(), "leak.json"), "{}");
}`;
  const d = runCase("packages/core/src/dynamic-destructured.ts", destructured);
  assert.equal(d.status, 1, d.out);
  assert.match(d.out, /packages\/core\/src\/dynamic-destructured\.ts:4/);

  const namespace = `import { join } from "node:path";
export async function save(): Promise<void> {
  const fsp = await import("node:fs");
  await fsp.writeFile(join(process.cwd(), "leak.json"), "{}");
}`;
  const n = runCase("packages/core/src/dynamic-namespace.ts", namespace);
  assert.equal(n.status, 1, n.out);
  assert.match(n.out, /packages\/core\/src\/dynamic-namespace\.ts:4/);
});

test("a template based at an interpolated relative literal is reported", () => {
  const content = `import { writeFileSync } from "node:fs";
export function save(): void {
  writeFileSync(\`\${'.'}/leak.json\`, "{}");
}`;
  const { status, out } = runCase("packages/core/src/template-interpolated.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/template-interpolated\.ts:3/);
  assert.match(out, /relative-literal/);

  // ...while a genuinely dynamic base stays out of reach (a documented bound).
  const dynamic = `import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
export function save(): void {
  writeFileSync(\`\${tmpdir()}/scratch.json\`, "{}");
}`;
  const d = runCase("packages/core/src/template-dynamic.ts", dynamic);
  assert.equal(d.status, 0, d.out);
  assert.match(d.out, /1 write sites/);
});

test("a write-family alias re-exported from a local module resolves", () => {
  const shim = `import { writeFileSync } from "node:fs";
export { writeFileSync as wf };`;
  const content = `import { wf } from "./shim.mjs";
import { join } from "node:path";
export function save(): void {
  wf(join(process.cwd(), "leak.json"), "{}");
}`;
  const { status, out } = runCase("packages/core/src/reexport.ts", content, {
    "packages/core/src/shim.mjs": shim,
  });
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/reexport\.ts:4/);
  assert.match(out, /process\.cwd\(\)/);
});

test("an alias named only in a comment does not register", () => {
  const content = `// import { writeFileSync as wf } from "node:fs" — prose, not a binding
function wf(target: string, text: string): void {
  void target;
  void text;
}
export function save(): void {
  wf("not-a-write.json", "{}");
}`;
  const { status, out } = runCase("packages/core/src/comment-alias.ts", content);
  assert.equal(status, 0, out);
  assert.match(out, /0 write sites/);
});

test("a write inside a template interpolation is not lost to a `}` in a regex or comment", () => {
  const afterRegex = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const s = \`prefix \${/\\}/.test(name) ? writeFileSync(join(process.cwd(), "leak.json"), "{}") : "no"}\`;
export default s;`;
  const r = runCase("packages/core/src/interp-regex.ts", afterRegex);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /packages\/core\/src\/interp-regex\.ts:3/);
  assert.match(r.out, /process\.cwd\(\)/);

  const afterComment = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const s = \`\${/* } */ writeFileSync(join(process.cwd(), "leak.json"), "{}")}\`;
export default s;`;
  const c = runCase("packages/core/src/interp-comment.ts", afterComment);
  assert.equal(c.status, 1, c.out);
  assert.match(c.out, /packages\/core\/src\/interp-comment\.ts:3/);
  assert.match(c.out, /process\.cwd\(\)/);
});

test("a quote inside a regex after a keyword no longer swallows the file", () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export function isQuoted(s: string): boolean { return /['"]/.test(s); }
writeFileSync(join(process.cwd(), "leak.json"), "{}");`;
  const { status, out } = runCase("packages/core/src/regex-quote.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/regex-quote\.ts:4/);
  assert.match(out, /process\.cwd\(\)/);
});

test("a call-shaped regex is a regex after a statement head, not after a block", () => {
  const afterHead = `import { writeFileSync } from "node:fs";
export function scan(line: string): boolean {
  if (!line) /writeFileSync("leak.json")/.test(line);
  return false;
}`;
  const head = runCase("packages/core/src/regex-head.ts", afterHead);
  assert.equal(head.status, 0, head.out);

  // A regex whose first token follows a `}` that closed a block is the one
  // position the heuristic still reads as a division: a documented residual.
  const afterBlock = `import { writeFileSync } from "node:fs";
if (1 > 2) {} /writeFileSync("leak.json")/.test("x");`;
  const block = runCase("packages/core/src/regex-block.ts", afterBlock);
  assert.equal(block.status, 1, block.out);
  assert.match(block.out, /relative-literal/);
});

test("an import-equals, a require promises destructuring and a namespace-member destructuring resolve", () => {
  const importEquals = `import fs = require("node:fs");
import { join } from "node:path";
fs.writeFileSync(join(process.cwd(), "leak.json"), "{}");`;
  const ie = runCase("packages/core/src/import-equals.ts", importEquals);
  assert.equal(ie.status, 1, ie.out);
  assert.match(ie.out, /packages\/core\/src\/import-equals\.ts:3/);

  const requirePromises = `const { promises: p } = require("node:fs");
const { join } = require("node:path");
p.writeFile(join(process.cwd(), "leak.json"), "{}");`;
  const rp = runCase("packages/core/src/require-promises.ts", requirePromises);
  assert.equal(rp.status, 1, rp.out);
  assert.match(rp.out, /packages\/core\/src\/require-promises\.ts:3/);

  const barePromises = `const { promises } = require("node:fs");
const { join } = require("node:path");
promises.writeFile(join(process.cwd(), "leak.json"), "{}");`;
  const bp = runCase("packages/core/src/require-promises-bare.ts", barePromises);
  assert.equal(bp.status, 1, bp.out);

  const namespaceMember = `import * as fs from "node:fs";
import { join } from "node:path";
const { writeFileSync } = fs.promises;
writeFileSync(join(process.cwd(), "leak.json"), "{}");`;
  const nm = runCase("packages/core/src/fs-promises.ts", namespaceMember);
  assert.equal(nm.status, 1, nm.out);
  assert.match(nm.out, /packages\/core\/src\/fs-promises\.ts:4/);
});

test("an assignment, a second declarator and a bound capture all resolve", () => {
  const assigned = `import * as fs from "node:fs";
import { join } from "node:path";
let wf;
wf = fs.writeFileSync;
wf(join(process.cwd(), "leak.json"), "{}");`;
  const a = runCase("packages/core/src/assigned.ts", assigned);
  assert.equal(a.status, 1, a.out);
  assert.match(a.out, /packages\/core\/src\/assigned\.ts:5/);

  const multiDeclarator = `import * as fs from "node:fs";
import { join } from "node:path";
const wf = fs.writeFileSync, md = fs.mkdirSync;
wf(join(process.cwd(), "leak.json"), "{}");
md(join(process.cwd(), "leak-dir"));`;
  const m = runCase("packages/core/src/multi-declarator.ts", multiDeclarator);
  assert.equal(m.status, 1, m.out);
  assert.match(m.out, /packages\/core\/src\/multi-declarator\.ts:4/);

  const bound = `import * as fs from "node:fs";
import { join } from "node:path";
const wf = fs.writeFileSync.bind(fs);
wf(join(process.cwd(), "leak.json"), "{}");`;
  const b = runCase("packages/core/src/bound.ts", bound);
  assert.equal(b.status, 1, b.out);
  assert.match(b.out, /packages\/core\/src\/bound\.ts:4/);
});

test("the callee shapes the header names as out of reach stay counted, not reported", () => {
  const cases = {
    "variable-bracket.ts": `import * as fs from "node:fs";
import { join } from "node:path";
const key = "writeFileSync";
fs[key](join(process.cwd(), "leak.json"), "{}");`,
    "concat-bracket.ts": `import * as fs from "node:fs";
import { join } from "node:path";
fs["write" + "FileSync"](join(process.cwd(), "leak.json"), "{}");`,
    "inline-require.ts": `const { join } = require("node:path");
require("node:fs").writeFileSync(join(process.cwd(), "leak.json"), "{}");`,
    "inline-import.ts": `import { join } from "node:path";
export async function save(): Promise<void> {
  (await import("node:fs")).writeFileSync(join(process.cwd(), "leak.json"), "{}");
}`,
    "fn-call.ts": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync.call(null, join(process.cwd(), "leak.json"), "{}");`,
    "shell.ts": `import { execSync } from "node:child_process";
import { join } from "node:path";
export function prep(): void {
  execSync(\`mkdir -p "\${join(process.cwd(), "scratch")}"\`, { stdio: "ignore" });
  execSync("rm -f ./state.json", { stdio: "ignore" });
}`,
  };
  for (const [name, content] of Object.entries(cases)) {
    const { status, out } = runCase(`packages/core/src/${name}`, content);
    assert.equal(status, 0, `${name}: ${out}`);
    assert.match(out, /0 write sites/, `${name}: ${out}`);
  }
});

test("an export-star shim and an unscanned specifier stay out of reach", () => {
  const star = `import { writeFileSync } from "./shim.mjs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "leak.json"), "{}");`;
  const s = runCase("packages/core/src/export-star.ts", star, {
    "packages/core/src/shim.mjs": `export * from "node:fs";`,
  });
  assert.equal(s.status, 0, s.out);
  assert.match(s.out, /0 write sites/);

  const unscanned = `import { wf } from "pi-braid-lib/fs-extra";
import { join } from "node:path";
wf(join(process.cwd(), "leak.json"), "{}");`;
  const u = runCase("packages/core/src/unscanned.ts", unscanned);
  assert.equal(u.status, 0, u.out);
  assert.match(u.out, /0 write sites/);
});

test("a template base that starts at an interpolation stays out of reach", () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const file = join(process.cwd(), "state.json");
writeFileSync(\`\${file}.tmp-\${process.pid}\`, "{}");`;
  const { status, out } = runCase("packages/core/src/template-base.ts", content);
  assert.equal(status, 0, out);
  assert.match(out, /1 write sites/);
});

test("the allowlist matches the whole target, not a substring of it", () => {
  const sanctioned = `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const __dirname = "/repo/packages/core/scripts";
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const artifactPath = join(REPO_ROOT, "packages/core/schema/braid.schema.json");
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, "{}", "utf8");`;
  const clean = runCase("packages/core/scripts/gen-braid-schema.mjs", sanctioned);
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /2 allowlisted/);

  // The reviewer's widening plant: the artifact name inside a cwd target.
  const widened = `${sanctioned}
writeFileSync(join(process.cwd(), "braid.schema.json.bak"), "{}");`;
  const w = runCase("packages/core/scripts/gen-braid-schema.mjs", widened);
  assert.equal(w.status, 1, w.out);
  assert.match(w.out, /gen-braid-schema\.mjs:8/);
  assert.match(w.out, /source-dir/);
});

test("the workers registry entry pins its argument, not its shape", () => {
  const sanctioned = `import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getWorkersFilePath } from "../../config/braid-paths.js";
export function save(cwd?: string): void {
  const file = getWorkersFilePath(cwd ?? process.cwd());
  mkdirSync(dirname(file), { recursive: true });
}`;
  const clean = runCase("packages/core/src/lib/orchestrator/workers.ts", sanctioned);
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /1 allowlisted/);

  const different = sanctioned.replace(
    "getWorkersFilePath(cwd ?? process.cwd())",
    "getWorkersFilePath(process.cwd())",
  );
  const d = runCase("packages/core/src/lib/orchestrator/workers.ts", different);
  assert.equal(d.status, 1, d.out);
  assert.match(d.out, /source-dir/);
});

test("a name declared twice is judged against its last declaration", () => {
  // The binding table is per file, not per scope: a call site bound to an
  // earlier declaration of the same name is judged against the later one. That
  // is a documented bound, and this case pins both directions of it.
  const hazardousFirst = `import * as fs from "node:fs";
function pinnedDir(): string { return "/abs/pinned"; }
function append(): void {
  const dir = process.cwd();
  fs.mkdirSync(dir, { recursive: true });
}
const dir = pinnedDir();
export default append;`;
  const first = runCase("packages/core/src/dupname-first.ts", hazardousFirst);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /1 write sites/);

  const hazardousLast = `import * as fs from "node:fs";
function pinnedDir(): string { return "/abs/pinned"; }
const dir = pinnedDir();
function append(): void {
  const dir = process.cwd();
  fs.mkdirSync(dir, { recursive: true });
}
export default append;`;
  const last = runCase("packages/core/src/dupname-last.ts", hazardousLast);
  assert.equal(last.status, 1, last.out);
  assert.match(last.out, /source-dir/);
});
