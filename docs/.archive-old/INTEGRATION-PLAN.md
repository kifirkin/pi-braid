# PI-BRAID MERGE: `cleanup/refactor` ← `harness/implicit-budget`

**Status**: DRAFT — detailed integration plan
**Base**: `cleanup/refactor` (605a0f9) — [HAS 214 PASSING TESTS, cleaner architecture]
**Source**: `harness/implicit-budget` (bab6841) — [HAS NEW EXTENSIONS, newer enforcement]
**Merge base (identical)**: 605a0f9 = bab6841 (both worktrees checked out the same commit)

---

## 0. UNDERSTANDING THE DIVERGENCE

### 0.1 Commit distance

```
cleanup/refactor: 605a0f9 (HEAD of worktree)
harness/implicit-budget: bab6841 (HEAD of worktree)
Both share 605a0f9 as merge base — 9 clean commits on each branch from that point
```

### 0.2 What `cleanup/refactor` (605a0f9) HAS that `harness` DELETED

**11 lib files removed in harness:**
| File | Lines | Purpose |
|------|-------|---------|
| `lib/evidence-pool.ts` | 297L | Conflict evidence collection + resolution |
| `lib/belief-policy-engine.ts` | 356L | Belief signal emission + recommendation engine |
| `lib/cognition-evaluator.ts` | 89L | Heuristic compliance evaluation |
| `lib/conflict-qa.ts` | 344L | QA-based conflict resolution |
| `lib/extension-state.ts` | 85L | Extension lifecycle state |
| `lib/extension-utils.ts` | 103L | Extension helpers |
| `lib/file-mutation-queue.ts` | 116L | Mutation ordering for conflicting writes |
| `lib/language-hint.ts` | 78L | Language detection + reply instruction |
| `lib/mars-reflector.ts` | 169L | Self-awareness reflection |
| `lib/reasoning-metrics.ts` | 135L | Reasoning quality metrics |
| `lib/topic-drift-detector.ts` | 207L | Topic drift detection |

**3 extensions removed in harness:**

- `extensions/heartbeat-scheduler/` — removed (replaced by `watchdog`?)
- `extensions/three-memory-stores/` — removed (replaced by `latent-activator`?)
- `extensions/wait-review/` — removed (workflow changed?)

**3 extensions restructured in harness (monolithed back from decomposed):**

- `context-manager/` — was 5 files (analysis+handlers+pruning+retry) → reverted to 1 × 1684L
- `enforcement/` — decomposed into judge/nudge/detection/validation/whisper architecture (see 0.3)
- `metacognition/` — grew from clean decomposed to 482+ line changes

**2 extensions made leaner in harness:**

- `vision/index.ts` — 1361L → ~594L (-767L, improved!)
- `prompt-builder/index.ts` — slight improvement

**17 test files deleted in harness** (non-critical; cleanup/refactor has newer tests)

### 0.3 What `harness` (bab6841) HAS that `cleanup/refactor` (605a0f9) DIDN'T ADD

**6 brand-new extensions:**
| Extension | Purpose | Dependencies |
|-----------|---------|-------------|
| `extensions/analytics/` | Usage + performance analytics | `latent-activator`, `watchdog` |
| `extensions/feedback/` | User feedback collection + routing | `analytics` |
| `extensions/latent-activator/` | Latent knowledge retrieval | `three-memory-stores` (removed!) |
| `extensions/rate-limiter/` | Token + rate management | None |
| `extensions/reasoning/` | Reasoning traces + patterns | None |
| `extensions/watchdog/` | Daemon monitoring + health | None |

**New enforcement architecture (judge/nudge model):**

```
enforcement/
├── index.ts                          # ~100L (much slimmer)
├── detection/
│   ├── dangerous.ts                  # NEW: dangerous pattern detection
│   ├── malformed.ts                  # NEW: malformed call detection
│   └── verification.ts               # (from cleanup/refactor)
├── handlers/                         # KEPT (blocking, tool-reg, tool-tracker)
├── judge.ts                          # NEW: judge orchestration
├── judge-prompt.ts                   # NEW: judge prompt template
├── nudge-manager.ts                  # NEW: nudge delivery system
├── prompts.ts                        # NEW: enforcement prompts
├── state.ts                          # NEW: enforcement state
├── validation.ts                     # NEW: validation layer
├── verification-judge.ts             # NEW: verification via judge
└── whisper.ts                        # NEW: whisper delivery
```

**New lib additions (preserved in harness):**

- `extension-state.ts` — preserved in harness (same file exists)
- `extension-utils.ts` — preserved in harness (same file exists)
- `lib/degradation-detector.ts` — 325L (harness has slight changes)
- `lib/error-classifier.ts` — 305L (harness has slight changes)
- `lib/logger.ts` — 377L (harness has slight changes)

