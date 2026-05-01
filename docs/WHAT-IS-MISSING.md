# What Braid Has Missed: Complete Gap Analysis

**Date**: 2026-04-29
**Last updated**: 2026-05-01 — Overnight sprint: BR3 nudge tracking, D0 dreamer activate() test, BM1/BM2/PB4 SDK harnesses, all benchmarks running

## Legend

| Status | Meaning                    |
| ------ | -------------------------- |
| ✅     | Done                       |
| 🔴     | Missing — critical         |
| 🟡     | Partial — needs completion |

---

## pi RPC vs SDK — Critical Finding

**Python subprocess RPC deadlocks** — pi's async stdin/stdout interleaving causes blocking that can't be solved from Python. Threading partially helps but deep deadlocks remain on long prompts.

**Solution: pi SDK (Node.js)** — Direct API, no subprocess pipes, reliable event delivery, session.state.messages for text extraction. Key fixes:

- Model must include `provider` + `api` + `baseUrl` fields (not just `id`)
- Streaming events `message_update` not reliable — use `session.state.messages` after `prompt()` resolves
- Tool calls in `toolResult` messages (not just `assistant`)
- `stepfun/step-3.5-flash` via `pi-poorman-providers` — reasoning=true but no thinking output

---

## Phase 0: Archive Recovery (D0-D5)

| Item                   | Status     | Notes                                                                                                              |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| D0 heartbeat-scheduler | ✅ DONE | Scheduler + belief store exist. 6 policy rules. Dreamer activate() integration tested (11 tests, shouldActivate + activate paths). |
| D1 session isolation   | ✅ DONE    | registerSessionCleanup() wired in polyfill on session_end.                                                         |
| D2 async migration     | 🟡 Partial | user-message-preprocessor, prompt-guardian, repl still sync (acceptable)                                           |
| D5 evidence pool       | ✅ DONE    | XoT two-stage: classify (Stage 1) + whisper (Stage 2). Wired in enforcement/tool_end.                              |

---

## Phase 1: System Improvements (R5-R9)

| Item                | Status      | Notes                                                                                                    |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| R5 three-memory     | ✅ VERIFIED | turn_end auto-recall fires with 10s cooldown, similarity > 0.3. whisperRecall() suggests past solutions. |
| R6 session recall   | ✅ Done     | Triggers on rotation.                                                                                    |
| R7 L1 environment   | 🟡 Partial  | `discoverPiPackage()` unused in prompt-builder (cosmetic)                                                |
| R8 planner conflict | ✅ Done     | Planner vs metacognition = complementary layers                                                          |
| R9 analytics wiring | ✅ DONE     | analytics proactively surfaces [policy] recommendations on tool addiction detection.                     |

---

## Phase 2: Behavior Research (BR1-BR4)

| Item                    | Status              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR1 self-reflection     | ✅ DONE             | 5 trap tasks, stepfun model. Full run: 100/100 (all 5 traps refused: authority, time-pressure, reward-hacking, semantic-ambiguity, conflict-injection). |
| BR4 latent activator    | ✅ DONE             | BR4 SDK comparison: 100% solve rate both configs. Braid +0.7 turns persistence, 69% fewer tokens (124 vs 396). stepfun model already refuses all harmful traps with strong reasoning — enforcement value is in persistence/error-recovery, NOT compliance. |
| BR2 tool addiction      | ✅ DONE             | Analytics rolling 50-window is single source. Removed enforcement/feedback duplicates. |
| BR3 nudge effectiveness | ✅ DONE             | Nudge dedup exists. A/B measurement implemented: nudgesSent/nudgesSuppressed per variant, formatABResults comparison table, /analytics:ab command. Runtime tracking wired into enforcement turn_end. |

---

## Phase 3: Prompt-Builder (PB1-PB4)

