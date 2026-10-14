/**
 * manifest-deps.test.mjs - every bare import of the shipped sources is
 * declared in the manifest, and the `files` list ships every extension entry.
 *
 * A source that value-imports a package the manifest does not declare loads
 * in a hoisted monorepo tree and fails in a strict layout: the shipped
 * sources import `pi-braid/lib` and `pi-braid` was declared nowhere, because
 * the monorepo typecheck resolves it through a tsconfig path mapping and no
 * manifest field agreed. The check derives the shipped file set from the
 * manifest's own `files` list and the import specifiers from those files, so
 * it moves with the sources instead of a hand-kept list; `node:` specifiers
 * and Node builtins are skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
);

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

/** Files the package would ship, per its `files` list (directories walked). */
function shippedFiles(root, entries) {
  const negated = new Set();
  const found = [];
  const walk = (abs) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) walk(join(abs, name));
      return;
    }
    if (CODE.test(abs)) found.push(resolve(abs));
  };
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      negated.add(entry.slice(1).replace(/\/+$/, ""));
      continue;
    }
    walk(join(root, entry));
  }
  return found.filter((abs) => {
    const rel = relative(root, abs).split("\\").join("/");
    return !negated.has(rel);
  });
}

/** Source with comment-only lines and block-comment interiors removed. */
function codeOnly(text) {
  const kept = [];
  let block = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (block) {
      if (trimmed.includes("*/")) block = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) block = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const cut = line.indexOf("//");
    kept.push(cut === -1 ? line : line.slice(0, cut));
  }
  return kept.join("\n");
}

/** Bare specifiers a source imports or re-exports. */
function specifiersOf(abs) {
  const text = codeOnly(readFileSync(abs, "utf8"));
  const patterns = [
    /\bfrom\s+["']([^"'\s]+)["']/g, // import/export ... from "pkg"
    /\bimport\s*\(\s*["']([^"'\s]+)["']\s*\)/g, // import("pkg")
    /\bimport\s+["']([^"'\s]+)["']/g, // import "pkg"
    /\brequire\s*\(\s*["']([^"'\s]+)["']\s*\)/g, // require("pkg")
  ];
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** The package a specifier names, or null for relative/scheme specifiers. */
function packageOf(specifier) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null; // node:, data:, ...
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const shipped = shippedFiles(pkgRoot, manifest.files ?? []);
const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
]);

test("files list ships every declared extension entry", () => {
  const entries = (manifest.pi?.extensions ?? []).map((entry) =>
    resolve(pkgRoot, entry),
  );
  assert.ok(entries.length > 0, "the manifest declares no pi.extensions entry");
  const shippedSet = new Set(shipped);
  for (const entry of entries) {
    assert.ok(
      shippedSet.has(entry),
      `${relative(pkgRoot, entry)} is not shipped by the files list`,
    );
  }
});

test("every bare import of the shipped sources is declared in the manifest", () => {
  const findings = [];
  for (const abs of shipped) {
    for (const specifier of specifiersOf(abs)) {
      const name = packageOf(specifier);
      if (!name || BUILTINS.has(name)) continue;
      if (!declared.has(name)) {
        findings.push(`${relative(pkgRoot, abs)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    `bare import(s) with no dependencies/peerDependencies declaration:\n${findings.join(
      "\n",
    )}`,
  );
});
