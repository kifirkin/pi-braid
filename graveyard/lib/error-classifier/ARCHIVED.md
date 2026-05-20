# error-classifier.ts — Structured Error Classification

**Origin**: Part of error-tracking module development.

**What it was supposed to do**: Classify errors by category, severity, and suggested action.
150+ line type definitions and classification logic.

**Why it was abandoned**: Never imported by any extension in `src/`. The enforcement module
handles error classification inline. The error-tracking extension uses simpler internal
categorization.

**Tests**: None (the test file was removed).

**Docs**: `docs/lib/error-classifier.md` — moved to graveyard.