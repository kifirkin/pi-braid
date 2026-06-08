# src/lib/cognitive-memory/ — Cognitive Memory Subsystem

The underlying engine behind the memory-related extensions
(`three-memory-stores`, `memory-agent-bridge`, `session-recall`).

## Files

| File | Purpose |
|---|---|
| `index.ts` | Public API and type exports. |
| (4 others) | Storage layer, retrieval logic, indexing. |

## Relationship to other layers

- `lib/cognitive-memory/` is the **engine** — pure data and logic.
- `extensions/memory/three-memory-stores/` is the **agent-facing tool wrapper** — exposes `memory_recall`, `memory_list`, `memory_get`, `memory_store` etc. as LLM-callable tools.
- `lib/store/` is for **ad-hoc persistent claims** (verifier output, conflict resolution). Different from the structured three-store memory.

## Local Contracts

- The three stores are: episodic, semantic, procedural. (See `three-memory-stores` extension for the runtime contract.)
- Cognitive memory is **per-session** (resets on session start) AND **persistent** (saved to disk).
- Reads should be fast (sub-100ms). Writes can be slow.
