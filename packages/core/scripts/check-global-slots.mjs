#!/usr/bin/env node
/**
 * check-global-slots.mjs - a string-keyed global slot must be a declared slot.
 *
 * `globalThis` is the transport for values that must survive the src/dist
 * module split and /reload. A bare `(globalThis as Record<string, unknown>)[k]`
 * cast cannot say what shape the value has or which build wrote it, so a new
 * one is how the two invisible failures return: a writer with no reader and a
 * reader with no writer.
 *
 * Scope: tracked `packages/*\/src/**\/*.ts`. A file is scanned when it uses the
 * string-keyed cast, or assigns into a `__braid_`-prefixed property. Every
 * `__braid_` key in such a file must be either:
 *
 *   - a key declared by a `defineSlot({ key: "..." })` descriptor anywhere in
 *     the scanned tree, or
 *   - a key in `LEGACY_GLOBAL_SLOTS` (`slot-registry.ts`) with a reason.
 *
 * `slot.ts` is the accessor this rule routes everything through, so it is
 * exempt by path; the exemption is printed with its reason rather than skipped
 * silently. The legacy list is read from the registry's source text because
 * this is a plain `.mjs` and the registry is TypeScript; the list is kept one
 * `key: "..."` entry per object so the read stays a text scan rather than an
 * import of a build artifact.
 *
 * A root that is not a git worktree is walked recursively, so the fixture can
 * drive synthetic trees through the same code the repository gate runs.
 *
 * Exit codes: 0 = every key is declared or legacy, 1 = at least one refusal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rootFlag = process.argv.indexOf("--root");
if (rootFlag >= 0 && !process.argv[rootFlag + 1]) {
  console.error("check-global-slots: --root needs a directory");
  process.exit(1);
}
const root = resolve(
  rootFlag >= 0 ? process.argv[rootFlag + 1] : join(here, "..", "..", ".."),
);

const MECHANISM_FILE = "packages/core/src/lib/state/slot.ts";
const REGISTRY_FILE = "packages/core/src/lib/state/slot-registry.ts";

/** The string-keyed cast this rule exists to route through `defineSlot`. */
const CAST = /globalThis\s+as\s+(?:Record<string,\s*unknown>|any\b)/;
const ASSIGN_DOT = /\.(__braid_[a-zA-Z0-9_]+)\s*=/g;
const ASSIGN_INDEX = /\[\s*["'](__braid_[a-zA-Z0-9_]+)["']\s*\]\s*=/g;
const KEY_LITERAL = /["'](__braid_[a-zA-Z0-9_]+)["']/g;

function relativePath(absolute) {
  return relative(root, absolute).split(sep).join("/");
}

function trackedFiles() {
  try {
    const output = execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--", "packages/*/src/**/*.ts"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function walkedFiles() {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  const found = [];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(packages, entry.name, "src");
    if (existsSync(src)) found.push(...walk(src).map(relativePath));
  }
  return found;
}

function revision() {
  try {
    const branch = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (branch && branch !== "HEAD") return branch;
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "an untracked tree";
  }
}

/** The legacy list, read from the registry's source text. */
function legacySlots() {
  const registryPath = join(root, REGISTRY_FILE);
  if (!existsSync(registryPath)) {
    console.error(
      `check-global-slots: ${REGISTRY_FILE} is missing; the legacy set has no declared home`,
    );
    process.exit(1);
  }
  const text = readFileSync(registryPath, "utf8");
  const start = text.indexOf("LEGACY_GLOBAL_SLOTS");
  const end = start >= 0 ? text.indexOf("\n];", start) : -1;
  if (start < 0 || end < 0) {
    console.error(
      `check-global-slots: ${REGISTRY_FILE} declares no LEGACY_GLOBAL_SLOTS array`,
    );
    process.exit(1);
  }
  const block = text.slice(start, end);
  const legacy = new Map();
  for (const object of block.split(/\},\s*\{/)) {
    const key = object.match(/key:\s*"(__braid_[a-zA-Z0-9_]+)"/);
    if (!key) continue;
    const file = object.match(/file:\s*"([^"]+)"/);
    const reason = object.match(/reason:\s*"([^"]+)"/);
    legacy.set(key[1], {
      file: file ? file[1] : "an unstated file",
      reason: reason ? reason[1] : "an unstated reason",
    });
  }
  return legacy;
}

/** Keys declared by a `defineSlot({ key: "..." })` descriptor in one file. */
function declaredKeys(text) {
  const keys = new Set();
  let inDescriptor = false;
  for (const line of text.split("\n")) {
    if (!inDescriptor && line.includes("defineSlot")) inDescriptor = true;
    if (!inDescriptor) continue;
    const key = line.match(/\bkey:\s*"(__braid_[a-zA-Z0-9_]+)"/);
    if (key) keys.add(key[1]);
    if (line.includes("});")) inDescriptor = false;
  }
  return keys;
}

const legacy = legacySlots();
const files = trackedFiles() ?? walkedFiles();
const texts = new Map();
const declared = new Set();
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  texts.set(file, text);
  for (const key of declaredKeys(text)) declared.add(key);
}

const findings = [];
const exemptions = [];
let scanned = 0;
for (const [file, text] of texts) {
  scanned += 1;
  const flagged = CAST.test(text) || /\.__braid_[a-zA-Z0-9_]+\s*=/.test(text);
  const assignments = [...text.matchAll(ASSIGN_DOT), ...text.matchAll(ASSIGN_INDEX)];
  if (!flagged && assignments.length === 0) continue;
  if (file === MECHANISM_FILE) {
    exemptions.push(file);
    continue;
  }
  const keys = new Set();
  for (const match of text.matchAll(KEY_LITERAL)) keys.add(match[1]);
  for (const match of assignments) keys.add(match[1]);
  if (keys.size === 0) {
    findings.push({
      file,
      line: 1,
      key: "(no key)",
      reason:
        "the string-keyed global cast carries no declared slot key; route the value through defineSlot()",
    });
    continue;
  }
  for (const key of keys) {
    if (declared.has(key) || legacy.has(key)) continue;
    const at = text
      .split("\n")
      .findIndex((line) => line.includes(key)) + 1;
    findings.push({
      file,
      line: Math.max(1, at),
      key,
      reason:
        "not declared by defineSlot() and not listed in LEGACY_GLOBAL_SLOTS with a reason",
    });
  }
}

console.log(
  `check-global-slots: scanned ${scanned} of ${files.length} tracked source files at ${revision()}`,
);
console.log(
  `  ${declared.size} slot key(s) declared by defineSlot(), ${legacy.size} legacy key(s) declared with reasons`,
);
for (const file of exemptions) {
  console.log(
    `  mechanism exemption: ${file} (the accessor every slot is routed through)`,
  );
}

if (findings.length > 0) {
  console.error(
    `\n  ${findings.length} unregistered global slot key(s) refused:`,
  );
  for (const finding of findings) {
    console.error(
      `    ${finding.file}:${finding.line}  ${finding.key}  ${finding.reason}`,
    );
  }
  console.error("\n  Global slot check... FAIL");
  process.exit(1);
}

console.log("\n  Global slot check... PASS");
process.exit(0);
