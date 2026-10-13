/**
 * Skills Auto-Injection — relevant skill suggestion via steer whisper.
 *
 * Agenda:
 *   Instead of requiring the agent to discover skills via `list_skills` tool,
 *   proactively detect when a skill is relevant to the current task and inject
 *   a suggestion via the steer whisper pattern.
 *
 * Design:
 *   1. Relevance detection: keyword match of skill name/description plus
 *      frontmatter trigger phrases against the user's current prompt.
 *      Qualification bar: a skill whose match never touches its NAME (name
 *      token or trigger phrase) must reach a score of at least
 *      MIN_NON_NAME_SCORE — a lone description/path keyword hit is too weak
 *      a signal: it fires broad skills on almost any prompt.
 *      Keywords are stemmed with one suffix rule (trailing s/es) so plural
 *      prompts hit singular name tokens ("skills" → "skill").
 *   2. Session-scoped state: track which skills were injected on which turn.
 *      Cooldown is per-skill on top of the global floor: an injected skill
 *      cools down at least COOLDOWN_TURNS, and once it was actually loaded
 *      (detected read) it cools down LOADED_COOLDOWN_TURNS — re-suggesting
 *      a skill that is already in context is noise.
 *   3. Slot management: at most MAX_INJECTED skills hold a slot. A loaded
 *      skill releases its slot — it is in the agent's context now. A slot
 *      whose skill was never loaded stays held until its entry ages out of
 *      the cooldown history: measured over the recorded suggestion corpus,
 *      every recycling variant (score-margin eviction, windowed slots, a
 *      third slot) admits fills that convert far below the incumbent rate,
 *      so the cap deliberately throttles. Injection history is pruned once
 *      every cooldown window it can influence has expired.
 *   4. Injection: sendTrackedMessage with deliverAs: "steer", triggerTurn: false,
 *      bypassing the per-turn whisper cap. The steer whisper is non-blocking
 *      (the agent reads it but does not pause its turn loop). The bypass is
 *      the module's delivery guarantee: this whisper is the only channel that
 *      can surface a matching skill, it is bounded by the module's own budget
 *      (COOLDOWN_TURNS, MAX_INJECTED, one send per turn), and the
 *      once-per-session hygiene whisper is delivered earlier in the same
 *      before_agent_start at the same priority, so without the bypass the
 *      cap would drop the suggestion exactly in the turn where a skill is
 *      most likely to match.
 *      `sendTrackedMessage` reports whether the message was accepted; a
 *      suppressed suggestion is neither sent nor counted.
 *   5. Content delivery: the whisper carries a BOUNDED
 *      excerpt of the matching skill's SKILL.md body (frontmatter stripped,
 *      ≤ MAX_EXCERPT_CHARS) plus an explicit read pointer to the full file —
 *      so skill content actually reaches the agent's view at the moment a
 *      domain matches, not just a truncated description. Best-effort: an
 *      unreadable file falls back to the description.
 *   6. No reply ritual: the whisper points at the SKILL.md read and stops
 *      there — a read is the conversion signal, and the solicited one-line
 *      reply is honored 2% of the time (channel noise, not information).
 *   7. Adoption counter: per-skill `suggested`/`loaded` counters,
 *      incremented on delivery and on load, surfaced by the `skill_stats`
 *      tool. `suggested` counts DELIVERED suggestions: the counter increments
 *      only after `sendTrackedMessage` reports the whisper was accepted, so
 *      the number measures the suggestion channel rather than the intent to
 *      use it. A load has two evidence grades — a verbal claim (the LOADED
 *      probe reply, an honor-system grade the whisper does not solicit; the
 *      counter stays monotone for the store's series) and a detected actual
 *      load (SKILL.md read seen by the tool_result read-detector; failed
 *      reads are skipped — an error result is not a load). Both increment
 *      `loaded`, so the all-time series stays continuous;
 *      `claimed`/`actual` record which trigger fired, and the detected read
 *      is the primary signal — sessionHasSkillLoad gates on actual loads
 *      only. Durable store rows carry an `epoch` marking which counting
 *      regime their `suggested` number mixes (rows written before the
 *      delivered-only regime normalize to "mixed": inflated, not comparable
 *      to delivered-regime counts), and rows written before the
 *      claimed/actual split normalize with actual = loaded, claimed = 0.
 *   8. Discovery record: after a compaction, pi's section rebuild can put
 *      the stock skill catalog back into the persisted transcript (braid
 *      suppresses it per-turn, but the post-compaction diff runs against
 *      pi's own options). The module records whether the catalog is present
 *      and surfaces the state through skill_stats instead of mutating the
 *      transcript.
 *   9. Best-effort: failures are non-fatal, logged at debug level.
 *
 * Structure matches the existing steer whisper pattern used by topic-drift,
 * turn-outcome, compaction-retry, context-lifecycle, and others.
 *
 * Integration:
 * Registered in skills-tool/index.ts extension factory.
 * Consumes the module-level skill cache populated by prompt-builder's
 * before_agent_start handler.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../../../lib/core/logger.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";
import { getSkillsUsageFilePath } from "../../../lib/config/braid-paths.js";
import { SESSION_COMPACT, AGENT_SETTLED } from "../../../lib/core/event-names.js";
import {
  getSessionProfile,
  recordSessionSkillLoad,
  recordSessionStart,
} from "./session-records.js";
import { triggerMatches } from "./skill-triggers.js";

const log = createLogger("skills-auto-inject");

// Constants

/**
 * Max skill suggestions holding a slot at any time.
 *
 * The cap is the channel's throttle, and measurement says it must stay 2: a
 * third slot's fills convert far below the incumbent rate, and every
 * eviction/recycling variant that frees slots admits fills no better — the
 * loads a bigger cap would "recover" were outranked by other live matches,
 * not starved of slots.
 */
