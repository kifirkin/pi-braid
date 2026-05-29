# Import Dependency Map — `await import()` Sites

Generated: 2026-05-29 (updated after Phase 6.4 consolidation)
Total: **26 `await import()` calls** across the codebase

## Classification Key

| Category | Count | Description |
|----------|-------|-------------|
| **MASK (circular)** | 14 | Dynamic imports used to break circular dependency chains between modules |
| **LAZY (legitimate)** | 8 | Delayed loading for startup perf (node builtins, heavy modules) |
| **UNSAFE (fragile)** | 4 | Dynamic imports in hot paths where a failed resolve would cascade |

---

The reduction from 33→26 is primarily from resolving the `await import()` calls in `handler-registry.ts` — those modules (verification-judge, claim-tracker, bidirectional-verifier, consolidation-channel, turn-end-coordinator, mars-reflector, dreamer) were converted to static imports after the enforcement god-object split broke circular dependency chains.

## 1. Enforcement (handler-registry.ts) — 0 calls (was 8, all resolved)

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 343 | `./verification-judge.js` | `runVerificationJudge`, `formatVerificationNudge` | MASK — verification-judge imports from `state.ts` which is statically imported by handler-registry | Low — called in message_end handler, safe to fail |
| 455 | `../../lib/claim-tracker.js` | `processAgentResponse`, `formatContradictionWhisper` | MASK — claim-tracker imports from `extension-state.ts` used by enforcement state | Low — wrapped in try/catch |
| 470 | `../../lib/bidirectional-verifier.js` | `loadSpecs`, `checkSpecCoverage`, `getVerifierState` | LAZY — heavy module with file system calls | Low — spec-verification handler, best-effort |
| 490 | `../../lib/consolidation-channel.js` | `scanArchives` | MASK — consolidation-channel imports from `logger.ts` which enforcement also uses | Low — archive-ingestion handler, best-effort |
| 502 | `../../lib/turn-end-coordinator.js` | `dispatchTurnEnd` | MASK — coordinator re-imports handler types from enforcement | Low — called in turn_end handler |
| 672 | `../../lib/mars-reflector.js` | `shouldAdvise` | MASK — mars-reflector imports from `extension-state.ts` | Low — turn_end handler |
| 708 | `../../lib/dreamer.js` | `dream` | MASK — dreamer imports from `extension-state.ts` | Low — turn_end handler |

## 2. Heartbeat Scheduler (heartbeat-scheduler/index.ts) — 5 calls, all MASK

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 479 | `../../memory/three-memory-stores/index.js` | `retrieveEpisodes` | MASK — heartbeat → memory cross-module dependency | Medium — cyclic: memory uses timer, timer is heartbeat module |
| 506 | `../../memory/three-memory-stores/index.js` | `retrieveEpisodes` | MASK — same as above, duplicate site | Medium |
| 568 | `../../memory/three-memory-stores/index.js` | `addEpisode` | MASK — heartbeat writes to memory store | Medium |
| 615 | `../../../lib/consolidation-channel.js` | `scoreEpisode` | MASK — lib module that enforcement also imports | Low |

## 3. Memory Module — 9 calls across 3 files

### compaction-retry.ts — 5 calls, all MASK (to rotation.js internal dependency)

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 45 | `./rotation.js` | `triggerEmergencyRotation` | MASK — circular dep within memory module: rotation imports from compaction module | Low — same package, same directory |
| 52 | `./rotation.js` | `triggerEmergencyRotation` | MASK — same site | Low |
| 137 | `./rotation.js` | `triggerEmergencyRotation` | MASK — same site | Low |
| 199 | `./rotation.js` | `triggerEmergencyRotation` | MASK — same site | Low |
| 248 | `./rotation.js` | `triggerEmergencyRotation` | MASK — same site | Low |

### context-lifecycle/index.ts — 1 call, LAZY

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 314 | `../../tools/timer/index.js` | `scheduleTimer` | LAZY — timer module is heavy but rarely used | Low |

### context-manager/handlers/tools.ts — 2 calls, LAZY

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 310 | `../../../tools/timer/index.js` | `scheduleTimer` | LAZY — same as above | Low |
| 597 | `../../../tools/timer/index.js` | `scheduleTimer` | LAZY — same as above | Low |

## 4. Heartbeat Modules — 4 calls

### budget.ts — 2 calls, MASK

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 35 | `../../../core/scratchpad/index.js` | `loadScratchpadFromDisk`, `saveScratchpadToDisk` | MASK — heartbeat → core cross-module | Low |
| 36 | `../../../../lib/belief-policy-engine.js` | `emitSignal` | MASK — belief-policy-engine imports from extension-state | Low |

### context-hygiene.ts — 1 call, LAZY

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 107 | `../../../../lib/context-density.js` | `evaluateContextDensity` | LAZY — heavy module | Low |

### timer-reminder.ts — 1 call, LAZY

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 23 | `../../../../lib/timer-bus.js` | `drainTimerReminders` | LAZY — infrequent call | Low |

