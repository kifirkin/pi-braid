/**
 * Surface-discipline diff scanner (shadow gate).
 *
 * Scans the ADDED lines of a worker diff for mechanical slop classes and
 * returns hits; callers report them as warnings. This gate is advisory by
 * design — findings never block a merge, and a scanner malfunction must
 * degrade to a warning, never to a thrown error in the merge path.
 *
 * Scope is deliberately narrow for precision: word-bounded regexes, comment
 * lines only for the narration classes, and one documented intent per
 * pattern. Dead code and verbose prose are out of scope here (separate
 * tooling); this module covers only the classes listed below.
 */

export interface SlopHit {
  /** Stable pattern id, e.g. "wave-token". */
  pattern: string;
  /** 1-based ordinal among the diff's added lines. */
  line: number;
  /** Trimmed excerpt of the offending added line (≤120 chars). */
  excerpt: string;
  /** "hard" marks the pure-restatement tiers a gate may act on later. */
  severity?: "hard";
}

// Drift-guard calibration: these pattern classes measured 2.39 hits per 100
// added lines on the calibration sample; the target is below 0.5. When a
// pattern changes here, re-run that density count so prompt text and
// detector stay honest about what they measure.
// Each entry carries a one-line intent; keep them word-bounded.

interface LinePattern {
  id: string;
  intent: string;
  regex: RegExp;
  /** Carried onto hits so callers can separate hard tiers from advisory ones. */
  severity?: "hard";
}

/** Patterns matched against any added line (code or comment). */
const LINE_PATTERNS: LinePattern[] = [
  {
    id: "wave-token",
    intent:
      "Orchestrator task identifiers (capital letter W plus 1-3 digits) — internal labels a future reader has no context for.",
    regex: /\bW\d{1,3}\b/,
  },
  {
    id: "phase-token",
    intent:
      "Orchestrator phase labels (the word Phase followed by a number) — same internal-metadata class as task identifiers.",
    regex: /\bPhase\s+\d+\b/,
  },
];

/** Patterns matched against comment text only (full-line or trailing). */
const COMMENT_PATTERNS: LinePattern[] = [
  {
    id: "echo-comment",
    intent:
      "Third-person narration verb opening a comment (Gets/Creates/Returns/…) — the comment restates the next statement instead of explaining why.",
    regex:
      /^(?:Gets|Sets|Checks|Updates|Creates|Removes|Adds|Deletes|Returns|Initializes|Loads|Saves|Calls|Runs|Builds|Parses|Handles|Triggers|Sends|Renders|Registers|Validates|Verifies|Ensures|Iterates|Waits|Commits|Logs|Exports|Imports|Defines|Calculates|Computes|Converts|Extracts|Fetches|Restores|Cleans|Clears|Resets|Skips|Toggles|Enables|Disables)\b/,
  },
  {
    id: "step-narration",
    intent:
      "Numbered step narration inside a comment (the word Step followed by a digit) — walkthrough prose, not a why-explanation.",
    regex: /\bStep\s+\d+\b/,
  },
  {
    id: "worker-id",
    intent:
      "Worker/task slug (w<number>-<name>) — orchestrator metadata a future reader has no context for.",
    regex: /\bw\d{1,3}-[a-z][\w-]*\b/,
  },
  {
    id: "wave-word",
    intent:
      "Wave label in prose (wave 3, Wave-4) — internal process metadata, not a technical fact.",
    regex: /\b[Ww]ave[-\s]?\d+\b/,
  },
  {
    id: "sprint-word",
    intent: "Sprint label (Sprint A-D) — internal process metadata.",
    regex: /\bSprint [A-D]\b/,
  },
  {
    id: "round-label",
    intent: "Round label (round 20) — internal process metadata.",
    regex: /\bround\s+\d+[a-z]?\b/i,
  },
  {
    id: "phase-label",
    intent:
      "Phase label (phase-3, Phase 2.3) — orchestrator metadata unless it names a protocol stage.",
    regex: /\bphase[\s-]?\d+(?:\.\d+)?\b/i,
  },
  {
    id: "owner-provenance",
    intent:
      "Owner attribution (owner directive/decision/report/approved/seed) — names WHO when the WHY is what a future reader needs.",
    regex: /\bowner[-\s](?:directive|decision|report(?:ed|ing)?|approv\w*|ratif\w*|seed)\b/i,
  },
  {
    id: "iso-date",
    intent: "Comment-borne date (YYYY-MM-DD) — change history belongs to git, not to a comment.",
    regex: /\b20\d\d-\d\d-\d\d\b/,
  },
  {
    id: "commit-ref",
    intent:
      "Commit/sha reference (commit <hash>, sha <hash>) — the hash says nothing to a future reader.",
    regex: /\b(?:commit|sha)\s+[0-9a-f]{5,40}\b/i,
  },
  {
    id: "hex-ref",
    intent:
      "Bare short hash in a comment (7+ chars, at least one digit and one a-f letter) — same class as commit-ref; plain words and pure digit runs are excluded.",
    regex: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/,
  },
  {
    id: "report-path",
    intent:
      "Ephemeral report/brief path (reports/<name>.md) — the file is not part of the tree a future reader has.",
    regex: /\b(?:reports?|briefs)\/[\w.-]+\.md\b/,
  },
];

