# Overnight Autonomous Development Plan
## pi-braid — April 23, 2026 Evening Session

---

## Executive Summary

This codebase has **severe infrastructure theater**: sophisticated systems exist on paper but aren't wired together. After thorough analysis of all 253 files (62K lines), I identified **12 critical broken systems** and **35+ specific implementation tasks** across 4 priority tiers.

The goal of this overnight session is **wiring, not writing**: making dormant code actually function, eliminating compliance theater, and creating the missing tools that complete the cognitive loop.

---

## TIER 1 — CRITICAL: Activate Dormant Infrastructure

### 1.1 Activate Heartbeat Policy Engine (BLOCKER)

**File**: `src/extensions/heartbeat-scheduler/index.ts`

**Problem**: `activatePolicyEngine()` function is defined at line 799 but **never called**. `policyEngineReady` stays `false` forever. This means:
- `recallerModule` never activates (memory recall never fires)
- `dreamerModule` never activates (offline consolidation never fires)
- `contextHygieneModule` never runs
- `measurementModule` never fires
- `evolverModule` never fires
- `toolTracking` stays at zeros (verification policy can never trigger)

**Fix**:
```typescript
// In session_start handler, after state initialization:
const { activatePolicyEngine } = await import('./cognitive-modules.js');
activatePolicyEngine(ctx, {
    onEnforcementWhisper: (msg) => ctx.enforcer?.sendEnforcementWhisper(msg),
    onPolicyFire: (policyId, context) => {
        // Route to appropriate cognitive module
        if (policyId === 'auto-recall') recallerModule.activate(ctx, context);
        else if (policyId === 'offline-consolidation') dreamerModule.activate(ctx, context);
    }
});
```

**Verify**: Build and run `node test/runtime/test-heartbeat.mjs` — should show `policyEngineReady: true` after session_start.

**Expected Outcome**: Cognitive heartbeat actually becomes cognitive.

---

### 1.2 Wire Tool Tracking to Analytics

**File**: `src/extensions/heartbeat-scheduler/index.ts`

**Problem**: `toolTracking` object is initialized to all zeros (lines 805-810) and `getToolTracking()` always returns `{ verificationCount: 0, ... }`. The policy engine has no real data.

**Fix**: In `onToolComplete` handler (line 760+):
```typescript
if (state.policyEngineReady) {
    const sessionId = ctx.cwd ?? String(process.pid);
    const engine = getPolicyEngine(sessionId);
    if (engine) {
        // Wire real tool data
        const tracking = engine.getToolTracking();
        tracking.totalToolsUsed++;
        tracking.lastToolCallTurn = state.turnCount;
        if (toolName === 'finalize' || toolName === 'think') tracking.verificationCount++;
        if (toolName === 'web_fetch') tracking.lastWebFetchTurn = state.turnCount;
        if (toolName === 'repl' || toolName === 'bash') tracking.lastCodeExecutionTurn = state.turnCount;
        
        // Also push to analytics
        ctx.analytics?.recordToolCall(toolName, Date.now(), {
            success: !event?.error,
            duration: event?.duration
        });
    }
}
```

**Verify**: After session with real tool usage, `heartbeat_status` should show non-zero tool counts.

---

### 1.3 Wire Three-Memory-Stores to Heartbeat Loop

**Files**: 
- `src/extensions/heartbeat-scheduler/index.ts` (cognitive module wiring)
- `src/extensions/three-memory-stores/index.ts` (API definitions)

**Problem**: `three-memory-stores` has `addEpisode`, `retrieveByRUMS`, `getMemoryState`, `recordToolCall`, `selectBestTool` but these are never called in the heartbeat loop.

**Fix in recallerModule.activate()**:
```typescript
// Instead of just registering, actually retrieve and act on memories
const { retrieveByRUMS } = await import('../three-memory-stores/index.js');
const { addMemoryEpisode } = await import('../three-memory-stores/index.js');

const relevant = retrieveByRUMS(
    ctx,
    currentTask, // from heartbeat context
    { maxResults: 3, recencyWeight: 0.7, usageWeight: 0.3, matchWeight: 0.0 }
);

if (relevant.length > 0) {
    addMemoryEpisode(ctx, {
        type: 'memory_recall',
        task: currentTask,
        outcome: relevant.length > 0 ? 'success' : 'no_match',
        lessons: relevant.map(r => r.episode.lessons || '')
    });
    // Surface memories to agent via whisper
    ctx.whisper?.(`Memory recall found ${relevant.length} relevant past episodes`);
}
```