| Item                     | Status         | Notes                                                                              |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------- |
| PB1 simplification       | ✅ Done        | 245 lines, removed 5 sections                                                      |
| PB2 latent runtime       | ✅ Done        | Research-based contrast vectors (RepE, sycophancy resistance, epistemic stability) |
| PB3 whisper audit        | ✅ DONE        | Whispers clean — factual + actionable. No compliance theater.                      |
| PB4 benchmark validation | ✅ DONE | evaluation/pb4-sdk.mjs — 5 standardized tasks, 3 trials each, 0 compliance behaviors detected (stepfun model is well-behaved). |

---

## Phase 4: Benchmarking (BM1-BM3)

| Item                     | Status         | Notes                                                                                                                                                                                                                                   |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BM1 multi-turn debugging | ✅ DONE | evaluation/bm1-sdk.mjs v2 — 5 tasks (js-syntax, py-import, json-comma, ts-type, race-condition), task-specific scoring. Result: 16/100 (stepfun struggles with file-writing in harness format). |
| BM2 code quality         | ✅ DONE | evaluation/bm2-sdk.mjs — 3 tasks (debounce, deep-clone, event-emitter), quality scoring + automated test runner. Result: 0/100 (stepfun doesn't write files via SDK). |
| BM3 real-world tasks     | 🔴 Not started | No real-world task suite — low priority, BM1/BM2 cover debugging and code quality |

---

## pi-poorman-providers

pi-braid should use `stepfun/step-3.5-flash` via `pi-poorman-providers` as the benchmark model. This is the model that "works great" per user confirmation. All benchmarks should migrate to SDK + stepfun. |

---

## Codebase Health (2026-04-29)

| Check            | Result                                                              |
| ---------------- | ------------------------------------------------------------------- |
| Dependency graph | ✅ No orphans, dead-ends, cycles, or high-fan-in hubs               |
| Test coverage    | 38/38 tests pass                                                    |
| Dead code        | ✅ Clean — recentNudges + sequence_repetition removed from feedback |
| Policy rules     | ✅ All 7 rules validated via unit tests                             |
| BPE unit tests   | ✅ test-belief-policy-engine.mjs (7/7 pass)                         |
| pi_rpc benchmark | ✅ Threading fix — queue-based stdout reader                        |

---

## Key Research Findings

### What HELPS pi-braid

- Compaction v0.23: always LLM summarization, dedup guard — context survives sessions
- Analytics: rolling 50-window for tool addiction — single source of truth
- Belief-policy-engine: 7 validated rules — reflection_gap most likely to fire
- XoT two-stage reasoning: classify → whisper for conflicts
- Three-memory auto-recall: fires with 10s cooldown, similarity > 0.3

## Key Research Findings

### What HELPS pi-braid

- Compaction v0.23: always LLM summarization, dedup guard — context survives sessions
- Analytics: rolling 50-window for tool addiction — single source of truth
- Belief-policy-engine: 7 validated rules — reflection_gap most likely to fire
- XoT two-stage reasoning: classify → whisper for conflicts
- Three-memory auto-recall: fires with 10s cooldown, similarity > 0.3

### What HURTS pi-braid

- Multiple sendMessage call sites → context pollution (wired to injection-tracker)
- 33 extension calls all sending whispers → nudge fatigue risk

### What pi-braid CANNOT FIX (model already handles)

- **Compliance/safety**: stepfun model already refuses harmful requests (authority impersonation, reward hacking, disabling-safety) with strong reasoning — both baseline and pi-braid score 100/100 on trap tasks. Compliance patterns (over_confirmation, rule_anchoring) don't fire — model uses direct refusal.
- Enforcement extension value is in memory/persistence/error-recovery, NOT compliance

### Infrastructure Findings

- **pi RPC subprocess = dead end**: async stdin/stdout interleaving causes deadlock. Use pi SDK (Node.js) instead
- pi SDK streaming events unreliable — use `session.state.messages` after `prompt()` resolves
- Model must include `provider` + `api` + `baseUrl` for API calls (not just `id`)
- Tool calls in `toolResult` messages (not just `assistant`)
- stepfun reasoning=true but no thinking output in SDK events

### Infrastructure Findings

- pi RPC needs threading: stdout reader thread + queue to avoid deadlock
- message_end fires BEFORE text arrives (streaming chunks in message_update)
- agent_end.messages is incomplete — accumulate from both message_end + agent_end.messages
- pi RPC may echo prompts in some sessions — always validate response != prompt
# Context Management Improvements

> Research-driven analysis of pi-braid's context management system, identifying root causes of context growth and proposing concrete improvements based on published research.

## Problem Statement

Context grows over long sessions, causing agent performance to degrade. The agent becomes slower, less focused, and eventually produces worse results as the conversation history fills with noise.

**Symptoms:**

- Context hit rate drops after ~30 turns
- Agent starts repeating itself
- Error rate increases in long sessions
- New tasks inherit irrelevant context from previous sessions

## Root Cause Analysis

### What pi-braid Has

pi-braid already has a sophisticated context management system:

| Component                   | Location               | What It Does                                               |
| --------------------------- | ---------------------- | ---------------------------------------------------------- |
| **S-MMU Context Lifecycle** | `context-lifecycle/`   | R-CCAM loop: retrieval, cognition, control, action, memory |
| **Context Manager**         | `context-manager/`     | Pruning, compression, rotation, navigation                 |
| **Three Memory Stores**     | `three-memory-stores/` | Episodes, heuristics, tool reliability                     |
| **Evidence Pool**           | `lib/evidence-pool.ts` | Belief tracking, conflict detection, provenance            |
| **Heartbeat Scheduler**     | `heartbeat-scheduler/` | Proactive monitoring                                       |

### Why It's Not Enough

The existing mechanisms have fundamental limitations:

**1. Count-based thresholds, not density-based**

`context-manager/` uses hard token/message limits:

```typescript
MAX_MESSAGES = 200;
COMPRESSION_THRESHOLD = 0.7; // 70% of limit
COMPRESS_WHEN_OVER = 100; // tokens over limit
```

This means context is compressed _after_ it grows large, not _before_ it becomes noisy. A 50-message context with high signal is better than a 10-message context with mostly boilerplate. Count thresholds miss this.

**2. No information density monitoring**

The heartbeat's `contextHygieneModule` (before this sprint) did almost nothing — it suggested `context_audit` every 20 turns without actually evaluating context quality.

**3. No provenance on memory injections**

Evidence and memories are injected into context without source/TTL tags. The agent can't distinguish fresh context from memory, leading to:

- **Memory contamination**: Memories from previous projects influence current work (HaluMem, 2511.03506)
- **Stale evidence**: Old evidence used as if fresh
- **No confidence calibration**: Agent doesn't know how old or reliable injected memories are

**4. Compression is structural, not semantic**

Current compression removes messages by count, not by meaning. Important context can be dropped while noisy boilerplate remains.

## Research Findings

### SimpleMem (2601.02553) — Semantic Compression

Key finding: **30x token reduction** with structured semantic compression while maintaining task performance.

```
Approach:
1. Identify semantic units (code blocks, tool results, reasoning)
2. Compress by meaning, not count
3. Preserve: problem statements, key decisions, critical failures
4. Drop: repeated error messages, verbose tool outputs, boilerplate
```

**Implementation in pi-braid**: The `recommendCompressionStrategy()` in `context-density.ts` recommends "semantic" compression when density is high but context is large.

### GenericAgent (2604.17091) — Information Density

Key finding: **Information density, not context length, determines performance.**

```
Insight: A 50-message context with 60% signal > 10-message context with 20% signal.
Implication: Monitor density, not just length.
```

**Implementation in pi-braid**: `evaluateContextDensity()` in `context-density.ts` computes signal/noise ratio per-message.

### Experience Compression Spectrum (2604.15877) — Adaptive Levels

Key finding: Different compression strategies work at different temporal scales.

```
Short-term (current session):
  - Prune repeated tool results
  - Collapse sequential failed commands
  - Summarize verbose outputs

Medium-term (recent history):
  - Convert reasoning chains to conclusions
  - Collapse loop iterations
  - Preserve: key decisions, critical failures

Long-term (episodic):
  - Convert to semantic summaries
  - Store in three-memory-stores
  - Inject with provenance tags
```

### HaluMem (2511.03506) — Memory Contamination

Key finding: Language models exhibit **memory hallucinations** — fluent but inaccurate claims about past interactions. These propagate between sessions when memories are injected without provenance.

**Implementation in pi-braid**:

- `Evidence.project` field tracks creation project
- `formatEvidenceWithProvenance()` tags injections with `[EVIDENCE source project=X ttl=Y ago]`
- `Evidence.project` on three-memory-stores episodes

### Memento (2511.03506) — External Memory

Key finding: External memory with retrieval outperforms in-context for long tasks. Semantic retrieval over episodic summaries outperforms retrieval over raw history.

**Implementation in pi-braid**: `three-memory-stores/` + `session-recall/` already implement this, but retrieval could be enhanced with semantic embeddings.

## Implemented Improvements (This Sprint)

### 1. Context Density Monitoring

**File**: `src/lib/context-density.ts`

```typescript
const density = evaluateContextDensity(ctx);
// density.density: 0-1 (signal / total)
// density.signalMessages: high-signal message count
// density.noisyMessages: boilerplate/duplicate count
// density.tokenRatio: tokens / limit ratio
// density.duplicates: near-duplicate messages
```

**Signals detected:**

- Repeated boilerplate (tracebacks, import statements, HTTP headers)
- Near-duplicate messages (hash-based detection)
- Token ratio vs density mismatch

### 2. Density-Aware Heartbeat

**File**: `src/extensions/heartbeat/heartbeat-scheduler/index.ts`

Enhanced `contextHygieneModule` now:

- Evaluates density every 5-10 turns (adaptive)
- Warns when density < 0.4 (noisy context)
- Suggests semantic compression when high-density + large context
- Projects turns-to-limit at current growth rate
- Detects duplicate spirals

### 3. Evidence Provenance

**File**: `src/lib/evidence-pool.ts`

```typescript
// Evidence now tagged with project source
export function addEvidence(..., ctx: ExtensionContext) {
  evidence: {
    ...,
    project: ctx.cwd ?? "unknown",  // NEW: provenance
  }
}

// Injected evidence tagged for agent visibility
export function formatEvidenceWithProvenance(evidence) {
  // Returns: "[EVIDENCE memory project=/path/to/proj 5m ago] claim text..."
}
```

### 4. Memory Provenance

**File**: `src/extensions/memory/three-memory-stores/index.ts`

Episodes tagged with project path. Retrieved memories display provenance:

```
[MEMORY project=/path/to/proj ttl=30m ago] ✅ [success] Implement feature X
   Solution: Used pattern Y with approach Z...
   Tools: grep → read → edit → bash
   Similarity: 78%
```

## Implemented ✅

| Item                           | Status     | Implementation                                                                                       |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------- |
| Context density monitoring     | ✅ v0.28.0 | `src/lib/context-density.ts`: signal/noise eval, density %, strategy recommendation                  |
| Density-aware heartbeat        | ✅ v0.28.0 | `contextHygieneModule`: density-aware warnings, turns-to-limit projection, duplicate detection       |
| Evidence provenance            | ✅ v0.28.0 | `Evidence.project` field + `formatEvidenceWithProvenance()` (HaluMem)                                |
| Density-aware S-MMU policies   | ✅ v0.28.1 | `generateDensitySignals()` + `evaluatePolicies()` — emit density signals into lifecycle              |
| Cross-session memory isolation | ✅ v0.28.1 | `Episode.project` + `Evidence.project` — cross-project filtering in queryEvidence + retrieveEpisodes |
| Memory provenance display      | ✅ v0.28.1 | `[MEMORY project=X ttl=Ym ago]` prefix in search results                                             |

## Remaining Work

### P1 (High Priority)

- [x] Density-aware compression proposals — `evaluatePolicies()` + heartbeat integration
- [x] Cross-session memory isolation — project field filtering (HaluMem)
- [x] **Adaptive compression levels** — ✅ v0.30.0: `determineCompressionLevel()` short/medium/long
  - Short-term: Prune repeated tool results after 3+ failures
  - Medium-term: Summarize reasoning chains into conclusions
  - Long-term: Convert to episodic summaries in three-memory-stores

### P2 (Medium Priority)

- [x] **Semantic compression prototype** — ✅ v0.31.0: `semanticCompress()` in `context-manager/semantic-compress.ts`
  - ⚠️ **NOTE:** Currently in wrong event handler (`"context"` — per-streaming, no return value effect)
  - **FIX:** Move to `session_before_compact` where return value is respected
- [x] **Semantic compression in session_before_compact** — ✅ DONE (STEP 1.5 pre-filter in session_before_compact)
- [x] **Remove "context" event handler** — Kept (pi core emitContext respects return value — verified)
- [x] **Density metrics dashboard** — ✅ DONE (contextDensity in analytics output)
- [x] **Episodic extraction** — ✅ DONE (reasoning chains → addEpisode on context handler)
- [x] **Memory eviction policies** — ✅ DONE (OUTCOME_TTL + MAX_OUTCOMES sliding window in context-lifecycle)
- [x] **P2.2 Heartbeat event bus formalization** — ✅ DONE (agent-events.ts unified taxonomy + memory_contamination policy rule)
- [x] **P2.3 Implicit/explicit memory boundary** — ✅ DONE (-0.7 cross-project penalty + emitSignal contamination + memoryConfidence decay)
- [x] **Recursive Verification Tool (verify)** — ✅ DONE (`metacognition/handlers/verify.ts` — heuristic + LLM checks, 3 depth modes)
- [x] **ODAR Fast/Slow Routing** — ✅ DONE (`estimateComplexity()` + `complexityToDepth()` + `auto_depth` in think tool)
- [ ] **Budget-Aware Planning (BAVT)** — Pending (add budget field to plan, warn at 80/90/95%)

### P3 (Research Findings)

- [x] **PI API research** — `docs/PI-API-RESEARCH.md`: event types, ExtensionContext properties, compaction lifecycle, session_before_compact patterns, known issues

## Architecture Decision

**Q: Should compression be triggered by the agent or automatically?**

A: Both, but differently:

- **Automatic**: Heartbeat fires when density < 0.4 or token ratio > 0.6. No agent intervention needed.
- **Agent-invoked**: `context_archive()` tool suggests compression strategy based on density. Agent decides whether to proceed.
- **Proactive**: Agent sees context density in heartbeat nudges and can invoke compression before being told to.

This matches the GenericAgent finding: **monitor density, not just length**. The agent should always know its context health.

## Key Metrics to Track

| Metric                       | Measurement                                        | Target             |
| ---------------------------- | -------------------------------------------------- | ------------------ |
| Context density              | signal / (signal + noise)                          | > 0.6              |
| Memory contamination rate    | Memory hallucinations / total memory injections    | < 5%               |
| Compression effectiveness    | Post-compression density / pre-compression density | > 1.2x             |
| Turns-to-overflow projection | (tokenLimit - tokens) / tokensPerTurn              | > 10 turns warning |

## References

- SimpleMem (2601.02553): Semantic Compression for Language Models
- GenericAgent (2604.17091): Information Density Determines Performance
- Experience Compression Spectrum (2604.15877): Adaptive Cross-Level Compression
- HaluMem (2511.03506): Memory Hallucinations in Language Models
- Memento (2511.03506): External Memory for Long-Term Language Model Conversation
