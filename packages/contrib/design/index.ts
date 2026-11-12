/**
 * `design_audit`: render a page at declared widths and measure the result.
 *
 * One tool, three parts behind it. `./audit.ts` is the ruler: pure functions
 * over a recorded snapshot, and the only place a number is decided.
 * `./adapter.ts` is the browser: CDP over the contrib package's existing
 * client, one evaluate per width. This file is the registration and the I/O
 * around them: read the token file, name the screenshot directory, return
 * errors as results.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";
import { readToggleVerdict } from "../module-toggle.js";
import { braidDir } from "../state-paths.js";
import {
  DEFAULT_WIDTHS,
  MAX_WIDTH,
  MAX_WIDTHS,
  MIN_WIDTH,
  auditSnapshots,
  normaliseWidths,
} from "./audit.js";
import { capturePage, findDesignFile, resolveTarget } from "./adapter.js";
import { runDesignBoard } from "./board-run.js";
import { BOARD_FORMAT_VERSION } from "./board.js";
import { renderAudit, type ScreenshotRef } from "./render.js";
import { NO_TOKENS, parseDesignTokens } from "./tokens.js";

const log = createLogger("design");

const MAX_TEXT_CHARS = 16000;

const auditParams = Type.Object({
  target: Type.String({
    description:
      "URL to render (http, https or file) or a path to a local HTML file.",
  }),
  widths: Type.Optional(
    Type.Array(Type.Integer({ minimum: MIN_WIDTH, maximum: MAX_WIDTH }), {
      description:
        `Viewport widths in CSS px (default ${DEFAULT_WIDTHS.join(", ")}; ` +
        `at most ${MAX_WIDTHS}).`,
      minItems: 1,
      maxItems: MAX_WIDTHS,
    }),
  ),
  screenshot_dir: Type.Optional(
    Type.String({
      description:
        "Directory for one full-page PNG per width. Defaults to " +
        "<braid home>/design/screenshots.",
    }),
  ),
  design_md: Type.Optional(
    Type.String({
      description:
        "Path to the project's DESIGN.md. Defaults to the file beside a local " +
        "target, then one directory above it.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: "Per-width load timeout in milliseconds (default 30000).",
    }),
  ),
});

export type DesignAuditInput = Static<typeof auditParams>;

const boardVariantParams = Type.Object({
  name: Type.String({
    description: "Variant name; it labels the row and the screenshot.",
  }),
  path_or_html: Type.String({
    description:
      "A URL or local file to render, or the page's own HTML. Inline HTML is " +
      "written into the board directory, so the record carries what it measured.",
  }),
});

const boardParams = Type.Object({
  variants: Type.Array(boardVariantParams, {
    description:
      "Two or more answers to one screen. One is allowed and is not compared.",
    minItems: 1,
    maxItems: 12,
  }),
  widths: Type.Optional(
    Type.Array(Type.Integer({ minimum: MIN_WIDTH, maximum: MAX_WIDTH }), {
      description:
        `Viewport widths in CSS px (default ${DEFAULT_WIDTHS.join(", ")}; ` +
        `at most ${MAX_WIDTHS}).`,
      minItems: 1,
      maxItems: MAX_WIDTHS,
    }),
  ),
  out_dir: Type.Optional(
    Type.String({
      description:
        "Directory for board.html, board.json, the staged variants and their " +
        "screenshots. Defaults to <braid home>/design/boards.",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "What the screen is, for the page heading.",
    }),
  ),
  decision: Type.Optional(
    Type.Object({
      variant: Type.String({ description: "The variant that gets built." }),
      reason: Type.String({
        description:
          "One sentence naming the numbers the choice was read from.",
      }),
    }),
  ),
  check: Type.Optional(
    Type.Boolean({
      description:
        "Re-render the recorded board in out_dir and compare every number it " +
        "carries; writes nothing.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: "Per-width load timeout in milliseconds (default 30000).",
    }),
  ),
});

export type DesignBoardInput = Static<typeof boardParams>;

export interface DesignAuditResult {
  target: string;
  designMd: string | null;
  audit: ReturnType<typeof auditSnapshots>;
  screenshots: Array<{
    width: number;
    path: string | null;
    height: number | null;
    truncated: boolean;
  }>;
  text: string;
}

function resolveWidths(input: number[] | undefined): number[] {
  return normaliseWidths(input, "audit");
}

function defaultScreenshotDir(): string | null {
  const root = braidDir();
  return root === null ? null : join(root, "design", "screenshots");
}

/**
 * The whole audit, with the tool wrapper removed, so a smoke run drives the
 * same path a session does. Throws on a refused target, an unreachable page,
 * or a malformed snapshot; the tool turns that throw into a result.
 */
