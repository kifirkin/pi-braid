/**
 * The board's I/O half: stage the variant sources, render them, write the page
 * and the record, and check a recorded board against a fresh render.
 *
 * A board's inputs are either a path or the page's own HTML. Inline HTML is
 * written into the board directory, so a record carries the exact document it
 * measured instead of a path into whatever checkout produced it; a path stays
 * a path, and `--check` resolves it beside the manifest, so re-running the
 * check in another directory does not silently measure a different file.
 *
 * `--check` is the release-ledger shape at the size of one screen: the page
 * and the manifest must agree before anything is measured (no browser
 * needed), then the variants are rendered again and every number the record
 * carries is compared. A number that moved is a failure, and it names the
 * variant and the metric, because "the board is stale" is not something a
 * reader can act on.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePage, resolveTarget } from "./adapter.js";
import { normaliseWidths, type Snapshot } from "./audit.js";
import {
  BOARD_FORMAT_VERSION,
  composeBoard,
  diffBoards,
  driftLine,
  manifestDigest,
  renderBoardSummary,
  type BoardDecision,
  type BoardManifest,
  type BoardVariantSource,
  type DriftEntry,
} from "./board.js";
import type { BoardShot } from "./board-page.js";
import { braidDir } from "../state-paths.js";

/** A board input string is HTML when it carries a tag; a path never does. */
const LOOKS_LIKE_HTML = /<[a-z!/][^>]*>/i;

const MANIFEST_NAME = "board.json";
const PAGE_NAME = "board.html";

export interface BoardVariantRequest {
  name: string;
  path_or_html: string;
}

export interface BoardRunInput {
  variants?: BoardVariantRequest[];
  widths?: number[];
  out_dir?: string;
  title?: string;
  decision?: BoardDecision;
  check?: boolean;
  timeout_ms?: number;
}

export interface MeasuredVariant {
  source: BoardVariantSource;
  snapshots: Snapshot[];
  shots: BoardShot[];
}

export interface BoardRunResult {
  outDir: string;
  pagePath: string;
  manifestPath: string;
  /** Null when a check ran against a record that could not be read. */
  manifest: BoardManifest | null;
  drift: DriftEntry[];
  exitCode: 0 | 1 | 2;
  text: string;
}

/** What a re-render is told about the record it is checking. */
export interface BoardMeasureContext {
  /** The record's own directory: relative sources resolve here first. */
  baseDir: string;
  timeoutMs?: number;
}

export interface BoardCheckOptions {
  timeoutMs?: number;
  /**
   * Renders the record's variants. The default drives a real browser; the
   * check's ordering, digest test and diff are the same either way, so a test
   * can drive them from recorded snapshots without a browser in the loop.
   */
  measure?: (
    sources: BoardVariantSource[],
    widths: number[],
    context: BoardMeasureContext,
  ) => Promise<MeasuredVariant[]>;
}

export interface BoardCheckResult {
  manifestPath: string;
  pagePath: string;
  drift: DriftEntry[];
  notes: string[];
  exitCode: 0 | 1 | 2;
  text: string;
}

