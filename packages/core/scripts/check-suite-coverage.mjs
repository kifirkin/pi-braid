/**
 * Every workspace package's test script must be reachable from `ci:check`.
 *
 * A package's own `test` script is the single source of truth for the files
 * that package runs, so a suite no step of `ci:check` invokes is a suite that
 * can never fail the gate. The packages are discovered, never listed: every
 * `packages/<dir>/package.json` that declares a `test` script must be
 * reachable from the root `ci:check` script, where reachable follows the same
 * npm script indirection the chain itself uses — `npm test`, `npm run
 * <name>`, `-w <workspace>` given as a directory path or as a package name,
 * and `--workspaces`.
 *
 * Exit code 0 prints a one-line summary; exit code 1 names every declaring
 * package the chain never reaches.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// ── Report ──────────────────────────────────────────────────────────────────

function report(declaring, reached) {
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

report(declaring, reached);
