/**
 * Owner-ruling extraction: the read half of the decision backfill.
 *
 * The store an agent consults by habit is the semantic memory store, and a
 * decision the owner stated once reaches it only if something reads the
 * transcript and writes it down. This module is that something's classifier:
 * one user turn in, either `null` or a candidate ruling with its pointer and
 * its class.
 *
 * Pure by construction - no I/O, no clock, no randomness - so its behaviour is
 * a fixture instead of a story. The write half (`scripts/build-decisions-index.mjs`)
 * owns the census, the caps, the duplicate scan and the single sanctioned
 * write; nothing here knows that a store exists.
 *
 * Two properties the write half depends on:
 *
 *  - **Verbatim.** The quote is a contiguous slice of the owner's own words,
 *    never a paraphrase and never a summary. A paraphrase loses the ruling;
 *    the quote is what a later reader re-checks against the session line.
 *  - **Resolvable pointer.** `rulingPointer()` renders
 *    `owner ruling: <session path>:<line> (<iso ts>, <project>)`, whose path
 *    and line address the very turn the quote was cut from, so
 *    `sed -n '<line>p' '<session path>'` prints the words the entry claims.
 *
 * The corpus holds every user-role turn, and in this transcript tree that
 * includes the seat's own voice: dispatch prompts addressed to a worker, and
 * whisper envelopes from braid's own subsystems. A directive-language
 * classifier over that input files the seat's brief text as an owner ruling,
 * with a pointer into a worker session - a store that looks like provenance
 * and is self-quotation. So the front door requires owner speech:
 *
 *  - a dispatch prompt ("You are worker …", "Read your brief in full", a
 *    pasted brief with its headings) is refused;
 *  - a `[braid-whisper - <subsystem>]` envelope is refused for every subsystem
 *    except `telegram`, whose body is the owner's own message in a transport
 *    wrapper: the wrapper is stripped and the body is what gets classified.
 *
 * What this module cannot do, and does not pretend to: a ruling stated as a
 * one-off task order ("now try to build X") is not a ruling, and a ruling that
 * a later ruling replaced is still a ruling. Both are recall problems for the
 * caller's caps and for a later pass, not screens to invent here.
 */

/** The closed set of ruling shapes the classifier can name. */
export type RulingClass = "prohibition" | "preference" | "requirement" | "policy";

/**
 * One user turn, in the shape the corpus index stores it. Declared here rather
 * than imported from `extensions/memory/session-recall/corpus-index.ts`: `lib/`
 * does not import from `extensions/`, and the classifier needs six fields, not
 * that module's build machinery.
 */
export interface RulingTurn {
  /** Absolute path of the session file the turn was read from. */
  session: string;
  /** pi's session id; with `line` it is the duplicate key. */
  session_id: string;
  /** Project label the session ran in. */
  project: string;
  /** Entry timestamp, ISO-8601. */
  ts: string;
  /** 1-based line number of the turn inside the session file. */
  line: number;
  /** The owner's words, verbatim. */
  text: string;
}

/** A turn the classifier judged to carry an owner ruling. */
export interface OwnerRulingCandidate {
  class: RulingClass;
  /** The owner's words, contiguous and verbatim, capped with a trailing ellipsis. */
  quote: string;
  session: string;
  session_id: string;
  project: string;
  ts: string;
  line: number;
}

/** Longest quote the store receives; past this the ruling is cut, not summarized. */
export const QUOTE_LIMIT = 400;

/**
 * A turn longer than this is a pasted brief, a log or a tool dump, not the
 * sentence an owner states a ruling in. The quote is capped at QUOTE_LIMIT
 * anyway, so a long turn can only contribute a fragment whose subject was
 * three paragraphs earlier.
 */
const MAX_TURN_CHARS = 1200;

/** Below this a turn is an acknowledgement ("ok", "proceed"), never a ruling. */
const MIN_TURN_WORDS = 3;

/** A continuation sentence is kept only while the quote stays short enough to read. */
const CONTINUATION_LIMIT = 200;

/**
 * A whisper envelope header. The transport line is not speech: for a telegram
 * envelope the body beneath it is the owner's message, and for every other
 * subsystem it is braid talking to itself.
 */
const WHISPER_HEADER = /^\s*\[braid-whisper - ([a-z0-9-]+)(?: @ [^\]]*)?\](.*)$/i;

/** The envelope's closing marker. */
const WHISPER_END = /^\s*\[braid-whisper-end\]\s*$/i;

/**
 * Transport lines inside a telegram envelope: the sender line, and the
 * sub-header a coalesced batch puts above each message. Neither is the
 * owner's words.
 */
