/**
 * The board's pure half: several rendered answers to one screen in, a
 * comparison page and its manifest out.
 *
 * The ruler measures (`./audit.ts`) and the adapter renders
 * (`./adapter.ts`); this module decides only what a board is: which numbers a
 * choice turns on, which value in each column is best, and what the record
 * says while nobody has chosen.
 *
 * Nothing here reads a clock, and the manifest carries no timestamp. The
 * record is what `--check` compares a fresh render against, so a record that
 * changed on every run could never be checked; the page digest is derived
 * from the manifest, not stamped beside it.
 */

import { createHash } from "node:crypto";
import type { FindingsCount, Snapshot, WidthAudit } from "./audit.js";
import { auditSnapshot } from "./audit.js";
import { renderBoardPage, type BoardShot } from "./board-page.js";

/** Manifest schema. A change here invalidates every recorded board. */
export const BOARD_FORMAT_VERSION = 1;

export type MetricDirection = "lower" | "higher" | null;

/** How a metric's per-width values become the one number a column compares. */
export type MetricAggregate = "worst" | "least";

export type BoardMetricId =
  | "contrastFailures"
  | "worstRatio"
  | "tapTargets"
  | "overflow"
  | "distinctValues"
  | "palette"
  | "dominantShare";

export interface BoardMetric {
  id: BoardMetricId;
  label: string;
  unit: string;
  direction: MetricDirection;
  aggregate: MetricAggregate;
  detail: string;
}

/**
 * The numbers a choice turns on, in the order the table prints them.
 *
 * `direction` is the whole point of a comparison and is stated per metric
 * rather than assumed: a count of failures is better small, a ratio better
 * large, and the dominant colour's share has no better direction at all, so
 * that column is printed and never marked.
 */
export const BOARD_METRICS: BoardMetric[] = [
  {
    id: "contrastFailures",
    label: "contrast failures",
    unit: "pairs",
    direction: "lower",
    aggregate: "worst",
    detail: "Text pairs below their WCAG minimum, at the worst measured width.",
  },
  {
    id: "worstRatio",
    label: "weakest ratio",
    unit: ":1",
    direction: "higher",
    aggregate: "least",
    detail:
      "The lowest ratio any text pair reached. A page can pass every pair and still creep toward the line, so the weakest number is watched, not only the failures.",
  },
  {
    id: "tapTargets",
    label: "tap targets < 44px",
    unit: "",
    direction: "lower",
    aggregate: "worst",
    detail: "Interactive boxes narrower or shorter than the 44px minimum.",
  },
  {
    id: "overflow",
    label: "overflow",
    unit: "",
    direction: "lower",
    aggregate: "worst",
    detail:
      "Elements wider than the viewport or scrolling inside their own box.",
  },
  {
    id: "distinctValues",
    label: "distinct values",
    unit: "",
    direction: "lower",
    aggregate: "worst",
    detail:
      "Font sizes, weights, line heights, spacings, radii and shadows, each counted once. Fewer is a tighter system.",
  },
  {
    id: "palette",
    label: "palette",
    unit: "colours",
    direction: "lower",
    aggregate: "worst",
    detail: "Distinct painted background colours, page ground included.",
  },
  {
    id: "dominantShare",
    label: "dominant colour",
    unit: "%",
    direction: null,
    aggregate: "worst",
    detail:
      "The share its largest colour covers. Printed for the record: neither flatter nor more varied is the better page, so no cell in this column is marked.",
  },
];

export interface BoardDecision {
  variant: string;
  reason: string;
}

export interface BoardVariantSource {
  name: string;
  /** A path or URL as the caller named it; relative paths resolve beside the manifest. */
  source: string;
  sourceKind: "file" | "url";
}

export interface BoardValueCounts {
  total: number;
  fontSizes: number;
  fontWeights: number;
  lineHeights: number;
  spacings: number;
  radii: number;
  shadows: number;
  offGrid: number;
}

export interface BoardWidthRecord {
  width: number;
  documentHeight: number;
  findings: FindingsCount;
  contrast: {
    checked: number;
    skipped: number;
    failing: number;
    smallest: number | null;
    failingPaths: string[];
  };
  tapTargets: number;
  tapTargetPaths: string[];
  overflow: number;
  overflowPaths: string[];
  values: BoardValueCounts;
  palette: number;
  dominant: { value: string; coverage: number } | null;
}

export interface BoardVariantRecord {
  name: string;
  source: string;
  sourceKind: "file" | "url";
  aggregate: Record<string, number | null>;
  widths: BoardWidthRecord[];
}

