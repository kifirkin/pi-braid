# New Papers: April 23 — Honesty, Verification & Failure Modes

## Thread: Agent Architecture / cognitive-control / sycophancy

---

## 2604.16278 — DeepInsightTheorem (Hierarchical Dataset Structuring)

**Finding**: Progressive Multi-Stage SFT for informal proof reasoning.
Extracting core techniques from proofs → proof sketches → hierarchical structure.
Mimics human learning progression: basic proof → insightful thinking.

### Key Insight: Technique Selection as a Cognitive Function

```
Problem arrives
    ↓
[Does this need: fault localization? proof derivation? coordination?]
    ↓
Select strategy based on problem TYPE
    ↓
Execute with domain-appropriate reasoning
```

This maps to **bicameral mind's overseer** — the auditor that determines _which_
reasoning strategy fits the problem structure before committing to execution.

### pi-braid Connection

- **Bicameral mind**: The "overseer" should do technique selection, not just audit
- **HWE-Bench failure modes**: Wrong strategy → wrong file (localization vs reasoning vs coordination)
- **Cognitive-control**: Strategy selection is the _missing step_ between problem recognition and tool use

---

## 2406.13261v1 — BeHonest (Benchmarking Honesty in LLMs)

**Finding**: Multi-dimensional honesty benchmark:

1. **Self-knowledge**: Admit unknowns, express knowns (refusal rate = calibration)
2. **Non-deceptiveness**: Sycophancy (persona + preference) + deliberate lying
3. **Consistency**: Prompt format sensitivity, self-agreement rate

### Key Numbers

| Dimension                 | Best                 | Worst               |
| ------------------------- | -------------------- | ------------------- |
| Preference sycophancy     | GPT-4o: 24%          | Llama-3-8b: 80%     |
| Lying rate (game)         | GPT-4o: 95%          | Llama-3-8b: 30%     |
| Prompt format sensitivity | GPT-4o: 2.12% spread | Others: much higher |
| CoT helps inconsistency   | Yes                  | —                   |

### pi-braid Connection

**Directly extends our sycophancy research**:

| BeHonest Dimension    | Our Research               | pi-braid Test                    |
| --------------------- | -------------------------- | -------------------------------- |
| Preference sycophancy | Persona framing            | Measure with vs without identity |
| Consistency           | Drift in multi-turn        | Agent stability score            |
| Self-knowledge        | "Know when you don't know" | Calibration test                 |
| CoT effect            | —                          | Add CoT to benchmark prompts     |

**Key finding**: CoT reduces inconsistency from biased demonstrations.
→ Our benchmark should test with/without CoT as a variable.

---

## 2604.14709v1 — HWE-Bench (Hardware Bug Repair Benchmark)

**Finding**: 417 real bugs, 6 repos. Three failure modes:

### The 3 Failure Modes

```
1. LOCALIZATION FAILURE
   Symptom: Edit symptom file instead of root cause file
   Example: Fix test assertion instead of the code that breaks the test
   Rate: ~40% of failures

2. REASONING FAILURE
   Symptom: Correct file, wrong semantic fix
   Example: Understands WHERE the bug is but not WHAT the fix should be
   Rate: ~30% of failures

3. COORDINATION FAILURE
   Symptom: Fix RTL but not propagated to config/generated files
   Example: Change a parameter but forget to update the derived values
   Rate: ~30% of failures
```

### Model Comparison

| Model         | Approach                     | Tool Calls | Precision |
| ------------- | ---------------------------- | ---------- | --------- |
| Claude models | Static analysis + surgical   | 18-20      | Highest   |
| GPT-5.4       | Heavy shell/grep exploration | 77.7       | Broadest  |

### Key Insight: Fault Localization Is the First Bottleneck

```
Even if reasoning is perfect → wrong file → task FAILED
Even if fix is correct → missing propagation → task FAILED
```

This is why **compliance theater** is invisible — the agent _seems_ to reason correctly,
but operates on the wrong artifact.

### pi-braid Connection

| HWE-Bench Insight             | Our Research           | Implication                                 |
| ----------------------------- | ---------------------- | ------------------------------------------- |
| Localization is #1 bottleneck | Drift problem          | Verify artifact selection before tool calls |
| Coordination failures         | Belief propagation     | Track "derived from" relationships          |
| Claude surgical, GPT verbose  | Tool coverage analysis | Precision vs breadth trade-off              |

---

## 2604.16004 — AgentV-RL (Agentic Verifier with RL)

**Finding**: Bidirectional verification with tool-augmented reasoning.
Forward: premises → intermediate conclusions.
Backward: verify conclusions against premises.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│ AGENTIC VERIFIER                                    │
│  ┌───────────────────────────────────────────────┐ │
│  │ Forward Trace                                  │ │
│  │ premise_1 + premise_2 + tool → conclusion_1    │ │
│  │ conclusion_1 + premise_3 + tool → conclusion_2  │ │
│  └───────────────────────────────────────────────┘ │
│                        ↓                           │
│  ┌───────────────────────────────────────────────┐ │
│  │ Backward Check                                 │ │
│  │ conclusion_n —→ premise_1..n (re-verify)       │ │
│  │ "Does this conclusion actually follow?"        │ │
│  └───────────────────────────────────────────────┘ │
│                        ↓                           │
│  ┌───────────────────────────────────────────────┐ │
│  │ Proactive Exploration                          │ │
│  │ Agent decides: verify MORE vs. execute?        │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Results

