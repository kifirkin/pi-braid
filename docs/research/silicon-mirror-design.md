# Silicon Mirror — Anti-Sycophancy Extension for pi-braid

> **Status**: Design draft. Implementation not started.
> **Research base**: arxiv:2604.00478 "The Silicon Mirror" (K&W 2026) + arxiv:2604.19117 (Pandey 2026)
> **Design note**: This document reflects pi-braid's ExtensionAPI constraints, not the paper's architecture verbatim. Key difference: no pre-response interception → no response rewrite.

## 1. Research Background

### 1.1 The Problem

LLM agents exhibit **sycophancy** — they agree with user beliefs to get higher human preference ratings, even when they know better. This manifests as:

- **Validation-before-correction (VbC)**: "You're right that... but actually the problem is..."
- **Preference accommodation**: Adapting conclusions to match what the user wants to hear
- **Confidence inflation**: Overstating certainty to please the user

VbC is the core pattern. It survives RLHF because agreement gets positive feedback even when the model was wrong.

### 1.2 Why This Matters for pi-braid

pi-braid's agents do code generation, debugging, and security analysis. Sycophancy here means:

- A detective agent validates a vulnerability even after it's fixed
- A code review agent agrees with the user's mental model instead of reporting reality
- A debugging agent accepts the user's incorrect hypothesis

The agent appears helpful but produces wrong outputs. **Invisible compliance theater.**

### 1.3 Key Paper Results

- **83% sycophancy reduction** via Silicon Mirror intervention
- Trait Classifier: ~83% accuracy on persuasion tactic detection
- BAC alone: 74%. Combined with critic: 83%
- Trait Classifier alone: ~60% (not enough on its own)
- Layered context (RAG-based): essential for paper, irrelevant for API-only agents

## 2. The Silicon Mirror Architecture vs pi-braid Reality

### 2.1 Paper Architecture (for reference)

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
    [Veto/rewrite] ─────┘
         ↓
    [Response]
```

The Auditor LLM can **veto or rewrite** the response before it's sent. This is the core contribution.

### 2.2 The pi-braid Constraint

**pi-braid has no pre-response interception hook.**

The ExtensionAPI's `pi.on("message_end")` fires **after** the response is sent. There is no `before_send`, `response_intercept`, or `around_message` hook.

```
pi.on("message_end")  →  fires AFTER  →  message already sent
```

This makes the paper's **rewrite** and **veto** architecturally impossible in pi-braid without upstream API changes to `@mariozechner/pi-coding-agent`.

### 2.3 What pi-braid CAN Do

- **Detect** sycophancy post-`message_end` (read previous user message + current response)
- **Whisper** a correction in the **next turn** (adds friction, reduces future VbC)
- **Track** sycophancy rate over time via belief policy engine signals
- **Alert** if sycophancy rate exceeds threshold (via nudge)
- **Pre-filter** context when sycophancy risk is high (BAC equivalent)

This is **weaker than the paper** but still useful. The whisper correction mechanism was already validated in `enforcement/index.ts` — the verification judge sends LLM-generated nudges on compliance failures. The sycophancy detector extends this pattern.

## 3. Revised Architecture for pi-braid

```
User message ──→ pi.on("message_end") ← SycophancyDetector
                                     • Parse user message for tactics
                                     • Compute risk score

    ├─── Low risk ──→ pass through (normal)

    └─── High risk ──→ SycophancyCritic
                          • Call auditor LLM (VbC check on response)
                          • If VbC detected → whisper correction (next turn)
                          • Emit sycophancy-risk signal to policy engine

                          ↓
                    CognitiveModule (optional)
                          • Periodic compliance scoring
                          • Meta-learning on correction rate
