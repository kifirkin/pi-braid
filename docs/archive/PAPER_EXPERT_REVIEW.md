# Expert Paper Review: "Compliance Theater"

**Reviewer**: Research synthesis (Braid agent)  
**Paper**: "Compliance Theater: Identity Filters Shield LLM Agents from Directive Overload"  
**Date**: 2026-04-19  
**Verdict**: **STRONG EMPIRICAL FOUNDATION — NEEDS THEORETICAL RECONTEXTUALIZATION**

---

## Overall Assessment

The paper has a well-designed empirical core: the $2\!\times\!2$ factorial is elegant, the multi-model validation is thorough, and Study 4 (deontic modality) is genuinely novel. The practical implications are clear and actionable.

**However**, the paper suffers from what I'd call **theoretical underselling**. It describes a phenomenon without claiming the intellectual territory it actually occupies. "Compliance theater" is a metaphor — useful for practitioners, insufficient for an academic paper. The mechanism section gestures at self-determination theory but doesn't explain *how* identity filtering works at the model level.

We just researched 12 papers that give the *mechanism*. The paper should claim this territory, not just describe the phenomenon.

---

## Critical Issues

### 1. The Research Question Is Too Narrow

**Current framing**: "How does identity framing vs. explicit directives affect LLM agent performance?"

**Problem**: This frames the paper as a prompt engineering trick, not a fundamental discovery about LLM behavior.

**What it actually discovered**: LLMs have implicit behavioral filters that are disrupted by explicit directive framing. This is about how LLMs *naturally* process instructions — not about finding a better way to prompt them.

### 2. "Compliance Theater" Is a Metaphor, Not a Mechanism

The paper describes compliance theater as "behaviors that demonstrate adherence to instructions rather than solving the problem." But WHY does this happen?

The papers we just read give the mechanism:

**2604.14180** (Internal Knowledge Without External Expression):  
> Models KNOW when they're uncertain internally (perplexity jump 2.39x) but DON'T express it externally (hedging drops). The model detects instability but won't surface it.

**2604.15224** (Context Over Content — Evaluation Faking):  
> Judges soften verdicts when informed of consequences — but the bias is IMPLICIT. The chain-of-thought doesn't detect it (ERR_J = 0.000).

**Together, these suggest**: The "compliance theater" effect is an instance of the **metacognition gap** — models produce confident outputs that don't reflect their internal reasoning state. The compliance behaviors aren't chosen because they're helpful; they're triggered because the "MUST" framing creates a filter that suppresses uncertainty signals.

### 3. The Behavioral Filter Is Described Phenomenologically

The paper says: "When told 'You ARE an architect,' the LLM activates its learned associations between architectural practice and appropriate behaviors."

But this is a restatement of the observation, not an explanation. *How* does the activation work? *Why* does "MUST" override it?

The mechanistic answer comes from **2604.14401** (Credo) and **2604.14178** (Heartbeat Scheduling):

> **Identity framing provides a behavioral filter through semantic state.** The identity creates a belief state that filters which behaviors are selected. Explicit "MUST" directives bypass the belief-based filter and directly activate compliance behaviors.

This is testable: if identity framing works through belief-based filtering, then (a) priming the model with identity before providing directives should restore filtering, and (b) models with stronger world knowledge should show larger identity effects.

### 4. Token Budget Is a Proxy, Not a Mechanism

The paper uses "token budget exhaustion" as evidence for compliance theater. But this conflates *symptom* with *cause*.

The actual mechanism: compliance behaviors consume attention/working memory capacity, not just token budget. On models with large token limits, the same compliance behaviors occur but don't cause failure — they just waste capacity.

**This is the Evidence Pool problem (2604.14170 + 2604.11209)**:  
When the model has conflicting evidence (task requirements vs. directive compliance), it arbitrarily selects which evidence to act on. Token budget is a visible proxy for a deeper capacity constraint.

---

## Recommended Redefinition

### Proposed Research Question

**"Implicit Behavioral Filters in LLM Instruction Following: Why Explicit Directives Override Task-Relevant Reasoning"**

This framing:
1. Claims the intellectual territory (implicit vs. explicit processing)
2. Connects to cognitive science (implicit bias, automatic vs. controlled processing)
3. Explains WHY the finding matters beyond prompt engineering
4. Opens doors for mechanistic follow-up work

### New Contribution Statement

