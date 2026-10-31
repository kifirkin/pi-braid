/**
 * Owner speech: the braid half of the ruling write path.
 *
 * Two jobs, both of them specific to this deployment:
 *
 *  - **Decide whether a turn is the owner speaking at all.** The corpus holds
 *    every user-role turn, and in this transcript tree that includes the
 *    system's own voice: dispatch prompts the seat writes to a running agent,
 *    and whisper envelopes from braid's subsystems. A directive-language
 *    classifier over that input files the seat's own brief text as an owner
 *    ruling, with a pointer into a worker session - a store that looks like
 *    provenance and is self-quotation. A telegram envelope is the exception:
 *    its body is the owner's message in a transport wrapper, so the wrapper is
 *    stripped and the body is what gets classified.
 *  - **File a ruling in braid's store.** The label stamped into `source`, the
 *    pointer shape, the duplicate key and the fixed tags are braid's filing
 *    convention, not English grammar, so they live here and the script that
 *    writes them carries no domain string of its own.
 *
 * The classification itself is `classifyRulingBody()` in the generic layer.
 * This module supplies the vocabulary that layer cannot know - what a ruling
 * can be about, and which words describe braid's own machinery - and removes
 * the envelope before it ever reaches the grammar.
 *
 * Pure by construction: no I/O, no clock, no randomness.
 */

import {
  classifyRulingBody,
  type GrammarVocabulary,
  type RulingClass,
  type RulingShape,
} from "../memory/decision-grammar.js";

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

/**
 * The label every filed ruling carries at the front of `source`, and the only
 * handle a later run greps for. It is a constant here because the store's
 * retention policy keys on the same prefix: a second spelling would be a class
 * of entry the prune could not see.
 */
export const OWNER_RULING_LABEL = "owner ruling";

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
 * sub-header a coalesced batch puts above each message. Neither is the owner's
 * words.
 */
const TELEGRAM_TRANSPORT =
  /^\s*(?:from @\S+ .*in chat \d+\S*|\[\d+\/\d+\s@ [^\]]*\](?:\s+from @\S+.*)?|-{3,})$/i;

/**
 * How a dispatch prompt opens. These are turns the seat wrote to a running
 * agent; they carry imperatives because that is what a dispatch is.
 */
const SEAT_OPENER =
  /^\s*(?:you are\b|your (?:branch|task|brief|report|cwd|job|pane|mission)\b|read your brief in full|read the brief\b|read (?:the )?(?:\/|~|[\w-]+\.md)|begin backlog item|your task:|mission:|task:|authori[sz]ed (?:execution )?brief|re-?read\b|acknowledge\b|this is a fresh session|first: )/i;

