#!/usr/bin/env node
/**
 * Instruction-String Reference Lint
 *
 * An emitted string that tells the model to call a tool is an interface claim:
 * the tool must be registered, and a quoted `action="x"` must be a value of
 * that tool's action enum. Both halves rot silently - the string is prose, so
 * no type checker sees it, and the tool it names can be renamed or removed
 * while the instruction keeps telling the model to reach for it.
 *
 * What is checked, per emitted string unit (one literal, or a `+` chain of
 * literals read as the one message they build):
 *
 *   - backticked names: `` `think()` ``, `` `context_compress` `` - the
 *     repository's own convention for marking a name as a name. A name that
 *     is snake_case (or is a registered tool) must resolve to a registered
 *     tool;
 *   - call shapes: `context_compress(action="archive")` - the head must be a
 *     registered tool and the action must be in that tool's derived enum;
 *   - family companions: a bare snake_case token in the same unit as a
 *     registered tool of the same name family (`context_*`) must itself be a
 *     registered tool or an external name. This is what catches a stale name
 *     written without the backtick convention, while leaving unrelated
 *     snake_case words alone.
 *
 * Deliberate mentions (a removed tool named as history, a host tool that is
 * not this repository's to register) carry an inline marker on the line of
 * the literal:
 *
 *     "consider `context_archive` for completed tasks"  // tool-ref-exempt: removed in the context-tool consolidation
 *
 * Registered tools and their action enums are derived from the source:
 * an object literal with a `name` and a `parameters` property is a tool
 * definition, whether it is passed to `pi.registerTool(...)` directly or
 * returned by a factory. Enums are read from the `action` property of the
 * tool's parameter schema - `Type.Literal(...)` members, `enum: [...]`
 * arrays, `StringEnum([...])` arrays, and one hop through a named constant or
 * a relative import. A tool whose enum cannot be derived is listed as
 * unchecked coverage, never guessed at.
 *
 * Usage: node packages/core/scripts/check-instruction-strings.mjs
 * Exit code: 0 = every reference resolves, 1 = an unresolved reference or a
 * stale baseline row.
 *
 * Baseline: KNOWN_UNRESOLVED records the references that name a tool this
 * repository does not register today. The check fails when a row no longer
 * matches, so the commit that repairs a reference deletes its row in the same
 * change.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectFiles } from "./lib/collect-files.mjs";

const require = createRequire(import.meta.url);

/** The repo root three levels above packages/core/scripts. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The tool names the host environment registers, not this repository:
 * pi-core builtins and the third-party tool packages the repo's own docs name.
 * Braid's own names are never listed here - they are resolved from the source,
 * so a removed tool cannot survive in this table.
 */
const EXTERNAL_TOOLS = new Map([
  ["read", "pi-core builtin"],
  ["write", "pi-core builtin"],
  ["edit", "pi-core builtin"],
  ["bash", "pi-core builtin"],
  ["grep", "pi-core builtin"],
  ["find", "pi-core builtin"],
  ["ls", "pi-core builtin"],
  ["powershell", "pi-core builtin"],
  ["tool_search", "pi-core tool-search extension"],
  ["web_search", "pi-web-access package"],
  ["fetch_content", "pi-web-access package"],
  ["source_check", "pi-web-access package"],
  ["get_search_content", "pi-web-access package"],
  ["web_enable", "pi-web-access package"],
  ["herdr_layout", "@ogulcancelik/pi-herdr package"],
  ["herdr_pane", "@ogulcancelik/pi-herdr package"],
  ["herdr_agent", "@ogulcancelik/pi-herdr package"],
]);

/**
 * References that name a tool this repository does not register, recorded so
 * the check can land before the repairs do. A row is keyed by file and tool;
 * the check fails when a row stops matching. Every row here is a queued
 * instruction repair: a stale tool name in a message the model reads.
 */
