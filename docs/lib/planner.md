# lib/planner.ts

**Purpose**: Plan-Execute-Review cycle — provides strategic planning before execution with adaptive replanning. Based on the SUPER_AGENT_GAP_ANALYSIS.

## Plan Structure

```typescript
{
  id: string,
  goal: string,
  steps: PlanStep[],
  status: PlanStatus,        // planning → executing → reviewing → completed | adapted | failed
  currentStepIndex: number,
  createdAt: number,
  completedAt?: number,
}
```

Each step:
```typescript
{
  id: string,
  description: string,
  type: StepType,             // information | action | decision | verification
  dependencies: string[],     // step IDs that must complete first
  expectedOutcome: string,
  status: StepStatus,         // pending → in_progress → completed | failed
}
```

## Key Functions

| Function | Description |
|----------|-------------|
| `createPlan(goal, steps, ctx?)` | Create a new plan from goal + step list |
| `executePlan(planId, ctx?)` | Start executing a plan |
| `completeStep(planId, stepId, result?)` | Mark step as completed |
| `failStep(planId, stepId, error?)` | Mark step as failed (triggers replanning) |
| `getPlanStatus(planId)` | Get current plan progress |
| `adaptPlan(planId, newSteps)` | Replan from current position |
| `reviewPlan(planId)` | Review and evaluate completed plan |

## Key Patterns

- **Dependency-aware**: Steps declare dependencies (other step IDs). `executePlan` respects these — won't start a step until its dependencies are done.
- **Adaptive replanning**: When a step fails, `adaptPlan` lets the agent replace remaining steps rather than starting over.
- **Type-based execution**: Step types hint at the kind of tool needed — `information` for read/search, `action` for write/edit, `decision` for think/hypothesize, `verification` for test/check.
- **Disk persistence**: Plans are saved to `~/.pi/agent/plans/` for cross-session continuation.
