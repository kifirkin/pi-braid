/**
 * Colour arithmetic for the design audit: parse a computed colour, flatten it
 * over what is behind it, and compute the WCAG 2.1 contrast ratio.
 *
 * Pure by construction: no I/O, no clock. Values arrive from
 * `getComputedStyle`, which serialises as `rgb()`/`rgba()`; hexadecimal and the
 * `transparent` keyword are accepted too because recorded snapshots are also
 * written by hand.
 *
 * A colour syntax this module cannot read returns null instead of a guess. The
 * callers count those as skipped, so an audit never claims a contrast pair it
 * did not measure.
 */

/** An sRGB colour: channels 0..255, alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNCTIONAL = /^rgba?\(\s*([^)]+)\)$/i;

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, value));
}

function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** One channel of a functional colour: `153`, `60%`, or a bare number. */
function parseChannel(token: string): number | null {
  const text = token.trim();
  if (text === "") return null;
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * 255 : null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseAlpha(token: string | undefined): number {
  if (token === undefined || token.trim() === "") return 1;
  const text = token.trim();
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) ? percent / 100 : 1;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : 1;
}

/**
 * Parse a CSS colour string. Supports `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()` in comma or space form (slash alpha included),
 * and `transparent`. Anything else is null.
 */
export function parseColor(value: string | null | undefined): Rgba | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (text.toLowerCase() === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const hex = HEX.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: parseInt(digits[0] + digits[0], 16),
        g: parseInt(digits[1] + digits[1], 16),
        b: parseInt(digits[2] + digits[2], 16),
        a: digits.length === 4 ? parseInt(digits[3] + digits[3], 16) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const fn = FUNCTIONAL.exec(text);
  if (!fn) return null;
  let body = fn[1];
  let alphaToken: string | undefined;
  const slash = body.split("/");
  if (slash.length === 2) {
    body = slash[0];
    alphaToken = slash[1];
  }
  const parts = body
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map(parseChannel);
  if (channels.some((channel) => channel === null)) return null;
  return {
    r: clampChannel(channels[0] as number),
    g: clampChannel(channels[1] as number),
    b: clampChannel(channels[2] as number),
    a: clampAlpha(parseAlpha(alphaToken ?? parts[3])),
  };
}

/** Source-over compositing of `fg` onto `bg`; the result carries both alphas. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  if (fg.a <= 0) return { ...bg };
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

/** Flatten a colour over an opaque base, then render it as `#rrggbb`. */
export function flatten(color: Rgba, base: Rgba): string {
  return toHex(composite(color, base));
}

/** `#rrggbb`, channels rounded and clamped. Alpha is not encoded. */
export function toHex(color: Rgba): string {
  const channel = (value: number) =>
    Math.round(clampChannel(value)).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** WCAG 2.1 relative luminance of an sRGB colour. */
export function relativeLuminance(color: Rgba): number {
  const linear = (channel: number) => {
    const value = clampChannel(channel) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * linear(color.r) +
    0.7152 * linear(color.g) +
    0.0722 * linear(color.b)
  );
}

/** WCAG 2.1 contrast ratio between two colours; order-independent. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