const KNOWN_UNRESOLVED = [
  {
    file: "packages/core/src/extensions/cognitive/turn-outcome/index.ts",
    token: "context_archive",
    reason: "loop-detector offline message names the consolidated context tool",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/compaction-retry.ts",
    token: "context_archive",
    reason: "compaction retry prompt names the consolidated context tool",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/compaction-retry.ts",
    token: "context_checkout",
    reason: "compaction retry prompt names the consolidated checkout tool",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/navigation.ts",
    token: "context_checkout",
    reason: "checkout-prepared notice names the consolidated checkout tool",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/rotation.ts",
    token: "context_tag",
    reason: "branch-depth notice names the consolidated tag tool",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/rotation.ts",
    token: "session_compact",
    reason: "branch-depth notice names the retired session compaction tool",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/rotation.ts",
    token: "context_archive",
    reason: "branch-depth notice names the consolidated archive tool",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/tools/context-inspect.ts",
    token: "context_checkout",
    reason: "inspect guidance names the consolidated checkout tool",
  },
  {
    file: "packages/core/src/lib/detection/context-tiers.ts",
    token: "context_archive",
    reason: "advisory tier text names the consolidated archive tool",
  },
  {
    file: "packages/core/src/extensions/heartbeat/heartbeat-scheduler/policies.ts",
    token: "context_inspect",
    reason: "the tool takes detail=, not action=; the tier message predates the rename",
  },
  {
    file: "packages/core/src/extensions/memory/context-manager/handlers/tools/context-compress.ts",
    token: "context_inspect",
    reason: "the tool takes detail=, not action=; the skip notice predates the rename",
  },
];

/** A file under a package's production tree, never a test or declaration file. */
const TEST_PATH = /(^|\/)(?:test|tests|__tests__)\//;
const TEST_FILE = /(^|\/)test[-.]|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Production roots: `packages/<pkg>/src` where it exists, plus the flat
 * module trees of the packages whose code is not src-shaped. Mirrors the
 * write-scope gate's derivation so both gates see the same source.
 */
function sourceRoots(root) {
  const roots = new Set();
  const packagesDir = join(root, "packages");
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const src = join(packagesDir, entry.name, "src");
    try {
      if (statSync(src).isDirectory()) roots.add(src);
    } catch {
      /* not src-shaped */
    }
  }
  for (const whole of ["contrib", "providers", "skills"]) {
    const dir = join(packagesDir, whole);
    try {
      if (statSync(dir).isDirectory()) roots.add(dir);
    } catch {
      /* absent in a fixture tree */
    }
  }
  return [...roots].sort();
}

/** Every production TypeScript file under the given root. */
function sourceFiles(root) {
  const files = new Set();
  for (const dir of sourceRoots(root)) {
    for (const file of collectFiles(dir, (p) => /\.(ts|mts|tsx)$/.test(p) && !p.endsWith(".d.ts"))) {
      const rel = relative(root, file);
      if (TEST_PATH.test(rel) || TEST_FILE.test(rel)) continue;
      files.add(file);
    }
  }
  return [...files].sort();
}

