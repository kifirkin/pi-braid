# pi-braid Roadmap — Remaining Large-Effort Tasks

**Date**: 2026-04-19
**Base commit**: `d5c7519` (v0.5.7 + post-P5 complete)
**Build**: 0 errors | 27 extensions | ~21,900 lines | 14/14 tests pass

**Task 1**: ✅ DONE — preprocessor uses `resolveUtilityModel()`, thinking:none set

---

## Architecture Constraints

These constraints govern all tasks below:

1. **Module-level global state is not session-scoped** — 9 modules have `const state = {}` or `let state` at module level. If pi ever runs multiple sessions in one process, state bleeds. Current pi runs one session per process, so this is safe TODAY but architecturally wrong.
2. **Extension load order is uncontrolled** — pi loads extensions from config in insertion order. No priority/dependency system exists.
3. **No `ctx.getUtilityModel()`** — the API never had this. Use `resolveUtilityModel(ctx)` from `src/lib/model-resolver.ts` instead.
4. **Preprocessor flow is correct** — `ctx.ui.setEditorText()` + `action: "handled"`. Never sends text to LLM directly.
5. **Anti-slop merged** — code-request patterns (EN + RU) now run inside preprocessor after translation, before editor update.

---

## Task 1: Preprocessor Model Resolution Fix

**Effort**: Small (30 min)
**Priority**: HIGH — preprocessor currently broken for reasoning-model-only setups
**Blocks**: Nothing
**Depends on**: Nothing

### Problem
`src/extensions/user-message-preprocessor/index.ts` line ~269 manually resolves the utility model with an ad-hoc fallback. But `src/lib/model-resolver.ts` already has `resolveUtilityModel(ctx)` with proper priority chain:
1. Custom utility model (from `/utility-model` command)
2. Default model/provider
3. Current model
4. Cheapest non-reasoning

### Implementation
```
// In preprocessor processMessage():
import { resolveUtilityModel } from "../../lib/model-resolver.js";

// Replace lines ~269-290:
let model = resolveUtilityModel(ctx);
if (!model) {
    state.skippedCount++;
    resolve({ action: "continue" });
    processQueue(ctx);
    return;
}
ctx.ui.setStatus("preprocessor", `⏳ Preprocessing with ${model.id}...`);
```

Delete ~15 lines of manual fallback logic. One import, one call.

### Verification
- Type check passes
- Test with reasoning-only model config → should pick cheapest non-reasoning
- Test with `/utility-model` set → should use that model

---

## Task 2: Session-Scoped State Refactor

**Effort**: Large (2-3 hours)
**Priority**: HIGH — correctness issue, blocks future multi-session support
**Blocks**: Task 6 (MARS reflection needs per-session confidence)
**Depends on**: Nothing

### Problem
9 modules use module-level mutable state:

| Module | State | Risk |
|--------|-------|------|
| `enforcement/state.ts` | 50+ fields | High — turn tracking, tool chains, drift detector |
| `enforcement/index.ts` | Inline closures | Medium — event handlers reference `state` |
| `context-manager/index.ts` | Inline state object | Medium — prune rules, BCR state |
| `user-message-preprocessor/index.ts` | Inline state object | Low — config, counters |
| `planner/index.ts` | Inline state object | Medium — plans array |
| `degradation-detector.ts` | Inline state | Low — error counters |
| `metacognitive-state.ts` | Module-level `let state` | Medium — confidence, gaps |
| `language-hint.ts` | Module-level `let` exports | Low — current language |
| `browser/index.ts` | `let sessionCleanup` | Low — cleanup function |

### Implementation: ExtensionContext Attachment Pattern

**Strategy**: Attach state to the `ExtensionContext` using a Symbol key, so each session gets its own state. Extensions read state from `ctx` instead of importing a global.

