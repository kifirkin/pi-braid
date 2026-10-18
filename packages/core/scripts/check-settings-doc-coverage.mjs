#!/usr/bin/env node
/**
 * Check for configuration-shaped Markdown signals for the package's braid.* source paths.
 *
 * A green result means every non-excluded static path mention has a matching
 * table, list, default, or effect line, and every dynamic path has a matching
 * documented family. The only named exclusion is `braid.version`, package
 * metadata rather than a setting. A green result does not prove that a
 * description is accurate or complete.
 *
 * Static text hits reuse check-braid-schema.mjs; a local TypeScript syntax
 * pass adds visible bracket, template, and destructured paths. Both source
 * passes read non-test .ts files only. Markdown evidence excludes fenced code,
 * HTML comments, and test/build/dependency directories.
 *
 * Usage: node packages/core/scripts/check-settings-doc-coverage.mjs [--coverage-root <packages-dir>]
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { REPO_ROOT, censusSourceLiterals } from "./check-braid-schema.mjs";

const DEFAULT_PACKAGES_ROOT = join(REPO_ROOT, "packages");
const DOC_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "builds",
  "coverage",
  "deps",
  "dependencies",
  "vendor",
  "test",
  "tests",
  "__tests__",
  "fixtures",
]);

/** A local metadata object called braid, not a setting read from settings.json. */
export const SETTINGS_DOC_EXCLUSIONS = [
  {
    key: "braid.version",
    reason:
      "a local package-metadata object in packages/core/src/extensions/core/prompt-builder/instance-composition.ts, not settings.json",
  },
];

const SOURCE_SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", "fixtures"]);
const SOURCE_SKIP_FILE_RE = /(^test\.ts$|\.test\.ts$|\.spec\.ts$|-test\.ts$|-tests\.ts$)/;
const DOC_PATH_RE = /\bbraid(?:\??\.(?:[A-Za-z0-9_-]+|<[^>\n]+>|\[[^\]\n]*\])|\[[^\]\n]*\])+/g;

function hasDynamicSegment(token) {
  if (/<[^>]+>|\$\{/.test(token)) return true;
  return [...token.matchAll(/\[([^\]]*)\]/g)].some(([, segment]) => !/^["'][^"']*["']$/.test(segment));
}

function stripHtmlComments(line, inComment) {
  let visible = "";
  let offset = 0;
  while (offset < line.length) {
    if (inComment) {
      const end = line.indexOf("-->", offset);
      if (end === -1) return { text: visible, inComment: true };
      offset = end + 3;
      inComment = false;
      continue;
    }
    const start = line.indexOf("<!--", offset);
    if (start === -1) {
      visible += line.slice(offset);
      break;
    }
    visible += line.slice(offset, start);
    offset = start + 4;
    inComment = true;
  }
  return { text: visible, inComment };
}

