# Skill Loading Research: Dynamic vs Static

**Date**: 2026-04-30  
**Based on**: Heartbeat-Driven (2604.14178), SkillX (2604.04804)  
**Problem**: Current system loads all skills at session start. This is primitive.

---

## Current pi-braid Skill System

**What's implemented**:
- `loadSkills()` from `@mariozechner/pi-coding-agent` (native)
- Skills loaded at `session_start` via `resources_discover`
- 13 bundled skills from `skills/` directory
- Activation based on keyword matching in task description

**What's primitive**:
1. **Static loading** — all skills loaded at session start regardless of task
2. **No hierarchy** — flat list of skills, no strategic/functional/atomic tiers
3. **No refinement** — skills don't update based on execution feedback
4. **No scheduling** — skills available continuously, not triggered by context
5. **Keyword-based** — simplistic activation, no semantic understanding

---

## Key Papers

### Heartbeat-Driven (2604.14178)

**Key insight**: "cognitive modules to be dynamically added or removed without structural reengineering"

```
Heartbeat scheduler decides WHEN to engage specific thinking activities:
- Recalling memories
- Summarizing experiences  
- Strategic planning

The scheduler learns to determine when to engage modules based on temporal patterns.
```

**Application to skills**:
- Skills should be scheduled like cognitive modules
- Trigger skills based on task phase (analysis vs implementation vs debugging)
- Remove skills when no longer relevant

### SkillX (2604.04804)

**Key insight**: Three-tier hierarchy + iterative refinement

```
Three-tier skill hierarchy:
1. Strategic Plans — high-level goal decomposition
2. Functional Skills — reusable task-solving procedures  
3. Atomic Skills — single tool operations

Iterative refinement:
- Execute skill → get feedback → revise skill based on success/failure
- Continuously improve library quality
- Proactively generate new skills to expand coverage
```

**Application to skills**:
- pi-braid skills should have tier hierarchy
- Monitor skill effectiveness → update or deactivate poorly performing skills
- Extract new skills from successful task completions

---

## Proposed Improvements

### Tier 1: Hierarchical Skill Organization

| Tier | Current | Proposed |
|------|---------|----------|
| Strategic | Flat list | Project-level guidance (e.g., "research mode", "debug mode") |
| Functional | Flat list | Task-specific workflows (e.g., "benchmark", "refactor", "document") |
| Atomic | N/A | Single-skill operations (e.g., "grep-pattern", "edit-exact") |

### Tier 2: Heartbeat-Scheduled Activation

```typescript
// Instead of loading all skills at session start:
// Schedule skills based on heartbeat events

interface SkillSchedule {
  skill: string;
  trigger: "task_start" | "turn_threshold" | "failure_detected" | "context_threshold";
  params: Record<string, unknown>;
  deactivateOn: "task_complete" | "idle_threshold" | "explicit";
}

// Example:
const schedule: SkillSchedule[] = [
  { skill: "debugging", trigger: "failure_detected", params: { count: 2 }, deactivateOn: "task_complete" },
  { skill: "benchmark", trigger: "task_start", params: { pattern: "benchmark*" }, deactivateOn: "task_complete" },
  { skill: "software-engineer", trigger: "task_start", params: {}, deactivateOn: "idle_threshold" }
];
```

### Tier 3: Execution Feedback Loop

```typescript
// Monitor skill effectiveness, refine over time

interface SkillEffectiveness {
  skill: string;
  activations: number;
  successRate: number;
  tokenCost: number;
}

// After each task:
// 1. Track which skills were used
// 2. Measure task success
// 3. Update effectiveness scores
// 4. Deactivate low-effectiveness skills
// 5. Extract new skills from successful complex tasks
```

---

## Research Questions

1. **Can skills be unloaded mid-session?**
   - Current: No evidence of dynamic unloading
   - Need to check pi API for `unloadSkill()` or equivalent

2. **Can heartbeat trigger skill activation?**
   - Heartbeat already runs in pi-braid
   - Need to wire skill activation to heartbeat events

3. **Can execution feedback update skill content?**
   - SkillX shows this is possible
   - pi-braid would need skill authoring capability

4. **What's the performance cost of loading all skills?**
   - 13 skills × ~100 lines each = 1300 lines in prompt
   - Selective loading could reduce token cost significantly

---

## Immediate Actions

1. [ ] Audit current skill loading: how many tokens do all skills add?
2. [ ] Check if pi API supports dynamic skill loading/unloading
3. [ ] Design heartbeat-triggered skill activation
4. [ ] Implement tier 1 (hierarchical organization)

---

## References

- Heartbeat-Driven (2604.14178): Proactive cognitive scheduling
- SkillX (2604.04804): Three-tier skill hierarchy + iterative refinement
- pi-braid skills: `pi-braid/skills/*/SKILL.md` (13 skills)