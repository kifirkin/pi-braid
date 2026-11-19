/**
 * The skills ranker: of the installed skills, which ones apply to the task the
 * agent is about to start — decided by a utility-model call.
 *
 * The decision this replaces read trigger phrases authored in one language and
 * tested them as word-bounded occurrences in the prompt. That is a structural
 * zero for a task written in any other script: a phrase table carries no
 * Cyrillic, so a Russian prompt cannot fire a skill by construction, whatever
 * the catalog says. The failure is not a weak heuristic to tune; it is a string
 * table deciding relevance in a language it was not written in. Ranking a task
 * against a catalog is judgement, so it moves to the model the house already
 * keeps for small judgement calls, and nothing here reads a phrase.
 *
 * Cost is the reason this module is shaped the way it is. The whisper is
 * computed inside `before_agent_start`, so the call sits in front of the turn:
 * one call per turn at most, none for a prompt too short to name work, and the
 * session's own answer for a repeated prompt served from memory. A failure
 * produces silence and one recorded reason, never a phrase match: a guess made
 * by a heuristic the owner asked to delete is worse than no suggestion.
 *
 * Every input is text the caller already holds (the prompt, the cached catalog
 * rows), so the module reads no file and touches no delivery path. It returns
 * an answer and records its own counters; the caller decides what to send.
 */

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { resolveUtilityModel, tryModelChain } from "../../../lib/ai/model-resolver.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { extractJson } from "../../../lib/utils/extract-json.js";

const log = createLogger("skills-ranker");

/**
 * Characters of the task text sent to the model. A prompt past this is cut, not
 * summarised: the opening of a task names its work, and a summariser here would
 * be a second model call paying for the first one's context.
 */
export const RANKER_PROMPT_CHARS = 2_000;

/**
 * Shortest task text worth a call. "continue", "yes", "fix it" name no domain,
 * so a model asked to rank them can only answer from the turn's history — which
 * it does not receive — and the call would be spent to learn nothing.
 */
export const RANKER_MIN_PROMPT_CHARS = 40;

/** Entries the model may return. The whisper has two slots; the third is the tie. */
export const RANKER_LIMIT = 3;

/** Characters of one catalog row's description: the first sentence, cut here if it runs. */
export const RANKER_DESCRIPTION_CHARS = 200;

/** Characters of one `why`: a clause, not a paragraph. Longer answers are cut. */
export const RANKER_WHY_CHARS = 200;

/**
 * Hard ceiling on the call, in ms.
 *
 * The call blocks the turn it exists to inform, so the ceiling is small on
 * purpose and there is no retry ladder behind it (`maxRetries: 0`): a retried
 * ladder would turn one slow provider into a turn that starts seconds late, and
 * a turn-start hook has nothing to show for the wait. The cache is what pays for
 * the repeat, not a second attempt.
 */
export const RANKER_TIMEOUT_MS = 10_000;

/** Prompts the session keeps an answer for, oldest evicted first. */
export const RANKER_CACHE_ENTRIES = 8;

/** Output tokens the answer needs: at most three short entries. */
const RANKER_MAX_TOKENS = 400;

/**
 * The system prompt. Two sentences carry the contract: the task may be written
 * in any language (so never decide by word occurrence), and `[]` is a correct
 * answer (so the model is not pushed to name something).
 */
export const RANKER_SYSTEM_PROMPT =
  "You rank an installed skill catalog against the task a user just gave a " +
  "coding agent.\n" +
  "The task may be written in any language. Judge what the task asks for, " +
  "never whether its words occur in a skill's text, and never the language " +
  "it is written in.\n" +
  "Answer with a JSON array and nothing else: at most three entries, each " +
  '{"name": "<exact name from the catalog>", "why": "<one clause naming what ' +
  'in the task makes this skill apply>"}, best first. Answer [] when no ' +
  "catalog entry applies: an empty answer is a correct answer, and a wrong " +
  "skill costs the agent a read it did not need.";

/** The catalog row the ranker reads: a name and the description beside it. */
export interface RankerSkill {
  name: string;
  description?: string;
}

/** One ranked row: a catalog name and the clause the model gave for it. */
export interface RankedEntry {
  name: string;
  why: string;
}