function activeMarkdownLines(text) {
  const lines = [];
  let fence = null;
  let inComment = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (fence !== null) {
      const close = /^( {0,3})(`+|~+)\s*$/.exec(line);
      if (close && close[2][0] === fence.marker && close[2].length >= fence.length) fence = null;
      continue;
    }
    if (!inComment) {
      const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (open) {
        fence = { marker: open[2][0], length: open[2].length };
        continue;
      }
    }
    const active = stripHtmlComments(line, inComment);
    inComment = active.inComment;
    lines.push({ line: index + 1, text: active.text });
  }
  return lines;
}

const DEFAULT_EFFECT_SIGNAL_RE =
  /\bby default\b|\bdefaults?\s*(?::|=|\bto\b|\bis\b)|\beffects?\s*(?::|=|\bis\b)|\bhas\s+(?:no\s+)?effect\b/i;

function hasTableSignal(line) {
  if (/^\s*\|.+\|/.test(line)) return true;
  let pipes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") pipes++;
  }
  return pipes >= 2;
}

function hasConfigurationSignal(line) {
  return (
    hasTableSignal(line) ||
    /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line) ||
    DEFAULT_EFFECT_SIGNAL_RE.test(line)
  );
}

/** Read active Markdown lines; examples, comments, and test fixtures cannot satisfy the signal. */
export function censusHumanDocs(packagesRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DOC_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(abs);
      }
    }
  };
  walk(packagesRoot);
  files.sort();
  return {
    files: files.length,
    lines: files.flatMap((file) =>
      activeMarkdownLines(readFileSync(file, "utf8")).map((entry) => ({
        ...entry,
        file: relative(REPO_ROOT, file),
      })),
    ),
  };
}

function normalizeDynamicPath(token) {
  return token
    .replace(/\?\./g, ".")
    .replace(/\[("|')([^\]"']*)\1\]/g, (_match, _quote, key) => `.${key}`)
    .replace(/\[[^\]]*\]/g, ".*")
    .replace(/<[^>]+>/g, "*")
    .replace(/\$\{[^}]*\}/g, "*");
}

function dynamicDocumentationLine(token, docCensus) {
  const expected = normalizeDynamicPath(token);
  for (const line of docCensus.lines) {
    if (!hasConfigurationSignal(line.text)) continue;
    for (const [path] of line.text.matchAll(DOC_PATH_RE)) {
      if (normalizeDynamicPath(path) === expected) return line;
    }
  }
  return null;
}

function sourceFiles(packagesRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(abs);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts") &&
        !SOURCE_SKIP_FILE_RE.test(entry.name)
      ) {
        files.push(abs);
      }
    }
  };
  walk(packagesRoot);
  return files.sort();
}

function literalPropertyKey(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  if (node && ts.isNumericLiteral(node)) return node.text;
  if (node && ts.isParenthesizedExpression(node)) return literalPropertyKey(node.expression);
  return null;
}

function staticPropertyKey(node, constants = null) {
  const literal = literalPropertyKey(node);
  if (literal !== null) return literal;
  if (node && ts.isIdentifier(node)) return constants?.get(node.text) ?? null;
  return null;
}

function appendStaticKey(path, key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function sourceStringConstants(sourceFile) {
  const constants = new Map();
  const ambiguous = new Set();
  const visit = (node) => {
    const declarationList = node.parent;
    const statement = declarationList?.parent;
    const container = statement?.parent;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isVariableStatement(statement) &&
      (ts.isSourceFile(container) || ts.isModuleBlock(container))
    ) {
      const value = literalPropertyKey(node.initializer);
      if (value !== null) {
        if (constants.has(node.name.text) && constants.get(node.name.text) !== value) {
          ambiguous.add(node.name.text);
        } else {
          constants.set(node.name.text, value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of ambiguous) constants.delete(name);
  return constants;
}

function braidPathOf(node, sourceFile, constants) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return braidPathOf(node.expression, sourceFile, constants);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const base = braidPathOf(node.expression, sourceFile, constants);
    if (base !== null) return appendStaticKey(base, node.name.text);
    if (node.name.text === "braid") return "braid";
    return null;
  }
  if (ts.isElementAccessExpression(node)) {
    const base = braidPathOf(node.expression, sourceFile, constants);
    const key = staticPropertyKey(node.argumentExpression, constants);
    if (base !== null) {
      return key === null
        ? `${base}[${node.argumentExpression?.getText(sourceFile) ?? "<computed>"}]`
        : appendStaticKey(base, key);
    }
    if (key === "braid") return "braid";
  }
  return null;
}

function bindingPropertyKey(node, constants) {
  if (ts.isComputedPropertyName(node)) return staticPropertyKey(node.expression, constants);
  if (ts.isIdentifier(node)) return node.text;
  return staticPropertyKey(node, constants);
}

function hasStaticBracketPath(node, constants) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return hasStaticBracketPath(node.expression, constants);
  }
  if (ts.isPropertyAccessExpression(node)) return hasStaticBracketPath(node.expression, constants);
  if (ts.isElementAccessExpression(node)) {
    return (
      staticPropertyKey(node.argumentExpression, constants) !== null ||
      hasStaticBracketPath(node.expression, constants)
    );
  }
  return false;
}

function templateBraidPath(node, sourceFile, constants) {
  const prefix = /\bbraid(?:\.[A-Za-z0-9_-]+)*\.$/.exec(node.head.text);
  if (!prefix) return null;
  let path = prefix[0].slice(0, -1);
  for (const span of node.templateSpans) {
    const key = staticPropertyKey(span.expression, constants);
    const segment = key ?? span.expression.getText(sourceFile);
    path = path.endsWith(".")
      ? `${path}${key === null ? `<${segment}>` : segment}`
      : key === null
        ? `${path}.<${segment}>`
        : appendStaticKey(path, key);
    const suffix = span.literal.text;
    if (suffix === "") continue;
    if (suffix === ".") {
      path += suffix;
      continue;
    }
    const staticSuffix = /^(?:\.[A-Za-z0-9_-]+)+/.exec(suffix);
    if (!staticSuffix) break;
    path += staticSuffix[0];
    if (staticSuffix[0].length < suffix.length) break;
  }
  return path.replace(/\.+$/, "") || null;
}

function dynamicPrefix(token) {
  const first = /<|\[|\$\{/.exec(token);
  if (!first) return null;
  const prefix = token.slice(0, first.index).replace(/[.?]+$/, "");
  return prefix === "braid" ? null : prefix;
}

function addHit(hits, token, finding) {
  if (!hits.has(token)) hits.set(token, []);
  const entries = hits.get(token);
  if (!entries.some((entry) => entry.file === finding.file && entry.line === finding.line)) {
    entries.push(finding);
  }
}

function collectDestructuredPaths(
  pattern,
  basePath,
  sourceFile,
  file,
  literalHits,
  dynamicHits,
  masked,
  constants,
) {
  for (const element of pattern.elements) {
    const property = element.propertyName ?? element.name;
    const line = sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1;
    if (element.dotDotDotToken) {
      if (basePath?.startsWith("braid")) {
        const token = `${basePath}[...rest]`;
        addHit(dynamicHits, token, { token, file, line });
      }
      continue;
    }
    const key = bindingPropertyKey(property, constants);
    if (key === null) {
      if (basePath?.startsWith("braid")) {
        const token = `${basePath}[${property.getText(sourceFile)}]`;
        addHit(dynamicHits, token, { token, file, line });
        const prefix = dynamicPrefix(token);
        if (prefix) masked.add(`${prefix}\0${file}\0${line}`);
      }
      continue;
    }
    const child = basePath === null ? (key === "braid" ? "braid" : null) : appendStaticKey(basePath, key);
    if (child === null) continue;
    if (child.startsWith("braid.")) {
      if (hasDynamicSegment(child)) {
        addHit(dynamicHits, child, { token: child, file, line });
      } else {
        addHit(literalHits, child, { token: child, file, line });
      }
    }
    if (ts.isObjectBindingPattern(element.name)) {
      collectDestructuredPaths(
        element.name,
        child,
        sourceFile,
        file,
        literalHits,
        dynamicHits,
        masked,
        constants,
      );
    }
  }
}

/** Add syntax-visible leaves and unresolved property paths without changing the shared schema census. */
function censusIndirectSettingsPaths(packagesRoot) {
  const literalHits = new Map();
  const dynamicHits = new Map();
  const masked = new Set();
  for (const abs of sourceFiles(packagesRoot)) {
    const text = readFileSync(abs, "utf8");
    const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constants = sourceStringConstants(sourceFile);
    const file = relative(REPO_ROOT, abs);
    const addDynamic = (token, node) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      addHit(dynamicHits, token, { token, file, line });
      const prefix = dynamicPrefix(token);
      if (prefix) masked.add(`${prefix}\0${file}\0${line}`);
    };
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const token = braidPathOf(node, sourceFile, constants);
        const parent = node.parent;
        const parentIsAccess = ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent);
        const parentToken = parentIsAccess ? braidPathOf(parent, sourceFile, constants) : null;
        if (token && hasDynamicSegment(token) && !(parentToken && hasDynamicSegment(parentToken))) {
          addDynamic(token, node);
        } else if (token?.startsWith("braid.") && hasStaticBracketPath(node, constants)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          addHit(literalHits, token, { token, file, line });
        }
      }
      if (ts.isTemplateExpression(node)) {
        const token = templateBraidPath(node, sourceFile, constants);
        if (token && hasDynamicSegment(token)) {
          addDynamic(token, node);
        } else if (token) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          addHit(literalHits, token, { token, file, line });
          const prefix = token.slice(0, token.lastIndexOf("."));
          if (prefix && prefix !== "braid") masked.add(`${prefix}\0${file}\0${line}`);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        const initializer = braidPathOf(node.initializer, sourceFile, constants);
        const base = initializer?.startsWith("braid") ? initializer : null;
        collectDestructuredPaths(
          node.name,
          base,
          sourceFile,
          file,
          literalHits,
          dynamicHits,
          masked,
          constants,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { literalHits, dynamicHits, masked };
}

function censusSettingsSource(packagesRoot) {
  const sourceCensus = censusSourceLiterals(packagesRoot);
  const indirect = censusIndirectSettingsPaths(packagesRoot);
  const hits = new Map();
  for (const [token, findings] of sourceCensus.hits) {
    const visible = findings.filter(
      (finding) => !indirect.masked.has(`${token}\0${finding.file}\0${finding.line}`),
    );
    if (visible.length > 0) hits.set(token, visible);
  }
  for (const [token, findings] of indirect.literalHits) {
    for (const finding of findings) addHit(hits, token, finding);
  }
  for (const [token, findings] of indirect.dynamicHits) {
    for (const finding of findings) addHit(hits, token, finding);
  }
  return { files: sourceCensus.files, hits };
}

function literalDocumentationLine(token, docCensus) {
  return (
    docCensus.lines.find(
      (line) => hasConfigurationSignal(line.text) && line.text.includes(token),
    ) ?? null
  );
}

/** Classify source paths by configuration-shaped Markdown signals, not semantic adequacy. */
export function checkSettingsDocCoverage(sourceCensus, docCensus) {
  const covered = [];
  const excluded = [];
  const dynamic = [];
  const unresolved = [];
  const uncovered = [];
  const exclusions = new Map(SETTINGS_DOC_EXCLUSIONS.map((entry) => [entry.key, entry.reason]));

  for (const token of [...sourceCensus.hits.keys()].sort()) {
    const first = sourceCensus.hits.get(token)[0];
    const finding = { token, file: first.file, line: first.line };
    if (hasDynamicSegment(token)) {
      const docLine = dynamicDocumentationLine(token, docCensus);
      const entry = {
        ...finding,
        documented: docLine !== null,
        docFile: docLine?.file,
        docLine: docLine?.line,
      };
      dynamic.push(entry);
      if (docLine === null) unresolved.push(finding);
    } else if (exclusions.has(token)) {
      excluded.push({ ...finding, reason: exclusions.get(token) });
    } else {
      const docLine = literalDocumentationLine(token, docCensus);
      if (docLine !== null) {
        covered.push({ ...finding, docFile: docLine.file, docLine: docLine.line });
      } else {
        uncovered.push(finding);
      }
    }
  }

  const dynamicDocumented = dynamic.filter((entry) => entry.documented);
  return {
    ok: uncovered.length === 0 && unresolved.length === 0,
    sourceFiles: sourceCensus.files,
    sourceLiterals: sourceCensus.hits.size,
    markdownFiles: docCensus.files,
    covered,
    excluded,
    dynamic,
    dynamicDocumented,
    unresolved,
    uncovered,
  };
}

export function scanSettingsDocCoverage(packagesRoot = DEFAULT_PACKAGES_ROOT) {
  return checkSettingsDocCoverage(
    censusSettingsSource(packagesRoot),
    censusHumanDocs(packagesRoot),
  );
}

/** Resolve --coverage-root in either spelling; a missing value is not a default. */
export function resolveCoverageRoot(argv = process.argv.slice(2)) {
  const flag = "--coverage-root";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let dir;
    if (arg === flag) {
      const next = argv[i + 1];
      dir = next && !next.startsWith("--") ? next : null;
    } else if (arg.startsWith(`${flag}=`)) {
      dir = arg.slice(flag.length + 1);
    } else {
      continue;
    }
    if (!dir) {
      throw new Error(
        "--coverage-root needs a directory (got no value); " +
          "omit the flag to scan the checkout, or pass --coverage-root <dir>",
      );
    }
    return resolve(dir);
  }
  return DEFAULT_PACKAGES_ROOT;
}

function main() {
  const packagesRoot = resolveCoverageRoot();
  const result = scanSettingsDocCoverage(packagesRoot);
  const summary =
    `settings doc signal check: ${result.sourceLiterals} braid.* source path(s) over ` +
    `${result.sourceFiles} source file(s), ${result.markdownFiles} human Markdown file(s); ` +
    `${result.covered.length} configuration-shaped literal mention(s), ${result.excluded.length} excluded, ` +
    `${result.dynamicDocumented.length} documented dynamic family path(s), ` +
    `${result.unresolved.length} unresolved dynamic, ${result.uncovered.length} uncovered literal`;
  console.log(`${result.ok ? "✅" : "❌"} ${summary}`);

  for (const entry of result.excluded) {
    console.log(`  - ${entry.token} (${entry.file}:${entry.line}): excluded: ${entry.reason}`);
  }
  for (const entry of result.dynamicDocumented) {
    console.log(
      `  - ${entry.token} (${entry.file}:${entry.line}): dynamic family documented at ${entry.docFile}:${entry.docLine}`,
    );
  }
  for (const entry of result.unresolved) {
    console.error(
      `  - ${entry.token} (${entry.file}:${entry.line}): unresolved dynamic path; document this exact family shape or make the property literal`,
    );
  }
  for (const entry of result.uncovered) {
    console.error(
      `  - ${entry.token} (${entry.file}:${entry.line}): add a configuration-shaped table row, list item, or default/effect line outside fences and HTML comments`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e) {
    console.error(`check-settings-doc-coverage: ${e.message}`);
    process.exit(1);
  }
}
