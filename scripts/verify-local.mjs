#!/usr/bin/env node
/**
 * Local verification gate — mirrors CI quality gates.
 * Run before pushing: node scripts/verify-local.mjs
 * Exit code 0 = all gates pass.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const gates = [
  { name: "Type check", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "Check docs", cmd: "node", args: ["scripts/check-doc-status.mjs"] },
  { name: "Check doc drift", cmd: "node", args: ["scripts/check-doc-drift.mjs"] },
  { name: "Check deps", cmd: "node", args: ["scripts/check-deps.mjs"] },
  { name: "Build", cmd: "npm", args: ["run", "build"] },
  { name: "Test", cmd: "npm", args: ["test"] },
];

let passed = 0;
let failed = 0;
const failures = [];

console.log(`Verification gates (${gates.length} total)\n`);

for (const gate of gates) {
  process.stdout.write(`  ${gate.name}... `);
  const result = spawnSync(gate.cmd, gate.args, {
    cwd: root,
    timeout: 120_000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    console.log("PASS");
    passed++;
  } else {
    console.log("FAIL");
    const lines = (result.stdout + "\n" + result.stderr).split("\n").filter(Boolean);
    const summary = lines.slice(0, 8).join("\n");
    console.log(`      ${summary.replace(/\n/g, "\n      ")}`);
    failures.push(gate.name);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`  Failed: ${failures.join(", ")}`);
}
process.exit(failed > 0 ? 1 : 0);