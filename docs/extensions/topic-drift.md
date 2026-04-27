# Extension: topic-drift

**Status**: ✅ Working
**Tests**: None
**Version**: v0.12.x

## Purpose

Topic drift detection — monitors whether the agent's output stays on topic relative to the original user request. Uses semantic anchor tracking to detect drift and alert the agent.

## Architecture

Two tools:
1. `check_topic_drift` — compare output against original request anchors
2. `reset_topic_anchors` — reset anchors to a new request or current context

## Events Handled

None — tools are called directly by the agent.

## Tools

| Tool | Description |
|------|-------------|
| `check_topic_drift` | Check if current output matches original request anchors. Params: `output` (text to check). Returns drift score and warning if confident. |
| `reset_topic_anchors` | Reset anchors to new request. Params: `newRequest` (optional — uses current context if omitted). |

## Key Patterns

- **Anchor extraction**: Extracts key terms from the original user request as semantic anchors. Compares current output against these anchors.
- **Token overlap scoring**: Drift score computed as Jaccard distance between output tokens and anchor tokens. Score >0.5 = significant drift.
- **Explicit reset**: Agent can reset anchors mid-task when shifting topics intentionally, preventing false positives.
