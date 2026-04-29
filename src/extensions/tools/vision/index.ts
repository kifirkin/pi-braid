import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("vision");
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { resolveVisionModel } from "../../../lib/model-resolver.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_MAX_IMAGE_SIZE_MB = 5;
const IMAGE_PREVIEW_THRESHOLD_MB = 2;

// ── Analysis Prompts ─────────────────────────────────────────────────────────

/**
 * Master analysis prompt — comprehensive, domain-aware, design-investigative.
 *
 * Covers 6 layers of analysis regardless of image type:
 *   1. Image Classification (domain detection)
 *   2. Universal Metadata + Design Properties
 *   3. Design Analysis (color, typography, layout, composition, accessibility)
 *   4. Domain-Specific Analysis (UI, game, brand, art, document, photo)
 *   5. Accessibility & Quality Audit
 *   6. Actionable Findings with priority triage
 */
const MASTER_ANALYSIS_PROMPT = `You are a professional design analyst and image investigator. Analyze this image with maximum thoroughness across ALL relevant dimensions. Do not skip any step — each layer catches what the others miss.

---

## STEP 1: IMAGE CLASSIFICATION

Classify this image into ONE primary category and list any secondary categories:

- **UI/Web Design** — websites, apps, dashboards, mockups, wireframes, components
- **Game Asset** — sprites, spritesheets, tilemaps, game UI, characters, environments
- **Brand Material** — logos, brand assets, marketing materials, business cards, style guides
- **Illustration / Digital Art** — concept art, illustrations, digital paintings, icons
- **Document / Diagram** — documents, flowcharts, diagrams, architecture drawings, specs
- **Photograph** — real-world photos, product shots, screenshots of physical objects
- **Mixed / Other** — describe specifically

## STEP 2: UNIVERSAL METADATA & DESIGN PROPERTIES

Extract every measurable property:

| Property | Value |
|----------|-------|
| Image Type | [classification result] |
| Dimensions | — from metadata |
| Aspect Ratio | — from metadata |
| Format | — from metadata |
| Dominant Colors | Top 5-8 hex codes with approximate % coverage |
| Color Harmony | complementary / analogous / triadic / monochromatic / split-complementary / tetradic / achromatic / custom / none |
| Color Temperature | warm / cool / neutral / mixed |
| Overall Contrast | high / medium / low |
| Information Density | high / medium / low (with evidence) |
| Grid / Layout System | column / row / modular / hybrid / freeform / none detected |
| Symmetry | symmetric / asymmetric / radial / irregular |
| Typography Present? | yes / no ; if yes → list typefaces detected |
| Focal Point | describe where the eye lands first, and why |
| Visual Hierarchy Strength | strong / moderate / weak |

## STEP 3: DESIGN ANALYSIS (always performed)

### 3a. Color Palette & Harmony
- List ALL distinct colors with hex codes (min 5, max 15)
- Identify the color harmony type (complementary, analogous, etc.)
- Estimate contrast ratios between adjacent / overlapping colors
- Classify each color's role: background, primary text, accent, border, surface, error, success, etc.
- Flag any near-identical colors that cause visual muddiness (delta-E < 5)
- Detect color accessibility issues (red-green pairings, low saturation on important elements)
- Is there a consistent palette or does it appear ad-hoc?

### 3b. Typography Analysis (if text is present)
- List every distinct typeface detected and how many sizes/weights
- Describe the typographic hierarchy: what reads as heading vs body vs caption vs label
- Estimate font sizes, weights, line heights from context
- Assess readability: line length, line height, contrast with background
- Flag typography issues: too many typefaces (>3), insufficient size contrast, cramped leading
- Note any font pairing logic (serif + sans, mono + sans, single family)

### 3c. Layout & Spacing
- Detect the grid system: columns, rows, margins, gutters
- Measure spacing rhythm: does it follow a consistent scale (4px, 8px, etc.) or is it ad-hoc?
- Analyze alignment: left/right/center/justified — consistent or inconsistent?
- Describe the layout structure: single column, multi-column, card grid, freeform, etc.
- Evaluate white space usage: generous, adequate, cramped, uneven
- Map element grouping and spatial relationships

### 3d. Composition & Visual Weight
- Apply the rule of thirds: where do key elements fall?
- Analyze visual weight distribution per quadrant (Q1-Q4) — what draws attention where?
- Assess balance: symmetrical, asymmetrical (what counterbalances what?), or unbalanced
- Identify visual flow: how does the eye travel through the composition?
- Evaluate proportion and scale relationships between elements
- Detect tension: intentional (drama, emphasis) vs unintentional (awkward spacing/alignment)

### 3e. Brand Identity Elements (if applicable)
- Is there a clear brand presence? (logo, consistent colors, typography)
- Logo placement, sizing, clear space usage
- Color consistency with what appears to be the brand palette
- Typography adherence to a single system
- Overall brand voice communicated through visuals (premium, playful, minimal, technical, etc.)

## STEP 4: DOMAIN-SPECIFIC ANALYSIS

Apply only the section(s) relevant to this image's classification.

### 4a. UI/Web Design
- Component taxonomy: list every UI component visible (buttons, cards, inputs, nav bars, modals, dropdowns, tables, lists, etc.)
- UI patterns: forms, search, data tables, pagination, onboarding, etc.
- State indicators: hover, active, disabled, selected, error, loading, empty states
- Design system identification: Material Design / Shadcn / Radix / Tailwind / Bootstrap / Ant Design / custom / none detected
- Platform cues: mobile (iOS/Android), desktop, web, native
- Responsive indicators: breakpoint hints, adaptive layouts
- Touch target sizing estimation (minimum 44×44px for mobile)
- Form validation patterns: inline errors, tooltips, toast messages
- Navigation patterns: tab bar, sidebar, hamburger, breadcrumbs, top nav
- List what the user CAN do on this screen (actionable affordances)
- **Flag broken patterns**: misaligned elements, inconsistent button styles, text overflow, overlapping elements, missing states

### 4b. Game Assets
- Asset type: sprite, spritesheet, tilemap, UI element, character, environment, icon, particle
- Grid detection (for spritesheets): columns × rows, cell dimensions, spacing, total sprites
- Palette: list all colors with hex codes, identify palette type (flat, gradients, dithered)
- Per-sprite analysis: for each sprite cell, describe content, colors, fill percentage
- Animation inference: frame count, implied motion (idle → walk → run), transition smoothness
- Scale multiplier estimation if scaled up
- Anomaly detection: missing features, differing palettes, irregular borders, misalignment
- Quality issues: anti-aliasing artifacts, compression, color banding, blurring
- **Style consistency**: do all sprites share the same art style, line weight, shading?

### 4c. Brand / Marketing Material
- Logo analysis: style (wordmark, icon, combination), colors, proportions, clear space
- Brand color adherence: does the material use a consistent palette?
- Typography: consistent type system or multiple unrelated fonts?
- Layout: grid-based or freeform? Does it follow brand templates?
- Imagery style: photography, illustration, abstract — consistent with brand?
- **Consistency score**: estimate how well this material adheres to a unified brand system
- Effectiveness: does it communicate the intended message clearly?

### 4d. Illustration / Digital Art
- Art style: realism, stylized, minimalist, vector, painterly, pixel art, line art
- Lighting: direction (top-down, side, rim), quality (hard, soft, ambient), consistency
- Shading: cel-shaded, smooth gradient, cross-hatch, dithering, no shading
- Depth cues: perspective (1-point, 2-point, isometric), overlap, atmospheric, scale
- Texture analysis: brush texture, paper texture, noise, gradients
- Color use: local color, atmospheric color, color script

### 4e. Document / Diagram
- Document type: spec, report, screenshot, whiteboard, slide, architecture diagram
- Text readability: font size, contrast, line spacing
- Information architecture: headings, sections, grouping, nesting
- Diagram clarity: arrow flows, legend, color coding, labels
- Missing context: is anything cut off, unlabeled, ambiguous?

## STEP 5: ACCESSIBILITY & QUALITY AUDIT

### Accessibility
- Color contrast: flag any text-on-background pairs likely below WCAG AA (4.5:1 for normal text, 3:1 for large text)
- Font size: is body text large enough to read? (UI text < 11px is problematic)
- Touch targets: are interactive elements likely ≥44×44px (mobile) or ≥24×24px (desktop)?
- Color-blind safety: does the design rely solely on color to convey information?
- Focus indicators: are there visible focus/selection states?

### Quality Issues
- Anti-aliasing or scaling artifacts
- Compression artifacts (JPEG blockiness, color banding)
- Resolution mismatch elements
- Alignment or spacing errors
- Missing or broken elements
- Text truncation or overflow
- Inconsistent styling

## STEP 6: ACTIONABLE FINDINGS

### P0 — CRITICAL (blocks usability, broken, inaccessible)
List each with: [Issue] → [Evidence] → [Specific Fix]

### P1 — MAJOR (significant quality or consistency gap)
List each with: [Issue] → [Evidence] → [Specific Fix]

### P2 — MINOR (polish opportunity)
List each with: [Issue] → [Fix]

### Top 3 Recommendations
What three changes would have the highest impact?

---

**Format**: Use clear sections with precise values. Include hex codes, estimated px values, and specific descriptions. Be exhaustive — no detail is too small. This analysis drives real design decisions.`;

