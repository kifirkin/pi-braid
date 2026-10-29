/**
 * Skill applicability — did a skill's own declared condition hold for the task?
 *
 * The suggestion whisper, the catalog ranking and the adoption counters all
 * answer "might this skill help?". None answers the question the counters
 * cannot: of the sessions that read nothing, which of them had a skill whose
 * stated condition the task text actually met? A suggestion that was ignored
 * and a skill that never applied looked identical in `suggested`/`loaded`.
 * This module decides that difference and keeps its evidence.
 *
 * The condition is the skill's OWN declaration, never a heuristic invented
 * here: the trigger phrases its file declares — frontmatter `trigger:` /
 * `triggers:`, a `## trigger:` body heading, the description's `Triggers:`
 * tail — the same entries `skill-triggers.ts` reads and the same provenance
 * labels it records. The shipped pack's contract already treats that list as
 * the machine-readable form of applicability ("a description that cannot fire
 * is indistinguishable from one that fires"), so a skill file needs no new
 * field for this module to see it. A file that declares no phrase yields no
 * verdict at all; the caller reports it as undeclared rather than asserting
 * "does not apply" on no evidence.
 *
 * Matching mirrors the injector on purpose. The occurrence boundary is the one
 * `triggerMatches` uses (a phrase occurs where neither neighbour is a letter or
 * digit, so "pane" is not an occurrence in "paneled"), because a verdict that
 * disagreed with the whisper would be worse than no verdict: the suite pins
 * the two answers equal over the installed catalog. What this module adds is
 * polarity — a phrase inside a negated clause ("do not research this") is not
 * the author's condition holding, so the clause is read and the phrase is
 * dropped as evidence.
 *
 * What this module does NOT do: it decides nothing about delivery, slots,
 * cooldowns, counters or ranking. It returns a classification and the caller
 * records it. Nothing here reads the session, writes a file or sends a
 * message.
 *
 * Cost: one pass over the task text per phrase of the cached catalog, with the
 * native substring scan as the cheap reject before any boundary work. The
 * caller holds the prompt in memory already (the injector matches against the
 * same string), so no I/O is added per turn.
 */

import type { TriggerSource } from "./skill-triggers.js";

/**
 * A skill as the applicability read consumes it: its name and the phrase list
 * the cache resolved from its file. `triggers` and `triggerSources` are the
 * fields `setCachedSkills` fills, so this read never touches the disk — the
 * phrases and their provenance are the ones the injector matched against.
 */
export interface ConditionalSkill {
  name: string;
  /** Authored phrases (lowercased, deduped, capped) — empty when the file declares none. */
  triggers?: string[];
  /** Which authored source declared each phrase. */
  triggerSources?: Record<string, TriggerSource>;
}

/** One authored phrase that matched, with the place in the file that declares it. */
export interface ApplicabilityEvidence {
  /** The authored phrase, as the reader normalized it. */
  phrase: string;
  /**
   * frontmatter | heading | description — absent only when the cached skill
   * carried no provenance map (an unenriched cache, never a production one).
   */
  source?: TriggerSource;
}

/**
 * One skill's verdict for a session.
 *
 * `ignored` is the evaluation's answer: the declared condition held and no
 * detected read followed. `read` is the read-detector's upgrade of the same
 * row. The third class, not-applicable, is never a row — it is a skill that
 * declared a condition and did not meet the task text, so a reader derives it
 * from the record's census (`evaluated` minus the verdict rows).
 */
export interface SkillApplicabilityVerdict {
  name: string;
  verdict: "read" | "ignored";
  evidence: ApplicabilityEvidence[];
}

/** Max evidence rows carried per skill: enough to review, bounded like every other surface. */
export const MAX_APPLICABILITY_EVIDENCE = 4;

/**
 * Word tokens a negation cue may sit before the phrase and still negate it.
 * "do not research this" (0) and "no need to research" (2) are negated;
 * "do not stop, then research it later" puts the cue past the clauseless
 * distance and reads as the assertion it is. Four is the smallest window that
 * covers the "no need to"/"there is no reason to" shapes without reaching
 * across a clause.
 */
export const NEGATION_GAP_TOKENS = 4;

/**
 * Negation cues, matched in the clause text BEFORE a phrase. The `-n't`
 * alternative is spelled out rather than listed per verb so a contraction the
 * list forgot ("won't", "shouldn't") still counts.
 */