**Note on `lib/evidence-pool.ts` and `lib/conflict-qa.ts`**: The harness `enforcement/index.ts` **NO LONGER IMPORTS** these, but the NEW files (`detection/dangerous.ts`, `judge.ts`, etc.) may still reference them. Need to audit.

---

## 1. PHASE 1: PREPARATION (Safety net — zero code loss)

### 1.1 Create integration branch

```bash
cd /Users/kifir/projects/agents/pi-braid

# From cleanup/refactor (our base)
git checkout cleanup/refactor
git pull  # ensure up to date
git checkout -b integration/implicit-budget-merge
```

### 1.2 Tag snapshots for rollback

```bash
git tag integration/snapshot-cleanup-refactor cleanup/refactor
git tag integration/snapshot-harness-backup bab6841
```

### 1.3 Verify test baseline on cleanup/refactor

```bash
cd /Users/kifir/projects/agents/pi-braid
npm test 2>&1 | tail -20
# Expected: 214 passing
```

### 1.4 Create harness worktree for reference

```bash
cd /Users/kifir/projects/agents/pi-braid
git worktree add /Users/kifir/projects/agents/pi-braid-harness-ref bab6841
# Keep as READ-ONLY reference; do NOT develop in it
```

### 1.5 Audit harness's new enforcement files for stale imports

```bash
cd /Users/kifir/projects/agents/pi-braid-harness
grep -r "evidence-pool\|conflict-qa\|belief-policy\|mars-reflector\|language-hint" \
  src/extensions/enforcement/src/ 2>/dev/null || echo "No stale imports found"
```

**Expected outcome**: Either no stale imports, or imports found only in files we discard.

---

## 2. PHASE 2: RESTORE DELETED LIB FILES (From cleanup/refactor)

### 2.1 Restore the 11 deleted lib files

These are safe to restore — they're from the base commit both worktrees share:

```bash
cd /Users/kifir/projects/agents/pi-braid
# Restore each deleted file from cleanup/refactor
git checkout cleanup/refactor -- \
  src/lib/evidence-pool.ts \
  src/lib/belief-policy-engine.ts \
  src/lib/cognition-evaluator.ts \
  src/lib/conflict-qa.ts \
  src/lib/extension-state.ts \
  src/lib/extension-utils.ts \
  src/lib/file-mutation-queue.ts \
  src/lib/language-hint.ts \
  src/lib/mars-reflector.ts \
  src/lib/reasoning-metrics.ts \
  src/lib/topic-drift-detector.ts

git add -A
git commit -m "restore: 11 deleted lib files from cleanup/refactor base

These files were removed in harness/implicit-budget but contain
important infrastructure: evidence-pool, belief-policy-engine,
conflict-qa, cognition-evaluator, extension-state, extension-utils,
file-mutation-queue, language-hint, mars-reflector, reasoning-metrics,
topic-drift-detector.
"
```

### 2.2 Verify they don't break the build

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
# Should be clean or only pre-existing warnings
```

---

## 3. PHASE 3: MERGE NEW EXTENSIONS FROM HARNESS (Safe additions)

### 3.1 Copy the 6 new extensions

```bash
cd /Users/kifir/projects/agents/pi-braid
for ext in analytics feedback latent-activator rate-limiter reasoning watchdog; do
  cp -r /Users/kifir/projects/agents/pi-braid-harness/src/extensions/$ext \
        src/extensions/
done

git add -A
git commit -m "feat: add 6 new extensions from harness/implicit-budget