/** Unwrap parentheses and `as const` / `satisfies` shapes around an expression. */
function unwrap(ts, node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/** The text of a property name, or null when it is computed. */
function propName(ts, name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** A file's parsed form plus the tables identifier resolution needs. */
function fileContext(ts, file, text) {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const decls = new Map();
  const imports = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!decls.has(node.name.text)) decls.set(node.name.text, node.initializer);
    }
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const spec = node.moduleSpecifier.text;
      if (clause.name) imports.set(clause.name.text, { spec, name: "default" });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          imports.set(el.name.text, { spec, name: el.propertyName ? el.propertyName.text : el.name.text });
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        imports.set(bindings.name.text, { spec, name: "*" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { file, src, decls, imports };
}

const contextCache = new Map();
const contextFor = (ts, file) => {
  if (!contextCache.has(file)) {
    contextCache.set(file, fileContext(ts, file, readFileSync(file, "utf8")));
  }
  return contextCache.get(file);
};

/** Resolve a relative import specifier to a scanned file, trying TS twins. */
function resolveModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/**
 * One hop of identifier resolution: a declaration in the same file, or a named
 * import from a relative module. Returns the expression and the context it
 * lives in, so nested reads use the right source text.
 */
function resolveIdentifier(ts, ctx, node) {
  if (!ts.isIdentifier(node)) return { node, ctx };
  const decl = ctx.decls.get(node.text);
  if (decl) return { node: decl, ctx };
  const imp = ctx.imports.get(node.text);
  if (imp && imp.spec.startsWith(".") && imp.name !== "*") {
    const target = resolveModule(ctx.file, imp.spec);
    if (target) {
      const targetCtx = contextFor(ts, target);
      const targetDecl = targetCtx.decls.get(imp.name);
      if (targetDecl) return { node: targetDecl, ctx: targetCtx };
    }
  }
  return { node, ctx };
}

/** The `action` property's initializer inside a tool's parameter schema. */
function findActionProperty(ts, ctx, node, depth = 0) {
  node = node ? unwrap(ts, node) : node;
  if (!node || depth > 6) return null;
  if (ts.isIdentifier(node)) {
    const resolved = resolveIdentifier(ts, ctx, node);
    return findActionProperty(ts, resolved.ctx, resolved.node, depth + 1);
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        propName(ts, prop.name) === "action" &&
        prop.initializer
      ) {
        return { node: prop.initializer, ctx };
      }
    }
    return null;
  }
  if (ts.isCallExpression(node)) {
    for (const arg of node.arguments) {
      const found = findActionProperty(ts, ctx, unwrap(ts, arg), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** The final segment of a callee expression: `Type.Literal` -> `Literal`. */
function calleeName(ts, expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** Collect the string members of an action enum expression into `out`. */
function collectEnumValues(ts, ctx, node, out, depth = 0) {
  node = node ? unwrap(ts, node) : node;
  if (!node || depth > 8) return;
  if (ts.isIdentifier(node)) {
    const resolved = resolveIdentifier(ts, ctx, node);
    if (resolved.node !== node || resolved.ctx !== ctx) {
      collectEnumValues(ts, resolved.ctx, resolved.node, out, depth + 1);
    }
    return;
  }
  if (ts.isCallExpression(node)) {
    const callee = calleeName(ts, node.expression);
    if (callee === "Literal" || callee === "Enum") {
      for (const arg of node.arguments) {
        const value = unwrap(ts, arg);
        if (ts.isStringLiteralLike(value)) out.add(value.text);
      }
    }
    for (const arg of node.arguments) collectEnumValues(ts, ctx, unwrap(ts, arg), out, depth + 1);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        collectEnumValues(ts, ctx, element.expression, out, depth + 1);
        continue;
      }
      const value = unwrap(ts, element);
      if (ts.isStringLiteralLike(value)) out.add(value.text);
      else collectEnumValues(ts, ctx, value, out, depth + 1);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        propName(ts, prop.name) === "enum" &&
        prop.initializer
      ) {
        collectEnumValues(ts, ctx, prop.initializer, out, depth + 1);
      }
    }
  }
}

/** A `+` chain leaf's cooked text; template holes become a NUL separator. */
function cookedText(ts, node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += "\u0000" + span.literal.text;
    return out;
  }
  return null;
}

const isStringLike = (ts, node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);

/** The top of the `+` chain a string leaf belongs to (its emitted unit). */
function unitTop(ts, node) {
  let top = node;
  while (
    top.parent &&
    ts.isBinaryExpression(top.parent) &&
    top.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    top = top.parent;
  }
  return top;
}

/**
 * An emitted unit: the joined text of one `+` chain of string leaves, plus
 * each leaf's span in that text so a finding can be traced to a line.
 */
function buildUnit(ts, src, top) {
  const leaves = [];
  const collect = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      collect(node.left);
      collect(node.right);
      return;
    }
    const text = cookedText(ts, node);
    if (text === null) return;
    leaves.push({ node, text });
  };
  collect(top);
  if (leaves.length === 0) return null;
  let value = "";
  const spans = [];
  for (const leaf of leaves) {
    spans.push({ start: value.length, end: value.length + leaf.text.length, leaf });
    value += leaf.text + "\u0001";
  }
  const first = leaves[0].node;
  const startLine = src.getLineAndCharacterOfPosition(first.getStart(src)).line + 1;
  return { value, spans, leaves, startLine, top };
}

// ── Analysis ────────────────────────────────────────────────────────────────