export const MAX_INJECTED = 2;

/**
 * Global cooldown floor: minimum turns before ANY skill can be re-injected.
 * Every injected skill cools down at least this long, whatever its own history.
 */
export const COOLDOWN_TURNS = 10;

/**
 * Per-skill cooldown extension: a suggested skill that was actually loaded
 * sits in the agent's context, so after its load it cools down for
 * LOADED_COOLDOWN_TURNS (3× the floor) and releases its suggestion slot for
 * the next match — re-suggesting an in-context skill is noise.
 */
export const LOADED_COOLDOWN_TURNS = 30;

/** Minimum keyword length to consider significant. */
const MIN_KEYWORD_LENGTH = 4;

/**
 * Max characters of SKILL.md body content carried in a suggestion whisper,
 * per skill. Bounded so the steer stays a whisper (~2 skills × 300 chars +
 * boilerplate). The whisper always points at the full file for the rest.
 */
export const MAX_EXCERPT_CHARS = 300;

/**
 * Minimum score for a skill whose match never touches its NAME (description
 * and/or filePath keyword hits only). Name matches qualify at any score.
 */
export const MIN_NON_NAME_SCORE = 2;

/**
 * Common English words to exclude from keyword matching.
 * Kept small — only the most frequent noise words that would
 * produce false positives across many skills.
 *
 * NOT the same set as lib/ai/critic-helpers.ts STOP_WORDS:
 * that list is a grammatical/text-normalization stop list for similarity
 * scoring; this one additionally filters domain noise words (work, tool,
 * code, file, task) for skill keyword extraction and deliberately omits
 * most function words (keyword matching needs them rare-but-meaningful).
 * Different sets with different jobs — deliberately not merged.
 */
const KEYWORD_STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "were",
  "they",
  "what",
  "when",
  "where",
  "which",
  "about",
  "into",
  "than",
  "then",
  "also",
  "just",
  "some",
  "more",
  "make",
  "like",
  "know",
  "will",
  "would",
  "could",
  "should",
  "their",
  "them",
  "very",
  "your",
  "over",
  "such",
  "each",
  "only",
  "other",
  "after",
  "before",
  "work",
  "tool",
  "code",
  "file",
  "task",
  "need",
  "look",
]);

// State

export interface InjectedSkill {
  name: string;
  turnNumber: number;
  filePath: string;
  /** Turn the skill was detected loaded after injection; releases the slot, extends the cooldown. */
  loadedTurn?: number;
}

interface AutoInjectState {
  /** Skills injected this session, ordered by injection time (oldest first). */
  injected: InjectedSkill[];
  /** Turn counter, incremented every before_agent_start. */
  currentTurn: number;
  /** True once the once-per-session profile hint whisper fired. */
  hintSent: boolean;
}

const STATE_KEY = "skills-auto-inject";

function getState(ctx: ExtensionContext): AutoInjectState {
  return getExtensionState(ctx, STATE_KEY, () => ({
    injected: [],
    currentTurn: 0,
    hintSent: false,
  }));
}

// Cached skills access
// Populated by prompt-builder's before_agent_start via setCachedSkills().
// We import the module-level cache from index.ts (the setter is already
// exported; we add an export for the getter).