```typescript
// src/lib/extension-state.ts (NEW)
const STATE_SYMBOL = Symbol.for("pi-braid:extension-state");

export function getExtensionState<T>(ctx: ExtensionContext, key: string, factory: () => T): T {
    if (!(ctx as any)[STATE_SYMBOL]) (ctx as any)[STATE_SYMBOL] = {};
    const bucket = (ctx as any)[STATE_SYMBOL];
    if (!bucket[key]) bucket[key] = factory();
    return bucket[key];
}
```

**Migration pattern** (per extension):

```typescript
// BEFORE (module-level global):
export const state = { /* ... */ };

// AFTER (session-scoped via ctx):
import { getExtensionState } from "../../lib/extension-state.js";

function getState(ctx: ExtensionContext) {
    return getExtensionState(ctx, "enforcement", () => ({
        config: { ...DEFAULT_CONFIG },
        turnHistory: new Map(),
        // ... all fields with defaults
    }));
}
```

**Migration order** (by risk, lowest first):
1. `language-hint.ts` — 2 fields, trivial
2. `metacognitive-state.ts` — 4 fields, simple
3. `degradation-detector.ts` — medium complexity
4. `planner/index.ts` — plans array, needs ctx in all tool handlers
5. `user-message-preprocessor/index.ts` — config + counters
6. `context-manager/index.ts` — prune rules + BCR
7. `enforcement/state.ts` — 50+ fields, most complex

**Key challenge**: Enforcement's event handlers receive `ctx` from the runner. All handlers need `ctx` as first arg (they already get it from `pi.on(event, (e, ctx) => ...)`). The tools (enforcement tools) need `ctx` passed through — **confirmed**: `execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)` gives `ctx` in tool handlers. ✅

**Verification**:
- All 14 existing tests still pass
- New test: two "sessions" in same process don't share state
- Type check passes

---

## Task 3: Conflict-Aware Knowledge Integration

**Effort**: Large (3-4 hours)
**Priority**: MEDIUM — research quality issue, prevents conflicting advice
**Blocks**: Nothing
**Depends on**: Task 2 (needs session-scoped state for EvidencePool)
**Source**: `docs/RESEARCH_CONFLICT_QA.md`

### Problem (from RESEARCH_CONFLICT_QA.md)
When the agent consults multiple sources (memory, web, docs, code), conflicting information flows into the response unchecked. The agent may:
1. Cite source A saying "X is true" then source B saying "X is false" — without flagging the conflict
2. Pick the most recent source by default (recency bias)
3. Never acknowledge uncertainty when sources disagree
4. Store conflicting memories without cross-referencing

### Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Source A    │────▶│ EvidencePool │────▶│ ConflictSet  │
│  (memory)   │     │              │     │ {claim, for, │
├─────────────┤     │ entries[]    │     │  against,    │
│  Source B    │────▶│ conflicts[] │     │  verdict}    │
│  (web)      │     │ signal()     │     └──────┬───────┘
├─────────────┤     │ detect()     │            │
│  Source C    │────▶│ resolve()    │     ┌──────▼───────┐
│  (code)     │     └──────────────┘     │ Enforcement  │
└─────────────┘                           │ Whisper      │
                                          └──────────────┘
```

### Implementation: `src/lib/evidence-pool.ts` (NEW ~120 lines)

```typescript
interface Evidence {
    claim: string;          // Normalized claim text
    source: string;         // "memory", "web", "code", "docs"
    content: string;        // Original content
    confidence: number;     // 0-1
    timestamp: number;
}

interface Conflict {
    claim: string;
    for: Evidence[];        // Evidence supporting
    against: Evidence[];    // Evidence contradicting
    verdict: "unresolved" | "resolved_for" | "resolved_against" | "uncertain";
    resolvedBy?: string;    // How it was resolved
}

class EvidencePool {
    private entries: Evidence[] = [];
    private conflicts: Conflict[] = [];