/**
 * Derive the registered tool set and action enums, and scan every emitted
 * string unit for tool references.
 */
export function analyzeInstructionStrings(root) {
  const ts = require("typescript");
  const files = sourceFiles(root);
  const tools = new Map(); // name -> [{ file, node, ctx }]
  const units = []; // { file, ctx, ...unit }

  for (const file of files) {
    const ctx = contextFor(ts, file);
    const { src } = ctx;
    const seenTops = new Set();
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const nameProp = node.properties.find(
          (p) =>
            ts.isPropertyAssignment(p) &&
            propName(ts, p.name) === "name" &&
            ts.isStringLiteralLike(unwrap(ts, p.initializer)),
        );
        const paramsProp = node.properties.find(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            (propName(ts, p.name) === "parameters" || propName(ts, p.name) === "parameter"),
        );
        if (nameProp && paramsProp) {
          const name = unwrap(ts, nameProp.initializer).text;
          if (!tools.has(name)) tools.set(name, []);
          tools.get(name).push({ file, node, ctx });
        }
      }
      if (isStringLike(ts, node)) {
        const top = unitTop(ts, node);
        if (!seenTops.has(top)) {
          seenTops.add(top);
          const unit = buildUnit(ts, src, top);
          if (unit) units.push({ file, ctx, ...unit });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }

  // Action enums, derived from each tool's parameter schema; the schema's own
  // property names are collected too, because a parameter name in a string
  // (`parse_mode`) names a knob, not a tool.
  const actionEnums = new Map(); // name -> Set<string>
  const toolsWithAction = new Set(); // tools whose schema declares an action parameter
  const schemaParams = new Set();
  for (const [name, defs] of tools) {
    for (const def of defs) {
      const paramsProp = def.node.properties.find(
        (p) => ts.isPropertyAssignment(p) && propName(ts, p.name) === "parameters",
      );
      if (!paramsProp) continue;
      collectSchemaParamNames(ts, def.ctx, unwrap(ts, paramsProp.initializer), schemaParams, 0);
      const action = findActionProperty(ts, def.ctx, unwrap(ts, paramsProp.initializer));
      if (action) toolsWithAction.add(name);
      if (!action) continue;
      const values = new Set();
      collectEnumValues(ts, action.ctx, action.node, values);
      if (values.size > 0) {
        if (!actionEnums.has(name)) actionEnums.set(name, new Set());
        for (const value of values) actionEnums.get(name).add(value);
      }
    }
  }

  // Tool-reference candidates.
  const BACKTICK = /`([^`\n]*)`/g;
  const CALL = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\(\s*action\s*[=:]\s*["']([a-z_]+)["']/g;
  const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
  const findings = [];
  const scannedStrings = units.length;

  const lineOf = (unit, index) => {
    for (const span of unit.spans) {
      if (index >= span.start && index < span.end) {
        const { node } = span.leaf;
        const position = node.getStart(unit.ctx.src) + (index - span.start);
        return unit.ctx.src.getLineAndCharacterOfPosition(position).line + 1;
      }
    }
    return unit.startLine;
  };

  for (const unit of units) {
    const named = new Set();
    let match;
    BACKTICK.lastIndex = 0;
    while ((match = BACKTICK.exec(unit.value)) !== null) {
      const span = match[1].trim();
      const head = (span.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/) || [null, span])[1];
      const token = head.replace(/\(\)$/, "").replace(/^\.+/, "");
      if (!SNAKE.test(token) && !tools.has(token) && !EXTERNAL_TOOLS.has(token)) continue;
      if (schemaParams.has(token) && !tools.has(token)) continue;
      named.add(token);
      findings.push({
        file: unit.file,
        line: lineOf(unit, match.index + 1),
        token,
        kind: "backtick",
        action: null,
      });
    }

    CALL.lastIndex = 0;
    while ((match = CALL.exec(unit.value)) !== null) {
      named.add(match[1]);
      findings.push({
        file: unit.file,
        line: lineOf(unit, match.index),
        token: match[1],
        kind: "call",
        action: match[2],
      });
    }

    // Family companions: a registered name in the unit makes same-family bare
    // snake_case tokens tool-shaped.
    const companions = new Set();
    for (const tool of tools.keys()) {
      if (new RegExp(`\\b${tool}\\b`).test(unit.value)) companions.add(tool);
    }
    const families = new Set();
    for (const tool of companions) {
      const family = tool.split("_")[0];
      if (tool.includes("_")) families.add(family);
    }
    if (families.size > 0) {
      for (const bare of unit.value.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
        const token = bare[1];
        if (named.has(token) || tools.has(token) || EXTERNAL_TOOLS.has(token)) continue;
        if (schemaParams.has(token) && !tools.has(token)) continue;
        if (!families.has(token.split("_")[0])) continue;
        findings.push({
          file: unit.file,
          line: lineOf(unit, bare.index),
          token,
          kind: "family",
          action: null,
        });
      }
    }
  }

  // Deduplicate identical findings (a leaf can be reached through nested visits).
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.file}:${finding.line}:${finding.token}:${finding.kind}`, finding);
  }
  return {
    ts,
    files,
    tools,
    actionEnums,
    toolsWithAction,
    schemaParams,
    units,
    scannedStrings,
    findings: [...unique.values()],
  };
}

