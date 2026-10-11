/**
 * pi-braid/telegram test runner.
 * Run: node test/run-tests.mjs  (or: npm test)
 *
 * 1. Emits the TypeScript sources into packages/telegram/dist (gitignored) so
 *    the node:test files can import plain ESM JS — the .js-extension source
 *    imports (resolved .js -> .ts by pi's loader, not by node's type-stripping)
 *    make direct .ts execution impossible. Mirrors core's build-then-test flow.
 * 2. Spawns `node <file>.test.mjs` for every test file under test/. Each
 *    child gets a normalized env (child-env.mjs): role-relevant ambient
 *    variables stripped, poller lock pinned per file.
 * NO npm install, NO network.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { childEnv } from "./child-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

/** Walk up from `from` to find the hoisted typescript tsc bin (monorepo). */
function findTscBin(from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "tsc"; // fall back to PATH
}

// ── 1. Build the test target ────────────────────────────────────────────────
const dist = join(pkgRoot, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const tsc = spawnSync(
  "node",
  [findTscBin(pkgRoot), "-p", "tsconfig.build.json"],
  {
    cwd: pkgRoot,
    encoding: "utf-8",
    env: childEnv("tsc"),
  },
);
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout);
  process.stderr.write(tsc.stderr);
  console.error("tsc emit to dist/ failed — cannot run tests.");
  process.exit(1);
}

// ── 2. Run every test file ──────────────────────────────────────────────────
const testFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

console.log(
  `\n@pi-braid/telegram: ${testFiles.length} test file(s) from dist/ build\n`,
);

let passed = 0;
let failed = 0;
const failures = [];

for (const file of testFiles) {
  const result = spawnSync("node", [join("test", file)], {
    cwd: pkgRoot,
    encoding: "utf-8",
    timeout: 120_000,
    env: childEnv(file),
  });
  const label = `[${file}]`;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status === 0) {
    passed++;
    console.log(`${label} PASS`);
  } else {
    failed++;
    failures.push(file);
    console.error(
      `${label} FAIL (exit ${result.status ?? result.signal ?? "unknown"})`,
    );
  }
  console.log("");
}

console.log(`telegram: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
