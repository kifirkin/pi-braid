/**
 * The dispatch protocol's own vocabulary: the words a worker dispatch carries
 * because braid runs it, not because of anything about the work.
 *
 * Membership test, applied to every entry: the word names WHO runs the work,
 * WHERE it is routed, WHAT the loop writes down, or HOW it is proved. A word
 * that names the work itself is never an entry, however often a dispatch says
 * it: `test`, `check`, `review`, `verify`, `probe`, `audit`, `harness` and
 * `docs` stay in the matcher's score, because a skill's subject can be exactly
 * that word. `path` and `named` are entries only in their dispatch sense
 * (`only the seven named paths`); the corpus-frequency gate is what keeps a
 * domain use of `path` from riding on them.
 *
 * Why the list exists. A matcher that scores a whole dispatch is scoring the
 * loop: `braid-reference`'s file names the roles, the registry and the skills
 * catalog, so a dispatch addressed to a worker hands that skill the evidence a
 * brief about a couples band never could. Measured on the recorded dispatch in
 * test-skill-dispatch.mjs, that skill scored 10 with 6 signals against a
 * 23-skill catalog and took the top slot with its body inlined, while the
 * brief's subject was a percentage table.
 *
 * This file is the one place allowed to spell those words inside
 * `packages/core/src`: check-placement.mjs reads a role word in generic source
 * as role policy, and this list is matcher input — data the matcher consults,
 * never a gate on where a session may run. The exclusion is one file with a
 * stated reason, so every other module keeps the check.
 *
 * The same list classifies a *phrase*: a trigger phrase made only of these
 * words (`braid docs`, `orchestrator registry`) names the dispatch, not the
 * task, so the matcher records it as evidence and never qualifies a skill.
 *
 * Entries are the stemmed forms the keyword extractor produces, so membership
 * is a token test, not a prefix test: `commit` covers `commits` (the stemmer
 * strips the plural) and does not cover `committed`.
 */

/** Minimum keyword length the extractor applies; shorter words carry no evidence. */
const MIN_WORD_LENGTH = 4;

/**
 * The function words the extractor drops before this list is consulted. A
 * phrase made only of these says nothing about either the loop or the work, so
 * it is not classified as vocabulary either way.
 *
 * Deliberately a small local copy rather than an import from the matcher: this
 * module decides membership, and reading the matcher's stop list would make
 * the answer depend on the module that asks.
 */
const PHRASE_STOP_WORDS = new Set([
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

/**
 * One-rule stemmer, the same crude rule the matcher applies (strip a trailing
 * `es` after a sibilant, else a trailing `s`): membership is tested on the
 * stemmed form, and the rule is restated here rather than imported so the
 * answer does not depend on the module that asks the question.
 */
function stemWord(word: string): string {
  if (/sses$/.test(word) || /(?:x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The vocabulary itself, grouped by the question each word answers. */
export const PROCESS_VOCABULARY: ReadonlySet<string> = new Set([
  // who runs it
  "worker",
  "orchestrator",
  "seat",
  "wave",
  "spawn",
  "spawned",
  "dispatch",
  "admission",
  "admitted",
  "registry",
  // where it is routed
  "worktree",
  "branch",
  "path",
  "named",
  "output",
  "deliverable",
  "queue",
  "pipeline",
  // what the loop writes
  "brief",
  "spec",
  "impl",
  "report",
  "artifact",
  "claim",
  "result",
  "block",
  "fenced",
  "json",
  "telemetry",
  "whisper",
  "catalog",
  // how it is proved
  "gate",
  "evidence",
  "measurement",
  "measured",
  "measure",
  "population",
  "ceiling",
  "rubric",
  "bar",
  "contract",
  "locked",
  "blocked",
  "validated",
  "hygiene",
  "adoption",
  "commit",
  "exit",
  "pass",
  "fail",
]);

/**
 * True when every significant word of a phrase is dispatch vocabulary: the
 * phrase describes the loop, so a prompt that carries it is telling the matcher
 * where it is, not what the work is. A phrase with no significant word (all
 * short or stop words) is not vocabulary — it says nothing either way. Pure.
 */
export function isProcessPhrase(phrase: string): boolean {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_WORD_LENGTH && !PHRASE_STOP_WORDS.has(w));
  // A word counts in its own spelling or its stemmed one, so a phrase's plural
  // is read as its singular while a stemmed stub that loses its meaning
  // (`docs` -> three letters) keeps the spelling that says what it is.
  return (
    words.length > 0 &&
    words.every((w) => PROCESS_VOCABULARY.has(w) || PROCESS_VOCABULARY.has(stemWord(w)))
  );
}