    addEvidence(claim: string, source: string, content: string, confidence: number): void;
    detectConflicts(): Conflict[];  // Compare claim embeddings (simple: token overlap)
    resolveConflict(claim: string, verdict: string, reason: string): void;
    getConflictingClaims(): Conflict[];
    getUnresolvedConflicts(): Conflict[];
}
```

### Integration Points

1. **Memory recall** (`src/extensions/memory/index.ts`): When `memory_recall` returns results, add to EvidencePool
2. **Web search** (`src/extensions/web-search/index.ts`): When web results come back, add to EvidencePool  
3. **Code reading** (`src/extensions/docs/index.ts`): When docs are read, add to EvidencePool
4. **Enforcement `message_end`**: Check for unresolved conflicts → whisper

### Conflict Detection Algorithm

Simple token-overlap comparison:
```
1. Normalize claims: lowercase, remove stop words, stem
2. For each pair of evidences with same normalized claim:
   a. If they support different conclusions → flag conflict
   b. If confidence difference > 0.3 → flag potential conflict
3. Group into ConflictSets
```

No LLM needed for detection. Resolution can use LLM (optional, via enforcement judge).

### The `signalAcknowledgedConflict()` Pattern

From RESEARCH_CONFLICT_QA.md:
```typescript
// In enforcement message_end handler:
const conflicts = evidencePool.getUnresolvedConflicts();
if (conflicts.length > 0) {
    sendEnforcementWhisper(pi, 
        `[conflict] ${conflicts.length} unresolved knowledge conflicts detected. ` +
        `Consider acknowledging uncertainty: "Sources disagree on X. I'll go with Y because Z."`
    );
}
```

### Verification
- Unit tests: conflicting evidence → conflict detected
- Unit tests: resolve conflict → verdict stored
- Integration: memory + web disagreeing → enforcement whisper
- Type check passes

---

## Task 4: Think v2 Completion

**Effort**: Medium (1-2 hours)
**Priority**: MEDIUM — cognitive quality improvement
**Blocks**: Nothing
**Depends on**: Nothing
**Source**: `docs/TOOL_IMPROVEMENTS_PROPOSAL.md`

### Current State
Think tool already has:
- `depth`: "quick" | "deep" ✅
- `confidence`: 0-1 ✅
- `type`: "insight" | "question" | "assumption" | "conclusion" | "hypothesis" | "plan" | "quick" ✅
- `tags`: string[] ✅
- `parent_id`: for threaded reasoning chains ✅
- `thought_id`: auto-generated ✅

### What's Missing

#### 4a: Structured Thought Types
Add explicit execution tracking types:
```typescript
type ThoughtType = 
    | "plan"        // Strategic decomposition
    | "execution"   // Implementation progress
    | "reflection"  // Post-action assessment
    // existing types...
