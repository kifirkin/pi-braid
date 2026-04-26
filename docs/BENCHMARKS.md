# Benchmark Suite

## Test Coverage

pi-braid has **51 real unit tests** across 5 test files. Each test asserts specific behavior.

| Test File | Tests | Scope |
|-----------|-------|-------|
| `test-mars-reflector.mjs` | 13 | MARS reflection engine |
| `test-belief-policy.mjs` | 19 | Belief policy engine |
| `test-features.mjs` | 22 | Addiction detection, cross-session learning, branch monitoring, daemon, documentation, bundle integrity |
| `scripts/run-tests.mjs` | — | Orchestrator: runs all test files, reports summary |

**Latest run**: All 51 tests pass (0 failures)

## Feature Test Details

### Addiction Detection (4 tests)
| Test | Input | Expected |
|------|-------|----------|
| Single-tool overuse | 15/15 grep calls | Warning (ratio >60%) |
| Balanced usage | 10 calls, even distribution | No warning |
| Rolling window | 100 calls: 50 old grep + 50 recent balanced | No warning (old burst excluded) |
| Trigger intervals | Simulate calls 1–25 | Triggers at 10 and 20 |

### Cross-Session Learning (3 tests)
| Test | Input | Expected |
|------|-------|----------|
| Jaccard similarity | `{read,grep,edit}` vs episodes | 2 similar matches (≥50%) |
| Dissimilar rejection | Read-only vs web tools | 0 matches |
| Edge cases | Identical/disjoint/partial sets | 1.0 / 0.0 / 1/3 |

### Branch Depth Monitoring (2 tests)
| Test | Input | Expected |
|------|-------|----------|
| Alarm threshold | 151 entries | Triggers (>150) |
| Below threshold | 100 entries | No trigger |

### Daemon Orchestrator (2 tests)
| Test | Expected |
|------|----------|
| Source file exports | `DaemonOrchestrator` + `spawnWorker` + `killWorker` + `healthCheck` |
| Shell script lifecycle | Commands: `start`, `stop`, `status`, `logs`, `restart` |

### BM1 / BR4 Regression (2 tests)
| Test | Expected |
|------|----------|
| BM1 task lookup | Uses `next()` generator, not `TASKS.index()` |
| BR4 CLI | Accepts `--extensions` argument |

### Bundle Integrity (4 tests)
| Test | Expected |
|------|----------|
| Bundle exists | `dist/index.cjs` present |
| Feature markers | `session_shutdown`, `turn_end`, `addiction` in bundle |
| Daemon excluded | `DaemonOrchestrator` NOT in bundle (standalone) |
| No dead imports | `getAllConflicts` removed |

## Research Benchmarks (RPC-based, unreliable)

The evaluation scripts (`br4_latent_multi_turn.py`, `bm1_multi_turn_debug.py`, `pi_rpc_benchmark.py`) send prompts through `pi --mode rpc`. **This harness is broken** — the model returns empty content (`assistant: []`), so no tools execute. These scripts produce meaningless pass rates.

**Root cause**: pi's `openai-completions` API type doesn't capture responses correctly for this model. This is a pi framework / LLM integration issue, not fixable in pi-braid.

**Workaround**: All features are validated through the 51 real unit tests above.

## Version History

| Version | Test Count | Pass Rate | Notes |
|---------|-----------|-----------|-------|
| v0.15.0–v0.15.1 | 32 (BR1) | 100% | MARS + belief policy |
| v0.16.0 | 32 | 100% | Lib docs |
| v0.17.0 | 32 | 100% | Features added |
| v0.18.0 | 51 | 100% | Benchmark suite with 22 real feature tests |
| **v0.19.0–v0.19.1** | **51** | **100%** | Fixed BM1 crash, analytics bug, cross-session matching |
