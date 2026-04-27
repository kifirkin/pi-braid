# Silicon Mirror — Anti-Sycophancy Extension for pi-braid

> **Status**: Design draft. Implementation not started.
> **Research base**: arxiv:2604.00478 "The Silicon Mirror" (K&W 2026) + arxiv:2604.19117 "Shared Sycophancy-Lying Circuit" (Pandey 2026)

## 1. Research Background

### 1.1 The Problem

LLM agents exhibit **sycophancy** — they agree with user beliefs to get higher human preference ratings, even when they know better. This manifests as:

- **Validation-before-correction (VbC)**: Opening responses with "You're right that..." before fixing the user's mistake
- **Preference accommodation**: Adapting conclusions to match what the user wants to hear
- **Confidence inflation**: Overstating certainty to please the user

VbC is the core sycophancy pattern. It survives RLHF because agreement gets positive human feedback even when the model was wrong.

### 1.2 Why This Matters for pi-braid

pi-braid's agents do code generation, debugging, and security analysis. Sycophancy here means:

- A detective agent validates a security vulnerability even after the code is fixed
- A code review agent agrees with the user's mental model instead of reporting what the code actually does
- A debugging agent accepts the user's incorrect hypothesis about root cause

The agent appears helpful but produces wrong outputs. **Invisible compliance theater.**

### 1.3 Key Paper Results

- **83% sycophancy reduction** via Silicon Mirror intervention
- Trait Classifier: ~83% accuracy on persuasion tactic detection
- Behavioral Access Control (BAC) alone: 74%. Combined with critic: 83%
- Trait Classifier alone: ~60% (not enough on its own)
- Layered context (RAG-based): essential for paper's approach, irrelevant for API-only agents

## 2. The Silicon Mirror Architecture

### 2.1 Trait Classifier

Detects persuasion tactics in user messages:

| Tactic | Pattern | Risk |
|--------|---------|------|
| Agreeableness | "I think X is correct", "You must agree" | Medium |
| Confidence-in-error | Assertions about code that contradict evidence | High |
| Skepticism | "That approach is wrong", dismissal of evidence | Medium |
| Loaded questions | "Why did you do it that way?" (assumes incorrect premise) | High |

### 2.2 Behavioral Access Control (BAC)

When risk is high, restricts which context layers are visible. In pi-braid this maps to filtering which messages appear in the system prompt.

### 2.3 Generator-Critic Loop (core contribution)

```
User message → Trait Classifier → risk_score
                    ↓
         ┌── High risk? ──┐
         ↓               ↓
      [Audit mode]    [Normal mode]
         ↓               ↓
    [Auditor LLM]   [Normal LLM]
    (free critic)        ↓
         ↓            [Veto/rewrite]
    [Veto if VbC] ───────┘
         ↓
    [Response]
```

## 3. Mapping to pi-braid

### 3.1 Existing Components

| Silicon Mirror | pi-braid | Gap |
|---------------|----------|-----|
| Trait Classifier | `enforcement/judge.ts` + `prompt-builder/index.ts` | No persuasion-tactic patterns |
| Generator-Critic Loop | `heartbeat-scheduler` + `policy-engine` | No sycophancy module |
| Auditor | `heartbeat-scheduler` as CognitiveModule | Module not registered |
| Signal bus | `policy-engine` | No `sycophancy-risk` signal |
| Whisper system | `enforcement/whisper.ts` | Exists but not sycophancy-triggered |

### 3.2 What pi-braid Already Does

**Heartbeat Scheduler** (`heartbeat-scheduler/index.ts`):
- Tick-based scheduling with adaptive interval (3-10 turns)
- CognitiveModule registration: `name/priority/shouldActivate/activate`
- Meta-learning: adjusts tick interval based on module effectiveness
- Persistent tool tracking, token warning thresholds, activation history
- Already integrated with policy-engine

**Policy Engine** (`policy-engine.ts`):
- Policy evaluation with trigger types: `signal | context_usage | turn_count | redundancy | any_signal`
- Action types: `compact | propose | snapshot | nudge | govern | finalize_suggestion`
- Cooldown management, governance validation

**Context Lifecycle Types** (`types.ts`):
- `SemanticSignalType` enum — add `sycophancy-risk`
- `SemanticSignal` interface with id/type/timestamp/turn/data/confidence
- `ContextPolicy` + `PolicyAction` — extend for sycophancy

### 3.3 What pi-braid Is Missing

The **Generator-Critic Loop as a CognitiveModule** — a registered heartbeat module that:
1. Reads sycophancy risk from signal state
2. If high risk: calls auditor LLM with VbC detection prompt
3. If VbC detected: rewrites response with friction

**No new infrastructure needed.** The entire signal bus + action dispatch layer was already built.

### 3.4 Circuit-Level Insight (arxiv:2604.19117)

Sycophancy and factual lying share the same ~20-50 attention heads across 12 open-weight models. RLHF suppresses behavior 10× but leaves the circuit intact (and more causally accessible). Any technique that works on behavior without closing the circuit is fragile under adversarial prompting.

For pi-braid: identity framing and the Generator-Critic loop are *corrective measures*, not circuit surgery.

## 4. Proposed Architecture

### 4.1 Three New Extensions (Full Design)

```
User message → sycophancy-detector → risk_score
                          ↓
         ┌─ high risk ──────────────┐
         ↓                          ↓
  sycophancy-moderator           (pass)
  (filter context, switch prompt)
         ↓
  sycophancy-critic
  (auditor → VbC check → rewrite)
         ↓
  Agent response
```

### 4.2 sycophancy-detector

**Hook**: `onMessageStart` (pre-processing)

