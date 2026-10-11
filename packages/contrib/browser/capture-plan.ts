/**
 * Pure capture-plan math for browser_screenshot.
 *
 * Zero imports on purpose: this module is unit-tested with plain `node`
 * (native type stripping) from packages/core/test/runtime/contrib/.
 *
 * Problem it solves: Page.captureScreenshot without overrides captures at the
 * device pixel ratio (Retina = 2x → 4x the pixels, ~4x the base64 payload)
 * with no size bound, so dense pages at 2x produce multi-MB screenshots —
 * HTTP 413 request loops.
 */

/** Hard cap on the long edge of the captured image, in output pixels. */
export const MAX_SCREENSHOT_DIM = 1440;

/** Default JPEG quality for captures (target size class: ~100-300KB). */
export const DEFAULT_JPEG_QUALITY = 75;

/** Viewport metrics as read from the page via Runtime.evaluate. */
export interface ViewportMetrics {
  /** Visible viewport width in CSS px. */
  width: number;
  /** Visible viewport height in CSS px. */
  height: number;
  /** devicePixelRatio (Retina = 2). */
  dpr: number;
  /** Document-space horizontal scroll offset (CSS px). */
  scrollX: number;
  /** Document-space vertical scroll offset (CSS px). */
  scrollY: number;
}

/** Clip plan for Page.captureScreenshot (all sizes in CSS px, pre-scale). */
export interface CapturePlan {
  /** Clip origin x in document CSS px. */
  x: number;
  /** Clip origin y in document CSS px. */
  y: number;
  /** Clip width in CSS px. */
  width: number;
  /** Clip height in CSS px. */
  height: number;
  /** Combined page scale for the clip (bounds long edge, compensates DPR). */
  scale: number;
  /** Expected output image width in px (long-edge bounded). */
  captureWidthPx: number;
  /** Expected output image height in px (long-edge bounded). */
  captureHeightPx: number;
}

function clampPositiveInt(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v > 0 ? v : fallback;
}

function clampDpr(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return dpr;
}

/**
 * Compute the bounded, DPR-neutralized capture plan for the visible viewport.
 *
 * - The clip covers exactly the visible viewport region expressed in document
 *   coordinates (scrollX/scrollY offset), so the capture matches what the
 *   user sees regardless of scroll position.
 * - With `dsfNeutralized` (Emulation.setDeviceMetricsOverride applied with
 *   deviceScaleFactor: 1), scale only bounds the long edge — output pixels =
 *   clip × scale at DSF 1.
 * - Without the override (emulation unsupported), scale additionally divides
 *   by the device pixel ratio as a best-effort compensation, under the
 *   assumption output pixels = clip × scale × DSF. Either way the long edge
 *   of the output stays ≤ MAX_SCREENSHOT_DIM.
 */
export function computeCapturePlan(
  m: ViewportMetrics,
  dsfNeutralized: boolean,
): CapturePlan {
  const width = clampPositiveInt(m.width, 1280);
  const height = clampPositiveInt(m.height, 720);
  const dpr = clampDpr(m.dpr);
  const scrollX = Number.isFinite(m.scrollX) ? Math.max(0, m.scrollX) : 0;
  const scrollY = Number.isFinite(m.scrollY) ? Math.max(0, m.scrollY) : 0;

  const longEdge = Math.max(width, height);
  const boundScale =
    longEdge > MAX_SCREENSHOT_DIM ? MAX_SCREENSHOT_DIM / longEdge : 1;
  const scale = dsfNeutralized ? boundScale : boundScale / dpr;

  return {
    x: scrollX,
    y: scrollY,
    width,
    height,
    scale,
    captureWidthPx: Math.round(width * boundScale),
    captureHeightPx: Math.round(height * boundScale),
  };
}
