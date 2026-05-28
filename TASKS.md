# pi-braid — Task Tracker

Last updated: 2026-05-28

## ✅ Ready to Commit

Triple-critic migration + module flattening (`definitions.ts` → `manifest.ts`).
All 171 tests pass. Uncommitted — needs a commit batch.

```
git add src/extensions/manifest.ts src/lib/critic-registry.ts \
       src/modules/loader.ts src/modules/api.ts src/index.ts \
       src/extensions/cognitive/verification/index.ts \
       src/extensions/cognitive/turn-outcome/index.ts \
       src/extensions/cognitive/topic-drift/index.ts \
       src/lib/claim-tracker.ts src/lib/consolidation-channel.ts \
       src/lib/evidence-pool.ts src/lib/topic-drift-detector.ts \
       src/extensions/enforcement/handler-registry.ts \
       src/extensions/enforcement/session-state.ts \
       src/extensions/enforcement/handlers/analysis/drift-handler.ts \
       test/runtime/test-claim-tracker.mjs test/runtime/test-topic-drift.mjs \
       test/runtime/test-diff.mjs test/runtime/test-observatory-extension.mjs \
       test/runtime/test-sleep.mjs test/runtime/test-system-monitor.mjs \
       src/modules/definitions.ts  # deleted
git commit -m "triple-critic migration + module flattening"
```

---

## 🔲 Remaining Work (7 items)

### Small fixes (~15 min each)

- [ ] **Whisper double-tag** — `src/extensions/enforcement/whisper.ts:71` removes `[enforcement]` prefix (redundant with `customType`)
- [ ] **Logger bindContext** — `src/lib/logger.ts` — remove `bindContext`/`unbindContext`/`hasContext`, make it console-only

### Medium complexity (~1-2 hours each)

- [ ] **Degradation→checkpoint rollback** — `state-checkpoint.ts` has restore infrastructure but `handleDegradation()` is not exported/wired to turn_end
- [ ] **File I/O consolidation** — `consolidation-channel.ts` uses `readFileSync`/`writeFileSync` (6 calls) directly instead of `async-storage.ts`

### Large items (~3-5 hours each)

- [ ] **Research lightweight refactoring tools** — Check what exists (ast-grep, ts-morph, jscodeshift, TS compiler API) before building custom tools. `code-search` skill already has ast-grep patterns.
- [ ] **lib/ restructure** — 47 flat files in `src/lib/` → functional subdirectories:
  - `cognition/` — text-classifier, critic-registry, llm-call, reasoning-*
  - `storage/` — async-storage, cognitive-memory, compression-strategy
  - `enforcement/` — claim-tracker, evidence-pool, topic-drift-detector, advice-tracker
  - `analysis/` — dreamer, mars-reflector, degradation-detector
  - `infrastructure/` — logger, event-bus, timer-bus, extension-state, injection-tracker
  - `utilities/` — braid-paths, braid-settings, tool-constants, language-hint
  - Barrel re-exports at old paths for backward compat
- [ ] **Refactoring extension** — Custom pi tools: `bulk_move_files`, `update_imports`, `rename_symbol`, `restructure_module`. Would make structural phases dramatically easier.

---

### How to find this later

Memory recall: `memory_recall("pi-braid remaining work plan")`
Session search: search for "pi-braid refactoring remaining work plan"