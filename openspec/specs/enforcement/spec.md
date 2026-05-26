# Enforcement Specification

## Purpose
Turn validation, tool tracking, and heuristic advice delivery. Entry point for Dreamer/MARS advice systems and advice feedback loop.

## Requirements

### Requirement: Turn Validation
The system SHALL validate each turn's tool usage patterns against configured thresholds.

#### Scenario: Silent turn detected
- GIVEN a turn with zero tool calls
- AND consecutive silent turns >= maxSilentTurns (6)
- WHEN the turn ends
- THEN the agent receives a whisper about silent turns

#### Scenario: Error burst detected
- GIVEN 3+ consecutive turns with tool errors
- WHEN the turn ends
- THEN the agent receives a critical whisper about error burst

### Requirement: Tool Tracking
The system SHALL track all tool calls with timing, success/failure, and file paths.

#### Scenario: Tool call recorded
- GIVEN a tool execution
- WHEN the tool_call event fires
- THEN the tool name is recorded in toolLog
- AND file paths are recorded for read/edit/write/bash tools
- AND calibration pairs are stored when think() provides confidence

### Requirement: Context Overflow Detection
The system SHOULD detect context overflow and suggest compaction.

#### Scenario: High context usage
- GIVEN context usage exceeds soft threshold (30K tokens)
- WHEN the turn ends
- THEN a token-based nudge is added to session signals

### Requirement: Advice Feedback Loop
The system SHALL evaluate Dreamer/MARS predictions after 10 turns and adjust thresholds based on accuracy.

#### Scenario: Low prediction accuracy
- GIVEN 5+ predictions with <50% accuracy
- WHEN the advice tracker evaluates pending advice
- THEN Dreamer cooldown increases (1.5x)
- AND MARS overuse multiplier increases (+1)

### Requirement: Turn_end Coordinator
The system SHALL dispatch turn_end events through a priority-ordered coordinator with error isolation.

#### Scenario: Handler error isolated
- GIVEN a registered handler that throws
- WHEN turn_end dispatches
- THEN other handlers still execute
- AND the error is logged
