# tool-registrations.ts — Enforcement Commands (Empty Shell)

**Origin**: Part of enforcement module, created during the command registration refactor.

**What it was supposed to do**: Register enforcement CLI commands: `enforcement-stats`,
`enforcement-on`, `enforcement-off`.

**Why it was abandoned**: All three commands were removed on 2026-04-28. Enforcement operates
entirely via event handlers and whisper messages. The file was left as an empty shell with
just a logger and explanatory comment. The import in-file header says it all: "All commands removed."

**Tests**: None.

**Note**: This file is referenced in the DEAD-EXTENSION-CLEANUP proposal as "Phase 1: Vestigial Commands."