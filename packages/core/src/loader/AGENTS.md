<!-- status: current -->

# src/loader/ - Extension Loader + Subagent API

Runtime machinery that decides which extensions to load and exposes
runtime toggling to a researcher subagent.

This directory was previously named `src/modules/`. The rename clarifies
that it contains the **loader** (and the related subagent API), not
"module definitions" - the flat extension manifest lives in
`src/extensions/manifest.ts`.

## Files

| File        | Purpose                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loader.ts` | Resolves `BRAID_MODULES` / `braid.modules` (pi global, pi project, braid's store) / runtime overrides into an enabled set, topologically sorts by dependency, and invokes each factory. |
| `api.ts`    | Registers `/modules-enable`, `/modules-disable`, `/modules-toggle`, `/modules-list`, `/modules-status`, `/modules-reset` commands for the subagent API.                                 |

## Layer position

Per `scripts/check-deps.mjs`:

- `loader/` may import from `lib/` and `extensions/` (it must read the manifest to know what to load).
- `loader/` may not import from other top-level layers.
- `lib/` and `extensions/` may not import from `loader/`.

## Local contracts

- The loader never imports from `extensions/` for _types_ - only the manifest file. This keeps the dependency direction clean.
- State is process-global (`_loaderState`). Don't put per-session data here.
- Persisted state lives in braid's own `braid.modules` store, not in a pi settings file: `getModuleOverridesFilePath()` resolves `braidDir()/projects/<project>/module-overrides.json` (`braidDir()/module-overrides.json` with no cwd), installed by a temp-file-plus-rename write. pi's global and project settings files are read as inputs, in that order, and never written.