/** Property names anywhere inside a tool's parameter schema, one hop deep. */
function collectSchemaParamNames(ts, ctx, node, out, depth) {
  node = node ? unwrap(ts, node) : node;
  if (!node || depth > 6) return;
  if (ts.isIdentifier(node)) {
    const resolved = resolveIdentifier(ts, ctx, node);
    if (resolved.node !== node || resolved.ctx !== ctx) {
      collectSchemaParamNames(ts, resolved.ctx, resolved.node, out, depth + 1);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
        const name = propName(ts, prop.name);
        if (name) out.add(name);
      }
    }
    return;
  }
  if (ts.isCallExpression(node)) {
    for (const arg of node.arguments) collectSchemaParamNames(ts, ctx, unwrap(ts, arg), out, depth + 1);
  }
}

/**
 * Inline exemption comments: line -> reason. The file's string and template
 * literals are masked before the line scan, so a marker spelled inside a
 * string is text, not an exemption.
 */
function exemptComments(ts, file) {
  const ctx = contextFor(ts, file);
  const text = readFileSync(file, "utf8");
  const chars = [...text];
  const mask = (node) => {
    const start = node.getStart(ctx.src);
    for (let i = start; i < node.getEnd(); i++) chars[i] = " ";
  };
  const visit = (node) => {
    if (isStringLike(ts, node)) mask(node);
    ts.forEachChild(node, visit);
  };
  visit(ctx.src);
  const out = new Map();
  chars.join("").split("\n").forEach((line, i) => {
    const marker =
      line.match(/\/\/\s*tool-ref-exempt:\s*(.+)$/) ||
      line.match(/\/\*\s*tool-ref-exempt:\s*([\s\S]*?)\s*\*\//);
    if (marker) out.set(i + 1, marker[1].trim());
  });
  return out;
}

/**
 * Run the lint against a tree. Returns the reference classes and an exit code;
 * the caller decides how to print them.
 */
export function runInstructionLint(root, { baseline = KNOWN_UNRESOLVED } = {}) {
  const analysis = analyzeInstructionStrings(root);
  const { tools, actionEnums, toolsWithAction, findings, files, scannedStrings } = analysis;

  const exemptByFile = new Map();
  const exemptions = [];
  const unresolved = [];
  const external = [];
  const known = [];
  const staleRows = [];
  const matchedRows = new Set();
  const uncheckedActions = [];

  for (const finding of findings) {
    const search = relative(root, finding.file);
    if (!exemptByFile.has(finding.file)) {
      exemptByFile.set(finding.file, exemptComments(analysis.ts, finding.file));
    }
    const exemption = exemptByFile.get(finding.file).get(finding.line);

    // The finding's problem, if it has one. A registered tool is clean unless
    // a call names an action its schema cannot accept.
    let problem = null;
    let enumValues = null;
    if (tools.has(finding.token)) {
      if (finding.action) {
        const values = actionEnums.get(finding.token);
        if (!toolsWithAction.has(finding.token)) {
          problem = "action-param-missing";
        } else if (!values) {
          uncheckedActions.push({ ...finding, file: search });
          continue;
        } else if (!values.has(finding.action)) {
          problem = "action-not-in-enum";
          enumValues = [...values];
        }
      }
      if (!problem) continue;
    } else if (EXTERNAL_TOOLS.has(finding.token)) {
      external.push({ ...finding, file: search });
      continue;
    } else {
      problem = "tool-not-registered";
    }

    // An inline marker excuses a deliberate mention, a recorded row excuses a
    // known unresolved reference; only the two together can clear a finding.
    if (exemption) {
      exemptions.push({ ...finding, file: search, reason: exemption });
      continue;
    }
    let recorded = false;
    for (const row of baseline) {
      if (row.token === finding.token && (!row.file || row.file === search)) {
        matchedRows.add(row);
        known.push({ ...finding, file: search, reason: row.reason });
        recorded = true;
        break;
      }
    }
    if (!recorded) unresolved.push({ ...finding, file: search, why: problem, enumValues });
  }

  for (const row of baseline) {
    if (!matchedRows.has(row)) staleRows.push(row);
  }

  const exitCode = unresolved.length > 0 || staleRows.length > 0 ? 1 : 0;
  return {
    exitCode,
    files,
    tools,
    actionEnums,
    scannedStrings,
    findings,
    unresolved,
    external,
    known,
    exemptions,
    staleRows,
    uncheckedActions,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const result = runInstructionLint(ROOT);
  let exitCode = result.exitCode;

  if (result.unresolved.length > 0) {
    console.error(`❌ Instruction strings name tools that are not registered (${result.unresolved.length}):\n`);
    for (const finding of result.unresolved) {
      const detail =
        finding.why === "action-param-missing"
          ? `the tool declares no action parameter (a call to it must use the tool's own parameter name)`
          : finding.why === "action-not-in-enum"
            ? `action "${finding.action}" is not in the enum (${finding.enumValues.join(", ")})`
            : "not a registered tool";
      console.error(`  ${finding.file}:${finding.line}  ${finding.token}  (${finding.kind} reference)`);
      console.error(`    ${detail}; register the tool or mark the line \`// tool-ref-exempt: <reason>\``);
    }
    console.error();
  }

  if (result.staleRows.length > 0) {
    console.error(`❌ Baseline rows no longer match a reference (${result.staleRows.length}) - delete the row with the repair:\n`);
    for (const row of result.staleRows) {
      console.error(`  ${row.file}  ${row.token}  (${row.reason})`);
    }
    console.error();
  }

  if (result.uncheckedActions.length > 0) {
    console.log(`ℹ️  Actions not checked - no enum derived for the tool (${result.uncheckedActions.length}):`);
    for (const finding of result.uncheckedActions.slice(0, 10)) {
      console.log(`  ${finding.file}:${finding.line}  ${finding.token}(action="${finding.action}")`);
    }
    if (result.uncheckedActions.length > 10) {
      console.log(`  ... and ${result.uncheckedActions.length - 10} more`);
    }
    console.log();
  }

  if (result.exemptions.length > 0) {
    console.log(`ℹ️  Excused by annotation (${result.exemptions.length}):`);
    for (const finding of result.exemptions) {
      console.log(`  ${finding.file}:${finding.line}  ${finding.token}  (${finding.reason})`);
    }
    console.log();
  }

  console.log(
    `   Registry: ${result.tools.size} registered tool(s), ${result.actionEnums.size} action enum(s) derived, ${result.files.length} source file(s) scanned.`,
  );
  console.log(
    `   References: ${result.findings.length} candidate(s) in ${result.scannedStrings} emitted string unit(s): ` +
      `${result.findings.length - result.unresolved.length - result.known.length - result.exemptions.length - result.external.length} registered, ` +
      `${result.external.length} external, ${result.exemptions.length} excused by annotation, ${result.known.length} known unresolved.`,
  );

  if (exitCode === 0) {
    console.log(
      `✅ check-instruction-strings: clean (every reference resolves, ${result.exemptions.length} excused, ${result.known.length} known unresolved).`,
    );
  }
  process.exit(exitCode);
}
