/**
 * Read the design tokens out of a `DESIGN.md` file.
 *
 * The format is YAML: a front-matter block at the top of the file, or fenced
 * `yaml` blocks beside the prose that documents each section. This module reads
 * the scalar leaves of the three token sections an audit can compare with
 * measured CSS values - `typography`, `spacing` and `rounded` - and normalises
 * dimensions to CSS pixels. It is not a YAML parser: block scalars, flow
 * collections and inline comments are skipped, while the `key: value` nests
 * the token format actually uses are read.
 *
 * Pure: the caller reads the file, this parses the text.
 */

export interface TokenPresence {
  fontSizes: boolean;
  fontWeights: boolean;
  lineHeights: boolean;
  spacings: boolean;
  radii: boolean;
}

/** Token values in the units the audit compares against: CSS pixels and numbers. */
export interface DesignTokens {
  /** `typography.*.fontSize`, px. */
  fontSizes: number[];
  /** `typography.*.fontWeight`. */
  fontWeights: number[];
  /** `typography.*.lineHeight`, px (unitless multipliers resolved with the entry's size). */
  lineHeights: number[];
  /** `spacing.*`, px. */
  spacings: number[];
  /** `rounded.*`, px. Percentage radii are not comparable and are skipped. */
  radii: number[];
  /** A section is present only when it yielded at least one comparable value. */
  present: TokenPresence;
  /** Scalar token leaves read from the three sections, for reporting. */
  tokenCount: number;
}

export const NO_TOKENS: DesignTokens = {
  fontSizes: [],
  fontWeights: [],
  lineHeights: [],
  spacings: [],
  radii: [],
  present: {
    fontSizes: false,
    fontWeights: false,
    lineHeights: false,
    spacings: false,
    radii: false,
  },
  tokenCount: 0,
};

interface Scalar {
  path: string[];
  value: string;
}

interface StackKey {
  indent: number;
  key: string;
}

/** Quoted scalar keys drop their quotes; unquoted keys are trimmed. */
function unquoteKey(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** A scalar value: quoted strings keep their contents, inline comments are cut. */
function scalarValue(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  const comment = text.indexOf(" #");
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

const KEY_LINE = /^([^:#][^:]*?):(?:\s+(.*))?$/;

/**
 * Scalar leaves of one YAML block, with their key path. A block scalar
 * (`description: >-`) is consumed to its dedent so its prose is not read as
 * keys.
 */
function parseBlock(lines: string[]): Scalar[] {
  const out: Scalar[] = [];
  const stack: StackKey[] = [];
  let blockIndent = -1;

  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (trimmed.startsWith("#") || trimmed === "---" || trimmed === "...") {
      continue;
    }

    const match = KEY_LINE.exec(trimmed);
    if (!match) continue;
    const key = unquoteKey(match[1]);
    const raw = (match[2] ?? "").trim();

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (raw === "") {
      stack.push({ indent, key });
      continue;
    }
    if (/^[>|][+-]?(?:\s|$)/.test(raw)) {
      blockIndent = indent;
      continue;
    }
    if (raw.startsWith("[") || raw.startsWith("{")) continue;
    out.push({
      path: [...stack.map((entry) => entry.key), key],
      value: scalarValue(raw),
    });
  }
  return out;
}

/** Front matter (the first `---` pair) and every fenced yaml block. */
function blocksOf(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  const blocks: string[][] = [];

  if (lines.length > 0 && lines[0].trim() === "---") {
    const end = lines.findIndex(
      (line, index) => index > 0 && line.trim() === "---",
    );
    if (end > 0) blocks.push(lines.slice(1, end));
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*```ya?ml\s*$/i.test(lines[index])) continue;
    const end = lines.findIndex(
      (line, at) => at > index && /^\s*```\s*$/.test(line),
    );
    if (end === -1) break;
    blocks.push(lines.slice(index + 1, end));
    index = end;
  }
  return blocks;
}

type Tree = { [key: string]: Tree | string };

function setPath(tree: Tree, path: string[], value: string): void {
  let cursor = tree;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const next = cursor[key];
    if (typeof next !== "object" || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Tree;
  }
  cursor[path[path.length - 1]] = value;
}

function asTree(value: unknown): Tree | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Tree)
    : null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const DIMENSION = /^(-?\d+(?:\.\d+)?)(px|rem|em|pt)?$/i;

/**
 * A CSS dimension in px. Unitless numbers are read as px when `basePx` is
 * null, and as a multiplier of it otherwise (`line-height: 1.5`).
 */
function dimensionPx(
  value: unknown,
  basePx: number | null = null,
  defaultPx = 16,
): number | null {
  if (typeof value !== "string") return null;
  const match = DIMENSION.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "")
    return basePx === null ? round3(amount) : round3(amount * basePx);
  if (unit === "px") return round3(amount);
  if (unit === "rem") return round3(amount * defaultPx);
  if (unit === "em") {
    return round3(amount * (basePx ?? defaultPx));
  }
  if (unit === "pt") return round3((amount * 4) / 3);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const amount = Number(value.trim());
  return Number.isFinite(amount) ? round3(amount) : null;
}

function uniqSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Walk one section's entries; leaves may be a flat map or one nesting deeper. */
function sectionLeaves(
  section: Tree | null,
  convert: (value: string) => number | null,
): number[] {
  if (section === null) return [];
  const out: number[] = [];
  for (const value of Object.values(section)) {
    if (typeof value === "string") {
      const parsed = convert(value);
      if (parsed !== null) out.push(parsed);
      continue;
    }
    for (const leaf of Object.values(value)) {
      if (typeof leaf !== "string") continue;
      const parsed = convert(leaf);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

/**
 * Parse the token file. A file with no readable token section yields
 * `NO_TOKENS`, whose `present` flags are all false, so the audit reports no
 * verdict instead of calling every measured value absent.
 */
export function parseDesignTokens(text: string): DesignTokens {
  const tree: Tree = {};
  for (const lines of blocksOf(text)) {
    for (const scalar of parseBlock(lines)) {
      setPath(tree, scalar.path, scalar.value);
    }
  }

  const fontSizes: number[] = [];
  const fontWeights: number[] = [];
  const lineHeights: number[] = [];

  const typography = asTree(tree.typography);
  if (typography !== null) {
    for (const entry of Object.values(typography)) {
      const record = asTree(entry);
      if (record === null) continue;
      const size = dimensionPx(record.fontSize);
      if (size !== null) fontSizes.push(size);
      const weight = numberValue(record.fontWeight);
      if (weight !== null) fontWeights.push(weight);
      if (typeof record.lineHeight === "string") {
        const height = dimensionPx(record.lineHeight, size);
        if (height !== null) lineHeights.push(height);
      }
    }
  }

  const spacings = sectionLeaves(asTree(tree.spacing), (value) =>
    dimensionPx(value),
  );
  const radii = sectionLeaves(asTree(tree.rounded), (value) =>
    dimensionPx(value),
  );

  return {
    fontSizes: uniqSorted(fontSizes),
    fontWeights: uniqSorted(fontWeights),
    lineHeights: uniqSorted(lineHeights),
    spacings: uniqSorted(spacings),
    radii: uniqSorted(radii),
    present: {
      fontSizes: fontSizes.length > 0,
      fontWeights: fontWeights.length > 0,
      lineHeights: lineHeights.length > 0,
      spacings: spacings.length > 0,
      radii: radii.length > 0,
    },
    tokenCount:
      fontSizes.length +
      fontWeights.length +
      lineHeights.length +
      spacings.length +
      radii.length,
  };
}
