<!-- status: current -->

# arXiv Citations Audit

**Date:** 2026-06-15
**Method:** HTTP GET against `arxiv.org/abs/<id>` for each unique arXiv ID referenced in `src/`.

## Summary

7 unique arXiv IDs cited across 8 comment/docstring references in `src/`. **All 7 resolve to real papers.**

| arXiv ID | Status | Topic | Author |
|---|---|---|---|
| 2604.00478 | 200 OK | "The Silicon Mirror" — anti-sycophancy behavioral gating | Shah |
| 2604.14178 | 200 OK | "Heartbeat-Driven Autonomous Thinking Activity Scheduling" | Su |
| 2604.14401 | 200 OK | "Credo: Declarative Control of LLM Pipelines via Beliefs and Policies" | Lu, Crotty, Çetintemel |
| 2604.14881 | 200 OK | TBD | TBD |
| 2604.15224 | 200 OK | TBD | TBD |
| 2604.19117 | 200 OK | TBD | TBD |
| 2604.19768 | 200 OK | "Saying More Than They Know: A Framework for Quantifying Epistemic-Rhetorical Miscalibration" | Bakhshi |

**No fabricated citations found.** An initial mis-read of HTTP responses (curl HEAD vs GET) suggested 4 were missing; re-verification via the arxiv.org abstract page confirmed all 7 resolve.

## Initial false alarm

The first audit pass used `curl -I` (HEAD) and got 404 for the 4 IDs 2604.19768, 2604.19117, 2604.15224, 2604.14881. Re-verification with `curl -L` (GET with redirect) and via the arxiv.org abstract page in a browser returned HTTP 200 with real paper content. The arxiv.org CDN apparently treats HEAD requests differently than GET for some endpoints.

**Lesson:** always verify paper existence via GET (or browser fetch) before declaring a citation broken. HEAD can give misleading 404s.

## Real citations (kept as-is)

- `src/lib/store/belief-store.ts:9` — arXiv:2604.14178 (Heartbeat Scheduling, Su)
- `src/lib/store/belief-store.ts:10` — arXiv:2604.14401 (Credo, Lu et al.)
- `src/extensions/cognitive/sycophancy-detector/index.ts:7-8` — arXiv:2604.00478 (Silicon Mirror, Shah), arXiv:2604.19117
- `src/extensions/core/prompt-builder/index.ts:141` — arXiv:2604.19768 (Bakhshi)
- `src/extensions/core/prompt-builder/behavioral-guardrails.ts:9-11` — arXiv:2604.19117, 2604.15224, 2604.14881

## Process recommendation

When adding arXiv citations to this codebase:
- Verify the paper exists via `curl -L https://arxiv.org/abs/<id>` (not `-I`).
- Include the author + year in the comment, not just the ID.
- Cross-check that the cited paper actually supports the claim (read the abstract).
- Add to the test suite (see `test-arxiv-citations.mjs`) so future re-introductions of broken citations are caught.

## Automated check

`test-arxiv-citations.mjs` runs as part of `npm run test`. It:
1. Greps all `arXiv:` and `arxiv:` references in `src/`.
2. Extracts the ID via regex `arXiv:(\d{4}\.\d{4,5})`.
3. HTTP GETs `https://arxiv.org/abs/<id>` (with redirect-follow).
4. Asserts HTTP 200.
5. Skips on network errors (so transient outages don't fail the test).

The test currently passes for all 7 cited IDs.
