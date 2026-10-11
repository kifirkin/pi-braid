/**
 * fixture-guard.mjs: refuse a verdict that came from a fixture which cannot run.
 *
 * The failure mode (observed): a mutation run reported RED and the red was read
 * as "the assertion caught the mutant", but the mutant did not compile. The run
 * had failed for a reason that says nothing about the assertion, and the
 * mistake only surfaces when someone spends an hour trying to explain why the
 * mutant's behaviour changed at all.
 *
 * The shape recurs wherever a harness builds a fixture at runtime (a mutated
 * copy of a source file, a planted file, a synthetic test file) and reads its
 * verdict out of an exit status: a fixture that cannot parse exits non-zero,
 * which is exactly the status an honest RED produces. Nothing in the exit
 * status distinguishes "the mutant was caught" from "the mutant never ran", so
 * the distinction has to be made before the verdict is read.
 *
 *   writeFileSync(copy, mutatedSource);
 *   assertFixtureParses(copy);     // a broken mutant stops here, by name
 *   const { status, out } = run(copy);
 *   assert.equal(status, 1, out);  // the RED is about the assertion now
 *
 * Both functions are read-only: nothing is written to the repository, to a
 * scratch directory, or anywhere else. The parse path spawns `node --check`; the
 * typecheck path builds an in-memory program and never calls `program.emit()`.
 *
 * Errors carry a fixed first line, so a caller can assert on the class:
 *   "fixture does not parse: <abs path>"
 *   "fixture does not typecheck: <abs path>"
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";

const require = createRequire(import.meta.url);

const NODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

/** How many diagnostics the typecheck path prints before it summarizes the rest. */
const MAX_DIAGNOSTICS = 10;

/**
 * Compiler flags for a fixture with no tsconfig.json above it. Deliberately
 * minimal and strict: no `types` (so the check does not depend on which
 * @types packages a machine has installed), no emit, ES2022 target.
 */
const fallbackOptions = (ts) => ({
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
});

/** Options that only describe emit; typing a fixture does not need them. */
const NO_EMIT_OVERRIDES = {
  noEmit: true,
  declaration: false,
  declarationMap: false,
  emitDeclarationOnly: false,
  composite: false,
  incremental: false,
  tsBuildInfoFile: undefined,
  outDir: undefined,
  outFile: undefined,
  rootDir: undefined,
  sourceMap: false,
};

/** TypeScript is loaded lazily: the parse path must not pay for it. */
let typescriptApi;
function loadTypeScript() {
  if (typescriptApi === undefined) {
    try {
      typescriptApi = require("typescript");
    } catch (error) {
      throw new Error(
        `fixture-guard: the typecheck path needs the installed typescript package: ${error.message}`,
        { cause: error },
      );
    }
  }
  return typescriptApi;
}

function requireFile(filePath) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`fixture-guard: no such fixture: ${abs}`);
  }
  return abs;
}

