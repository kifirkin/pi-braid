/**
 * The ruler's pure half: a snapshot of one rendered page in, an audit out.
 *
 * No I/O, no clock, no randomness. The adapter records the snapshot; this
 * module decides what it measures, so a gate can run on files and produce the
 * same numbers on a machine with no browser.
 *
 * A snapshot is a flat array of node records in document order. Every child
 * index is greater than its parent's, which lets the ancestor walk for an
 * effective background stay a linear memo instead of a re-traversal per node.
 *
 * Bounds, stated because a measurement that hides them is a lie:
 * - colour coverage paints node boxes in document order; sibling overlap is
 *   resolved topmost-last, and z-index is not read;
 * - a background narrower than its element box (gradient, image, clip) is
 *   counted as the element box in its computed solid colour;
 * - text contrast reads the element's own computed colour and direct text, so
 *   a painted decoration behind the glyphs is not modelled;
 * - the inline-text exemption from the 44px pointer-target rule is not
 *   applied: a link box below the minimum is reported.
 */

import {
  composite,
  contrastRatio,
  parseColor,
  toHex,
  type Rgba,
} from "./colors.js";
import { NO_TOKENS, type DesignTokens } from "./tokens.js";

export interface SnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The computed style fields the audit reads. */
export interface SnapshotStyle {
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  borderRadius: string;
  boxShadow: string;
  display: string;
  visibility: string;
  opacity: string;
}

export interface SnapshotNode {
  /** Lowercase tag name. */
  tag: string;
  /** Stable selector path from `html`, tag plus `:nth-of-type`. */
  path: string;
  /** Index of the parent node, or null for the root. Always below the node's index. */
  parent: number | null;
  rect: SnapshotRect;
  style: SnapshotStyle;
  /** Direct text of the element, whitespace collapsed; empty when it is a container. */
  text: string;
  /** Code points in `text`. */
  textLength: number;
  interactive: boolean;
  scrollWidth: number;
  clientWidth: number;
}

export interface Snapshot {
  /** Recording metadata; never measured. */
  url?: string;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth?: number;
  documentHeight: number;
  /** The opaque colour the browser paints behind the page. */
  canvasColor: string;
  nodes: SnapshotNode[];
}

export interface AuditOptions {
  designTokens?: DesignTokens | null;
  /** Smallest accepted pointer target, both axes. */
  minTargetPx?: number;
  /** Spacing values are on-grid when they are a multiple of this. */
  gridStepPx?: number;
}

export interface ValueUse {
  /** The value as rendered, for example `16px`, `400`, `normal`, or a shadow. */
  value: string;
  /** The comparable number: px for dimensions, the weight itself; null otherwise. */
  numeric: number | null;
  count: number;
  /** On the type scale (font sizes) or the spacing grid; null where not judged. */
  onGrid: boolean | null;
  /** In the project token file; null when the file has no comparable section. */
  inTokens: boolean | null;
}

export interface Inventory {
  fontSizes: ValueUse[];
  fontWeights: ValueUse[];
  lineHeights: ValueUse[];
  spacings: ValueUse[];
  radii: ValueUse[];
  shadows: ValueUse[];
}

export interface ContrastFailure {
  path: string;
  text: string;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  fontSizePx: number;
  fontWeight: number;
}

export interface ContrastReport {
  /** Text-bearing elements measured. */
  checked: number;
  /** Text-bearing elements whose colour or size could not be read. */
  skipped: number;
  failures: ContrastFailure[];
}

export interface ColorUse {
  value: string;
  coverage: number;
  area: number;
}

export interface TapTarget {
  path: string;
  width: number;
  height: number;
}

export interface OverflowFinding {
  path: string;
  reason: "scroll" | "viewport";
  right: number;
  scrollWidth: number;
  clientWidth: number;
}

export interface FindingsCount {
  contrast: number;
  offGrid: number;
  missingTokens: number;
  tapTargets: number;
  overflow: number;
  total: number;
}

