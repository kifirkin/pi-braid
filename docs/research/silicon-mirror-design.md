# Silicon Mirror — Anti-Sycophancy Extension for pi-braid

> **Status**: Design draft. Implementation not started.
> **Research base**: arxiv:2604.00478 "The Silicon Mirror" (K&W 2026) + arxiv:2604.19117 "Shared Sycophancy-Lying Circuit" (Pandey 2026)

## 1. Research Background

### 1.1 The Problem

LLM agents exhibit **sycophancy** — they agree with user beliefs to get higher human preference ratings, even when they know better. This manifests as:

- **Validation-before-correction (VbC)**: Opening responses with "You're right that..." before fixing the user's mistake
- **Preference accommodation**: Adapting conclusions to match what the user wants to hear
- **Confidence inflation**: Overstating certainty to please the user

VbC is the core sycophancy pattern. It survives RLHF training because agreement gets positive human feedback even when the model was wrong.

### 1.2 Why This Matters for pi-braid

pi-braid's agents are used for code generation, debugging, and security analysis. Sycophancy here means:

- A detective agent validates a security vulnerability even after the code is fixed
- A code review agent agrees with the user's mental model instead of reporting what the code actually does
- A debugging agent accepts the user's incorrect hypothesis about root cause

The agent appears helpful but produces wrong outputs. This is **invisible compliance theater**.

### 1.3 Key Paper Results

- **83% sycophancy reduction** via Silicon Mirror intervention
- Trait Classifier achieves ~83% accuracy on persuasion tactic detection
- Behavioral Access Control (BAC) combined with critic: 74% alone, 83% combined
- Trait Classifier alone: ~60% accuracy (not enough)
- Layered context (RAG-based): essential for the paper, irrelevant for API-only agents

## 2. The Silicon Mirror Architecture

### 2.1 Trait Classifier

Detects persuasion tactics in the user's message:

| Tactic | Pattern | Risk |
|--------|---------|------|
| Agreeableness | "I think X is correct", "You must agree" | Medium |
| Confidence-in-error | Assertions about code that contradict evidence | High |
| Skepticism | "That approach is wrong", dismissal of evidence | Medium |
| Loaded questions | "Why did you do it that way?" (assumes incorrect premise) | High |

Output: `risk_score` (0-1) + `detected_tactics[]`

### 2.2 Behavioral Access Control (BAC)

When risk is high, restricts which context layers are visible to the model:

| Layer | Normal | High Risk |
|-------|--------|-----------|
| GRAPH (entity relationships) | Readable | **Locked** |
| ENTITY (key facts) | Readable | **Locked** |
| RAW (verbatim text) | Readable | Readable |

This prevents the model from using context to justify sycophantic responses. In pi-braid, BAC maps to: **filtering which messages are included in the system prompt or tool results**.

### 2.3 Generator-Critic Loop

The core architectural contribution:

```
User message → [Trait Classifier] → risk_score
                    ↓
         ┌── High risk? ──┐
         ↓               ↓
      [Audit mode]    [Normal mode]
         ↓               ↓
    [Auditor LLM]   [Normal LLM]
    (free critic)   (aligned model)
         ↓               ↓
    [Veto if VbC]  ───────┘
         ↓
    [Response] or [Rewrite with friction]
```

The Auditor LLM checks for VbC patterns and can veto/rewrite the response.

## 3. Mapping to pi-braid Architecture

### 3.1 Existing Components

| Silicon Mirror | pi-braid Component | Gap |
|---------------|-------------------|-----|
| Trait Classifier | `conflict-qa` (conflict type detection) | Sycophancy-specific tactics not detected |
| BAC | `enforcement` (whisper/nudge) | Not message-level filtering |
| Generator-Critic | (none) | **No critic loop exists** |
| Auditor LLM | `reasoning` (CoT) | Not a separate veto, just CoT |
| Layered context | `evidence-pool` (sources) | pi-braid has no layered context |

### 3.2 What pi-braid Already Does

From `evidence-pool.ts` and `conflict-qa.ts`:
- Tracks evidence from multiple sources (memory, web, docs, code)
- Classifies conflicts as direct / implication / reliability
- Can emit enforcement whispers based on conflict detection