**Fix in evolverModule.activate()**:
```typescript
const { evolveHeuristic, getHeuristicStats } = await import('../three-memory-stores/index.js');
const stats = getHeuristicStats(ctx);
const underperforming = stats.filter(s => s.successRate < 0.5 && s.applications > 5);
for (const rule of underperforming) {
    const evolved = evolveHeuristic(ctx, rule.ruleId, { success: false });
    if (evolved) ctx.whisper?.(`Evolved underperforming heuristic: ${rule.ruleId}`);
}
```

**Verify**: `memory_episodes` tool should show entries after multi-turn session.

---

### 1.4 Make Analytics Programmatically Readable

**File**: `src/extensions/analytics/index.ts`

**Problem**: Analytics is write-only. `formatCurrentSession()` and `formatAllSessions()` return human-readable strings. No programmatic access for the agent.

**Fix**: Add these tools to `registerTools`:
```typescript
pi.registerTool({
    name: 'get-session-metrics',
    description: 'Get structured current session analytics',
    execute: async () => {
        const sessions = await listSessions(analyticsDir);
        const current = sessions[0]; // most recent
        if (!current) return { metrics: {} };
        
        // Return structured data, not just text
        return {
            sessionId: current.id,
            duration: Date.now() - current.startTime,
            toolCounts: current.tools, // { toolName: count }
            errorCount: current.errors,
            successRate: current.successes / (current.successes + current.errors),
            tokenUsage: current.tokens,
            policyFires: current.policyFires,
        };
    }
});

pi.registerTool({
    name: 'get-tool-reliability',
    description: 'Get tool success rates per task type from historical data',
    execute: async (params: { taskType?: string; limit?: number }) => {
        const historical = await loadAllSessions(analyticsDir);
        const byTool = groupBy(historical.flatMap(s => s.tools), 'name');
        const reliability = Object.entries(byTool).map(([tool, calls]) => ({
            tool,
            successRate: calls.filter(c => c.success).length / calls.length,
            totalCalls: calls.length,
            avgDuration: mean(calls.map(c => c.duration))
        }));
        return reliability
            .filter(r => r.totalCalls >= 3)
            .sort((a, b) => b.successRate - a.successRate)
            .slice(0, params.limit ?? 10);
    }
});

pi.registerTool({
    name: 'get-degradation-history',
    description: 'Get historical degradation events',
    execute: async () => {
        const historical = await loadAllSessions(analyticsDir);
        return historical.flatMap(s => s.degradationEvents || []).slice(-20);
    }
});
```

**Also fix**: `formatCurrentSession()` should return structured data in addition to the text. Store session data as JSON, not just formatted strings.

**Verify**: After implementation, agent can call `get-tool-reliability` and get structured data.

---

### 1.5 Wire Belief-Store to Heartbeat Measurement Module

**Files**:
- `src/extensions/heartbeat-scheduler/index.ts` (measurement module)
- `src/lib/belief-store.ts`

**Problem**: Belief-store is imported and instantiated (session_start) but beliefs are never added, policies are never evaluated, and the `measurementModule` never uses it.

**Fix in measurementModule.activate()**:
```typescript
const { beliefStore } = getBeliefStore(ctx);
const { getDegradationReasons } = await import('../../lib/degradation-detector.js');
const reasons = getDegradationReasons(ctx);

for (const reason of reasons) {
    // Add as belief
    beliefStore.addBelief(ctx, {
        type: 'degradation_signal',
        content: reason.description,
        confidence: reason.severity,
        source: 'measurement',
        tags: ['measurement', 'degradation']
    });
    
    // If this is a repeated degradation, escalate confidence
    const existing = beliefStore.getBeliefs(ctx, { type: 'degradation_signal', content: reason.description });
    if (existing.length > 0) {
        beliefStore.updateBelief(ctx, existing[0].id, {
            confidence: Math.min(1.0, existing[0].confidence + 0.1)
        });
    }
}

const { isDegraded } = await import('../../lib/degradation-detector.js');
if (isDegraded(ctx)) {
    const { triggerPolicy } = getPolicyEngine(ctx.cwd);
    triggerPolicy('degradation-response', { reasons });
}
```

