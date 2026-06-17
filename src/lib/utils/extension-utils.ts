/**
 * Shared extension utilities - use these instead of duplicating across extensions.
 *
 * These are small, universal helpers that every extension needs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPrivateExtensionState } from "../state/extension-state.js";

/**
 * Build a valid AgentToolResult with text content.
 * Use this instead of returning raw strings or duplicating the pattern.
 */
export function textResult(text: string): any {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * Build an AgentToolResult with multiple text parts.
 */
export function textParts(...parts: string[]): any {
  return {
    content: parts.map((text) => ({ type: "text" as const, text })),
    details: {},
  };
}

/**
 * Safe getter for another extension's session state.
 * Returns null if the extension hasn't initialized yet.
 *
 * @example
 * const enforcement = getExtensionStateOrNull<EnforcementState>(ctx, "enforcement");
 * if (enforcement) { /* use it *\/ }
 */
export function getExtensionStateOrNull<T>(ctx: ExtensionContext, key: string): T | null {
  try {
    const fn = getPrivateExtensionState(ctx);
    if (typeof fn === "function") {
      return fn(key) as T | null;
    }
  } catch {
    // Extension not available
  }
  return null;
}

/**
 * Format bytes as human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)}${units[i]}`;
}

/**
 * Format duration in ms as human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Debounce a function - returns a debounced version that delays execution.
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timeoutId: any = null;
  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delayMs);
  };
}

/**
 * Check if a string looks like a valid file path.
 */
export function looksLikeFilePath(s: string): boolean {
  return /^[.\/]?[a-zA-Z0-9_./-]+$/.test(s) && s.length > 1 && !s.includes(" "); // eslint-disable-line no-useless-escape
}

/**
 * Check if a string looks like a valid URL.
 */
export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}