## 5. Analytics (heartbeat/analytics/index.ts) — 1 call, LAZY

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 292 | `./ab-variant.js` | `formatABResults` | LAZY — only called in UI notification | Low |

## 6. Cognitive Modules — 1 call, MASK

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 81 (tool-safety/index.ts) | `../../../lib/injection-tracker.js` | `sendTrackedMessage` | MASK — injection-tracker imports extension-state | Low |

## 7. Core Modules — 2 calls, LAZY

### input-polisher/index.ts — 1 call, MASK

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 534 | `../../memory/context-manager/handlers/shared.js` | `isCompactionActive` | MASK — core → memory cross-module | Low |

### metacognition/handlers/finalize.ts — 1 call, MASK

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 29 | `../../memory/three-memory-stores/index.js` | `addEpisode`, `addPrinciple` | MASK — core → memory cross-module | Low — finalize handler |

## 8. Prompt Builder — 2 calls, LAZY (node builtins)

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 711 | `node:path` | `join` | LAZY — node builtin, startup perf | None |
| 712 | `node:fs` | `readdirSync`, `existsSync`, `readFileSync` | LAZY — node builtin, startup perf | None |

## 9. Lib Modules — 1 call, LAZY

| Line (reasoning-summary.ts:51) | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 51 | `./text-classifier.js` | `classify` | LAZY — heavy LLM call module | Low — try/catch wrapper |

## 10. Contrib (Observatory) — 3 calls, LAZY (node builtins)

| Line | Target | Imported Symbol | Why Dynamic | Risk |
|------|--------|----------------|-------------|------|
| 92 | `node:child_process` | `execSync` | LAZY — node builtin, only on start | None |
| 118 | `node:child_process` | `execSync` | LAZY — node builtin, only on stop | None |
| 134 | `node:child_process` | `execSync` | LAZY — node builtin, only on stop | None |

---

## Dependency Graph (Module-Level)

```
core/ ──────────────────────────────────────────────┐
  prompt-builder ──→ node:path, node:fs (LAZY)      │
  metacognition ──→ memory/stores (MASK)             │
  input-polisher ──→ memory/context-manager (MASK)   │
                                                     │
cognitive/                                           │
  tool-safety ──→ injection-tracker (MASK) ──────────┤
                                                     │
enforcement/                                         │
  handler-registry ──→ verification-judge (MASK)     ├──→ all depend on
                   ──→ claim-tracker (MASK)          │    extension-state.ts
                   ──→ bidirectional-verifier (MASK) │    + various lib modules
                   ──→ consolidation-channel (MASK)  │
                   ──→ turn-end-coordinator (MASK)   │
                   ──→ mars-reflector (MASK)         │
                   ──→ dreamer (MASK)                │
                                                     │
heartbeat/                                           │
  scheduler ──→ three-memory-stores (MASK) ──────────┤
           ──→ consolidation-channel (MASK)          │
  budget ──→ scratchpad (MASK) ──────────────────────┤
         ──→ belief-policy-engine (MASK)             │
  context-hygiene ──→ context-density (LAZY)         │
  timer-reminder ──→ timer-bus (LAZY)               │
                                                     │
memory/                                              │
  compaction-retry ──→ rotation.js (MASK, internal)  │
  context-lifecycle ──→ timer (LAZY)                 │
  tools ──→ timer (LAZY)                             │
                                                     │
lib/                                                  │
  reasoning-summary ──→ text-classifier (LAZY)       │
```

## Circular Dependency Chains

Each chain below represents a group of modules that form a cycle, broken by `await import()`:

### Chain A: enforcement ↔ lib (6 links)
```
handler-registry → claim-tracker → extension-state ↔ handler-registry
handler-registry → mars-reflector → extension-state ↔ handler-registry
handler-registry → dreamer → extension-state ↔ handler-registry
handler-registry → belief-policy-engine (STATIC) → extension-state ↔ handler-registry
```

### Chain B: heartbeat ↔ memory ↔ timer (3 links)
```
heartbeat-scheduler → three-memory-stores → timer (tool) → heartbeat-module
heartbeat-scheduler → consolidation-channel → logger ↔ heartbeat-module
```

### Chain C: core ↔ memory (2 links)
```
input-polisher → context-manager/handlers/shared → tools → timer (heartbeat)
finalize → three-memory-stores → timer → heartbeat
```

## Resolution Path (Phase 3)

The plan resolves these by splitting `handler-registry.ts` into focused handler files. Each extracted handler only statically imports the lib modules it needs (2-5 imports instead of 15-20). The core insight:

> **The circular dependency is not real — it's an artifact of the monolithic handler-registry importing everything.** Once handlers are split, enforcement handlers no longer import from memory/heartbeat, breaking the cycle naturally.

For `compaction-retry.ts → rotation.js` (5 sites), extract shared rotation utilities into `shared.ts` so both files use static imports.