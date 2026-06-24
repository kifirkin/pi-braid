<!-- status: current -->

# Latent Activator Extension

Dynamic implicit identity/persona system. Activates latent
capabilities (behaviors) based on context. Based on research:

- HER (2601.21459): Dual-layer thinking (first-person vs third-person)
- HumanLLM (2601.10198): Psychological patterns as causal forces
- DPRF (2510.14205): Dynamic persona refinement

**Key insight**: models have INERTIA - persistent biases. This
framework works WITH biases, not against them.

## What this extension owns

- The `behavior` tool - the agent-facing interface for activating
  predefined behavior patterns
- The behavior catalog (38 predefined patterns, grouped into
  scenarios)

## Tools exposed

| Tool       | Actions | Purpose                                                  |
| ---------- | ------- | -------------------------------------------------------- |
| `behavior` | activate| Turn on a behavior pattern                               |
| `behavior` | deactivate | Turn off a specific behavior                         |
| `behavior` | list    | List currently active behaviors                          |
| `behavior` | mix     | Activate a scenario combo (clears existing first)        |
| `behavior` | deactivate_all | Clear all active behaviors                         |

## Safety bounds on the `behavior` tool

- **Session reset:** every new session starts with `["planner", "executor"]` -
  behaviors never leak across sessions.
- **Active cap:** max 5 behaviors active at once. Activation beyond the
  cap is refused with a clear error; the agent must deactivate first
  (or use `action="deactivate_all"` to clear all and start fresh).
- **Idempotent `mix`:** `action="mix"` clears existing behaviors
  first, so a scenario combo is a known good state regardless of
  prior activations.
- **No auto-activation:** the latent-activation inference path is
  disabled (the auto-activate code was removed in the 0.3.0 audit).
  The agent must explicitly call the tool.

## Local Contracts

- **Session-scoped**: behaviors reset on `session_start`.
- **Opt-in tool**: the `behavior` tool is registered but the
  auto-inference path is OFF by default. The agent must use the tool
  explicitly to activate behaviors.
- **No whisper emission**: behaviors change the agent's prompt
  context (via the system prompt) but don't inject whispers.
