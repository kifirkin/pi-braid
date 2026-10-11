/**
 * Frontmatter `triggers:` phrases for the suggestion matcher.
 *
 * pi's skill objects carry a fixed shape (name, description, path, source),
 * so curated trigger phrases never reach braid through the prompt-builder
 * cache — read them from the SKILL.md frontmatter directly. Reads are
 * memoized by file mtime + size: repeated turns stat, only changed or
 * first-seen files parse.
 *
 * A trigger hit scores like a name hit and qualifies a skill whose
 * description alone would stay under the qualification bar — the phrase is
 * the author's own signal of when the skill applies, sharper than any
 * description keyword.
 */

import { statSync, readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Max trigger phrases read per skill — a longer list is an authoring bug, not a matcher input. */
export const MAX_TRIGGERS = 12;

/** Max characters of one trigger phrase. */
export const MAX_TRIGGER_CHARS = 64;

interface TriggerCacheEntry {
  mtimeMs: number;
  size: number;
  triggers: string[];
}

const cache = new Map<string, TriggerCacheEntry>();

/** Compiled word-boundary matchers, memoized per normalized phrase. */
const regexCache = new Map<string, RegExp>();

/**
 * Normalize a frontmatter `triggers` value into clean phrases. Accepts a YAML
 * list or a comma-separated string; drops empty, overlong, and surplus
 * entries. Pure.
 */
export function normalizeTriggers(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const cleaned: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const phrase = item.trim().toLowerCase();
    if (!phrase || phrase.length > MAX_TRIGGER_CHARS || cleaned.includes(phrase)) continue;
    cleaned.push(phrase);
    if (cleaned.length >= MAX_TRIGGERS) break;
  }
  return cleaned;
}

/**
 * Read a skill's trigger phrases: frontmatter `triggers:` first (canonical),
 * then the description's trailing "Triggers: …" segment — the pack's existing
 * convention (7 of 32 skills carry one) predates the frontmatter field, and
 * the matcher should honor what authors already wrote. Missing/unreadable
 * file or malformed YAML → no triggers (the matcher falls back to
 * name/description scoring alone). Memoized: unchanged files never re-read.
 */
export function readSkillTriggers(filePath: string, description?: string): string[] {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    cache.delete(filePath);
    return [];
  }
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.triggers;
  let triggers: string[];
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    triggers = normalizeTriggers((frontmatter as Record<string, unknown>).triggers);
  } catch {
    triggers = []; // malformed frontmatter — score on name/description only
  }
  if (!triggers.length && description) triggers = parseDescriptionTriggers(description);
  cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, triggers });
  return triggers;
}

/**
 * Trigger phrases from a description's trailing "Triggers: …" segment —
 * the contrib pack convention ("… Use when X. Triggers: meme, image macro.").
 * Pure.
 */
export function parseDescriptionTriggers(description: string): string[] {
  const idx = description.toLowerCase().lastIndexOf("triggers:");
  if (idx < 0) return [];
  const tail = description
    .slice(idx + "triggers:".length)
    .replace(/[.。]*\s*$/, "")
    .trim();
  if (!tail || tail.length > 200) return [];
  return normalizeTriggers(tail);
}

/** Test seam: forget every memoized frontmatter read. */
export function clearSkillTriggerCache(): void {
  cache.clear();
  regexCache.clear();
}

/**
 * True when the phrase occurs in the prompt on word boundaries ("pane" does
 * not match "paneled"). Multi-word phrases match literally; hyphenated
 * prompt tokens count as boundaries.
 */
export function triggerMatches(phrase: string, promptText: string): boolean {
  let re = regexCache.get(phrase);
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
    regexCache.set(phrase, re);
  }
  return re.test(promptText);
}
