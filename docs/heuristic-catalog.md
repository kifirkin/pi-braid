# Heuristic Fragility Catalog — Full Codebase Scan

Generated: 2026-05-29  
Method: grep for RegExp, .test(), PATTERNS, THRESHOLD, hardcoded keyword lists across src/

---

## Critical (directly affects agent behavior quality)

### 1. `register-auto-retry-end.ts:48-50` — Error Type Classification

```typescript
if (/429|rate.?limit/i.test(errorMsg)) return "rate_limit";
if (/5\d\d|server.?error|internal|overloaded|unavailable/i.test(errorMsg)) return "server_error";
if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg)) return "network";
```

**Fragility**: Misses provider-specific error formats (Anthropic 529, OpenAI 503 with different phrasing, custom proxy errors).
**Impact**: Wrong retry strategy → wasted retries or missed recovery.
**Fix**: `errorType` critic in critic-registry with 3-label classify().
**Effort**: ~30 minutes. Self-contained function, easy to swap.

### 2. `sycophancy-detector/index.ts` — Two Regex Fallbacks

**sycophancyFallback** (5 patterns): Flattery, loaded questions, authority claims, skepticism.
```typescript
/\b(I think|I believe|you must (agree|be right)|Surely)\b/i
/\b(This is definitely|The code (always|never)|Obviously)\b/i
```

**detectVbCFallback** (4 patterns): Validation-before-correction detection.
```typescript
/\b(You('re| are) right\b|That('s| is) a (fair|good) point\b)//... 50+ char lookahead
```

**Fragility**: Already uses classify() as primary — fallback is last resort. Low urgency.
**Impact**: Only matters when LLM unavailable (rare).
**Fix**: Already well-architected with three-tier fallback. Keep as-is.
**Effort**: 0 (already done).

### 3. `claim-tracker.ts:145-171` — Entity Extraction + Polarity Detection

**Verb leading-word filter**: `/^(what|how|why|let|try|check|i'?|this is why|the reason|because|so|therefore|however)/i`
**Verb matching**: `const VERBS = /\b(is|was|has|have|had|does|did|will|could|would|should|may|might|shall|supports|uses|provides|requires|contains|includes|returns|creates|allows|implements|generates|handles|manages|configures|deploys)\b/i`
**Polarity**: `/\b(not|no|never|n't|without)\b/i`

**Fragility**: 28 hardcoded verbs — misses domain-specific verbs (initializes, validates, dispatches). Polarity check misses "lacks", "excludes".
**Impact**: Data quality — missed claims, wrong polarity → confusion in belief store.
**Fix**: `entityExtraction` + `polarityDetection` critics. But extraction needs structured output, not binary label — harder.
**Effort**: ~2 hours (needs structured extraction, not just classify).

---

## Medium (indirectly affects quality)

### 4. `probe-handler.ts:76-84` — Command Classification

```typescript
if (/\|\s*grep|\|\s*awk|\|\s*sed/.test(cmd)) -> "pipeline"
if (/for|while|\$\(/.test(cmd)) -> "loop"
if (/sudo|rm\s|>\s*\/|mv\s+.*\s+.*/.test(cmd)) -> "dangerous"
```

**Fragility**: Misses PowerShell pipelines, `;` chaining, `&&` chaining, `npx` dangerous commands.
**Impact**: Security classification misses → dangerous commands not flagged.
**Fix**: `commandType` critic with 4-label classify(). But this is called per-tool-call — latency matters.
**Effort**: ~1 hour. Must be fast (heuristic + utility model, skip session model).

### 5. `bidirectional-verifier.ts:195-203` — Requirement Strength

```typescript
if (/\bSHALL\b/.test(body)) strength = "SHALL";
else if (/\bMUST\b/.test(body)) strength = "MUST";
else if (/\bSHOULD\b/.test(body)) strength = "SHOULD";
```

**Fragility**: Misses intent-level strength ("this is required", "it is critical that") that's not RFC 2119 keyword.
**Impact**: Under-classifies soft requirements → agent treats them as optional.
**Fix**: `instructionStrength` critic. Low effort, medium value.
**Effort**: ~30 minutes.

---

## Low (data quality, not decision-making)

### 6. `reasoning-summary.ts:14-25` — Reasoning Pattern Detection

