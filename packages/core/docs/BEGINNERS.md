<!-- status: current -->

# Beginner's Guide to pi-braid

This guide bridges **install → how agents use braid → writing your first
extension**. It assumes you have pi-coding-agent installed and know roughly
what an agent session is. For the complete setup reference (all install
paths, module toggles, troubleshooting) see [`SETUP.md`](SETUP.md).

---

## 1. What pi-braid is

pi is a coding agent with a base agent loop and a small built-in toolset.
**Extensions** are the way pi gets more capability: they register tools,
listen for session events, and shape the system prompt.

pi-braid is a collection of extensions that add a **metacognitive layer**:
memory that survives between sessions, reasoning tools (`think`, `verify`,
`finalize`), enforcement of agent-behavior policies, and self-improvement.
It is a monorepo of five workspaces; the one you care about first is
`packages/core`.

## 2. Install

The fast way, from npm:

```bash
pi install npm:pi-braid
```

`pi install` registers the package with pi in `~/.pi/agent/settings.json` and
installs it under pi's npm directory, so there is nothing to clone and nothing
to build. This one package carries the metacognitive suite and the core skill
set; the other packages are add-ons:

```bash
pi install npm:pi-braid-skills     # the on-demand skill pack (per project)
pi install npm:pi-braid-contrib    # standalone tool extensions
pi install npm:pi-braid-providers  # extra LLM providers
pi install npm:pi-braid-telegram   # bidirectional Telegram channel
```

### Working from a checkout

If you want to modify braid or run the latest `main`, clone and build instead:

```bash
git clone https://github.com/kifirkin/pi-braid.git ~/pi-braid
cd ~/pi-braid && npm install && npm run build
```

Tell pi to load the core workspace (and any siblings you want):

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "file:~/pi-braid/packages/core",
    "file:~/pi-braid/packages/skills",
    "file:~/pi-braid/packages/contrib",
  ],
}
```

Then start pi. You're done when you see the braid tools in `<Available
tools>` (memory, timer, workspace_snapshot, …) and the braid skills in
`<available_skills>`.

## 3. How agents use braid

An agent session is a loop: see the system prompt → pick a tool → run it →
observe → repeat. braid changes what the agent _can_ do at each step:

- **Metacognitive tools** - `think` (structured reasoning before hard
  decisions), `verify` (check work after an edit), `finalize` (close a task
  with evidence). These are always-on.
- **Memory** - `memory_store` / `memory` let the agent persist and recall
  across sessions. Three stores: episodes (what happened), semantic (facts),
  heuristics (procedural rules). The agent uses them automatically.
- **Scratchpad** - per-session goal/plan/decision tracking that survives
  context compaction.
- **Context lifecycle** - the agent manages its own context window
  (`context_compress`, `context_navigate`), the same way you'd organize a
  long to-do.
- **Skills** - `SKILL.md` files the agent reads on demand (a `software-engineer`
  skill defines how it debugs; a `research` skill defines how it researches).
  Skills cost nothing until opened.

You don't "use" most of this yourself - the agent does, guided by its system
prompt and the skill files. Your job is to pick which extensions to enable
and point the agent at the right docs.

## 4. Anatomy of a braid extension

An extension is a **factory function** that receives `pi` (the extension API)
and registers tools / event handlers:

```ts
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function myExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "hello",
    label: "Hello",
    promptSnippet: "Say hello",
    description: "Say hello to the user.",
    parameters: Type.Object({
      who: Type.String({ description: "Who to greet" }),
    }),
    execute: async (_toolCallId: string, params: any) => ({
      content: [{ type: "text" as const, text: `Hello, ${params.who}!` }],
    }),
  } as ToolDefinition<any, any, any>);
}
```

Key points:

- **Tool name** must be unique across everything pi loads; `description` is
  what the agent reads to decide whether to call the tool.
- **Parameters** use TypeBox schemas - pi validates the agent's arguments
  against them.
- **`execute`** returns a content block. Return `{ content: [{ type: "text",
text: ... }] }`.
- The factory can also `pi.on(...)` session events (see
  `packages/core/src/lib/core/event-names.ts`).

## 5. Your first extension

A runnable example lives at **`examples/minimal-extension/`** - copy it into
a scratch directory and point pi at it:

```jsonc
// ~/.pi/agent/settings.json — alongside your braid packages
{
  "packages": ["file:~/pi-braid/packages/core"],
  "extensions": ["file:~/my-extensions/index.ts"],
}
```

Then start pi and ask: _"say hello to the world"_. The agent should call
your `hello` tool.

### Extending braid itself

Extensions that belong in braid are added under `packages/core/src/extensions/`
and registered in `src/extensions/manifest.ts` (the flat list the loader
reads). Each gets a `module` label for the toggle commands. Follow the layout
of an existing group (e.g. `src/extensions/cognitive/`) and the contract in
`packages/core/AGENTS.md`.

If your extension is standalone tooling that doesn't belong in core, put it
in `packages/contrib` (see [`../../contrib/README.md`](../../contrib/README.md)).

## 6. Where to go next

| Topic                         | Doc                                              |
| ----------------------------- | ------------------------------------------------ |
| Full install + module toggles | [`SETUP.md`](SETUP.md)                           |
| Core contributor contract     | [`../AGENTS.md`](../AGENTS.md)                   |
| Tool catalog (canonical)      | [`../TOOLS.md`](../TOOLS.md)                     |
| Roadmap + shipped milestones  | [`ROADMAP.md`](ROADMAP.md)                       |
| Project history               | [`HISTORY.md`](HISTORY.md)                       |
| Release notes                 | [`../../../CHANGELOG.md`](../../../CHANGELOG.md) |
