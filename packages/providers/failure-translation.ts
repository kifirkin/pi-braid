/**
 * failure-translation.ts: one place that answers both failure questions for a
 * raw error string.
 *
 * Two vocabularies, two questions, one input:
 *
 *   - providers `FailureClass` (ring-lifecycle.ts): the fate of the ROUTE.
 *     Delegated, never re-derived: the rotation walk's own `classifyFailure`
 *     answers it, so this module cannot drift from the walk.
 *   - core `LlmErrorCategory` (packages/core/src/lib/errors/llm-error.ts):
 *     the health of the SESSION. Providers is a standalone package, so
 *     product code cannot import across the package boundary; core's string
 *     classifier is mirrored here as data instead. The mirror is pinned by
 *     test/failure-translation.test.mjs: every canonical row there is
 *     cross-checked against the real core classifier, so drift on a text a row
 *     carries is a red diff. The rows are witnesses, not a derivation: a core
 *     change that alters the verdict for a text no row carries leaves this
 *     mirror stale and the test green.
 *
 * Translation, not unification: the two verdicts are reported side by side
 * and never merged. A string can be `key` to the route and `unknown` to the
 * session (a bare 403), or `none` to the route and `rate_limit` to the
 * session (a plain 429). Both are current, documented behaviour and the pin
 * records them as they are.
 */
import { classifyFailure, type FailureClass } from "./ring-lifecycle";

/**
 * Core's error vocabulary, declared here as data because providers cannot
 * import `packages/core`. The member strings are core's own values, kept
 * verbatim: the pin test compares the values `classifyLlmError` returns.
 */
export type LlmErrorCategory =
  | "balance"
  | "rate_limit"
  | "context_window"
  | "transient"
  | "abort"
  | "auth"
  | "unknown";

/**
 * Core's string classifier, mirrored as an ordered data table. The order is
 * core's own precedence (balance, rate_limit, auth, context_window,
 * transient) and each pattern list is copied verbatim from llm-error.ts
 * (BALANCE_PATTERNS, RATE_LIMIT_PATTERNS, AUTH_PATTERNS,
 * CONTEXT_WINDOW_PATTERNS, TRANSIENT_PATTERNS). Core's numeric status
 * branches (`status === 402` and friends) are unreachable from a raw string:
 * a status enters core only through `extractStatusCode(err)`, which returns
 * nothing for a string. Core's `abort` branch likewise needs an error
 * object, so it is unreachable here and is deliberately not a rule.
 */
const CORE_CATEGORY_RULES: ReadonlyArray<
  readonly [LlmErrorCategory, readonly RegExp[]]
> = [
  [
    "balance",
    [
      /402/,
      /insufficient[_ ]balance/i,
      /billing/i,
      /payment[_ ]required/i,
      /quota[_ ]exceeded/i,
    ],
  ],
  [
    "rate_limit",
    [/429/, /rate[_ ]limit/i, /too[_ ]many[_ ]requests/i, /throttl/i],
  ],
  [
    "auth",
    [/401/, /invalid[_ ]api[_ ]key/i, /unauthorized/i, /authentication/i],
  ],
  [
    "context_window",
    [
      /413/,
      /context[_ ]length[_ ]exceeded/i,
      /context[_ ]window/i,
      /maximum[_ ]context/i,
      /prompt[_ ]is[_ ]too[_ ]long/i,
    ],
  ],
  [
    "transient",
    [
      /500/,
      /502/,
      /503/,
      /504/,
      /529/,
      /overloaded/i,
      /server[_ ]error/i,
      /temporarily[_ ]unavailable/i,
      /econnreset/i,
      /etimedout/i,
      /enotfound/i,
      /network[_ ]error/i,
      /fetch failed/i,
      /socket hang up/i,
      /econnaborted/i,
      /epipe/i,
      /eai[_ ]again/i,
      /und[_ ]err/i,
      /other side closed/i,
    ],
  ],
];

/** Core's category for a raw error string: the classifier's string path. */
function coreCategoryOf(errText: string): LlmErrorCategory {
  // Core builds its text as `${status ?? ""} ${message}`.trim(); for a string
  // input the message is the string itself.
  const text = errText.trim();
  for (const [category, patterns] of CORE_CATEGORY_RULES) {
    if (patterns.some((pattern) => pattern.test(text))) return category;
  }
  return "unknown";
}

/** Both verdicts for one raw error string, side by side. */
export interface FailureTranslation {
  /** Providers vocabulary: the fate of the route (the rotation walk). */
  class: FailureClass;
  /** The 4xx/5xx status the text names, when it names one. */
  status: number | null;
  /** Core vocabulary: the health of the session. */
  category: LlmErrorCategory;
}

/**
 * Answer both questions for one raw error string. The providers half is the
 * walk's own classifier, delegated; the core half is the mirror above.
 */
export function translateFailure(errText: string): FailureTranslation {
  const classification = classifyFailure(errText);
  return {
    class: classification.class,
    status: classification.status,
    category: coreCategoryOf(errText),
  };
}