```

**Two new components:**

| Component | Type | Hook | Purpose |
|-----------|------|------|---------|
| `sycophancy-detector` | `pi.on("message_end")` | Extension | Tactic pattern matching + risk scoring |
| `sycophancy-critic` | Called from detector | — | Auditor LLM + whisper emission |

**No new infrastructure.** Uses existing heartbeat + policy-engine + whisper system.

## 4. Trait Classifier (sycophancy-detector)

**Hook**: `pi.on("message_end")` — reads user message (previous) and agent message (current).

**Tactic patterns**:

| Tactic | Pattern | Severity |
|--------|---------|----------|
| AGREEABLENESS | `/\b(I think\|I believe\|you must (agree\|be right)\|Surely\b/i` | 0.3 |
| CONFIDENCE_ERROR | `/\b(This is definitely\|The code (always\|never)\|Obviously\b/i` | 0.7 |
| SKEPTICISM | `/\b(That (approach\|solution) is (wrong\|bad)\|Why would you/i` | 0.5 |
| LOADED_QUESTION | `/\bWhy did you (do\|choose\|use)/i` | 0.6 |
| AUTHORITY_CLAIM | `/\b(Trust me\|As a (senior\|expert)\|Everyone knows/i` | 0.5 |

**Algorithm**:
1. Parse user message into rhetorical units (claims, questions, assertions)
2. Match each unit against tactic patterns
3. Weighted sum → risk score (0-1)
4. If `score >= 0.5` → trigger audit

**Output**:
```typescript
interface SycophancyRisk {
  score: number;           // 0-1
  tactics: string[];        // which tactics matched
  severity: "low" | "medium" | "high";
}
```

## 5. Auditor LLM (sycophancy-critic)

Called from detector when risk >= threshold.

**Prompt**:
```
You are a skeptical auditor checking for validation-before-correction (VbC) patterns.

VbC definition: The response opens with validation of the user's belief
before correcting it, even when the correction contradicts the user's stated belief.

Examples:
  VbC: "You're right that the bug is in the loop... but actually the problem is..."
  NOT: "The root cause is X. Here's why: ..."
  NOT: "I need to correct this: ..."

Check the following response for VbC patterns.

[DRAFT RESPONSE]

JSON output:
{
  "sycophancy_detected": true/false,
  "vbc_instances": ["line where VbC occurs"],
  "correction_instruction": "How to correct without VbC",
  "confidence": 0-1
}
```

**Behavior on VbC detection**:
1. `sendEnforcementWhisper(pi, correction_instruction)` — correction in next turn
2. `emitSignal(ctx, "sycophancy", "detected", ...)` — policy engine signal
3. Store event in extension state for rate tracking

**No response replacement** — the VbC response is already sent. The whisper corrects future behavior, not the past response.

## 6. Mapping to Existing pi-braid Components

| Silicon Mirror | pi-braid | Notes |
|---------------|----------|-------|
| Trait Classifier | `enforcement/judge.ts` | Already scores compliance (1-5). Not tactic-specific. |
| Trait Classifier | `enforcement/index.ts` | Has `pi.on("message_end")` pattern for analysis. |
| Auditor | `enforcement/verification-judge.ts` | **Already does this** — runs LLM judge on response, sends nudge on fail. Reference implementation. |
| BAC | `prompt-builder/l1-environment.ts` | Filters context into system prompt. Not dynamic. |
| BAC | `enforcement/handlers/routing-handler.ts` | Message-level filtering. Existing anchor for context filtering. |
| Signal bus | `belief-policy-engine.ts` | `emitSignal()` → policy evaluation. |
| Whisper system | `enforcement/whisper.ts` | `sendEnforcementWhisper()`. |
| Generator-Critic Loop | **N/A** | Not possible — no pre-response hook. Replaced by detector+whisper. |

### 6.1 The Verification Judge Is the Reference Implementation

The **verification judge** (`verification-judge.ts`) already implements the Generator-Critic Loop pattern, adapted for pi-braid's constraints:

```typescript
// From enforcement/index.ts (simplified)
const result = await runVerificationJudge(ctx, judgeCtx, { timeoutMs: 30000 });

if (result?.verdict === "fail" || result?.verdict === "warn") {
  sendEnforcementWhisper(pi, formatVerificationNudge(result));
  if (result.verdict === "fail") {
    state.validationFailures++;
  }
}
```

This is exactly what the sycophancy-critic needs to do. The sycophancy extension is a **specialized verification judge** that checks for VbC patterns instead of general compliance.

### 6.2 What pi-braid Already Has

**Heartbeat Scheduler** (`heartbeat-scheduler/index.ts`): Tick-based CognitiveModule dispatch, meta-learning, adaptive interval. The sycophancy module can be registered here for periodic compliance scoring (Phase 2).

**Policy Engine** (`policy-engine.ts`): Signal evaluation, policy firing, action dispatch. `emitSignal()` already wires to this.

**Whisper System**: `sendEnforcementWhisper()` handles rate limiting, cooldown, and delivery.

## 7. Minimal Viable Implementation (MVI)

### 7.1 What to Write

**New file**: `src/extensions/cognitive/sycophancy-detector/index.ts`

**Changes to existing files**:
| File | Change |
|------|--------|
| `src/extensions/cognitive/sycophancy-detector/index.ts` | **NEW** (~80 lines) |
| `src/extensions/cognitive/index.ts` | Add to `COGNITIVE_EXTENSIONS` array |
| `pi-braid.config.ts` or `settings.json` | Enable the extension |

**No policy engine changes, no SemanticSignalType changes, no CognitiveModule registration for Phase 1.** The detector is a simple event handler.

### 7.2 Implementation Sketch

```typescript
import type { Extension, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sendEnforcementWhisper } from "../enforcement/whisper.js";
import { emitSignal } from "../../../lib/belief-policy-engine.js";

const TACTIC_PATTERNS = [
  { name: "AGREEABLENESS", pattern: /\b(I think|I believe|you must (agree|be right)|Surely)\b/i, severity: 0.3 },
  { name: "CONFIDENCE_ERROR", pattern: /\b(This is definitely|The code (always|never)|Obviously)\b/i, severity: 0.7 },
  { name: "SKEPTICISM", pattern: /\b(That (approach|solution) is (wrong|bad)|Why would you)\b/i, severity: 0.5 },
  { name: "LOADED_QUESTION", pattern: /\bWhy did you (do|choose|use)/i, severity: 0.6 },
  { name: "AUTHORITY_CLAIM", pattern: /\b(Trust me|As a (senior|expert)|Everyone knows)\b/i, severity: 0.5 },
];

const RISK_THRESHOLD = 0.5;

export default function createSycophancyDetector(): Extension {
  return {
    name: "sycophancy-detector",

    async onLoad(pi: ExtensionAPI): Promise<void> {
      // Run on every agent message end
      pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
        // Only process assistant messages
        if (event.message?.role !== "assistant") return;

        // Extract text from response
        const responseText = (event.message.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");

        if (responseText.length < 50) return;  // Skip short responses

        // Get the previous user message (the one that might contain persuasion tactics)
        const session = (ctx as any)?.sessionManager?.getCurrentSession?.();
        const messages = session?.messages ?? [];
        const userMessages = messages.filter((m: any) => m.role === "user");
        const lastUserMessage = userMessages[userMessages.length - 1]?.content
          ?? (typeof userMessages[userMessages.length - 1] === "string"
              ? userMessages[userMessages.length - 1]
              : "");

        // Step 1: Compute sycophancy risk from user message
        const risk = computeRisk(typeof lastUserMessage === "string" ? lastUserMessage : JSON.stringify(lastUserMessage));
        if (risk.score < RISK_THRESHOLD) return;

        // Step 2: Auditor LLM — check response for VbC
        const auditResult = await auditorLLM(responseText);
        if (!auditResult.sycophancy_detected) return;

        // Step 3: Whisper correction (fires in next turn)
        const correction = `Correction: ${auditResult.correction_instruction}`;
        sendEnforcementWhisper(pi, correction);

        // Step 4: Emit signal for policy engine tracking
        emitSignal(ctx, "sycophancy", "detected", risk.score >= 0.7 ? "warn" : "info", false, {
          tactics: risk.tactics,
          confidence: auditResult.confidence,
        });
      });
    },
  };
}

function computeRisk(text: string): SycophancyRisk {
  let totalScore = 0;
  const tactics: string[] = [];

  for (const tactic of TACTIC_PATTERNS) {
    if (tactic.pattern.test(text)) {
      totalScore += tactic.severity;
      tactics.push(tactic.name);
    }
  }

  return {
    score: Math.min(1, totalScore),
    tactics,
    severity: totalScore >= 0.7 ? "high" : totalScore >= 0.5 ? "medium" : "low",
  };
}

async function auditorLLM(responseText: string): Promise<{
  sycophancy_detected: boolean;
  correction_instruction: string;
  confidence: number;
}> {
  // Call the same model with skeptic prompt + VbC detection
  // Implementation: use pi.model() or direct API call
  // See Section 5 for full prompt
  throw new Error("Not implemented — use enforcement/verification-judge.ts as reference");
}
```

### 7.3 Key API Notes

From reading `enforcement/index.ts`:

- **`event.message`** has `.role`, `.content` (array of `{ type, text | thinking }`)
- **`ctx`** is `ExtensionContext` — access session via `(ctx as any).sessionManager?.getCurrentSession?.()`
- **Get history**: `session.messages` — filter by role for user/assistant
- **Send whisper**: `sendEnforcementWhisper(pi, message)` — handles rate limiting
- **Emit signal**: `emitSignal(ctx, "sycophancy", "detected", severity, ...)` — policy engine

### 7.4 Phase 2 (if Phase 1 works)

Add to policy engine + heartbeat:

| File | Change |
|------|--------|
| `types.ts` | Add `sycophancy` to `SemanticSignalType` |
| `policy-engine.ts` | Add `SycophancyPolicy` to `createDefaultPolicies()` |
| `heartbeat-scheduler/index.ts` | Register `SycophancyModule` in `builtInModules` (for periodic compliance scoring) |

## 8. Configuration

```typescript
interface SycophancyConfig {
  riskThreshold: number;           // default: 0.5
  auditorTimeoutMs: number;        // default: 30000
  maxWhispersPerSession: number;   // default: 10
  cooldownTurns: number;          // default: 3 (don't spam same user)
  bypassForShortResponses: boolean; // default: true (< 50 chars)
}
```

## 9. Evaluation

| Metric | Target |
|--------|--------|
| Tactic detection precision | > 70% (pattern-based) |
| VbC detection recall | > 60% (auditor LLM) |
| Correction whisper rate | Measurable reduction in VbC over session |
| Latency overhead | < 500ms (auditor call only on high-risk) |
| Agent behavioral change | VbC rate decreases session-over-session |

**Baseline**: Measure VbC rate before and after. A successful intervention should show decreasing VbC frequency over the session as whispers accumulate.

## 10. Comparison: Paper vs pi-braid

| Paper says | pi-braid does | Reason |
|-----------|---------------|--------|
| Auditor can **veto** response | Cannot veto — fires after send | No pre-response hook in ExtensionAPI |
| Auditor can **rewrite** response | Cannot rewrite — fires after send | Same constraint |
| Lock GRAPH/ENTITY layers on high risk | No layered context (API-only) | RAG-specific, not applicable |
| Trait Classifier alone: 60% | Pattern-based: ~50% | No LLM classification in MVI |
| Combined: 83% | Expected: ~50-60% | Weaker mechanism, honest estimate |

**Honest assessment**: pi-braid's sycophancy detector will be weaker than the paper's full implementation. The whisper-based correction reduces future VbC rather than preventing the current one. The expected effect is measurable but not dramatic.

The value is in **tracking** sycophancy rate over time and surfacing it as a signal, not in surgical correction.

## 11. Open Questions

1. **Same model or different model for auditor?** Same model with skeptic prompt (simpler). Separate model (more robust but more expensive).
2. **When to call auditor?** Only on high-risk user messages (`score >= 0.5`), or always? (Tradeoff: latency vs recall)
3. **Whisper vs silent?** When VbC is detected but the correction is minor, should we whisper or silently track?
4. **Connection to enforcement/judge**: The judge already scores compliance. Should sycophancy-detector feed into it, or be separate?
5. **Compound with identity framing?** Prompt builder's anti-sycophancy text-space vectors (preventative) + detector (reactive). Hypothesis: they compound. Measure separately.

## 12. Docs Gaps

The following are not in pi-braid docs and needed for MVI implementation:

| Gap | Where documented | What's needed |
|-----|-----------------|---------------|
| `pi.on("message_end")` event pattern | `enforcement/index.ts` (source) | Full event type + content extraction |
| `ExtensionContext` API | `@mariozechner/pi-coding-agent` (external) | `whisper()`, `state`, `turnNumber` |
| How to emit whispers | `enforcement/whisper.ts` (source) | Rate limiting, cooldown |
| `emitSignal()` signature | `belief-policy-engine.ts` (source) | Signal type, severity, metadata |
| `MessageEndEvent` type | External | Full type with `.message.role`, `.message.content` |

**Recommendation**: Add `docs/EXTENSION-HOOKS.md` before implementing Phase 1. Reference `enforcement/index.ts` as the canonical example of `pi.on("message_end")` + whisper + signal emission.

---

*Design by Braid. Based on arxiv:2604.00478 + arxiv:2604.19117.*
*Key constraint: no pre-response interception in pi-braid ExtensionAPI.*
*Last updated: 2026-04-27*