# Minimal pi-braid extension

A single-tool extension (`hello`) that shows the minimal shape every pi
extension follows. Compare with a real contrib module -
[`packages/contrib/sleep/index.ts`](../../packages/contrib/sleep/index.ts) -
for the full feature set (validation, logging, event handlers).

## Tool-registration snippet

The core of any extension is the factory + `pi.registerTool`:

```ts
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function myExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "my_tool", // unique across everything pi loads
    label: "My Tool",
    promptSnippet: "What the tool does, in agent-reader terms",
    description: "Full description the agent reads to decide when to call it.",
    parameters: Type.Object({
      // TypeBox schema — pi validates arguments
      input: Type.String({ description: "…" }),
    }),
    execute: async (_toolCallId: string, params: any) => ({
      content: [{ type: "text" as const, text: `Got: ${params.input}` }],
    }),
  } as ToolDefinition<any, any, any>);
}
```

## Try it

```bash
# From the repo root
cp -r examples/minimal-extension /tmp/my-ext
```

Add to `~/.pi/agent/settings.json` (next to your braid packages):

```jsonc
{
  "packages": ["file:~/pi-braid/packages/core"],
  "extensions": ["file:/tmp/my-ext/index.ts"],
}
```

Restart pi and ask: _"say hello to the world"_.

## Next steps

- Extensions that belong in braid live under `packages/core/src/extensions/`
  and are registered in `packages/core/src/extensions/manifest.ts`.
- Standalone tooling that doesn't belong in core goes to `packages/contrib`.
- See [`packages/core/docs/BEGINNERS.md`](../../packages/core/docs/BEGINNERS.md) § 4–5 for the full walkthrough.
