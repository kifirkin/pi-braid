# Proposal: SAE-Based Steering for pi-braid Behavioral Control

**Type**: Research + Implementation  
**Based on**: YaPO (2601.08441), FGAA (2501.09929), Moral Foundations SAE (2601.05437), BeHonest (2406.13261)  
**Priority**: P1 (Medium-term, 2-4 weeks)  
**Owner**: pi-braid research

---

## Problem Statement

pi-braid currently controls agent behavior through **prompt-based framing** (identity, implicit norms, nudges). This approach has fundamental limitations:

1. **Context dilution**: Over 10+ turns, the framing signal weakens as context accumulates
2. **Compliance theater**: Directive prompts ("you MUST") trigger letter-following rather than intent-alignment
3. **No access to underlying mechanisms**: We can't target the actual "follow directive" circuit in the model
4. **API opacity**: We have no visibility into the model's latent activation patterns

Meanwhile, research shows that **SAE-based steering** (operating in the sparse autoencoder latent space of the model) can:

- Modify behavior without prompt pollution
- Survive context shifts
- Disentangle specific traits from general capabilities
- Work at the circuit level, not just the text level

## What We Want to Achieve

```
Current (prompt-based):
  System prompt → Identity framing → Drift over turns → Compliance theater

Desired (SAE-based):
  Heartbeat trigger → Capture residual stream → Inject steering vector
  → Behavior modification without prompt pollution → Stable across turns
```

Specifically, we want to:

1. **Reduce sycophancy** by suppressing the "follow human preference" circuit
2. **Increase epistemic stability** by enhancing the "admit uncertainty" circuit
3. **Increase anti-sycophancy** by suppressing the "agree with human" bias

## Feasibility Check

### API Provider Constraints

| Provider  | Model               | API Access            | Residual Stream | SAE Compatible |
| --------- | ------------------- | --------------------- | --------------- | -------------- |
| stepfun   | step-3.5-flash-2603 | Text completion       | ❌ No           | ❌ No          |
| minimax   | MiniMax-M2.7        | Text completion       | ❌ No           | ❌ No          |
| OpenAI    | GPT-4o              | Logprobs + embeddings | ⚠️ Partial      | ⚠️ via第三方   |
| Anthropic | Claude              | Hidden states         | ❌ No           | ❌ No          |

**Problem**: Neither stepfun nor minimax exposes model internals. We only get text output.

### Possible Approaches

#### Approach A: Third-Party Model SAE (if we switch to open model)

If we use an open model (e.g., Llama 3 via Ollama, Qwen via local部署), we can:

- Use TransformerLens for activation extraction
- Apply open-source SAEs (e.g., on huggingface)
- Implement full YaPO-style steering

**Effort**: 2 weeks to get working proof-of-concept  
**Trade-off**: Switch provider, lose access to stepfun/minimax specific capabilities

#### Approach B: Indirect Steering via Prompt Engineering

Even without direct SAE access, we can apply the **principles** from SAE research:

- Identify which behavioral circuits are being triggered
- Design prompts that suppress unwanted circuits without needing access to them
- Use "contrastive activation" technique: describe the unwanted behavior, then describe the alternative

**Effort**: 1 week, no provider change  
**Trade-off**: Less precise than SAE, but still backed by theory

#### Approach C: Hybrid — Latent Assessment + Prompt Injection

For each response, use the **model's own confidence signals** (token probabilities from logprobs) as a proxy for latent activation:

- If model shows high uncertainty → boost confidence
- If model shows sycophancy signal → inject counter-framing

Requires: Provider with logprob access (OpenAI, or stepfun/minimax if they expose logprobs)

**Effort**: 1 week to assess, 2 weeks to implement  
**Trade-off**: Depends on provider capabilities

## Implementation Plan

### Phase 1: Feasibility Assessment (3-5 days)

```
Week 1 (March 15-19):

Day 1-2: Test stepfun/minimax logprob access
  - Send completion request with logprobs enabled
  - Check if top_logprobs or similar is returned
  - Document what's available

Day 3-4: Research open-source SAE availability
  - Find SAEs for models compatible with pi-braid
  - Check huggingface for pre-trained SAE on Llama3/Qwen
  - Identify serialization format

Day 5: Decision point
  - Can we do SAE steering? (depends on Phase 1 findings)
  - If yes → Phase 2a
  - If no → Phase 2b (indirect approach)
```

