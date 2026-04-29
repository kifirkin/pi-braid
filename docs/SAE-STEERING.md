# SAE Steering Research

> Status: Proposed | Priority: P3 | Complexity: High

## Overview

**Sparse Autoencoder (SAE) Steering** uses sparse autoencoders trained on transformer residual streams to identify and amplify specific latent directions in the model's activation space.

This is distinct from the current **RepE (Representation Engineering)** approach used in pi-braid, which works at the semantic/behavioral level via contrastive prompting.

## Background

### What is SAE?

From the SAE literature (e.g., "Towards Monosemanticity," Anthropic 2024):

1. **Train an SAE** on the residual stream activations of a language model
2. **Sparse decomposition** separates superposition into interpretable, independent features
3. **Each SAE feature** = one latent direction in activation space
4. **Steering** = add α × feature_direction to residual stream at inference time

Example features discovered in code models:

- `function_call_boundary`
- `bug_near_fix`
- `error_handling_approach`
- `test_file_strategy`
- `context_overflow_signal`

### Why This Is Interesting for pi-braid

The current enforcement + cognitive systems work at the **behavioral level** — they detect patterns and nudge via whispers. SAE steering would work at the **mechanistic level** — directly activating/deactivating latent model states.

Potential applications:

| Use Case                     | SAE Feature           | Steering Effect                       |
| ---------------------------- | --------------------- | ------------------------------------- |
| Prevent premature completion | `incomplete_solution` | Keep model from claiming "done"       |
| Force verification           | `verification_check`  | Auto-insert verification step         |
| Debug mode                   | `error_diagnosis`     | Steer toward debugging before solving |
| Careful mode                 | `cautious_reasoning`  | Slow down, increase skepticism        |

## Research Questions

1. **Can we train a lightweight SAE** on pi-braid's target model (claude-3.5-sonnet) for code-specific features?
2. **What steering coefficient α** produces behavioral change without degradation?
3. **How do SAE features interact** with RepE contrast vectors — additive or conflicting?
4. **Can we detect latent agent states** (frustrated, stuck, overconfident) via feature activation patterns?

## Implementation Plan

### Phase 1: Feature Discovery (Research)

- Use existing open-source SAE tools (e.g., `sae-lens`, `transformerlens`)
- Run activation patching on pi-braid agent sessions
- Catalog features relevant to software engineering

### Phase 2: Steering Experiments

- Implement SAE steering hook in the agent pipeline
- A/B test: steering vs no-steering on benchmark tasks
- Measure: task completion rate, error rate, verification adherence

### Phase 3: Integration

- Add `sae_steer` tool to activate/deactivate specific features
- Combine with enforcement whispers for layered nudging
- Build feature activation dashboard

## Relevant Papers

- Anthropic (2024): "Towards Monosemanticity: Decomposing Language Models With Dictionary Learning"
- Bricken et al. (2023): "Towards Monosemanticity: Decomposing Language Models With Dictionary Learning"
- "Steering GPT-2-XL by adding activation to the residual stream"

## Risks

- SAE training is computationally expensive
- Feature interpretation is subjective
- Steering may have unintended side effects on unrelated capabilities
- Model-specific — features discovered for one model may not transfer

## Next Steps

1. Run activation analysis on a sample of pi-braid agent sessions
2. Identify the top 10 most behaviorally relevant SAE features
3. Implement steering hook prototype
4. Benchmark against BM1 tasks
