/**
 * Structural pin: `no-empty` stays enabled in the shared ESLint config.
 *
 * The rule stops new undocumented silent catches only while the config
 * enables it. With the rule off, a tree full of bare `catch {}` blocks still
 * lints clean, so a silent re-disable would re-open the hole with every gate
 * green. The lint step cannot fail on that drift - there is no violation to
 * report - so the decision is pinned here instead.
 *
 * This checks the declared config, not the resolved one: the lint step itself
 * exercises resolution on every run and fails on any violation.
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const config = (await import(pathToFileURL(join(ROOT, "eslint.config.js")).href)).default;

const declared = [];
for (const block of config) {
  const rule = block.rules?.["no-empty"];
  if (rule !== undefined) declared.push(rule);
}

const severity = (rule) => (Array.isArray(rule) ? rule[0] : rule);
const allowsEmptyCatch = (rule) => Array.isArray(rule) && rule[1]?.allowEmptyCatch === true;

const problems = [];
if (declared.length === 0) {
  problems.push("no config block declares no-empty");
}
for (const rule of declared) {
  if (severity(rule) === "off" || severity(rule) === 0) {
    problems.push(`a config block disables no-empty: ${JSON.stringify(rule)}`);
  }
  if (allowsEmptyCatch(rule)) {
    problems.push(`a config block allows empty catch blocks: ${JSON.stringify(rule)}`);
  }
}

if (problems.length > 0) {
  console.log("\u274c no-empty is no longer enforced by the shared ESLint config:");
  for (const problem of problems) {
    console.log(`  ${problem}`);
  }
  process.exit(1);
}

console.log("\u2705 no-empty stays enabled in the shared ESLint config.");