const TELEGRAM_TRANSPORT =
  /^\s*(?:from @\S+ .*in chat \d+\S*|\[\d+\/\d+ @ [^\]]*\](?:\s+from @\S+.*)?|-{3,})$/i;

/**
 * How a seat dispatch prompt opens. These are turns the seat wrote to a
 * worker; they carry imperatives because that is what a dispatch is.
 */
const SEAT_OPENER =
  /^\s*(?:you are\b|your (?:branch|task|brief|report|cwd|job|pane|mission)\b|read your brief in full|read the brief\b|read (?:the )?(?:\/|~|[\w-]+\.md)|begin backlog item|your task:|mission:|task:|authori[sz]ed (?:execution )?brief|re-?read\b|acknowledge\b|this is a fresh session|first: )/i;

/**
 * Words a dispatch prompt tends to carry: the seat's own shorthands, which the
 * owner does not use when he states a ruling. Two in one turn is a brief.
 */
const SEAT_ANATOMY: ReadonlyArray<RegExp> = [
  /\bAUTHORITATIVE BRIEF\b/i,
  /\bAUTHORISED BRIEF\b/i,
  /\bresult block\b/i,
  /check-result\.mjs/,
  /\bConfirm receipt\b/i,
  /\bPI_SESSION_FILE\b/i,
  /\bEnd it with the result block\b/i,
  /\bDispatch facts\b/i,
  /\bRead your brief\b/i,
];

/** Pasted-brief structure: headings that only a dispatch prompt carries. */
const BRIEF_HEADINGS = /^\s*#{2,}\s/m;

/**
 * Session machinery. A message about a timer, a poller, a pane or a
 * predecessor's transcript is the seat talking to a process; the owner states
 * rules about how braid behaves, not about which lock file the previous seat
 * held.
 */
const SESSION_MACHINERY =
  /\b(?:timer|poller|polling|pane|worktree|predecessor|successor|lock (?:file|PID)|transcript|session file|placement section|check-result|result block|ci:check)\b/i;

/**
 * What a ruling is about when it does not open with the owner's own voice: the
 * system, its agents, its tools. A bare directive with none of this and no
 * first person ("Do not read or write files.") is a worker's brief line, not a
 * decision about braid.
 */
const SYSTEM_SCOPE =
  /\b(?:braid|agent|agents|worker|workers|writer|writers|reader|readers|seat|seats|system|prompt|memory|store|skill|skills|tool|tools|model|models|subscription|subscri\w*|session|sessions|orchestrator|identity|layer|layers|gate|gates|report|reports|brief|briefs|docs?|telegram|context|queue|pipeline|repo|repository|codebase|website|app|product)\b/i;