```

Already exists in schema. Need to add **enforcement nudges** when:
- Long execution chains without reflection (>5 tools without a "reflection" thought)
- Plans without subsequent execution thoughts
- Missing reflection after failed tool calls

#### 4b: Thought Chain Visualization
Threaded reasoning chains (via `parent_id`) need a way to surface them:
```typescript
// In enforcement turn_end:
const chains = getThoughtChains();  // Group thoughts by parent_id chains
const orphanChains = chains.filter(c => c.length > 1 && !c.last().conclusion);
if (orphanChains.length > 0) {
    sendEnforcementWhisper(pi, `[chains] ${orphanChains.length} open reasoning chains`);
}
```

#### 4c: Confidence Calibration
Track confidence predictions vs actual outcomes:
```typescript
// When tool succeeds after think(confidence: 0.9):
calibration.record(0.9, true);
// Over time: check if high-confidence predictions are accurate
```

### Implementation Steps
1. Add enforcement nudge for "execution without reflection" (5 lines in enforcement)
2. Add thought chain tracking to metacognitive-state (20 lines)
3. Add calibration tracking to metacognitive-state (15 lines)
4. Update think tool result to show calibration hint when confidence is misaligned

### Verification
- Type check passes
- Test: 6+ tool calls without reflection → nudge fires
- Test: thought chain with 3+ nodes → tracked correctly

---

## Task 5: Reasoning Metrics Calibration

**Effort**: Medium (1-2 hours)  
**Priority**: MEDIUM — metrics exist but thresholds are untested
**Blocks**: Nothing
**Depends on**: Nothing

### Current State
`src/lib/reasoning-metrics.ts` has conservative thresholds:
- Anchor overlap < 0.15 → "topic_drift"
- Bigram entropy < 0.15 → "repetitive"  
- Self-contradictions > 2 → "self_contradiction"

These were set conservatively. They need calibration against real agent output.

### Implementation

#### 5a: Calibration Harness
Create `test/runtime/test-reasoning-metrics.mjs`:
```javascript
// Test cases with known-good and known-bad outputs
const cases = [
    { request: "implement auth", response: "Here's auth code...", expectStable: true },
    { request: "fix the bug", response: "The bug is X. The bug is not X.", expectStable: false },
    { request: "refactor", response: "refactor refactor refactor...", expectStable: false },
    // ... 10-15 cases covering each metric
];
```

#### 5b: Threshold Tuning
Run metrics against historical agent outputs (from session files in `~/.pi/sessions/`):
```bash
# Extract agent responses from recent sessions
# Run metrics against them
# Adjust thresholds to minimize false positives
```

#### 5c: Metric Persistence
Store stability scores in enforcement state for trend tracking:
```typescript
// In enforcement state:
stabilityHistory: [] as Array<{ turn: number; metrics: StabilityMetrics }>,
```

If stability consistently degrades → stronger whisper → context audit recommendation.

### Verification
- Test harness passes all cases
- No false positives on well-formed agent output
- Trend detection works over 10+ turns

---

## Task 6: MARS Reflection

**Effort**: Medium (1-2 hours)
**Priority**: LOW — infrequent trigger, nice-to-have
**Blocks**: Nothing
**Depends on**: Task 2 (needs session-scoped metacognitive-state)

### Problem
The agent never reflects on its own performance patterns across a session. It doesn't notice:
- "I've been using bash for everything this session — should I use grep/find more?"
- "I keep failing on TypeScript type errors — maybe I should check types earlier"
- "My confidence has been dropping — I should acknowledge uncertainty"

### Architecture
```
┌────────────────┐     ┌──────────────────┐     ┌──────────────┐
│ turn_end event │────▶│ MARS Reflector   │────▶│ Enforcement  │
│ (every N turns)│     │                  │     │ Whisper      │
└────────────────┘     │ analyzePatterns()│     └──────────────┘
                       │ generateAdvice() │
                       └──────────────────┘
```

### Implementation: `src/lib/mars-reflector.ts` (NEW ~80 lines)

```typescript
interface SessionPattern {
    toolDistribution: Map<string, number>;  // tool → usage count
    errorTypes: Map<string, number>;        // error → count
    confidenceTrend: number[];              // confidence values over time
    stabilityTrend: StabilityMetrics[];     // reasoning quality over time
}

function analyzePatterns(enforcementState): SessionPattern;
function generateAdvice(pattern: SessionPattern): string | null;
```

**Trigger**: Every 15 turns (configurable), check patterns. Only whisper if actionable advice exists.

**Advice rules**:
1. Tool over-reliance: one tool > 60% of calls → suggest alternatives
2. Error recurrence: same error type > 3 times → suggest root cause investigation  
3. Confidence decline: 3+ consecutive drops → suggest acknowledging uncertainty
4. Stability decline: overlap trending down → suggest refocusing on original task

### Integration
In enforcement `turn_end`:
```typescript
if (state.currentTurn % 15 === 0 && state.currentTurn > 0) {
    const advice = generateAdvice(analyzePatterns(state));
    if (advice) sendEnforcementWhisper(pi, `[mars] ${advice}`);
}
```

### Verification
- Type check passes
- Test: mock enforcement state with over-reliance → advice generated
- Test: no issues → null (no whisper)

---

## Task 7: Hypothesis Confidence Scoring

**Effort**: Small (1 hour)
**Priority**: LOW — enhancement, not critical
**Blocks**: Nothing  
**Depends on**: Nothing
**Source**: `docs/TOOL_IMPROVEMENTS_PROPOSAL.md`

### Current State
The `hypothesize` tool generates 2-3 hypotheses with descriptions but no confidence ranking. The utility model generates them, but the output format doesn't include a "rank" or "likelihood" field.

### Implementation
Add confidence scoring to hypothesis output:
```typescript
// In metacognition hypothesize handler:
// After utility model generates hypotheses, ask it to rank them:
// "Rate each hypothesis 0-1 for likelihood given the evidence"

