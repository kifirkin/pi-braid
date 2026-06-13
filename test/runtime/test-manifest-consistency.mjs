/**
 * Manifest Consistency Test
 *
 * Asserts that the set of extension directories under src/extensions/
 * matches the set of IDs declared in src/extensions/manifest.ts.
 *
 * Detects drift in either direction:
 *   - A directory exists on disk but is not in the manifest (orphan)
 *   - A manifest entry points to a directory that does not exist (dangling)
 *
 * Exits non-zero on any mismatch.
 *
 * Background: the deep code review (2026-06-13) found multiple instances
 * of drift, including an `auto-singleton` directory that was documented
 * in AGENTS.md but absent from both the manifest and the filesystem
 * (the directory was deleted but the references weren't cleaned up).
 * This test prevents that class of drift from recurring.
 *
 * Companion to test-single-ownership.mjs (which guards event-name strings).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSIONS_DIR = join(ROOT, "src", "extensions");
const MANIFEST_FILE = join(EXTENSIONS_DIR, "manifest.ts");

// ── Step 1: discover extension directories ─────────────────────────────────

function listDirs(base) {
  return readdirSync(base)
    .filter((entry) => {
      const full = join(base, entry);
      return statSync(full).isDirectory();
    })
    .map((entry) => join(base, entry));
}

/**
 * Map directory paths to extension IDs by looking at each directory's
 * `index.ts` (if present) and extracting the import statement from
 * manifest.ts. Easier: just use the directory name as the ID, since
 * the manifest convention is that ID = directory name.
 *
 * Top-level categories (e.g., `src/extensions/cognitive/`) are NOT
 * extensions themselves — they are namespaces containing sub-extensions.
 * An extension is one of:
 *   - A top-level subdir of `src/extensions/` with its own `index.ts`
 *   - A nested subdir whose parent namespace has no `index.ts`
 *     (e.g., `src/extensions/cognitive/metacognition/`)
 */
function discoverExtensionDirs() {
  const topDirs = listDirs(EXTENSIONS_DIR);
  const extensions = [];

  for (const topDir of topDirs) {
    const topName = topDir.split("/").pop();
    const topIndex = join(topDir, "index.ts");

    if (existsSync(topIndex)) {
      // The top-level dir itself is an extension (e.g., `enforcement/`)
      extensions.push({
        id: topName,
        path: topDir,
      });
      continue;
    }

    // The top-level dir is a namespace; each subdir is an extension.
    for (const subDir of listDirs(topDir)) {
      const subName = subDir.split("/").pop();
      const subIndex = join(subDir, "index.ts");
      if (existsSync(subIndex)) {
        extensions.push({
          id: subName,
          path: subDir,
        });
      }
    }
  }

  return extensions;
}

// ── Step 2: extract IDs from manifest.ts ────────────────────────────────────

function parseManifestIds() {
  const src = readFileSync(MANIFEST_FILE, "utf-8");
  // Match the `id: "..."` lines (or `id: '...'`).
  const re = /^\s*id:\s*["']([^"']+)["']/gm;
  const ids = [];
  let match;
  while ((match = re.exec(src)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

// ── Step 3: extract imports from manifest.ts (to verify each dir is imported) ─

function parseManifestImports() {
  const src = readFileSync(MANIFEST_FILE, "utf-8");
  // Match `import <name>Fn from "./<path>/index.js"`
  const re = /from\s+["'](\.\/[^"']*\/index\.js)["']/g;
  const importPaths = [];
  let match;
  while ((match = re.exec(src)) !== null) {
    importPaths.push(match[1]);
  }
  return importPaths;
}

// ── Step 4: cross-check ────────────────────────────────────────────────────

const discovered = discoverExtensionDirs();
const manifestIds = parseManifestIds();
const manifestImports = parseManifestImports();

const discoveredIds = new Set(discovered.map((d) => d.id));
const manifestIdSet = new Set(manifestIds);

const orphans = discovered.filter((d) => !manifestIdSet.has(d.id));
const dangling = manifestIds.filter((id) => !discoveredIds.has(id));

// ── Step 5: also check that each manifest entry has a matching import line ─

// Convert import path like "./cognitive/metacognition/index.js" to a
// normalized form. For top-level dirs, the path is "./metacognition/index.js"
// (no namespace prefix). For namespace members, it's "./cognitive/metacognition/index.js".
// We re-derive the expected import path from the discovered dir and check
// the manifest contains a corresponding import.

const expectedImportPaths = new Set();
for (const d of discovered) {
  const rel = d.path.slice(EXTENSIONS_DIR.length + 1); // strip src/extensions/
  expectedImportPaths.add(`./${rel}/index.js`);
}

const missingImports = [...expectedImportPaths].filter((p) => !manifestImports.includes(p));

// ── Report ─────────────────────────────────────────────────────────────────

let hasDrift = false;

if (orphans.length > 0) {
  hasDrift = true;
  console.log(
    `\n⚠️  ${orphans.length} extension directory(ies) exist on disk but are NOT in manifest.ts:\n`,
  );
  for (const o of orphans) {
    console.log(`  + ${o.id}    (${o.path})`);
  }
}

if (dangling.length > 0) {
  hasDrift = true;
  console.log(
    `\n⚠️  ${dangling.length} manifest.ts ID(s) point to directories that do NOT exist:\n`,
  );
  for (const d of dangling) {
    console.log(`  - ${d}`);
  }
}

if (missingImports.length > 0) {
  hasDrift = true;
  console.log(
    `\n⚠️  ${missingImports.length} extension directory(ies) have no ` +
      `matching import statement in manifest.ts:\n`,
  );
  for (const p of missingImports) {
    console.log(`  ? ${p}`);
  }
}

if (hasDrift) {
  console.log(
    `\nTo fix: add a { id, fn, ... } entry to src/extensions/manifest.ts ` +
      `for each missing extension, or remove the orphan directory.\n`,
  );
  process.exit(1);
}

console.log(
  `✅ Manifest is consistent: ${discovered.length} extension directory(ies) ` +
    `match ${manifestIds.length} manifest entry(ies) with ${manifestImports.length} import(s).`,
);