/** The owner's own voice: first person, singular or collective. */
const FIRST_PERSON = /\b(?:i|i'm|i've|i'll|i'd|we|we're|we've|we'll|we'd|my|our|ours|let's)\b/i;

/**
 * Second-person address. A dispatch or a steer talks to *you*; the owner
 * stating a rule for braid talks about agents, workers or the system, or
 * generalizes explicitly (`any instance`, `generically`).
 */
const SECOND_PERSON = /\b(?:you|your|yours|yourself|yourselves)\b/i;
const GENERALIZED =
  /\b(?:any (?:instance|agent|worker|seat|one)|every (?:agent|instance|worker|seat)|generically?|whichever|regardless)\b/i;

/**
 * First-person report voice: the owner narrating what he saw, changed or
 * disabled. Such a sentence can carry "always" or "no longer" by accident
 * ("I still see only ...", "it no longer indexed"), so it is refused unless it
 * opens with a directive.
 */
const REPORT_VOICE =
  /\b(?:i|we)\b[^.!?]{0,120}\b(?:noticed|noticing|see|saw|seen|disabled|enabled|changed|updated|merged|pushed|committed|created|deleted|found|think|thought|guess|believe|realised|realized|checked|ran|built|fixed|added|removed|renamed|replaced|read|told|said|mentioned)\b/i;

/**
 * Conversational openers that carry no decision: the owner thinking aloud. A
 * marker inside one of these ("doesn't really matter") is not a ruling.
 */
const CONVERSATIONAL =
  /^\s*(?:or i don'?t know|i don'?t know|not sure|doesn'?t really matter|whatever|never mind|nevermind)\b/i;

/** Sends a turn from the seat to a running worker. */
const STEER_OPENER =
  /^\s*(?:steer(?:,| from| to|:)|seat to |\[agent:|dispatch(?:ed)?:|correction to|status check|reminder:)/i;

/** A turn that reads as a report of work already done, on its first line. */
const STATUS_OPENER =
  /^(?:done|finished|merged|shipped|pushed|committed|built|fixed|updated|completed|released|deployed|landed|green|all (?:tests|gates|checks)|tests? (?:pass|green)|gates? (?:pass|green))/i;

/**
 * Hedged advice: the shape of a recommendation the owner floated and did not
 * adopt. `should` and `could` are deliberately absent from the durable marker
 * table below - they are how advice is phrased, not how a ruling is stated -
 * so a hedged sentence has to be refused explicitly rather than by accident.
 */
const HEDGE =
  /\b(?:maybe|perhaps|might|could|would|possibly|probably|consider|i think|i guess|not sure|unsure|what if|why not|we should probably)\b/i;

/**
 * Opening words that make a sentence a question, used only together with a
 * question mark: the mark alone is enough at the end of a turn, but a turn that
 * opens with a question and closes with a ruling keeps its ruling.
 */
const INTERROGATIVE_OPENER = /^\s*(?:how|what|why|when|where|which|who|whose|whether)\b/i;

const QUESTION_OPENER =
  /^(?:should|shall|can|could|may|might|do|does|did|is|are|was|were|will|would|have|has|how|what|why|when|where|which|who|whose|am|if)\b/i;

/**
 * The durable-marker table, in class-priority order. A marker earns a place
 * only if it makes the sentence a standing instruction rather than a task:
 * "must", "never", "always", "only", "prefer" state a rule; "should", "could",
 * "let's" and bare imperatives state this turn's work.
 */
/**
 * Decision frames, in class-priority order. A frame is the grammar of a
 * standing instruction rather than of this turn's work: an absolute
 * (`never`, `always`, `must`, `only one`), a comparison between ways of doing
 * something (`prefer`, `instead of`, `rather than`, `better than`), or a
 * prescription the owner states in the collective voice (`we need to`,
 * `should`). Bare imperatives are deliberately absent: "investigate X" is a
 * task for this turn, and a store built from every imperative is a task list
 * filed as policy.
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
 * Split a turn into contiguous sentence spans.
 *
 * The spans are offsets into the original string, so a quote assembled from
 * them is a byte-for-byte slice of the owner's words - the property the pointer
 * check leans on. Newlines end a sentence; a period does not end one inside a
 * known abbreviation, a number (`3.5`), or a path (`decision-extraction.ts`).
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
 * Is the turn a paste - a shell transcript, a code block, a log or a payload?
 *
 * A pasted command is the single most common false ruling: it carries
 * imperatives ("rm -rf"), digits, and often the word "only". The screens are
 * cheap because a ruling sentence is prose, and prose does not start every
 * line with a prompt, a box, or a stack frame.
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

/** Does the turn end in a question, or open with one and carry no ruling after it? */
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
 * stitched from two places in the turn.
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
 * The owner's words inside a turn, or `null` when the turn is not the owner's
 * speech.
 *
 * Stripping happens line by line, and the kept lines are the original lines, so
 * a quote later cut from the body is still a contiguous slice of the stored
 * turn - the pointer resolves either way. A turn that carries any
 * non-telegram envelope is refused whole: a seat whisper and an owner tail can
 * share one turn, and no mechanical rule here can say which sentence is whose.
 */
function ownerSpeech(body: string): string | null {
  const lines = body.split("\n");
  const headers = lines.map((line) => WHISPER_HEADER.exec(line)).filter(Boolean);
  if (headers.length > 0) {
    const foreign = headers.find((header) => header![1].toLowerCase() !== "telegram");
    if (foreign) return null;
  }
  if (headers.length === 0) return body;

  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (WHISPER_HEADER.test(line)) {
      inside = true;
      continue;
    }
    if (WHISPER_END.test(line)) {
      inside = false;
      continue;
    }
    if (inside && TELEGRAM_TRANSPORT.test(line)) continue;
    if (inside) kept.push(line);
  }
  const stripped = kept.join("\n").trim();
  return stripped || null;
}

/** Is this turn a seat dispatch prompt rather than the owner speaking? */
function looksLikeSeatPrompt(body: string): boolean {
  const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
  if (SEAT_OPENER.test(firstLine)) return true;
  if (STEER_OPENER.test(firstLine)) return true;
  for (const pattern of SEAT_ANATOMY) if (pattern.test(body)) return true;
  return BRIEF_HEADINGS.test(body) && /\bbrief\b/i.test(body);
}

/**
 * Does a sentence address the reader rather than state a rule about braid?
 * The escape hatch is explicit generalization: a ruling aimed at any instance
 * is a ruling, while one aimed at this worker is a steer.
 */
function addressesSecondPerson(sentence: string): boolean {
  return SECOND_PERSON.test(sentence) && !GENERALIZED.test(sentence);
}

/**
 * Absolute frames that make a hedged sentence a ruling anyway: an owner who
 * writes "maybe we should never post through an API" has still ruled, while
 * "we could consider APIs" has not.
 */
const ABSOLUTE =
  /\b(?:never|must|always|only one|required|mandatory|forbidden|banned|not allowed|by default|from now on|going forward)\b/i;

/**
 * Classify one user turn.
 *
 * Returns `null` for everything that is not a standing instruction: a question,
 * a paste, a status report, a hedged recommendation, an acknowledgement, or a
 * turn too long to cut a self-contained sentence from. Returns a candidate
 * carrying the class, the verbatim quote, and the provenance fields the pointer
 * and the duplicate key are built from.
 */
export function classifyOwnerRuling(turn: RulingTurn): OwnerRulingCandidate | null {
  if (!turn || typeof turn.text !== "string") return null;
  const raw = turn.text.trim();
  if (!raw) return null;
  const speech = ownerSpeech(raw);
  if (!speech) return null;
  const text = speech;
  if (wordCount(text) < MIN_TURN_WORDS) return null;
  if (text.length > MAX_TURN_CHARS) return null;
  if (looksLikeSeatPrompt(text)) return null;
  if (looksPasted(text)) return null;

  const spans = sentenceSpans(text);
  if (spans.length === 0) return null;
  if (isQuestionShaped(text, spans)) return null;

  const firstSentence = text.slice(spans[0].start, spans[0].end).trim();
  if (STATUS_OPENER.test(firstSentence)) return null;
  if (INTERROGATIVE_OPENER.test(firstSentence)) return null;
  if (SECOND_PERSON.test(text) && !GENERALIZED.test(text)) return null;
  if (!FIRST_PERSON.test(text) && !SYSTEM_SCOPE.test(text)) return null;
  if (!FIRST_PERSON.test(text) && SESSION_MACHINERY.test(text)) return null;

  for (let index = 0; index < spans.length; index++) {
    const sentence = text.slice(spans[index].start, spans[index].end).trim();
    const kind = markerClass(sentence);
    if (!kind) continue;
    if (STATUS_OPENER.test(sentence)) continue;
    if (CONVERSATIONAL.test(sentence)) continue;
    if (sentence.includes("?")) continue;
    if (addressesSecondPerson(sentence)) continue;
    // The same voice test the turn passed, applied to the sentence that will
    // be quoted: a bare directive lifted out of a longer seat message is a
    // brief line, not a decision.
    if (!FIRST_PERSON.test(sentence) && !SYSTEM_SCOPE.test(sentence)) continue;
    if (!FIRST_PERSON.test(sentence) && SESSION_MACHINERY.test(sentence)) continue;
    if (
      REPORT_VOICE.test(sentence) &&
      !/^\s*(?:never|always|prefer|must not|by default|from now on)/i.test(sentence)
    ) {
      continue;
    }
    if (HEDGE.test(sentence) && !ABSOLUTE.test(sentence)) continue;
    const quote = quoteFrom(text, spans, index);
    if (!quote) continue;
    return {
      class: kind,
      quote,
      session: turn.session,
      session_id: turn.session_id,
      project: turn.project,
      ts: turn.ts,
      line: turn.line,
    };
  }
  return null;
}

/**
 * The pointer the store carries in `source`, in one fixed shape:
 * `owner ruling: <session path>:<line> (<iso ts>, <project>)`.
 *
 * Greppable by prefix, and it resolves: the path and line address the turn the
 * quote came from, so `sed -n '<line>p' '<session path>'` prints the words.
 */
export function rulingPointer(candidate: OwnerRulingCandidate): string {
  return `owner ruling: ${candidate.session}:${candidate.line} (${candidate.ts}, ${candidate.project})`;
}

/**
 * The duplicate key: one turn is one ruling, so `<session_id>:<line>` names it
 * whether the entry was written by this script, by hand, or by a later run.
 */
export function rulingDuplicateKey(candidate: OwnerRulingCandidate): string {
  return `${candidate.session_id}:${candidate.line}`;
}

/**
 * A project label as a tag token: lowercase alphanumerics, single hyphens, no
 * leading/trailing hyphen. `projects/agents/pi-braid` becomes
 * `projects-agents-pi-braid`, which is greppable and cannot collide with a
 * different project's label through punctuation alone.
 */
export function projectTag(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-project";
}

/**
 * The tag set every backfilled ruling carries: the fixed handles a reader
 * filters on, then the ruling's own class and the project it came from.
 */
export function rulingTags(candidate: OwnerRulingCandidate): string[] {
  return ["owner-ruling", "decision", candidate.class, projectTag(candidate.project)];
}