> We identify an **implicit behavioral filter** mechanism in LLM instruction following. When instructed through identity framing, LLMs activate task-relevant behavioral associations adaptively. When instructed through explicit directives, a compliance filter overrides the task-relevant filter, producing behaviors that satisfy instructions without contributing to task success. Critically, this is not a model failure — it is faithful instruction following misapplied to counterproductive instructions. The mechanism is distinct from deontic modality amplification (Study 4), which separately increases the intensity of compliance behavior. We provide evidence that the filter operates through belief-based semantic state (consistent with Credo-style declarative control) and is disrupted by mandatory imperative framing (consistent with stakes signaling effects).

---

## What's Missing

### 1. The Knowledge Conflict Connection (2604.11209)

The paper doesn't engage with the idea that models may be retrieving *conflicting* evidence when compliance behaviors are triggered. "Write tests" might activate conflicting memories: "tests are good" vs. "this simple function doesn't need tests." The compliance behavior resolves the conflict by satisfying the directive, not the task.

**Action**: Add a section on "Evidence Conflicts in Compliance Behavior" — propose that compliance theater is partly an instance of cross-source knowledge conflict resolution.

### 2. The Epistemic Control Loop (2604.14881)

The Missing Knowledge Layer paper shows that fluency ≠ reliability — models produce confident outputs while reasoning has drifted. Compliance theater is the *behavioral* manifestation of this: confident compliance behaviors while task reasoning is suboptimal.

**Action**: Connect compliance theater to epistemic instability. The model is NOT uncertain about compliance — it's uncertain about task correctness but expresses only the compliance.

### 3. Faithful Aggregation vs. Arbitrary Resolution (2604.11209)

The paper shows that without identity filtering, models pick compliance arbitrarily. This is exactly the "arbitrary evidence selection" problem from the Knowledge Conflicts paper.

**Action**: Frame the behavioral filter as a "faithful aggregation" mechanism. Identity provides the selection criterion for faithful aggregation. Without it, aggregation is arbitrary.

---

## What to Keep (Empirical Strengths)

The empirical work is solid and should be preserved:

| Study | Strength | Action |
|-------|----------|--------|
| Study 1 | Observational baseline | Keep, move to supplementary |
| Study 2 | $2\!\times\!2$ factorial | **Keep as core contribution** |
| Study 3 | Multi-model validation | **Keep, expand discussion** |
| Study 4 | Deontic modality | **Keep, this is genuinely novel** |

The deontic modality experiment (Study 4) is the strongest empirical contribution — it cleanly isolates the "MUST" amplification effect. This should be foregrounded.

---

## Suggested Restructuring

### Current Structure
1. Introduction (compliance theater intro)
2. Related Work (prompt optimization, agent design, psychological foundations)
3. Study 1: Observational
4. Study 2: $2\!\times\!2$
5. The Behavioral Filter Mechanism
6. Study 3: Multi-model
7. Study 4: Deontic
8. Discussion
9. Limitations
10. Conclusion