/** The metric set as the record states it, so an old board keeps its own rules. */
export interface BoardManifestMetric {
  id: BoardMetricId;
  label: string;
  unit: string;
  direction: MetricDirection;
  aggregate: MetricAggregate;
}

export interface BoardManifest {
  format: number;
  tool: "design_board";
  toolVersion: string;
  title: string;
  pageDigest: string;
  widths: number[];
  decision: BoardDecision | null;
  metrics: BoardManifestMetric[];
  variants: BoardVariantRecord[];
}

export interface BoardVariantInput extends BoardVariantSource {
  snapshots: Snapshot[];
}

export interface BoardInput {
  variants: BoardVariantInput[];
  widths: number[];
  decision?: BoardDecision | null;
  toolVersion: string;
  title?: string;
  shots?: BoardShot[];
}

export interface BoardCell {
  metric: BoardMetricId;
  value: number | null;
  /** The value as the page prints it. */
  display: string;
  /** The colour behind a share metric, for a swatch. */
  colour: string | null;
  best: boolean;
}

export interface BoardRow {
  name: string;
  cells: BoardCell[];
}

export interface BoardTable {
  metrics: BoardManifestMetric[];
  rows: BoardRow[];
  /** True when at least one column has two comparable values to mark. */
  marks: boolean;
  note: string;
}