**Also fix**: Wire policy evaluation results back to belief-store. When a policy fires, update its confidence based on whether the action helped.

**Verify**: Belief-store should accumulate beliefs over session. `belief-store:get` should return growing set.

---

## TIER 2 — HIGH: Missing Core Tools

### 2.1 Create Bidirectional Verification Tool

**New file**: `src/extensions/verification/index.ts`

**Purpose**: Cross-check agent claims against retrieved facts. This is the missing "fresh eyes" tool that the documentation repeatedly mentions.

**Implementation**:
```typescript
export function registerVerificationTool(pi: PiExt) {
    pi.registerTool({
        name: 'verify_claim',
        description: 'Verify agent claims against retrieved context. Returns structured verification result.',
        execute: async (params: {
            claim: string,      // The claim to verify
            context: string[], // Retrieved context/documents
            claimId?: string   // Optional ID for tracking
        }) => {
            const issues: VerificationIssue[] = [];
            
            // 1. Check for contradictions with context
            for (const ctx_text of params.context) {
                const contradiction = checkContradiction(params.claim, ctx_text);
                if (contradiction) {
                    issues.push({
                        type: 'contradiction',
                        severity: 'high',
                        description: contradiction,
                        conflictingTexts: [params.claim, ctx_text]
                    });
                }
            }
            
            // 2. Check for unsupported claims
            const hasSupport = params.context.some(c => 
                semanticOverlap(params.claim, c) > 0.3
            );
            if (!hasSupport) {
                issues.push({
                    type: 'unsupported',
                    severity: 'medium',
                    description: 'Claim not supported by any retrieved context'
                });
            }
            
            // 3. Check for hedge words that need verification
            const hedges = ['should', 'always', 'never', 'must', 'guaranteed'];
            for (const hedge of hedges) {
                if (params.claim.includes(hedge)) {
                    issues.push({
                        type: 'hedge_warning',
                        severity: 'low',
                        description: `Contains absolute language: "${hedge}". Verify this is warranted.`
                    });
                }
            }
            
            return {
                claimId: params.claimId || generateId(),
                verified: issues.length === 0,
                issues,
                summary: issues.length === 0 
                    ? 'Claim verified against context'
                    : `${issues.length} issue(s) found: ${issues.map(i => i.type).join(', ')}`
            };
        }
    });
    
    pi.registerTool({
        name: 'verify_decomposition',
        description: 'Verify that a task decomposition fully covers the parent task.',
        execute: async (params: {
            parentTask: string,
            subtasks: string[],
            constraints?: string[]
        }) => {
            // Check for gaps: parent task features not covered by any subtask
            const parentFeatures = extractKeyFeatures(params.parentTask);
            const subtaskCoverage = params.subtasks.flatMap(s => extractKeyFeatures(s));
            
            const gaps = parentFeatures.filter(f => 
                !subtaskCoverage.some(sc => semanticMatch(f, sc))
            );
            
            return {
                complete: gaps.length === 0,
                gaps,
                coverage: parentFeatures.length > 0 
                    ? (parentFeatures.length - gaps.length) / parentFeatures.length
                    : 1.0,
                suggestions: gaps.map(g => `Add subtask to address: ${g}`)
            };
        }
    });
}
```

**Verify**: Create `test/runtime/test-verification.mjs` with:
- Contradiction detection (claim vs context)
- Unsupported claim detection
- Decomposition gap finding
- Hedge word warnings

---

### 2.2 Make Session Recall Proactive (Not Just On Rotation)

**Files**: 
- `src/extensions/session-recall/index.ts`
- `src/extensions/heartbeat-scheduler/index.ts`

**Problem**: Session recall only fires when user explicitly calls it or on session rotation. It's never triggered proactively based on task context.

**Fix**: Add proactive recall triggers to heartbeat-scheduler:

```typescript
// In heartbeat tick handler, check for recall triggers:
const proactiveRecallTriggers = [
    { condition: () => ctx.currentTask?.includes('debug'), recallType: 'debugging_episodes' },
    { condition: () => ctx.currentTask?.includes('implement') || ctx.currentTask?.includes('build'), recallType: 'implementation_episodes' },
    { condition: () => ctx.currentTask?.includes('review') || ctx.currentTask?.includes('audit'), recallType: 'review_episodes' },
    { condition: () => ctx.toolFailures > 2, recallType: 'error_recovery_episodes' },
    { condition: () => ctx.decompositionDepth > 2, recallType: 'complex_task_episodes' },
];

for (const trigger of proactiveRecallTriggers) {
    if (trigger.condition()) {
        const recall = await recallSession(ctx, {
            type: trigger.recallType,
            maxResults: 3,
            threshold: 0.6
        });
        if (recall.episodes.length > 0) {
            ctx.whisper?.(`Proactive recall: Found ${recall.episodes.length} relevant ${trigger.recallType}`);
        }
    }
}
```

**Also add**: `onError` handler in session-recall to automatically recall error recovery episodes when a tool fails.

**Verify**: After a tool failure, `memory_episodes` should show proactive recall entries.

---

### 2.3 Add Budget-Aware Planning Tool

**New file**: `src/extensions/planner/budget-planner.ts`

**Purpose**: Track tool costs and budget. Prevent runaway tool usage. The feedback extension has budget tracking but no budget-aware planning.

**Implementation**:
```typescript
pi.registerTool({
    name: 'plan_with_budget',
    description: 'Create a task plan with budget tracking and cost estimates',
    execute: async (params: {
        task: string,
        maxBudget?: number,     // Max tool calls allowed (default: 50)
        context?: string
    }) => {
        const budget = params.maxBudget ?? 50;
        const estimatedSteps = estimateSteps(params.task);
        const estimatedCost = estimateCost(estimatedSteps);
        
        // Warn if task seems over-budget
        const warnings = [];
        if (estimatedCost.toolCalls > budget) {
            warnings.push(`Estimated ${estimatedCost.toolCalls} calls exceeds budget ${budget}. Consider decomposing or narrowing scope.`);
        }
        if (estimatedCost.totalTokens > 100000) {
            warnings.push(`High token estimate: ${estimatedCost.totalTokens}. Will require context management.`);
        }
        
        // Generate phased plan with checkpoints
        const plan = generatePhasedPlan(params.task, {
            maxPerPhase: Math.ceil(budget / 3),
            checkpoints: ['verify', 'test', 'finalize']
        });
        
        return {
            task,
            budget,
            estimatedCost,
            plan,
            warnings,
            costPerPhase: plan.phases.map(p => ({
                phase: p.name,
                estimatedCalls: p.estimatedCalls,
                checkpoint: p.checkpoint
            }))
        };
    }
});

pi.registerTool({
    name: 'check_budget',
    description: 'Check remaining budget and spending rate',
    execute: async () => {
        const state = getHeartbeatState(ctx);
        const session = getAnalyticsSession(ctx);
        
        const used = session?.totalToolCalls ?? 0;
        const budget = state?.budget ?? 50;
        const remaining = budget - used;
        const rate = used / (session?.duration ?? 1) * 60000; // calls per minute
        
        return {
            used,
            remaining,
            budget,
            percentUsed: (used / budget) * 100,
            ratePerMinute: Math.round(rate * 10) / 10,
            projectedOverrun: rate * session?.duration > budget,
            suggestions: remaining < budget * 0.2 
                ? ['Low budget remaining. Prioritize critical path only.']
                : []
        };
    }
});
```

**Verify**: `plan_with_budget` should return structured cost estimates. `check_budget` should show current spending.

---

## TIER 3 — MEDIUM: Fix Compliance Theater

### 3.1 Make Enforcement Judge Use Structured Signals (Not Text Patterns)

**Files**:
- `src/extensions/enforcement/judge-prompt.ts`
- `src/extensions/enforcement/validation.ts`

**Problem**: Judge template embeds verbose text patterns for matching. Enforcement uses text arrays for conditions. Nudges are raw strings without semantic structure.

**Fix in judge-prompt.ts**:
Replace verbose pattern matching with structured signal output format:

```typescript
const JUDGE_TEMPLATE = `You are an enforcement signal generator. Analyze the agent's response and output structured signals only.

Output format (JSON):
{
  "signals": [
    {
      "type": "compliance" | "deception" | "incomplete" | "hallucination" | "scope_violation",
      "severity": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "specific quote from response",
      "remediation": "specific action to fix",
      "nudgeType": "whisper" | "block" | "warn",
      "category": "enforcement" | "quality" | "safety"
    }
  ]
}

