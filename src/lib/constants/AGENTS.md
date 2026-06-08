# src/lib/constants/ — Project-wide Constants

Shared constants and enums. Keep this dir minimal — most constants should
live with the code that uses them.

## When to add a constant here

Add to `lib/constants/` only when:
- The constant is used by 3+ modules across different subdirs.
- The value is a "magic number/string" that benefits from a named alias.

Otherwise, define the constant next to its usage.