export interface CachedSkill {
  name: string;
  filePath: string;
  description: string;
  baseDir: string;
  sourceInfo?: { source?: string; package?: string };
  /** pi frontmatter flag: excluded from model selection (explicit invocation only). */
  disableModelInvocation?: boolean;
  /** Frontmatter trigger phrases (setCachedSkills resolves them from SKILL.md). */
  triggers?: string[];
}

// Shared module-level variable rather than a per-module copy: the import
// cycle is safe — index.ts calls setCachedSkills, auto-inject reads
// getCachedSkills.
let _skillsCache: CachedSkill[] = [];

/** Called by index.ts's setCachedSkills to keep the auto-inject cache in sync. */
export function updateSkillCache(skills: CachedSkill[]): void {
  _skillsCache = skills;
}

// Keyword Extraction

/**
 * One-rule stemmer: strip a trailing plural s/es so "skills" matches the
 * "skill" name token. Kept deliberately crude — one suffix rule, no
 * dictionary — because the matcher needs recall on plurals, not linguistics:
 *   "sses"/"xes"/"zes"/"ches"/"shes" → strip es (classes→class, boxes→box)
 *   other trailing s (not ss)         → strip s  (skills→skill, memes→meme)
 * Everything else passes through unchanged.
 */
export function stemKeyword(word: string): string {
  if (/sses$/.test(word) || /(?:x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Extract significant keywords from a text string.
 * Filters out stop words, short words, and non-alphabetic tokens, then stems
 * trailing plurals; the stem result must still pass the length and stop-word
 * bar (stemming "tasks" lands on the noise word "task", which stays out).
 */
export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_KEYWORD_LENGTH && !KEYWORD_STOP_WORDS.has(w) && /[a-z]/.test(w))
    .map(stemKeyword)
    .filter((w) => w.length >= MIN_KEYWORD_LENGTH && !KEYWORD_STOP_WORDS.has(w));

  return [...new Set(words)];
}

// Relevance Scoring

/**
 * Score a skill against a set of keywords.
 *
 * Scoring rules:
 *   +3  skill name contains a keyword (exact match)
 *   +2  skill name contains a keyword as substring
 *   +2  a frontmatter trigger phrase occurs in the prompt (word-bounded)
 *   +1  skill description contains a keyword
 *   +1  skill filePath contains a keyword (e.g. "research" in "research/SKILL.md")
 *
 * A trigger hit counts as a name hit: the phrase is the skill author's own
 * relevance signal, so it qualifies the skill the same way a name match does.
 *
 * Qualification bar: a skill whose match never touches its NAME (description
 * and/or filePath hits only) must reach a total score of at least
 * MIN_NON_NAME_SCORE — one description keyword is too weak a signal and
 * lets generic skills fire on almost any prompt. Name and trigger matches
 * always qualify.
 *
 * `promptText` (lowercased by the caller or raw — matching is case-insensitive
 * on our side) enables trigger matching; omit it where the raw prompt is not
 * available and only keyword scoring should run.
 *
 * Returns 0 if the skill does not qualify.
 */
export function scoreSkill(skill: CachedSkill, keywords: string[], promptText?: string): number {
  let score = 0;
  let nameHit = false;
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  const path = skill.filePath.toLowerCase();

  for (const trig of skill.triggers ?? []) {
    if (triggerMatches(trig, promptText ?? "")) {
      score += 2;
      nameHit = true;
    }
  }

  for (const kw of keywords) {
    // Exact token match in name
    if (name.split(/[^a-z0-9]+/).includes(kw)) {
      score += 3;
      nameHit = true;
      continue;
    }
    // Substring match in name (catches compound names like "code-search")
    if (name.includes(kw)) {
      score += 2;
      nameHit = true;
      continue;
    }
    // Description contains keyword
    if (desc.includes(kw)) {
      score += 1;
      continue;
    }
    // File path matches (e.g. "research" in "research/SKILL.md")
    if (path.includes(kw)) {
      score += 1;
    }
  }

  if (!nameHit && score < MIN_NON_NAME_SCORE) return 0;
  return score;
}

/**
 * Decide which scored skills to suggest given the session injection state.
 * Pure — mirrors the handler's decision path so it can be unit-tested:
 *   sort (score desc, name asc) → cooldown filter (global floor + per-skill
 *   loaded extension) → slot budget over ACTIVE held slots (a loaded skill
 *   released its slot) → top-N slice.
 *
 * Returns the chosen scored items (empty when nothing qualifies). The
 * caller is responsible for recording the picks in session state.
 */
export function selectSuggestions(
  scored: Array<{ skill: CachedSkill; score: number }>,
  injected: InjectedSkill[],
  currentTurn: number,
): Array<{ skill: CachedSkill; score: number }> {
  if (!scored.length) return [];

  const sorted = [...scored].sort(
    (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
  );

  const available = sorted.filter((s) => !onCooldown(s.skill.name, injected, currentTurn));
  if (!available.length) return [];

  // Active slots: not-yet-loaded injections. A loaded skill sits in the
  // agent's context — its slot is released for the next match.
  const active = injected.filter((i) => i.loadedTurn === undefined);
  const slotBudget = MAX_INJECTED - active.length;
  if (slotBudget <= 0) return [];

  return available.slice(0, slotBudget);
}

/**
 * Cooldown gate: the global floor applies to every injection; a skill that
 * was loaded after its injection additionally cools down for
 * LOADED_COOLDOWN_TURNS from the load (it is already in context).
 */
function onCooldown(name: string, injected: InjectedSkill[], currentTurn: number): boolean {
  const prev = injected.find((i) => i.name === name);
  if (!prev) return false;
  if (currentTurn - prev.turnNumber < COOLDOWN_TURNS) return true;
  if (prev.loadedTurn !== undefined && currentTurn - prev.loadedTurn < LOADED_COOLDOWN_TURNS) {
    return true;
  }
  return false;
}

// Steer Whisper Content

/**
 * Strip YAML frontmatter from a SKILL.md body. Pure.
 *
 * Agent Skills files open with `---\nkey: value...\n---`; the frontmatter
 * duplicates the metadata we already have (name/description), so the excerpt
 * starts at the actual instructions. Tolerant: files without frontmatter
 * (or with an unclosed `---` block) are returned as-is.
 */
export function stripSkillFrontmatter(content: string): string {
  const text = content.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return text;
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines
        .slice(i + 1)
        .join("\n")
        .trim();
    }
  }
  return text; // no closing delimiter — treat the whole doc as body
}