/**
 * Words a dispatch prompt tends to carry: the seat's own shorthands, which the
 * owner does not use when he states a ruling. One in a turn is enough, because
 * none of them is owner vocabulary.
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

/** Sends a turn from the seat to a running agent. */
const STEER_OPENER =
  /^\s*(?:steer(?:,| from| to|:)|seat to |\[agent:|dispatch(?:ed)?:|correction to|status check|reminder:)/i;

/**
 * Session machinery. A message about a timer, a poller, a pane or a
 * predecessor's transcript is braid talking to a process; the owner states
 * rules about how braid behaves, not about which lock file the previous
 * occupant held.
 */
const SESSION_MACHINERY =
  /\b(?:timer|poller|polling|pane|worktree|predecessor|successor|lock (?:file|PID)|transcript|session file|placement section|check-result|result block|ci:check)\b/i;

/**
 * What a ruling is about when it does not open with the owner's own voice: the
 * system, its agents, its tools. A bare directive with none of this and no
 * first person ("Do not read or write files.") is an instruction aimed at the
 * reader, not a decision about braid.
 */
const SYSTEM_SCOPE =
  /\b(?:braid|agent|agents|worker|workers|writer|writers|reader|readers|seat|seats|system|prompt|memory|store|skill|skills|tool|tools|model|models|subscription|subscri\w*|session|sessions|orchestrator|identity|layer|layers|gate|gates|report|reports|brief|briefs|docs?|telegram|context|queue|pipeline|repo|repository|codebase|website|app|product)\b/i;

/**
 * Explicit generalization. A rule aimed at any instance is a rule; one aimed
 * at the agent reading it is a steer, and the escape hatch has to be stated.
 */
const GENERALIZED =
  /\b(?:any (?:instance|agent|worker|seat|one)|every (?:agent|instance|worker|seat)|generically?|whichever|regardless)\b/i;

/**
 * The vocabulary this deployment hands the generic grammar. It is the only
 * braid-specific input `classifyRulingBody()` takes, and it is a value rather
 * than a parameter chain so a fixture can classify the same body with and
 * without an envelope and compare.
 */
export const BRAID_VOCABULARY: GrammarVocabulary = {
  namesSubject: (text) => SYSTEM_SCOPE.test(text),
  talksProcess: (text) => SESSION_MACHINERY.test(text),
  generalizes: (text) => GENERALIZED.test(text),
};

/**
 * The owner's words inside a turn, or `null` when the turn is not the owner's
 * speech.
 *
 * Stripping happens line by line, and the kept lines are the original lines, so
 * a quote later cut from the body is still a contiguous slice of the stored
 * turn - the pointer resolves either way. A turn that carries any non-telegram
 * envelope is refused whole: a subsystem whisper and an owner tail can share
 * one turn, and no mechanical rule here can say which sentence is whose.
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

/** Is this turn a dispatch prompt rather than the owner speaking? */
function looksLikeSeatPrompt(body: string): boolean {
  const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
  if (SEAT_OPENER.test(firstLine)) return true;
  if (STEER_OPENER.test(firstLine)) return true;
  for (const pattern of SEAT_ANATOMY) if (pattern.test(body)) return true;
  return BRIEF_HEADINGS.test(body) && /\bbrief\b/i.test(body);
}

/**
 * Classify one user turn.
 *
 * Refuses everything that is not owner speech before the grammar runs, then
 * hands the body to the generic classifier with this deployment's vocabulary,
 * and stamps the provenance the pointer and the duplicate key are built from.
 */
export function classifyOwnerRuling(turn: RulingTurn): OwnerRulingCandidate | null {
  if (!turn || typeof turn.text !== "string") return null;
  const raw = turn.text.trim();
  if (!raw) return null;
  const speech = ownerSpeech(raw);
  if (!speech) return null;
  if (looksLikeSeatPrompt(speech)) return null;
  const shape: RulingShape | null = classifyRulingBody(speech, BRAID_VOCABULARY);
  if (!shape) return null;
  return {
    class: shape.class,
    quote: shape.quote,
    session: turn.session,
    session_id: turn.session_id,
    project: turn.project,
    ts: turn.ts,
    line: turn.line,
  };
}

/**
 * The pointer the store carries in `source`, in one fixed shape:
 * `owner ruling: <session path>:<line> (<iso ts>, <project>)`.
 *
 * Greppable by prefix, and it resolves: the path and line address the turn the
 * quote came from, so `sed -n '<line>p' '<session path>'` prints the words.
 */
export function rulingPointer(candidate: OwnerRulingCandidate): string {
  return `${OWNER_RULING_LABEL}: ${candidate.session}:${candidate.line} (${candidate.ts}, ${candidate.project})`;
}

/**
 * The pointer as a pattern, so a caller that scans a store for filed rulings
 * reads the label from the same place it writes it instead of spelling it a
 * second time. Groups: 1 the session path, 2 the line number.
 */
export function rulingPointerPattern(): RegExp {
  const escaped = OWNER_RULING_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}: (.+):(\\d+) \\(`);
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
 * The fixed handles every filed ruling carries: the class a reader filters on,
 * and the project it came from. The quote's own words are added beside these by
 * `deriveTopicTags()`, because a handle names the entry while a topic word is
 * what a later question arrives through.
 */
export function rulingBaseTags(candidate: OwnerRulingCandidate): string[] {
  return ["owner-ruling", candidate.class, projectTag(candidate.project)];
}