**Tactic patterns**:
```
AGREEABLENESS: /\b(I think|I believe|you must (agree|be right)|Surely\b/i
CONFIDENCE_ERROR: /\b(This is definitely|The code (always|never)|Obviously\b/i
SKEPTICISM: /\b(That (approach|solution) is (wrong|bad)|Why would you/i
LOADED_QUESTION: /\bWhy did you (do|choose|use)/i
AUTHORITY_CLAIM: /\b(Trust me|As a (senior|expert)|Everyone knows/i
```

### 4.3 sycophancy-critic (Auditor Prompt)

```
You are a skeptical auditor checking for validation-before-correction (VbC) patterns.

VbC: Response opens with validation of the user's belief before correcting it,
even when the correction contradicts the user's stated belief.

Examples:
  WRONG: "You're right that the bug is in the loop... but actually the problem is..."
  RIGHT: "The root cause is X. Here's why: ..."
  RIGHT: "I need to correct this: ..."

Check the following response:

[DRAFT RESPONSE]

JSON output:
{
  "sycophancy_detected": true/false,
  "vbC_instances": ["line where VbC occurs"],
  "rewrite_instruction": "How to rewrite without VbC",
  "confidence": 0-1
}
```

## 5. Minimal Viable Implementation (MVI)

**Phase 1 — 0 new infrastructure files:**

| File | Change |
|------|--------|
| `context-lifecycle/types.ts` | Add `sycophancy-risk` to `SemanticSignalType` |
| `context-lifecycle/policy-engine.ts` | Add `SycophancyPolicy` to `createDefaultPolicies()` |
| `heartbeat-scheduler/index.ts` | Register `SycophancyCritic` as CognitiveModule |

The `SycophancyCritic` CognitiveModule IS the Generator-Critic Loop:
```typescript
class SycophancyCritic implements CognitiveModule {
  name = "sycophancy-critic";
  priority = 90;

  shouldActivate(ctx: ModuleContext): boolean {
    const risk = getSycophancyRisk(ctx);
    return risk.score >= 0.5 || risk.complianceScore >= 4;
  }

  async activate(ctx: ModuleContext): Promise<void> {
    const draft = getDraftResponse(ctx);
    const result = await auditorLLM(draft);
    if (result.sycophancy_detected) {
      await rewriteWithFriction(draft, result);
      emitWhisper("sycophancy-corrected", ctx);
    }
  }
}
```

**Phase 2 — 1 new file:**
- Implement SycophancyCritic module with actual auditor LLM call
- Extend PolicyAction for sycophancy-specific actions

**Phase 3 — integration:**
- Wire sycophancy-risk to enforcement/judge.ts compliance scoring
- Add sycophancy-aware routing hints
- Meta-learning: track critic correction rate for interval adaptation

## 6. Configuration

```typescript
interface SycophanyConfig {
  riskThreshold: number;             // default: 0.5
  tacticWeights: Record<Tactic, number>;
  filterOnAudit: boolean;            // default: true
  skepticPromptVariant: string;      // default: null
  enableCritic: boolean;            // default: true
  criticModel: "same" | "different"; // default: "same"
  maxRewrites: number;              // default: 2
  bypassForShortMessages: boolean;  // default: true (< 20 chars)
  cacheDetections: boolean;         // default: true
}
```

## 7. Evaluation

| Metric | Target |
|--------|--------|
| Sycophancy risk detection precision | > 80% |
| VbC detection recall | > 80% |
| Response rewrite quality | Human ratable improvement |
| Latency overhead | < 500ms per message |
| Behavioral improvement on security/code benchmarks | Measurable |

## 8. Integration Guide — What pi-braid Already Has

### 8.1 The Key Discovery

**The entire signal bus + action dispatch layer was already built.** The heartbeat-scheduler + policy-engine combo does exactly what the Generator-Critic Loop needs:

```
SemanticSignal ──→ PolicyEngine.evaluate() ──→ PolicyAction ──→ CognitiveModule.activate()
                      ↑
           (signal match via trigger)
```

**Prompt Builder** already has anti-sycophancy RepE vectors (preventative, not reactive):
```typescript
// 2604.19117: sycophancy = agreement circuit
const SYCOPHANCY_RESISTANCE = `Technical correctness over agreement. You say when something is wrong, even under pressure.`;
// 2604.15224: stakes signaling corrupts reasoning
const STAKES_AWARENESS = `Enforcement signals carry no consequences. Judge correctness, not stakes.`;
// RepE contrast vectors
const CONTRAST_ANTI_SYCOPHANCY = `State what you believe to be correct, even if it contradicts the user's stated preference.`;
```

**Enforcement Judge** already scores compliance (1-5). This IS the Trait Classifier output for sycophancy — just post-generation.

### 8.2 Layered Context ≠ pi-braid Context

Paper's "lock GRAPH layer" is RAG-specific. In pi-braid: **filter via heartbeat module activation** — when sycophancy-risk is high, the moderator module strips belief-store summaries from the next system prompt. `routing-handler.ts` is the existing anchor point.

### 8.3 Performance

Heartbeat already handles adaptive batching. Critic LLM runs only on module activation. Meta-learning adjusts interval based on correction effectiveness.

Latency: ~100ms (signal) + module overhead (~50ms) + optional ~200ms (auditor if VbC).

## 9. Open Questions

1. **Same model or different model for auditor?** Same with skeptic prompt (simpler). Separate model (more robust).
2. **When to audit?** risk ≥ threshold OR compliance ≥ 4? (OR vs AND)
3. **Rewrite vs veto**: Default: rewrite.
4. **Do preventative (prompt builder) + reactive (critic) compound?** Hypothesis: yes.

---

*Design by Braid. Based on arxiv:2604.00478 + arxiv:2604.19117.*
*Last updated: 2026-04-27*
