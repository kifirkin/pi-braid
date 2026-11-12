/**
 * The private-data vocabulary, in one place.
 *
 * Three literals were found by a secret audit in this repository's published
 * tags and in one commit no branch pointed at: a home directory, a private
 * project tree, and a personal mailbox. They are declared here rather than in a
 * file under the owner's home, because a rule that lives outside the repository
 * is a rule a clone cannot run and a reviewer cannot read. The gate that uses
 * them is `check-private-paths.mjs`; this file is data plus the two allowances
 * the identity rule consults.
 *
 * Every literal is assembled from fragments at load time. A detector whose own
 * bytes carry the strings it refuses cannot pass over itself: it would have to
 * allowlist the file that defines the rule, and an allowlisted detector is
 * exactly where the next leak would sit unnoticed. `test-private-gate.mjs`
 * runs the gate over this tree and the tree includes this file, so the
 * fragments are load-bearing rather than cosmetic.
 *
 * The generic shapes are owned elsewhere and deliberately not repeated:
 * `check-placement.mjs` refuses any owner path (`/Users/<name>`,
 * `/home/<name>`) whoever the user, and the identity rule in
 * `check-private-paths.mjs` refuses any commit address that is neither a noreply
 * alias nor a declared allowance. What no other gate covers is the owner's own
 * prefixes and the owner's personal mailbox, so those are what this list names.
 * A consumer-mailbox *domain* rule was considered and rejected: it would refuse
 * every legitimate address a document may state as a contact, and the
 * allowances it would need to keep such a document green are themselves the
 * hiding place this list exists to avoid.
 *
 * Shapes:
 *   - a pattern is `{ name, regex, reason }`. The regex carries no `g` or `y`
 *     flag on purpose: `test` on a stateful pattern advances `lastIndex`, so the
 *     second line of a file would be judged from wherever the first match ended.
 *     The gate refuses a pattern that carries either flag.
 *   - an allowance is `{ file, pattern, lines?, reason }`. It is keyed to one
 *     file and one pattern, and to one line range when `lines` is given, so it
 *     cannot silence the pattern anywhere else; it is printed by every run that
 *     applies it; and an entry that suppresses nothing fails the run.
 *   - an email allowance is `{ address, reason }`, a standing permission for one
 *     identity rather than a suppression of one match, so it is not checked for
 *     staleness: nothing is wrong with an allowance this range happened not to
 *     use.
 */

/** Join fragments so no single line carries a whole leaked literal. */
const part = (...pieces) => pieces.join("");

/** Escape the regex metacharacters a literal may carry (the dot in a domain). */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HOME_DIR = ["", part("Us", "ers"), "kifir"].join("/");
const PRIVATE_TREE = ["projects", part("vi", "be"), part("implicit-", "framing")].join("/");
const MAILBOX_LOCAL = part("kif", "irkin");
const MAILBOX_DOMAIN = part("gm", "ail", ".", "com");

export const PATTERNS = [
  {
    name: "home-dir",
    regex: new RegExp(literal(HOME_DIR)),
    reason:
      "the owner's home directory: a path no clone can resolve, and the prefix that names the machine it was pasted from",
  },
  {
    name: "private-project-tree",
    regex: new RegExp(literal(PRIVATE_TREE)),
    reason:
      "a private project tree: the path names a repository that is not published here",
  },
  {
    name: "personal-email",
    regex: new RegExp(
      `${literal(MAILBOX_LOCAL)}(?:\\+[A-Za-z0-9._-]+)?@${literal(MAILBOX_DOMAIN)}`,
      "i",
    ),
    reason:
      "the owner's personal mailbox (with or without a plus-address tag): the noreply identity exists to keep this address out of published content",
  },
];

/**
 * The alias a commit identity may carry: GitHub's account-scoped address, in
 * both spellings it issues (`<id>+<login>@` and `<login>@`). It names an
 * account, not a mailbox, so it is the one form accepted without an allowance.
 */
export const NOREPLY_ALIAS = /^(?:\d+\+)?[A-Za-z0-9][A-Za-z0-9-]*@users\.noreply\.github\.com$/i;

/** Standing identity allowances: `{ address, reason }`. */
export const ALLOWED_EMAILS = [
  {
    address: "noreply@github.com",
    reason:
      "GitHub's web-flow identity: it authors the merge commits and browser edits the service makes, so it names the service rather than a person",
  },
];

/**
 * File-scoped content allowances: `{ file, pattern, lines?, reason }`.
 *
 * Empty on purpose. An allowance is the right layer for a fixture whose subject
 * is the gate's refusal, because there the literal has to exist. It is the
 * wrong layer for a real path in a real document, which is the leak the gate
 * exists for; hiding that in this list is the defect, not the fix. The fixtures
 * of `test-private-gate.mjs` assemble their planted paths from fragments the
 * same way this file does, which needs no allowance at all, so the mechanism
 * ships exercised and the list ships empty.
 */
export const ALLOWANCES = [];