export interface WidthAudit {
  width: number;
  documentHeight: number;
  colors: ColorUse[];
  /** Sum of the rounded colour percentages; 100 when the page has area. */
  coverageTotal: number;
  contrast: ContrastReport;
  inventory: Inventory;
  tapTargets: TapTarget[];
  overflow: OverflowFinding[];
  findings: FindingsCount;
}

export interface FindingsAtWidth extends FindingsCount {
  width: number;
}

export interface Audit {
  target: string | null;
  widths: WidthAudit[];
  params: {
    minTargetPx: number;
    gridStepPx: number;
    typeScale: number[];
    tokenFile: boolean;
    tokenCount: number;
  };
  /** The narrowest measured width: the width a report names as its verdict. */
  findings: FindingsAtWidth;
}

const DEFAULT_MIN_TARGET = 44;
const DEFAULT_GRID_STEP = 4;

/** Type sizes treated as a scale when the project has no type tokens. */
export const DEFAULT_TYPE_SCALE = [12, 14, 16, 18, 20, 24, 30, 32, 36, 48, 60];

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

function pxValue(value: number): string {
  return `${formatNumber(value)}px`;
}

function parsePx(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

function parseNumber(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const amount = Number(value.trim());
  return Number.isFinite(amount) ? amount : null;
}

function near(a: number, b: number, epsilon = 0.0005): boolean {
  return Math.abs(a - b) < epsilon;
}

function assertSnapshot(snapshot: Snapshot, where: string): void {
  if (snapshot === null || typeof snapshot !== "object") {
    throw new Error(`${where}: snapshot is not an object`);
  }
  if (
    !(snapshot.viewportWidth > 0) ||
    !Number.isFinite(snapshot.viewportWidth)
  ) {
    throw new Error(`${where}: viewportWidth must be a positive number`);
  }
  if (
    !(snapshot.documentHeight > 0) ||
    !Number.isFinite(snapshot.documentHeight)
  ) {
    throw new Error(`${where}: documentHeight must be a positive number`);
  }
  if (!Array.isArray(snapshot.nodes)) {
    throw new Error(`${where}: nodes must be an array`);
  }
  for (let index = 0; index < snapshot.nodes.length; index += 1) {
    const node = snapshot.nodes[index];
    if (node === null || typeof node !== "object") {
      throw new Error(`${where}: node ${index} is not an object`);
    }
    if (typeof node.path !== "string" || node.path === "") {
      throw new Error(`${where}: node ${index} has no selector path`);
    }
    if (
      node.parent !== null &&
      (!Number.isInteger(node.parent) ||
        node.parent < 0 ||
        node.parent >= index)
    ) {
      throw new Error(
        `${where}: node ${index} (${node.path}) has parent ${String(node.parent)}, ` +
          "which is not an earlier node; snapshots must be in document order",
      );
    }
    const rect = node.rect;
    if (
      rect === null ||
      typeof rect !== "object" ||
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height)
    ) {
      throw new Error(
        `${where}: node ${index} (${node.path}) has no numeric rect`,
      );
    }
    if (node.style === null || typeof node.style !== "object") {
      throw new Error(`${where}: node ${index} (${node.path}) has no style`);
    }
  }
}

function isRendered(node: SnapshotNode): boolean {
  if (node.style.display === "none") return false;
  if (
    node.style.visibility === "hidden" ||
    node.style.visibility === "collapse"
  ) {
    return false;
  }
  if (node.rect.width <= 0 || node.rect.height <= 0) return false;
  const opacity = parseNumber(node.style.opacity);
  if (opacity !== null && opacity <= 0) return false;
  return true;
}

function hasText(node: SnapshotNode): boolean {
  return node.textLength > 0 && node.text.trim() !== "";
}

function largeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontWeight >= 700 && fontSizePx >= 18.66);
}

