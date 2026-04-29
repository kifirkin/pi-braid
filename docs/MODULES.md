# Module System

> How extensions are grouped into modules and toggled at runtime.

## Overview

Extensions are grouped into 14 modules. Modules are loaded based on the `BRAID_MODULES` environment variable:

```bash
# Enable everything (default)
export BRAID_MODULES="all"

# Enable specific modules
export BRAID_MODULES="core,cognitive,memory,retry"
```

The `core` module is always on regardless of `BRAID_MODULES`.

## Module Definitions

Defined in `src/modules/definitions.ts`:

```typescript
export const MODULE_DEFINITIONS: ModuleDefinition[] = [
  {
    name: "core",
    extensions: [{ name: "polyfill" }, { name: "metacognition" }, ...],
    alwaysOn: true,
  },
  { name: "cognitive", extensions: [...], alwaysOn: false },
  // ...
];
```

## Module Loading

`src/modules/loader.ts` loads extensions based on module configuration:

1. Read `BRAID_MODULES` env var
2. If `all`, load every module
3. If specific, load only those modules (plus `core`)
4. Each extension's factory function is called via dynamic import

## Runtime Toggling

Researcher subagents can toggle modules during benchmark sessions:

| Command                   | Effect                           |
| ------------------------- | -------------------------------- |
| `/modules-list`           | Show all modules and their state |
| `/modules-enable <name>`  | Enable a module (next session)   |
| `/modules-disable <name>` | Disable a module (next session)  |
| `/modules-toggle <name>`  | Toggle a module on/off           |
| `/modules-status`         | Show current load state          |
| `/modules-reset`          | Reset all runtime overrides      |

## Extension Directory Structure

Every extension lives at:

```
src/extensions/<module>/<extension>/index.ts
```

Example:

```
src/extensions/
  core/
    metacognition/
      index.ts
      handlers/
        think.ts
        hypothesize.ts
        finalize.ts
        scoring.ts
  cognitive/
    enforcement/
      index.ts
      detection/
      whisper.ts
  memory/
    three-memory-stores/
```

The module name matches the parent directory; the extension name matches the leaf directory.

## Adding a New Extension

1. Create `src/extensions/<module>/<extension>/index.ts`
2. Add to the module's `extensions` array in `definitions.ts`
3. Register tools and event handlers
4. Use `getExtensionState(ctx, "extension-name", factory)` for session state
5. Add test in `test/runtime/test-<extension>.mjs`
6. Update this document