export interface ComposedBoard {
  manifest: BoardManifest;
  table: BoardTable;
  html: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameNumber(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-9;
}

function manifestMetric(metric: BoardMetric): BoardManifestMetric {
  return {
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    direction: metric.direction,
    aggregate: metric.aggregate,
  };
}

/** A painted box's own count per family, taken from the ruler's inventory. */
function valueCounts(audit: WidthAudit): BoardValueCounts {
  const inventory = audit.inventory;
  const families = [
    inventory.fontSizes,
    inventory.fontWeights,
    inventory.lineHeights,
    inventory.spacings,
    inventory.radii,
    inventory.shadows,
  ];
  return {
    fontSizes: inventory.fontSizes.length,
    fontWeights: inventory.fontWeights.length,
    lineHeights: inventory.lineHeights.length,
    spacings: inventory.spacings.length,
    radii: inventory.radii.length,
    shadows: inventory.shadows.length,
    total: families.reduce((sum, family) => sum + family.length, 0),
    offGrid: families.reduce(
      (sum, family) =>
        sum + family.filter((use) => use.onGrid === false).length,
      0,
    ),
  };
}

function widthRecord(snapshot: Snapshot, audit: WidthAudit): BoardWidthRecord {
  const dominant = audit.colors[0] ?? null;
  return {
    width: audit.width,
    documentHeight: audit.documentHeight,
    findings: audit.findings,
    contrast: {
      checked: audit.contrast.checked,
      skipped: audit.contrast.skipped,
      failing: audit.contrast.failures.length,
      smallest: audit.contrast.smallest,
      failingPaths: audit.contrast.failures.map((failure) => failure.path),
    },
    tapTargets: audit.tapTargets.length,
    tapTargetPaths: audit.tapTargets.map((target) => target.path),
    overflow: audit.overflow.length,
    overflowPaths: audit.overflow.map((finding) => finding.path),
    values: valueCounts(audit),
    palette: audit.colors.length,
    dominant:
      dominant === null
        ? null
        : { value: dominant.value, coverage: round2(dominant.coverage) },
  };
}

/** The number a metric reports at one width; null when it was not measurable. */
function valueAt(record: BoardWidthRecord, id: BoardMetricId): number | null {
  switch (id) {
    case "contrastFailures":
      return record.contrast.failing;
    case "worstRatio":
      return record.contrast.smallest;
    case "tapTargets":
      return record.tapTargets;
    case "overflow":
      return record.overflow;
    case "distinctValues":
      return record.values.total;
    case "palette":
      return record.palette;
    case "dominantShare":
      return record.dominant === null ? null : record.dominant.coverage;
  }
}

function aggregateOf(
  records: BoardWidthRecord[],
  metric: BoardManifestMetric,
): number | null {
  const values = records
    .map((record) => valueAt(record, metric.id))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return metric.aggregate === "least"
    ? Math.min(...values)
    : Math.max(...values);
}

function buildVariant(
  input: BoardVariantInput,
  widths: number[],
): BoardVariantRecord {
  const byWidth = new Map<number, Snapshot>();
  for (const snapshot of input.snapshots) {
    if (byWidth.has(snapshot.viewportWidth)) {
      throw new Error(
        `variant "${input.name}" carries two ${snapshot.viewportWidth}px snapshots`,
      );
    }
    byWidth.set(snapshot.viewportWidth, snapshot);
  }
  for (const width of widths) {
    if (!byWidth.has(width)) {
      throw new Error(`variant "${input.name}" was not measured at ${width}px`);
    }
  }
  for (const width of byWidth.keys()) {
    if (!widths.includes(width)) {
      throw new Error(
        `variant "${input.name}" carries a ${width}px snapshot the board does not list`,
      );
    }
  }

  const records = widths.map((width) => {
    const snapshot = byWidth.get(width) as Snapshot;
    return widthRecord(snapshot, auditSnapshot(snapshot));
  });
  const aggregate: Record<string, number | null> = {};
  for (const metric of BOARD_METRICS) {
    aggregate[metric.id] = aggregateOf(records, manifestMetric(metric));
  }
  return {
    name: input.name,
    source: input.source,
    sourceKind: input.sourceKind,
    aggregate,
    widths: records,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Digest of the record the page claims to be. Computed with the digest field
 * blanked rather than omitted, so the same call serves the write and the
 * check: a manifest whose numbers were edited without the page being
 * regenerated has a digest that no longer matches its own body, and a page
 * carrying the old string disagrees with both.
 *
 * Pixels are not covered. Screenshots are a visual record; the digest is the
 * numbers and the decision, which is what a reader acts on.
 */
export function manifestDigest(manifest: BoardManifest): string {
  const body = JSON.stringify(canonical({ ...manifest, pageDigest: "" }));
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function displayValue(
  metric: BoardManifestMetric,
  value: number | null,
): string {
  if (value === null) return "—";
  if (metric.id === "worstRatio") return value.toFixed(2);
  if (metric.id === "dominantShare") return `${value.toFixed(1)}%`;
  return String(value);
}

/** The colour behind a share aggregate: the widest width that reached it. */
function colourFor(
  variant: BoardVariantRecord,
  metric: BoardManifestMetric,
  value: number | null,
): string | null {
  if (metric.id !== "dominantShare" || value === null) return null;
  for (const record of [...variant.widths].reverse()) {
    if (
      record.dominant !== null &&
      sameNumber(record.dominant.coverage, value)
    ) {
      return record.dominant.value;
    }
  }
  return null;
}

function bestOf(
  values: Array<number | null>,
  metric: BoardManifestMetric,
): number | null {
  if (metric.direction === null) return null;
  const present = values.filter((value): value is number => value !== null);
  // A column where one variant carries a value has no second place to
  // compare against; marking the only number would read as a verdict.
  if (present.length < 2) return null;
  return metric.direction === "lower"
    ? Math.min(...present)
    : Math.max(...present);
}

/**
 * The comparison table, with the best value in each column marked.
 *
 * Ties are marked on every tying cell: two variants that both reach zero
 * contrast failures are both best at it, and saying so is cheaper than
 * inventing a tie-break the numbers do not support.
 */
export function comparisonTable(manifest: BoardManifest): BoardTable {
  const metrics = manifest.metrics;
  const columns = metrics.map((metric) => ({
    metric,
    values: manifest.variants.map(
      (variant) => variant.aggregate[metric.id] ?? null,
    ),
  }));
  const bests = columns.map((column) => bestOf(column.values, column.metric));

  const rows: BoardRow[] = manifest.variants.map((variant, rowIndex) => ({
    name: variant.name,
    cells: columns.map((column, columnIndex) => {
      const value = column.values[rowIndex];
      const best = bests[columnIndex];
      return {
        metric: column.metric.id,
        value,
        display: displayValue(column.metric, value),
        colour: colourFor(variant, column.metric, value),
        best: value !== null && best !== null && sameNumber(value, best),
      };
    }),
  }));

  const marks = bests.some((best) => best !== null);
  let note: string;
  if (manifest.variants.length < 2) {
    note =
      "One variant: a board of one has nothing to compare, so no cell is marked best.";
  } else if (!marks) {
    note =
      "No column carries two comparable values, so no cell is marked best.";
  } else {
    note =
      "A marked cell holds the best value in its column; ties are marked on " +
      "every tying cell, and a column with one measured value is not marked.";
  }
  return { metrics, rows, marks, note };
}

/** Compose the page and the record from rendered snapshots. Pure. */
export function composeBoard(input: BoardInput): ComposedBoard {
  if (input.variants.length === 0) {
    throw new Error("a board needs at least one variant");
  }
  const names = new Set<string>();
  for (const variant of input.variants) {
    const name = variant.name.trim();
    if (name === "") throw new Error("every variant needs a name");
    if (names.has(name)) throw new Error(`two variants are named "${name}"`);
    names.add(name);
  }
  const widths = [...new Set(input.widths)].sort((a, b) => a - b);
  if (widths.length === 0) throw new Error("a board needs at least one width");

  const decision = input.decision ?? null;
  if (decision !== null) {
    if (typeof decision.variant !== "string") {
      throw new Error("a decision needs a variant name");
    }
    if (!names.has(decision.variant)) {
      throw new Error(
        `the decision names "${decision.variant}", which is not a variant on this board (${[...names].join(", ")})`,
      );
    }
    if (typeof decision.reason !== "string" || decision.reason.trim() === "") {
      throw new Error(
        "a decision needs a reason: the record has to say what the numbers were read as",
      );
    }
  }

  const manifest: BoardManifest = {
    format: BOARD_FORMAT_VERSION,
    tool: "design_board",
    toolVersion: input.toolVersion,
    title: input.title?.trim() || "Variant board",
    pageDigest: "",
    widths,
    decision,
    metrics: BOARD_METRICS.map(manifestMetric),
    variants: input.variants.map((variant) =>
      buildVariant({ ...variant, name: variant.name.trim() }, widths),
    ),
  };
  manifest.pageDigest = manifestDigest(manifest);

  const table = comparisonTable(manifest);
  const html = renderBoardPage({
    manifest,
    table,
    shots: input.shots ?? [],
  });
  return { manifest, table, html };
}

/**
 * The table as markdown, for the tool's own result: the same numbers the page
 * prints, so a report can paste one and a reader can check the other.
 */
export function renderBoardSummary(manifest: BoardManifest): string {
  const table = comparisonTable(manifest);
  const lines: string[] = [];
  lines.push(`# ${manifest.title}`);
  lines.push("");
  lines.push(
    `${manifest.variants.length} variant${manifest.variants.length === 1 ? "" : "s"} × ` +
      `${manifest.widths.length} width${manifest.widths.length === 1 ? "" : "s"} ` +
      `(${manifest.widths.map((width) => `${width}px`).join(", ")}).`,
  );
  lines.push("");
  const header = `| variant | ${table.metrics
    .map(
      (metric) =>
        `${metric.label}${metric.direction === "lower" ? " ↓" : metric.direction === "higher" ? " ↑" : ""}`,
    )
    .join(" | ")} | verdict |`;
  lines.push(header);
  lines.push(`| --- | ${table.metrics.map(() => "---").join(" | ")} | --- |`);
  for (const row of table.rows) {
    const cells = row.cells.map((cell) => {
      const text =
        cell.colour === null ? cell.display : `${cell.display} ${cell.colour}`;
      return cell.best ? `**${text}**` : text;
    });
    lines.push(`| ${row.name} | ${cells.join(" | ")} | |`);
  }
  lines.push("");
  lines.push(table.note);
  lines.push("");
  for (const variant of manifest.variants) {
    const perWidth = variant.widths
      .map(
        (record) =>
          `${record.width}px: contrast ${record.contrast.checked}/${record.contrast.failing} ` +
          `weakest ${record.contrast.smallest === null ? "—" : record.contrast.smallest} ` +
          `taps ${record.tapTargets} overflow ${record.overflow} ` +
          `values ${record.values.total} palette ${record.palette}`,
      )
      .join(" · ");
    lines.push(`- **${variant.name}** (${variant.source}): ${perWidth}`);
  }
  lines.push("");
  if (manifest.decision === null) {
    lines.push(
      "Decision: undecided. The record carries `decision: null`; name a variant and a reason, then regenerate the board.",
    );
  } else {
    lines.push(
      `Decision: **${manifest.decision.variant}** — ${manifest.decision.reason}`,
    );
  }
  return lines.join("\n");
}

export interface DriftEntry {
  kind:
    | "format"
    | "record"
    | "page"
    | "variant-set"
    | "widths"
    | "metric"
    | "width-number";
  variant?: string;
  metric?: BoardMetricId;
  subject: string;
  recorded: number | string | null;
  fresh: number | string | null;
}

/** One width's numbers as flat pairs, so a diff is a loop rather than a list. */
function flatWidth(
  record: BoardWidthRecord,
): Record<string, string | number | null> {
  return {
    "page height": record.documentHeight,
    findings: record.findings.total,
    "contrast findings": record.findings.contrast,
    "off-grid values": record.findings.offGrid,
    "token misses": record.findings.missingTokens,
    "contrast pairs": record.contrast.checked,
    "skipped pairs": record.contrast.skipped,
    "contrast failures": record.contrast.failing,
    "weakest ratio": record.contrast.smallest,
    "failing pairs": record.contrast.failingPaths.join(", ") || null,
    "tap targets": record.tapTargets,
    "tap targets named": record.tapTargetPaths.join(", ") || null,
    overflow: record.overflow,
    "overflow at": record.overflowPaths.join(", ") || null,
    "distinct values": record.values.total,
    "font sizes": record.values.fontSizes,
    "font weights": record.values.fontWeights,
    "line heights": record.values.lineHeights,
    spacings: record.values.spacings,
    radii: record.values.radii,
    shadows: record.values.shadows,
    palette: record.palette,
    "dominant colour": record.dominant?.value ?? null,
    "dominant coverage": record.dominant?.coverage ?? null,
  };
}

/**
 * What moved between a recorded board and a fresh one.
 *
 * Every field the record carries is compared, aggregates and per-width
 * numbers alike: the aggregates are what a choice is made on, and the
 * per-width numbers are what say which width moved. A variant whose name
 * changed or a width that was added is drift too, because the record then
 * describes a board nobody looked at.
 */
export function diffBoards(
  recorded: BoardManifest,
  fresh: BoardManifest,
): DriftEntry[] {
  const drift: DriftEntry[] = [];
  if (recorded.format !== fresh.format) {
    drift.push({
      kind: "format",
      subject: "manifest format",
      recorded: recorded.format,
      fresh: fresh.format,
    });
  }
  if (recorded.widths.join(",") !== fresh.widths.join(",")) {
    drift.push({
      kind: "widths",
      subject: "measured widths",
      recorded: recorded.widths.join(", "),
      fresh: fresh.widths.join(", "),
    });
  }

  const recordedNames = recorded.variants.map((variant) => variant.name);
  const freshNames = fresh.variants.map((variant) => variant.name);
  const variantKey = (names: string[]) => [...names].sort().join(", ");
  if (variantKey(recordedNames) !== variantKey(freshNames)) {
    drift.push({
      kind: "variant-set",
      subject: "variant set",
      recorded: variantKey(recordedNames),
      fresh: variantKey(freshNames),
    });
  }

  for (const before of recorded.variants) {
    const after = fresh.variants.find(
      (variant) => variant.name === before.name,
    );
    if (after === undefined) continue;
    for (const metric of recorded.metrics) {
      const recordedValue = before.aggregate[metric.id] ?? null;
      const freshValue = after.aggregate[metric.id] ?? null;
      if (!sameNumber(recordedValue, freshValue)) {
        drift.push({
          kind: "metric",
          variant: before.name,
          metric: metric.id,
          subject: metric.label,
          recorded: recordedValue,
          fresh: freshValue,
        });
      }
    }
    for (const record of before.widths) {
      const freshRecord = after.widths.find(
        (candidate) => candidate.width === record.width,
      );
      if (freshRecord === undefined) continue;
      const recordedFlat = flatWidth(record);
      const freshFlat = flatWidth(freshRecord);
      for (const key of Object.keys(recordedFlat)) {
        const a = recordedFlat[key];
        const b = freshFlat[key];
        const same =
          typeof a === "number" && typeof b === "number"
            ? sameNumber(a, b)
            : a === b;
        if (!same) {
          drift.push({
            kind: "width-number",
            variant: before.name,
            subject: `${key} at ${record.width}px`,
            recorded: a,
            fresh: b,
          });
        }
      }
    }
  }
  return drift;
}

/** One drift entry as a line of the check's report. */
export function driftLine(entry: DriftEntry): string {
  const show = (value: number | string | null) =>
    value === null ? "nothing" : String(value);
  const where =
    entry.variant === undefined
      ? entry.subject
      : `variant "${entry.variant}": ${entry.subject}`;
  if (typeof entry.recorded === "number" && typeof entry.fresh === "number") {
    return `${where} moved ${signedMetricValue(entry.recorded)} → ${signedMetricValue(entry.fresh)}`;
  }
  return `${where} moved ${show(entry.recorded)} → ${show(entry.fresh)}`;
}

function signedMetricValue(value: number): string {
  const text = Number.isInteger(value) ? String(value) : String(round2(value));
  return text;
}
