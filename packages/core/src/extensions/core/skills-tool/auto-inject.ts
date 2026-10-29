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
 *      curated trigger phrases against the user's current prompt.
 *      Qualification bar: a skill whose match never touches its NAME (name
 *      token or trigger phrase) must reach a score of at least
 *      MIN_NON_NAME_SCORE — a lone description/path keyword hit is too weak
 *      a signal: it fires broad skills on almost any prompt.
 *      Keywords are stemmed with one suffix rule (trailing s/es) so plural
 *      prompts hit singular name tokens ("skills" → "skill").
 *      Corpus-common words are gated out of the weak legs AND out of the
 *      name leg's prefix hits: a word present in COMMON_KEYWORD_DF or more of
 *      the cached skills' documents cannot tell skills apart, so
 *      description/path hits from it score nothing. A name hit is word-shaped
 *      by construction — a whole name token, or the start of one — so a word
 *      buried inside a coined token ("line" in placement-disc**line**) is not
 *      a name hit at all. A whole-name-token hit and a trigger hit are never
 *      gated: the skill's own identity vocabulary is what a prompt naming it
 *      looks like, and a curated phrase is the author's signal.
 *   1b. Ranking: equal scores compare by more distinct matched signals, then
 *      by rarer evidence (lower summed document frequency), then by name.
 *      Alphabetical order alone decided which of two equally-scored skills
 *      took a slot, which is how a broadly-matching skill outranked the one
 *      whose evidence was the prompt's actual subject.
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
 *  10. Drift trigger: the visible catalog in the prompt is a snapshot of the
 *      work's directory, not of the session. When the path-taking tools
 *      accumulate entries in a new work area, one steer line re-points at the
 *      catalog (at most DRIFT_MAX_FIRES a session, DRIFT_WINDOW_CALLS apart,
 *      and never within that window of a suggestion or a SKILL.md read). The
 *      rule and its bounds live in loading-guidance.ts beside the floor text
 *      the line points at; this module only wires them to tool results.
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
  recordApplicabilityCensus,
  recordApplicabilityVerdict,
  recordSessionSkillLoad,
  recordSessionStart,
} from "./session-records.js";
import { evaluateApplicability } from "./applicability.js";
import type { SkillApplicabilityVerdict } from "./applicability.js";
import { triggerMatches } from "./skill-triggers.js";
import type { TriggerSource } from "./skill-triggers.js";
import {
  advanceDrift,
  driftDirectoryFor,
  driftPayload,
  initialDrift,
  noteDriftSurface,
  recordDriftDrop,
  recordDriftFire,
  skillReadRoot,
} from "./loading-guidance.js";
import type { CatalogEntry, DriftTracker } from "./loading-guidance.js";

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
 * A keyword present in this many skill documents or more is corpus-common: it
 * appears in a large share of the catalog (5 of 22 skills = 23%), so it cannot
 * distinguish one skill from another and contributes NOTHING to the weak legs
 * (description, catalog path) — or to the name leg's token-prefix rule, the one
 * name hit that can rest on a shared word.
 *
 * The number is measured, not guessed. Two measurements, one threshold:
 *
 *   Corpus mass. Over 400 recorded prompts against the 22-skill catalog, the
 *   weak-leg points awarded to words by document frequency are df1 17.0%,
 *   df2 22.4%, df3 20.9%, df4 13.3%, df5 7.8%, df6 4.1%, df7 9.1%, df9 0.4%,
 *   df22 5.1%. Words at df ≥ 5 carry 26.4% of every weak-leg point the matcher
 *   awards; df ≥ 4 carries 39.7%, df ≥ 6 carries 18.6%. The catalog's generic
 *   vocabulary starts here (skill, read, prompt, text, build, change, agent,
 *   line); below it the words still describe work types (review, check, test,
 *   edit, documentation).
 *
 *   Labelled set. 26 recorded prompts, recall@2 by threshold: df ≥ 4 → 12/23,
 *   df ≥ 5 → 13/23, df ≥ 6 → 13/23, df ≥ 7 → 14/23, no gate at all → 12/23.
 *   Recall alone cannot choose the number: every step that weakens the gate
 *   admits more skills (45, 54, 67, 71, 106 admissions) and admitting more can
 *   only raise a top-2 recall figure. 5 is where the gate removes a quarter of
 *   the corpus-common mass without also deleting the work-type words that are
 *   sometimes a skill's only reachable evidence.
 */
