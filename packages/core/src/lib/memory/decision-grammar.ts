/**
 * Decision grammar: the generic half of the ruling write path.
 *
 * One body of text in, either the standing instruction it carries or `null`.
 * "Generic" is a claim about what the module is allowed to know: sentence
 * spans, the marker table that turns a sentence into a standing instruction,
 * the shapes that are not instructions (a question, a status report, a paste, a
 * hedge, a conversational aside), and the first- and second-person grammar of
 * English. It knows nothing about who wrote the text, which channel carried it,
 * or what the caller's world is made of.
 *
 * The last of those is the one thing a grammar cannot supply, so the caller
 * hands it in as `GrammarVocabulary`: which words name a subject a ruling can be
 * about, which words describe the caller's own machinery, and how an explicit
 * generalization reads. `classifyRulingBody()` applies those three tests at the
 * same two places it applies its own - the turn and the sentence that gets
 * quoted - so a directive aimed at the reader is told apart from a rule about
 * the system by vocabulary this layer never spells.
 *
 * The second half of the module is the store side of the same write path:
 * `deriveTopicTags()` reads a quote and the population it is filed into and
 * returns the words worth carrying as tags. The rule reasons about tokens,
 * document frequency and a generic English stop list, so it belongs next to the
 * grammar rather than in the caller's vocabulary.
 *
 * Pure by construction: no I/O, no clock, no randomness, so its behaviour is a
 * fixture instead of a story.
 */

import { QUERY_STOP_WORDS } from "./constants.js";

/** The closed set of ruling shapes the classifier can name. */
export type RulingClass = "prohibition" | "preference" | "requirement" | "policy";

/** A classified body: what kind of instruction it is, and the words to keep. */
export interface RulingShape {
  class: RulingClass;
  /** A contiguous, verbatim slice of the body, capped with a trailing ellipsis. */
  quote: string;
}

/**
 * The three questions a grammar has to ask the caller's world.
 *
 * `namesSubject` is the escape hatch for a bare directive: "Do not read or
 * write files." names no system, so without first person it is an instruction
 * aimed at the reader, not a rule about anything. `talksProcess` refuses a body
 * whose subject is the caller's own machinery rather than the thing a ruling is
 * about, and `generalizes` admits a second-person body that says it speaks to
 * every recipient ("any instance", "generically"), which is a rule rather than
 * a steer.
 */
export interface GrammarVocabulary {
  namesSubject(text: string): boolean;
  talksProcess(text: string): boolean;
  generalizes(text: string): boolean;
}

/** Longest quote the caller receives; past this the quote is cut, not summarized. */
export const QUOTE_LIMIT = 400;

/**
 * A body longer than this is a pasted brief, a log or a tool dump, not the
 * sentence an owner states a ruling in. The quote is capped at QUOTE_LIMIT
 * anyway, so a long body can only contribute a fragment whose subject was three
 * paragraphs earlier.
 */
const MAX_TURN_CHARS = 1200;

/** Below this a body is an acknowledgement ("ok", "proceed"), never a ruling. */
const MIN_TURN_WORDS = 3;

/** A continuation sentence is kept only while the quote stays short enough to read. */
const CONTINUATION_LIMIT = 200;