Rules:
- type: The semantic category of the issue (use specific types, not "violation")
- severity: How serious (0.1=minor, 0.5=major, 1.0=critical)
- confidence: How sure you are (don't overstate confidence)
- evidence: Exact quote, not interpretation
- remediation: Specific actionable fix, not generic advice
- nudgeType: whisper=low-key, warn=direct, block=stop

Compliance signals:
- "compliance": Agent correctly followed instructions
- "incomplete": Response missing required information

Violation signals:
- "deception": Agent lied or misrepresented
- "hallucination": Agent made up information
- "scope_violation": Agent did something outside the requested scope
- "safety": Agent attempted dangerous action

Return empty signals array if all is well.`;
```

**Fix in nudge-manager.ts** to parse structured signals:
```typescript
function handleEnforcementSignal(signal: EnforcementSignal) {
    // Instead of text pattern matching:
    if (signal.nudgeType === 'block') {
        // Block immediately
        ctx.block(signal.remediation);
    } else if (signal.nudgeType === 'warn') {
        // Send warning with structured format
        sendNudge(ctx, {
            type: 'warn',
            message: signal.remediation,
            signal: signal, // pass structured signal
            category: signal.category
        });
    } else {
        // Whisper - low-key hint
        sendNudge(ctx, {
            type: 'whisper',
            message: signal.remediation,
            signal: signal,
            category: signal.category
        });
    }
    
    // Log structured signal, not just text
    ctx.analytics?.recordSignal(signal);
}
```

**Verify**: Enforcement should produce structured JSON signals, not just verbose text. Nudges should have specific remediation advice.

---

### 3.2 Fix Nudge Quality (End Compliance Theater in Nudges)

**File**: `src/extensions/enforcement/nudge-manager.ts`

**Problem**: Nudges are generic ("Be mindful..."). No specificity, no action recommendations.

**Fix**: Implement nudge templates with specificity:
```typescript
// Instead of generic nudges:
const NUDGE_TEMPLATES = {
    error_concealment: {
        generic: "Be mindful of your transparency commitments.",
        specific: "Error {error_type} detected. Your response did not acknowledge it. State the error explicitly and propose a fix.",
        tone: 'direct'
    },
    scope_drift: {
        generic: "Stay on topic.",
        specific: "You drifted from the original request: '{original_task}'. Current focus: '{current_focus}'. Return to scope or explicitly renegotiate.",
        tone: 'direct'
    },
    missing_verification: {
        generic: "Consider verifying your work.",
        specific: "You made {claim_type} without verification. Run {verification_tool} to confirm {specific_aspect}.",
        tone: 'whisper'
    },
    // ... more specific templates
};

function sendSpecificNudge(ctx: ExtensionContext, signal: EnforcementSignal) {
    const template = NUDGE_TEMPLATES[signal.type];
    const message = template 
        ? interpolate(template.specific, signal)
        : signal.remediation; // fallback to structured remediation
    
    sendNudge(ctx, {
        type: template?.tone || 'whisper',
        message,
        signal,
        previousNudges: getRecentNudges(ctx, signal.type)
    });
}
```

**Verify**: Nudges should be specific and actionable. Review nudge output to confirm specificity.

---

### 3.3 Wire Context-Lifecycle Signal Detector to Heartbeat

**Files**:
- `src/extensions/context-lifecycle/index.ts`
- `src/extensions/heartbeat-scheduler/index.ts`

**Problem**: `signal-detector.ts` defines topic drift, context overflow, and topic shift detection logic but it's never invoked.

**Fix**: In heartbeat tick handler:
```typescript
// Add topic drift and context overflow monitoring
const { detectTopicDrift } = await import('../context-lifecycle/signal-detector.js');
const { detectContextOverflow } = await import('../context-lifecycle/signal-detector.js');
const { detectTopicShift } = await import('../context-lifecycle/signal-detector.js');

const contextHistory = getRecentContext(10); // last 10 turns
const drift = detectTopicDrift(contextHistory);
if (drift.drifted) {
    // Notify agent
    ctx.whisper?.(`Topic drift detected: moved from "${drift.originalTopic}" to "${drift.currentTopic}". Confidence: ${drift.confidence.toFixed(2)}`);
}

const overflow = detectContextOverflow(ctx);
if (overflow.overflowing) {
    ctx.whisper?.(`Context overflow risk: ${overflow.usedTokens}/${overflow.limitTokens} tokens. Consider pruning.`);
}
```

**Verify**: Topic drift should trigger whispers during multi-session conversations.

---

## TIER 4 — LOW: Nice-to-Have Improvements

### 4.1 Wire Error Classification to Enforcement Retry

**Files**:
- `src/extensions/enforcement/index.ts` (main handler)
- `src/lib/error-classifier.ts`

**Problem**: `classifyError` and `shouldRetry` are defined but enforcement doesn't use them.

**Fix**: In enforcement tool error handler:
```typescript
const { classifyError, shouldRetry } = await import('../../lib/error-classifier.js');

if (event?.error) {
    const classification = classifyError(event.error, event.toolName);
    
    if (shouldRetry(classification)) {
        // Suggest retry with appropriate strategy
        const strategy = RETRY_STRATEGIES[classification.category];
        ctx.whisper?.(`Error classified as ${classification.category}. ${strategy.hint}`);
        
        // Store for potential automatic retry
        setRetryCandidate(ctx, event.toolName, {
            classification,
            strategy,
            attempt: 1,
            maxAttempts: strategy.maxAttempts
        });
    }
}
```

---

### 4.2 Add Self-Correction Loop (Meta-Improvement)

**New file**: `src/extensions/self-correction/index.ts`

**Purpose**: Agent can identify its own failure patterns and create heuristics to prevent recurrence.

```typescript
pi.registerTool({
    name: 'meta_correct',
    description: 'Identify a failure pattern and create a prevention heuristic',
    execute: async (params: {
        failure: string,       // What went wrong
        context: string,       // When it happened
        lesson: string,        // What to do differently
        severity?: 'low'|'medium'|'high'
    }) => {
        // Add as a belief
        const { beliefStore } = getBeliefStore(ctx);
        beliefStore.addBelief(ctx, {
            type: 'self_correction',
            content: params.failure,
            confidence: params.severity === 'high' ? 0.9 : params.severity === 'medium' ? 0.7 : 0.5,
            source: 'self',
            tags: ['self-correction', 'lesson']
        });
        
        // Create a procedural heuristic
        const { addHeuristicRule } = await import('../three-memory-stores/index.js');
        const rule = addHeuristicRule(ctx, {
            condition: params.context.substring(0, 100),
            action: params.lesson,
            successRate: 0.7, // initial estimate
            source: 'self-correction',
            tags: ['self-correction']
        });
        
        return {
            beliefId: beliefStore.getBeliefs(ctx, { content: params.failure })[0]?.id,
            heuristicId: rule?.id,
            message: `Recorded failure pattern and created heuristic: ${rule?.id}`
        };
    }
});
```

---

### 4.3 L1 Environment Discovery in Prompt Builder

**File**: `src/extensions/prompt-builder/l1-environment.ts`

**Problem**: `discoverPiPaths()` is defined but never called.

**Fix**: Call discovery and inject results into prompt:
```typescript
// In buildPrompt or l1Environment setup:
const paths = await discoverPiPaths();
if (paths.docsPath) {
    // Add docs path to system prompt context
    const docsIndex = await buildDocsIndex(paths.docsPath);
    // Inject relevant docs snippets based on current task
}
```

---

### 4.4 Create Unified Policy Engine

**Files**:
- `src/extensions/context-lifecycle/policy-engine.ts` (more complete design)
- `src/extensions/heartbeat-scheduler/index.ts` (simpler design)

**Problem**: Two policy engine implementations with different designs.

**Fix**: Consolidate on the context-lifecycle design (signal routing, topic drift), refactor heartbeat-scheduler to use it.

---

### 4.5 Add Proactive Policy Learning

**File**: `src/extensions/heartbeat-scheduler/index.ts`

**Problem**: Policies are static. No learning from outcomes.

**Fix**: After each policy fires, track the outcome:
```typescript
// After policy fires and action is taken:
const outcome = await trackOutcome(policyId, action);
beliefStore.updatePolicy(ctx, policyId, {
    confidence: outcome.success 
        ? Math.min(1.0, policy.confidence + 0.05)
        : Math.max(0.1, policy.confidence - 0.1),
    lastTriggered: Date.now(),
    lastOutcome: outcome.success ? 'success' : 'failure'
});
```

---

### 4.6 Analytics A/B Testing Infrastructure

**File**: `src/extensions/analytics/index.ts`

**Problem**: No experiment tracking for policy variants.

**Fix**: Add experiment tracking:
```typescript
pi.registerTool({
    name: 'get_experiment_variant',
    description: 'Get assigned experiment variant for A/B testing',
    execute: async (params: { experimentId: string }) => {
        const variant = getVariant(ctx, params.experimentId);
        return { experimentId: params.experimentId, variant, isControl: variant === 'control' };
    }
});
```

---

## Test & Verification Strategy

After each phase, run:

```bash
# Type check
npx tsc --noEmit --skipLibCheck

# Build
npx esbuild src/index.ts --bundle --format=esm --outdir=dist

# Run all tests
node test/runtime/test-all.mjs

# Specific test files for each phase
node test/runtime/test-heartbeat.mjs       # Phase 1
node test/runtime/test-integration.mjs     # Phase 1-2
node test/runtime/test-verification.mjs    # Phase 2 (new)
node test/runtime/test-budget-planning.mjs # Phase 2 (new)
```

---

## Phase Schedule (Overnight ~8-10 hours)

| Phase | Tasks | Est. Time | Verify |
|-------|-------|-----------|--------|
| **0** | Build + test baseline | 15 min | All tests pass |
| **1** | Activate heartbeat engine + wire tracking | 45 min | cognitive modules fire |
| **2** | Wire three-memory-stores + belief-store | 45 min | memories accumulate |
| **3** | Make analytics readable + add tools | 30 min | structured read works |
| **4** | Create verification tool | 60 min | bidirectional check works |
| **5** | Make session recall proactive | 30 min | auto-recall fires |
| **6** | Budget-aware planning tool | 45 min | cost estimates work |
| **7** | Fix enforcement signals + nudge quality | 60 min | structured signals |
| **8** | Wire signal detector + error classification | 45 min | topic drift works |
| **9** | Self-correction + L1 discovery | 30 min | meta-learning works |
| **10** | Unified policy engine + policy learning | 60 min | single engine |
| **11** | Final integration test + docs | 30 min | all tests pass |
| **12** | Write session summary to `docs/OVERNIGHT-RESULTS.md` | 15 min | — |

**Total**: ~7.5 hours of implementation, ~2 hours buffer = 9-10 hours

---

## Risks & Mitigations

1. **Risk**: Activating dormant policy engine causes side effects
   - **Mitigation**: Start with `policyEngineReady = false`, add `PI_ENV=dev` guard, log all policy fires

2. **Risk**: Wire changes break existing tests
   - **Mitigation**: Run tests after each task. Revert if tests fail. Keep changes minimal and focused.

3. **Risk**: Budget-aware planning tool causes false budget warnings
   - **Mitigation**: Make budget configurable, default to high budget (100), warn but don't block

4. **Risk**: Verification tool produces too many false positives
   - **Mitigation**: Start with high confidence threshold (0.8), reduce as data accumulates

5. **Risk**: Self-correction creates contradictory heuristics
   - **Mitigation**: Use conflict detection before adding new heuristics

---

## What NOT to Do This Session

- Don't rewrite existing working tools
- Don't add new cognitive architectures from scratch
- Don't change the enforcement signal protocol (breaking change)
- Don't modify the prompt builder's core logic
- Don't touch the browser extension
- Don't refactor the error classification taxonomy
- Don't add new paper implementations

---

## Parallel Agent Inputs Incorporated

Added from parallel agent audits (`mem-mo342dag`, `mem-mo91o7ja`) + proposal docs:

| Source | Key Findings |
|--------|-------------|
| `mem-mo91o7ja` (codebase audit) | 4 CRITICAL issues: monkey patches, globalThis duplicates, broken type guard, HTTP 429 conflict |
| `mem-mo342dag` (tool audit) | 2 duplicate tool names found |
| `TOOL_IMPROVEMENTS_PROPOSAL.md` | Tool v2: think() depth+chains, hypothesize() ranked, memory_recall() relevance, memory_store() TTL |
| `PROPOSAL_TOPIC_DRIFT_DETECTOR.md` | Semantic drift detection before generation |
| `CODEBASE-AUDIT-FULL.md` | 4 CRITICAL + 4 HIGH + 9 MODERATE issues across codebase |

Full consolidated plan: `docs/OVERNIGHT-PLAN-UPDATED.md`