/** The board directory: the caller's, or the braid state root's own shelf. */
function resolveBoardDir(given: string | undefined): string {
  if (typeof given === "string" && given.trim() !== "") {
    return resolve(given.trim());
  }
  const root = braidDir();
  if (root === null) {
    throw new Error(
      "no out_dir was named and the braid state root is underivable; refusing to write a board beside the cwd",
    );
  }
  return join(root, "design", "boards");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One file name per variant, unique and derived from the names alone. */
function slugsFor(names: string[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const [index, name] of names.entries()) {
    const base = slugify(name) || `variant-${index + 1}`;
    let candidate = base;
    let at = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${at}`;
      at += 1;
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

interface StagedVariant {
  source: BoardVariantSource;
  target: string;
  slug: string;
}

function stageVariants(
  requests: BoardVariantRequest[],
  outDir: string,
): StagedVariant[] {
  if (requests.length === 0) {
    throw new Error("a board needs at least one variant");
  }
  const names = requests.map((request) => request.name.trim());
  const slugs = slugsFor(names);
  return requests.map((request, index) => {
    const name = names[index];
    const text = (request.path_or_html ?? "").trim();
    if (name === "") throw new Error("every variant needs a name");
    if (text === "") {
      throw new Error(`variant "${name}" carries neither HTML nor a path`);
    }
    if (LOOKS_LIKE_HTML.test(text)) {
      const file = join(outDir, "variants", `${slugs[index]}.html`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
      return {
        source: {
          name,
          source: relative(outDir, file),
          sourceKind: "file" as const,
        },
        target: file,
        slug: slugs[index],
      };
    }
    const resolved = resolveTarget(text);
    return {
      source: {
        name,
        source: text,
        sourceKind: resolved.localPath === null ? "url" : "file",
      },
      target: text,
      slug: slugs[index],
    };
  });
}

function readPng(path: string | null): string | null {
  if (path === null) return null;
  // The capture just wrote this file; a read failure here is a real error,
  // not a variant without a picture, and a placeholder would hide it.
  return readFileSync(path).toString("base64");
}

/** Render every staged variant at every width, keeping the screenshots inline. */
async function renderVariants(
  staged: StagedVariant[],
  widths: number[],
  screenshotRoot: string | null,
  timeoutMs?: number,
): Promise<MeasuredVariant[]> {
  const measured: MeasuredVariant[] = [];
  for (const variant of staged) {
    const screenshotDir =
      screenshotRoot === null ? null : join(screenshotRoot, variant.slug);
    const captured = await capturePage(variant.target, {
      widths,
      screenshotDir,
      timeoutMs,
    });
    measured.push({
      source: variant.source,
      snapshots: captured.widths.map((width) => width.snapshot),
      shots: captured.widths.map((width) => ({
        name: variant.source.name,
        width: width.snapshot.viewportWidth,
        data: readPng(width.screenshot?.path ?? null),
        height: width.screenshot?.height ?? null,
      })),
    });
  }
  return measured;
}

/** The package version, recorded so a check can say what wrote the record. */
function toolVersion(): string {
  try {
    const text = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readDecision(outDir: string): BoardDecision | null {
  const path = join(outDir, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      decision?: BoardDecision | null;
    };
    return parsed.decision ?? null;
  } catch {
    // A record that cannot be read is about to be replaced; a stale decision
    // read from garbage would be worse than no decision at all.
    return null;
  }
}

function summaryText(input: {
  manifest: BoardManifest;
  pagePath: string;
  manifestPath: string;
}): string {
  return [
    renderBoardSummary(input.manifest),
    "",
    `Page: ${input.pagePath}`,
    `Record: ${input.manifestPath}`,
    input.manifest.decision === null
      ? "Next: open the page, fill the verdict column, then either record a decision or leave the board undecided."
      : "Next: open the page; the decision is printed at the top and the numbers behind it are the table.",
  ].join("\n");
}

/** Generate a board, or re-check the one a directory already holds. */
export async function runDesignBoard(
  input: BoardRunInput,
): Promise<BoardRunResult> {
  const outDir = resolveBoardDir(input.out_dir);
  const widths = normaliseWidths(input.widths, "board");

  if (input.check === true) {
    const checked = await checkBoard(join(outDir, MANIFEST_NAME), {
      timeoutMs: input.timeout_ms,
    });
    let manifest: BoardManifest | null = null;
    if (checked.exitCode !== 2) {
      manifest = JSON.parse(
        readFileSync(checked.manifestPath, "utf8"),
      ) as BoardManifest;
    }
    return {
      outDir,
      pagePath: checked.pagePath,
      manifestPath: checked.manifestPath,
      manifest,
      drift: checked.drift,
      exitCode: checked.exitCode,
      text: checked.text,
    };
  }

  if (!Array.isArray(input.variants) || input.variants.length === 0) {
    throw new Error("a board needs at least one variant");
  }
  mkdirSync(outDir, { recursive: true });
  const staged = stageVariants(input.variants, outDir);
  const measured = await renderVariants(
    staged,
    widths,
    join(outDir, "screenshots"),
    input.timeout_ms,
  );

  // An explicit decision wins; otherwise a regenerated board keeps the one its
  // record already carries, so a content edit does not quietly reopen the
  // choice. A carried decision that names a vanished variant is refused by
  // composeBoard rather than dropped.
  const decision = input.decision ?? readDecision(outDir);

  const composed = composeBoard({
    variants: measured.map((variant) => ({
      ...variant.source,
      snapshots: variant.snapshots,
    })),
    widths,
    decision,
    toolVersion: toolVersion(),
    title: input.title,
    shots: measured.flatMap((variant) => variant.shots),
  });

  const pagePath = join(outDir, PAGE_NAME);
  const manifestPath = join(outDir, MANIFEST_NAME);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(composed.manifest, null, 2)}\n`,
  );
  writeFileSync(pagePath, composed.html);

  return {
    outDir,
    pagePath,
    manifestPath,
    manifest: composed.manifest,
    drift: [],
    exitCode: 0,
    text: summaryText({ manifest: composed.manifest, pagePath, manifestPath }),
  };
}

interface ParsedRecord {
  manifest: BoardManifest;
  at: string;
}

function parseRecord(path: string): ParsedRecord {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`no board record at ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `board record at ${path} is not JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const record = parsed as Partial<BoardManifest>;
  const problems: string[] = [];
  if (record === null || typeof record !== "object") {
    problems.push("not an object");
  }
  if (record.tool !== "design_board") problems.push("tool is not design_board");
  if (typeof record.format !== "number")
    problems.push("format is not a number");
  if (typeof record.pageDigest !== "string")
    problems.push("pageDigest is missing");
  if (!Array.isArray(record.widths) || record.widths.length === 0) {
    problems.push("widths is empty");
  }
  if (!Array.isArray(record.metrics) || record.metrics.length === 0) {
    problems.push("metrics is empty");
  }
  if (!Array.isArray(record.variants) || record.variants.length === 0) {
    problems.push("variants is empty");
  }
  for (const variant of Array.isArray(record.variants) ? record.variants : []) {
    if (
      typeof variant?.name !== "string" ||
      typeof variant?.source !== "string"
    ) {
      problems.push("a variant has no name or source");
      break;
    }
    if (!Array.isArray(variant.widths) || variant.widths.length === 0) {
      problems.push(`variant "${variant.name}" carries no per-width numbers`);
      break;
    }
    if (variant.aggregate === null || typeof variant.aggregate !== "object") {
      problems.push(`variant "${variant.name}" carries no aggregate numbers`);
      break;
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `board record at ${path} is unusable: ${problems.join("; ")}`,
    );
  }
  return { manifest: record as BoardManifest, at: path };
}

/**
 * The page and the record must describe each other. Two independent tests:
 * the record's digest must match its own body (a hand-edited manifest), and
 * the page must carry that digest (a page rendered before the record moved).
 * Neither needs a browser, so a stale artifact is caught in seconds.
 */
function digestDrift(record: ParsedRecord, pagePath: string): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const recomputed = manifestDigest(record.manifest);
  if (recomputed !== record.manifest.pageDigest) {
    drift.push({
      kind: "record",
      subject: "the record's own digest",
      recorded: record.manifest.pageDigest,
      fresh: recomputed,
    });
  }
  if (!existsSync(pagePath)) {
    drift.push({
      kind: "page",
      subject: "the page",
      recorded: record.manifest.pageDigest,
      fresh: "missing",
    });
    return drift;
  }
  if (!readFileSync(pagePath, "utf8").includes(record.manifest.pageDigest)) {
    drift.push({
      kind: "page",
      subject: "the page's digest",
      recorded: record.manifest.pageDigest,
      fresh: "the page does not carry it",
    });
  }
  return drift;
}

