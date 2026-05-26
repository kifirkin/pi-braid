# Cognitive Quality Specification

## Purpose
Structured reasoning, verification, topic-drift detection, sycophancy detection, and turn-outcome loop detection.

## Requirements

### Requirement: Verification Tools
The system SHALL provide verify_claim and verify_decomposition tools.

#### Scenario: Claim verified
- GIVEN the agent calls verify_claim with a claim and context
- WHEN the tool executes
- THEN contradictions, hedge words, and unsupported claims are detected
- AND a structured result is returned

### Requirement: Topic Drift Detection
The system SHALL provide check_topic_drift and reset_topic_anchors tools.

#### Scenario: Drift detected
- GIVEN the agent calls check_topic_drift with output text
- WHEN the tool executes
- THEN the output is compared against topic anchors
- AND drift severity is returned if topic has shifted

### Requirement: Turn Outcome Detection
The system SHOULD detect repetitive failure loops across consecutive turns.

#### Scenario: Loop detected
- GIVEN same tool sequence for 4+ consecutive turns
- WHEN turn_outcome analyzes the turn
- THEN a strategic steer is sent suggesting a different approach
