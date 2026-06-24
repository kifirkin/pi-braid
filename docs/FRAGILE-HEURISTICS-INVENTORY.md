<!-- status: forward-looking -->

# Fragile Heuristics Inventory

**Generated 2026-06-14** as part of Q9 deep investigation (per user:
"hand-coded fallbacks or any fragile (regexp or whatever based)
heuristics is bad practice and we need replace with llm
critic or clasifier calls").

This is the canonical inventory of every regex, string-match,
keyword-map, and stopword-list heuristic in pi-braid, classified
by risk and proposed LLM replacement.

**Risk classification:**

- **A — Accuracy-critical.** Wrong answer causes user-visible
  error or behavior change. Replace with LLM.
- **B — Categorical.** Wrong category triggers wrong downstream
  action. Replace with LLM or constrain tightly.
- **C — Cheap pre-filter.** Errors are caught downstream; only
  the pre-filter needs to be "good enough". Keep with tests.
- **D — Format / syntax.** Detects a structural pattern (path,
  hex, ISO date). Replace only if format is unknown; otherwise
  regex is correct.

**Replacement tier mapping (text-classifier.ts):**
- Tier 2 = utility model (configured, ~200ms)
- Tier 3 = session model (always available, ~2-5s)

For most cases, Tier 2 is the right replacement. Tier 3 only
when the utility model isn't configured or for high-stakes
classifications.

---

## 1. `src/lib/ai/critic-registry.ts` — the core critic fallbacks

All 21 `*Fallback()` methods. Reached when LLM tier fails.
Each is called from `text-classifier.ts` Tier 1.

| # | Fallback | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `topicDriftFallback` | C | 190-192 | "no" is safe default; keep. |
| 2 | `contradictionFallback` | A | 250-272 | **A — replace.** Negation-word overlap is a false-positive mine. Tier 2 always. |
| 3 | `toolLoopFallback` | C | 318-320 | "no" is safe default; keep. |
| 4 | `evidenceConflictFallback` | A | 326-328 | **A — replace.** Returns "no" by default — that's a silent suppression. Tier 2 always. |
| 5 | `hintQualityFallback` | B | 402-404 | "yes" is too permissive. **B — replace with Tier 2.** |
| 6 | `compressionUrgencyFallback` | B | 464-477 | Multi-class (AGGRESSIVE/SEMANTIC/CONSERVATIVE/NONE). **B — replace with Tier 2; the threshold logic is a heuristic that LLM handles better.** |
| 7 | `qualitativeDegradationFallback` | B | 508-510 | Single "STABLE" default. **B — Tier 2; "STABLE" being the default masks real degradation.** |
| 8 | `errorTypeFallback` | D | 569-574 | Status code → category. **D — keep.** HTTP status codes are well-defined. |
| 9 | `instructionStrengthFallback` | D | 600-605 | RFC 2119 keyword match. **D — keep.** Spec-defined. |
| 10 | `commandTypeFallback` | A | 635-640 | "dangerous" for `sudo|rm|>/`. **A — replace.** Missing `chmod 777`, `mkfs`, `dd if=` etc. Tier 2 always. |
| 11 | `inputCodeHeavyFallback` | C | 707-718 | Whitespace ratio. **C — keep with tests.** |
| 12 | `inputWellWrittenFallback` | A | 720-738 | Sentence count + capitalization. **A — replace.** "well-written" is subjective; LLM is the right judge. |
| 13 | `inputClarityFallback` | A | 741-756 | Word count + run-on + contradiction markers. **A — replace.** Tier 2 always. |
| 14 | `inputAmbiguityFallback` | A | 758-766 | Vague phrase list. **A — replace.** Phrase lists miss 90% of ambiguity. Tier 2 always. |
| 15 | `hintRelevanceFallback` | A | 795-801 | "Fix X error" → "no". **A — replace.** LLM should judge hint relevance. Tier 2 always. |
| 16 | `conflictResolutionFallback` | A | 832-857 | Keyword overlap heuristic. **A — replace.** LLM can resolve "but actually" intent. Tier 2. |
| 17 | `complianceFramingFallback` | B | 876-885 | Tone/audience classification. **B — Tier 2.** |
| 18 | `polarityDetectionFallback` | A | 903-913 | Negation word list. **A — replace.** "I have not seen a case where it does not work" trips this. Tier 2. |
| 19 | `entityExtractionFallback` | A | 931-933 | ENTITY_VERBS regex. **A — replace.** LLM extracts named entities; regex only catches capitalized verbs. Tier 2. |
| 20 | `sycophancyFallback` | A | 958-967 | Sycophancy phrase list. **A — replace.** Phrase lists miss novel forms. Tier 2. |
| 21 | `vbCFallback` (verify-by-contract?) | A | 991-1000 | Regex on "You're right... however". **A — replace.** Tier 2. |

**Summary of critic fallbacks: 14 are A (replace), 3 are B
(replace with Tier 2), 1 is C (keep with tests), 3 are D
(keep).**

**Tactical fix path:**
1. Add `validLabels: string[]` and `tierPolicy: "always-llm" | "fallback-only"` to `CriticDef`.
2. For A-class critics, set `tierPolicy: "always-llm"` and remove the heuristic. Tier 1 returns `null` (forcing Tier 2). Document the change.
3. For B-class critics, set `tierPolicy: "fallback-only"` and mark the heuristic as "best-effort, biased toward over-triggering". Add monitoring (`recordCriticCall` already exists).
4. text-classifier.ts: if `tierPolicy === "always-llm"`, skip Tier 1 entirely. Skip the widen-matcher (D-4 revert).

**This is the right fix; D-4 (widened matcher) was wrong.**

---

## 2. `src/lib/store/claim-tracker.ts` — claim normalization

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `polarity = /\b(not\|no\|never\|n't\|without)\b/i` | A | 244 | **A — replace.** Same negation-word fragility as critic-registry #18. Use LLM polarity classifier. |
| 2 | `if (/^(what\|how\|why...)/i.test(sentence)) continue;` (skip question sentences) | B | 241 | **B — replace.** Hard-coded question starters miss foreign-language + non-standard questions. Tier 2. |
| 3 | `jsonMatch = raw.match(/\[[\s\S]*\]/)` (extract JSON) | D | 108 | **D — keep but extract to `lib/utils/extract-json.ts`** (already exists, use it). |
| 4 | `verbMatch = sentence.match(ENTITY_VERBS)` | B | 198 | **B — replace.** Use LLM verb identification. |

---

## 3. `src/lib/store/bidirectional-verifier.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | RFC 2119 keyword match (SHALL/MUST/SHOULD/MAY) | D | 188-190 | **D — keep.** Spec-defined. |
| 2 | Given/When/Then block extractor | D | 199-200 | **D — keep.** Structural pattern. |
| 3 | Markdown heading extractor (`## Purpose`) | D | 173 | **D — keep.** Markdown is structural. |

---

## 4. `src/lib/utils/sop-suggestion.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Stop-word filter for task tokenization | B | 173 | **B — replace.** Use LLM-extracted key terms. Tier 2. |
| 2 | File-path regex `[a-zA-Z0-9_\-./]+\.[a-zA-Z]+` | D | 192 | **D — keep.** Format detection. |
| 3 | Identifier regex `[a-z][a-zA-Z0-9]{2,}` | D | 202 | **D — keep.** Format detection. |
| 4 | `TASK_EXCLUDE_PATTERNS = [/\/retry/, /^\[retry\]/]` | C | 41 | **C — keep with tests.** |

---

## 5. `src/extensions/cognitive/hints.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | "Fix X error" → reject hint | A | 157-159 | **A — replace.** Same as critic-registry #15. Tier 2. |
| 2 | Generic-debug-pattern rejection | A | 158-159 | **A — replace.** LLM judge. |

---

## 6. `src/extensions/cognitive/reasoning/index.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `COMPLETION_CLAIM_PATTERNS` (regex on agent's "we're done" claims) | A | 50-58 | **A — replace.** Phrase list misses non-standard phrasings. Use LLM completion-claim detector. Tier 2. |

---

## 7. `src/extensions/cognitive/metacognition/handlers/scoring.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `/verify\|check\|test\|confirm\|reproduce/i` → "verify" dimension | B | 50 | **B — replace.** LLM classifies response dimension. Tier 2. |
| 2 | `/because\|caused by\|root cause/` → "causal" | B | 56 | **B — replace.** |
| 3 | `/proper\|maintainable\|clean\|refactor/` → "quality" | B | 62 | **B — replace.** |
| 4 | `/edge case\|boundary/` → "edge" | B | 68 | **B — replace.** |
| 5 | File-ref regex `[\w/.-]+\.(ts\|js\|json\|py\|rs\|go)` | D | 36 | **D — keep.** Format detection. |

---

## 8. `src/extensions/cognitive/metacognition/handlers/think.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Plan-marker regex (`\d+. \w+` + first/then/next) | B | 118-119 | **B — replace.** LLM plan detection. |
| 2 | Question-marker count (`?`) | C | 124 | **C — keep but report as a feature, not a quality signal.** |
| 3 | "because" present in claim but not premise → contradiction | A | 334 | **A — replace.** Way too brittle. Tier 2. |

---

## 9. `src/extensions/cognitive/metacognition/handlers/verify.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Code-block count | C | 118 | **C — keep with tests.** |
| 2 | Plan-marker regex | B | 120 | **B — replace** (same as think.ts). |
| 3 | Reasoning-marker regex | B | 121 | **B — replace.** |
| 4 | TODO/FIXME/HACK/XXX detection | D | 157 | **D — keep.** Format. |
| 5 | `eval()` detection | D | 159 | **D — keep.** Syntax. |
| 6 | `.innerHTML =` detection | D | 160 | **D — keep.** Syntax. |
| 7 | `delete \w+, {` (deep delete) | D | 161 | **D — keep.** Syntax. |

---

## 10. `src/extensions/cognitive/openspec.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | RFC 2119 detection (SHALL/MUST/SHOULD) | D | 42 | **D — keep.** Spec-defined. |

---

## 11. `src/extensions/enforcement/handlers/probe-handler.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Bash command classification (pipeline/loop/dangerous/info) | A | 49-51 | **A — replace.** Missing `chmod 777`, `mkfs`, `dd if=`, etc. **Tier 2 ALWAYS** for command classification. |
| 2 | Code-block detection in `params.oldText` | D | 97 | **D — keep.** Format. |

---

## 12. `src/extensions/enforcement/handlers/tool-tracker.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `testPatterns` for shell test detection | C | 119-136 | **C — keep with tests.** Tool classification is structural. |

---

## 13. `src/extensions/memory/context-manager/handlers/shared.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `transientPatterns` for error categorization | C | 196-209 | **C — keep with tests.** Status code / message patterns. |
| 2 | `contextWindowPatterns` for context-full detection | C | 214-222 | **C — keep with tests.** Specific phrases. |
| 3 | Hex ID detection | D | 120 | **D — keep.** Format. |

---

## 14. `src/extensions/memory/context-manager/semantic-compress.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Semantic type patterns (summary/boilerplate/etc.) | B | 85-122 | **B — replace.** LLM classifies semantic type. Tier 2. |

---

## 15. `src/extensions/memory/utils.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | File-extension extractor | D | 140 | **D — keep.** |
| 2 | CamelCase identifier extractor | D | 148 | **D — keep.** |

---

## 16. `src/lib/ai/llm-call.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `RATE_LIMIT_PATTERNS` (substrings) | C | 228-238 | **C — keep with tests.** LLM-provider error messages. |
| 2 | `TRANSIENT_ONLY_PATTERNS` | C | 242+ | **C — keep with tests.** |

---

## 17. `src/lib/ai/language-hint.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Unicode block detection (RU/AR/ZH/JA/KO/HI/TH/HE/EL) | D | 51-75 | **D — keep.** Unicode block ranges are the only correct way. |

---

## 18. `src/lib/utils/injection-tracker.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Source categorization by regex | C | 182-191 | **C — keep with tests.** Source strings are controlled. |

---

## 19. `src/lib/memory/index.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `GENERIC_CONTENT_PATTERNS` (auto-captured detection) | C | 46 | **C — keep with tests.** Source strings are controlled. |

---

## 20. `src/extensions/memory/memory-agent-bridge/explore-paths.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Stop-word list (the, and, for, ...) | B | 141 | **B — replace.** Use LLM-extracted key terms. Tier 2. |

---

## 21. `src/extensions/memory/scratchpad/index.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `[budget: \d+]` trailing-token parser | D | 407 | **D — keep.** Format. |

---

## 22. `src/extensions/memory/session-recall/index.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Session-name extraction `--name--` | D | 71 | **D — keep.** Format. |
| 2 | ISO date extraction | D | 86 | **D — keep.** Format. |

---

## 23. `src/extensions/scheduling/timer/index.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Tag char-set validation | D | 441 | **D — keep.** Format. |

---

## 24. `src/lib/utils/extension-utils.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Filename char-set | D | 91 | **D — keep.** |
| 2 | URL prefix | D | 98 | **D — keep.** |

---

## 25. `src/lib/utils/filter-safe-to-remove.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Quoted path extraction | D | 215 | **D — keep.** Format. |

---

## 26. `src/lib/state/workspace-snapshot.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Leading/trailing dash strip | D | 120 | **D — keep.** |
| 2 | `EXCLUDED_PATHS` | C | 142 | **C — keep with tests.** |

---

## 27. `src/extensions/memory/past-insights.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Pattern matchers for content classification | C | 150, 165 | **C — keep with tests.** Source-controlled strings. |

---

## 28. `src/extensions/memory/context-manager/handlers/events.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Tool-name backtick extractor | D | 269 | **D — keep.** Format. |

---

## 29. `src/extensions/memory/memory-agent-bridge/index.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | TTL regex `(\d+)([hdm])` | D | 179 | **D — keep.** Format. |

---

## 30. `src/extensions/core/prompt-builder/skills-section.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | Markdown heading extractor | D | 38 | **D — keep.** Format. |

---

## 31. `src/extensions/core/prompt-builder/index.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | First-sentence extractor `[.!?]` | C | 97 | **C — keep with tests.** |

---

## 32. `src/lib/reasoning/reasoning-summary.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `REASONING_PATTERNS` (12 regex for "I think", "Let me", etc.) | B | 16-29 | **B — replace.** Tier 2 already used in `confirmReasoningBlock`; tier 1 regex is a fast pre-filter. **Keep as pre-filter with `tierPolicy: "fallback-only"` + test coverage.** |
| 2 | Tool-name extractor `` `(\w+)`( `` | D | 110 | **D — keep.** Format. |

---

## 33. `src/lib/ai/text-classifier.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | `lower === "yes" \|\| /^yes\b/` | C | 186-187 | **C — keep with tests.** Output normalization. |
| 2 | `lower === "no" \|\| /^no\b/` | C | 186-187 | **C — keep with tests.** |

---

## 34. `src/lib/utils/extract-json.ts`

| # | Heuristic | Risk | Lines | Proposal |
|---|---|---|---|---|
| 1 | JSON code-block extractor | D | 29 | **D — keep.** Format. |

---

# Totals

| Risk | Count | Action |
|---|---|---|
| **A** Accuracy-critical | **17** | Replace with LLM (Tier 2) |
| **B** Categorical | **12** | Replace with LLM or constrain tightly |
| **C** Cheap pre-filter | **16** | Keep with tests |
| **D** Format / syntax | **31** | Keep |
| **Total heuristics** | **76** | |

**A + B = 29 heuristics to replace with LLM calls** (~38% of all
heuristics in pi-braid).

# Replacement plan

This is a major piece of work. Order of attack:

1. **`text-classifier.ts` plumbing** — add `tierPolicy` to `CriticDef`,
   skip Tier 1 when `tierPolicy: "always-llm"`. (1 file, ~30 LOC.)
2. **A-class critic fallbacks** — convert to `tierPolicy: "always-llm"`,
   delete the heuristic bodies. (1 file, 14 deletions.)
3. **B-class critic fallbacks** — convert to `tierPolicy: "fallback-only"`,
   add `confidence` field to result. (1 file, 3 changes.)
4. **Other A-class heuristics** (claim-tracker, hints, completion-claim,
   probe-handler command classification, polarity). Each becomes a
   LLM call via `classify()`. (5-6 files.)
5. **Other B-class heuristics** (scoring dimensions, plan detection,
   semantic-compress, sop-suggestion). Each becomes Tier 2 classifier.
   (5-6 files.)
6. **Cost analysis** — 37 A+B heuristics × (per-session) LLM calls.
   Estimate tier-2 cost and document.
7. **Monitoring** — extend `recordCriticCall` to log heuristic→LLM
   transitions so we can measure how often tier 1 was wrong (if we
   keep any).

# Test impact

- `test-critic-gate.mjs` — add tierPolicy assertions.
- New: `test-text-classifier-tier-policy.mjs` — locks the new
  always-llm / fallback-only distinction.

# Risk

Adding 37 LLM calls per turn is significant cost. Mitigation:
- Use Tier 2 (utility model) for the cheap ones (~200ms, ~$0.0001/call)
- Cache results by input hash for short windows
- Make `tierPolicy: "always-llm"` opt-in per critic, not default

# Open questions

- Q16: Tier 2 cost budget. What's the per-turn LLM spend limit?
- Q17: Caching. Hash-based short-window cache for tier-2 results?
- Q18: Rollout strategy. Replace all at once, or per-extension?
