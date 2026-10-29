/**
 * Every workspace package's test script must be reachable from `ci:check`, and
 * every module the core runner counts must be a fixture.
 *
 * A package's own `test` script is the single source of truth for the files
 * that package runs, so a suite no step of `ci:check` invokes is a suite that
 * can never fail the gate. The packages are discovered, never listed: every
 * `packages/<dir>/package.json` that declares a `test` script must be
 * reachable from the root `ci:check` script, where reachable follows the same
 * npm script indirection the chain itself uses - `npm test`, `npm run
 * <name>`, `-w <workspace>` given as a directory path or as a package name,
 * and `--workspaces`.
 *
 * The second half judges the population that chain runs. The core runner walks
 * a tree and counts every `.mjs` it finds as a passed fixture, so a shared
 * helper in that tree registers nothing, asserts nothing, and still adds one to
 * the tally: the same shape as a suite the chain never reaches, a pass that
 * cannot fail. So the runner is asked what it would count (`--list`), and every
 * counted module must be one of
 *
 *   case     a case registered with `node:test`, directly or through a helper
 *            the module declares and calls while it loads
 *   assert   an assertion from `node:assert` called at module scope
 *   driver   a call into a function the module declares, at load: the
 *            hand-rolled harness that counts its own passes and sets the exit
 *            code
 *
 * and every module the tree declares a non-fixture must be none of those, since
 * a declaration that names a real fixture keeps a test out of the run. The
 * declaration is the runner's own (`fixture-manifest.json` in the walked tree),
 * read back through `--list` rather than by walking the tree a second time, so
 * the gate and the runner cannot disagree about which files exist. A tree that
 * carries no core runner - a bench - has no population to judge.
 *
 * Exit code 0 prints a summary naming the packages, the counted population and
 * the declared non-fixtures; exit code 1 names every declaring package the
 * chain never reaches and every module the population disagrees about.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");
const PKG_PARENT = "packages";
const CHAIN = "ci:check";

const problems = [];
const fail = (message) => problems.push(message);

/** Read and parse a JSON file, or null when it is absent or unparseable. */
function readJson(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${file}: not valid JSON`);
    return null;
  }
}

/**
 * Every directory under `packages/` that carries a manifest: the candidate
 * set the check derives its answer from. The root manifest is the chain's
 * own, kept separately.
 */
function discoverPackages() {
  let entries;
  try {
    entries = readdirSync(join(root, PKG_PARENT), { withFileTypes: true });
  } catch {
    fail(`${PKG_PARENT}: not found, so no package's test script can be reached`);
    return [];
  }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = `${PKG_PARENT}/${entry.name}`;
    const manifest = readJson(join(root, dir, "package.json"));
    if (!manifest) continue; // a directory that is not a package
    packages.push({
      dir,
      name: typeof manifest.name === "string" ? manifest.name : null,
      scripts: manifest.scripts ?? {},
    });
  }
  return packages.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/** Split a script body into shell-ish tokens; quotes are honored, no expansion. */
function tokenize(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/** Command separators that end one invocation's token run. */
const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);

/**
 * The npm invocations inside a script body, as `{ script, targets, all }`:
 * `script` is the npm script name (`test` for `npm test`), `targets` the
 * `-w` / `--workspace` values, `all` true for `--workspaces`. Flags and
 * arguments after `--` belong to the invoked script, not to npm.
 */
function npmInvocations(command) {
  const tokens = tokenize(command);
  const invocations = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "npm") continue;
    let end = i + 1;
    while (
      end < tokens.length &&
      tokens[end] !== "npm" &&
      !SEPARATORS.has(tokens[end])
    ) {
      end++;
    }
    const segment = tokens.slice(i + 1, end);
    let script = null;
    let all = false;
    const targets = [];
    for (let k = 0; k < segment.length; k++) {
      const token = segment[k];
      if (token === "--") break;
      if (token === "-w" || token === "--workspace") {
        const value = segment[k + 1];
        if (value && !value.startsWith("-")) {
          targets.push(value);
          k++;
        }
        continue;
      }
      if (token.startsWith("--workspace=")) {
        targets.push(token.slice("--workspace=".length));
        continue;
      }
      if (token === "--workspaces" || token === "-ws") {
        all = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      // `npm test` names its script directly; `npm run <name>` names it in
      // the next plain token.
      if (script === null && token !== "run") script = token;
    }
    if (script) invocations.push({ script, targets, all });
    i = end - 1;
  }
  return invocations;
}

