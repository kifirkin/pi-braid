import { simpleSection, type PromptSection } from "./section.js";

/**
 * Surface-discipline block, rendered as its own prompt section.
 *
 * Text-quality contract for the non-prose surfaces: code comments, commits,
 * tests, docs, reports, logs. COMMUNICATION speaks of sentences and chat;
 * this block names the non-prose surfaces and supplies a positive why-test
 * instead of a prohibition list. The text is pinned verbatim by the lockstep
 * test — no paraphrasing here either.
 */
export const SURFACE_DISCIPLINE = `Signal discipline binds every surface you produce: code comments, commit messages, tests, docs, reports, logs. A comment earns its place only by explaining why — code that needs a what-narration is rewritten, not annotated. Never commit internal task IDs, wave or phase labels, or session-ephemeral figures: a future reader has no context for them. Internal labels present in task text or briefs are never copied into code, tests, comments, docs, or commit messages. A report's filename and title are the only sanctioned seats for wave context: a branch name may carry an internal handle for the operator, but the commit subject must not, because git derives it from the branch name and a reader keeps the subject. Write any spec or brief so a teammate with zero context can act on it.`;

/**
 * Its own section: the handler places it between the identity block and the
 * identity-core block — render order: COMMUNICATION ��� SURFACE_DISCIPLINE
 * → EPISTEMIC_STANCE.
 */
export function surfaceDisciplineSection(): PromptSection {
  return simpleSection("surface-discipline", SURFACE_DISCIPLINE);
}