// OR: use heuristic scoring based on:
// - How many evidence points support it
// - Whether similar errors were seen before (memory recall)
// - Whether the hypothesis suggests a specific file (more likely than vague)
```

Simple heuristic approach (no extra LLM call):
```typescript
function scoreHypothesis(hypothesis: string, evidence: string): number {
    let score = 0.5;
    // Specific file mention → +0.2
    if (/src\/|lib\/|test\//i.test(hypothesis)) score += 0.2;
    // Mentions specific error → +0.1
    if (/TypeError|Error|crash|fail/i.test(hypothesis)) score += 0.1;
    // Vague language → -0.2
    if (/maybe|might|could be anything/i.test(hypothesis)) score -= 0.2;
    return Math.max(0, Math.min(1, score));
}
```

### Verification
- Type check passes
- Test: hypothesis with file path scores higher than vague hypothesis

---

## Dependency Graph

```
Task 1 (Preprocessor Fix)     ──[standalone]
Task 2 (Session State)        ──┬──▶ Task 6 (MARS)
                                └──▶ Task 3 (Conflict QA)
Task 3 (Conflict QA)          ────▶ [depends on Task 2]
Task 4 (Think v2)             ──[standalone]
Task 5 (Metrics Calibration)  ──[standalone]
Task 6 (MARS Reflection)      ────▶ [depends on Task 2]
Task 7 (Hypothesis Scoring)   ──[standalone]
```

## Execution Order

```
Phase 1 (Quick Wins — ~2 hours):
  Task 1 → Task 7 → Task 4

Phase 2 (Core Refactor — ~3 hours):
  Task 2

Phase 3 (Intelligence Layer — ~5 hours):
  Task 3 → Task 5 → Task 6
```

## Estimated Total: ~10 hours

---

## Doc Consolidation Status

### Archived (docs/archive/)
AUDIT-2026-04-14.md, ABLATION_STUDY.md, CONTEXT-MANAGEMENT-DESIGN.md, CONTEXT-OVERFLOW-FIX.md, RESEARCH_SYNTHESIS_COMPLETE.md, SKEPTIC-AUDIT.md, VALIDATION_PROTOCOL.md, GAP-ANALYSIS.md, MEASUREMENT_GAP_SOLUTION.md, PROPOSAL_TOPIC_DRIFT_DETECTOR.md

### Current (docs/)
| File | Status | Action Needed |
|------|--------|---------------|
| REVIEW-v0.5.7.md | Active | Update as tasks complete |
| TOOL_IMPROVEMENTS_PROPOSAL.md | Reference for Task 4, 7 | Archive after Task 4+7 done |
| TOOLS_ISSUES_REPORT.md | Mostly fixed | Archive after verification |
| RESEARCH_SYNTHESIS_20260419_EVENING.md | Research notes | Archive |
| RESEARCH_CONFLICT_QA.md | **Active** — basis for Task 3 | Archive after Task 3 done |

### To Create
| File | Purpose |
|------|---------|
| `docs/ROADMAP-v0.6.md` | This file (rename) |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Task 2 breaks enforcement state | High — enforcement is core | Incremental migration, test after each module |
| Task 3 EvidencePool too noisy | Medium — false conflict flags | Conservative thresholds, only whisper on 2+ sources |
| Task 5 metrics uncalibrated | Low — false positives only | Start with warn-only, track accuracy over sessions |
| ExtensionContext doesn't support Symbol attachment | High — blocks Task 2 | Fallback: WeakMap<ExtensionContext, State> |
| `ctx` not available in tool handlers | Medium — blocks Task 2 for tools | Check pi.registerTool handler signature first |