/** `node --check` in a child process; the fixture is judged as node will run it. */
function nodeCheck(abs) {
  const result = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`fixture-guard: could not run node --check on ${abs}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("").trim();
    const why = result.status === null ? `killed by ${result.signal ?? "a signal"}` : `exit ${result.status}`;
    throw new Error(`fixture does not parse: ${abs} (node --check ${why})\n${detail}`);
  }
}

/** A diagnostic as `file:line:column TS<code>: message`. */
function formatDiagnostic(ts, diagnostic) {
  const file = diagnostic.file;
  const named = file ? file.fileName : "<no file>";
  let where = named;
  if (file && typeof diagnostic.start === "number") {
    const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start);
    where = `${named}:${line + 1}:${character + 1}`;
  }
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  return `${where} TS${diagnostic.code}: ${text}`;
}

function typescriptParseDiagnostics(ts, abs) {
  const text = readFileSync(abs, "utf8");
  const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, false);
  const diagnostics = source.parseDiagnostics;
  if (!Array.isArray(diagnostics)) {
    // A guard that shrugs when the API shape moves is the bug it exists to catch.
    throw new Error(
      `fixture-guard: typescript ${ts.version} exposes no parseDiagnostics on a SourceFile; ` +
        `cannot validate ${abs}`,
    );
  }
  return diagnostics.map((d) => formatDiagnostic(ts, d));
}

/**
 * Throw unless the fixture parses. Returns the resolved absolute path.
 *
 * `.js`/`.mjs`/`.cjs` go through `node --check`, so the module system the file's
 * own location implies (the nearest package.json `type`) is the one it is judged
 * under, exactly as the run that follows will judge it. `.ts`/`.mts`/`.cts` are
 * parsed by the TypeScript compiler and reported with their diagnostics.
 *
 * This is a syntax check only: it says the fixture can run, not that it imports
 * anything that exists, and not that it typechecks (see the slow path below).
 */
export function assertFixtureParses(filePath) {
  const abs = requireFile(filePath);
  const extension = extname(abs).toLowerCase();
  if (NODE_EXTENSIONS.has(extension)) {
    nodeCheck(abs);
  } else if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    const ts = loadTypeScript();
    const diagnostics = typescriptParseDiagnostics(ts, abs);
    if (diagnostics.length > 0) {
      throw new Error(
        `fixture does not parse: ${abs} (${diagnostics.length} parse diagnostic(s))\n` +
          diagnostics.slice(0, MAX_DIAGNOSTICS).join("\n"),
      );
    }
  } else {
    throw new Error(
      `fixture-guard: unsupported fixture extension "${extension}" for ${abs} ` +
        `(expected .js/.mjs/.cjs or .ts/.mts/.cts)`,
    );
  }
  return abs;
}

/** The nearest tsconfig.json above the fixture, or null. */
function nearestTsconfig(ts, abs) {
  return ts.findConfigFile(dirname(abs), ts.sys.fileExists, "tsconfig.json") ?? null;
}

/** The tsconfig's own flags (extends resolved, paths resolved against it). */
function compilerOptionsFor(ts, abs) {
  const configPath = nearestTsconfig(ts, abs);
  if (configPath === null) {
    return { configPath: null, options: fallbackOptions(ts) };
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      `fixture-guard: cannot read ${configPath}: ${formatDiagnostic(ts, read.error)}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  return { configPath, options: { ...parsed.options, ...NO_EMIT_OVERRIDES } };
}

/**
 * Throw unless the fixture typechecks. Returns the resolved absolute path.
 *
 * The slow path (a full compiler program: seconds, not milliseconds), and the
 * one to reach for when the mutant is type-level: a deletion that removes a
 * discriminant TypeScript needs parses perfectly and still cannot compile, so
 * `assertFixtureParses` is blind to exactly the class that produced this guard.
 *
 * Flags come from the nearest tsconfig.json; emit-only flags are overridden (the
 * check never emits). A fixture with no tsconfig.json above it is checked with a
 * documented minimal strict default. TypeScript fixtures only: a `.mjs` fixture
 * has no types to get wrong, so use `assertFixtureParses` there.
 */
export function assertFixtureTypechecks(filePath) {
  const abs = requireFile(filePath);
  const extension = extname(abs).toLowerCase();
  if (!TYPESCRIPT_EXTENSIONS.has(extension)) {
    throw new Error(
      `fixture-guard: the typecheck path takes a TypeScript fixture, got "${extension}" ` +
        `(${abs}); use assertFixtureParses for .js/.mjs/.cjs`,
    );
  }
  const ts = loadTypeScript();
  const parseDiagnostics = typescriptParseDiagnostics(ts, abs);
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `fixture does not parse: ${abs} (${parseDiagnostics.length} parse diagnostic(s))\n` +
        parseDiagnostics.slice(0, MAX_DIAGNOSTICS).join("\n"),
    );
  }
  const { configPath, options } = compilerOptionsFor(ts, abs);
  const program = ts.createProgram({ rootNames: [abs], options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) return abs;

  // The fixture's own diagnostics carry the verdict; diagnostics from files it
  // imports are counted and named, not silently dropped.
  const own = diagnostics.filter((d) => d.file?.fileName === abs);
  const imported = [
    ...new Set(diagnostics.filter((d) => d.file?.fileName !== abs).map((d) => d.file?.fileName ?? "<no file>")),
  ];
  const from = configPath === null ? "built-in strict default" : configPath;
  const origin =
    own.length > 0
      ? `${own.length} in the fixture`
      : `none in the fixture, ${diagnostics.length} in files it imports (${imported.slice(0, 3).join(", ")})`;
  const lines = (own.length > 0 ? own : diagnostics)
    .slice(0, MAX_DIAGNOSTICS)
    .map((d) => formatDiagnostic(ts, d));
  throw new Error(
    `fixture does not typecheck: ${abs} (${diagnostics.length} diagnostic(s), ${origin}; ` +
      `compilerOptions from ${from})\n${lines.join("\n")}`,
  );
}