interface Layer {
  color: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  order: number;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Subtract already-painted y intervals from one layer's interval. */
function uncovered(
  y0: number,
  y1: number,
  covered: Array<[number, number]>,
): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let cursor = y0;
  for (const [start, end] of covered) {
    if (end <= cursor) continue;
    if (start >= y1) break;
    if (start > cursor) pieces.push([cursor, Math.min(start, y1)]);
    cursor = Math.max(cursor, end);
    if (cursor >= y1) break;
  }
  if (cursor < y1) pieces.push([cursor, y1]);
  return pieces;
}

function mergeIntervals(intervals: Array<[number, number]>): void {
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let write = 0;
  for (let read = 0; read < intervals.length; read += 1) {
    if (write > 0 && intervals[read][0] <= intervals[write - 1][1]) {
      intervals[write - 1][1] = Math.max(
        intervals[write - 1][1],
        intervals[read][1],
      );
      continue;
    }
    intervals[write] = intervals[read];
    write += 1;
  }
  intervals.length = write;
}

interface ValueBucket {
  numeric: number | null;
  count: number;
}

function bump(
  bucket: Map<string, ValueBucket>,
  value: string,
  numeric: number | null,
): void {
  const existing = bucket.get(value);
  if (existing) {
    existing.count += 1;
    return;
  }
  bucket.set(value, { numeric, count: 1 });
}

function valueUses(
  bucket: Map<string, ValueBucket>,
  judge: (numeric: number | null) => {
    onGrid: boolean | null;
    inTokens: boolean | null;
  },
): ValueUse[] {
  return [...bucket.entries()]
    .map(([value, entry]) => {
      const judged = judge(entry.numeric);
      return {
        value,
        numeric: entry.numeric,
        count: entry.count,
        onGrid: judged.onGrid,
        inTokens: judged.inTokens,
      };
    })
    .sort((a, b) => {
      const left = a.numeric ?? Number.POSITIVE_INFINITY;
      const right = b.numeric ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left - right;
      return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    });
}

function verdict(
  numeric: number | null,
  values: number[],
  present: boolean,
): boolean | null {
  if (!present || numeric === null) return null;
  return values.some((value) => near(value, numeric));
}