/**
 * Bounded excerpt of a skill body: strip frontmatter, trim, cap at maxChars,
 * mark truncation. Pure.
 */
export function extractSkillExcerpt(content: string, maxChars: number = MAX_EXCERPT_CHARS): string {
  const body = stripSkillFrontmatter(content).trim();
  if (body.length <= maxChars) return body;
  const cut = body.slice(0, maxChars);
  // Cut at a word boundary when possible; always collapse trailing whitespace.
  const boundary = cut.lastIndexOf(" ");
  const slice = (boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut).trimEnd();
  return slice + "…";
}

/**
 * Read a SKILL.md from disk and return a bounded body excerpt.
 * Returns "" on any error (missing file, unreadable) — the caller falls
 * back to the skill description.
 */
export function readSkillExcerpt(filePath: string, maxChars: number = MAX_EXCERPT_CHARS): string {
  try {
    return extractSkillExcerpt(readFileSync(filePath, "utf-8"), maxChars);
  } catch {
    return "";
  }
}

/** Collapse whitespace/newlines to single spaces for a one-line whisper bullet. */
function toOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Format the steer whisper content for a set of recommended skills.
 *
 * Each bullet carries a BOUNDED excerpt of the SKILL.md body (frontmatter
 * stripped, ≤ MAX_EXCERPT_CHARS, collapsed to one line) plus an explicit
 * read pointer to the full file — the agent sees real skill content at the
 * moment of domain match, not just a truncated description. Unreadable
 * files fall back to the description (also bounded, one line).
 */
export function formatWhisper(skills: CachedSkill[]): string {
  const lines = skills.map((s) => {
    const excerpt = readSkillExcerpt(s.filePath) || s.description;
    // Strip the truncation mark (if any) — the read pointer follows immediately.
    const lead = toOneLine(excerpt)
      .slice(0, MAX_EXCERPT_CHARS)
      .replace(/\.\.\.$/, "")
      .replace(/…$/, "");
    return `- ${s.name}: ${lead} — read \`${s.filePath}\` for the full skill.`;
  });
  return (
    `[SKILL SUGGESTION] These skills match your current task; their content is excerpted below:\n` +
    lines.join("\n") +
    `\n(Use \`list_skills\` to see all available skills; read a SKILL.md file for full context.)`
  );
}

// Adoption counters

