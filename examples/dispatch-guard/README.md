<!-- status: current -->

# Dispatch guard

A pi extension that makes `herdr_agent prompt` fire-and-forget: it rewrites `wait` to `false` before the call runs, records the rewrite, and leaves every other tool and action alone.

## Why it exists

`herdr_agent prompt` waits for the target agent's lifecycle to settle unless the call says otherwise, and a working agent does not settle. The dispatching turn then blocks inside the call until the target's whole run ends. The standing rule is to pass `wait: false`, and a timed-out wait does not mean the prompt failed, so the block buys nothing. This extension enforces the rule where it is decided rather than where it is remembered.

## Install

Project-scoped, beside the project's other local extensions:

```bash
cp -r examples/dispatch-guard <project>/.pi/extensions/dispatch-guard
```

Or point pi at the file from `settings.json`:

```jsonc
{ "extensions": ["file:/absolute/path/to/examples/dispatch-guard/index.ts"] }
```

Project-local `.pi/extensions` entries load once the project is trusted, and discovery reads one level deep, so `<project>/.pi/extensions/dispatch-guard/index.ts` is found as written. The guard arms for the whole project; a global install (`~/.pi/agent/extensions/`) arms every project. A new process or session picks it up.

The `package.json` beside the entry declares the module type, so node reads the TypeScript entry as ESM rather than reparsing it. It carries no `pi.extensions` field, which is what keeps pi's discovery on the `index.ts` path.

## What it does

| Call                                           | Result                                    |
| ---------------------------------------------- | ----------------------------------------- |
| `herdr_agent` `prompt`, `wait` absent          | executed with `wait: false`, line, record |
| `herdr_agent` `prompt`, `wait: true`           | executed with `wait: false`, line, record |
| `herdr_agent` `prompt`, `wait: false`          | untouched, no line, no record             |
| `herdr_agent` `prompt`, `wait: "settle"`       | untouched: the escape hatch               |
| any other `herdr_agent` action, any other tool | untouched, arguments identical            |

The escape hatch exists for the rare caller that really means to block: a string is not a boolean, so `wait: "settle"` is not rewritten. Note the boundary: the tool declares `wait` as a boolean, and pi validates arguments before any hook runs, so a model-issued string is refused there and never reaches the guard. The hatch matters to a caller that reaches the handler outside that validation.

## What it records

The first rewrite of a session appends one custom entry holding the line, and every rewrite appends an entry with the running count, so a session file carries one line and a counter:

```jsonc
{
  "type": "custom",
  "customType": "dispatch-guard",
  "data": { "rewrites": 1, "notice": "dispatch guard: wait forced to false on prompt" },
}
{ "type": "custom", "customType": "dispatch-guard", "data": { "rewrites": 2 } }
```

Custom entries stay out of the model's context. The operator also sees the line once per session through `ctx.ui.notify`, because a custom entry is invisible in the transcript until an entry renderer is registered.

## Test

```bash
node packages/core/test/runtime/examples/test-dispatch-guard.mjs   # the fixture
npm run check:dispatch-guard                                       # the same run as a gate step
```

The fixture registers the extension into a stand-in `pi`, then calls the captured `tool_call` handler with the argument object the tool would receive, and reads what came back.