- analytics: Usage + performance analytics
- feedback: User feedback collection + routing
- latent-activator: Latent knowledge retrieval
- rate-limiter: Token + rate management
- reasoning: Reasoning traces + patterns
- watchdog: Daemon monitoring + health
"
```

### 3.2 Fix dependencies

**Critical dependency**: `latent-activator` depends on `three-memory-stores` which cleanup/refactor has. Good — no fix needed there.

**Analytics dependencies**: `analytics` depends on `latent-activator` and `watchdog`. Both now present. Good.

### 3.3 Verify extension registration

Check `src/index.ts` in pi-braid to ensure new extensions are registered (or auto-discovered):

```bash
grep -l "analytics\|feedback\|latent-activator\|rate-limiter\|reasoning\|watchdog" \
  src/index.ts src/extensions/*/index.ts 2>/dev/null
```

If extensions aren't auto-discovered, add them to the extension registry in `src/index.ts`.

### 3.4 Run tests to verify no breakage

```bash
npm test 2>&1 | tail -30
```

---

## 4. PHASE 4: REINTEGRATE HARNESS'S IMPROVEMENTS INTO EXISTING EXTENSIONS

### 4.1 Enforcement: Integrate judge/nudge architecture

**Problem**: cleanup/refactor has handler-based enforcement; harness has judge/nudge enforcement.

**Decision**: Take harness's NEW enforcement files (detection/dangerous, judge, judge-prompt, nudge-manager, prompts, state, validation, verification-judge, whisper) but merge them with cleanup/refactor's existing handler files that harness still has (blocking, tool-reg, tool-tracker).

**Steps**:

```bash
cd /Users/kifir/projects/agents/pi-braid

# 4.1.1 Get harness's NEW enforcement subdirectory files
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/detection/dangerous.ts \
   src/extensions/enforcement/detection/
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/judge.ts \
   src/extensions/enforcement/
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/judge-prompt.ts \
   src/extensions/enforcement/
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/nudge-manager.ts \
   src/extensions/enforcement/
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/prompts.ts \
   src/extensions/enforcement/
cp /Users/kifir/projects/agents/pi-barness/projects/agents/pi-braid-harness/src/extensions/enforcement/state.ts \
   src/extensions/enforcement/
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/validation.ts \
   src/extensions/enforcement/
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/verification-judge.ts \
   src/extensions/enforcement/
cp /Users/kifir/projects/agents/pi-braid-harness/src/extensions/enforcement/whisper.ts \
   src/extensions/enforcement/

# 4.1.2 Merge harness's enforcement/index.ts changes into cleanup/refactor's index
# This requires careful manual diff merging. Use vscode or manual edit.
# Key harness changes to preserve:
#   - Slimmer index.ts (drop unused imports, use judge-based flow)
#   - Judge + NudgeManager integration
#   - New detection modules wired in

# 4.1.3 Audit imports in new files
grep "from.*evidence-pool\|from.*conflict-qa\|from.*belief-policy\|from.*language-hint" \
  src/extensions/enforcement/*.ts src/extensions/enforcement/detection/*.ts 2>/dev/null
# If any import deleted lib files → redirect to restored files
```

### 4.2 Vision: Integrate harness's improvements

```bash
# Harness's vision/index.ts is 767 lines smaller — find what was improved
diff /Users/kifir/projects/agents/pi-braid/src/extensions/vision/index.ts \
     /Users/kifir/projects/agents/pi-braid-harness/src/extensions/vision/index.ts \
  | head -100
```

**Decision**: Use harness's version (leaner). Verify it still covers all critical functionality.

### 4.3 Healthcheck: Integrate harness's improvements

```bash
diff /Users/kifir/projects/agents/pi-braid/src/extensions/healthcheck/index.ts \
     /Users/kifir/projects/agents/pi-braid-harness/src/extensions/healthcheck/index.ts \
  | head -60
```

**Decision**: Merge harness's improvements (better agent-core testing, removed dead code) into cleanup/refactor's decomposed structure.

### 4.4 Prompt-builder: Verify which version is better

```bash
# Both changed — compare carefully
diff /Users/kifir/projects/agents/pi-braid/src/extensions/prompt-builder/index.ts \
     /Users/kifir/projects/agents/pi-braid-harness/src/extensions/prompt-builder/index.ts
```

**Decision**: Likely keep cleanup/refactor's version (more complete capability table), but merge the `THINK_STEP_BY_STEP` section from harness.

### 4.5 Metacognition: Restore decomposed structure

```bash
# cleanup/refactor decomposed metacognition/ into handlers/
# harness monolithed it back — restore decomposition
ls /Users/kifir/projects/agents/pi-braid/src/extensions/metacognition/handlers/
```

**Decision**: Keep cleanup/refactor's decomposition. Any new logic from harness's monolithic version needs to be ported back into handlers.

### 4.6 Context-manager: Restore decomposed structure

```bash
# cleanup/refactor decomposed context-manager/ into 5 files
# harness monolithed it back to 1684L — restore decomposition
ls /Users/kifir/projects/agents/pi-braid/src/extensions/context-manager/
```

**Decision**: Keep cleanup/refactor's decomposition. Apply harness's new features (session continuation, compaction improvements) into the handler structure.

---

## 5. PHASE 5: RESTORE DELETED EXTENSIONS + TESTS

### 5.1 Restore 3 deleted extensions (optional — assess value)

```bash
cd /Users/kifir/projects/agents/pi-braid

# heartbeat-scheduler: Assess if replaced by watchdog
ls /Users/kifir/projects/agents/pi-braid/src/extensions/watchdog/
# If watchdog covers all heartbeat-scheduler functionality → skip restore
# Otherwise:
git checkout cleanup/refactor -- src/extensions/heartbeat-scheduler/

# three-memory-stores: latent-activator may supersede it
ls /Users/kifir/projects/agents/pi-braid/src/extensions/latent-activator/
# If latent-activator is a proper superset → skip restore
# Otherwise:
git checkout cleanup/refactor -- src/extensions/three-memory-stores/

# wait-review: Assess
git checkout cleanup/refactor -- src/extensions/wait-review/
```

**Decision rule**: If new extension fully covers deleted extension's functionality, discard deleted. Otherwise restore.

### 5.2 Restore tests

```bash
cd /Users/kifir/projects/agents/pi-braid

# Restore tests that are still relevant
git checkout cleanup/refactor -- \
  tests/runtime/test-context-manager-handlers.mjs \
  tests/runtime/test-metacognition-handlers.mjs \
  tests/runtime/test-finalize-bcr.mjs \
  tests/runtime/test-evidence-pool.mjs \
  tests/runtime/test-conflict-qa.mjs \
  tests/runtime/test-error-classifier.mjs \
  tests/runtime/test-integration.mjs \
  tests/runtime/test-memory-stores.mjs \
  tests/runtime/test-heartbeat.mjs

git add -A
git commit -m "restore: deleted test files from cleanup/refactor"
```

---

## 6. PHASE 6: VALIDATION

### 6.1 Build verification

```bash
npm run build 2>&1 | grep -E "^(error|Error|ERROR)" | head -20
echo "Build exit code: $?"
```

### 6.2 Test suite

```bash
npm test 2>&1 | grep -E "pass|fail|error|TOTAL" | tail -20
# Target: 214+ passing
```

### 6.3 Manual smoke test

```bash
# Test the key new integrations
node -e "
const { default: contextManager } = await import('./dist/extensions/context-manager/index.js');
const { default: enforcement } = await import('./dist/extensions/enforcement/index.js');
const { default: analytics } = await import('./dist/extensions/analytics/index.js');
console.log('All new extensions load OK');
" 2>&1
```

### 6.4 Context-manager decomposition sanity check

```bash
# Verify the 5-file structure is intact
ls src/extensions/context-manager/
# Expected: analysis.ts handlers/ index.ts pruning.ts retry.ts rotation.ts
wc -l src/extensions/context-manager/index.ts
# Expected: <200L (not 1684L)
```

---

## 7. PHASE 7: FINALIZE

### 7.1 Resolve any remaining conflicts

```bash
git status
# Manually resolve any remaining merge conflicts
```

### 7.2 Final commit

```bash
git add -A
git commit -m "merge: integrate harness/implicit-budget into cleanup/refactor

Features merged from harness:
- 6 new extensions: analytics, feedback, latent-activator, rate-limiter,
  reasoning, watchdog
- New enforcement architecture: judge/nudge model + detection/dangerous
- Vision improvements: 767L reduction
- Healthcheck improvements: better agent-core testing

Architecture preserved from cleanup/refactor:
- context-manager: 5-file decomposition (analysis+handlers+pruning+retry+rotation)
- enforcement: hybrid of decomposed handlers + new judge architecture
- metacognition: decomposed handler structure
- All 11 restored lib files
- All 214+ passing tests
"
```

### 7.3 Push and cleanup

```bash
# Push integration branch
git push -u origin integration/implicit-budget-merge

# Once verified, merge into cleanup/refactor
git checkout cleanup/refactor
git merge integration/implicit-budget-merge
git push

# Remove reference worktree
git worktree remove /Users/kifir/projects/agents/pi-braid-harness-ref

# Decide on harness worktree:
# Option A: Update harness to point to new merged cleanup/refactor
#   (cd /Users/kifir/projects/agents/pi-braid-harness && git checkout harness/implicit-budget && git merge cleanup/refactor)
# Option B: Keep as-is for further development, then rebase later
```

---

## 8. RISK REGISTER

| Risk                                               | Likelihood | Impact | Mitigation                               |
| -------------------------------------------------- | ---------- | ------ | ---------------------------------------- |
| Harness enforcement imports deleted libs           | MEDIUM     | HIGH   | Phase 1.5 audit + Phase 4.1.3 fix        |
| New extensions have circular dependencies          | MEDIUM     | MEDIUM | Phase 3.3 verify registration            |
| Re-monolified files lose cleanup/refactor features | HIGH       | HIGH   | Phase 4.5+4.6 restoration                |
| Build breaks after lib restore                     | LOW        | MEDIUM | Phase 2.2 verify build                   |
| Tests fail after extension merge                   | MEDIUM     | MEDIUM | Phase 6.2 full test suite                |
| Session manager API changed in harness             | LOW        | HIGH   | Audit ctx usage in new enforcement files |

---

## 9. EXECUTION ORDER (Linear — no parallelism)

```
PHASE 1 (Safety) → PHASE 2 (Libs) → PHASE 3 (New Extensions)
    → PHASE 4 (Reintegration) → PHASE 5 (Restoration)
        → PHASE 6 (Validation) → PHASE 7 (Finalize)
```

**Estimated time**: 2-4 hours (heaviest work is Phase 4.1 enforcement merge + Phase 4.5+4.6 context-manager restoration)