/**
 * Why the answer is what it is.
 *
 *   model       a call was made and named at least one skill
 *   empty       a call was made and the catalog answered `[]`
 *   cached      the session already had this prompt's answer; no call
 *   short       the task text is too short to rank; no call
 *   failed      a call was attempted and produced no answer; no suggestion
 */
export type RankerBasis = "model" | "empty" | "cached" | "short" | "failed";

/** The ranker's answer for one turn. */
export interface RankerAnswer {
  rows: RankedEntry[];
  basis: RankerBasis;
  /** Why there is no answer; present only for `failed`. */
  reason?: string;
}

/**
 * The ranker's counters, session-scoped.
 *
 * `ranked` counts calls attempted (a timeout is a call), `rankedCached` the
 * turns answered from memory, `rankedFailed` the turns that produced silence
 * because the call, the model or the answer was unusable. The three numbers
 * separate "the ranker is silent because nothing applies" from "the ranker is
 * silent because it is broken", which is the difference a reader cannot see in
 * the suggestion count alone.
 */
export interface RankerStats {
  ranked: number;
  rankedCached: number;
  rankedFailed: number;
  /** The most recent failure's reason, kept for `skill_stats`; null until one lands. */
  lastFailure: string | null;
}

interface RankerState {
  stats: RankerStats;
  /** This session's answers by prompt hash, insertion-ordered for eviction. */
  cache: Map<string, RankedEntry[]>;
}

const STATE_KEY = "skills-ranker";

function getState(ctx: ExtensionContext): RankerState {
  return getExtensionState(ctx, STATE_KEY, () => ({
    stats: { ranked: 0, rankedCached: 0, rankedFailed: 0, lastFailure: null },
    cache: new Map<string, RankedEntry[]>(),
  }));
}

/** The session's ranker counters, as `skill_stats` reports them. */
export function getRankerStats(ctx: ExtensionContext): RankerStats {
  return { ...getState(ctx).stats };
}

/**
 * The first sentence of a description, collapsed to one line and bounded.
 *
 * A catalog row is a name and the first thing its author said about the skill:
 * the rest of a long description is the body's business, and paying for it on
 * every turn is what makes a catalog prompt cost more than the whisper saves.
 * Pure.
 */