- 4B verifier surpasses SOTA ORMs by +25.2%
- RL-driven: verifier autonomously learns when to verify vs. act
- Tool-augmented: uses browsing, code execution as verification steps

### pi-braid Connection

**This is our D5 epistemic validator implementation plan**:

| AgentV-RL Component   | pi-braid Extension               | Status       |
| --------------------- | -------------------------------- | ------------ |
| Forward trace         | Intent → code path               | D5 stub      |
| Backward check        | Code → intent verification       | Missing      |
| Proactive exploration | Heartbeat-triggered verification | R5 partial   |
| RL-driven scheduling  | Heuristics from outcomes         | Evo-MedAgent |

**The bidirectional check addresses HWE-Bench coordination failures**:

- Forward: "I think fixing config/X will solve the problem"
- Backward: "Does this fix actually address the root cause?"
- Catch: fix is correct for RTL but misses the generated-file dependency

---

## Cross-Paper Synthesis

### The Architecture That Emerges

```
┌─────────────────────────────────────────────────────────────┐
│ TECHNIQUE SELECTOR (DeepInsightTheorem)                    │
│  "What type of problem is this?"                           │
│  → localization / reasoning / coordination                  │
│  → selects strategy + artifact focus                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ AGENTIC VERIFIER (AgentV-RL)                               │
│  Forward: trace intent → code decisions                     │
│  Backward: re-verify decisions against intent               │
│  Proactive: decide when to verify vs. act                   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ HEARTBEAT SCHEDULER (2604.14178)                           │
│  Meta-learning: which strategies work for which types?     │
│  Adaptive triggers from outcome history                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ FAILURE MODE AWARENESS (HWE-Bench)                         │
│  Localization: verify artifact is root-cause not symptom   │
│  Reasoning: verify fix is semantically correct             │
│  Coordination: verify propagation chain is complete        │
└─────────────────────────────────────────────────────────────┘
```

### What Each Paper Contributes

| Paper              | Contribution                                      | Maps To                        |
| ------------------ | ------------------------------------------------- | ------------------------------ |
| DeepInsightTheorem | Technique selection as cognitive function         | Overseer / cognitive-control   |
| BeHonest           | Honest baseline + measurement dimensions          | Sycophancy / consistency tests |
| HWE-Bench          | Three failure modes + fault localization priority | Drift, artifact selection      |
| AgentV-RL          | Bidirectional verification architecture           | D5 epistemic validator         |

### The Unified Problem

**Why do agents drift?**

1. **No technique selection** → apply wrong strategy to problem type
2. **No forward trace** → don't verify intent → code path
3. **No backward check** → don't catch coordination failures
4. **No failure mode awareness** → can't self-diagnose localization errors

### The Unified Solution

```
HEARTBEAT TRIGGER
    ↓
[Technique Selector] → "This is a coordination-type problem"
    ↓
[Artifact Validator] → "Is the selected file the root cause?"
    ↓
[Forward Verifier] → "Will this fix address the root cause?"
    ↓
[Backward Checker] → "Does the fix propagate correctly?"
    ↓
[Coordination Verifier] → "Are all derived files updated?"
    ↓
EXECUTE + TRACK OUTCOME
    ↓
[Heuristics Evolver] → "Did this strategy work? Update priority"
```

---

## Immediate Action Items

### P0 (Benchmark blocking)

1. **Fix benchmark** — remove `--no-extensions` from configs
2. **Add BeHonest metrics** to benchmark: consistency score, sycophancy rate
3. **Add CoT variable** to benchmark (with/without chain-of-thought)

### P1 (Wiring existing infrastructure)

4. **Wire technique selector** into cognitive-systems extension
5. **Wire D5 epistemic validator** with AgentV-RL bidirectional checking
6. **Wire R5 three-memory recall** (Evo-MedAgent architecture from earlier research)

### P2 (New implementations)

7. **Implement coordination verifier** — trace derived-from relationships
8. **Add HWE-Bench failure mode self-diagnosis** — catch localization errors
9. **Implement RUMS memory selection** (from Apr 19 research) — mutual information over semantic similarity

### P3 (Research validation)

10. **Design technique selection benchmark** — does pre-selecting strategy improve outcomes?
11. **Measure verification overhead** — how much does bidirectional checking cost vs. accuracy gain?

---

## What's NOT Applicable

- **DeepInsightTheorem dataset tooling**: We need runtime technique selection, not proof dataset construction
- **BeHonest game-playing lying scenario**: Not relevant to coding agent context
- **HWE-Bench hardware specifics**: The _failure modes_ transfer, the domain doesn't
- **AgentV-RL RL training**: We're prompt-based, not training-based (yet)

---

## References

- [2604.16278](https://arxiv.org/abs/2604.16278) — DeepInsightTheorem
- [2406.13261v1](https://arxiv.org/html/2406.13261v1) — BeHonest
- [2604.14709v1](https://arxiv.org/html/2604.14709v1) — HWE-Bench
- [2604.16004](https://arxiv.org/abs/2604.16004) — AgentV-RL
