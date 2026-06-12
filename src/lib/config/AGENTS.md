# src/lib/config/ - Configuration

Configuration loading and merging for the extension tree.

## Files

| File | Purpose |
|---|---|
| `*.ts` | Config loaders per source (env, settings file, runtime API). |

## Local Contracts

- Config sources are merged with priority: runtime API > env > settings file > defaults.
- Each extension reads its config via `getExtensionState(ctx, ...)` rather than reading globals directly.
- Changes to config shape should be backward-compatible - old settings files should still load.