const NEGATION_CUE =
  /\b(?:not|never|no|nor|without|avoid|avoiding|skip|skipping)\b|\b[a-z]+n['\u2019]t\b/gi;

/** True when `char` continues a word (the boundary rule `triggerMatches` uses). */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

/**
 * Every index in `lowered` where `phrase` occurs as a whole phrase, using the
 * matcher's boundary rule: neither neighbour may be a letter or digit. Phrase
 * must already be lowercase. Pure.
 */
export function phraseOccurrences(phrase: string, lowered: string): number[] {
  if (!phrase) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = lowered.indexOf(phrase, from);
    if (at < 0) break;
    if (!isWordChar(lowered[at - 1]) && !isWordChar(lowered[at + phrase.length])) out.push(at);
    from = at + 1;
  }
  return out;
}

/**
 * Index where the clause containing `at` begins: after the nearest sentence
 * terminator. A clause boundary is what stops a negation in one statement from
 * reaching a phrase in the next ("do not use the catalog; research the topic"
 * asserts research). Pure.
 */
export function clauseStart(lowered: string, at: number): number {
  for (let i = at - 1; i >= 0; i--) {
    const char = lowered[i];
    if (char === "." || char === "!" || char === "?" || char === ";" || char === "\n") return i + 1;
  }
  return 0;
}

/**
 * True when the clause text preceding a phrase carries a negation cue close
 * enough to negate it. The LAST cue decides, so "not only did we not ask" is
 * read by its nearest cue rather than its first. Pure.
 */
export function isNegatedPrefix(prefix: string): boolean {
  const cue = new RegExp(NEGATION_CUE.source, "gi");
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = cue.exec(prefix))) last = match;
  if (!last) return false;
  const gap = prefix.slice(last.index + last[0].length);
  return (gap.match(/[a-z0-9]+/g) ?? []).length <= NEGATION_GAP_TOKENS;
}

/**
 * The evidence for one skill's declared condition holding on `taskText`.
 *
 * A phrase is evidence when at least one of its occurrences is asserted:
 * negating one occurrence does not erase another ("do not skip research" and
 * "research this" in the same text both count). Phrases are evidence at most
 * MAX_APPLICABILITY_EVIDENCE times per skill, in authored order. An empty
 * return means the condition did not hold. Pure.
 */
export function skillApplicability(
  skill: ConditionalSkill,
  taskText: string,
): ApplicabilityEvidence[] {
  const lowered = taskText.toLowerCase();
  const evidence: ApplicabilityEvidence[] = [];
  for (const authored of skill.triggers ?? []) {
    if (evidence.length >= MAX_APPLICABILITY_EVIDENCE) break;
    const phrase = authored.toLowerCase();
    // Cheap reject first: most phrases are absent from most prompts.
    if (!phrase || !lowered.includes(phrase)) continue;
    const asserted = phraseOccurrences(phrase, lowered).some(
      (at) => !isNegatedPrefix(lowered.slice(clauseStart(lowered, at), at)),
    );
    if (!asserted) continue;
    const source = skill.triggerSources?.[authored] ?? skill.triggerSources?.[phrase];
    evidence.push(source ? { phrase, source } : { phrase });
  }
  return evidence;
}

/** The whole catalog's answer for one task text. */
export interface ApplicabilityEvaluation {
  /** Skills whose declared condition held, each still an `ignored` verdict. */
  applicable: SkillApplicabilityVerdict[];
  /** Installed skills that declare at least one condition phrase. */
  evaluated: number;
  /** Installed skills that declare none — no condition, so no verdict either way. */
  undeclared: string[];
}

/**
 * Classify every installed skill against one task text. Pure: the catalog
 * arrives as the cache already resolved it, and the text is the prompt the
 * injector matched against.
 */
export function evaluateApplicability(
  skills: ConditionalSkill[],
  taskText: string,
): ApplicabilityEvaluation {
  const applicable: SkillApplicabilityVerdict[] = [];
  const undeclared: string[] = [];
  let evaluated = 0;
  const text = taskText ?? "";
  for (const skill of skills) {
    if (!skill.triggers?.length) {
      undeclared.push(skill.name);
      continue;
    }
    evaluated++;
    const evidence = skillApplicability(skill, text);
    if (evidence.length) applicable.push({ name: skill.name, verdict: "ignored", evidence });
  }
  return { applicable, evaluated, undeclared };
}