/** The owner's own voice: first person, singular or collective. */
const FIRST_PERSON = /\b(?:i|i'm|i've|i'll|i'd|we|we're|we've|we'll|we'd|my|our|ours|let's)\b/i;

/**
 * Second-person address. A directive written to *you* is an instruction for
 * the reader; a rule for the system talks about it, or generalizes explicitly.
 */
const SECOND_PERSON = /\b(?:you|your|yours|yourself|yourselves)\b/i;

/**
 * First-person report voice: the speaker narrating what was seen, changed or
 * disabled. Such a sentence can carry "always" or "no longer" by accident ("I
 * still see only ...", "it no longer indexed"), so it is refused unless it opens
 * with a directive.
 */
const REPORT_VOICE =
  /\b(?:i|we)\b[^.!?]{0,120}\b(?:noticed|noticing|see|saw|seen|disabled|enabled|changed|updated|merged|pushed|committed|created|deleted|found|think|thought|guess|believe|realised|realized|checked|ran|built|fixed|added|removed|renamed|replaced|read|told|said|mentioned)\b/i;

/**
 * Conversational openers that carry no decision: thinking aloud. A marker
 * inside one of these ("doesn't really matter") is not a ruling.
 */
const CONVERSATIONAL =
  /^\s*(?:or i don'?t know|i don'?t know|not sure|doesn'?t really matter|whatever|never mind|nevermind)\b/i;

/** A body that reads as a report of work already done, on its first line. */
const STATUS_OPENER =
  /^(?:done|finished|merged|shipped|pushed|committed|built|fixed|updated|completed|released|deployed|landed|green|all (?:tests|gates|checks)|tests? (?:pass|green)|gates? (?:pass|green))/i;

/**
 * Hedged advice: the shape of a recommendation that was floated and not
 * adopted. `should` and `could` are deliberately absent from the durable
 * marker table below - they are how advice is phrased, not how a ruling is
 * stated - so a hedged sentence has to be refused explicitly.
 */
const HEDGE =
  /\b(?:maybe|perhaps|might|could|would|possibly|probably|consider|i think|i guess|not sure|unsure|what if|why not|we should probably)\b/i;

/**
 * Absolute frames that make a hedged sentence a ruling anyway: "maybe we should
 * never post through an API" has still ruled, while "we could consider APIs"
 * has not.
 */
const ABSOLUTE =
  /\b(?:never|must|always|only one|required|mandatory|forbidden|banned|not allowed|by default|from now on|going forward)\b/i;

/**
 * Opening words that make a sentence a question, used only together with a
 * question mark: the mark alone is enough at the end of a body, but a body that
 * opens with a question and closes with a ruling keeps its ruling.
 */
const INTERROGATIVE_OPENER = /^\s*(?:how|what|why|when|where|which|who|whose|whether)\b/i;

const QUESTION_OPENER =
  /^(?:should|shall|can|could|may|might|do|does|did|is|are|was|were|will|would|have|has|how|what|why|when|where|which|who|whose|am|if)\b/i;

/**
 * Decision frames, in class-priority order. A frame is the grammar of a
 * standing instruction rather than of this turn's work: an absolute (`never`,
 * `always`, `must`, `only one`), a comparison between ways of doing something
 * (`prefer`, `instead of`, `rather than`, `better than`), or a prescription
 * stated in the collective voice (`we need to`, `should`). Bare imperatives are
 * deliberately absent: "investigate X" is a task for this turn, and a table
 * built from every imperative is a task list filed as policy.
 */
const MARKERS: ReadonlyArray<{ class: RulingClass; pattern: RegExp }> = [
  {
    class: "prohibition",
    pattern:
      /\b(?:never|don't|do not|must not|may not|not allowed|forbidden|banned|no longer|stop (?:using|doing|running|adding|writing|posting|editing|treating))\b/i,
  },
  {
    class: "preference",
    pattern: /\b(?:prefer|preferably|instead of|rather than|better than|avoid)\b/i,
  },
  {
    class: "requirement",
    pattern: /\b(?:must|should|always|required|mandatory|only one|need(?:s)? to|have to|has to)\b/i,
  },
  {
    class: "policy",
    pattern:
      /\b(?:by default|default is|from now on|going forward|rule is|policy|standard|convention|principle)\b/i,
  },
];

/** A sentence span over the original text; every quote is a slice of one. */
interface Span {
  start: number;
  end: number;
}

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|resp|no|dr|mr|mrs|ms|st)\.$/i;

/**
 * Split a body into contiguous sentence spans.
 *
 * The spans are offsets into the original string, so a quote assembled from
 * them is a byte-for-byte slice of the words - the property the pointer check
 * leans on. Newlines end a sentence; a period does not end one inside a known
 * abbreviation, a number (`3.5`), or a path (`decision-grammar.ts`).
 */
function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  const push = (end: number): void => {
    if (end > start) {
      const slice = text.slice(start, end);
      if (slice.trim()) spans.push({ start, end });
    }
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      push(i);
      continue;
    }
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (ch === "." && ABBREVIATION.test(text.slice(Math.max(0, i - 12), i + 1))) continue;
    if (ch === "." && /\d$/.test(text[i - 1] ?? "") && /^\d/.test(next ?? "")) continue;
    push(i + 1);
  }
  push(text.length);
  return spans;
}

