// @ts-nocheck
const log = { info: (m) => console.log(`[docs] ${m}`), debug: () => {}, warn: (m) => console.warn(`[docs] ${m}`), error: (m) => console.error(`[docs] ${m}`) };
/**
 * Document tools - read various document formats
 *
 * Supports formats via macOS native tools:
 * - doc, docx, rtf, rtfd, html, htm, txt: via textutil
 * - pdf: text via pdf-parse, screenshots via pdf-parse getScreenshot
 *
 * NEVER returns raw binary content to the agent.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
let PDFParse: any;
try { PDFParse = require("pdf-parse").PDFParse; } catch {}
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const readDocSchema = Type.Object({
  path: Type.String({ description: "Path to document file" }),
  format: Type.Optional(
    StringEnum(["txt", "html", "rtf"], {
      default: "txt",
      description: "Output format",
    }),
  ),
  maxLines: Type.Optional(Type.Number({ default: 500, description: "Max lines to return" })),
});

const pdfScreenshotSchema = Type.Object({
  path: Type.String({ description: "Path to PDF file" }),
  page: Type.Optional(Type.Number({ description: "Page number (1-indexed). Default: 1." })),
  scale: Type.Optional(
    Type.Number({
      description:
        "DPI scale factor. 1=72dpi (readable, compact), 1.5=108dpi, 2=144dpi. Default: 1.0.",
    }),
  ),
});

const TEXTUTIL_FORMATS = ["doc", "docx", "rtf", "rtfd", "html", "htm", "txt"];
const PDF_FORMATS = ["pdf"];
const ALL_FORMATS = [...TEXTUTIL_FORMATS, ...PDF_FORMATS];

/**
 * Check if content looks like binary (not readable text).
 * Returns true if content contains null bytes or excessive control characters.
 */
function isBinaryContent(content: string): boolean {
  // Check for null bytes (strongest binary indicator)
  if (content.includes("\0")) return true;

  // Check ratio of control characters (excluding whitespace)
  const sampleSize = Math.min(content.length, 8192);
  const sample = content.slice(0, sampleSize);
  let controlChars = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Control chars except tab (9), newline (10), carriage return (13)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlChars++;
    }
  }
  // If >5% control characters, it's likely binary
  return controlChars / sampleSize > 0.05;
}

/**
 * Truncate content to maxLines.
 */
function truncateLines(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length > maxLines) {
    return `${lines.slice(0, maxLines).join("\n")}\n... (truncated, ${lines.length} total lines)`;
  }
  return content;
}

/**
 * Read PDF text using pdf-parse (pure JS, no native deps).
 * Returns extracted text or null if extraction failed.
 */