/**
 * Pixel art / spritesheet analysis prompt — enhanced.
 */
const PIXEL_ART_PROMPT = `This is a pixel art image or spritesheet. Analyze it as pixel art — do NOT treat it as a natural photograph.

**Dimensions**: {width}×{height} pixels
{extremeRatioWarning}

---

## PART 1: IMAGE TYPE & STRUCTURE

1. **Type**: single sprite, spritesheet grid, tilemap, UI element, icon set, animation frames, or other
2. **Grid Detection** (for spritesheets):
   - Columns × Rows
   - Cell dimensions (width × height per cell)
   - Spacing/gaps between cells (px)
   - Total sprite count
   - Are all cells the same size? (yes/no — flag mismatches)
3. **Scale Factor**: if the image appears scaled-up (sharp blocky edges), estimate the multiplier (e.g., 2×, 4×, 8×)

## PART 2: COLOR PALETTE

List ALL distinct colors with hex codes. For each dominant color (>5% coverage), provide approximate percentage.
Analyze:
- Palette size (how many unique colors)
- Palette type: flat (no blending), dithered, gradient-like, indexed (≤16 colors = retro/game-console), full color
- Color harmony: does the palette follow a scheme (complementary, analogous, monochromatic)?
- Any colors that seem out of place or inconsistent with the rest?
- **Hardware constraints**: if the palette is small (<32 colors), note the implied constraints (Game Boy, NES, PICO-8, etc.)

## PART 3: PER-SPRITE ANALYSIS

For each detected sprite cell:
- Content description (character pose, animation frame, object, tile type)
- Colors present in that cell
- Fill percentage (rough estimate of non-transparent area)
- Notable features, details, expression changes
- **Deltas from adjacent frames** (for animation strips): what changed? (arm position, leg angle, facial expression)

## PART 4: CONSISTENCY & ANOMALY DETECTION

- Style consistency: do all sprites share the same line weight, shading technique, color palette, and level of detail?
- Proportions: are body/object proportions consistent across all sprites?
- Alignment: are all sprites aligned to the same baseline or grid?
- Anomalies to flag:
  - Missing features present in other cells (body parts, accessories, details)
  - Palette deviation (one cell uses colors not found elsewhere)
  - Fill percentage outlier (significantly more or less dense)
  - Irregular borders, misalignment, or uneven spacing
  - Scale mismatch (one sprite noticeably larger or smaller)

## PART 5: QUALITY ISSUES

Report any:
- Blurring or anti-aliasing (indicates the pixel art was scaled, not native resolution)
- Compression artifacts or color banding
- Dithering artifacts or pattern breakup
- Jagged or broken lines where smooth curves are intended
- Visible seam lines for tilesets

## PART 6: SUMMARY

- **Total unique colors**: [N]
- **Sprite count**: [N]
- **Consistency score**: excellent / good / fair / poor
- **Key issues**: [top 2-3 problems]
- **Recommendations**: [actionable improvements]

**Use precise pixel measurements**. Describe positions by pixel coordinates where helpful.`;

