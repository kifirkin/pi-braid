import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { resolveVisionModel } from "../../lib/model-resolver.js";

// Constants

const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_MAX_IMAGE_SIZE_MB = 5;
const IMAGE_PREVIEW_THRESHOLD_MB = 2;

/**
 * Universal Image Analysis Prompt
 *
 * This single prompt handles ALL content types internally. The LLM examines
 * the image, detects its domain, and applies the appropriate analysis
 * framework automatically. No pre-classification needed.
 *
 * Supported domains detected internally:
 * - ui: User interfaces (buttons, forms, dashboards, menus)
 * - game_screenshot: Games (HUD, characters, levels, enemies)
 * - sprite_asset: Pixel art sprites, tilesets, icons
 * - spritesheet: Grid of animation frames
 * - document: Text documents, forms, slides
 * - diagram: Charts, flowcharts, graphs, schematics
 * - photo: Natural photography
 * - other: Anything else
 */
const UNIVERSAL_ANALYSIS_PROMPT = `Analyze this image comprehensively. First determine its content domain, then apply the appropriate analysis framework.

**Image**: {filename}
**Dimensions**: {width}×{height} pixels
{extremeRatioWarning}

---

## Phase 1: Domain Detection

Examine the image and determine its content type:
- **ui**: User interfaces (buttons, forms, dashboards, menus, navigation)
- **game_screenshot**: Game in progress (HUD, characters, levels, enemies)
- **sprite_asset**: Pixel art sprites, tilesets, icons, game assets
- **spritesheet**: Grid of animation frames or multiple sprites
- **document**: Text documents, forms, slides, reports
- **diagram**: Charts, flowcharts, graphs, schematics
- **photo**: Natural photography, screenshots of real-world content
- **other**: Anything that doesn't fit above categories

Choose ONE primary domain. If multiple apply, choose the most specific (e.g., a game HUD with character = game_screenshot).

---

## Phase 2: Universal Measurements

Always extract these baseline measurements:

| Metric | Value |
|--------|-------|
| Dimensions | {width}×{height}px |
| Aspect Ratio | {ratio}:1 |
| Dominant Colors | Top 5 hex codes with approximate % |
| Information Density | high / medium / low |
| Layout Quadrants | Q1, Q2, Q3, Q4 element summary |

---

## Phase 3: Domain-Specific Deep Analysis

### For **ui** (User Interfaces):

**Layout Structure**
- Overall pattern: single column, grid, dashboard, sidebar layout, etc.
- Content hierarchy zones (header, main, footer, sidebar)
- Responsive indicators (mobile/tablet/desktop viewport)

**Component Inventory** (list ALL visible):
- Navigation: header, sidebar, tabs, breadcrumbs, hamburger menu
- Content: cards, panels, modals, accordions
- Interactive: buttons, inputs, toggles, dropdowns, sliders
- Feedback: toasts, alerts, progress bars, badges, tooltips
- Each component: position (approx), size (approx), state (normal/hover/disabled)

**Typography**
- Font sizes (relative hierarchy: H1/H2/H3/body/small)
- Text colors (primary/secondary/muted/disabled)
- Any truncation, overflow, or readability issues?

**Color & Style**
- Primary brand color (hex)
- Accent/secondary color (hex)
- Background scheme (light/dark/system)
- Border radius style (sharp/rounded/pill)

**Spacing & Alignment**
- Grid system (if visible)
- Consistent margins/padding (px estimate)
- Element alignment (left/center/right)

**Accessibility** (if assessable)
- Contrast ratio (pass/fail for WCAG AA)
- Focus indicators visible?
- Error states rendered?


### For **game_screenshot** (Game Screenshots):

**Game Type Detection**
- Genre: platformer, RPG, puzzle, shooter, strategy, adventure, etc.
- Perspective: side-scrolling, top-down, isometric, first-person, third-person

**Player/Character**
- Visible? Description (sprite, model, silhouette)
- Pose/state: idle, walking, running, jumping, attacking, etc.
- Hitbox area (if discernible)
- Animation frame (if sprite)

**HUD/Interface Elements** (if present)
- Health/vitals: style + current/max values
- Score: visible value
- Lives/continues: count
- Timer: mm:ss format
- Inventory slots: count and content
- Mini-map: presence + style
- Menu/pause accessible?

**Environment/Level**
- Environment type: forest, cave, city, interior, etc.
- Platforms/terrain: visible collision surfaces
- Background layers: parallax depth indicators
- Interactive objects: doors, switches, collectibles
- Exit points/checkpoints: visible goals

**Game State Assessment**
- Current state: playing, paused, menu, cutscene, inventory open
- Enemies/NPCs: count, type, position
- Projectiles/effects: visible action elements
- Dialogue/text: on-screen text content

### For **sprite_asset** (Single Sprite/Icon):

**Sprite Overview**
- Dimensions: {width}×{height}px
- Scale factor: original / 2x / 3x / 4x (detect from blocky edges)
- Style: character, item, tile, UI element, icon, effect

**Visual Content**
- Subject description: what the sprite depicts
- Pose/action: idle, walk frame 1, attack, etc.
- Detail level: 8-bit, 16-bit, modern pixel art

**Color Analysis**
- Full color palette (all unique colors with hex)
- Dominant colors (top 5 with %)
- Transparency: yes (alpha) / no (solid background)

**Technical Quality**
- Clean edges: yes (no anti-aliasing) / no (smoothing detected)
- Consistent style: yes / no (mixed art styles)
- Palette limit: appropriate for style / excessive

### For **spritesheet** (Multiple Sprites Grid):

**Grid Detection**
- Columns × Rows
- Cell dimensions: W×H per sprite
- Inter-cell spacing/gaps: px
- Total sprites: count
- Bordered cells vs. tight pack

**Per-Sprite Analysis** (sample the grid):
- Frame 1 (top-left): content description + colors
- Frame 2-N: compare to Frame 1 for consistency
- Last frame (bottom-right): final pose/state

**Animation Sequence** (if applicable):
- Detected sequence: idle → walk → run → jump (for example)
- Frame count per action
- Pose progression logical?

**Anomalies**
- Missing frames
- Duplicate frames
- Color bleeding between cells
- Misaligned cells
- Inconsistent sprite dimensions

### For **document** (Documents, Forms, Slides):

**Document Type**
- Type: report, form, slide, contract, manual, etc.
- Estimated page count (if multi-page)
- Intended audience/purpose

**Complete Text Extraction**
Extract ALL visible text:
- Headers and subheaders
- Body paragraphs (summarize if very long)
- Lists (bullet/numbered)
- Table content (with column headers)
- Captions and footnotes
- Footer/page numbers

**Data Extraction** (for charts/tables):
- Chart type: bar, line, pie, scatter, table
- Axis labels and units
- Data values (as many as visible)
- Legend entries

**Structural Integrity**
- No cut-off content at edges
- Tables aligned correctly
- Figures properly positioned
- Headers/footers consistent

### For **diagram** (Charts, Flowcharts, Schematics):

**Diagram Type**
- Format: flowchart, org chart, network, circuit, UML, architectural
- Complexity: simple / moderate / complex

**Element Inventory**
- Nodes/shapes: count + type (rectangle, diamond, oval, etc.)
- Connections: arrows, lines, connectors
- Labels: text on nodes and connections
- Legend/key: present / absent

**Flow/Logic**
- Direction: top-to-bottom, left-to-right, bidirectional
- Decision points: diamond nodes with yes/no branches
- Terminals: start/end ovals

**Data Values** (for charts/graphs):
- Chart type with data series
- Axis labels with units
- Key data points with values
- Trend indicators (increasing, decreasing, stable)

### For **photo** (Natural Photography):

**Scene Description**
- Subject: what is the main focus
- Setting: indoor, outdoor, urban, nature, etc.
- Lighting: natural, artificial, harsh, soft, backlit

**Composition**
- Rule of thirds: applied / not applied
- Leading lines: present / absent
- Depth: shallow / deep / extreme
- Framing: tight / balanced / cluttered

**Technical Quality**
- Focus: sharp / soft / selective
- Exposure: correct / underexposed / overexposed
- Color balance: natural / tinted / filtered
- Noise/grain: minimal / moderate / heavy

### For **other**:

Provide general description covering:
- What the image depicts
- Dominant visual elements
- Colors and mood
- Any notable technical qualities

---

## Phase 4: Summary Report

Provide a structured final report:

### Detected Domain: [domain]

### Key Findings
[3-5 bullet points of most important observations]

### Measurements
| Element | Position | Size | Notes |
|---------|----------|------|-------|
| [element 1] | (x,y) | W×H | [notes] |
| [element 2] | (x,y) | W×H | [notes] |

### Issues (if any)
- **Critical**: [breaking issues]
- **Warning**: [quality concerns]
- **Info**: [minor notes]

### Recommendations (if requested context allows)
[Suggestions for improvement, if applicable]

---

Format your response clearly with headers and tables. Be thorough but organized.`;