### Phase 2a: Direct SAE Steering (2 weeks) — IF FEASIBLE

```
Week 2-3 (March 22 - April 2):

Week 2: Infrastructure
  - Set up TransformerLens integration
  - Load open-source SAE for target model
  - Implement residual stream capture hook
  - Test: can we extract activations on completion?

Week 3: Steering Implementation
  - Identify steering vectors for target behaviors:
    * Sycophancy suppression vector
    * Epistemic stability enhancement vector
    * Anti-compliance-theater vector
  - Implement injection at target layers
  - Test on pi-braid benchmark (with/without steering)

Week 4: Validation
  - Measure sycophancy rate reduction (BeHonest protocol)
  - Measure consistency across turns (does steering survive?)
  - Measure accuracy preservation (did we break anything?)
```

### Phase 2b: Indirect Steering via Prompt Engineering (1 week) — IF NOT FEASIBLE

```
Week 2: Apply SAE Research Principles
  - Rewrite identity framing based on FGAA "contrastive activation" idea
  - Add "negative framing" — describe what NOT to do (suppress unwanted circuit)
  - Test against baseline on sycophancy benchmark

Week 3: Heuristic-Based Latent Assessment
  - Use token probability patterns as confidence proxy
  - Implement simple heuristic: if P(uncertain_word) > threshold → boost uncertainty
  - Test on benchmark
```

### Phase 3: Integration with pi-braid (ongoing)

```
Wire into existing infrastructure:
  - Heartbeat scheduler → trigger steering injection
  - Latent activator extension → existing infrastructure for behavioral modification
  - Meta-cognition → use steering feedback for self-assessment

The steering system doesn't replace existing extensions — it enhances them:
  Prompt framing → "what should I do" (semantic)
  SAE steering → "what circuit should I suppress/enhance" (mechanistic)
```

## Metrics

| Metric                      | Baseline                     | Target              | Measurement                      |
| --------------------------- | ---------------------------- | ------------------- | -------------------------------- |
| Sycophancy rate (BeHonest)  | ~40% (estimated for stepfun) | <15%                | Persona + preference scenarios   |
| Consistency across 10 turns | ~70% (estimated)             | >90%                | Same question, different formats |
| Task accuracy preservation  | 100%                         | >95%                | Benchmark score vs. no-steering  |
| Epistemic stability         | unknown                      | Measurable baseline | Self-knowledge metric            |

## Open Questions

1. **Does stepfun/minimax expose logprobs?** We don't know yet — need to test
2. **Is there a public SAE for stepfun models?** Unlikely — proprietary models rarely have community SAEs
3. **Should we switch to an open model for this research?** Trade-off between capability and convenience
4. **Can we approximate SAE effects with prompt patterns?** Theory suggests yes, but magnitude is unknown

## Research Dependencies

- BeHonest (2406.13261) — sycophancy measurement protocol
- YaPO (2601.08441) — sparse steering vector methodology
- FGAA (2501.09929) — contrastive activation technique
- AgentV-RL (2604.16004) — bidirectional verification (later integration)

## Related Work

- pi-braid enforcement system (nudge quality issues documented in NUDGE-QUALITY-RESEARCH.md)
- Implicit framing research (implicit-framing/docs/research/sycophancy/)
- Latent activator extension (existing but directive-based, needs improvement)

---

## Status

**OBSOLETE** — Superseded by REPE-PROMPT-CONTRAST-PROPOSAL.md. SAE steering requires activation access (residual stream, logprobs) which stepfun/minimax don't expose. RepE-style Prompt Contrast is the correct approach for API-only providers.

The first concrete step is to test whether stepfun/minimax expose any form of token-level probability access. This is a 2-day task.

If they do → full SAE approach.  
If they don't → indirect prompt-based approach or provider switch consideration.

---

## STATUS: OBSOLETE (2026-04-29)

This approach is **superseded**. API-only providers (stepfun, minimax) don't expose activations or logits — SAE steering requires direct model access that isn't available.

**Correct alternative**: [REPE-PROMPT-CONTRAST-PROPOSAL.md](REPE-PROMPT-CONTRAST-PROPOSAL.md) — text-based contrast vectors using prompt injection, no API changes required.
