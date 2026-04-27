# Extension: latent-activator

**Status**: ✅ Working
**Tests**: None
**Version**: v0.12.x

## Purpose

Behavior pattern management — activates/deactivates latent agent behaviors for different task contexts. Provides `activate_behavior`, `deactivate_behavior`, `get_active_behaviors`, and `activate_mix` tools.

Behaviors shift how the agent approaches problems: from exploratory to focused, reflective to direct, etc.

## Events Handled

None — tools are called directly by the agent.

## Tools

| Tool | Description |
|------|-------------|
| `activate_behavior` | Activate a behavior pattern (e.g., "skeptic", "explorer", "architect") |
| `deactivate_behavior` | Deactivate a behavior by name |
| `get_active_behaviors` | List currently active behaviors with descriptions |
| `activate_mix` | Activate predefined combo for common scenarios: `code-review`, `debugging`, `planning`, `implementation`, `exploration`, `reflection`, `crisis`, `learning`, `refactoring`, `handover` |

## Predefined Mixes

| Mix | Behaviors Activated |
|-----|-------------------|
| `debugging` | systematic, detail-oriented |
| `planning` | big-picture, risk-aware |
| `implementation` | pragmatic, focused |
| `code-review` | thorough, quality-focused |
| `refactoring` | pattern-aware, minimal-diff |
| `exploration` | curious, breadcrumb-aware |
| `crisis` | focused-action, 80-20 |
| `learning` | pattern-extraction, question-driven |
| `handover` | documentation-minded, context-preserving |

## Key Patterns

- **Activation stack**: Multiple behaviors can be active simultaneously. No deactivation cascade — each must be explicitly deactivated.
- **Mix shortcuts**: Common scenarios activate preset behavior combos, reducing cognitive load on the agent.
- **No persistence**: Behavior state is session-scoped and ephemeral — intentionally not persisted to disk.