export const COMMON_KEYWORD_DF = 5;

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
  /** Where the work is going, for the drift trigger (loading-guidance.ts). */
  drift: DriftTracker;
  /** Which skills' own declared conditions held this session (applicability.ts). */
  applicability: ApplicabilityState;
}

/**
 * The session's applicability bookkeeping. Cumulative by design: once a task
 * text met a skill's declared condition, the skill applied to that session, and
 * a read that lands on a later turn is still a read of a skill that applied.
 */
interface ApplicabilityState {
  /** True once the session's census row landed on disk. */
  censusWritten: boolean;
  /** Verdicts by skill name; only ever grows, and an entry only ever upgrades. */
  verdicts: Map<string, SkillApplicabilityVerdict>;
  /** Skills declaring a condition, from the latest evaluation. */
  evaluated: number;
  /** Skills declaring none, from the latest evaluation. */
  undeclared: string[];
  /** Task-text length the latest evaluation read. */
  taskChars: number;
}

function initialApplicability(): ApplicabilityState {
  return { censusWritten: false, verdicts: new Map(), evaluated: 0, undeclared: [], taskChars: 0 };
}

const STATE_KEY = "skills-auto-inject";

function getState(ctx: ExtensionContext): AutoInjectState {
  return getExtensionState(ctx, STATE_KEY, () => ({
    injected: [],
    currentTurn: 0,
    hintSent: false,
    drift: initialDrift(),
    applicability: initialApplicability(),
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
  /** Which source authored each phrase (the row's evidence label). */
  triggerSources?: Record<string, TriggerSource>;
}

// Shared module-level variable rather than a per-module copy: the import
// cycle is safe — index.ts calls setCachedSkills, auto-inject reads
// getCachedSkills.
let _skillsCache: CachedSkill[] = [];

/** Called by index.ts's setCachedSkills to keep the auto-inject cache in sync. */
export function updateSkillCache(skills: CachedSkill[]): void {
  _skillsCache = skills;
}

/**
 * The visible catalog as the prompt floor renders it (see loading-guidance.ts):
 * every cached skill model selection may route to, with the description and
 * path the row needs. Read from this module because the cache lives here; the
 * floor's read root is derived from the paths, never hardcoded.
 */
export function getCachedVisibleSkills(): CatalogEntry[] {
  return _skillsCache
    .filter((s) => !s.disableModelInvocation)
    .map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }));
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
 * The text a skill contributes to the corpus-frequency count: its description
 * plus its own catalog path (`<dir>/skill.md`). Deliberately NOT the absolute
 * path: a checkout root puts its own directory names ("private", "packages",
 * a worktree name) in every one of the 22 documents — measured at df 22 for
 * `private`, `package`, `pack` and `core`, and different on every machine the
 * agent runs on. On description plus the skill's own directory those four
 * measure df 0, 1, 1 and 2; `skill` and `kill` stay catalog-wide because the
 * file itself is named SKILL.md, and the rarity gate is what removes them.
 * Lowercased; the matcher tests substrings. Pure.
 */
export function skillCorpusDocument(skill: CachedSkill): string {
  const tail = skill.filePath.toLowerCase().split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  return `${skill.description.toLowerCase()} ${tail}`;
}

/**
 * Document frequency of each keyword across the cached skills: how many skill
 * documents contain it as a substring (the test every weak leg performs).
 * Computed once per turn from the cache, for the prompt's keywords only. Pure
 * given the cache.
 */
export function corpusKeywordFrequency(
  keywords: string[],
  skills: CachedSkill[],
): Map<string, number> {
  const docs = skills.map(skillCorpusDocument);
  const freq = new Map<string, number>();
  for (const kw of keywords) {
    let n = 0;
    for (const doc of docs) if (doc.includes(kw)) n++;
    freq.set(kw, n);
  }
  return freq;
}

/** One skill's match against a prompt: points, distinct signals, evidence rarity. */
export interface SkillMatch {
  /** Score the qualification bar and the ranking read (same scale as before). */
  score: number;
  /** Distinct matched signals: each trigger phrase, each distinct keyword. */
  signals: number;
  /** Summed document frequency of the matched keywords — lower is rarer. */
  evidenceDf: number;
  /** Strongest evidence behind the score; null when the skill did not qualify. */
  reason: RelevanceReason | null;
}

/**
 * What the strongest evidence for a row was. Short on purpose: a ranking row
 * says "trigger", not a sentence — the reader is choosing a read, not reading
 * an explanation.
 *
 *   trigger     — an authored phrase from frontmatter or the description tail
 *   heading     — an authored phrase from a `## trigger:` body heading
 *   name        — a keyword in the skill's own name
 *   description — a description or catalog-path keyword (the weak legs)
 */
export type RelevanceReason = "trigger" | "heading" | "name" | "description";

/** Evidence strength for the row's single `reason` field. */
const REASON_STRENGTH: Record<RelevanceReason, number> = {
  trigger: 4,
  heading: 3,
  name: 2,
  description: 1,
};

/**
 * How a keyword occurs in a skill name: as a whole token, as the start of a
 * longer token, or not at all.
 *
 * The third answer is the fix: the name leg used to award points to any
 * substring anywhere in the name, so a corpus-common word ("line", df 7 of 22)
 * scored +2 for placement-disc**line** and release-pi**peline** and carried the
 * name-hit exemption from the qualification bar with it. A word buried inside
 * a coined token names the author's coinage, not the prompt's subject; a word
 * that starts a token still reads as the author's own vocabulary ("engine" in
 * software-engineer).
 */
function nameOccurrence(tokens: string[], kw: string): "token" | "prefix" | null {
  if (tokens.includes(kw)) return "token";
  for (const token of tokens) if (token.length > kw.length && token.startsWith(kw)) return "prefix";
  return null;
}

const NO_MATCH: SkillMatch = { score: 0, signals: 0, evidenceDf: 0, reason: null };

/**
 * Score a skill against a set of keywords.
 *
 * Scoring rules:
 *   +3  skill name carries a keyword as a whole token (exact match)
 *   +2  skill name starts a token with a keyword, below the frequency gate
 *   +2  a trigger phrase occurs in the prompt (word-bounded)
 *   +1  skill description contains a keyword
 *   +1  the skill's own catalog path contains a keyword (e.g. "research" in
 *       "research/skill.md")
 *
 * A trigger hit counts as a name hit: the phrase is the skill author's own
 * relevance signal, so it qualifies the skill the same way a name match does.
 *
 * `keywordDf` is the corpus document frequency of the prompt's keywords (see
 * corpusKeywordFrequency). A keyword at COMMON_KEYWORD_DF or above scores
 * nothing on the weak legs, and nothing on the name leg's token-prefix rule:
 * a common word that only starts a token ("line" in "line-counting") is
 * vocabulary the catalog shares, not the skill's own. Passing no map scores
 * every keyword at full weight (the pre-rarity behavior, which the unit
 * fixtures pin).
 *
 * Qualification bar: a skill whose match never touches its NAME (description
 * and/or filePath hits only) must reach a total score of at least
 * MIN_NON_NAME_SCORE — one description keyword is too weak a signal and
 * lets generic skills fire on almost any prompt. Name and trigger matches
 * always qualify.
 *
 * `promptText` enables trigger matching; omit it where the raw prompt is not
 * available and only keyword scoring should run.
 *
 * Returns the zero match if the skill does not qualify.
 */
export function matchSkill(
  skill: CachedSkill,
  keywords: string[],
  promptText?: string,
  keywordDf?: ReadonlyMap<string, number>,
): SkillMatch {
  let score = 0;
  let signals = 0;
  let evidenceDf = 0;
  let nameHit = false;
  let reason: RelevanceReason | null = null;
  const noteReason = (candidate: RelevanceReason) => {
    if (!reason || REASON_STRENGTH[candidate] > REASON_STRENGTH[reason]) reason = candidate;
  };
  const name = skill.name.toLowerCase();
  const nameTokens = name.split(/[^a-z0-9]+/).filter(Boolean);
  const desc = skill.description.toLowerCase();
  const path = skill.filePath.toLowerCase().split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  const dfOf = (kw: string) => keywordDf?.get(kw) ?? 0;

  for (const trig of skill.triggers ?? []) {
    if (triggerMatches(trig, promptText ?? "")) {
      score += 2;
      signals++;
      nameHit = true;
      // A curated phrase is the rarest evidence a skill can offer: df 0. Its
      // provenance is what the row reports as its evidence label.
      noteReason(skill.triggerSources?.[trig] === "heading" ? "heading" : "trigger");
    }
  }

  for (const kw of keywords) {
    const df = dfOf(kw);
    const occurrence = nameOccurrence(nameTokens, kw);
    // Exact token match in name: the skill's own identity vocabulary, never gated.
    if (occurrence === "token") {
      score += 3;
      signals++;
      nameHit = true;
      evidenceDf += df;
      noteReason("name");
      continue;
    }
    // Token-prefix match in name ("engine" in "software-engineer"): name
    // evidence, but only while the word is distinctive enough to mean it.
    if (occurrence === "prefix" && df < COMMON_KEYWORD_DF) {
      score += 2;
      signals++;
      nameHit = true;
      evidenceDf += df;
      noteReason("name");
      continue;
    }
    // Corpus-common keyword: the weak legs score nothing for it, so a prompt
    // full of generic vocabulary cannot buy a slot.
    if (df >= COMMON_KEYWORD_DF) continue;
    let weakHit = false;
    if (desc.includes(kw)) {
      score += 1;
      weakHit = true;
    }
    // File path matches (e.g. "research" in "research/SKILL.md")
    if (path.includes(kw)) {
      score += 1;
      weakHit = true;
    }
    // One signal per distinct keyword: a word present in both the description
    // and the path is one piece of evidence, not two.
    if (weakHit) {
      signals++;
      evidenceDf += df;
      noteReason("description");
    }
  }

  if (!nameHit && score < MIN_NON_NAME_SCORE) return NO_MATCH;
  return { score, signals, evidenceDf, reason };
}

/** The score alone (see matchSkill for the rules and the rarity gate). */
export function scoreSkill(
  skill: CachedSkill,
  keywords: string[],
  promptText?: string,
  keywordDf?: ReadonlyMap<string, number>,
): number {
  return matchSkill(skill, keywords, promptText, keywordDf).score;
}

/**
 * A skill with its match evidence, as the selection step consumes it. The
 * evidence fields are optional so a caller holding only a score still selects;
 * they then default to zero and the name stays the tie-breaker.
 */
export interface ScoredSkill {
  skill: CachedSkill;
  score: number;
  signals?: number;
  evidenceDf?: number;
}

/**
 * The ranking comparator, shared by the whisper's selection and the catalog
 * read: score, then breadth of match (distinct signals), then rarity of the
 * evidence (summed document frequency), then name. Pure.
 */
function compareScored(a: ScoredSkill, b: ScoredSkill): number {
  return (
    b.score - a.score ||
    (b.signals ?? 0) - (a.signals ?? 0) ||
    (a.evidenceDf ?? 0) - (b.evidenceDf ?? 0) ||
    a.skill.name.localeCompare(b.skill.name)
  );
}

/**
 * Decide which scored skills to suggest given the session injection state.
 *
 * Pure — mirrors the handler's decision path so it can be unit-tested:
 *   sort (score desc, distinct signals desc, evidence df asc, name asc) →
 *   cooldown filter (global floor + per-skill loaded extension) → slot budget
 *   over ACTIVE held slots (a loaded skill released its slot) → top-N slice.
 *
 * The rank order is the fix for alphabetical slot allocation: two skills with
 * equal points used to be ordered by name, so a broadly-matching skill took
 * the slot from one whose evidence was the prompt's actual subject. Distinct
 * signals separate breadth of match; evidence df separates a match on the
 * prompt's distinctive words from one on its filler.
 *
 * Returns the chosen scored items (empty when nothing qualifies). The
 * caller is responsible for recording the picks in session state.
 */
export function selectSuggestions(
  scored: ScoredSkill[],
  injected: InjectedSkill[],
  currentTurn: number,
): ScoredSkill[] {
  if (!scored.length) return [];

  const sorted = [...scored].sort(compareScored);

  const available = sorted.filter((s) => !onCooldown(s.skill.name, injected, currentTurn));
  if (!available.length) return [];

  // Active slots: not-yet-loaded injections. A loaded skill sits in the
  // agent's context — its slot is released for the next match.
  const active = injected.filter((i) => i.loadedTurn === undefined);
  const slotBudget = MAX_INJECTED - active.length;
  if (slotBudget <= 0) return [];

  return available.slice(0, slotBudget);
}

// Deterministic ranking for the catalog read

/**
 * Declared margin: a gap smaller than this between the first and second
 * qualified skill means the top is a coin flip, and the read says so
 * (`thin-margin`) instead of presenting the order as a decision. The number is
 * deliberate, not measured: one description keyword (+1) is exactly the
 * distance the scorer says is too weak to qualify a skill on its own
 * (MIN_NON_NAME_SCORE), so a lead that one extra weak hit could erase is not a
 * lead.
 */
export const RANK_MARGIN_THRESHOLD = 2;

/**
 * A task text shorter than this cannot carry a ranking signal: a greeting or a
 * two-word nudge names no domain, so the deterministic tier reports itself
 * short rather than confidently wrong.
 */
export const RANK_SHORT_TASK_CHARS = 24;

/** Why the deterministic tier answered the way it did. */
export type RankingBasis =
  | "no-task"
  | "short-task"
  | "no-score"
  | "unambiguous"
  | "tie"
  | "thin-margin";

/** One skill as the ranking read consumes it: match evidence plus its label. */
export interface RankedSkill {
  skill: CachedSkill;
  score: number;
  signals: number;
  evidenceDf: number;
  reason: RelevanceReason | null;
}

/** The deterministic tier's whole answer: an ordered list and a verdict on it. */
export interface DeterministicRanking {
  /** Qualified skills only, best first (the order the whisper ranks by). */
  ranked: RankedSkill[];
  /** True when the list cannot separate its own top — the escalation trigger. */
  ambiguous: boolean;
  basis: RankingBasis;
}

/**
 * Rank the catalog against a task text without a model. Pure given the cache.
 *
 * Ordering is the whisper's comparator (score, then distinct signals, then
 * summed evidence df, then name) so the two surfaces can never disagree about
 * which skill is better. `ambiguous` is the one thing the whisper does not
 * need: it decides every turn with slots and cooldowns, while a catalog read
 * shows the whole list and therefore must say when its own top is not decided
 * (a tie or a thin margin) or when the task text could not inform it at all.
 *
 * The verdict:
 *   no-task      — no task text at all; nothing to rank.
 *   short-task   — the text carries no significant keyword, or is shorter than
 *                  RANK_SHORT_TASK_CHARS: nothing here can rank a catalog.
 *   no-score     — every skill scored zero: unambiguous (nothing applies).
 *   tie          — the top two score the same: ambiguous.
 *   thin-margin  — the top two sit closer than RANK_MARGIN_THRESHOLD: ambiguous.
 *   unambiguous  — one skill leads the field by at least the margin.
 */
export function rankSkillsDeterministic(
  skills: CachedSkill[],
  taskText: string,
): DeterministicRanking {
  const text = (taskText ?? "").trim();
  if (!text) return { ranked: [], ambiguous: false, basis: "no-task" };
  const keywords = extractKeywords(text);
  const ranked: RankedSkill[] = [];
  if (keywords.length) {
    const keywordDf = corpusKeywordFrequency(keywords, skills);
    for (const skill of skills) {
      const match = matchSkill(skill, keywords, text, keywordDf);
      if (match.score <= 0) continue;
      ranked.push({
        skill,
        score: match.score,
        signals: match.signals,
        evidenceDf: match.evidenceDf,
        reason: match.reason,
      });
    }
  }
  ranked.sort(compareScored);
  if (text.length < RANK_SHORT_TASK_CHARS || !keywords.length) {
    return { ranked, ambiguous: true, basis: "short-task" };
  }
  if (!ranked.length) return { ranked, ambiguous: false, basis: "no-score" };
  if (ranked.length === 1) return { ranked, ambiguous: false, basis: "unambiguous" };
  const margin = ranked[0].score - ranked[1].score;
  if (margin === 0) return { ranked, ambiguous: true, basis: "tie" };
  if (margin < RANK_MARGIN_THRESHOLD) return { ranked, ambiguous: true, basis: "thin-margin" };
  return { ranked, ambiguous: false, basis: "unambiguous" };
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

// Applicability verdict (recorded, never enforced)

/**
 * Classify the catalog against this turn's task text and record what changed.
 *
 * Two writes, both append-only:
 *   - the session's census row, once, retried until it lands. It is what makes
 *     "not-applicable" derivable (evaluated minus the verdict rows) and what
 *     names the skills whose files state no condition at all.
 *   - one verdict row per skill whose declared condition held, and never twice
 *     for the same (session, skill): the set only grows because the verdict is
 *     per-session — a skill whose condition held on any turn applied to the
 *     session.
 *
 * The row shape is the joint the sibling compliance record expects: it joins on
 * (sessionId, skill) and adds its own `suggested`/`listed`/`read`/`applied`
 * beside this verdict, so `ignored / (read + ignored)` becomes computable. This
 * module writes no `applied` leg: a tool belong to a skill's family only once
 * the skill declares that family, and no skill does yet.
 *
 * Reads only — it never touches `injected`, a counter or a send. That is the
 * whole point of the ordering in before_agent_start: this step cannot move the
 * suggestion, and the suggestion cannot move the verdict.
 */
function stepApplicability(
  ctx: ExtensionContext,
  state: AutoInjectState,
  skills: CachedSkill[],
  prompt: string,
): void {
  const evaluation = evaluateApplicability(skills, prompt);
  const app = state.applicability;
  const fresh = evaluation.applicable.filter((verdict) => !app.verdicts.has(verdict.name));
  for (const verdict of fresh) app.verdicts.set(verdict.name, verdict);
  app.evaluated = evaluation.evaluated;
  app.undeclared = evaluation.undeclared;
  app.taskChars = prompt.length;

  if (!app.censusWritten) {
    const wrote = recordApplicabilityCensus(ctx, {
      taskChars: app.taskChars,
      evaluated: app.evaluated,
      undeclared: app.undeclared,
    });
    // A session without an id, or a refused store: retry on the next turn.
    if (wrote) app.censusWritten = true;
  }
  if (!fresh.length) return;
  log.debug(
    `[skills-auto-inject] applicability: ${fresh.length} newly applicable, ` +
      `${evaluation.evaluated} evaluated, ${evaluation.undeclared.length} undeclared`,
  );
  for (const verdict of fresh) {
    recordApplicabilityVerdict(ctx, {
      skill: verdict.name,
      applicability: verdict.verdict,
      evidence: verdict.evidence,
    });
  }
}

/**
 * Upgrade an applicable skill to `read` and append its verdict row. A read of a
 * skill whose declared condition never held gets no row: the three classes are
 * about skills that applied, and a read is not a fourth one.
 */
function markApplicabilityRead(ctx: ExtensionContext, state: AutoInjectState, name: string): void {
  const app = state.applicability;
  const held = app.verdicts.get(name);
  if (!held || held.verdict === "read") return;
  app.verdicts.set(name, { ...held, verdict: "read" });
  recordApplicabilityVerdict(ctx, {
    skill: name,
    applicability: "read",
    evidence: held.evidence,
  });
}

// Main Handler

/** The tool_result fields this module reads. */
interface ToolResultEvent {
  toolName?: string;
  isError?: boolean;
  input?: { path?: string };
  content?: Array<{ text?: string }>;
}

/**
 * Count a SKILL.md read (the list→read load path) and mark the matching
 * injection loaded (releases its slot and extends its cooldown: the skill is
 * in the agent's context now). Returns the skill name when the read was one,
 * so the caller can treat it as a skill surface.
 */
function detectSkillLoad(
  ev: ToolResultEvent,
  ctx: ExtensionContext,
  state: AutoInjectState,
): string | undefined {
  if (ev?.toolName !== "read") return undefined;
  // A failed read returns the error text, not the file — counting it
  // inflated `loaded` with phantom loads (the read-detector never saw
  // the skill content, and no SKILL.md was opened).
  if (ev.isError) return undefined;
  const text = (ev.content ?? []).map((c) => c.text ?? "").join("\n");
  const name = skillNameFromRead(ev.input?.path, text);
  if (!name) return undefined;
  const held = state.injected.find((i) => i.name === name && i.loadedTurn === undefined);
  if (held) held.loadedTurn = state.currentTurn;
  recordSkillLoad(ctx, name);
  // The load counters say a read happened; this says whether the session was
  // one where the skill applied. Independent writes, independent failures.
  markApplicabilityRead(ctx, state, name);
  log.debug(`[skills-auto-inject] counted actual load of "${name}" via read`);
  return name;
}

/**
 * Fire the drift line when the work has moved into a new work area (the rule
 * and its bounds live in loading-guidance.ts, beside the floor text the line
 * points at). The floor is the catalog against the prompt that was in view;
 * a session now reading and writing elsewhere has its catalog in the prompt
 * and its task text elsewhere, and one line re-points at it.
 *
 * Guarded like the floor section itself: without read and list_skills there is
 * no catalog in the prompt to point at, so nothing fires.
 */
function stepDrift(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: AutoInjectState,
  ev: ToolResultEvent,
): void {
  const target = advanceDrift(
    state.drift,
    driftDirectoryFor(ev?.toolName, ev?.input?.path, ctx.cwd ?? ""),
  );
  if (!target) return;
  const toolNames = new Set(pi.getAllTools().map((t) => t.name));
  if (!toolNames.has("read") || !toolNames.has("list_skills")) {
    recordDriftDrop(state.drift);
    return;
  }
  const delivered = sendTrackedMessage(
    pi,
    {
      customType: "skills-drift",
      content: [{ type: "text" as const, text: driftPayload(target, skillReadRoot(_skillsCache)) }],
      display: true,
      details: {
        [BRAID_INJECTED]: true,
        [BRAID_SOURCE]: "skills-auto-inject",
        directory: target,
      },
    },
    { delivery: "park", deliverAs: "steer" },
    { type: "context", source: "skills-auto-inject" },
    // The module's own budget is the bound (DRIFT_MAX_FIRES a session,
    // DRIFT_WINDOW_CALLS between fires), so a suppression cap must not drop
    // the line in a busy turn: that is exactly when the work is moving and
    // the floor's snapshot goes stale.
    { bypassFloodCap: true },
  );
  if (!delivered) {
    recordDriftDrop(state.drift);
    return;
  }
  recordDriftFire(state.drift, target);
  log.info(
    `[skills-auto-inject] drift line for ${target} (fire ${state.drift.fires}, call ${state.drift.calls})`,
  );
}

/**
 * Register the auto-inject handler on before_agent_start, the read-tool load
 * detector and the drift trigger on tool_result.
 *
 * Call this from the skills-tool extension factory, after registering
 * the list_skills tool.
 */
export function registerAutoInject(pi: ExtensionAPI): void {
  // Two jobs per tool result. The load detector runs first: a SKILL.md read
  // that just landed is a skill surface, and the drift guard must see it
  // before it decides whether to speak.
  pi.on("tool_result", (event: unknown, ctx: ExtensionContext) => {
    try {
      const ev = event as ToolResultEvent;
      const state = getState(ctx);
      if (detectSkillLoad(ev, ctx, state)) noteDriftSurface(state.drift);
      stepDrift(pi, ctx, state, ev);
    } catch {
      // best-effort — never break the tool loop over a counter or a whisper
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

      // Applicability is recorded BEFORE every scoring early-return below.
      // Most sessions match no skill, and those are exactly the sessions the
      // adoption counters cannot explain: the returns would erase them. The
      // step reads the catalog and the prompt only, so the suggestion decision
      // below is untouched by it (and its failure cannot cost a suggestion).
      try {
        stepApplicability(ctx, state, skills, prompt);
      } catch (err) {
        log.debug(`[skills-auto-inject] applicability step failed (best-effort): ${err}`);
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

      // Corpus-common words cannot tell skills apart. Their document frequency
      // is measured once per turn from the same cache the scorer reads.
      const keywordDf = corpusKeywordFrequency(keywords, skills);

      // Score each skill. The raw prompt rides along for trigger matching.
      const scored = skills
        .map((s) => ({ skill: s, ...matchSkill(s, keywords, prompt, keywordDf) }))
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

      // A delivered suggestion is a skill surface: the drift trigger stays
      // quiet for its window, because the pointer the trigger exists to
      // supply has just landed.
      noteDriftSurface(state.drift);

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