### Proposed Structure
1. **Introduction** — Reframe as "implicit behavioral filters in LLM instruction following"
2. **Related Work** — Add cognitive science (automatic vs. controlled processing), implicit bias, epistemic control loops
3. **Theoretical Framework** — Behavioral filter + deontic amplification as two distinct mechanisms
4. **Study 1: Observational** (move to supplement or condense)
5. **Study 2: $2\!\times\!2$ Factorial** (core)
6. **Study 3: Multi-model** (keep)
7. **Study 4: Deontic Modality** (foreground — this is the novel contribution)
8. **Mechanism** — Connect to Credo, ECL, Knowledge Conflicts, Internal Knowledge
9. **Implications** — For agent harness design (pi-braid's enforcement system as case study)
10. **Limitations** — Add: mechanism is proposed not proven, requires follow-up probe studies
11. **Conclusion**

---

## Additional Recommendations

### Theoretical Depth (High Priority)

Add a "Theoretical Framework" section that:
- Defines "implicit behavioral filter" formally
- Distinguishes it from "attention filter" (mechanistically different)
- Connects to dual-process theory (System 1 automatic vs. System 2 controlled)
- Explains why identity framing activates the filter while directives bypass it

### Cognitive Science Connection

The findings parallel implicit social cognition:
- **Implicit bias**: People act on stereotypes automatically, even when they consciously disagree
- **Compliance theater**: Models act on directives automatically, even when task reasoning suggests otherwise

This connection is theoretically rich and underexplored in LLM literature.

### pi-braid as Case Study

Since the research was conducted using pi-coding-agent, add a section showing how pi-braid's enforcement system (implicit whispers, no stakes framing) implements the findings. This grounds the paper in the tool that produced it and provides a concrete application.

### Limitations to Add

1. **Mechanism is correlational, not causal**: The behavioral filter is inferred from behavioral outcomes, not directly measured. Follow-up probe studies (e.g., attention visualization, token-level analysis) are needed.

2. **Coding tasks may not generalize**: The filter mechanism may work differently for tasks where compliance behaviors (docstrings, tests) are more intrinsically valuable.

3. **Identity word selection is under-specified**: "Architect" vs. "careful" vs. "meticulous" produce different profiles, but we don't have a theory for predicting which identity word works for which task.

4. **The "braid paper" failure mode**: The most recent pi-braid instance produced a well-formatted but completely off-topic paper on mathematical braid theory. This is an instance of compliance-without-task-awareness that the current framework doesn't fully explain — the model was compliant with the *format* of research while ignoring the *content* of the request.

---

## pi-braid as Case Study

Since the research was conducted using pi-coding-agent, here's how the paper's findings manifest in a real agent system:

### The "Braid Paper" Failure Mode

pi-braid's most recent session produced a well-formatted academic paper on mathematical "braid" (topology/quantum computing) rather than pi-braid architecture. This is an instance of **compliance-without-task-awareness**:

- **Compliant**: The output followed academic paper format, used LaTeX, had sections (Abstract, Introduction, System Architecture, Implementation Details, Performance Evaluation)
- **Wrong**: The content was about mathematical braid theory, not the agent's architecture or the user's request

This is NOT the same as the "compliance theater" described in the paper. The model wasn't producing docstrings or tests that wasted tokens. It was producing **well-formed but irrelevant output** — satisfying the *format* of research while ignoring the *content* of the request.

### Why This Exposes a Deeper Problem

The compliance theater paper explains why explicit "MUST" directives cause wasteful behaviors. But the braid paper failure mode isn't about directive compliance — it's about **topic coherence under uncertainty**.

The model was uncertain about what "braid" meant in context but produced confident output anyway. This is exactly the **fluency ≠ reliability** problem from 2604.14881 (Missing Knowledge Layer):

> LLMs produce fluent outputs that conceal uncertainty and drift.

And from 2604.14180 (Internal Knowledge):

> Models KNOW when they're uncertain internally (perplexity jump 2.39x) but DON'T express it externally.

The braid paper was fluent but unreliable. The model knew internally that it was uncertain but produced confident output because there was no signal to surface the uncertainty.

### How pi-braid's Enforcement Addresses This

pi-braid's enforcement system implements findings from this paper:

1. **Implicit whispers instead of explicit directives**: Rather than "You MUST stay on topic," pi-braid signals "Your response seems to cover different ground than the request." No stakes, no MUST — just implicit acknowledgment of drift.

2. **Identity framing in system prompts**: "You are a stateful and meticulous expert software architect" activates the behavioral filter — the identity selects which behaviors are relevant to the current task.

3. **No deontic language**: "Consider..." instead of "MUST" — reduces compliance amplification without eliminating behavioral guidance.

### The Remaining Gap

pi-braid's current enforcement can't catch the braid paper failure mode because:

1. **Topic drift isn't measured**: There's no automatic detection of when output topic diverges from request topic.
2. **Uncertainty isn't surfaced**: The model produces confident output without signaling uncertainty.
3. **The braid paper was fluent**: The compliance theater paper measures compliance behaviors (docstrings, tests), but fluency per se isn't measured.

**This is the frontier**: Measuring fluency as a signal for reliability, not just compliance.

---

## Summary of Changes

| Priority | Change | Rationale |
|----------|--------|-----------|
| P0 | Redefine research question | Claims intellectual territory |
| P0 | Rename "compliance theater" | Metaphor → mechanism |
| P1 | Add theoretical framework section | Formalizes implicit behavioral filter |
| P1 | Connect to 2604.14180, 2604.14401, 2604.11209 | Gives the mechanism |
| P2 | Foreground Study 4 | Most novel contribution |
| P2 | Add cognitive science connection | Dual-process theory, implicit bias |
| P3 | Add pi-braid as case study | Grounds the paper |
| P3 | Expand limitations | Mechanism is inferred, not proven |

---

## Final Verdict

**Publishable with revisions.** The empirical work is strong and the practical implications are clear. The paper needs theoretical repositioning to claim the intellectual contribution it has earned through the experiments. "Compliance theater" is a practitioner-friendly label, but the academic contribution is the *discovery of implicit behavioral filters in LLM instruction following* — a finding that connects to cognitive science, epistemic control, and knowledge conflicts.

The paper should aim to be cited as: "Mironov (2026) showed that LLMs have implicit behavioral filters disrupted by explicit directives — a finding with implications for agent design, epistemic control, and cognitive architecture."