export async function runDesignAudit(
  input: DesignAuditInput,
): Promise<DesignAuditResult> {
  const widths = resolveWidths(input.widths);
  const target = (input.target ?? "").trim();
  if (target === "") throw new Error("target is empty");

  const resolved = resolveTarget(target);
  const designMd =
    typeof input.design_md === "string" && input.design_md.trim() !== ""
      ? input.design_md.trim()
      : findDesignFile(resolved.localPath);

  let tokens = NO_TOKENS;
  if (designMd !== null) {
    let text: string;
    try {
      text = readFileSync(designMd, "utf8");
    } catch (error) {
      throw new Error(
        `could not read DESIGN.md at ${designMd}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    tokens = parseDesignTokens(text);
    if (tokens.tokenCount === 0) {
      log.warn(
        `[design] ${designMd} carries no typography, spacing or rounded token this audit can compare`,
      );
    }
  }

  const screenshotDir =
    typeof input.screenshot_dir === "string" &&
    input.screenshot_dir.trim() !== ""
      ? input.screenshot_dir.trim()
      : defaultScreenshotDir();

  const captured = await capturePage(target, {
    widths,
    screenshotDir,
    timeoutMs: input.timeout_ms,
  });

  const audit = auditSnapshots(
    captured.widths.map((width) => width.snapshot),
    { designTokens: tokens },
  );

  const screenshots: ScreenshotRef[] = captured.widths.map((width) => ({
    width: width.snapshot.viewportWidth,
    path: width.screenshot?.path ?? null,
  }));

  let text = renderAudit(audit, screenshots);
  if (screenshotDir === null) {
    text +=
      "\n\nScreenshots: not saved (no screenshot_dir was named and the braid " +
      "state root is underivable).";
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[text truncated; the full audit is in details.audit]`;
  }

  return {
    target: audit.target ?? resolved.url,
    designMd,
    audit,
    screenshots: captured.widths.map((width) => ({
      width: width.snapshot.viewportWidth,
      path: width.screenshot?.path ?? null,
      height: width.screenshot?.height ?? null,
      truncated: width.screenshot?.truncated ?? false,
    })),
    text,
  };
}

export default function designExtension(pi: ExtensionAPI): void {
  const toggle = readToggleVerdict(["design"]);
  if (toggle.disabled) {
    log.info(
      `[design] disabled via settings (braid.contrib.${toggle.key}: false).`,
    );
    return;
  }

  pi.registerTool({
    name: "design_audit",
    label: "Design Audit",
    promptSnippet:
      "Measure a rendered page: contrast, colours, values, tap targets, overflow",
    description:
      "Render a URL or local HTML file at declared widths and measure it: dominant " +
      "colours with percentage coverage, every text pair's WCAG contrast against its " +
      "effective background with failing pairs named by selector, the distinct font " +
      "sizes, weights, line-heights, spacings, radii and shadows in use with token-file " +
      "verdicts when a DESIGN.md is present, tap targets below 44x44, and elements that " +
      "overflow at each width. Returns markdown plus the structured audit in details, " +
      "and writes one full-page PNG per width to screenshot_dir.",
    parameters: auditParams,
    execute: async (
      _toolCallId: string,
      params: DesignAuditInput,
    ): Promise<unknown> => {
      try {
        const result = await runDesignAudit(params);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            target: result.target,
            design_md: result.designMd,
            audit: result.audit,
            screenshots: result.screenshots,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `design_audit: ${message}` },
          ],
          details: { error: message },
          isError: true,
        };
      }
    },
  } as ToolDefinition<any, any, any>);

  pi.registerTool({
    name: "design_board",
    label: "Design Board",
    promptSnippet:
      "Render variants of one screen side by side and mark the best value per metric",
    description:
      "Render several variants of one screen at declared widths and compose one " +
      "self-contained HTML page that puts them side by side with the ruler's numbers " +
      "under each, plus a comparison table that marks the best value in every decisive " +
      "column (contrast failures, weakest ratio, tap targets under 44px, overflow, " +
      "distinct values, palette) and leaves a verdict column for a human. Writes " +
      "board.html and board.json; board.json carries the inputs, the measurements, the " +
      "widths, the tool version and the decision, or states that the choice is still " +
      "open. check=true re-renders the recorded board and fails on any number that " +
      "moved.",
    parameters: boardParams,
    execute: async (
      _toolCallId: string,
      params: DesignBoardInput,
    ): Promise<unknown> => {
      try {
        const result = await runDesignBoard(params);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            page: result.pagePath,
            record: result.manifestPath,
            format: BOARD_FORMAT_VERSION,
            decision: result.manifest?.decision ?? null,
            drift: result.drift,
            manifest: result.manifest,
          },
          isError: result.exitCode !== 0,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `design_board: ${message}` },
          ],
          details: { error: message },
          isError: true,
        };
      }
    },
  } as ToolDefinition<any, any, any>);

  log.info("[design] loaded: design_audit, design_board");
}