// ── Types ────────────────────────────────────────────────────────────────────

interface ImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
  isExtremeRatio: boolean;
  isOversized: boolean;
  isPreviewable: boolean;
  sizeWarning?: string;
  analysisWarning?: string;
}

interface ImageSizeCheck {
  size: number;
  sizeMB: number;
  isOversized: boolean;
  isPreviewable: boolean;
  warning?: string;
}

interface AnalysisResult {
  analysis: string;
  imageData?: { data: string; mimeType: string };
  model: Model<any> | undefined;
  path: string;
  size: number;
  mimeType: string;
  detail: "standard" | "comprehensive";
  sizeWarning?: string;
  analysisWarning?: string;
}

// ── Utility Functions ────────────────────────────────────────────────────────

function expandHomeDir(imagePath: string): string {
  if (imagePath.startsWith("~/") || imagePath === "~") {
    return imagePath.replace(/^~/, os.homedir());
  }
  return imagePath;
}

function isImageFile(imagePath: string): boolean {
  const ext = path.extname(imagePath).toLowerCase().slice(1);
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

function getMimeType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase().slice(1);
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mimeTypes[ext] || "image/jpeg";
}

function checkImageSize(absolutePath: string): ImageSizeCheck {
  const stats = fs.statSync(absolutePath);
  const size = stats.size;
  const sizeMB = size / BYTES_PER_MB;
  const threshold = DEFAULT_MAX_IMAGE_SIZE_MB;
  const isOversized = sizeMB > threshold;
  const isPreviewable = sizeMB < IMAGE_PREVIEW_THRESHOLD_MB;

  return {
    size,
    sizeMB,
    isOversized,
    isPreviewable,
    warning: isOversized
      ? `Image is ${sizeMB.toFixed(1)}MB (max recommended: ${threshold}MB). Analysis may be slower.`
      : undefined,
  };
}

