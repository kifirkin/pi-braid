import { createLogger } from "../logger.js";
const log = createLogger("browser:readability");

/**
 * HTML content extraction - lightweight readability without external deps.
 * Strips nav, header, footer, aside, scripts, styles,
 * then finds the main content area.
 */

export function extractReadableContent(
  html: string,
  _url: string,
): { title: string; content: string } {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const stripSelectors = [
    /<nav[^>]*>[\s\S]*?<\/nav>/gi,
    /<header[^>]*>[\s\S]*?<\/header>/gi,
    /<footer[^>]*>[\s\S]*?<\/footer>/gi,
    /<aside[^>]*>[\s\S]*?<\/aside>/gi,
    /<script[^>]*>[\s\S]*?<\/script>/gi,
    /<style[^>]*>[\s\S]*?<\/style>/gi,
    /<form[^>]*class="[^"]*search[^"]*"[^>]*>[\s\S]*?<\/form>/gi,
    /<div[^>]*class="[^"]*(?:sidebar|nav|menu|footer|header|cookie|banner|popup|modal)[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
  ];
  for (const re of stripSelectors) {
    text = text.replace(re, "");
  }

  // Find main content area
  const mainMatch = text.match(
    /<(?:main|article|content|body)[^>]*>([\s\S]*)<\/(?:main|article|content|body)>/i,
  );
  let content = mainMatch ? mainMatch[1] : text;

  // Replace block-level tags with newlines (preserves paragraph separation)
  content = content.replace(
    /<\/(?:div|p|h[1-6]|li|blockquote|pre|section|article)\s*>/gi,
    "\n",
  );
  content = content.replace(
    /<(?:div|p|h[1-6]|li|blockquote|pre|section|article|br|hr)[^>]*>/gi,
    "\n",
  );
  // Strip remaining inline tags without adding space — prevents word splitting
  content = content.replace(/<[^>]+>/g, "");
  content = decodeEntities(content);
  // Collapse whitespace (preserve paragraph breaks)
  content = content.replace(/\n{3,}/g, "\n\n");
  content = content.replace(/[ \t]+/g, " ");
  content = content.replace(/^\s+|\s+$/gm, "").trim();

  return { title, content };
}

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&copy;/g, "©")
    .replace(/&reg;/g, "®")
    .replace(/&trade;/g, "™")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}