/** Words in a string, counted the way a reader would. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Is the body a paste - a shell transcript, a code block, a log or a payload?
 *
 * A pasted command is the single most common false ruling: it carries
 * imperatives ("rm -rf"), digits, and often the word "only". The screens are
 * cheap because a ruling sentence is prose, and prose does not start every line
 * with a prompt, a box, or a stack frame.
 */
function looksPasted(text: string): boolean {
  if (text.includes("```")) return true;
  if (/^\s*[{[]/.test(text)) return true;
  if (/^\s*(?:\$|%|> |#!)\s/m.test(text)) return true;
  if (/(?:^|\n)\s*(?:[│├└─]|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/m.test(text)) return true;
  if (/Traceback \(most recent call last\)|\bat [\w$.]+ \([\w/.-]+:\d+:\d+\)/.test(text))
    return true;
  const lines = text.split("\n").filter((line) => line.trim());
  const commandLines = lines.filter((line) =>
    /^\s*(?:sudo |git |npm |npx |node |python3? |cd |ls |cat |rg |grep |curl |chmod |brew |make |docker |kubectl |export |rm )/.test(
      line,
    ),
  );
  if (commandLines.length >= 2) return true;
  // A payload of paths and key=value rows, with almost no sentence structure.
  if (lines.length >= 6 && lines.every((line) => line.length < 200)) {
    const payloadish = lines.filter((line) => /^[\w./-]{2,}\s*[:=]\s*\S/.test(line));
    if (payloadish.length >= lines.length / 2) return true;
  }
  return false;
}

/** Does the body end in a question, or open with one and carry nothing after it? */
function isQuestionShaped(text: string, spans: Span[]): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith("?")) return true;
  const first = spans[0] ? text.slice(spans[0].start, spans[0].end).trim() : "";
  return QUESTION_OPENER.test(first) && first.includes("?") && spans.length === 1;
}

/**
 * The class a sentence marks, or `null` when it marks no standing instruction.
 * First match in table order wins, so "must never" reads as a prohibition and
 * "always prefer" as a preference.
 */
function markerClass(sentence: string): RulingClass | null {
  for (const { class: kind, pattern } of MARKERS) {
    if (pattern.test(sentence)) return kind;
  }
  return null;
}

/**
 * Assemble the quote: the sentence that carries the marker, plus its immediate
 * continuation while that stays short. Contiguous, never reordered, never
 * stitched from two places in the body.
 */
function quoteFrom(text: string, spans: Span[], markerIndex: number): string {
  let end = spans[markerIndex].end;
  const next = spans[markerIndex + 1];
  if (next) {
    const candidate = text.slice(spans[markerIndex].start, next.end);
    if (candidate.length <= CONTINUATION_LIMIT) end = next.end;
  }
  const quote = text.slice(spans[markerIndex].start, end).trim();
  if (quote.length <= QUOTE_LIMIT) return quote;
  return `${quote.slice(0, QUOTE_LIMIT).trimEnd()}...`;
}

/**
 * Classify one body that is already known to be owner speech.
 *
 * Returns `null` for everything that is not a standing instruction: a question,
 * a paste, a status report, a hedged recommendation, an acknowledgement, a
 * second-person directive, or a body too long to cut a self-contained sentence
 * from. Returns the class and the verbatim quote otherwise. The caller owns the
 * provenance fields, because the caller is the one that knows where the text
 * came from.
 */
export function classifyRulingBody(
  text: string,
  vocabulary: GrammarVocabulary,
): RulingShape | null {
  if (typeof text !== "string") return null;
  const body = text.trim();
  if (!body) return null;
  if (wordCount(body) < MIN_TURN_WORDS) return null;
  if (body.length > MAX_TURN_CHARS) return null;
  if (looksPasted(body)) return null;

  const spans = sentenceSpans(body);
  if (spans.length === 0) return null;
  if (isQuestionShaped(body, spans)) return null;

  const firstSentence = body.slice(spans[0].start, spans[0].end).trim();
  if (STATUS_OPENER.test(firstSentence)) return null;
  if (INTERROGATIVE_OPENER.test(firstSentence)) return null;

  const firstPerson = FIRST_PERSON.test(body);
  if (SECOND_PERSON.test(body) && !vocabulary.generalizes(body)) return null;
  if (!firstPerson && !vocabulary.namesSubject(body)) return null;
  if (!firstPerson && vocabulary.talksProcess(body)) return null;

  for (let index = 0; index < spans.length; index++) {
    const sentence = body.slice(spans[index].start, spans[index].end).trim();
    const kind = markerClass(sentence);
    if (!kind) continue;
    if (STATUS_OPENER.test(sentence)) continue;
    if (CONVERSATIONAL.test(sentence)) continue;
    if (sentence.includes("?")) continue;
    if (SECOND_PERSON.test(sentence) && !vocabulary.generalizes(sentence)) continue;
    // The same voice test the body passed, applied to the sentence that will
    // be quoted: a bare directive lifted out of a longer message is an
    // instruction for the reader, not a decision about the system.
    const sentenceFirstPerson = FIRST_PERSON.test(sentence);
    if (!sentenceFirstPerson && !vocabulary.namesSubject(sentence)) continue;
    if (!sentenceFirstPerson && vocabulary.talksProcess(sentence)) continue;
    if (
      REPORT_VOICE.test(sentence) &&
      !/^\s*(?:never|always|prefer|must not|by default|from now on)/i.test(sentence)
    ) {
      continue;
    }
    if (HEDGE.test(sentence) && !ABSOLUTE.test(sentence)) continue;
    const quote = quoteFrom(body, spans, index);
    if (!quote) continue;
    return { class: kind, quote };
  }
  return null;
}

// ── Tag derivation ──────────────────────────────────────────────────────────

/** How many tags a ruling carries. */
export const TAG_LIMIT = 3;

/** Shortest token a tag may be cut from. */
const TAG_TOKEN_MIN_LENGTH = 4;

/**
 * The share of the population past which a token names nothing. A word a
 * quarter of the store already carries is the store's background, not a topic:
 * it would fire on every query and add nothing a reader could act on.
 */
const TAG_POPULATION_SHARE = 0.25;

/** Tokens a tag may be cut from: letters, then letters/digits/hyphens. */
const TAG_TOKEN = /[a-z][a-z0-9-]{3,}/g;

/**
 * The population a quote is filed into, as the frequency test sees it:
 * how many documents it holds, and how many of them carry a token.
 */
export interface TagPopulation {
  /** Documents in the population. */
  total: number;
  /** Documents carrying `token`. */
  count(token: string): number;
}

/**
 * The tags a quote earns from the population it is filed into.
 *
 * Take the quote's tokens of four characters or more, drop the read path's stop
 * words, drop any token more than a quarter of the population carries, and keep
 * the three the population carries most, ties by first occurrence.
 *
 * The ranking is by frequency and not by rarity, and the reason is the read
 * path's own arithmetic: a tag's bonus is a flat constant however rare the
 * token is, so rarity buys nothing a later query will say. Two tokens of equal
 * rarity are worth the same as tags, and the one a question is likelier to name
 * is the one the population's own prose uses more often. That makes the
 * frequency ranking the findability ranking, and it leaves the 25% cap as the
 * only guard against a tag that names nothing.
 */
export function deriveTopicTags(
  text: string,
  population: TagPopulation,
  limit: number = TAG_LIMIT,
): string[] {
  const ceiling = population.total * TAG_POPULATION_SHARE;
  const seen = new Set<string>();
  const candidates: Array<{ token: string; count: number; first: number }> = [];
  for (const token of String(text ?? "")
    .toLowerCase()
    .match(TAG_TOKEN) ?? []) {
    if (token.length < TAG_TOKEN_MIN_LENGTH) continue;
    if (QUERY_STOP_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    const count = population.count(token);
    if (count > ceiling) continue;
    candidates.push({ token, count, first: candidates.length });
  }
  candidates.sort((a, b) => b.count - a.count || a.first - b.first);
  return candidates.slice(0, limit).map((candidate) => candidate.token);
}
