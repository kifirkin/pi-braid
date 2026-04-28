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

// Constants

const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_MAX_IMAGE_SIZE_MB = 5;
const IMAGE_PREVIEW_THRESHOLD_MB = 2; // Only include preview if under 2MB

/** Standard image analysis prompt - for screenshots, photos, documents */
const GENERAL_PROMPT = `Please analyze this image comprehensively. Extract ALL information from the image including:

1. **Overall Description**: What type of content is this? (screenshot, diagram, document, photograph, UI, code, etc.)
2. **Text Content**: ALL visible text in the image, preserving structure and formatting. Include labels, buttons, error messages, file paths, code snippets, etc. Be exhaustive.
3. **Visual Elements**: Colors, layout, components, icons, graphical elements
4. **Technical Details**: For code, UI, diagrams - include exact values, class names, IDs, parameters, configurations
5. **Contextual Information**: Window titles, terminal prompts, file names, timestamps, status indicators
6. **Structure**: How elements are organized, relationships between components
7. **Actionable Information**: Any visible commands, settings, configurations, or parameters that could be useful
8. **Layout Sketch**: If applicable, provide an ASCII art representation of the layout showing relative positions of key UI elements, text blocks, or visual components. Use box-drawing characters (┌─┐│└┘) for structure. This helps understand spatial relationships even without seeing the image.

Format your response clearly with sections and bullet points. Be extremely thorough - the user needs to understand everything visible in this image to perform their task.`;

/** Pixel art / spritesheet analysis prompt */
const PIXEL_ART_PROMPT = `This is a pixel art image or spritesheet. Analyze it as such - do NOT treat it as a natural photograph.

**Dimensions**: {width}×{height} pixels
{extremeRatioWarning}

## Analysis Requirements

1. **Image Type**: Is this a single sprite, a spritesheet grid, a tilemap, game asset, or other pixel art?
2. **Grid Detection**: If a spritesheet, identify the grid structure:
   - Number of columns and rows
   - Cell dimensions (width × height per cell)
   - Spacing/gaps between cells
   - Total number of sprites
3. **Color Palette**: List all distinct colors used (with hex codes). Report approximate percentage coverage for dominant colors.
4. **Per-Sprite Analysis**: For each detected sprite cell:
   - Describe the visual content (character pose, animation frame, object)
   - List colors present in that cell
   - Estimate fill percentage (how much of the cell is non-transparent/non-background)
5. **Anomaly Detection**: Flag cells that differ significantly from the others:
   - Missing features (body parts, accessories, details present in other cells)
   - Different color palette
   - Significantly different fill percentage
   - Misalignment or irregular borders
6. **Quality Issues**: Report any artifacts like:
   - Blurring or anti-aliasing (indicates the pixel art was scaled)
   - Missing expected elements for the depicted scene
   - Compression artifacts or color banding

If the image appears to be scaled-up pixel art (sharp blocky edges, repetitive color blocks), note the approximate scale multiplier.

Format output clearly. Be precise with dimensions and color values.`;

// Types

/**
 * Image metadata extracted before LLM analysis
 */
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
}

// Utility Functions

/**
 * Expand ~ to home directory
 */
function expandHomeDir(imagePath: string): string {
  if (imagePath.startsWith("~/") || imagePath === "~") {
    return imagePath.replace(/^~/, os.homedir());
  }
  return imagePath;
}

/**
 * Check if path is a supported image file
 */
