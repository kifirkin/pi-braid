# PI-BRAID MERGE: `cleanup/refactor` ← `harness/implicit-budget`

**Status**: DRAFT
**Base**: `cleanup/refactor` (605a0f9) — [HAS 214 PASSING TESTS, cleaner architecture]
**Source**: `harness/implicit-budget` (bab6841) — [HAS 6 NEW EXTENSIONS, newer enforcement]
**Merge base**: 605a0f9 = bab6841 (both worktrees share the same commit)

---

## WHAT DIVERGED

Both branches share the same base (605a0f9) then diverged over ~9 commits each.

### `cleanup/refactor` HAS that `harness` DELETED

- **11 lib files**: evidence-pool, belief-policy-engine, conflict-qa, cognition-evaluator, extension-state, extension-utils, file-mutation-queue, language-hint, mars-reflector, reasoning-metrics, topic-drift-detector
- **3 extensions**: heartbeat-scheduler, three-memory-stores, wait-review
- **17 test files**
- Handler-based decomposition in context-manager, metacognition, enforcement

### `harness` HAS that `cleanup/refactor` DIDN'T ADD

- **6 new extensions**: analytics, feedback, latent-activator, rate-limiter, reasoning, watchdog
- **New enforcement architecture**: judge/nudge model with detection/dangerous, judge, nudge-manager, whisper, validation
- **Vision improvements**: 767 lines smaller
- Healthcheck improvements

---

## INTEGRATION STRATEGY

**Decision**: Use `cleanup/refactor` as base (214 tests, clean decomposition). Cherry-pick harness features manually. Do NOT merge branches directly.

### Phase 1: Safety
```bash
cd /Users/kifir/projects/agents/pi-braid
git checkout cleanup/refactor
git pull
git checkout -b integration/implicit-budget-merge
git tag integration/snapshot-cleanup-refactor cleanup/refactor
git tag integration/snapshot-harness-backup bab6841
npm test  # verify 214 passing
```

Create read-only reference worktree:
```bash
git worktree add /Users/kifir/projects/agents/pi-braid-harness-ref bab6841
```

### Phase 2: Audit harness imports
```bash
cd /Users/kifir/projects/agents/pi-braid-harness
grep -r "evidence-pool\|conflict-qa\|belief-policy\|mars-reflector\|language-hint" \
  src/extensions/enforcement/
```
If stale imports found → fix before proceeding.

### Phase 3: Restore deleted lib files
```bash
cd /Users/kifir/projects/agents/pi-braid
git checkout cleanup/refactor -- \
  src/lib/evidence-pool.ts \
  src/lib/belief-policy-engine.ts \
  src/lib/conflict-qa.ts \
  src/lib/cognition-evaluator.ts \
  src/lib/extension-state.ts \
  src/lib/extension-utils.ts \
  src/lib/file-mutation-queue.ts \
  src/lib/language-hint.ts \
  src/lib/mars-reflector.ts \
  src/lib/reasoning-metrics.ts \
  src/lib/topic-drift-detector.ts
npm run build  # verify clean
```

### Phase 4: Copy 6 new extensions
```bash
for ext in analytics feedback latent-activator rate-limiter reasoning watchdog; do
  cp -r /Users/kifir/projects/agents/pi-braid-harness/src/extensions/$ext src/extensions/
done
```

### Phase 5: Reintegrate enforcement improvements
Copy harness's NEW files into cleanup/refactor's existing handler structure:
- `detection/dangerous.ts`, `judge.ts`, `judge-prompt.ts`, `nudge-manager.ts`, `prompts.ts`, `state.ts`, `validation.ts`, `verification-judge.ts`, `whisper.ts`
- Merge `enforcement/index.ts` carefully (use vscode diff)

### Phase 6: Restore decomposed extensions
For context-manager and metacognition: use cleanup/refactor's handler-based structure. Merge harness's feature improvements into it manually.

### Phase 7: Vision + Healthcheck improvements
Use harness's leaner `vision/index.ts` (767L smaller). Merge harness healthcheck improvements into cleanup/refactor's decomposed structure.

### Phase 8: Restore deleted extensions (assess)
- `heartbeat-scheduler`: compare with watchdog; restore if not fully superseded
- `three-memory-stores`: compare with latent-activator; restore if not fully superseded
- `wait-review`: assess independently

### Phase 9: Restore deleted tests
```bash
git checkout cleanup/refactor -- tests/runtime/
```

### Phase 10: Validate
```bash
npm run build
npm test  # target: 214+
```

### Phase 11: Finalize
```bash
git add -A
git commit -m "merge: integrate harness/implicit-budget into cleanup/refactor"
git checkout cleanup/refactor
git merge integration/implicit-budget-merge
git push
git worktree remove /Users/kifir/projects/agents/pi-braid-harness-ref
```

---

## RISK REGISTER

| Risk | L | Impact | Mitigation |
|------|---|--------|-----------|
| Harness enforcement imports deleted libs | M | HIGH | Phase 2 audit |
| New extensions have circular deps | M | MED | Phase 4 extension registration check |
| Re-monolified files lose cleanup features | H | HIGH | Phase 6 decomposition restoration |
| Build breaks after lib restore | L | MED | Phase 3 build verification |
| Tests fail after merge | M | MED | Phase 9 test restore |
| Session manager API changed in harness | L | HIGH | Audit ctx usage in new enforcement files |

---

## EXECUTION ORDER

```
PHASE 1 → PHASE 2 → PHASE 3 → PHASE 4 → PHASE 5 → PHASE 6 → PHASE 7 → PHASE 8 → PHASE 9 → PHASE 10 → PHASE 11
```

Estimated time: 2-4 hours. Heaviest work: Phase 5 enforcement merge + Phase 6 context-manager restoration.
