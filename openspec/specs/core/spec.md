# Core Specification

## Purpose
Foundation layer: metacognition tools, prompt assembly, scratchpad, polyfill, and agent-environment integration.

## Requirements

### Requirement: Prompt Assembly
The system SHALL assemble the system prompt each turn via `before_agent_start` event.

#### Scenario: Contrast mode injected
- GIVEN enforcement emits enforcement_signals with contrastMode
- WHEN before_agent_start fires
- THEN activeContrastMode is updated
- AND the truthfulness guardrail section appears in the prompt

### Requirement: Metacognition Tools
The system SHALL provide think, verify, hypothesize, and finalize tools to the agent.

#### Scenario: Think records reasoning
- GIVEN the agent calls think()
- WHEN the tool executes
- THEN a thought chain entry is created
- AND the thought is recorded in enforcement state

### Requirement: Scratchpad
The system SHALL provide a scratchpad tool for tracking goals, decisions, and next steps across turns.

#### Scenario: Scratchpad persists
- GIVEN the agent writes to scratchpad
- WHEN the tool executes
- THEN content is persisted to disk at ~/.pi/agent/braid/scratchpads/