export function firstSentence(
  text: string | undefined,
  maxChars: number = RANKER_DESCRIPTION_CHARS,
): string {
  const flattened = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flattened) return "";
  const cut = flattened.search(/[.!?](\s|$)/);
  const sentence = cut < 0 ? flattened : flattened.slice(0, cut + 1);
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1).trimEnd()}…` : sentence;
}

/** The catalog block: one row per skill, `name — first sentence`. Pure. */
export function buildCatalogRows(skills: readonly RankerSkill[]): string {
  return skills
    .map((skill) => {
      const sentence = firstSentence(skill.description);
      return sentence ? `- ${skill.name} — ${sentence}` : `- ${skill.name}`;
    })
    .join("\n");
}

/** The user message: the catalog, then the task. Pure. */
export function buildRankerPrompt(prompt: string, skills: readonly RankerSkill[]): string {
  const text = (prompt ?? "").trim();
  const cut = text.length > RANKER_PROMPT_CHARS ? `${text.slice(0, RANKER_PROMPT_CHARS)}…` : text;
  return `Catalog (name — description):\n${buildCatalogRows(skills)}\n\nTask:\n${cut}`;
}

/** The session's cache key for one task text. Pure. */
export function promptKey(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 32);
}

/**
 * Parse the model's answer against the catalog it was given.
 *
 * Strict by construction, because every repair is a guess: the answer must be a
 * JSON array; each entry an object carrying a non-empty `name` in the catalog
 * and a non-empty `why`; at most RANKER_LIMIT entries. One bad entry fails the
 * whole answer rather than salvaging the rows around it — a model that invented
 * a skill is a model whose other rows are not trusted either, and a partially
 * trusted answer is exactly the silent compromise this seam exists to end.
 *
 * `[]` is a valid answer: the ranker said nothing applies. Pure.
 */
export function parseRankerAnswer(
  text: string,
  catalog: readonly RankerSkill[],
): { rows: RankedEntry[] } | { error: string } {
  const json = extractJson(text ?? "");
  if (json === null) return { error: "answer carries no JSON" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "answer is not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { error: "answer is not a JSON array" };
  if (parsed.length > RANKER_LIMIT) {
    return { error: `${parsed.length} entries, the contract allows ${RANKER_LIMIT}` };
  }
  const canonical = new Map(catalog.map((skill) => [skill.name.trim().toLowerCase(), skill.name]));
  const rows: RankedEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.length; index++) {
    const entry = parsed[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: `entry ${index} is not an object` };
    }
    const record = entry as { name?: unknown; why?: unknown };
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const why = typeof record.why === "string" ? record.why.replace(/\s+/g, " ").trim() : "";
    if (!name) return { error: `entry ${index} carries no name` };
    if (!why) return { error: `entry ${index} carries no why` };
    // The model's capitalization is typographic, not a different skill: the
    // lookup folds case and trims, and a name the catalog does not carry is an
    // invented row, which fails the answer.
    const resolved = canonical.get(name.toLowerCase());
    if (!resolved) return { error: `entry ${index} names an unknown skill "${name}"` };
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    rows.push({
      name: resolved,
      why: why.length > RANKER_WHY_CHARS ? why.slice(0, RANKER_WHY_CHARS) : why,
    });
  }
  return { rows };
}

/**
 * Rank the cached catalog against one task text.
 *
 * The order of the checks is the cost order: the prompt is checked for length
 * before the cache and the cache before the model, so a turn pays the least it
 * can. Silences are answers, not errors: a short prompt and a repeated prompt
 * return no rows and record no failure, while a call that produced nothing
 * records its reason in the log and in `rankedFailed`.
 */
export async function rankSkills(
  ctx: ExtensionContext,
  prompt: string,
  skills: readonly RankerSkill[],
): Promise<RankerAnswer> {
  const text = (prompt ?? "").trim();
  if (!text || !skills.length) return { rows: [], basis: "short" };
  if (text.length < RANKER_MIN_PROMPT_CHARS) return { rows: [], basis: "short" };

  const state = getState(ctx);
  const key = promptKey(text);
  const cached = state.cache.get(key);
  if (cached) {
    state.stats.rankedCached++;
    return { rows: cached, basis: "cached" };
  }

  const fail = (reason: string): RankerAnswer => {
    state.stats.rankedFailed++;
    state.stats.lastFailure = reason;
    log.info(`no skill suggestion: ${reason}`);
    return { rows: [], basis: "failed", reason };
  };

  // The model is resolved before the call so its absence is a named reason
  // rather than a chain error the reader has to decode. A context with no
  // registry is a failure like any other: the turn still runs, and the reason
  // is recorded rather than thrown out of a turn-start hook.
  let configured: boolean;
  try {
    configured = resolveUtilityModel(ctx) !== undefined;
  } catch (err) {
    return fail(`model registry unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!configured) return fail("no utility model configured");

  state.stats.ranked++;
  let result: Awaited<ReturnType<typeof tryModelChain>>;
  try {
    result = await tryModelChain(
      ctx,
      [() => resolveUtilityModel(ctx)],
      RANKER_SYSTEM_PROMPT,
      buildRankerPrompt(text, skills),
      {
        temperature: 0,
        maxTokens: RANKER_MAX_TOKENS,
        // A reasoning pass would spend the output budget on thinking before it
        // reaches the answer, and the answer is three short rows.
        reasoning: "off",
        timeoutMs: RANKER_TIMEOUT_MS,
        maxRetries: 0,
        sdkRetries: 0,
      },
    );
  } catch (err) {
    return fail(`call threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ("error" in result) return fail(result.error);

  const parsed = parseRankerAnswer(result.text, skills);
  if ("error" in parsed) return fail(parsed.error);

  if (state.cache.size >= RANKER_CACHE_ENTRIES) {
    const oldest = state.cache.keys().next();
    if (!oldest.done) state.cache.delete(oldest.value);
  }
  state.cache.set(key, parsed.rows);
  return { rows: parsed.rows, basis: parsed.rows.length ? "model" : "empty" };
}
