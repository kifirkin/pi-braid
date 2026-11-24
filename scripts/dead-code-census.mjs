#!/usr/bin/env node
/**
 * Dead-code census for the braid package family.
 *
 * Every number in docs/DEAD-CODE-AUDIT-2026-11-24.md comes from this script.
 *
 *   node scripts/dead-code-census.mjs           # report-shaped tables
 *   node scripts/dead-code-census.mjs --json    # machine-readable
 *   node scripts/dead-code-census.mjs --why PATH  # entry-path explanation for one file
 *
 * Why it is not knip: knip's "unused files" mixes three different things, and
 * its "unused exports" is dominated by the `export` keyword sitting on symbols
 * a file already uses itself. Bucket 4 of the brief (PUBLIC-BUT-UNCALLED) is
 * invisible to knip entirely because it is not a reachability question.
 *
 * The instrument is TypeScript's own resolver: one program over every
 * production .ts file in the five workspaces, edges resolved with
 * ts.resolveModuleName, plus a syntactic pass over .mjs test/script harnesses.
 *
 * Entry points are read from package.json (`pi.extensions`, `main`, `exports`,
 * `bin`) and from test/script directories. Nothing else is an entry: that is
 * the whole point, because "reachable from a test" is the bucket the brief
 * asks to keep separate.
 *
 * Test harnesses in this repo load the BUILT tree (`join(DIST, "lib", ...)`),
 * not source, so a plain import graph cannot see their edges. The .mjs pass
 * recovers those by concatenating runs of literal path segments out of
 * join()/resolve() calls and mapping dist/ back onto src/. Edges it cannot
 * recover are counted and listed rather than silently dropped.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, dirname, resolve as presolve, sep } from "node:path";
import ts from "typescript";

const ROOT = presolve(import.meta.dirname, "..");
const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes("--json");
const WHY = ARGV.includes("--why") ? ARGV[ARGV.indexOf("--why") + 1] : null;

const WORKSPACES = [
  "packages/core",
  "packages/skills",
  "packages/contrib",
  "packages/providers",
  "packages/telegram",
];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  "fixtures",
]);

const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

// ─── file discovery ─────────────────────────────────────────────────────────

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

const isTestPath = (p) =>
  /(^|\/)test\//.test(p) || /\.test\.[cm]?[jt]s$/.test(p);
const isScriptPath = (p) => /(^|\/)scripts\//.test(p) && /\.m?js$/.test(p);

function lineCount(file) {
  const text = readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}

function packageAt(dir) {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

// ─── entries ────────────────────────────────────────────────────────────────

/** dist/main/exports targets are build output; the source is what we measure. */
function distToSrc(wsDir, target) {
  const t = target.replace(/^\.\//, "");
  const candidates = [];
  if (t.startsWith("dist/")) candidates.push(join(wsDir, "src", t.slice(5)));
  else candidates.push(join(wsDir, t));
  for (const c of candidates) {
    const asTs = c.replace(/\.js$/, ".ts");
    if (existsSync(asTs)) return asTs;
    if (existsSync(c)) return c;
  }
  return null;
}

function collectEntries(wsDir) {
  const pkg = packageAt(wsDir);
  const prod = [];
  const api = [];
  const paths = {};
  if (pkg) {
    for (const e of pkg.pi?.extensions ?? []) {
      const s = distToSrc(wsDir, e);
      if (s) prod.push(s);
    }
    if (pkg.main) {
      const s = distToSrc(wsDir, pkg.main);
      if (s) {
        prod.push(s);
        api.push(s);
      }
    }
    if (typeof pkg.exports === "string") {
      const s = distToSrc(wsDir, pkg.exports);
      if (s) {
        prod.push(s);
        api.push(s);
      }
    } else if (pkg.exports && typeof pkg.exports === "object") {
      for (const [sub, target] of Object.entries(pkg.exports)) {
        const one =
          typeof target === "string"
            ? target
            : (target?.import ?? target?.default);
        if (!one) continue;
        const s = distToSrc(wsDir, one);
        if (s) {
          prod.push(s);
          api.push(s);
          const spec =
            sub === "." ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, "")}`;
          paths[spec] = [s];
        }
      }
    }
    for (const b of Object.values(pkg.bin ?? {})) {
      const s = distToSrc(wsDir, b);
      if (s) prod.push(s);
    }
  }
  return { prod: [...new Set(prod)], api: [...new Set(api)], paths };
}

/** files named as a command in any package.json `scripts` value: a declared entry */
function collectCommandRoots() {
  const out = [];
  const pkgs = [
    join(ROOT, "package.json"),
    ...WORKSPACES.map((w) => join(ROOT, w, "package.json")),
  ];
  for (const p of pkgs) {
    if (!existsSync(p)) continue;
    const dir = dirname(p);
    const scripts = packageAt(dir)?.scripts ?? {};
    for (const cmd of Object.values(scripts)) {
      if (typeof cmd !== "string") continue;
      for (const token of cmd.split(/[\s&&|;]+/)) {
        const clean = token.replace(/^['"]|['"]$/g, "");
        if (!/\.(mjs|ts|js|cjs)$/.test(clean)) continue;
        const abs = join(dir, clean);
        if (existsSync(abs)) out.push(abs);
      }
    }
  }
  return [...new Set(out)];
}

const wsDirs = WORKSPACES.map((w) => join(ROOT, w));
const entriesInfo = wsDirs.map((d) => ({ dir: d, ...collectEntries(d) }));
const PROD_ENTRIES = [...new Set(entriesInfo.flatMap((e) => e.prod))];
const API_ENTRIES = [...new Set(entriesInfo.flatMap((e) => e.api))];
const WS_PATH_MAP = Object.assign({}, ...entriesInfo.map((e) => e.paths));

// ─── resolver options ───────────────────────────────────────────────────────

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  baseUrl: ROOT,
  paths: WS_PATH_MAP,
  types: ["node"],
  allowJs: false,
};

const host = ts.createCompilerHost(compilerOptions, true);

function resolveSpec(spec, fromFile) {
  if (spec.startsWith("node:")) return null;
  const r = ts.resolveModuleName(
    spec,
    fromFile,
    compilerOptions,
    host,
  ).resolvedModule;
  if (!r) return null;
  const f = presolve(r.resolvedFileName);
  return f.includes("/node_modules/") ? null : f;
}

// ─── file inventory ─────────────────────────────────────────────────────────

const prodFiles = [];
const testFiles = [];
const scriptFiles = [];
const otherFiles = [];

for (const dir of wsDirs) {
  const pkg = packageAt(dir);
  const touchesTs = existsSync(join(dir, "tsconfig.json"));
  for (const f of walk(dir)) {
    if (!pkg) continue;
    const r = rel(f);
    if (/\.d\.ts$/.test(f)) {
      otherFiles.push(f);
      continue;
    }
    if (isTestPath(r)) {
      if (/\.(mjs|js|ts)$/.test(f)) testFiles.push(f);
      continue;
    }
    if (isScriptPath(r)) {
      scriptFiles.push(f);
      continue;
    }
    if (f.endsWith(".ts")) {
      // packages/skills is content-only; any stray .ts there is not a program root.
      if (touchesTs) prodFiles.push(f);
      else otherFiles.push(f);
      continue;
    }
    if (f.endsWith(".mjs")) scriptFiles.push(f);
  }
}

// Root-level scripts (repo convention: `scripts/*.mjs`; core's own checks live in
// packages/core/scripts and are already collected above).
const rootScriptsDir = join(ROOT, "scripts");
if (existsSync(rootScriptsDir)) {
  for (const f of walk(rootScriptsDir))
    if (/\.m?js$/.test(f)) scriptFiles.push(f);
}

const unique = (a) => [...new Set(a)];
const PROD = unique(prodFiles);
const TESTS = unique(testFiles);
const SCRIPTS = unique(scriptFiles);

// ─── production graph (TypeScript resolver) ─────────────────────────────────

const program = ts.createProgram({ rootNames: PROD, options: compilerOptions });
const checker = program.getTypeChecker();
const sfCache = new Map();
for (const sf of program.getSourceFiles())
  sfCache.set(presolve(sf.fileName), sf);

const edges = new Map(); // file -> Set<file>
const unresolvedDynamic = []; // { from, snippet, recoveredAs }

function addEdge(from, to) {
  if (!from || !to || from === to) return;
  if (!edges.has(from)) edges.set(from, new Set());
  edges.get(from).add(to);
}

function specifiersOf(sf) {
  const out = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) {
      const m = st.moduleSpecifier;
      if (m && ts.isStringLiteral(m)) out.push(m.text);
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if ((isImport || isRequire) && ts.isStringLiteral(node.arguments[0]))
        out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

for (const f of PROD) {
  const sf =
    sfCache.get(presolve(f)) ??
    ts.createSourceFile(
      f,
      readFileSync(f, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
  for (const spec of specifiersOf(sf)) {
    const to = resolveSpec(spec, f);
    if (to) addEdge(f, to);
  }
}

// ─── test/script graph (.mjs: syntactic, plus dist-path recovery) ───────────

/** try to land a path literal inside a workspace source tree */
function candidatesFor(fromFile, literal) {
  const out = [];
  let cleaned = literal.replace(/^\.\//, "");
  // `../../dist/x.js` and `dist/x.js` both name the build tree; the subject is
  // the source that produced it.
  cleaned = cleaned.replace(/^(\.\.\/)+/, "");
  if (/^(dist|src)\//.test(cleaned))
    cleaned = cleaned.replace(/^(dist|src)\//, "");

  const direct = presolve(dirname(fromFile), literal);
  for (const ext of ["", ".ts", ".js", ".mjs", ".tsx"]) {
    if (existsSync(direct + ext)) out.push(presolve(direct + ext));
  }
  if (/\.js$/.test(direct) && existsSync(direct.replace(/\.js$/, ".ts")))
    out.push(direct.replace(/\.js$/, ".ts"));
  for (const idx of ["index.ts", "index.js", "index.mjs"]) {
    if (existsSync(join(direct, idx))) out.push(join(direct, idx));
  }

  for (const dir of wsDirs) {
    if (!fromFile.startsWith(dir + sep)) continue;
    const asTs = cleaned.replace(/\.js$/, ".ts");
    for (const cand of [
      join(dir, "src", asTs),
      join(dir, asTs),
      join(dir, "src", cleaned),
      join(dir, cleaned),
    ]) {
      if (existsSync(cand) && !cand.includes("/node_modules/")) out.push(cand);
    }
  }
  // repo-relative literal (a check script naming a path it audits)
  const fromRoot = join(ROOT, cleaned);
  if (existsSync(fromRoot) && !fromRoot.includes("/node_modules/"))
    out.push(fromRoot);
  // `..` from a workspace root is the packages/ directory: cross-workspace
  // imports in harnesses are written that way (join(ROOT, "..", "contrib", ...)).
  const fromPackages = join(ROOT, "packages", cleaned);
  if (existsSync(fromPackages) && !fromPackages.includes("/node_modules/"))
    out.push(fromPackages);
  return [...new Set(out.filter((p) => !p.includes("/node_modules/")))];
}

const recovery = {
  import: 0,
  dynamicLiteral: 0,
  distPathRun: 0,
  pathLiteral: 0,
};

function stringRunLiterals(call) {
  // `join(DIST, "lib", "x.js")` -> "lib/x.js". A single literal beside a
  // computed segment is still a built path: `join(pkgRoot, "x.ts")`.
  const runs = [];
  let cur = [];
  let hasNonLiteral = false;
  for (const a of call.arguments) {
    if (ts.isStringLiteral(a)) cur.push(a.text);
    else {
      hasNonLiteral = true;
      if (cur.length) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  const joined = call.arguments
    .filter((a) => ts.isStringLiteral(a))
    .map((a) => a.text);
  if (joined.length > 1) runs.push(joined);
  return runs.filter(
    (r) =>
      r.length > 1 ||
      r[0].includes("/") ||
      (hasNonLiteral && r[0].includes(".")),
  );
}

for (const f of [...TESTS, ...SCRIPTS]) {
  const text = readFileSync(f, "utf8");
  const kind = f.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kind);
  const literals = [];
  const barePathLiterals = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const m = node.moduleSpecifier;
      if (m && ts.isStringLiteral(m))
        literals.push({ spec: m.text, kind: "import" });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const first = node.arguments[0];
      if (
        (isImport || name === "require") &&
        first &&
        ts.isStringLiteral(first)
      ) {
        literals.push({ spec: first.text, kind: "dynamicLiteral" });
      } else if (name === "join" || name === "resolve") {
        for (const run of stringRunLiterals(node))
          literals.push({ spec: run.join("/"), kind: "distPathRun" });
      }
    }
    if (
      ts.isStringLiteral(node) &&
      /\.(ts|js)$/.test(node.text) &&
      !node.text.startsWith(".")
    ) {
      barePathLiterals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const { spec, kind: how } of literals) {
    const mapped = WS_PATH_MAP[spec];
    if (mapped) {
      for (const m of mapped) addEdge(f, m);
      recovery[how]++;
      continue;
    }
    const landed = candidatesFor(f, spec);
    if (landed.length) {
      for (const l of landed) addEdge(f, l);
      recovery[how]++;
    } else if (how !== "import" && /\.(ts|js|mjs|cjs)$/.test(spec)) {
      // Only module-shaped paths are a blind spot. A temp-dir name from
      // join(tmpdir(), "x-") is not a module nobody can see, it is not a module.
      unresolvedDynamic.push({ from: rel(f), snippet: spec, how });
    }
  }

  // Last recovery class: a path literal that names an existing file. No
  // basename guessing: a bare basename is not a module reference, it is a
  // string some table happens to carry.
  for (const lit of new Set(barePathLiterals)) {
    if (!lit.includes("/")) continue;
    const landed = candidatesFor(f, lit);
    if (landed.length) {
      for (const l of landed) addEdge(f, l);
      recovery.pathLiteral++;
    }
  }
}

// ─── reachability ───────────────────────────────────────────────────────────

function bfs(roots) {
  const seen = new Set();
  const queue = [...roots];
  const parent = new Map();
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) {
      if (seen.has(next)) continue;
      if (!parent.has(next)) parent.set(next, cur);
      queue.push(next);
    }
  }
  return { seen, parent };
}

const inRepo = (p) =>
  p && p.startsWith(ROOT + sep) && !p.includes("/node_modules/");
const prodRoots = PROD_ENTRIES.filter(inRepo);
// A file named in a package.json script is a declared entry too, but it is a
// developer command, so it and everything it reaches belong to the harness side.
const commandRoots = collectCommandRoots().filter(inRepo);
const testRoots = unique([...TESTS, ...SCRIPTS, ...commandRoots]).filter(
  inRepo,
);

const prod = bfs(prodRoots);
const all = bfs([...prodRoots, ...testRoots]);
const reachableProd = new Set([...prod.seen].filter(inRepo));
const reachableAll = new Set([...all.seen].filter(inRepo));

// importers index
const importers = new Map();
for (const [from, tos] of edges)
  for (const to of tos) {
    if (!importers.has(to)) importers.set(to, new Set());
    importers.get(to).add(from);
  }

// ─── symbol analysis over the production program ────────────────────────────

const prodImports = new Map(); // file -> Set(name | "*")
const harnessImports = new Map();
const recordInto = (map, file, name) => {
  if (!file) return;
  if (!map.has(file)) map.set(file, new Set());
  map.get(file).add(name);
};

for (const f of PROD) {
  const sf = sfCache.get(presolve(f));
  if (!sf) continue;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const target = resolveSpec(st.moduleSpecifier.text, f);
      if (!target) continue;
      const clause = st.importClause;
      if (clause.name) recordInto(prodImports, target, "default");
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) recordInto(prodImports, target, "*");
      else if (nb)
        for (const s of nb.elements)
          recordInto(prodImports, target, (s.propertyName ?? s.name).text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      const target = resolveSpec(st.moduleSpecifier.text, f);
      if (!target) continue;
      if (!st.exportClause) recordInto(prodImports, target, "*");
      else if (ts.isNamespaceExport(st.exportClause))
        recordInto(prodImports, target, "*");
      else
        for (const s of st.exportClause.elements)
          recordInto(prodImports, target, (s.propertyName ?? s.name).text);
    }
  }
}
for (const f of [...TESTS, ...SCRIPTS]) {
  const text = readFileSync(f, "utf8");
  const sf = ts.createSourceFile(
    f,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const landFor = (spec) =>
    spec.startsWith(".") || !WS_PATH_MAP[spec]
      ? candidatesFor(f, spec)
      : WS_PATH_MAP[spec];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const clause = st.importClause;
    for (const t of landFor(st.moduleSpecifier.text) ?? []) {
      if (clause.name) recordInto(harnessImports, t, "default");
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) recordInto(harnessImports, t, "*");
      else if (nb)
        for (const e of nb.elements)
          recordInto(harnessImports, t, (e.propertyName ?? e.name).text);
    }
  }
  // `const { a, b } = await import(join(DIST, ...))` — the house style for
  // loading built output. Record the destructured names as imports.
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      let call = node.initializer;
      if (ts.isAwaitExpression(call)) call = call.expression;
      if (
        ts.isCallExpression(call) &&
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        call.arguments[0] &&
        ts.isStringLiteral(call.arguments[0])
      ) {
        const landed = candidatesFor(f, call.arguments[0].text);
        for (const t of landed) {
          for (const el of node.name.elements)
            recordInto(
              harnessImports,
              t,
              (el.propertyName ?? el.name).getText(sf),
            );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** exported symbols of a file, with their declaration span */
function exportsOf(file) {
  const sf = sfCache.get(presolve(file));
  if (!sf) return [];
  const modSymbol = checker.getSymbolAtLocation(sf);
  if (!modSymbol) return [];
  const out = [];
  for (const s of checker.getExportsOfModule(modSymbol)) {
    const decls = s.getDeclarations() ?? [];
    let start = 0;
    let end = 0;
    for (const d of decls) {
      start = d.getStart(sf);
      end = d.getEnd();
      break;
    }
    const name = s.getName();
    out.push({
      name,
      file,
      line: sf.getLineAndCharacterOfPosition(start).line + 1,
      loc: Math.max(
        1,
        sf.getLineAndCharacterOfPosition(end).line -
          sf.getLineAndCharacterOfPosition(start).line +
          1,
      ),
    });
  }
  return out;
}

const ENTRY_SET = new Set(prodRoots.map((p) => presolve(p)));
const API_SET = new Set(API_ENTRIES.map((p) => presolve(p)));

// own-file reference counts, one checker pass per file that has candidates
function ownFileRefs(file, wantedNames) {
  const sf = sfCache.get(presolve(file));
  if (!sf) return new Map();
  const counts = new Map();
  const targetNames = new Set(wantedNames);
  const visit = (node) => {
    if (ts.isIdentifier(node) && targetNames.has(node.text)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) counts.set(sym.getName(), (counts.get(sym.getName()) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

const deadExports = []; // export keyword sits on a symbol nothing imports, used in-file
const deadSymbols = []; // symbol referenced nowhere at all
const publicUncalled = []; // declared package API with no internal caller
const testHooks = []; // exported, imported only by a test/script harness

for (const f of PROD) {
  if (!reachableProd.has(presolve(f))) continue;
  const exps = exportsOf(f);
  if (!exps.length) continue;
  const byProd = prodImports.get(presolve(f)) ?? new Set();
  const byHarness = harnessImports.get(presolve(f)) ?? new Set();
  const isApi = API_SET.has(presolve(f));
  const isEntry = ENTRY_SET.has(presolve(f));
  const candidates = exps.filter(
    (e) => !(byProd.has("*") || byProd.has(e.name)),
  );
  if (!candidates.length) continue;
  const counts = ownFileRefs(
    f,
    candidates.map((e) => e.name),
  );
  for (const e of candidates) {
    const row = { ...e, ownRefs: (counts.get(e.name) ?? 0) - 1 };
    if (isApi) {
      publicUncalled.push(row);
      continue;
    }
    // An extension entry's default export is the handle the harness takes by
    // name; the loader is the caller, not an import statement.
    if (isEntry && (e.name === "default" || e.name === "*default*")) continue;
    if (byHarness.has("*") || byHarness.has(e.name)) {
      testHooks.push(row);
      continue;
    }
    if (row.ownRefs > 0) deadExports.push(row);
    else deadSymbols.push(row);
  }
}

// ─── buckets ────────────────────────────────────────────────────────────────

// Production code only. Test and script harnesses are the instrument, not the
// subject: counting them as TEST-ONLY files would report 200k LOC of tests as
// a finding and bury the production number that matters.
const measured = unique(PROD).map((f) => ({
  abs: presolve(f),
  rel: rel(f),
  loc: lineCount(f),
}));
const harness = unique([...TESTS, ...SCRIPTS]).map((f) => ({
  abs: presolve(f),
  rel: rel(f),
  loc: lineCount(f),
}));

const commandSet = new Set(commandRoots.map((p) => presolve(p)));

const buckets = { unreachable: [], testOnly: [], transitive: [], live: [] };

for (const f of measured) {
  if (reachableProd.has(f.abs)) {
    buckets.live.push(f);
    continue;
  }
  if (reachableAll.has(f.abs)) {
    const via = [...(importers.get(f.abs) ?? [])]
      .map(rel)
      .filter(
        (p) => isTestPath(p) || isScriptPath(p) || p.startsWith("scripts/"),
      );
    if (commandSet.has(f.abs))
      via.unshift("(declared command in a package.json script)");
    buckets.testOnly.push({ ...f, via });
    continue;
  }
  const imps = [...(importers.get(f.abs) ?? [])].map((p) => p);
  const deadImps = imps.filter(
    (p) => !reachableAll.has(p) && !reachableProd.has(p),
  );
  if (imps.length === 0) buckets.unreachable.push({ ...f, importers: [] });
  else
    buckets.transitive.push({
      ...f,
      importers: imps.map(rel),
      deadImporters: deadImps.map(rel),
    });
}

const wsOf = (p) =>
  WORKSPACES.find((w) => p === w || p.startsWith(w + "/")) ?? "scripts/";
const wsTotal = new Map();
for (const w of WORKSPACES) wsTotal.set(w, { files: 0, loc: 0 });
wsTotal.set("scripts/", { files: 0, loc: 0 });
for (const f of measured) {
  const w = wsOf(f.rel);
  const t = wsTotal.get(w);
  t.files++;
  t.loc += f.loc;
}
const wsBucket = new Map();
const bump = (w, bucket, f) => {
  if (!wsBucket.has(w))
    wsBucket.set(w, { unreachable: 0, testOnly: 0, transitive: 0 });
  wsBucket.get(w)[bucket] += f.loc;
};
for (const f of buckets.unreachable) bump(wsOf(f.rel), "unreachable", f);
for (const f of buckets.testOnly) bump(wsOf(f.rel), "testOnly", f);
for (const f of buckets.transitive) bump(wsOf(f.rel), "transitive", f);

const wsSymbols = new Map();
const symBump = (w, k) => {
  if (!wsSymbols.has(w))
    wsSymbols.set(w, {
      publicUncalled: 0,
      publicUncalledLoc: 0,
      deadExportKeyword: 0,
      deadSymbols: 0,
      testHooks: 0,
    });
  wsSymbols.get(w)[k]++;
};
for (const e of publicUncalled) {
  symBump(wsOf(rel(e.file)), "publicUncalled");
  wsSymbols.get(wsOf(rel(e.file))).publicUncalledLoc += e.loc;
}
for (const e of deadExports) symBump(wsOf(rel(e.file)), "deadExportKeyword");
for (const e of deadSymbols) symBump(wsOf(rel(e.file)), "deadSymbols");
for (const e of testHooks) symBump(wsOf(rel(e.file)), "testHooks");

const pubLoc = publicUncalled.reduce((a, e) => a + e.loc, 0);

// ─── output ─────────────────────────────────────────────────────────────────

const rev = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
})();

const payload = {
  revision: rev,
  generatedFor: "docs/DEAD-CODE-AUDIT-2026-11-24.md",
  entries: { prod: prodRoots.map(rel), test: testRoots.length },
  totals: {
    files: measured.length,
    loc: measured.reduce((a, f) => a + f.loc, 0),
    prodFiles: PROD.length,
    testFiles: TESTS.length,
    scriptFiles: SCRIPTS.length,
    harnessFiles: harness.length,
    harnessLoc: harness.reduce((a, f) => a + f.loc, 0),
  },
  buckets: {
    unreachable: {
      files: buckets.unreachable.length,
      loc: buckets.unreachable.reduce((a, f) => a + f.loc, 0),
    },
    testOnly: {
      files: buckets.testOnly.length,
      loc: buckets.testOnly.reduce((a, f) => a + f.loc, 0),
    },
    transitive: {
      files: buckets.transitive.length,
      loc: buckets.transitive.reduce((a, f) => a + f.loc, 0),
    },
  },
  publicUncalled: { symbols: publicUncalled.length, loc: pubLoc },
  testHooks: {
    symbols: testHooks.length,
    loc: testHooks.reduce((a, e) => a + e.loc, 0),
  },
  exportHygiene: {
    deadExportKeyword: deadExports.length,
    deadSymbols: deadSymbols.length,
  },
  dynamicUnresolved: unresolvedDynamic.length,
  recovery,
  perWorkspace: {},
  detail: buckets,
  symbols: { publicUncalled, deadExports, deadSymbols, testHooks },
  unresolvedDynamic,
};

for (const [w, t] of wsTotal) {
  const b = wsBucket.get(w) ?? { unreachable: 0, testOnly: 0, transitive: 0 };
  const dead = b.unreachable + b.testOnly + b.transitive;
  payload.perWorkspace[w] = {
    ...t,
    ...b,
    dead,
    deadPct: t.loc ? +((dead / t.loc) * 100).toFixed(2) : 0,
    symbols: wsSymbols.get(w) ?? {},
  };
}

if (WHY) {
  const target = presolve(WHY.startsWith("/") ? WHY : join(ROOT, WHY));
  const chain = [];
  let cur = target;
  const parent = all.parent;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(rel(cur));
    cur = parent.get(cur);
  }
  const inProd = reachableProd.has(target);
  const inAll = reachableAll.has(target);
  console.log(`\n${rel(target)}`);
  console.log(`  loc: ${existsSync(target) ? lineCount(target) : "n/a"}`);
  console.log(`  prod-reachable: ${inProd}   test/script-reachable: ${inAll}`);
  console.log(
    `  importers: ${[...(importers.get(target) ?? [])].map(rel).join(", ") || "(none)"}`,
  );
  console.log(`  path from entry: ${inAll ? chain.join(" -> ") : "(none)"}`);
  process.exit(0);
}

if (JSON_OUT) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "0.0");

const out = [];
out.push(
  `braid dead-code census   rev ${rev}   entries: ${prodRoots.length} prod, ${testRoots.length} test/script`,
);
out.push("");
out.push(
  `${pad("workspace", 20)}${lpad("files", 7)}${lpad("LOC", 9)}${lpad("UNREACH", 9)}${lpad("TEST-ONLY", 11)}${lpad("TRANS-DEAD", 12)}${lpad("dead", 8)}${lpad("dead%", 7)}`,
);
for (const [w, t] of wsTotal) {
  const p = payload.perWorkspace[w];
  out.push(
    pad(w, 20) +
      lpad(t.files, 7) +
      lpad(t.loc, 9) +
      lpad(p.unreachable, 9) +
      lpad(p.testOnly, 11) +
      lpad(p.transitive, 12) +
      lpad(p.dead, 8) +
      lpad(p.deadPct + "%", 7),
  );
}
const T = payload.totals;
const B = payload.buckets;
out.push(
  pad("TOTAL", 20) +
    lpad(T.files, 7) +
    lpad(T.loc, 9) +
    lpad(B.unreachable.loc, 9) +
    lpad(B.testOnly.loc, 11) +
    lpad(B.transitive.loc, 12) +
    lpad(B.unreachable.loc + B.testOnly.loc + B.transitive.loc, 8) +
    lpad(
      pct(B.unreachable.loc + B.testOnly.loc + B.transitive.loc, T.loc) + "%",
      7,
    ),
);
out.push("");
out.push(
  `PUBLIC-BUT-UNCALLED (not dead, maintenance surface): ${publicUncalled.length} symbols, ${pubLoc} LOC`,
);
out.push(
  `test-hook exports (imported by a harness only, alive for tests): ${testHooks.length} symbols`,
);
out.push(
  `dead \`export\` keyword inside live files: ${deadExports.length} symbols`,
);
out.push(
  `symbols referenced nowhere at all inside live files: ${deadSymbols.length}`,
);
out.push(
  `test/script harness files (measured, not bucketed): ${harness.length} files, ${harness.reduce((a, f) => a + f.loc, 0)} LOC`,
);
out.push(`harness edges recovered: ${JSON.stringify(recovery)}`);
out.push(
  `dynamic edges the .mjs pass could not resolve: ${unresolvedDynamic.length}`,
);
out.push("");
out.push("symbol findings by workspace");
for (const w of [...WORKSPACES, "scripts/"]) {
  const s = wsSymbols.get(w);
  if (!s) continue;
  out.push(
    `  ${pad(w, 20)} public-uncalled ${lpad(s.publicUncalled, 4)} (${s.publicUncalledLoc} LOC)   test-hooks ${lpad(s.testHooks, 4)}   dead-export-keyword ${lpad(s.deadExportKeyword, 4)}   never-referenced ${lpad(s.deadSymbols, 3)}`,
  );
}
out.push("");

const section = (title, rows, render) => {
  out.push(
    `${title} (${rows.length} files, ${rows.reduce((a, f) => a + f.loc, 0)} LOC)`,
  );
  if (!rows.length) out.push("  (none)");
  for (const f of rows.sort((a, b) => b.loc - a.loc))
    out.push("  " + render(f));
  out.push("");
};

section(
  "UNREACHABLE - no importer anywhere",
  buckets.unreachable,
  (f) => `${lpad(f.loc, 5)}  ${f.rel}`,
);
section(
  "TEST-ONLY - reachable only from test/script harnesses",
  buckets.testOnly,
  (f) => `${lpad(f.loc, 5)}  ${f.rel}   <- ${f.via.join(", ")}`,
);
section(
  "TRANSITIVELY DEAD - only dead parents import it",
  buckets.transitive,
  (f) => `${lpad(f.loc, 5)}  ${f.rel}   <- ${f.deadImporters.join(", ")}`,
);

out.push(
  `PUBLIC-BUT-UNCALLED line items (${publicUncalled.length} symbols, ${pubLoc} LOC)`,
);
if (!publicUncalled.length) out.push("  (none)");
for (const e of publicUncalled.sort(
  (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
)) {
  out.push(`  ${lpad(e.loc, 4)}  ${rel(e.file)}:${e.line}  ${e.name}`);
}
out.push("");
out.push(
  `dead \`export\` keyword, symbol used only inside its own file (${deadExports.length})`,
);
for (const e of deadExports.sort((a, b) => b.loc - a.loc).slice(0, 40)) {
  out.push(
    `  ${rel(e.file)}:${e.line}  ${e.name}  (own-file refs: ${e.ownRefs})`,
  );
}
if (deadExports.length > 40) out.push(`  ... ${deadExports.length - 40} more`);
out.push("");
out.push(`symbols referenced nowhere at all (${deadSymbols.length})`);
for (const e of deadSymbols.sort((a, b) => b.loc - a.loc))
  out.push(`  ${lpad(e.loc, 4)}  ${rel(e.file)}:${e.line}  ${e.name}`);
out.push("");
if (unresolvedDynamic.length) {
  out.push(`dynamic edges not resolved (${unresolvedDynamic.length})`);
  for (const d of unresolvedDynamic) out.push(`  ${d.from}  ::  ${d.snippet}`);
  out.push("");
}

console.log(out.join("\n"));