async function extractPdfWithPdfParse(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path);
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();

    if (result?.text && result.text.trim().length > 0 && !isBinaryContent(result.text)) {
      return result.text;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read PDF text using pdftotext (from poppler) — enhancement when available.
 * Returns extracted text or null if extraction failed.
 */
function extractPdfWithPdftotext(path: string): string | null {
  try {
    execSync("which pdftotext", { stdio: "ignore" });
  } catch {
    return null; // pdftotext not installed
  }

  try {
    const result = execSync(`pdftotext -layout "${path}" -`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    if (result && result.trim().length > 0 && !isBinaryContent(result)) {
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fallback: extract readable strings from PDF using `strings`.
 * Only useful for uncompressed/old PDFs. Returns null if output
 * is mostly PDF structure (not human-readable text).
 */
function extractPdfWithStrings(path: string): string | null {
  try {
    const result = execSync(`strings -n 6 "${path}"`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    });
    if (!result || result.trim().length < 50 || isBinaryContent(result)) {
      return null;
    }

    // Check if output is mostly PDF structure (not readable text)
    const lines = result.split("\n").filter((l) => l.trim().length > 0);
    const structurePatterns = /^(<<|>>|endobj|stream|endstream|xref|trailer|obj$|\d+ \d+ obj)/;
    const nonStructureLines = lines.filter((l) => !structurePatterns.test(l.trim()));
    const readableRatio = nonStructureLines.length / lines.length;

    // If <30% of lines are non-structure, strings didn't extract useful text
    if (readableRatio < 0.3) return null;

    return nonStructureLines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Read PDF — three-tier extraction:
 *   1. pdf-parse  (pure JS, always available, cross-platform)
 *   2. pdftotext  (macOS CLI enhancement, installed separately)
 *   3. strings    (last resort, crude but never binary)
 *
 * NEVER returns raw binary. Throws clear error if all methods fail.
 */
async function readPdf(
  path: string,
  maxLines: number,
): Promise<{ content: string; method: string }> {
  // Tier 1: pdf-parse (primary — pure JS, no native deps)
  const pdfParseResult = await extractPdfWithPdfParse(path);
  if (pdfParseResult) {
    return { content: truncateLines(pdfParseResult, maxLines), method: "pdf-parse" };
  }

  // Tier 2: pdftotext (enhancement, e.g. from poppler)
  const pdftotextResult = extractPdfWithPdftotext(path);
  if (pdftotextResult) {
    return { content: truncateLines(pdftotextResult, maxLines), method: "pdftotext" };
  }

  // Tier 3: strings (last resort — filters PDF structure, never binary)
  const stringsResult = extractPdfWithStrings(path);
  if (stringsResult) {
    return {
      content: truncateLines(
        `[Note: text extraction produced limited output — PDF may be image-based or heavily compressed.\n` +
          `For best results, install pdftotext: brew install poppler]\n\n${stringsResult}`,
        maxLines,
      ),
      method: "strings",
    };
  }

  // All tiers failed — return helpful error, never binary
  throw new Error(
    "Could not extract text from PDF. All extractors failed:\n" +
      "  - pdf-parse: could not parse PDF structure\n" +
      "  - pdftotext: not installed (run: brew install poppler)\n" +
      "  - strings: output was mostly PDF structure (image-based or encrypted PDF)\n" +
      "For image-based/scanned PDFs, use analyze_image on each page screenshot instead.",
  );
}

/**
 * Read document using macOS textutil.
 */
async function readWithTextutil(path: string, format: string, maxLines: number): Promise<string> {
  const tmpFile = `/tmp/doc_extract_${Date.now()}.txt`;

  execSync(`textutil -convert ${format} "${path}" -output "${tmpFile}"`, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  let content: string;
  try {
    content = await fs.readFile(tmpFile, "utf-8");
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {
      /* ignore */
    }
  }

  // Binary safety check for textutil output too
  if (isBinaryContent(content)) {
    throw new Error("textutil produced binary output — file may be corrupted or unsupported");
  }

  return truncateLines(content, maxLines);
}

export default function docExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_document",
    label: "Read Document",
    description:
      "Read text from various document formats (doc, docx, rtf, html, txt, pdf). " +
      "For PDF: pdf-parse (primary) → pdftotext (if installed) → strings (last resort). " +
      "Extracts text only — images are not extracted. " +
      "For image-based/scanned PDFs, use render_pdf_page instead.",
    parameters: readDocSchema,
    execute: async (
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ lines: number; format: string; method?: string }>> => {
      if (!fsSync.existsSync(params.path)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${params.path}` }],
          details: { lines: 0, format: "none" },
        };
      }

      const ext = params.path.toLowerCase().split(".").pop() || "";
      const isPdf = PDF_FORMATS.includes(ext);
      const isTextutil = TEXTUTIL_FORMATS.includes(ext);

      if (!isPdf && !isTextutil) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unsupported format: .${ext}. Supported: ${ALL_FORMATS.join(", ")}`,
            },
          ],
          details: { lines: 0, format: "none" },
        };
      }

      const maxLines = params.maxLines || 500;

      try {
        if (isPdf) {
          const { content, method } = await readPdf(params.path, maxLines);
          const lines = content.split("\n").filter((l) => l.trim().length > 0).length;
          return {
            content: [{ type: "text" as const, text: content }],
            details: { lines, format: "pdf", method },
          };
        } else {
          const outputFormat = params.format || "txt";
          const content = await readWithTextutil(params.path, outputFormat, maxLines);
          const lines = content.split("\n").filter((l) => l.trim().length > 0).length;
          return {
            content: [{ type: "text" as const, text: content }],
            details: { lines, format: ext },
          };
        }
      } catch (error) {
        const message = (error as Error).message;
        return {
          content: [{ type: "text" as const, text: `Error reading document: ${message}` }],
          details: { lines: 0, format: isPdf ? "pdf" : ext },
        };
      }
    },
  });

  // ── PDF Page Renderer ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "render_pdf_page",
    label: "Render PDF Page",
    description:
      "Render a PDF page as a PNG image for visual analysis. " +
      "Use when read_document returns no text (scanned/image PDFs) or when " +
      "you need to inspect layout, figures, tables, or formatting. " +
      "Returns the image inline AND saves it to a temp path (exposed in details). " +
      "If you lacks vision, use the saved path with analyze_image.",
    parameters: pdfScreenshotSchema,
    execute: async (
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ): Promise<
      AgentToolResult<{ page: number; width: number; height: number; scale: number; path: string }>
    > => {
      if (!fsSync.existsSync(params.path)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${params.path}` }],
          details: { page: 0, width: 0, height: 0, scale: params.scale ?? 1.0, path: "" },
        };
      }
      const page = params.page ?? 1;
      const scale = params.scale ?? 1.0; // 1.0 = 72dpi (readable, ~50% smaller than 1.5x)

      try {
        const buf = await fs.readFile(params.path);
        const parser = new PDFParse({ data: buf });
        const result = await parser.getScreenshot({
          scale,
          partial: [page],
        });

        const pageData = result.pages?.[0];
        if (!pageData?.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to render page ${page} of "${params.path}": ${result.pages?.length ? "page returned no image data" : "page not found in document"}`,
              },
            ],
            details: { page, width: 0, height: 0, scale, path: "" },
          };
        }

        const tmpPath = `/tmp/pdf_page_${Date.now()}.png`;
        fsSync.writeFileSync(tmpPath, pageData.data);

        const imageBase64 =
          pageData.data instanceof Uint8Array
            ? Buffer.from(pageData.data).toString("base64")
            : typeof pageData.data === "string"
              ? pageData.data
              : Buffer.from(pageData.data as ArrayBufferLike).toString("base64");

        return {
          content: [
            { type: "image" as const, data: imageBase64, mimeType: "image/png" },
            {
              type: "text" as const,
              text:
                `Page ${page} rendered at ${scale}x scale (${pageData.width ?? 0}x${pageData.height ?? 0}px). ` +
                `Saved to: ${tmpPath}. If your model can't view images, use analyze_image("${tmpPath}") with a vision-capable model.`,
            },
          ],
          details: {
            page,
            width: pageData.width ?? 0,
            height: pageData.height ?? 0,
            scale,
            path: tmpPath,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error rendering "${params.path}" page ${page}: ${(error as Error).message}`,
            },
          ],
          details: { page, width: 0, height: 0, scale, path: "" },
        };
      }
    },
  });
}
