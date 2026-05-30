/**
 * Vision Extension — analyze_image tool
 *
 * Two-phase LLM-as-judge approach:
 *   Phase 1 (classifier): Lightweight LLM call classifies the image into a type.
 *   Phase 2 (analysis):  Targeted analysis prompt based on the classification.
 *
 * Supports an optional `query` parameter — when the agent has a specific
 * question about the image, it's used as the Phase 2 prompt instead of the
 * generic type-specific template.
 *
 * The tool result includes the image as inline content so the TUI renders a
 * preview alongside the analysis text.
 *
 * This replaces the former monolithic master prompt (~500 lines) that tried to
 * cover every image type in one shot. The classifier gives us structured context
 * so the analysis phase uses a precise, type-appropriate prompt.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveVisionModel } from "../../lib/ai/model-resolver.js";
import { createLogger } from "../../lib/core/logger.js";

// ── Logger ──

const log = createLogger("vision");

// ── Constants ──

const SUPPORTED_FORMATS = ["jpg", "jpeg", "png", "gif", "webp"];
const MB = 1024 * 1024;
const MAX_IMAGE_MB = 5;
const PREVIEW_THRESHOLD_MB = 2;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ── Types ──

interface ImageMeta {
  width: number;
  height: number;
  ratio: number;
  isExtreme: boolean;
  isOversized: boolean;
  isPreviewable: boolean;
  sizeMB: number;
  sizeWarning?: string;
  ratioWarning?: string;
}

interface ClassifyResult {
  type: "ui-web" | "game-asset" | "brand" | "illustration" | "document" | "photograph" | "other";
  hasText: boolean;
  isPixelArt: boolean;
  isSpritesheet: boolean;
  grid: string; // "NxM" or "none"
  colors: "low" | "medium" | "high";
}

interface AnalysisResult {
  analysis: string;
  model: Model<Api> | undefined;
  path: string;
  mimeType: string;
  detail: "standard" | "comprehensive";
  classification: ClassifyResult;
  imageBase64: string;
  query?: string;
}

// ── Utilities ──

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, os.homedir()) : p;
}

function isImage(p: string): boolean {
  return SUPPORTED_FORMATS.includes(path.extname(p).toLowerCase().slice(1));
}

function getMime(p: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[path.extname(p).toLowerCase().slice(1)] || "image/jpeg";
}

function readBase64(p: string): { data: string; mime: string } | null {
  try {
    const buf = fs.readFileSync(p);
    return { data: buf.toString("base64"), mime: getMime(p) };
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** Read minimal file header bytes to extract dimensions without loading full image. */
function getMeta(p: string): ImageMeta | null {
  try {
    const buf = fs.readFileSync(p);
    let w = 0;
    let h = 0;
    const ext = path.extname(p).toLowerCase();

    if (ext === ".png" && buf.length > 24) {
      w = buf.readUInt32BE(16);
      h = buf.readUInt32BE(20);
    } else if ((ext === ".jpg" || ext === ".jpeg") && buf.length > 10) {
      let off = 2;
      while (off < buf.length - 9 && off < 10000) {
        if (buf[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc4) {
          h = buf.readUInt16BE(off + 5);
          w = buf.readUInt16BE(off + 7);
          break;
        }
        if (marker !== 0xff && marker !== 0x00 && marker !== 0xd8 && marker !== 0xd9) {
          off += 2 + buf.readUInt16BE(off + 2);
        } else {
          off += 2;
        }
      }
    } else if (ext === ".gif" && buf.length > 10) {
      w = buf.readUInt16LE(6);
      h = buf.readUInt16LE(8);
    } else if (ext === ".webp" && buf.length > 30) {
      const fcc = buf.toString("ascii", 12, 16);
      if (fcc === "VP8 " && buf.length > 30) {
        w = buf.readUInt16LE(26) & 0x3fff;
        h = buf.readUInt16LE(28) & 0x3fff;
      } else if (fcc === "VP8L" && buf.length > 25) {
        const bits = buf.readUInt32LE(21);
        w = (bits & 0x3fff) + 1;
        h = ((bits >> 14) & 0x3fff) + 1;
      }
    }

    if (!w || !h) return null;

    const s = fs.statSync(p);
    const sizeMB = s.size / MB;
    const ratio = w / h;
    return {
      width: w,
      height: h,
      ratio,
      isExtreme: ratio > 20 || ratio < 1 / 20,
      isOversized: sizeMB > MAX_IMAGE_MB,
      isPreviewable: sizeMB < PREVIEW_THRESHOLD_MB,
      sizeMB,
      sizeWarning:
        sizeMB > MAX_IMAGE_MB
          ? `Image is ${sizeMB.toFixed(1)}MB (max recommended: ${MAX_IMAGE_MB}MB). Analysis may be slower.`
          : undefined,
      ratioWarning:
        ratio > 20 || ratio < 1 / 20
          ? `Extreme aspect ratio (${ratio.toFixed(1)}:1). Content at edges may be missed by the vision model. Consider cropping or splitting.`
          : undefined,
    };
  } catch {
    return null;
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────

/**
 * Phase 1 prompt: classifier — lightweight LLM call to categorise the image.
 * The model outputs a short parseable header that the analysis phase reads.
 */
const CLASSIFIER_PROMPT = `Classify this image. Output exactly two lines:

TYPE=<category>
FLAGS=<comma-separated flags>

Categories (pick one):
  ui-web        — websites, apps, dashboards, mockups, wireframes
  game-asset    — sprites, spritesheets, tilemaps, game UI, characters
  brand         — logos, brand materials, business cards, style guides
  illustration  — concept art, illustrations, digital paintings, icons
  document      — documents, flowcharts, diagrams, architecture drawings, specs
  photograph    — real-world photos, product shots
  other         — anything else

Flags (pick all that apply):
  has-text       — image contains readable text
  pixel-art      — appears to be pixel art (low-res, blocky)
  spritesheet    — contains multiple sprite cells in a grid
  grid<NxM>      — if spritesheet, grid dimensions (e.g. grid4x4)
  low-colors     — limited palette (~16 or fewer distinct colors)
  medium-colors  — moderate palette (17-64 colors)
  high-colors    — full-color image (65+ colors)

Example:
TYPE=ui-web
FLAGS=has-text,high-colors

Output ONLY the two lines, nothing else.`;

/**
 * Phase 2 prompts: targeted analysis by image type.
 * Each covers the relevant dimensions for that type specifically.
 * The {meta} and {ratioWarning} placeholders are substituted at runtime.
 */
const ANALYSIS_PROMPTS: Record<string, string> = {
  "ui-web": `Analyze this UI/web screenshot or mockup. Cover:

1. **What is this?** — page/screen type, purpose, what the user can do here
2. **Layout** — grid system (columns/rows), margins, spacing rhythm, responsive cues
3. **Components** — list every UI element with estimated dimensions and role
4. **Text** — extract ALL visible text preserving structure. Note typefaces, sizes, hierarchy
5. **Colors** — dominant palette (hex codes with % coverage), harmony type, roles
6. **Typography** — typefaces, heading/body/caption hierarchy, font size estimates
7. **Design System ID** — Material / Shadcn / Tailwind / Bootstrap / Ant Design / custom
8. **Platform** — mobile / desktop / web / native; OS cues
9. **Issues** — misalignment, contrast problems, overflow, inconsistent styling
10. **Accessibility** — color contrast concerns, touch targets, font legibility

{meta}
{ratioWarning}`,

  "game-asset": `Analyze this game asset. Cover:

1. **Asset type** — sprite, spritesheet, tilemap, UI, character, environment, icon
2. **Grid structure** (for spritesheets): columns × rows, cell dimensions, spacing, total sprites
3. **Color palette** — list hex codes, palette size, type (indexed/dithered/flat/gradient)
4. **Per-sprite content** — describe each cell, note deltas between animation frames
5. **Consistency** — style, shading, proportions, line weight across all sprites
6. **Anomalies** — missing features, palette deviations, alignment issues
7. **Quality** — anti-aliasing artifacts, scaling issues, compression, banding
8. **Hardware constraints** — if limited palette, note implied platform (NES, GB, PICO-8, etc.)

{meta}
{ratioWarning}`,

  "brand": `Analyze this brand/ marketing material. Cover:

1. **Material type** — logo, business card, style guide, ad, presentation, etc.
2. **Logo analysis** — style (wordmark/icon/combination), colors, proportions, clear space
3. **Color palette** — hex codes, brand color adherence, harmony type
4. **Typography** — typefaces used, hierarchy, consistency
5. **Layout** — grid structure, alignment, white space
6. **Brand consistency score** — excellent / good / fair / poor
7. **Effectiveness** — does it communicate the intended message clearly?
8. **Issues** — color mismatches, typography conflicts, poor contrast

{meta}
{ratioWarning}`,

  "illustration": `Analyze this illustration / digital art. Cover:

1. **Art style** — realism, stylized, vector, painterly, pixel art, line art, etc.
2. **Color** — palette (hex codes), harmony, temperature (warm/cool/neutral)
3. **Lighting** — direction, quality (hard/soft), consistency
4. **Composition** — rule of thirds, visual weight, focal point, flow
5. **Depth** — perspective, overlap, atmospheric cues, scale
6. **Shading** — cel-shaded, gradient, cross-hatch, dithering, none
7. **Texture** — brush texture, paper grain, noise
8. **Quality** — anti-aliasing, compression artifacts, color banding

{meta}
{ratioWarning}`,

  "document": `Analyze this document / diagram. Cover:

1. **Document type** — spec, report, whiteboard, slide, architecture diagram, code screenshot
2. **Text content** — extract ALL visible text preserving structure and formatting
3. **Information architecture** — headings, sections, grouping, nesting
4. **Readability** — font size, contrast, line spacing
5. **Diagram clarity** — flows, arrows, legend, color coding, labels
6. **Missing context** — cut-off content, unlabeled items, ambiguous elements

{meta}
{ratioWarning}`,

  "photograph": `Analyze this photograph. Cover:

1. **Subject** — main subject, setting, context
2. **Composition** — rule of thirds, leading lines, framing, balance
3. **Color** — dominant palette (hex codes), temperature, harmony
4. **Lighting** — natural/artificial, direction, quality, mood
5. **Depth & focus** — foreground/midground/background, depth of field
6. **Technical** — estimated exposure, white balance hints
7. **Overall impression** — aesthetic quality, emotional tone

{meta}
{ratioWarning}`,

  "other": `Analyze this image in detail. Cover:

1. **What is this?** — describe the image content and purpose
2. **Visual elements** — colors (hex codes), shapes, patterns, text
3. **Composition** — layout, focal points, balance, hierarchy
4. **Technical quality** — resolution, artifacts, clarity
5. **Notable details** — anything distinctive or unusual

{meta}
{ratioWarning}`,
};

// ── Classification ───────────────────────────────────────────────────────────

function parseClassification(raw: string): ClassifyResult {
  const def: ClassifyResult = {
    type: "other",
    hasText: false,
    isPixelArt: false,
    isSpritesheet: false,
    grid: "none",
    colors: "high",
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("TYPE=")) {
      const val = trimmed.slice(5).trim().toLowerCase();
      const valid = ["ui-web", "game-asset", "brand", "illustration", "document", "photograph", "other"];
      if (valid.includes(val)) def.type = val as ClassifyResult["type"];
    }
    if (trimmed.startsWith("FLAGS=")) {
      const flags = trimmed.slice(6).split(",").map((f) => f.trim().toLowerCase());
      def.hasText = flags.includes("has-text");
      def.isPixelArt = flags.includes("pixel-art");
      def.isSpritesheet = flags.includes("spritesheet");
      def.colors = flags.includes("low-colors")
        ? "low"
        : flags.includes("medium-colors")
          ? "medium"
          : "high";
      const gridFlag = flags.find((f) => f.startsWith("grid"));
      if (gridFlag) def.grid = gridFlag.slice(4);
    }
  }

  return def;
}

async function classifyImage(
  model: Model<Api>,
  apiKey: string,
  imageB64: string,
  mime: string,
): Promise<ClassifyResult> {
  const result = await completeSimple(
    model,
    {
      systemPrompt: "You classify images by type and visual properties. Respond concisely.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: CLASSIFIER_PROMPT },
            { type: "image", data: imageB64, mimeType: mime },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: 150, temperature: 0 },
  );

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((t) => t.text)
    .join("\n");

  return parseClassification(text);
}

// ── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Wraps completeSimple with exponential backoff for transient failures.
 * The pi-ai SDK already handles quick retries; this catches sustained errors.
 */
async function callWithRetry(
  model: Model<Api>,
  context: Parameters<typeof completeSimple>[1],
  options: Parameters<typeof completeSimple>[2],
  label: string,
): Promise<ReturnType<typeof completeSimple>> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await completeSimple(model, context, options);
      if (!result.errorMessage) return result;

      const msg = result.errorMessage.toLowerCase();
      const isTransient =
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("500") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504") ||
        msg.includes("timeout") ||
        msg.includes("econnreset") ||
        msg.includes("etimedout");

      const isFatal =
        msg.includes("unauthorized") ||
        msg.includes("authentication") ||
        msg.includes("api key") ||
        msg.includes("model not available") ||
        msg.includes("no vision-capable model");

      if (isFatal) throw new Error(result.errorMessage);
      if (!isTransient || attempt === MAX_RETRIES) {
        log.warn(`${label} non-transient error (attempt ${attempt + 1}): ${msg}`);
        throw new Error(result.errorMessage);
      }

      const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (msg.includes("429") ? 2 : 1);
      log.warn(`${label} transient (attempt ${attempt + 1}), retry in ${delay}ms: ${msg}`);
      await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const msg = String(err);
      if (msg.includes("429") || msg.includes("unauthorized") || msg.includes("api key")) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      log.warn(`${label} error (attempt ${attempt + 1}), retry in ${delay}ms: ${msg}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(`${label} failed after ${MAX_RETRIES} retries`);
}

// ── Main Analysis ────────────────────────────────────────────────────────────

async function performAnalysis(
  ctx: ExtensionContext,
  absolutePath: string,
  detail: "standard" | "comprehensive",
  query?: string,
  onUpdate?: (msg: string) => void,
): Promise<AnalysisResult> {
  const model = resolveVisionModel(ctx);
  if (!model) {
    throw new Error(
      "No vision-capable model available. Configure via /vision-model or use a model that supports image input.",
    );
  }

  if (!fs.existsSync(absolutePath)) throw new Error(`File not found: ${absolutePath}`);
  if (!isImage(absolutePath)) {
    throw new Error(`Unsupported format. Supported: ${SUPPORTED_FORMATS.join(", ")}`);
  }

  const sizeCheck = fs.statSync(absolutePath);
  const encoded = readBase64(absolutePath);
  if (!encoded) throw new Error(`Failed to read: ${absolutePath}`);
  const meta = getMeta(absolutePath);
  const mime = getMime(absolutePath);

  // Phase 1: classify
  const metaLines = [`Analyzing: ${absolutePath}`];
  if (meta) {
    metaLines.push(`Dimensions: ${meta.width}×${meta.height} (${meta.ratio.toFixed(1)}:1)`);
  }
  metaLines.push(`Size: ${formatSize(sizeCheck.size)}`);
  metaLines.push(`MIME: ${mime}`);
  metaLines.push(`Detail: ${detail}`);
  if (meta?.sizeWarning) metaLines.push(meta.sizeWarning);
  metaLines.push(`Vision model: ${model.provider}/${model.id}`);
  onUpdate?.(metaLines.join("\n"));

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) {
    throw new Error(
      `No API key for ${model.provider}. Set ${model.provider.toUpperCase()}_API_KEY or use /login.`,
    );
  }

  // Phase 1: Classify image using LLM-as-judge
  onUpdate?.("Classifier: running...");
  const classification = await classifyImage(model, apiKey, encoded.data, encoded.mime);
  log.info(
    `Classified: ${classification.type} (pixel=${classification.isPixelArt}, sprite=${classification.isSpritesheet})`,
  );
  onUpdate?.(`Classifier: ${classification.type}${classification.isPixelArt ? " (pixel art)" : ""}${classification.isSpritesheet ? " (spritesheet)" : ""}`);

  // Build dimension annotations
  const metaNote = meta
    ? `**Metadata**: ${meta.width}×${meta.height}px, ${meta.ratio.toFixed(1)}:1 ratio`
    : "";
  const ratioNote = meta?.ratioWarning ?? "";

  // Phase 2: determine analysis prompt
  let analysisPrompt: string;
  let systemPrompt: string;

  if (query) {
    // Agent provided a specific question — use it directly with context
    analysisPrompt = `Answer this question about the image:\n\n${query}\n\nContext: this image was classified as "${classification.type}"${classification.isPixelArt ? ", pixel art" : ""}${classification.isSpritesheet ? ", spritesheet" : ""}.\n\n${metaNote}\n${ratioNote}`.trim();
    systemPrompt = "You are a precise image analyst. Answer the user's question about the image thoroughly based on what you can see.";
    onUpdate?.(`Analysis: answering query with ${detail} detail...`);
  } else {
    // Standard analysis: use type-specific prompt
    const typeKey = classification.type === "game-asset" && classification.isPixelArt
      ? "game-asset"
      : classification.type;
    const promptTemplate = ANALYSIS_PROMPTS[typeKey] ?? ANALYSIS_PROMPTS["other"];
    analysisPrompt = promptTemplate
      .replace("{meta}", metaNote)
      .replace("{ratioWarning}", ratioNote);

    systemPrompt =
      classification.isPixelArt
        ? "You are an expert in pixel art, spritesheets, and game asset analysis. Provide precise, technical descriptions with pixel-level measurements."
        : "You are a professional image analyst. Extract every measurable detail. Be precise with hex codes, estimated pixel values, and specific descriptions.";

    onUpdate?.(`Analysis: using ${typeKey} prompt with ${detail} detail...`);
  }

  const result = await callWithRetry(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: analysisPrompt },
            { type: "image", data: encoded.data, mimeType: encoded.mime },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      maxTokens: detail === "comprehensive" ? 8192 : 4096,
      temperature: 0.3,
    },
    `Vision analysis (${model.provider}/${model.id})`,
  );

  const textContent = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((t) => t.text);
  let analysis = textContent.join("\n").trim() || "(No analysis produced)";

  // Append metadata footer
  if (meta) {
    analysis += `\n\n---\n**Image**: ${meta.width}×${meta.height}px, ${meta.ratio.toFixed(1)}:1 ratio`;
    if (meta.ratioWarning) analysis += `\n**Warning**: ${meta.ratioWarning}`;
  }

  return {
    analysis,
    model,
    path: absolutePath,
    mimeType: mime,
    detail,
    classification,
    imageBase64: encoded.data,
    query,
  };
}

// ── Extension Registration ───────────────────────────────────────────────────

export default function visionExtension(pi: ExtensionAPI) {
  // ── Tool: analyze_image ──────────────────────────────────────────────────

  pi.registerTool({
    name: "analyze_image",
    label: "Analyze Image",
    description:
      "Analyze an image file using a vision model with a two-phase LLM-as-judge approach. " +
      "Phase 1 classifies the image type (UI, game asset, brand, illustration, document, photo) using a lightweight classifier call. " +
      "Phase 2 runs a targeted analysis prompt based on the classification. " +
      "Reports dimensions, aspect ratio, color palette, text, components, quality issues. " +
      "Supports standard and comprehensive detail levels. " +
      "Accepts an optional `query` parameter — if you have a specific question about the image, pass it here and Phase 2 will answer it directly.",
    parameters: Type.Object({
      imagePath: Type.String({
        description: "Path to the image file (jpg, jpeg, png, gif, webp)",
      }),
      detail: Type.Optional(
        Type.Union([Type.Literal("standard"), Type.Literal("comprehensive")], {
          description:
            "Analysis detail level. 'standard' is faster and covers essentials. " +
            "'comprehensive' performs in-depth design, accessibility, and domain-specific analysis with up to 8K token output. Default: 'standard'.",
          default: "standard",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            "Optional specific question about the image. When provided, Phase 2 answers this question directly instead of running the generic type-specific analysis prompt.",
        }),
      ),
    }),

    execute: async (
      _toolCallId,
      params: { imagePath: string; detail?: "standard" | "comprehensive"; query?: string },
      _signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<unknown>> => {
      const imagePathExpanded = expandHome(params.imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);
      const detail = params.detail ?? "standard";
      const query = params.query;

      if (!fs.existsSync(absolutePath)) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${params.imagePath}` }],
          details: { path: absolutePath, error: "file_not_found" },
        };
      }

      if (!isImage(absolutePath)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: "${params.imagePath}" is not a supported image file. Supported formats: ${SUPPORTED_FORMATS.join(", ")}`,
            },
          ],
          details: { path: absolutePath, supported: SUPPORTED_FORMATS },
        };
      }

      try {
        const result = await performAnalysis(ctx, absolutePath, detail, query, (msg) => {
          onUpdate?.({ content: [{ type: "text", text: msg }], details: { status: "analyzing" } });
        });

        const header = query
          ? `[Image analyzed: ${absolutePath}] (query: "${query}")\n[Classification: ${result.classification.type}${result.classification.isPixelArt ? ", pixel art" : ""}${result.classification.isSpritesheet ? ", spritesheet" : ""}]\n\n`
          : `[Image analyzed: ${absolutePath}] (detail: ${detail})\n[Classification: ${result.classification.type}${result.classification.isPixelArt ? ", pixel art" : ""}${result.classification.isSpritesheet ? ", spritesheet" : ""}]\n\n`;

        return {
          content: [
            { type: "image" as const, data: result.imageBase64, mimeType: result.mimeType },
            {
              type: "text",
              text: `${header}${result.analysis}`,
            },
          ],
          details: {
            path: absolutePath,
            mimeType: result.mimeType,
            detail: result.detail,
            classification: result.classification,
            visionModel: result.model?.id,
            query: result.query,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Image analysis failed: ${message}` }],
          details: { error: message },
        };
      }
    },
  });

  // ── Command: /analyze-image ──────────────────────────────────────────────

  pi.registerCommand("analyze-image", {
    description:
      "Analyze an image using a vision-capable model. Supports optional detail level: /analyze-image --detail=comprehensive <path>. Usage: /analyze-image <path>",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /analyze-image [--detail=standard|comprehensive] <image-path>",
          "error",
        );
        return;
      }

      let detail: "standard" | "comprehensive" = "standard";
      let imagePath = trimmed;
      const detailMatch = trimmed.match(/^--detail=(standard|comprehensive)\s+(.+)$/);
      if (detailMatch) {
        detail = detailMatch[1] as "standard" | "comprehensive";
        imagePath = detailMatch[2];
      }

      const imagePathExpanded = expandHome(imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);

      if (!isImage(absolutePath)) {
        ctx.ui.notify(
          `Not a supported image file. Supported: ${SUPPORTED_FORMATS.join(", ")}`,
          "error",
        );
        return;
      }

      const stats = fs.statSync(absolutePath);
      if (stats.size > MAX_IMAGE_MB * MB) {
        ctx.ui.notify(
          `Image is ${formatSize(stats.size)} (max recommended: ${MAX_IMAGE_MB}MB). Analysis may be slower.`,
          "warning",
        );
      }

      try {
        const result = await performAnalysis(ctx, absolutePath, detail);
        const header = `[Image: ${absolutePath}]\n[Size: ${formatSize(stats.size)}]\n[Detail: ${result.detail}]\n[Type: ${result.classification.type}]\n\n`;
        await ctx.ui.editor("Image Analysis", header + result.analysis);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Analysis failed: ${message}`, "error");
      }
    },
  });
}