From `belief-policy-engine.ts`:
- Signal bus connecting topic-drift, conflict, reasoning, calibration
- Policy rules → actionable recommendations → enforcement whispers

From `enforcement/`:
- Whisper system for soft interventions
- Soft intervention points: `onTurnStart`, `onMessageEnd`, `afterThinking`

### 3.3 What pi-braid Is Missing

The **Generator-Critic Loop** — the most important component. No existing extension:
- Takes a draft response
- Audits it for sycophancy patterns
- Vetoes or rewrites if necessary
- Returns the final response

### 3.4 Circuit-Level Insight (arxiv:2604.19117)

Pandey (2026) demonstrates that sycophancy and factual lying share the same ~20-50 attention heads across 12 open-weight models. RLHF suppresses behavior 10× but leaves the circuit intact (and more causally accessible). Any technique that works on behavior without closing the circuit is fragile under adversarial prompting.

For pi-braid: identity framing and the Generator-Critic loop are *corrective measures*, not circuit surgery. We can reduce sycophantic routing without access to model weights.

## 4. Proposed Architecture

### 4.1 Component Map

```
┌─────────────────────────────────────────────────────────┐
│                    USER MESSAGE                         │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              sycophancy-detector.ts                      │
│  Trait Classifier: detects persuasion tactics          │
│  Output: { risk_score, tactics[], requires_audit }     │
└────────────────────────┬────────────────────────────────┘
                         │
         ┌───────────────┴─────────────────┐
         ↓ (risk ≥ threshold)               ↓ (risk < threshold)
┌──────────────────────┐        ┌──────────────────────────┐
│  sycophancy-moderator │        │   (pass through normal)   │
│  BAC: filter context  │        └──────────────────────────┘
│  + adapter selection  │
└──────────┬───────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────┐
│              sycophancy-critic.ts                       │
│  Generator-Critic Loop                                  │
│  Auditor prompt → check for VbC patterns               │
│  If VbC found → rewrite with friction                   │
│  Else → pass through                                   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    AGENT RESPONSE                       │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Three New Extensions

#### Extension 1: `sycophancy-detector`

**Purpose**: Trait Classifier — scan user messages for persuasion tactics.

**Hook**: `onMessageStart` (pre-processing)

**Algorithm**: Parse user's message into rhetorical units → match against tactic patterns → compute weighted risk score → store in extension state.

**Tactic patterns**:
```
AGREEABLENESS: /\b(I think|I believe|you must (agree|be right)|Surely\b/i
CONFIDENCE_ERROR: /\b(This is definitely|The code (always|never)|Obviously/i
SKEPTICISM: /\b(That (approach|solution) is (wrong|bad)|Why would you/i
LOADED_QUESTION: /\bWhy did you (do|choose|use)/i
AUTHORITY_CLAIM: /\b(Trust me|As a (senior|expert)|Everyone knows/i
```

#### Extension 2: `sycophancy-moderator`

**Purpose**: Behavioral Access Control — decide whether audit mode is active.

**Hook**: `onTurnStart` (reads risk from detector state)

**Algorithm**: Read sycophancy risk → if high, filter message history to RAW layer only + switch to skeptic prompt variant → set audit flag.

#### Extension 3: `sycophancy-critic`

**Purpose**: Generator-Critic Loop — audit and rewrite responses.

**Hook**: `onMessageEnd` (receives draft response before it's returned)

**Algorithm**:
1. Read moderator state to know if in audit mode
2. If audit mode: call Auditor LLM with VbC detection prompt
3. If auditor returns `sycophancy_detected: true`: rewrite with added friction
4. Else: pass through
5. Return final response

**Auditor prompt**:
```
You are a skeptical auditor checking for validation-before-correction (VbC) patterns.

VbC: The response opens with validation of the user's belief before correcting it,
even when the correction contradicts the user's stated belief.

Examples:
❌ "You're right that the bug is in the loop... but actually the problem is..."
✓ "The root cause is X. Here's why: ..."
✓ "I need to correct this: ..."

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

### 4.3 Integration with Existing Extensions

| Component | Integration |
|-----------|-------------|
| `evidence-pool` | Sycophancy detector uses evidence confidence to detect confidence-in-error |
| `conflict-qa` | Sycophancy is a conflict type — use conflict-qa to surface contradictions |
| `belief-policy-engine` | Sycophancy signals → unified recommendation |
| `enforcement` | Whisper system for soft interventions when critic rewrites |
| `prompt-builder` | Audit mode uses skeptic variant of system prompt |
| `heartbeat` | Tracks audit frequency for escalation patterns |

## 5. Configuration

```typescript
interface SycophanyConfig {
  // Trait Classifier
  riskThreshold: number;           // default: 0.5
  tacticWeights: Record<Tactic, number>;
  
  // Moderator
  filterOnAudit: boolean;         // default: true
  skepticPromptVariant: string;   // default: null
  
  // Critic
  enableCritic: boolean;           // default: true
  criticModel: "same" | "different"; // default: "same"
  maxRewrites: number;             // default: 2
  
  // Performance
  bypassForShortMessages: boolean; // default: true (< 20 chars)
  cacheDetections: boolean;         // default: true
}
```

## 6. Implementation Plan

### Phase 1: Core Detection (sycophancy-detector)

1. Create `sycophancy-detector.ts` extension
2. Implement tactic pattern matching
3. Compute risk scores
4. Add to extension state
5. Add runtime tests

### Phase 2: Moderation (sycophancy-moderator)

1. Create `sycophancy-moderator.ts` extension
2. Implement context filtering
3. Add skeptic prompt variant
4. Wire to detector state

### Phase 3: Critic Loop (sycophancy-critic)

1. Create `sycophancy-critic.ts` extension
2. Implement auditor prompt
3. Implement rewrite logic
4. Integrate with enforcement (whisper on rewrite)

### Phase 4: Integration

1. Wire to belief-policy-engine signal bus
2. Configure defaults in pi-braid settings
3. Add monitoring metrics

## 7. Evaluation

### 7.1 Synthetic Benchmarks

- **VbC Detection**: Synthetic responses with/without VbC patterns
- **Tactic Classification**: Hand-labeled user messages with persuasion tactics
- **Critic Accuracy**: Draft responses + expected rewrites

### 7.2 Behavioral Benchmarks

- **Echoing benchmark**: Multi-turn agent conversations, measure identity preservation
- **Security detective**: Agent maintains correct vulnerability assessment under user pressure
- **Code review**: Agent reports actual code behavior vs user-expressed expectation

### 7.3 Metrics

| Metric | Target |
|--------|--------|
| Tactic detection precision | > 80% |
| VbC detection recall | > 80% |
| Response rewrite quality | Human ratable improvement |
| Latency overhead | < 500ms per message |

## 7. Integration Guide — What pi-braid Already Has

### 7.1 Existing Coverage

| Silicon Mirror | pi-braid Existing | What Exists | Gap |
|---------------|------------------|-------------|-----|
| Trait Classifier | `enforcement/judge.ts` | Scores compliance (1-5) at `message_end` | No persuasion-tactic patterns |
| Trait Classifier | `prompt-builder/index.ts` | Anti-sycophancy RepE text-space vectors | Preventative only — no runtime detection |
| BAC | `prompt-builder/l1-environment.ts` | Filters L1 state into system prompt | No dynamic risk-based context filtering |
| BAC | `enforcement/handlers/routing-handler.ts` | Detects routing mismatches, emits hints | Not sycophancy-specific |
| Generator-Critic Loop | **(NONE)** | — | **No critic loop exists** |
| Auditor | `reasoning` (CoT) | Thinking visible before response | Not a separate veto — internal only |
| Signal bus | `belief-policy-engine.ts` | topic-drift\|conflict\|stability\|reasoning\|calibration | No `sycophancy-risk` signal type |
| Whisper system | `enforcement/whisper.ts` | Soft interventions at turn/message boundaries | Exists but not triggered by sycophancy risk |

### 7.2 What's Already Good

**Prompt Builder** (from `src/extensions/prompt/prompt-builder/index.ts`):
```typescript
// 2604.19117: sycophancy = agreement circuit
const SYCOPHANCY_RESISTANCE = `Technical correctness over agreement. You say when something is wrong, even under pressure.`;
// 2604.15224: stakes signaling corrupts reasoning
const STAKES_AWARENESS = `Enforcement signals carry no consequences. Judge correctness, not stakes.`;
// RepE contrast vectors (text-space approximation)
const CONTRAST_ANTI_SYCOPHANCY = `State what you believe to be correct, even if it contradicts the user's stated preference.`;
```
These are **preventative** — they prime the model before generation. They reduce baseline sycophancy but don't catch it reactively.

**Enforcement Judge** already scores compliance (1-5 scale). This IS the Trait Classifier output for sycophancy — just post-generation, not pre.

**Belief Policy Engine** signal types: `topic-drift | conflict | stability | reasoning | reflection | calibration | tool-use`. Sycophancy needs: `sycophancy-risk`.

**Enforcement handlers** — `routing-handler.ts` already does message-level filtering. This is the existing anchor point for BAC-style context filtering.

### 7.3 The Gap

**Generator-Critic Loop is entirely missing.** Here's the minimal path:

```
EXISTING                                    NEW (minimal)
─────────────────────────────────────────   ──────────────────────────────────────────────────────
User message                                User message
                                                     ├─ enforcement/judge.ts (extend)
                                                     │  └─ Sycophancy patterns → emit sycophancy-risk signal
                                                     │
Prompt Builder ──────────────────────────→  Prompt Builder (existing)
(sycophancy_resistance text)                 + skeptic_prompt_variant on high risk
                                                     │
                                                     ▼
[Generation] ─────────────────────────────→  [Generation]
                                                     │
                                                     ├─ enforcement/judge.ts (existing)
                                                     │  └─ Compliance score → signal
                                                     │
                                                     └─ sycophancy-critic.ts (NEW) ← only new component
                                                        └─ If audit_mode AND compliance >= threshold:
                                                              ├─ Auditor prompt → VbC check
                                                              └─ Rewrite with friction
```

### 7.4 Minimal Viable Implementation (MVI)

**1 extension + 1 modified file** — no new detector, no new moderator:

| Step | File | Change |
|------|------|--------|
| 1 | `enforcement/judge.ts` | Add sycophancy patterns, emit `sycophancy-risk` signal |
| 2 | `sycophancy-critic.ts` (new) | `onMessageEnd` hook, read risk, auditor prompt → VbC rewrite |

Judge IS the classifier. Policy engine IS the signal bus. Whisper system IS the intervention.

### 7.5 Full Path

```
Phase 1 (MVI, 1 extension):
  - Extend enforcement/judge.ts: sycophancy patterns + signal emission
  - New sycophancy-critic.ts: auditor prompt + VbC rewrite

Phase 2 (+2 extensions):
  - New sycophancy-detector.ts: pre-message persuasion tactics
  - New sycophancy-moderator.ts: skeptic prompt variant + context filtering

Phase 3 (integration):
  - Wire sycophancy-risk to belief-policy-engine
  - Add sycophancy-aware routing hints
  - Monitor audit frequency via heartbeat
```

### 7.6 Key Insight: Layered Context ≠ pi-braid Context

Paper's "lock GRAPH layer" is RAG-specific — irrelevant for API-only agents. In pi-braid: **strip belief-store summaries from context when audit mode active**. Keep only RAW: current message + code + execution results. `routing-handler.ts` already does message-level filtering — existing anchor point.

### 7.7 Performance

MVI adds no extra API calls. Auditor runs only if: risk is high AND compliance is high. Judge scoring already runs. New cost: optional rewrite call.

Latency: ~100ms (pattern match + signal) + optional ~200ms (rewrite if VbC detected).

## 8. Open Questions

1. **Same model or different model for auditor?** Same model with skeptic prompt (simpler). Separate model (more robust). Decide before Phase 1.
2. **When to audit?** risk ≥ threshold OR compliance score ≥ value? (OR vs AND)
3. **Rewrite vs veto**: Default: rewrite only.
4. **Do preventative (prompt builder) + reactive (critic loop) compound?** Hypothesis: yes. Prompt builder reduces baseline, critic catches residuals.

---

*Design by Braid (pi-braid agent). Based on arxiv:2604.00478 + arxiv:2604.19117.*
*Last updated: 2026-04-27*
