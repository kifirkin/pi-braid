/**
 * Render an audit as markdown. The report a worker pastes should be produced
 * by the ruler, not hand-written from the JSON, so the two cannot disagree.
 *
 * Every list is bounded; a truncated section says how many it hid and the full
 * object travels beside the text in the tool result.
 */

import type { Audit, ContrastFailure, ValueUse, WidthAudit } from "./audit.js";

export interface ScreenshotRef {
  width: number;
  path: string | null;
}

const MAX_COLORS = 10;
const MAX_FAILURES = 25;
const MAX_VALUES = 30;
const MAX_TARGETS = 25;
const MAX_OVERFLOW = 25;

function list<T>(items: T[], limit: number): T[] {
  return items.slice(0, limit);
}

function moreLine(count: number, limit: number): string[] {
  return count > limit ? [`(${count - limit} more in the JSON)`] : [];
}

function valueLine(use: ValueUse): string {
  const flags: string[] = [];
  if (use.onGrid === true) flags.push("on grid");
  if (use.onGrid === false) flags.push("OFF GRID");
  if (use.inTokens === true) flags.push("in tokens");
  if (use.inTokens === false) flags.push("not in tokens");
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return `- ${use.value} x${use.count}${suffix}`;
}

function contrastLine(failure: ContrastFailure): string {
  return (
    `- \`${failure.path}\` ${failure.ratio}:1 (needs ${failure.required}) ` +
    `${failure.foreground} on ${failure.background}, ` +
    `${failure.fontSizePx}px/${failure.fontWeight}: "${failure.text}"`
  );
}

function widthSection(audit: WidthAudit, screenshots: ScreenshotRef[]): string {
  const out: string[] = [];
  const findings = audit.findings;

  out.push(
    `## ${audit.width}px (document ${audit.documentHeight}px)`,
    "",
    `Findings: ${findings.total} (contrast ${findings.contrast}, off-grid ${findings.offGrid}, ` +
      `token misses ${findings.missingTokens}, tap targets ${findings.tapTargets}, ` +
      `overflow ${findings.overflow})`,
    "",
    "### Contrast",
    "",
    `checked ${audit.contrast.checked}, skipped ${audit.contrast.skipped}, ` +
      `failing ${audit.contrast.failures.length}, smallest ratio ` +
      (audit.contrast.smallest === null
        ? "none measured"
        : audit.contrast.smallest),
  );
  for (const failure of list(audit.contrast.failures, MAX_FAILURES)) {
    out.push(contrastLine(failure));
  }
  out.push(...moreLine(audit.contrast.failures.length, MAX_FAILURES));

  out.push("", "### Dominant colours", "");
  if (audit.colors.length === 0) out.push("(no painted area recorded)");
  for (const color of list(audit.colors, MAX_COLORS)) {
    out.push(`- ${color.value} ${color.coverage}% (${color.area}px2)`);
  }
  out.push(...moreLine(audit.colors.length, MAX_COLORS));
  out.push(`coverage total ${audit.coverageTotal}%`);

  out.push("", "### Values", "");
  const inventory: Array<[string, ValueUse[]]> = [
    ["font sizes", audit.inventory.fontSizes],
    ["font weights", audit.inventory.fontWeights],
    ["line heights", audit.inventory.lineHeights],
    ["spacings", audit.inventory.spacings],
    ["radii", audit.inventory.radii],
    ["shadows", audit.inventory.shadows],
  ];
  for (const [label, uses] of inventory) {
    if (uses.length === 0) {
      out.push(`${label}: none`);
      continue;
    }
    out.push(`${label}:`);
    for (const use of list(uses, MAX_VALUES)) out.push(valueLine(use));
    out.push(...moreLine(uses.length, MAX_VALUES));
  }

  out.push("", "### Tap targets", "");
  if (audit.tapTargets.length === 0) out.push("none");
  for (const target of list(audit.tapTargets, MAX_TARGETS)) {
    out.push(`- \`${target.path}\` ${target.width} x ${target.height}`);
  }
  out.push(...moreLine(audit.tapTargets.length, MAX_TARGETS));

  out.push("", "### Overflow", "");
  if (audit.overflow.length === 0) out.push("none");
  for (const item of list(audit.overflow, MAX_OVERFLOW)) {
    const detail =
      item.reason === "scroll"
        ? `scrollWidth ${item.scrollWidth} > clientWidth ${item.clientWidth}`
        : `right edge ${item.right} > viewport ${audit.width}`;
    out.push(`- \`${item.path}\` (${item.reason}): ${detail}`);
  }
  out.push(...moreLine(audit.overflow.length, MAX_OVERFLOW));

  if (screenshots.length > 0) {
    out.push("", "### Screenshots", "");
    for (const shot of screenshots) {
      out.push(`- ${shot.width}px: ${shot.path ?? "(not saved)"}`);
    }
  }

  return out.join("\n");
}

/** The markdown rendering of an audit, plus any screenshots taken beside it. */
export function renderAudit(
  audit: Audit,
  screenshots: ScreenshotRef[] = [],
): string {
  const sections = audit.widths.map((width) =>
    widthSection(
      width,
      screenshots.filter((shot) => shot.width === width.width),
    ),
  );
  const header = [
    "# Design audit",
    "",
    `Target: ${audit.target ?? "(unnamed snapshot)"}`,
    `Widths: ${audit.widths.map((width) => `${width.width}px`).join(", ")}`,
    `Grid: ${audit.params.gridStepPx}px | min target: ${audit.params.minTargetPx}px | ` +
      `type scale: ${audit.params.typeScale.join(", ")}`,
    audit.params.tokenFile
      ? `Tokens: ${audit.params.tokenCount} comparable values from the project's DESIGN.md`
      : "Tokens: no DESIGN.md supplied",
    "",
    `Verdict at the narrowest width (${audit.findings.width}px): ` +
      `${audit.findings.total} findings.`,
  ];
  return [header.join("\n"), ...sections].join("\n\n");
}