// Types

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
  sizeWarning?: string;
  analysisWarning?: string;
  detectedDomain: string;
}

// Utility Functions

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
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc4) {
          height = buffer.readUInt16BE(offset + 5);
          width = buffer.readUInt16BE(offset + 7);
          break;
        }
        if (marker !== 0xff && marker !== 0x00 && marker !== 0xd8 && marker !== 0xd9) {
          const segLen = buffer.readUInt16BE(offset + 2);
          offset += 2 + segLen;
        } else {
          offset += 2;
        }
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
      width,
      height,
      aspectRatio,
      isExtremeRatio,
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
  } catch {
    return null;
  }
}

/**
 * Core image analysis - returns analysis result with optional image data
 *
 * Uses a single universal prompt that internally:
 * 1. Detects the content domain (ui, game, sprite, document, etc.)
 * 2. Extracts universal measurements (dimensions, colors, layout)
 * 3. Applies domain-specific deep analysis
 * 4. Produces a structured summary report
 */
async function performImageAnalysis(
  ctx: ExtensionContext,
  absolutePath: string,
  onUpdate?: (metadata: string) => void,
): Promise<AnalysisResult> {
  const model = resolveVisionModel(ctx);
  if (!model) {
    throw new Error(
      "No vision-capable model available. Configure a vision model via /vision-model or set a model that supports image input.",
    );
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  if (!isImageFile(absolutePath)) {
    throw new Error(
      `Not a supported image file. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`,
    );
  }

  const sizeCheck = checkImageSize(absolutePath);
  const imageData = readImageAsBase64(absolutePath);
  const imageBase64 = sizeCheck.isPreviewable ? imageData : undefined;
  const metadata = getImageMetadata(absolutePath);

  const mimeType = getMimeType(absolutePath);
  const fileName = path.basename(absolutePath);
  const metadataLines = [`Analyzing: ${fileName}`];
  if (metadata) {
    metadataLines.push(
      `Dimensions: ${metadata.width}×${metadata.height} (${metadata.aspectRatio.toFixed(1)}:1 ratio)`,
    );
  }
  metadataLines.push(`Size: ${formatFileSize(sizeCheck.size)} (${sizeCheck.sizeMB.toFixed(1)} MB)`);
  metadataLines.push(`MIME: ${mimeType}`);
  if (sizeCheck.warning) metadataLines.push(sizeCheck.warning);
  metadataLines.push(`Vision model: ${model.provider}/${model.id}`);
  onUpdate?.(metadataLines.filter(Boolean).join("\n"));

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider ${model.provider}. Set ${model.provider.toUpperCase()}_API_KEY environment variable or use /login.`,
    );
  }

  // Build the universal analysis prompt with dynamic values
  const analysisPrompt = UNIVERSAL_ANALYSIS_PROMPT
    .replace("{filename}", fileName)
    .replace("{width}", String(metadata?.width ?? "?"))
    .replace("{height}", String(metadata?.height ?? "?"))
    .replace("{ratio}", metadata ? metadata.aspectRatio.toFixed(1) : "?")
    .replace("{extremeRatioWarning}", metadata?.analysisWarning ?? "");

  const context = {
    systemPrompt:
      "You are an expert visual analyst. Analyze images thoroughly, detect their content domain, and apply the appropriate analysis framework. Provide structured, detailed reports.",
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: analysisPrompt },
          {
            type: "image" as const,
            data: imageData?.data ?? "",
            mimeType: imageData?.mimeType ?? "image/jpeg",
          },
        ],
        timestamp: Date.now(),
      },
    ],
  };

  const result = await completeSimple(model, context, {
    apiKey,
    maxTokens: 4096,
    temperature: 0.3,
  });

  const textContent = result.content.filter(
    (c): c is { type: "text"; text: string } => c.type === "text",
  );
  const analysis = textContent.map((t) => t.text).join("\n");

  if (result.errorMessage) {
    throw new Error(`Analysis failed: ${result.errorMessage}`);
  }

  // Append metadata summary to analysis
  let annotated = analysis || "(No analysis produced)";
  if (metadata) {
    annotated += `\n\n---\n**Image metadata**: ${metadata.width}×${metadata.height}px, ${metadata.aspectRatio.toFixed(1)}:1 ratio`;
    if (metadata.analysisWarning) {
      annotated += `\n**Warning**: ${metadata.analysisWarning}`;
    }
  }

  // Extract detected domain from analysis for the result
  const detectedDomain = extractDetectedDomain(analysis) || "unknown";

  return {
    analysis: annotated,
    imageData: imageBase64 ?? undefined,
    model,
    path: absolutePath,
    size: sizeCheck.size,
    mimeType,
    sizeWarning: sizeCheck.warning,
    analysisWarning: metadata?.analysisWarning,
    detectedDomain,
  };
}

/**
 * Extract the detected domain from the analysis text
 */
function extractDetectedDomain(analysis: string): string | null {
  const domainPatterns = [
    { pattern: /###\s*Detected\s*Domain:\s*(\w+)/i, name: "detected_domain_header" },
    { pattern: /Detected\s*Domain:\s*\*\*(?:ui|game_screenshot|sprite_asset|spritesheet|document|diagram|photo|other)\*\*/i, name: "detected_domain_bold" },
    { pattern: /Domain\s*Detection.*?(?:^|\n)\s*(ui|game_screenshot|sprite_asset|spritesheet|document|diagram|photo|other)/im, name: "domain_detection" },
  ];

  for (const { pattern } of domainPatterns) {
    const match = analysis.match(pattern);
    if (match) {
      return match[1]?.toLowerCase() || null;
    }
  }

  return null;
}

// Extension

export default function visionExtension(pi: ExtensionAPI) {
  // Tool: analyze_image

  pi.registerTool({
    name: "analyze_image",
    label: "Analyze Image",
    description:
      "Analyze an image file using a vision model. Automatically detects the content domain (UI, game screenshot, sprite, document, etc.) and applies the appropriate analysis framework. Supports all visual content types with structured output.",
    parameters: Type.Object({
      imagePath: Type.String({
        description: "Path to the image file (jpg, jpeg, png, gif, webp)",
      }),
    }),

    execute: async (
      _toolCallId,
      params: { imagePath: string },
      _signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<unknown>> => {
      const imagePathExpanded = expandHomeDir(params.imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);

      if (!fs.existsSync(absolutePath)) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${params.imagePath}` }],
          details: { path: absolutePath, error: "file_not_found" },
        };
      }

      if (!isImageFile(absolutePath)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: "${params.imagePath}" is not a supported image file. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`,
            },
          ],
          details: { path: absolutePath, supported: SUPPORTED_IMAGE_EXTENSIONS },
        };
      }

      try {
        const result = await performImageAnalysis(ctx, absolutePath, (metadata) => {
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
          text: `[Image analyzed: ${path.basename(result.path)}]\n[Detected domain: ${result.detectedDomain}]\n\n${result.analysis}`,
        });

        return {
          content: resultContent,
          details: {
            path: absolutePath,
            size: result.size,
            mimeType: result.mimeType,
            imageIncluded: !!result.imageData,
            visionModel: result.model?.id,
            detectedDomain: result.detectedDomain,
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
      "Analyze an image using a vision model. Automatically detects content domain and applies appropriate framework. Usage: /analyze-image <path>",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      const imagePath = args.trim();
      if (!imagePath) {
        ctx.ui.notify("Usage: /analyze-image <image-path>", "error");
        return;
      }

      const imagePathExpanded = expandHomeDir(imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);

      if (!isImageFile(absolutePath)) {
        ctx.ui.notify(
          `Not a supported image file. Supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`,
          "error",
        );
        return;
      }

      const sizeCheck = checkImageSize(absolutePath);
      if (sizeCheck.warning) {
        ctx.ui.notify(sizeCheck.warning, "warning");
      }

      try {
        const result = await performImageAnalysis(ctx, absolutePath);
        const header = `[Image: ${path.basename(result.path)}]\n[Domain: ${result.detectedDomain}]\n[Size: ${formatFileSize(result.size)}]\n\n`;
        await ctx.ui.editor("Image Analysis", header + result.analysis);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Analysis failed: ${message}`, "error");
      }
    },
  });
}