/** Measure one snapshot. Throws on a malformed snapshot; never on a weird page. */
export function auditSnapshot(
  snapshot: Snapshot,
  options: AuditOptions = {},
): WidthAudit {
  assertSnapshot(snapshot, "auditSnapshot");

  const tokens = options.designTokens ?? NO_TOKENS;
  const minTargetPx = options.minTargetPx ?? DEFAULT_MIN_TARGET;
  const gridStepPx = options.gridStepPx ?? DEFAULT_GRID_STEP;
  const width = snapshot.viewportWidth;
  const height = snapshot.documentHeight;
  const pageArea = width * height;
  const nodes = snapshot.nodes;

  const canvasBase = parseColor(snapshot.canvasColor) ?? WHITE;
  const canvas = canvasBase.a >= 1 ? canvasBase : composite(canvasBase, WHITE);

  const backgrounds: Array<Rgba | undefined> = new Array(nodes.length);

  /** The opaque colour painted behind this element, ancestors included. */
  function backgroundAt(index: number): Rgba {
    const chain: number[] = [];
    let base = canvas;
    let cursor: number | null = index;
    while (cursor !== null) {
      const cached = backgrounds[cursor];
      if (cached !== undefined) {
        base = cached;
        break;
      }
      chain.push(cursor);
      const parent: number | null = nodes[cursor].parent;
      cursor = parent === null || parent >= cursor ? null : parent;
    }
    for (let at = chain.length - 1; at >= 0; at -= 1) {
      const node = nodes[chain[at]];
      const own = parseColor(node.style.backgroundColor);
      if (own !== null && own.a > 0) {
        base = composite(own, base);
        if (base.a < 1) base = composite(base, canvas);
      }
      backgrounds[chain[at]] = base;
    }
    return base;
  }

  // Contrast: direct text against the flattened background.
  const failures: ContrastFailure[] = [];
  let checked = 0;
  let skipped = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isRendered(node) || !hasText(node)) continue;
    const foreground = parseColor(node.style.color);
    const fontSizePx = parsePx(node.style.fontSize);
    const fontWeight = parseNumber(node.style.fontWeight);
    // A transparent computed colour is text painted by something else (a
    // gradient clipped to the glyphs, an image fill); its contrast is not in
    // the record, so it is skipped rather than measured as background-on-background.
    if (
      foreground === null ||
      foreground.a <= 0 ||
      fontSizePx === null ||
      fontWeight === null
    ) {
      skipped += 1;
      continue;
    }
    const background = backgroundAt(index);
    const flattenedForeground = toHex(composite(foreground, background));
    const ratio = contrastRatio(foreground, background);
    const required = largeText(fontSizePx, fontWeight) ? 3 : 4.5;
    checked += 1;
    if (ratio + 1e-9 < required) {
      failures.push({
        path: node.path,
        text:
          node.text.length > 80 ? `${node.text.slice(0, 77)}...` : node.text,
        foreground: flattenedForeground,
        background: toHex(background),
        ratio: round2(ratio),
        required,
        fontSizePx: round2(fontSizePx),
        fontWeight: round2(fontWeight),
      });
    }
  }
  failures.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Colour coverage: page area, topmost painted box per region.
  const layers: Layer[] = [
    { color: toHex(canvas), x0: 0, y0: 0, x1: width, y1: height, order: -1 },
  ];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isRendered(node)) continue;
    const own = parseColor(node.style.backgroundColor);
    if (own === null || own.a <= 0) continue;
    const x0 = Math.max(0, node.rect.x);
    const y0 = Math.max(0, node.rect.y);
    const x1 = Math.min(width, node.rect.x + node.rect.width);
    const y1 = Math.min(height, node.rect.y + node.rect.height);
    if (x1 <= x0 || y1 <= y0) continue;
    layers.push({
      color: toHex(backgroundAt(index)),
      x0,
      y0,
      x1,
      y1,
      order: index,
    });
  }

  const areas = new Map<string, number>();
  if (pageArea > 0 && layers.length > 0) {
    const xs = uniqueSorted(layers.flatMap((layer) => [layer.x0, layer.x1]));
    for (let xi = 0; xi < xs.length - 1; xi += 1) {
      const x0 = xs[xi];
      const x1 = xs[xi + 1];
      if (x1 <= x0) continue;
      const active = layers
        .filter((layer) => layer.x0 <= x0 && layer.x1 >= x1)
        .sort((a, b) => b.order - a.order);
      if (active.length === 0) continue;
      const covered: Array<[number, number]> = [];
      for (const layer of active) {
        for (const [y0, y1] of uncovered(layer.y0, layer.y1, covered)) {
          const area = (x1 - x0) * (y1 - y0);
          areas.set(layer.color, (areas.get(layer.color) ?? 0) + area);
        }
        covered.push([layer.y0, layer.y1]);
        mergeIntervals(covered);
      }
    }
  }

  // Percentages are a partition of the page: apportion the rounding so the
  // printed values sum to exactly 100.00 instead of drifting by the cents each
  // independent round-off loses.
  interface Draft {
    value: string;
    area: number;
    cents: number;
    remainder: number;
  }
  const drafts: Draft[] = [...areas.entries()].map(([value, area]) => {
    const exact = pageArea > 0 ? (area / pageArea) * 100 : 0;
    const cents = Math.floor(exact * 100 + 1e-9);
    return {
      value,
      area: round2(area),
      cents,
      remainder: exact * 100 - cents,
    };
  });
  const targetCents = pageArea > 0 ? 10000 : 0;
  let assigned = drafts.reduce((sum, draft) => sum + draft.cents, 0);
  const byRemainder = [...drafts].sort((a, b) =>
    b.remainder !== a.remainder
      ? b.remainder - a.remainder
      : a.value < b.value
        ? -1
        : a.value > b.value
          ? 1
          : 0,
  );
  for (const draft of byRemainder) {
    if (assigned >= targetCents) break;
    draft.cents += 1;
    assigned += 1;
  }
  for (
    let at = byRemainder.length - 1;
    at >= 0 && assigned > targetCents;
    at -= 1
  ) {
    const draft = byRemainder[at];
    if (draft.cents === 0) continue;
    draft.cents -= 1;
    assigned -= 1;
  }
  const colors: ColorUse[] = drafts
    .map((draft) => ({
      value: draft.value,
      coverage: draft.cents / 100,
      area: draft.area,
    }))
    .sort((a, b) =>
      b.coverage !== a.coverage
        ? b.coverage - a.coverage
        : a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0,
    );
  const coverageTotal = round2(
    colors.reduce((sum, color) => sum + color.coverage, 0),
  );

  // The value inventory.
  const fontSizes = new Map<string, ValueBucket>();
  const fontWeights = new Map<string, ValueBucket>();
  const lineHeights = new Map<string, ValueBucket>();
  const spacings = new Map<string, ValueBucket>();
  const radii = new Map<string, ValueBucket>();
  const shadows = new Map<string, ValueBucket>();

  for (const node of nodes) {
    if (!isRendered(node)) continue;
    if (hasText(node)) {
      const size = parsePx(node.style.fontSize);
      if (size !== null) bump(fontSizes, pxValue(size), size);
      const weight = parseNumber(node.style.fontWeight);
      if (weight !== null) bump(fontWeights, formatNumber(weight), weight);
      const heightPx = parsePx(node.style.lineHeight);
      if (heightPx !== null) {
        bump(lineHeights, pxValue(heightPx), heightPx);
      } else if (node.style.lineHeight.trim() !== "") {
        bump(lineHeights, node.style.lineHeight.trim(), null);
      }
    }

    const sides = [
      node.style.marginTop,
      node.style.marginRight,
      node.style.marginBottom,
      node.style.marginLeft,
      node.style.paddingTop,
      node.style.paddingRight,
      node.style.paddingBottom,
      node.style.paddingLeft,
    ];
    for (const side of sides) {
      const value = parsePx(side);
      if (value === null || value === 0) continue;
      bump(spacings, pxValue(value), value);
    }

    const radiusTokens = new Set(
      node.style.borderRadius.split("/")[0].trim().split(/\s+/).filter(Boolean),
    );
    for (const token of radiusTokens) {
      const value = parsePx(token);
      if (value !== null) {
        if (value === 0) continue;
        bump(radii, pxValue(value), value);
      } else if (/^\d+(?:\.\d+)?%$/.test(token)) {
        bump(radii, token, null);
      }
    }

    const shadow = node.style.boxShadow.trim();
    if (shadow !== "" && shadow !== "none") {
      bump(shadows, shadow, null);
    }
  }

  const typeScale =
    tokens.present.fontSizes && tokens.fontSizes.length > 0
      ? tokens.fontSizes
      : DEFAULT_TYPE_SCALE;

  const inventory: Inventory = {
    fontSizes: valueUses(fontSizes, (numeric) => ({
      onGrid:
        numeric === null ? null : typeScale.some((size) => near(size, numeric)),
      inTokens: verdict(numeric, tokens.fontSizes, tokens.present.fontSizes),
    })),
    fontWeights: valueUses(fontWeights, (numeric) => ({
      onGrid: null,
      inTokens: verdict(
        numeric,
        tokens.fontWeights,
        tokens.present.fontWeights,
      ),
    })),
    lineHeights: valueUses(lineHeights, (numeric) => ({
      onGrid: null,
      inTokens: verdict(
        numeric,
        tokens.lineHeights,
        tokens.present.lineHeights,
      ),
    })),
    spacings: valueUses(spacings, (numeric) => ({
      onGrid:
        numeric === null
          ? null
          : near(numeric % gridStepPx, 0, 0.001) ||
            near(numeric % gridStepPx, gridStepPx, 0.001),
      inTokens: verdict(numeric, tokens.spacings, tokens.present.spacings),
    })),
    radii: valueUses(radii, (numeric) => ({
      onGrid: null,
      inTokens: verdict(numeric, tokens.radii, tokens.present.radii),
    })),
    shadows: valueUses(shadows, () => ({ onGrid: null, inTokens: null })),
  };

  // Tap targets.
  const tapTargets: TapTarget[] = [];
  for (const node of nodes) {
    if (!node.interactive || !isRendered(node)) continue;
    if (node.rect.width >= minTargetPx && node.rect.height >= minTargetPx) {
      continue;
    }
    tapTargets.push({
      path: node.path,
      width: round2(node.rect.width),
      height: round2(node.rect.height),
    });
  }
  tapTargets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Overflow: the element's own scrollbox, or its right edge past the viewport.
  const overflow: OverflowFinding[] = [];
  for (const node of nodes) {
    if (node.tag === "html" || node.tag === "body") continue;
    if (!isRendered(node)) continue;
    if (node.style.display === "inline" || node.style.display === "contents") {
      continue;
    }
    const right = node.rect.x + node.rect.width;
    if (node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1) {
      overflow.push({
        path: node.path,
        reason: "scroll",
        right: round2(right),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      });
      continue;
    }
    if (right > width + 0.5) {
      overflow.push({
        path: node.path,
        reason: "viewport",
        right: round2(right),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      });
    }
  }
  overflow.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const inventoryValues = [
    ...inventory.fontSizes,
    ...inventory.fontWeights,
    ...inventory.lineHeights,
    ...inventory.spacings,
    ...inventory.radii,
    ...inventory.shadows,
  ];
  const offGrid = inventoryValues.filter(
    (value) => value.onGrid === false,
  ).length;
  const missingTokens = inventoryValues.filter(
    (value) => value.inTokens === false,
  ).length;
  const findings: FindingsCount = {
    contrast: failures.length,
    offGrid,
    missingTokens,
    tapTargets: tapTargets.length,
    overflow: overflow.length,
    total: 0,
  };
  findings.total =
    findings.contrast +
    findings.offGrid +
    findings.missingTokens +
    findings.tapTargets +
    findings.overflow;

  return {
    width,
    documentHeight: round2(height),
    colors,
    coverageTotal,
    contrast: { checked, skipped, failures },
    inventory,
    tapTargets,
    overflow,
    findings,
  };
}

