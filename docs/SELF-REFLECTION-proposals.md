# Self-Reflection: Improvement Proposals
*Cycle 9 — Highest-ROI fixes for tool effectiveness and system health*

---

## P1: Create `diff` Tool (reduce bash by ~8-12%)

**Problem**: Agent uses `bash diff file1 file2` or `git diff` to see changes. This returns plain text, not structured data. No way to apply patches.

**Solution**: `pi.registerTool({ name: "file_diff", ... })` that:
- Takes `fileA`, `fileB` (optional git ref)
- Returns structured diff (hunks, added/removed lines)
- Can apply patches via `patch` parameter
- Returns changed line numbers for follow-up `read` calls

**Impact**: Eliminates one of the top 3 bash use cases. Makes verification faster.

## P2: Add `tool_error` Event (fill event bus gap)

**Problem**: No `tool_error` event type exists. When a tool fails, enforcement can't react directly. Errors go to error-capture but no event propagates for other modules.

**Solution**: Emit `tool_error` from error-capture extension. Enforcement subscribes to react. Heartbeat can track failure rates.

**Impact**: Enables proactive error recovery. Reduces silent tool failures.

## P3: Lazy-Load session_start Handlers (reduce startup latency)

**Problem**: 12 listeners fire on `session_start` synchronously. Startup gets slower with every new extension. Latency is invisible — agent just waits.

**Solution**: Add batch phase loading:
```
Phase 1 (synchronous): polyfill, extension-state, logger
Phase 2 (await all): memory, enforcement, context-lifecycle, prompt
Phase 3 (fire-and-forget): analytics, heartbeat, latent-activator
```

**Impact**: Faster startup, less context wasted on initialization whispers.

## P4: Extract enforcement Handlers (complete decomposition)

**Problem**: handlers/ directory is misleading — 0 event registrations. All 8 pi.on() handlers remain in 1268-line index.ts.

**Solution**: Move each pi.on() into its own handler file:
- `handlers/input-handler.ts`
- `handlers/tool-call-handler.ts`
- `handlers/turn-end-handler.ts`
- `handlers/session-start-handler.ts`
- etc.

Each handler file receives `(pi, getState, ...utilities)` and registers itself.

**Impact**: Drops index.ts from 1268L to ~100L (imports + export). Each handler becomes independently testable.

## P5: Write Tests for Critical Untested Libraries

**Priority order (by risk):**
1. `extension-state.ts` (146L) — ALL extensions depend on it
2. `injection-tracker.ts` (131L) — controls message visibility
3. `degradation-detector.ts` (328L) — drives auto-rollback
4. `filter-safe-to-remove.ts` (251L) — LLM context summarization
5. `cognitive-memory.ts` (1225L) — largest untested file
6. `logger.ts` (301L) — 30+ dependents

Each test takes ~30 min to write. Total: ~3 hours for all 6.

**Impact**: From 24/40 untested to 18/40 untested. Covers highest-risk surface.

## P6: Create System Monitor Tool

**Problem**: Only `healthcheck` exists (snapshot). No way to see CPU/memory trends, process count, disk growth.

**Solution**: `pi.registerTool({ name: "system_monitor", ... })`:
- Returns resource usage as structured metrics
- Can start continuous monitoring (setInterval + whisper when thresholds exceeded)
- Stores history for trend visualization

**Impact**: Proactive resource management. Reduces crashes from memory pressure.

## P7: Audit Low-Value Extensions

**Extensions to review for removal or reduction:**
- `latent-activator` (568L, 0 catch blocks, unclear value)
- `evolve` (780L, unclear trigger conditions)
- `rate-limiter` (173L, disabled-by-default, never fires)
- `watchdog` (77L, minimal value vs overhead)
- `agent-environment` (282L, disabled-by-default)
- `sycophancy-detector` (280L, 0 catch blocks)

**Recommendation**: Either rewrite with clear value proposition, or remove. Dead code is a maintenance burden.

---

*Generated during infinite self-reflection loop. Next analysis: implementation plans for each proposal.*