/** Per-skill usage counters, session-scoped (a durable cross-session copy is mirrored below). */
export interface SkillStats {
  /** Times this skill was suggested via the auto-inject whisper. */
  suggested: number;
  /** Total loads: probe claims plus detected SKILL.md reads. */
  loaded: number;
  /** Loads claimed verbally via the LOADED probe reply (honor system). */
  claimed: number;
  /** Loads detected by the read tool (SKILL.md read via tool_result). */
  actual: number;
}

const STATS_KEY = "skills-usage-stats";

function getStats(ctx: ExtensionContext): Record<string, SkillStats> {
  return getExtensionState(ctx, STATS_KEY, () => ({}));
}

/** Read the session's per-skill usage counters (for the skill_stats tool). */
export function getSkillStats(ctx: ExtensionContext): Record<string, SkillStats> {
  return getStats(ctx);
}

/** Increment `suggested` for each skill name — called only AFTER a whisper
 *  was accepted for delivery, so the counter measures arrivals. */
export function recordSkillSuggestion(ctx: ExtensionContext, names: string[]): void {
  const stats = getStats(ctx);
  for (const name of names) {
    const s = (stats[name] ??= { suggested: 0, loaded: 0, claimed: 0, actual: 0 });
    s.suggested++;
    recordDurable(name, "suggested");
  }
}

/**
 * Record a DETECTED load (SKILL.md read via the read tool) — the primary,
 * verified load signal. Increments `loaded` + `actual`, and flips the
 * session's durable adoption record to hadSkillLoad (the monthly rollup
 * numerator; claims never set it).
 */
export function recordSkillLoad(ctx: ExtensionContext, name: string): void {
  if (!name) return;
  const stats = getStats(ctx);
  const s = (stats[name] ??= { suggested: 0, loaded: 0, claimed: 0, actual: 0 });
  s.loaded++;
  s.actual++;
  recordDurable(name, "actual");
  recordSessionSkillLoad(ctx);
}

/**
 * Record a CLAIMED load (a verbal "LOADED <name>" reply — the honor-system
 * signal). The suggestion whisper does not solicit the reply, so this has no
 * production caller; the export exists to keep `claimed` monotone in the
 * durable store's published series. Increments `loaded` + `claimed`.
 */
export function recordSkillClaim(ctx: ExtensionContext, name: string): void {
  if (!name) return;
  const stats = getStats(ctx);
  const s = (stats[name] ??= { suggested: 0, loaded: 0, claimed: 0, actual: 0 });
  s.loaded++;
  s.claimed++;
  recordDurable(name, "claim");
}

// Durable adoption counters (cross-session)

/**
 * Which counting regime produced an entry's `suggested` number:
 *   "delivered" — every increment counted a whisper ACCEPTED for delivery
 *                 (the only regime current code writes).
 *   "mixed"     — the row predates the epoch split and may contain
 *                 increments counted before delivery acceptance (inflated).
 * A mixed row stays mixed when new increments land on it: the inflation
 * cannot be split out of the counter, so the epoch never silently improves.
 */
export type SuggestedEpoch = "delivered" | "mixed";

/**
 * Per-skill durable counters, persisted to getSkillsUsageFilePath() so the
 * adoption baseline survives process restart. Unlike the session-scoped state
 * above, this is process-global BY DESIGN (cross-session telemetry, disk-backed)
 * — the same exception class as `_skillsCache` above: the value must be
 * reachable from whisper-path code with no ctx threading, and the file is the
 * source of truth, not the cache.
 */
export interface DurableSkillStats {
  /** All-time suggestion count (see `epoch` for which regime it mixes). */
  suggested: number;
  /** All-time load count (claims + detected reads). */
  loaded: number;
  /** All-time count of verbally claimed loads (LOADED probe reply). */
  claimed: number;
  /** All-time count of detected loads (SKILL.md read via the read tool). */
  actual: number;
  /** ISO timestamp of the most recent recorded event. */
  lastAt: string;
  /** Which counting regime `suggested` mixes (see SuggestedEpoch). */
  epoch: SuggestedEpoch;
}

let _durableStore: Record<string, DurableSkillStats> | undefined;

