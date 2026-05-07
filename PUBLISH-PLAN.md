# pi-braid Publishing Prep — Overnight Sprint Plan

**Goal**: Repo ready for public GitHub publishing in one pass.
**Estimated time**: 6–8 hours of agent work.
**Branch**: `develop` → merge to `main` when done.

---

## Phase 1: Security & Hygiene (30 min) — CRITICAL, do first

- [ ] Remove 6 session HTML files from root (~10MB) — `rm pi-session-*.html`
- [ ] Add `*.html` and `pi-session-*` to `.gitignore`
- [ ] Scan ALL files for hardcoded secrets, tokens, API keys
- [ ] Verify no personal paths (`/Users/kifir`) leaked into source
- [ ] Remove `dist/` from git tracking (already in .gitignore but tracked)
- [ ] Remove compiled `extensions/`, `lib/`, `modules/` dirs from git tracking
- [ ] Add these dirs to `.gitignore` explicitly
- [ ] Run `git rm -r --cached` on all compiled output

## Phase 2: package.json Polish (30 min)

- [ ] Bump version to `0.2.0` (drop alpha)
- [ ] Add `files` field: `["dist/", "skills/", "docs/", "braid-os/", "README.md", "LICENSE", "AGENTS.md"]`
- [ ] Add `exports` field for ESM entry
- [ ] Add `bugs` URL, `homepage` URL
- [ ] Review `keywords` — add `agent-extension`, `llm-agent`, `self-improvement`
- [ ] Verify `engines` field or add one
- [ ] Ensure `scripts.prepublishOnly` runs typecheck + build
- [ ] Add `scripts.prepare` for post-install build

## Phase 3: README.md Rewrite (1 hour)

- [ ] Professional opening — what it is, why it exists, what problem it solves
- [ ] Architecture diagram (ASCII or mermaid)
- [ ] Feature list with brief descriptions
- [ ] Installation instructions (npm + manual)
- [ ] Configuration section (settings.json, environment variables)
- [ ] Module overview table
- [ ] Development section link
- [ ] License badge, build status badge (if CI setup)
- [ ] Remove informal language, polish tone

## Phase 4: Documentation Cleanup (2 hours)

- [ ] Audit all 101 doc files — delete stale/irrelevant ones
- [ ] Delete `docs/.archive-old/` entirely (3 files, historical)
- [ ] Write `CONTRIBUTING.md` — dev setup, PR process, code style
- [ ] Update `docs/ARCHITECTURE.md` — reflect current state
- [ ] Update `docs/CHANGELOG.md` — add v0.37.0 entry
- [ ] Verify all doc internal links are valid
- [ ] Ensure `AGENTS.md` is accurate for new contributors
- [ ] Delete any docs referencing deleted features (prompt-guardian, browser, planner)

## Phase 5: Source Code Quality (2 hours)

- [ ] Remove dead code — unused exports, unreachable branches
- [ ] Remove stale imports (already partially done)
- [ ] Audit all `TODO`/`FIXME`/`HACK` comments — resolve or create issues
- [ ] Consistent error handling — no bare `catch {}` (except JSON.parse of untrusted data)
- [ ] Verify all exported functions have JSDoc
- [ ] Check for `console.log` statements (should use logger)
- [ ] Verify no circular dependencies (run dependency graph)
- [ ] Ensure all public APIs have TypeScript types
- [ ] Run `eslint` if configured, fix violations

## Phase 6: Build & Test Verification (30 min)

- [ ] `npm run typecheck` — clean
- [ ] `npm run build` — clean, verify dist/ output
- [ ] `npm run test` — 61/61 pass
- [ ] `npm pack --dry-run` — verify only intended files included
- [ ] Test install from local tarball in temp dir
- [ ] Verify `pi -e /path/to/pi-braid/src/index.ts` still works

## Phase 7: Final Polish (30 min)

- [ ] Squash or organize commit history on develop (optional — rebase)
- [ ] Merge develop → main
- [ ] Tag as `v0.2.0`
- [ ] Verify GitHub repo settings: description, topics, homepage
- [ ] Write GitHub release notes

## Known Issues (investigate later)

- [ ] `context_prune(dryRun=false)` kills agent loop — blocks autonomous sessions
- [ ] `~/.pi/memory/memory.json` legacy fallback — can remove after transition period
- [ ] `test-cognitive-memory.mjs` clears all memories during test — need isolated test data

---

## Execution Notes

- Use `context_archive` only for context management (NOT `context_prune`)
- Commit after each phase
- Run full test suite after Phases 1, 5, 6
- Store key learnings in memory after each phase