function isImageFile(imagePath: string): boolean {
  const ext = path.extname(imagePath).toLowerCase().slice(1); // Remove leading dot
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Get MIME type from file extension
 */
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

/**
 * Check image file size and return warnings
 */
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
 * Extract image dimensions and detect characteristics.
 * Reads minimal header bytes to determine dimensions without loading full image.
 */
function getImageMetadata(absolutePath: string): ImageMetadata | null {
  try {
    const buffer = fs.readFileSync(absolutePath);
    let width = 0;
    let height = 0;

    const ext = path.extname(absolutePath).toLowerCase();

    if (ext === ".png" && buffer.length > 24) {
      // PNG: IHDR width at byte 16 (4 bytes BE), height at byte 20
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    } else if ((ext === ".jpg" || ext === ".jpeg") && buffer.length > 10) {
      // JPEG: scan for SOF markers (0xFF 0xC0..0xC3) for dimensions
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
      // GIF: width at offset 6 (2 bytes LE), height at offset 8 (2 bytes LE)
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

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/**
 * Read image file and convert to base64
 */
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
 * Retry wrapper with exponential backoff for transient API failures.
 * Retries on network errors, rate limits (429), and server errors (5xx).
 * Does NOT retry on auth errors (401), not found (404), or validation errors.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message.toLowerCase();

      // Don't retry auth or configuration errors
      const nonRetryable =
        message.includes("unauthorized") ||
        message.includes("authentication") ||
        message.includes("api key") ||
        message.includes("not found") ||
        message.includes("invalid api key") ||
        message.includes("model not available") ||
        message.includes("no api key") ||
        message.includes("no vision-capable model");

      if (nonRetryable || attempt === maxRetries) {
        throw lastError;
      }

      // Check for rate limit or server errors
      const isRateLimited = message.includes("429") || message.includes("rate limit") || message.includes("too many requests");
      const isServerError = message.includes("500") || message.includes("502") || message.includes("503") || message.includes("504");
      const isNetworkError = message.includes("econnreset") || message.includes("etimedout") || message.includes("enotfound") || message.includes("network");
      const isGpuEngineError = message.includes("enginecore") || message.includes("upstream error") || message.includes("nvidia") && message.includes("error");
      const isTransient = isRateLimited || isServerError || isNetworkError || isGpuEngineError || message.includes("timeout");

      if (!isTransient) {
        // Unknown error — retry once more just in case
        if (attempt < maxRetries - 1) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          log.warn(`${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }

      const delay = isRateLimited ? baseDelayMs * Math.pow(2, attempt) * 2 : baseDelayMs * Math.pow(2, attempt);
      log.warn(`${operationName} transient error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error(`${operationName} failed after ${maxRetries} retries`);
}

// Core Analysis Logic

/**
 * Core image analysis - returns analysis result with optional image data
 */
async function performImageAnalysis(
  ctx: ExtensionContext,
  absolutePath: string,
  onUpdate?: (metadata: string) => void,
): Promise<AnalysisResult> {
  // Get vision model from core agent settings
  // Resolve vision model - no patching required, reads settings + modelRegistry directly
  const model = resolveVisionModel(ctx);
  if (!model) {
    throw new Error(
      "No vision-capable model available. Configure a vision model via /vision-model or set a model that supports image input.",
    );
  }

  // Check file exists
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  // Check file is an image
  if (!isImageFile(absolutePath)) {
    throw new Error(
      `Not a supported image file. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`,
    );
  }

  // Check image size
  const sizeCheck = checkImageSize(absolutePath);

  // Read image for preview (only if small enough)
  const imageData = await readImageAsBase64(absolutePath);
  const imageBase64 = sizeCheck.isPreviewable ? imageData : undefined;

  // Detect image metadata for better analysis context
  const metadata = await getImageMetadata(absolutePath);

  // Send initial metadata update
  const mimeType = getMimeType(absolutePath);
  const metadataLines = [`Analyzing: ${absolutePath}`];
  if (metadata) {
    metadataLines.push(
      `Dimensions: ${metadata.width}×${metadata.height} (${metadata.aspectRatio.toFixed(1)}:1 ratio)`,
    );
  }
  metadataLines.push(`Size: ${formatFileSize(sizeCheck.size)} (${sizeCheck.sizeMB.toFixed(1)} MB)`);
  metadataLines.push(`MIME: ${mimeType}`);
  if (sizeCheck.warning) metadataLines.push(sizeCheck.warning);
  metadataLines.push(`Using vision model: ${model.provider}/${model.id}`);
  onUpdate?.(metadataLines.filter(Boolean).join("\n"));

  // Get API key
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider ${model.provider}. Set ${model.provider.toUpperCase()}_API_KEY environment variable or use /login.`,
    );
  }

  // Build context with image
  // Detect potential pixel art: small dimensions, PNG/GIF/WebP, likely blocky content
  const ext = path.extname(absolutePath).toLowerCase();
  const isLikelyPixelArt = metadata
    ? metadata.width <= 384 && metadata.height <= 384 && [".png", ".gif", ".webp"].includes(ext)
    : false;

  // Select prompt based on image characteristics
  const analysisPrompt = isLikelyPixelArt
    ? PIXEL_ART_PROMPT.replace("{width}", String(metadata?.width ?? "?"))
        .replace("{height}", String(metadata?.height ?? "?"))
        .replace("{extremeRatioWarning}", metadata?.analysisWarning ?? "")
    : GENERAL_PROMPT;

  const context = {
    systemPrompt: isLikelyPixelArt
      ? "You are an expert in pixel art, spritesheets, and game asset analysis. Provide precise, technical descriptions."
      : "You are an image analysis assistant. Provide detailed, accurate descriptions of images.",
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

  // Call the vision model with retry for transient failures
  const result = await withRetry(
    () =>
      completeSimple(model, context, {
        apiKey,
        maxTokens: 4096,
        temperature: 0.3,
      }),
    `Vision analysis (${model.provider}/${model.id})`,
  );

  // Extract text content
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

  return {
    analysis: annotated,
    imageData: imageBase64 ?? undefined,
    model,
    path: absolutePath,
    size: sizeCheck.size,
    mimeType,
    sizeWarning: sizeCheck.warning,
    analysisWarning: metadata?.analysisWarning,
  };
}

// Extension

/**
 * Vision Extension - Image Analysis
 *
 * Provides the analyze_image tool for vision-capable image analysis.
 * Uses the vision model configured via the vision model selector.
 *
 * Tools:
 *   analyze_image - LLM-callable tool for image analysis
 *
 * Commands:
 *   /analyze-image <path> - User command for image analysis
 */
export default function visionExtension(pi: ExtensionAPI) {
  // Tool: analyze_image

  pi.registerTool({
    name: "analyze_image",
    label: "Analyze Image",
    description:
      "Analyze an image file using a vision model. Automatically detects pixel art, spritesheets, and grid layouts for specialized analysis. Extracts text, visual elements, technical details, and color palettes. Reports image dimensions and aspect ratio warnings.",
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
      // Expand home directory and resolve path
      const imagePathExpanded = expandHomeDir(params.imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);

      // Validate file exists
      if (!fs.existsSync(absolutePath)) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${params.imagePath}` }],
          details: { path: absolutePath, error: "file_not_found" },
        };
      }

      // Validate image format
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

      // Perform analysis with streaming updates
      try {
        const result = await performImageAnalysis(ctx, absolutePath, (metadata) => {
          onUpdate?.({
            content: [{ type: "text", text: metadata }],
            details: { status: "analyzing" },
          });
        });

        // Build result content: image first (for display), then text
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
          text: `[Image analyzed: ${absolutePath}]\n\n${result.analysis}`,
        });

        return {
          content: resultContent,
          details: {
            path: absolutePath,
            size: result.size,
            mimeType: result.mimeType,
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
      "Analyze an image using a vision-capable model. Automatically detects pixel art and spritesheets. Usage: /analyze-image <path>",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      const imagePath = args.trim();
      if (!imagePath) {
        ctx.ui.notify("Usage: /analyze-image <image-path>", "error");
        return;
      }

      // Expand home directory and resolve path
      const imagePathExpanded = expandHomeDir(imagePath);
      const absolutePath = path.resolve(ctx.cwd, imagePathExpanded);

      // Validate image format
      if (!isImageFile(absolutePath)) {
        ctx.ui.notify(
          `Not a supported image file. Supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`,
          "error",
        );
        return;
      }

      // Check size and warn
      const sizeCheck = checkImageSize(absolutePath);
      if (sizeCheck.warning) {
        ctx.ui.notify(sizeCheck.warning, "warning");
      }

      try {
        const result = await performImageAnalysis(ctx, absolutePath);

        // Show analysis in editor
        const header = `[Image: ${absolutePath}]\n[Size: ${formatFileSize(result.size)}]\n\n`;
        await ctx.ui.editor("Image Analysis", header + result.analysis);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Analysis failed: ${message}`, "error");
      }
    },
  });
}
