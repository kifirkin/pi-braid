/**
 * The internal-label vocabulary, in one place.
 *
 * Two surfaces refuse the same tokens: files (`check-labels.mjs`, which scans
 * package sources, tests and docs) and history (`check-commit-subjects.mjs`,
 * which reads commit subjects). A token one surface refuses and the other
 * accepts is a rule with a hole in it, so the patterns live here and both gates
 * read them. A new token is added once and both surfaces see it.
 *
 * Three digits only, and deliberately: task labels in this repository use three
 * digits, while every two-digit `Wnn` token in the tree is an ISO calendar week
 * (the `2026-Wnn` strings, and the two week-number constants in the memory
 * write-log metrics fixture), so a two-to-three-digit pattern would flag
 * calendar weeks forever and train people to ignore the gate. Two-digit
 * historical task labels are out of scope.
 *
 * The export is an array of global regexes, read with `matchAll` (which clones
 * the pattern and never moves `lastIndex`), so a shared object stays stateless
 * across callers.
 */
export const LABEL_TOKEN_PATTERNS = [/\bW\d{3}(-T\d+)?\b/g, /\bBRIEF-[A-Z0-9-]+/g];