/** Normalize one raw file entry; undefined when the entry is not usable. */
function normalizeDurableEntry(raw: unknown): DurableSkillStats | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const suggested =
    typeof r.suggested === "number" && Number.isFinite(r.suggested) ? r.suggested : 0;
  const loaded = typeof r.loaded === "number" && Number.isFinite(r.loaded) ? r.loaded : 0;
  const claimed = typeof r.claimed === "number" && Number.isFinite(r.claimed) ? r.claimed : 0;
  // Rows written before the claimed/actual split carry only `loaded`:
  // treat the whole count as actual (claimed 0) — no migration needed.
  const actual =
    typeof r.actual === "number" && Number.isFinite(r.actual)
      ? r.actual
      : Math.max(0, loaded - claimed);
  return {
    suggested,
    loaded,
    claimed,
    actual,
    lastAt: typeof r.lastAt === "string" ? r.lastAt : "",
    // Rows without an epoch predate the split: their `suggested` may mix
    // pre-delivery-regime increments with delivered ones.
    epoch: r.epoch === "delivered" ? "delivered" : "mixed",
  };
}

/**
 * Read the durable store from disk. Missing OR corrupt file → fresh start
 * ({}). Never throws: the suggestion path depends on this staying safe.
 */
function readDurableStore(): Record<string, DurableSkillStats> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getSkillsUsageFilePath(), "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, DurableSkillStats> = {};
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeDurableEntry(entry);
      if (normalized) out[name] = normalized;
    }
    return out;
  } catch {
    return {}; // missing or corrupt → fresh start
  }
}

/** In-memory durable store, lazily loaded once per process. */
function getDurableStore(): Record<string, DurableSkillStats> {
  if (!_durableStore) _durableStore = readDurableStore();
  return _durableStore;
}

/**
 * Best-effort atomic-ish write (temp file + rename) of the durable store.
 * Swallows every error: this runs on the whisper path — a stats failure must
 * NEVER break suggestions. The first refusal in a process still warns (the
 * sink may be refusing because no absolute braid root resolves); later ones
 * stay at debug.
 */