/**
 * Read minimal header bytes to extract dimensions without loading full image.
 */
function getImageMetadata(absolutePath: string): ImageMetadata | null {
  try {
    const buffer = fs.readFileSync(absolutePath);
    let width = 0;
    let height = 0;

    const ext = path.extname(absolutePath).toLowerCase();

    if (ext === ".png" && buffer.length > 24) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    } else if ((ext === ".jpg" || ext === ".jpeg") && buffer.length > 10) {
      let offset = 2;
      while (offset < buffer.length - 9 && offset < 10000) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc4) {
          height = buffer.readUInt16BE(offset + 5);
          width = buffer.readUInt16BE(offset + 7);
          break;
        }
        if (marker !== 0xff && marker !== 0x00 && marker !== 0xd8 && marker !== 0xd9) {
          const segLen = buffer.readUInt16BE(offset + 2);
          offset += 2 + segLen;
        } else { offset += 2; }
      }
    } else if (ext === ".gif" && buffer.length > 10) {
      width = buffer.readUInt16LE(6);
      height = buffer.readUInt16LE(8);
    } else if (ext === ".webp" && buffer.length > 30) {
      const fourCC = buffer.toString("ascii", 12, 16);
      if (fourCC === "VP8 " && buffer.length > 30) {
        width = buffer.readUInt16LE(26) & 0x3fff;
        height = buffer.readUInt16LE(28) & 0x3fff;
      } else if (fourCC === "VP8L" && buffer.length > 25) {
        const bits = buffer.readUInt32LE(21);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      }
    }

    if (width === 0 || height === 0) return null;

    const aspectRatio = width / height;
    const isExtremeRatio = aspectRatio > 20 || aspectRatio < 1 / 20;
    const sizeCheck = checkImageSize(absolutePath);

    return {
      width, height, aspectRatio, isExtremeRatio,
      isOversized: sizeCheck.isOversized,
      isPreviewable: sizeCheck.isPreviewable,
      sizeWarning: sizeCheck.warning,
      analysisWarning: isExtremeRatio
        ? `Extreme aspect ratio (${aspectRatio.toFixed(1)}:1). Content at edges may be missed by the vision model. Consider cropping or splitting.`
        : undefined,
    };
  } catch {
    return null;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function readImageAsBase64(absolutePath: string): { data: string; mimeType: string } | null {
  try {
    const buffer = fs.readFileSync(absolutePath);
    const mimeType = getMimeType(absolutePath);
    return { data: buffer.toString("base64"), mimeType };
  } catch { return null; }
}

/**
 * Retry wrapper with exponential backoff for transient API failures.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message.toLowerCase();

      const nonRetryable =
        message.includes("unauthorized") || message.includes("authentication") ||
        message.includes("api key") || message.includes("not found") ||
        message.includes("invalid api key") || message.includes("model not available") ||
        message.includes("no api key") || message.includes("no vision-capable model");

      if (nonRetryable || attempt === maxRetries) throw lastError;

      const isRateLimited = message.includes("429") || message.includes("rate limit") || message.includes("too many requests");
      const isServerError = message.includes("500") || message.includes("502") || message.includes("503") || message.includes("504");
      const isNetworkError = message.includes("econnreset") || message.includes("etimedout") || message.includes("enotfound") || message.includes("network");
      const isGpuEngineError = message.includes("enginecore") || message.includes("upstream error") || (message.includes("nvidia") && message.includes("error"));
      const isTransient = isRateLimited || isServerError || isNetworkError || isGpuEngineError || message.includes("timeout");

      if (!isTransient && attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        log.warn(`${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const delay = isRateLimited ? baseDelayMs * Math.pow(2, attempt) * 2 : baseDelayMs * Math.pow(2, attempt);
      log.warn(`${operationName} transient error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error(`${operationName} failed after ${maxRetries} retries`);
}

// ── Prompt Builder ───────────────────────────────────────────────────────────

function buildAnalysisPrompt(
  metadata: ImageMetadata | null,
  detail: "standard" | "comprehensive",
  isPixelArt: boolean,
): { prompt: string; systemPrompt: string } {
  if (isPixelArt) {
    return {
      prompt: PIXEL_ART_PROMPT
        .replace("{width}", String(metadata?.width ?? "?"))
        .replace("{height}", String(metadata?.height ?? "?"))
        .replace("{extremeRatioWarning}", metadata?.analysisWarning ?? ""),
      systemPrompt:
        "You are an expert in pixel art, spritesheets, and game asset analysis. Provide precise, technical descriptions with pixel-level measurements.",
    };
  }

  // For comprehensive detail, use the full master prompt
  if (detail === "comprehensive") {
    return {
      prompt: MASTER_ANALYSIS_PROMPT,
      systemPrompt:
        "You are a professional design analyst and image investigator. Extract every measurable detail. Skip nothing. Be precise with hex codes, estimated pixel values, and specific descriptions.",
    };
  }

  // Standard detail — abridged version of master analysis
  return {
    prompt: `Analyze this image thoroughly. Cover all of the following:

1. **Classification**: What type of content is this? (UI/Web, game asset, brand material, illustration, document, photograph, diagram, code, etc.)
2. **Text Content**: ALL visible text — preserve structure, formatting, exact values. Be exhaustive.
3. **Visual Elements**: Colors (list top 5-8 hex codes with %), layout structure, components, icons
4. **Design Properties**: 
   - Color harmony and palette roles
   - Typography hierarchy (if text present)
   - Grid/layout system detected
   - Visual hierarchy and focal point
   - Overall composition quality
5. **Technical Details**: For code, UI, diagrams — exact values, class names, IDs, parameters, configurations
6. **Context**: Window titles, file names, timestamps, status indicators, prompts
7. **Brand/Design System Cues**: Any recognizable design system, brand colors, consistent patterns
8. **Issues**: Any visible problems — alignment errors, contrast issues, broken elements, artifacts
9. **Accessibility**: Color contrast concerns, font size legibility, touch target sizing
10. **Layout Sketch**: Provide an ASCII art layout sketch using box-drawing characters (┌─┐│└┘) showing relative positions of key elements.

Format with clear sections and precise values. Be thorough.`,
    systemPrompt:
      "You are an image analysis assistant. Provide detailed, accurate descriptions covering design, text, technical details, and quality.",
  };
}

// ── Core Analysis Logic ──────────────────────────────────────────────────────

async function performImageAnalysis(
  ctx: ExtensionContext,
  absolutePath: string,
  detail: "standard" | "comprehensive",
  onUpdate?: (metadata: string) => void,
): Promise<AnalysisResult> {
  const model = resolveVisionModel(ctx);
  if (!model) {
    throw new Error(
      "No vision-capable model available. Configure a vision model via /vision-model or set a model that supports image input.",
    );
  }

  if (!fs.existsSync(absolutePath)) throw new Error(`File not found: ${absolutePath}`);
  if (!isImageFile(absolutePath)) {
    throw new Error(`Not a supported image file. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`);
  }

  const sizeCheck = checkImageSize(absolutePath);
  const imageData = readImageAsBase64(absolutePath);
  const imageBase64 = sizeCheck.isPreviewable ? imageData : undefined;
  const metadata = getImageMetadata(absolutePath);
  const mimeType = getMimeType(absolutePath);

  // Send metadata update
  const metadataLines = [`Analyzing: ${absolutePath}`];
  if (metadata) {
    metadataLines.push(`Dimensions: ${metadata.width}×${metadata.height} (${metadata.aspectRatio.toFixed(1)}:1 ratio)`);
  }
  metadataLines.push(`Size: ${formatFileSize(sizeCheck.size)} (${sizeCheck.sizeMB.toFixed(1)} MB)`);
  metadataLines.push(`MIME: ${mimeType}`);
  metadataLines.push(`Detail: ${detail}`);
  if (sizeCheck.warning) metadataLines.push(sizeCheck.warning);
  metadataLines.push(`Using vision model: ${model.provider}/${model.id}`);
  onUpdate?.(metadataLines.filter(Boolean).join("\n"));

  // API key
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider ${model.provider}. Set ${model.provider.toUpperCase()}_API_KEY environment variable or use /login.`,
    );
  }

  // Detect pixel art
  const ext = path.extname(absolutePath).toLowerCase();
  const isLikelyPixelArt = metadata
    ? metadata.width <= 384 && metadata.height <= 384 && [".png", ".gif", ".webp"].includes(ext)
    : false;

  // Build prompt
  const { prompt: analysisPrompt, systemPrompt } = buildAnalysisPrompt(
    metadata, detail, isLikelyPixelArt,
  );

  const context = {
    systemPrompt,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: analysisPrompt },
          { type: "image" as const, data: imageData?.data ?? "", mimeType: imageData?.mimeType ?? "image/jpeg" },
        ],
        timestamp: Date.now(),
      },
    ],
  };

  const result = await withRetry(
    () => completeSimple(model, context, {
      apiKey,
      maxTokens: detail === "comprehensive" ? 8192 : 4096,
      temperature: 0.3,
    }),
    `Vision analysis (${model.provider}/${model.id})`,
  );

  const textContent = result.content.filter(
    (c): c is { type: "text"; text: string } => c.type === "text",
  );
  const analysis = textContent.map(t => t.text).join("\n");

  if (result.errorMessage) {
    throw new Error(`Analysis failed: ${result.errorMessage}`);
  }

  let annotated = analysis || "(No analysis produced)";
  if (metadata) {
    annotated += `\n\n---\n**Image metadata**: ${metadata.width}×${metadata.height}px, ${metadata.aspectRatio.toFixed(1)}:1 ratio`;
    if (metadata.analysisWarning) {
      annotated += `\n**Warning**: ${metadata.analysisWarning}`;
    }
  }

  return {
    analysis: annotated,
    imageData: imageBase64 ?? undefined,
    model,
    path: absolutePath,
    size: sizeCheck.size,
    mimeType,
    detail,
    sizeWarning: sizeCheck.warning,
    analysisWarning: metadata?.analysisWarning,
  };
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function visionExtension(pi: ExtensionAPI) {
  // Tool: analyze_image

  pi.registerTool({
    name: "analyze_image",
    label: "Analyze Image",
    description:
      "Analyze an image file using a vision model. Automatically detects pixel art, spritesheets, and grid layouts for specialized analysis. Extracts text, visual elements, design properties (color harmony, typography, layout, composition), technical details, and quality issues. Reports image dimensions and aspect ratio warnings. Supports standard and comprehensive detail levels.",
    parameters: Type.Object({
      imagePath: Type.String({
        description: "Path to the image file (jpg, jpeg, png, gif, webp)",
      }),
      detail: Type.Optional(
        Type.Union(
          [Type.Literal("standard"), Type.Literal("comprehensive")],
          { description: "Analysis detail level. 'standard' is faster and covers essentials. 'comprehensive' performs in-depth design, accessibility, and domain-specific analysis with up to 8K token output. Default: 'standard'.", default: "standard" },
        ),
      ),
    }),

    execute: async (
      _toolCallId,
      params: { imagePath: string; detail?: "standard" | "comprehensive" },
      _signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<unknown>> => {
      const imagePathExpanded = expandHomeDir(params.imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);
      const detail = params.detail ?? "standard";

      if (!fs.existsSync(absolutePath)) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${params.imagePath}` }],
          details: { path: absolutePath, error: "file_not_found" },
        };
      }

      if (!isImageFile(absolutePath)) {
        return {
          content: [{ type: "text", text: `Error: "${params.imagePath}" is not a supported image file. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}` }],
          details: { path: absolutePath, supported: SUPPORTED_IMAGE_EXTENSIONS },
        };
      }

      try {
        const result = await performImageAnalysis(ctx, absolutePath, detail, (metadata) => {
          onUpdate?.({
            content: [{ type: "text", text: metadata }],
            details: { status: "analyzing" },
          });
        });

        const resultContent: (TextContent | ImageContent)[] = [];
        if (result.imageData) {
          resultContent.push({
            type: "image" as const,
            data: result.imageData.data,
            mimeType: result.imageData.mimeType,
          });
        }
        resultContent.push({
          type: "text" as const,
          text: `[Image analyzed: ${absolutePath}] (detail: ${detail})\n\n${result.analysis}`,
        });

        return {
          content: resultContent,
          details: {
            path: absolutePath,
            size: result.size,
            mimeType: result.mimeType,
            detail: result.detail,
            imageIncluded: !!result.imageData,
            visionModel: result.model?.id,
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

  // Command: /analyze-image

  pi.registerCommand("analyze-image", {
    description:
      "Analyze an image using a vision-capable model. Supports optional detail level: /analyze-image --detail=comprehensive <path>. Usage: /analyze-image <path>",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /analyze-image [--detail=standard|comprehensive] <image-path>", "error");
        return;
      }

      let detail: "standard" | "comprehensive" = "standard";
      let imagePath = trimmed;
      const detailMatch = trimmed.match(/^--detail=(standard|comprehensive)\s+(.+)$/);
      if (detailMatch) {
        detail = detailMatch[1] as "standard" | "comprehensive";
        imagePath = detailMatch[2];
      }

      const imagePathExpanded = expandHomeDir(imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);

      if (!isImageFile(absolutePath)) {
        ctx.ui.notify(`Not a supported image file. Supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`, "error");
        return;
      }

      const sizeCheck = checkImageSize(absolutePath);
      if (sizeCheck.warning) ctx.ui.notify(sizeCheck.warning, "warning");

      try {
        const result = await performImageAnalysis(ctx, absolutePath, detail);
        const header = `[Image: ${absolutePath}]\n[Size: ${formatFileSize(result.size)}]\n[Detail: ${result.detail}]\n\n`;
        await ctx.ui.editor("Image Analysis", header + result.analysis);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Analysis failed: ${message}`, "error");
      }
    },
  });
}