/**
 * Catch blocks whose body is empty or comments only — exceptions swallowed
 * without handling. Matched against the joined added text, so multi-line
 * bodies are covered.
 */
const SWALLOWED_CATCH: LinePattern = {
  id: "swallowed-catch",
  intent:
    "Catch block with an empty or comment-only body — the error path was silenced rather than handled.",
  regex: /\bcatch\s*(?:\([^)]*\))?\s*\{(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*\}/,
};

/**
 * Imperative narration verbs, from the antislop Class-1 detector. Matched
 * against `//` line comments only: block and JSDoc lines conventionally open
 * imperative ("Extract the comment portion …") and are documentation, not
 * narration. Detection is mechanical by design — a comment may carry a why
 * after the verb; the advisory report surfaces it, the author decides.
 */
const ECHO_IMPERATIVE_VERBS =
  "Set|Get|Create|Update|Remove|Delete|Return|Call|Check|Loop|Iterate|Init|Initialize|Parse|Build|Read|Write|Add|Run|Use|Register|Log|Skip|Try|Handle|Compute|Convert|Format|Extract|Filter|Sort|Store|Load|Fetch|Send|Emit|Validate|Normalize|Clamp|Guard|Increment|Decrement|Clear|Reset|Compare|Attach|Detach|Wrap|Unwrap";

/**
 * Patterns matched against `//` line comments only (full-line or trailing).
 * The short-form tier is the hard gate: a bare verb plus at most five words
 * has no room for a why, so the restatement signal is unambiguous.
 */
const SLASH_COMMENT_PATTERNS: LinePattern[] = [
  {
    id: "echo-imperative",
    intent:
      "Imperative narration verb opening a // comment (Set the value, Extract name) — the comment restates the next statement instead of explaining why.",
    regex: new RegExp(`^(?:${ECHO_IMPERATIVE_VERBS})\\s+[a-z]`),
  },
  {
    id: "echo-short-form",
    intent:
      "Short-form restatement: imperative verb plus at most five more words — the strongest pure-restatement signal, hard tier of the echo-comment class.",
    regex: new RegExp(`^(?:${ECHO_IMPERATIVE_VERBS})(?:\\s+\\S+){0,5}$`),
    severity: "hard",
  },
];

/**
 * Extract the comment portion of a source line: full-line comments (line
 * comments, block-continuation lines, shell comments) or a trailing line
 * comment after whitespace. Code text without a comment yields undefined,
 * which keeps the narration patterns away from identifiers and strings.
 * `slash` marks comments that came from a `//` marker, so narration tiers
 * scoped to line comments can skip block and JSDoc lines.
 */
function extractComment(line: string): { text: string; slash: boolean } | undefined {
  const fullLine = line.match(/^\s*(?:\*|\/\/|\/\*|#)\s?(.*)$/);
  if (fullLine) return { text: fullLine[1], slash: /^\s*\/\//.test(line) };
  const trailing = line.match(/\s\/\/(.*)$/);
  if (trailing) return { text: trailing[1], slash: true };
  return undefined;
}

/** Collect every match of `pattern` over the added text with line ordinals. */
function collectBlockHits(pattern: LinePattern, joined: string): SlopHit[] {
  const hits: SlopHit[] = [];
  const re = new RegExp(pattern.regex.source, pattern.regex.flags.replace("g", "") + "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(joined)) !== null) {
    const line = joined.slice(0, match.index).split("\n").length;
    const excerpt = joined
      .slice(match.index, match.index + 160)
      .split("\n")[0]
      .trim()
      .slice(0, 120);
    hits.push({ pattern: pattern.id, line, excerpt });
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return hits;
}

/**
 * Scan the added lines of a unified diff for the slop classes above.
 * Pure function over the diff text — no fs, no git, no network — so the
 * merge path can call it inside a try/catch and treat any failure as a
 * warning rather than a gate failure.
 */
export function scanAddedLinesForSlop(diff: string): SlopHit[] {
  const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  const hits: SlopHit[] = [];

  addedLines.forEach((raw, index) => {
    const line = raw.slice(1);

    for (const pattern of LINE_PATTERNS) {
      if (pattern.regex.test(line)) {
        hits.push({ pattern: pattern.id, line: index + 1, excerpt: line.trim().slice(0, 120) });
      }
    }

    const comment = extractComment(line);
    if (comment !== undefined) {
      for (const pattern of COMMENT_PATTERNS) {
        if (pattern.regex.test(comment.text)) {
          hits.push({
            pattern: pattern.id,
            line: index + 1,
            excerpt: line.trim().slice(0, 120),
            severity: pattern.severity,
          });
        }
      }
      if (comment.slash) {
        for (const pattern of SLASH_COMMENT_PATTERNS) {
          if (pattern.regex.test(comment.text.trim())) {
            hits.push({
              pattern: pattern.id,
              line: index + 1,
              excerpt: line.trim().slice(0, 120),
              severity: pattern.severity,
            });
          }
        }
      }
    }
  });

  const joined = addedLines.map((l) => l.slice(1)).join("\n");
  hits.push(...collectBlockHits(SWALLOWED_CATCH, joined));

  return hits;
}