function persistDurableStore(): void {
  try {
    if (!_durableStore) return;
    const file = getSkillsUsageFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(_durableStore, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    reportDurableFailure("write", err);
  }
}

/** Warned once per process about a refused durable skills store. */
let _warnedDurableFailure = false;

function reportDurableFailure(action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (_warnedDurableFailure) {
    log.debug(`[skills-auto-inject] durable stats ${action} failed (best-effort): ${message}`);
    return;
  }
  _warnedDurableFailure = true;
  log.warn(`[skills-auto-inject] durable stats ${action} failed (best-effort): ${message}`);
}

/** Record one durable event and flush to disk (best-effort). */
function recordDurable(name: string, kind: "suggested" | "claim" | "actual"): void {
  try {
    const store = getDurableStore();
    const entry = (store[name] ??= {
      suggested: 0,
      loaded: 0,
      claimed: 0,
      actual: 0,
      lastAt: "",
      epoch: "delivered",
    });
    if (kind === "suggested") {
      entry.suggested++;
    } else {
      entry.loaded++;
      if (kind === "claim") entry.claimed++;
      else entry.actual++;
    }
    entry.lastAt = new Date().toISOString();
    persistDurableStore();
  } catch (err) {
    reportDurableFailure("update", err);
  }
}

/** Read the durable per-skill counters (for the skill_stats tool). */
export function getDurableSkillStats(): Record<string, DurableSkillStats> {
  return getDurableStore();
}

/**
 * Resolve a skill name from a read-tool result: the SKILL.md frontmatter
 * signature (`---\nname: <name>`) first, then the file path against the
 * cached catalog. Returns undefined when the read is not a skill load.
 *
 * Exported for the read-detector tests (the list→read load path): the
 * function is pure given the module-level cache, which tests seed via
 * updateSkillCache().
 */
export function skillNameFromRead(filePath: string | undefined, text: string): string | undefined {
  const fm = text.match(/^\s*---\s*\r?\n\s*name:\s*([^\s]+)/);
  if (fm) return fm[1];
  if (filePath) {
    const hit = _skillsCache.find((s) => s.filePath === filePath);
    if (hit) return hit.name;
    const base = filePath.split(/[\\/]/).pop() ?? "";
    if (base === "SKILL.md") {
      const dir = filePath.split(/[\\/]/).slice(-2, -1)[0] ?? "";
      const byDir = _skillsCache.find((s) => s.name === dir);
      if (byDir) return byDir.name;
    }
  }
  return undefined;
}

// Discovery-mode record (post-compaction catalog re-entry)

/** Session-scoped record of the discovery surface's state. */
interface DiscoveryState {
  /** Successful compactions seen this session. */
  compactions: number;
  /** A compaction landed since the last transcript check. */
  pendingCatalogCheck: boolean;
  /** Reason of the most recent compaction (manual / threshold / overflow). */
  lastCompactionReason?: string;
  /** Result of the last transcript check. */
  stockCatalogSeen?: boolean;
  /** ISO timestamp of the last transcript check. */
  checkedAt?: string;
}

const DISCOVERY_STATE_KEY = "skills-discovery";

/** The stock catalog's own tag — braid never writes this section itself. */
const STOCK_SKILLS_MARKER = "<available_skills>";

function getDiscoveryState(ctx: ExtensionContext): DiscoveryState {
  return getExtensionState(ctx, DISCOVERY_STATE_KEY, () => ({
    compactions: 0,
    pendingCatalogCheck: false,
  }));
}

/** True when a persisted system message carries pi's stock skill catalog. */
function transcriptHasStockCatalog(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  return entries.some((entry) => {
    const msg = (entry as { message?: { role?: string; sections?: Record<string, unknown> } })
      ?.message;
    if (msg?.role !== "system" || typeof msg.sections?.skills !== "string") return false;
    return (msg.sections.skills as string).includes(STOCK_SKILLS_MARKER);
  });
}

/**
 * Run the pending transcript check (one per compaction) and record the
 * discovery mode. Returns the current record for skill_stats.
 */
export function resolveDiscoveryMode(ctx: ExtensionContext): DiscoveryState {
  const state = getDiscoveryState(ctx);
  if (state.pendingCatalogCheck) {
    state.pendingCatalogCheck = false;
    state.stockCatalogSeen = transcriptHasStockCatalog(ctx);
    state.checkedAt = new Date().toISOString();
    if (state.stockCatalogSeen) {
      log.info(
        `[skills-auto-inject] stock skill catalog present in the transcript after compaction ` +
          `(reason: ${state.lastCompactionReason ?? "unknown"})`,
      );
    }
  }
  return state;
}

// Main Handler

/**
 * Register the auto-inject handler on before_agent_start plus the
 * read-tool load detector on tool_result.
 *
 * Call this from the skills-tool extension factory, after registering
 * the list_skills tool.
 */
export function registerAutoInject(pi: ExtensionAPI): void {
  // Count SKILL.md reads (the list→read load path) via the read tool, and
  // per-skill: mark the matching injection as loaded (releases its slot and
  // extends its cooldown — the skill is in the agent's context now).
  pi.on("tool_result", (event: unknown, ctx: ExtensionContext) => {
    try {
      const ev = event as {
        toolName?: string;
        isError?: boolean;
        input?: { path?: string };
        content?: Array<{ text?: string }>;
      };
      if (ev?.toolName !== "read") return;
      // A failed read returns the error text, not the file — counting it
      // inflated `loaded` with phantom loads (the read-detector never saw
      // the skill content, and no SKILL.md was opened).
      if (ev.isError) return;
      const text = (ev.content ?? []).map((c) => c.text ?? "").join("\n");
      const name = skillNameFromRead(ev.input?.path, text);
      if (name) {
        const state = getState(ctx);
        const held = state.injected.find((i) => i.name === name && i.loadedTurn === undefined);
        if (held) held.loadedTurn = state.currentTurn;
        recordSkillLoad(ctx, name);
        log.debug(`[skills-auto-inject] counted actual load of "${name}" via read`);
      }
    } catch {
      // best-effort — never break the tool loop over a counter
    }
  });

  // Post-compaction the transcript can regain pi's stock skill catalog (the
  // section diff is computed against pi's own prompt options, not braid's
  // mutated ones). Recording that state change keeps the discovery surface
  // honest; stripping the block would mean mutating persisted session
  // entries — no sanctioned seam, not worth it.
  pi.on(SESSION_COMPACT, (event: unknown, ctx: ExtensionContext) => {
    try {
      const state = getDiscoveryState(ctx);
      state.compactions++;
      state.lastCompactionReason =
        typeof (event as { reason?: unknown })?.reason === "string"
          ? ((event as { reason: string }).reason as string)
          : undefined;
      state.pendingCatalogCheck = true;
    } catch {
      // best-effort
    }
  });

  // The rebuilt system message persists when the post-compaction run starts,
  // so the check runs at settle — after the run's entries are on disk.
  pi.on(AGENT_SETTLED, (_event: unknown, ctx: ExtensionContext) => {
    try {
      resolveDiscoveryMode(ctx);
    } catch {
      // best-effort
    }
  });

  pi.on("before_agent_start", async (event: unknown, ctx: ExtensionContext) => {
    try {
      // Once-per-session durable adoption record (the rollup denominator).
      recordSessionStart(ctx);
      const state = getState(ctx);
      state.currentTurn++;
      // Explicit-invocation-only skills are not advertised: pi hides them
      // from its prompt block, so the suggestion whisper must not put them
      // back in front of the model. The unfiltered cache still resolves an
      // explicit read in skillNameFromRead().
      const skills = _skillsCache.filter((s) => !s.disableModelInvocation);

      const ev = event as {
        prompt?: string;
        systemPrompt?: string;
        systemPromptOptions?: { skills?: unknown[] };
      };
      const prompt = ev.prompt ?? "";
      if (!prompt.trim()) {
        return; // No user input to match against
      }

      // One-shot profile hint: the first non-empty prompt of a session whose
      // configured profile carries a hint gets exactly one steer — the hint
      // text itself, byte-for-byte. Profiles without a hint and sessions
      // matching no profile get nothing; an empty first prompt defers the
      // fire to the next non-empty prompt, still once per session. Sent
      // before the keyword path so the hint reaches the agent even when the
      // skill cache is not populated yet.
      const profile = getSessionProfile(ctx);
      if (!state.hintSent && profile.hint) {
        state.hintSent = true;
        log.info(
          `[skills-auto-inject] profile hint whisper (profile "${profile.name}", first non-empty prompt)`,
        );
        sendTrackedMessage(
          pi,
          {
            customType: "skills-boot",
            content: [{ type: "text" as const, text: profile.hint }],
            display: true,
            details: {
              [BRAID_INJECTED]: true,
              [BRAID_SOURCE]: "skills-auto-inject",
            },
          },
          { delivery: "park", deliverAs: "steer" },
          { type: "context", source: "skills-auto-inject" },
        );
      }

      if (!skills.length) {
        return; // No skills loaded yet — nothing to suggest
      }

      const keywords = extractKeywords(prompt);
      if (!keywords.length) {
        return; // No significant keywords to match
      }

      // Score each skill. The raw prompt rides along for trigger matching.
      const scored = skills
        .map((s) => ({ skill: s, score: scoreSkill(s, keywords, prompt) }))
        .filter((s) => s.score > 0);

      if (!scored.length) {
        return; // No relevant skills found
      }

      // Cooldown + slot budget (pure decision, exported for tests).
      const toInject = selectSuggestions(scored, state.injected, state.currentTurn);

      if (!toInject.length) {
        return;
      }

      const skillsToInject = toInject.map((s) => s.skill);
      const text = formatWhisper(skillsToInject);

      // Delivery first, bookkeeping second: a suggestion that a suppression
      // path drops must neither consume its cooldown slot nor move a counter.
      // See the module header for why the cap is bypassed here.
      const delivered = sendTrackedMessage(
        pi,
        {
          customType: "skills-suggestion",
          content: [{ type: "text" as const, text }],
          display: true,
          details: {
            [BRAID_INJECTED]: true,
            [BRAID_SOURCE]: "skills-auto-inject",
            skills: skillsToInject.map((s) => s.name),
          },
        },
        { delivery: "park", deliverAs: "steer" },
        { type: "context", source: "skills-auto-inject" },
        { bypassFloodCap: true },
      );

      if (!delivered) {
        log.debug("[skills-auto-inject] suggestion suppressed before delivery; not counted");
        return;
      }

      log.info(
        `[skills-auto-inject] Suggesting ${skillsToInject.map((s) => s.name).join(", ")} ` +
          `(turn ${state.currentTurn}, keywords: ${keywords.slice(0, 5).join(", ")})`,
      );

      for (const item of toInject) {
        state.injected.push({
          name: item.skill.name,
          turnNumber: state.currentTurn,
          filePath: item.skill.filePath,
        });
      }
      // Bound the history: an entry whose loaded cooldown fully expired can
      // no longer affect any cooldown or slot decision.
      state.injected = state.injected.filter(
        (i) =>
          state.currentTurn - i.turnNumber < LOADED_COOLDOWN_TURNS ||
          (i.loadedTurn !== undefined && state.currentTurn - i.loadedTurn < LOADED_COOLDOWN_TURNS),
      );

      // E3: per-skill suggestion counter — counts deliveries, not intent.
      recordSkillSuggestion(
        ctx,
        skillsToInject.map((s) => s.name),
      );
    } catch (err) {
      log.debug(`[skills-auto-inject] Error in before_agent_start: ${err}`);
    }
  });
}
