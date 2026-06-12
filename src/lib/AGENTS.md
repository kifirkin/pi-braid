# src/lib/ - Shared Library Subsystems

This directory contains **library code** (non-extension modules) used across the
extension tree. Each subdirectory has a distinct purpose; this file is the index.

## Subdirectory Index

| Subdir | Purpose |
|---|---|
| [`ai/`](./ai/AGENTS.md) | LLM utilities - critic registry, model resolution, text classification, structured LLM call wrapper. |
| [`memory/`](./memory/AGENTS.md) | Memory engine - the underlying storage and reasoning layer for memory-related extensions. |
| [`config/`](./config/AGENTS.md) | Configuration loading and merging. |
| [`constants/`](./constants/AGENTS.md) | Project-wide constants and enums. |
| [`core/`](./core/AGENTS.md) | Foundation utilities - logger, event-name constants. Anything that's truly cross-cutting lives here. |
| [`detection/`](./detection/AGENTS.md) | Detection primitives - degradation detection, topic-drift, context density, compression strategies. |
| [`enforcement/`](./enforcement/AGENTS.md) | Cross-extension enforcement utilities - turn-dedup registry, whisper capping. |
| [`events/`](./events/AGENTS.md) | Event-bus and channel infrastructure - consolidation, timer, turn-end coordination. |
| [`reasoning/`](./reasoning/AGENTS.md) | Reasoning engines - dreamer (loop prediction), belief policy, MARS reflector, summarization, advice tracker. |
| [`state/`](./state/AGENTS.md) | Per-extension state, session state, global state, checkpointing. |
| [`store/`](./store/AGENTS.md) | Persistent stores - claims, evidence, conflicts, beliefs. |
| [`types/`](./types/AGENTS.md) | Shared type definitions and result wrappers. |
| [`utils/`](./utils/AGENTS.md) | Misc utilities - injection tracker, mutation queue, filter helpers, SOP extraction. |

## Conventions

- Files in `lib/` are **not** loaded as extensions. They are imported by extensions in `../extensions/`.
- `lib/core/` and `lib/types/` are imported by virtually every other module - keep them minimal and stable.
- Subdirectories should not import from each other across the table above. If a lib module needs another lib module, it should be a thin dependency (e.g., `lib/reasoning` may use `lib/events`).
- New utilities: prefer adding to an existing subdir if it fits. Create a new subdir only when there are 3+ related files with a clear shared concept.
