# Memory Specification

## Purpose
Three memory stores, context lifecycle management, session recall, and agent-facing memory tools.

## Requirements

### Requirement: Memory Tools
The system SHALL provide memory_store, memory_recall, memory_list, and memory_get tools.

#### Scenario: Memory stored
- GIVEN the agent calls memory_store
- WHEN the tool executes
- THEN content is persisted to episodic memory
- AND the memory is tagged with the provided tags

### Requirement: Context Compaction
The system SHALL provide context_compact, context_prune, context_archive, and context_checkout tools.

#### Scenario: Context compacted
- GIVEN the agent calls context_compact
- WHEN the tool executes
- THEN old messages are removed from context
- AND unpersisted learnings are surfaced via enforcement
