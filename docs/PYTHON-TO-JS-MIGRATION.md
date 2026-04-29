# Python → JS Migration for pi-braid Evaluation

**Date**: 2026-04-29
**Status**: Phase 1 done — BM1, BR4, BR1 harnesses migrated. Run-all runner created.

## Done ✅
- `evaluation/bm1-sdk.mjs` — BM1 multi-turn debugging (3 tasks, ~60/100 avg)
- `evaluation/br4-sdk.mjs` — BR4 latent multi-turn comparison (3-trial run complete)
- `evaluation/br1-sdk.mjs` — BR1 trap task validation (5 trap types)
- `evaluation/run-all.mjs` — Unified benchmark runner
- `docs/PYTHON-TO-JS-MIGRATION.md` — Migration plan + SDK patterns

## Pending
- `evaluation/bm2-sdk.mjs` — BM2 code quality (from bm2_code_quality.py)
- `evaluation/comprehensive-sdk.mjs` — Comprehensive benchmark suite
- `evaluation/overnight-sdk.mjs` — Overnight multi-trial validation
- `scripts/benchmark.mjs` — Quick smoke test
- `scripts/smoke-*.mjs` — Smoke tests (Python → JS)
- `test/stability-*.mjs` — Stability tests
- Delete: all Python evaluation + script files

## SDK Patterns (Established)

### Model Registration
```js
import { stepfunModels } from '/path/to/pi-poorman-providers/stepfun.ts';

const stepfunModel = {
  ...stepfunModels.find(m => m.id === 'step-3.5-flash'),
  provider: 'stepfun',
  api: 'openai-completions',
  baseUrl: 'https://api.stepfun.ai/step_plan/v1',
};
```

### Session Creation
```js
const loader = new DefaultResourceLoader({
  cwd: workspace,
  agentDir: getAgentDir(),
  extensionFactories: [(pi) => {
    pi.registerProvider('stepfun', {
      baseUrl: 'https://api.stepfun.ai/step_plan/v1',
      apiKey: 'STEP_API_KEY',
      api: 'openai-completions',
      models: stepfunModels,
    });
  }],
});
await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  model: stepfunModel,
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
});
```

### Run Prompt + Extract Results
```js
await Promise.race([
  session.prompt(prompt),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
]);

const messages = session.state?.messages || [];
for (const m of messages) {
  if (m.role === 'assistant') {
    for (const b of m.content || []) {
      if (b.type === 'text') text += b.text;
      if (b.type === 'toolCall') toolCalls.push(b);
      if (b.type === 'thinking') thinking += b.thinking;
    }
  }
  if (m.role === 'toolResult') {
    for (const b of m.content || []) {
      if (b.type === 'text') toolOutput += b.text;
    }
  }
}
```

### Guard: run main() only when executed directly (not imported)
```js
if (typeof process.send !== 'function' && process.argv[1] && process.argv[1].includes('bm1-sdk.mjs')) {
  main().catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  });
}
```


## Rationale

This session proved it: **Python subprocess RPC deadlocks**. pi uses async stdin/stdout that interleaves — Python can't handle it safely. The pi SDK (Node.js) is the correct approach.

Benefits of full JS/TS migration:
1. **No deadlocks** — SDK runs in-process, no subprocess pipes
2. **Single language** — pi core, pi-braid extensions, benchmarks all JS/TS
3. **Direct API access** — session.state, events, tools all typed
4. **Faster iteration** — no Python env setup, share node_modules with pi

## Files to Migrate

### Evaluation (benchmarks) — HIGH PRIORITY

| File | LOC | New Location | Notes |
|------|-----|--------------|-------|
| `bm1_multi_turn_debug.py` | 591 | `evaluation/bm1-sdk.mjs` | ✅ Already migrated |
| `br4_latent_multi_turn.py` | 270 | `evaluation/br4-sdk.mjs` | Compliance pattern detection, needs SDK migration |
| `bm2_code_quality.py` | 287 | `evaluation/bm2-sdk.mjs` | eslint, complexity, edge cases |
| `benchmark_comprehensive.py` | 315 | `evaluation/comprehensive-sdk.mjs` | Full benchmark suite |
| `run_benchmarks.py` | 204 | `evaluation/run-all.mjs` | Runner with config |
| `overnight_test.py` | 226 | `evaluation/overnight-sdk.mjs` | Multi-trial validation |
| `aggregate_results.py` | 200 | `evaluation/aggregate.mjs` | Results aggregation |
| `pi_rpc_benchmark.py` | 210 | RETIRE | Superseded by SDK |

### Scripts — MEDIUM PRIORITY

| File | LOC | New Location | Notes |
|------|-----|--------------|-------|
| `benchmark.py` | 266 | `scripts/benchmark.mjs` | Quick smoke test |
| `smoke-test-decomposition.py` | 285 | `scripts/smoke-decomposition.mjs` | Task decomposition tests |
| `smoke-test-phase3.py` | 190 | `scripts/smoke-phase3.mjs` | Phase 3 validation |
| `subagent-rpc.py` | 165 | RETIRE | pi RPC subprocess, broken |

### Test — LOW PRIORITY

| File | LOC | New Location | Notes |
|------|-----|--------------|-------|
| `stability-check.py` | 164 | `test/stability-check.mjs` | Session stability |
| `stability.py` | 171 | `test/stability.mjs` | Long-run stability |

### Archive — DROP

| File | LOC | Notes |
|------|-----|-------|
| `docs/.archive-old/H8_extension_docs_gen.py` | ~150 | Dead code |

## SDK Patterns (Established)

### Model Registration
```js
import { stepfunModels } from '/path/to/pi-poorman-providers/stepfun.ts';

const stepfunModel = {
  ...stepfunModels.find(m => m.id === 'step-3.5-flash'),
  provider: 'stepfun',
  api: 'openai-completions',
  baseUrl: 'https://api.stepfun.ai/step_plan/v1',
};
```

### Session Creation
```js
const loader = new DefaultResourceLoader({
  cwd: workspace,
  agentDir: getAgentDir(),
  extensionFactories: [(pi) => {
    pi.registerProvider('stepfun', { /* ... */ });
  }],
});
await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  model: stepfunModel,
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
});
```

### Run Prompt + Extract Results
```js
await Promise.race([
  session.prompt(prompt),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
]);

const messages = session.state?.messages || [];
for (const m of messages) {
  if (m.role === 'assistant') {
    for (const b of m.content || []) {
      if (b.type === 'text') text += b.text;
      if (b.type === 'toolCall') toolCalls.push(b);
      if (b.type === 'thinking') thinking += b.thinking;
    }
  }
  if (m.role === 'toolResult') {
    for (const b of m.content || []) {
      if (b.type === 'text') toolOutput += b.text;
    }
  }
}
```

## Migration Order

1. **Phase 1**: Migrate `run_benchmarks.py` + retire `pi_rpc_benchmark.py` (runner infrastructure)
2. **Phase 2**: Migrate `br4_latent_multi_turn.py` → `br4-sdk.mjs` (existing benchmark, clear pattern)
3. **Phase 3**: Migrate `bm2_code_quality.py` → `bm2-sdk.mjs` (new benchmark, straightforward)
4. **Phase 4**: Migrate `benchmark_comprehensive.py` → `comprehensive-sdk.mjs` (complex, multi-config)
5. **Phase 5**: Scripts + test stability files
6. **Phase 6**: Delete all Python files

## Deprecation

After migration:
- `test/runtime/*.py` → all `.mjs`
- `scripts/*.py` → all `.mjs`
- `evaluation/*.py` → all `.mjs`
- `docs/.archive-old/` → delete
