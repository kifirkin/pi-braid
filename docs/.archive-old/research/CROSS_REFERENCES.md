# Cross-Thread References

**Purpose**: How the 6 research threads interconnect

---

## The Dependency Graph

```
implicit-framing
      │
      ├──▶ cognitive-control (ECL gives mechanism)
      │         │
      │         ├──▶ agent-architecture (beliefs drive policies)
      │         │
      │         └──▶ measurement (entropy detection)
      │
      ├──▶ measurement (stakes signaling detection)
      │
      └──▶ knowledge-conflicts (arbitrary resolution)
                │
                └──▶ context-engineering (evidence pool)
                          │
                          └──▶ all threads (shared evidence)
```

---

## Thread → Thread Dependencies

### implicit-framing → cognitive-control

**How**: ECL (2604.14178) explains HOW implicit signals work

- Identity framing activates beliefs (Credo-style)
- Beliefs trigger cognitive modules (Heartbeat-style)
- Whisper is the signal, not the mechanism

**Connection document**: `cognitive-control/synthesis.md`

### cognitive-control → measurement

**How**: Measurement feeds into scheduling decisions

- Entropy detection (2604.14528) triggers heartbeat
- Stability metrics decide which modules to activate
- Drift detection decides when to intervene

**Connection document**: `measurement/synthesis.md`

### cognitive-control → agent-architecture

**How**: Declarative policies drive evolution

- Credo beliefs → SEPL assessment criteria
- Heartbeat scheduling → when to propose evolution
- Policy evaluation → evolution decision

**Connection document**: `agent-architecture/synthesis.md`

### knowledge-conflicts → context-engineering

**How**: Evidence pool needs source tracking

- Conflict detection requires source labels
- Faithful reasoning requires evidence structure
- Deficiency analysis uses evidence pool

**Connection document**: `context-engineering/synthesis.md`

---

## THE PAPER → All Threads

The compliance theater paper connects to all threads:

| Thread              | Connection                                        |
| ------------------- | ------------------------------------------------- |
| implicit-framing    | Core finding: identity > directives               |
| cognitive-control   | ECL explains mechanism                            |
| measurement         | How to measure compliance success                 |
| knowledge-conflicts | Arbitrary evidence selection = compliance theater |
| context-engineering | Evidence pool prevents conflicts                  |
| agent-architecture  | Self-evolution prevents drift                     |

---

## Concrete Cross-Thread Implementations

### 1. Topic Drift Detection (measurement → implicit-framing)

```
measurement/entropy-detection.ts
    ↓
    Detects topic drift (anchor overlap < 0.5)
    ↓
implicit-framing/whisper.ts
    ↓
    Sends minimal whisper: "Your response seems to cover different ground."
    ↓
cognitive-control/heartbeat.ts
    ↓
    Adjusts module activation based on drift pattern
```

### 2. Evidence Pool (context-engineering → knowledge-conflicts)

```
context-engineering/evidence-pool.ts
    ↓
    Source tracking (tool_call, memory, system_prompt)
    ↓
knowledge-conflicts/source-tracking.ts
    ↓
    Detects cross-source conflicts
    ↓
implicit-framing/faithful-aggregation.ts
    ↓
    Acknowledges conflict, doesn't suppress
```

### 3. MARS Reflection (cognitive-control → agent-architecture)

```
cognitive-control/heartbeat-scheduler.ts
    ↓
    Fires when pattern changes detected
    ↓
agent-architecture/autogenesis.ts
    ↓
    Proposes → Assesses → Commits evolution
    ↓
measurement/drift-detection.ts
    ↓
    Verifies evolution improved stability
```

---

## Papers That Span Threads

### 2604.14180 Internal Knowledge

- **cognitive-control**: Models know but don't express
- **measurement**: Entropy proxy for internal uncertainty
- **implicit-framing**: Compliance is confident output while reasoning is uncertain

### 2604.14525 Cross-Query Contradictions

- **measurement**: Metrics (contradiction density, revision cost)
- **knowledge-conflicts**: Conflict detection algorithm
- **agent-architecture**: Assessment criteria for evolution

### 2604.11209 Knowledge Conflicts (XoT)

- **knowledge-conflicts**: Core framework
- **context-engineering**: Evidence pool structure
- **implicit-framing**: Compliance theater = arbitrary evidence selection

---

## Implementation Order

1. **Start**: implicit-framing + measurement
   - Topic drift detection connects them directly
   - Can test without complex infrastructure

2. **Then**: cognitive-control + knowledge-conflicts
   - Heartbeat builds on drift detection
   - Evidence pool enables conflict detection

3. **Finally**: agent-architecture + context-engineering
   - Depend on earlier threads
   - More complex, can learn from earlier experiments

---

## Status Tracking

| Connection                                | Document                           | Status      |
| ----------------------------------------- | ---------------------------------- | ----------- |
| implicit-framing → cognitive-control      | `cognitive-control/synthesis.md`   | ✅ Complete |
| implicit-framing → measurement            | `measurement/synthesis.md`         | ✅ Complete |
| cognitive-control → measurement           | `measurement/synthesis.md`         | ✅ Complete |
| cognitive-control → agent-architecture    | `agent-architecture/synthesis.md`  | ✅ Complete |
| knowledge-conflicts → context-engineering | `context-engineering/synthesis.md` | ✅ Complete |
| THE PAPER → all threads                   | `paper/expert-review.md`           | ✅ Complete |