/**
 * Measure a set of snapshots, one per width. Widths are sorted ascending and
 * must be unique; the narrowest width supplies the audit-level verdict.
 */
export function auditSnapshots(
  snapshots: Snapshot[],
  options: AuditOptions = {},
): Audit {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("auditSnapshots: at least one snapshot is required");
  }
  const sorted = [...snapshots].sort(
    (a, b) => a.viewportWidth - b.viewportWidth,
  );
  const seen = new Set<number>();
  for (const snapshot of sorted) {
    if (seen.has(snapshot.viewportWidth)) {
      throw new Error(
        `auditSnapshots: duplicate snapshot width ${snapshot.viewportWidth}`,
      );
    }
    seen.add(snapshot.viewportWidth);
  }
  const widths = sorted.map((snapshot) => auditSnapshot(snapshot, options));
  const narrowest = widths[0];

  const tokens = options.designTokens ?? NO_TOKENS;
  return {
    target: sorted[0].url ?? null,
    widths,
    params: {
      minTargetPx: options.minTargetPx ?? DEFAULT_MIN_TARGET,
      gridStepPx: options.gridStepPx ?? DEFAULT_GRID_STEP,
      typeScale:
        tokens.present.fontSizes && tokens.fontSizes.length > 0
          ? tokens.fontSizes
          : DEFAULT_TYPE_SCALE,
      tokenFile: tokens !== NO_TOKENS,
      tokenCount: tokens.tokenCount,
    },
    findings: { width: narrowest.width, ...narrowest.findings },
  };
}