function checkHeader(record: BoardManifest, manifestPath: string): string[] {
  return [
    `design_board --check: ${manifestPath}`,
    `Recorded by ${record.tool} ${record.toolVersion}; ` +
      `${record.variants.length} variant${record.variants.length === 1 ? "" : "s"} × ` +
      `${record.widths.length} width${record.widths.length === 1 ? "" : "s"} ` +
      `(${record.widths.map((width) => `${width}px`).join(", ")}).`,
  ];
}

/**
 * Check a recorded board against a fresh render.
 *
 * Exit codes: 0 no drift, 1 drift, 2 the record could not be read. The page
 * and digest tests run first and need no browser: a page that already
 * disagrees with its manifest does not become worth measuring.
 */
export async function checkBoard(
  manifestPath: string,
  options: BoardCheckOptions = {},
): Promise<BoardCheckResult> {
  const pagePath = join(dirname(manifestPath), PAGE_NAME);
  let record: ParsedRecord;
  try {
    record = parseRecord(manifestPath);
  } catch (error) {
    return {
      manifestPath,
      pagePath,
      drift: [],
      notes: [],
      exitCode: 2,
      text: `design_board --check: ${(error as Error).message}`,
    };
  }

  const notes: string[] = [];
  const recordDrift = digestDrift(record, pagePath);
  if (recordDrift.length > 0) {
    return {
      manifestPath,
      pagePath,
      drift: recordDrift,
      notes,
      exitCode: 1,
      text: [
        ...checkHeader(record.manifest, manifestPath),
        "",
        "DRIFT",
        ...recordDrift.map((entry) => `  ${driftLine(entry)}`),
        "",
        "The page and the record must agree before the numbers are worth re-measuring.",
        "Regenerate the board, or restore the page. Verdict: drift.",
      ].join("\n"),
    };
  }

  if (record.manifest.format !== BOARD_FORMAT_VERSION) {
    return {
      manifestPath,
      pagePath,
      drift: [
        {
          kind: "format",
          subject: "manifest format",
          recorded: record.manifest.format,
          fresh: BOARD_FORMAT_VERSION,
        },
      ],
      notes,
      exitCode: 1,
      text: [
        ...checkHeader(record.manifest, manifestPath),
        "",
        "DRIFT",
        `  the record is format ${record.manifest.format}; this tool writes format ${BOARD_FORMAT_VERSION}.`,
        "A record from another schema cannot be compared. Regenerate the board. Verdict: drift.",
      ].join("\n"),
    };
  }

  if (record.manifest.toolVersion !== toolVersion()) {
    notes.push(
      `record written by ${record.manifest.tool} ${record.manifest.toolVersion}, ` +
        `checked by ${toolVersion()}; the numbers are compared, the presentation may differ.`,
    );
  }

  const measure = options.measure ?? renderRecordedVariants;
  let fresh;
  try {
    const verified = await measure(
      record.manifest.variants.map((variant) => ({
        name: variant.name,
        source: variant.source,
        sourceKind: variant.sourceKind,
      })),
      record.manifest.widths,
      { baseDir: dirname(manifestPath), timeoutMs: options.timeoutMs },
    );
    fresh = composeBoard({
      variants: verified.map((variant) => ({
        ...variant.source,
        snapshots: variant.snapshots,
      })),
      widths: record.manifest.widths,
      decision: record.manifest.decision,
      toolVersion: record.manifest.toolVersion,
      title: record.manifest.title,
    });
  } catch (error) {
    return {
      manifestPath,
      pagePath,
      drift: [],
      notes,
      exitCode: 2,
      text: [
        ...checkHeader(record.manifest, manifestPath),
        `design_board --check: could not measure the record's variants: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ].join("\n"),
    };
  }

  const recordedMetrics = record.manifest.metrics
    .map((metric) => metric.id)
    .join(", ");
  const freshMetrics = fresh.manifest.metrics
    .map((metric) => metric.id)
    .join(", ");
  if (recordedMetrics !== freshMetrics) {
    notes.push(
      `the tool compares (${freshMetrics}) where this board records (${recordedMetrics}); ` +
        "the numbers the board carries were compared, and regenerating prints the rest.",
    );
  }

  const drift = diffBoards(record.manifest, fresh.manifest);
  const header = [
    ...checkHeader(record.manifest, manifestPath),
    `Page: ${pagePath} (carries the record's digest)`,
  ];
  const lines =
    drift.length === 0
      ? [
          ...header,
          ...notes.map((note) => `Note: ${note}`),
          "",
          "No number moved. Verdict: clean.",
        ]
      : [
          ...header,
          ...notes.map((note) => `Note: ${note}`),
          "",
          "DRIFT",
          ...drift.map((entry) => `  ${driftLine(entry)}`),
          "",
          `${drift.length} number${drift.length === 1 ? "" : "s"} moved. ` +
            "Regenerate the board and read what changed, or revert the page. Verdict: drift.",
        ];

  return {
    manifestPath,
    pagePath,
    drift,
    notes,
    exitCode: drift.length === 0 ? 0 : 1,
    text: lines.join("\n"),
  };
}

/** Resolve a record's sources beside the record, then render them. */
async function renderRecordedVariants(
  sources: BoardVariantSource[],
  widths: number[],
  context: BoardMeasureContext,
): Promise<MeasuredVariant[]> {
  const staged: StagedVariant[] = sources.map((source, index) => {
    const slug = slugify(source.name) || `variant-${index + 1}`;
    if (source.sourceKind === "url") {
      return { source, target: source.source, slug };
    }
    const beside = resolve(context.baseDir, source.source);
    if (!existsSync(beside)) {
      throw new Error(
        `variant "${source.name}" was recorded as ${source.source}, and no file is there (${beside})`,
      );
    }
    return { source, target: beside, slug };
  });
  return renderVariants(staged, widths, null, context.timeoutMs);
}

function usage(): string {
  return [
    "design_board --check <board.json | board directory>",
    "",
    "Re-renders the variants a record names and compares every number it",
    "carries. Exit 0: nothing moved. Exit 1: drift. Exit 2: the record could",
    "not be read.",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const checkAt = argv.indexOf("--check");
  if (checkAt === -1) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const target = argv[checkAt + 1];
  if (target === undefined || target.startsWith("--")) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  let manifestPath = resolve(target);
  if (existsSync(manifestPath) && statSync(manifestPath).isDirectory()) {
    manifestPath = join(manifestPath, MANIFEST_NAME);
  }
  const result = await checkBoard(manifestPath);
  process.stdout.write(`${result.text}\n`);
  process.exitCode = result.exitCode;
}

function isEntryPoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `design_board --check: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