```typescript
const REASONING_PATTERNS = [
  /\bI think\b/i, /\bLet me\b/i, /\bPerhaps\b/i, /\bHowever\b/i,
  /\bTherefore\b/i, /\bFirst\b.*then\b/i, /\bSo\b.*because\b/i,
  /\bLet me analyze\b/i, /\bThe approach\b/i, /\bI need to\b/i,
  /\bBased on\b.*I\b/i, /\bLooking at\b.*we can\b/i,
];
```

**Architecture**: Two-tier — regex pre-filter (Tier 1), then classify() on matches (Tier 2).
**Fragility**: Regex misses reasoning formulations ("One approach is...", "Considering both sides..."). But Tier 2 catches these.
**Impact**: Low — false negatives from Tier 1 are caught by Tier 2. False positives are cheap (extra classify call).
**Fix**: None needed — the two-tier pattern is correct.

### 7. `cognitive-memory/index.ts:46` — Generic Content Filtering

```typescript
const GENERIC_CONTENT_PATTERNS = [/auto-captured memory from enforcement/i, /auto-captured/i];
```

**Fragility**: Trivial pattern — two entries. Low risk.
**Impact**: Almost zero — only filters clearly auto-generated content.
**Fix**: Leave as-is.

### 8. `latent-activator/index.ts:394` — Compliance Framing Detection

```typescript
const COMPLIANCE_PATTERNS = ["must", "required", "ensure", "verify", "always", ...14 total];
```

**Fragility**: Misses compliance framing in commands ("You are to", "It is your responsibility to").
**Impact**: Low — this is a soft signal for reflection injection.
**Fix**: Keep as-is or add `complianceFraming` critic.
**Effort**: ~30 minutes if desired.

---

## Security (keep rule-based)

### 9. `vet-filter.ts:259-264` — Command Safety Checking

```typescript
new RegExp(S("\\brm\\s+-rf\\s+\\/(?:\\s+|$)")), // rm -rf /
new RegExp(S("\\bcurl\\b.*\\|\\s*(?:bash|sh|zsh|ksh)\\s*$")), // curl ... | bash
```

**Rationale**: Security blocks must be deterministic — false negatives are unacceptable. LLM judges hallucinate.
**Verdict**: DO NOT REPLACE with LLM judge. Keep rule-based.

---

## Threshold Constants (not heuristic, but configurable)

| File | Constant | Value | Notes |
|------|----------|-------|-------|
| `sop-suggestion.ts` | MIN_SIMILARITY | 0.3 | Jaccard threshold, reasonable |
| `sop-suggestion.ts` | MAX_SUGGESTIONS_PER_TURN | 1 | Conservative |
| `sop-suggestion.ts` | MAX_TOTAL_TOKENS | 800 | Resource limit |
| `session-recall/index.ts` | MAX_SEARCH_RESULTS | 10 | Resource limit |
| `session-recall/index.ts` | MAX_SNIPPETS_PER_SESSION | 3 | Conservative |
| `error-tracking/index.ts` | MAX_ERRORS | 100 | Resource limit |
| `auto-singleton/index.ts` | MAX_TIMEOUT_SECONDS | 3600 | Safety limit |
| `verification.ts` | VERIFICATION_REMINDER_THRESHOLD | 12 turns | Tuning parameter |
| `context-density.ts` | MAX_RECENT | 20 | Rolling window size |
| Various | ERROR_BURST_THRESHOLD | 3 | Appears in 3 files — duplication |

**Fragility**: ERROR_BURST_THRESHOLD (3) appears in 3 files independently. If tuned, must update all.

---

## Summary: Prioritized Fix List

| # | Module | Effort | Impact | Type |
|---|--------|--------|--------|------|
| 1 | `register-auto-retry-end` — error type | 30 min | High | Add `errorType` critic |
| 2 | `claim-tracker` — entity/polarity | 2 hours | Medium | Add `entityExtraction` + `polarityDetection` critics |
| 3 | `probe-handler` — command classification | 1 hour | Medium | Add `commandType` critic (latency-sensitive) |
| 4 | `bidirectional-verifier` — requirement strength | 30 min | Medium | Add `instructionStrength` critic |
| 5 | `latent-activator` — compliance framing | 30 min | Low | Add `complianceFraming` critic (optional) |
| — | `sycophancy-detector` — fallback regexes | 0 | — | Already well-architected |
| — | `reasoning-summary` — two-tier patterns | 0 | — | Correct pattern, no fix needed |
| — | `vet-filter` — security patterns | N/A | — | Keep rule-based, DO NOT replace |