/** Resolve a `-w` value to a discovered package: a directory path or a name. */
function resolveWorkspace(spec, packages) {
  const trimmed = spec.replace(/^\.\//, "").replace(/\/+$/, "");
  return (
    packages.find((pkg) => pkg.dir === trimmed || pkg.name === trimmed) ?? null
  );
}

/**
 * Walk the npm script graph from the root chain and return the set of
 * `<dir>#<script>` nodes it reaches. A workspace spec that resolves to no
 * package is a problem: npm would fail on it, so the chain is already broken.
 */
function reachableFrom(packages, rootManifest) {
  const manifestOf = (dir) =>
    dir === "" ? rootManifest : (packages.find((p) => p.dir === dir) ?? null);
  const reached = new Set();
  const seen = new Set();
  const queue = [{ dir: "", script: CHAIN }];
  while (queue.length > 0) {
    const node = queue.shift();
    const key = `${node.dir}#${node.script}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const manifest = manifestOf(node.dir);
    const label = node.dir === "" ? "package.json" : node.dir;
    if (!manifest) {
      fail(`${label}: reached as a workspace, but no package.json carries it`);
      continue;
    }
    const body = manifest.scripts?.[node.script];
    if (typeof body !== "string") {
      fail(`${label}: the chain calls "${node.script}", which no script defines`);
      continue;
    }
    reached.add(key);
    for (const invocation of npmInvocations(body)) {
      if (invocation.all) {
        // `--workspaces` runs the script in every workspace that declares it.
        for (const pkg of packages) {
          if (typeof pkg.scripts[invocation.script] === "string") {
            queue.push({ dir: pkg.dir, script: invocation.script });
          }
        }
        continue;
      }
      if (invocation.targets.length === 0) {
        queue.push({ dir: node.dir, script: invocation.script });
        continue;
      }
      for (const spec of invocation.targets) {
        const target = resolveWorkspace(spec, packages);
        if (!target) {
          fail(`${label}: "${node.script}" runs in workspace "${spec}", which is no package here`);
          continue;
        }
        queue.push({ dir: target.dir, script: invocation.script });
      }
    }
  }
  return reached;
}

// ── The counted population ──────────────────────────────────────────────────

/** The runner this check sits beside: a bench tree carries the check alone. */
const RUNNER = join(__dirname, "run-tests.mjs");
/** Where that runner walks, so a path `--list` prints can be read back. */
const TEST_TREE = resolve(__dirname, "..", "test", "runtime");
/** The tree's declaration of the modules in it that are not fixtures. */
const MANIFEST = join(TEST_TREE, "fixture-manifest.json");
/** That declaration as a reader retypes it: relative to the repository root. */
const MANIFEST_LABEL = relative(root, MANIFEST);

const CASE_MODULES = new Set(["node:test"]);
const ASSERT_MODULES = new Set(["node:assert", "node:assert/strict"]);

let parser = null;

/**
 * TypeScript's parser, resolved from this file's own tree on first use.
 *
 * Not imported at the top for two reasons: the check runs before the build, and
 * a copy of this script in a bench may have no parser to resolve. The
 * population half only runs where the tree carries the core runner, which no
 * bench does unless it is testing this half - and that bench links a parser in.
 */
function typescript() {
  if (parser === null) parser = createRequire(import.meta.url)("typescript");
  return parser;
}

/** The line a call sits on, 1-indexed, for a report a reader can open. */
function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** True when the node runs when a function is called rather than when it loads. */
function insideFunction(ts, node) {
  for (let up = node.parent; up; up = up.parent) {
    if (
      ts.isFunctionDeclaration(up) ||
      ts.isFunctionExpression(up) ||
      ts.isArrowFunction(up) ||
      ts.isMethodDeclaration(up) ||
      ts.isConstructorDeclaration(up) ||
      ts.isGetAccessorDeclaration(up) ||
      ts.isSetAccessorDeclaration(up)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True for a call behind a CLI entry guard - `if (process.argv[1] &&
 * import.meta.url === ...)`. That branch is what the module does when it is run
 * as a program, not what the run loads when it counts the module as a fixture.
 */
function behindEntryGuard(ts, node) {
  for (let up = node.parent; up; up = up.parent) {
    if (!ts.isIfStatement(up)) continue;
    const test = up.expression.getText();
    if (test.includes("import.meta") && test.includes("process.argv")) return true;
  }
  return false;
}

/**
 * What a module does when it is loaded, read from its own source.
 *
 * The bindings are resolved from the module's ESM imports rather than by
 * spelling, so an assertion imported as `strict as check` is still an
 * assertion, and a call is one of the three shapes only at module scope: a
 * helper that asserts inside a function nobody calls asserts nothing for the
 * run that loads it.
 */
function classifyModule(file, text) {
  const ts = typescript();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const binding = new Map(); // local name -> "case" | "assert"
  const declared = new Set(); // functions this module declares by name
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declared.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || !init) continue;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          declared.add(declaration.name.text);
        }
      }
    }
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = statement.moduleSpecifier.text;
    const kind = CASE_MODULES.has(specifier)
      ? "case"
      : ASSERT_MODULES.has(specifier)
        ? "assert"
        : null;
    if (kind === null) continue;
    const clause = statement.importClause;
    if (clause.name) binding.set(clause.name.text, kind);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) binding.set(named.name.text, kind);
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) binding.set(element.name.text, kind);
    }
  }

  const first = { case: null, assert: null, driver: null };
  const visit = (node) => {
    if (ts.isCallExpression(node) && !insideFunction(ts, node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression)
          ? node.expression.expression.text
          : null;
      const kind = callee === null ? null : binding.get(callee);
      if (kind !== undefined) first[kind] ??= lineOf(source, node);
      else if (callee !== null && declared.has(callee) && !behindEntryGuard(ts, node)) {
        first.driver ??= lineOf(source, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (first.case !== null) {
    return { verdict: "case", note: `registers a case with node:test at line ${first.case}` };
  }
  if (first.assert !== null) {
    return { verdict: "assert", note: `asserts with node:assert at line ${first.assert}` };
  }
  if (first.driver !== null) {
    return { verdict: "driver", note: `calls a function it declares at line ${first.driver}` };
  }
  return {
    verdict: "neither",
    note:
      "registers no case with node:test, asserts nothing from node:assert at module scope, " +
      "and calls no function it declares",
  };
}

/**
 * Classify a module `--list` printed, or report it and return null when the
 * tree it names cannot be read: a path the runner walks and the check cannot
 * open is a disagreement about where the tree is, not a verdict on the module.
 */
function classifyListed(file) {
  const path = join(TEST_TREE, file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(`${file}: the runner lists this module, but ${path} cannot be read (${error.code})`);
    return null;
  }
  return classifyModule(path, text);
}

/**
 * Judge the population the core runner counts.
 *
 * The runner is spawned, not read: `--list` is the runner's own answer to which
 * files this run is over, so the walk, the declaration in the tree, and the
 * coordinate a path is stated in are all the runner's single copy. Returns the
 * two counts to report, or null where the tree carries no core runner.
 */
function auditPopulation() {
  if (!existsSync(RUNNER)) return null;
  const run = spawnSync(process.execPath, [RUNNER, "--list"], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, PI_TEST_ROOT: "", PI_TEST_JOBS: "" },
  });
  if (run.status !== 0) {
    const why = (run.stderr ?? "").trim() || run.error?.message || "no output";
    fail(`${RUNNER} --list exited ${run.status ?? run.signal}, so the population is unread: ${why}`);
    return null;
  }
  const counted = [];
  const declared = [];
  for (const line of (run.stdout ?? "").split("\n")) {
    if (line === "") continue;
    const [kind, file, reason = ""] = line.split("\t");
    if (kind === "counted") counted.push(file);
    else if (kind === "skipped") declared.push({ file, reason, present: true });
    else if (kind === "absent") declared.push({ file, reason, present: false });
    else fail(`${RUNNER} --list printed a line this check cannot read: ${JSON.stringify(line)}`);
  }

  for (const file of counted) {
    const shape = classifyListed(file); // null: unreadable, already reported
    if (shape === null || shape.verdict !== "neither") continue;
    fail(
      `${file}: counted as a passed fixture, but the module ${shape.note}, so the run counts a ` +
        `pass that cannot fail. Make it a fixture, or state in ${MANIFEST_LABEL} why it is not one`,
    );
  }
  for (const entry of declared) {
    if (entry.reason.trim() === "") {
      fail(`${entry.file}: declared a non-fixture with no reason stated, in ${MANIFEST_LABEL}`);
    }
    if (!entry.present) {
      fail(`${entry.file}: declared a non-fixture in ${MANIFEST_LABEL}, but the walked tree carries no such module`);
      continue;
    }
    const shape = classifyListed(entry.file);
    if (shape !== null && shape.verdict !== "neither") {
      fail(
        `${entry.file}: declared a non-fixture, but the module ${shape.note}, so the declaration ` +
          `keeps a real test out of the run`,
      );
    }
  }
  return { counted: counted.length, declared: declared.length };
}

// ── Report ──────────────────────────────────────────────────────────────────

function report(declaring, reached, population) {
  if (problems.length > 0) {
    console.error(`check-suite-coverage: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const reachedList = declaring
    .filter((pkg) => reached.has(`${pkg.dir}#test`))
    .map((pkg) => pkg.dir);
  console.log(
    `check-suite-coverage: clean (${declaring.length} package(s) declare a "test" script, ` +
      `all reached from ${CHAIN}: ${reachedList.join(", ")})`,
  );
  if (population) {
    console.log(
      `  population: ${population.counted} module(s) counted by the runner, ` +
        `${population.declared} declared a non-fixture in ${MANIFEST_LABEL}`,
    );
  }
}

const rootManifest = readJson(join(root, "package.json"));
const packages = discoverPackages();
const declaring = packages.filter((pkg) => typeof pkg.scripts.test === "string");
const reached = reachableFrom(packages, rootManifest ?? {});

for (const pkg of declaring) {
  if (!reached.has(`${pkg.dir}#test`)) {
    fail(
      `${pkg.dir}${pkg.name ? ` (${pkg.name})` : ""}: declares a "test" script that ` +
        `${CHAIN} never reaches, so its suite cannot fail the gate`,
    );
  }
}

report(declaring, reached, auditPopulation());
