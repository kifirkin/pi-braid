/**
 * Curated trigger phrases for the suggestion matcher.
 *
 * pi's skill objects carry a fixed shape (name, description, path, source),
 * so curated trigger phrases never reach braid through the prompt-builder
 * cache — read them from the SKILL.md itself. Reads are memoized by file
 * mtime + size: repeated turns stat, only changed or first-seen files parse.
 *
 * Authors wrote the phrases in three places, and all three are read:
 *   1. frontmatter, under `trigger:` (a comma-separated string) or
 *      `triggers:` (a YAML list) — the canonical field;
 *   2. a `## trigger:` body heading, quoted or bare (9 of core's 22 skills
 *      carry the phrases here and nowhere else);
 *   3. the description's trailing "Triggers: …" segment, the pack's older
 *      convention.
 * A file may use any of them; the first source that yields phrases wins, so
 * the frontmatter stays authoritative and a body heading never silently
 * overrides it.
 *
 * A trigger hit scores like a name hit and qualifies a skill whose
 * description alone would stay under the qualification bar — the phrase is
 * the author's own signal of when the skill applies, sharper than any
 * description keyword. Matching is case-insensitive: prompts arrive
 * capitalized ("MASTERSHIP TRANSFER: …"), and a phrase that only matched
 * lowercase text would be dead in production while a lowercase-only unit
 * fixture kept the suite green.
 */

import { statSync, readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Max trigger phrases read per skill — a longer list is an authoring bug, not a
 * matcher input. Two authored lists reach the cap (braid-reference 16,
 * pi-reference 15), so their tail phrases are not read: raising the cap needs
 * the assertion in test-skill-decision.mjs changed with it.
 */
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
 * Read a skill's trigger phrases: frontmatter (`trigger` or `triggers`) first,
 * then a `## trigger:` body heading, then the description's trailing
 * "Triggers: …" segment. Missing/unreadable file or malformed YAML → no
 * triggers (the matcher falls back to name/description scoring alone).
 * Memoized: unchanged files never re-read.
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
    const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const fm = frontmatter as Record<string, unknown>;
    triggers = normalizeTriggers(fm.trigger);
    if (!triggers.length) triggers = normalizeTriggers(fm.triggers);
    if (!triggers.length) triggers = parseBodyTriggers(body);
  } catch {
    triggers = []; // malformed frontmatter — score on name/description only
  }
  if (!triggers.length && description) triggers = parseDescriptionTriggers(description);
  cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, triggers });
  return triggers;
}

/** First `## trigger:` / `## triggers:` heading; a heading-shaped line cannot come from frontmatter. */
const BODY_TRIGGER_HEADING = /^##\s*triggers?\s*:\s*(.*)$/i;

/**
 * Trigger phrases from a body `## trigger: "a, b, c"` heading. The FIRST such
 * heading is the whole input: a body with several is an authoring error, not
 * extra matcher input. Quotes around the value are stripped. Pure.
 */
export function parseBodyTriggers(body: string): string[] {
  for (const line of body.split(/\r?\n/)) {
    const match = BODY_TRIGGER_HEADING.exec(line);
    if (match) return normalizeTriggers(match[1].trim().replace(/^["']|["']$/g, ""));
  }
  return [];
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
 * prompt tokens count as boundaries. Phrases are normalized to lowercase, so
 * the prompt is folded to match: the boundary classes stay lowercase-only.
 */
export function triggerMatches(phrase: string, promptText: string): boolean {
  let re = regexCache.get(phrase);
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
    regexCache.set(phrase, re);
  }
  return re.test(promptText.toLowerCase());
}
