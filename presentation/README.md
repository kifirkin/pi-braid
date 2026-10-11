<!-- status: current -->

# presentation

The pi & Braid slide deck (`index.html`, a single-file reveal.js deck served from CDN
assets), plus the redirect stub `presentation.html` for old links and `.nojekyll` so
GitHub Pages serves files as-is.

## How the deck is served

`.github/workflows/pages.yml` deploys this directory as the GitHub Pages artifact on
every push to `main` (and on manual `workflow_dispatch`): `actions/upload-pages-artifact`
packages `presentation/` and `actions/deploy-pages` publishes it. GitHub Pages must be
enabled once by the repo owner (Settings → Pages → Source: GitHub Actions); private
repos cannot serve Pages, so the workflow stays idle until the repo is public. Once
live, the deck is at `https://<owner>.github.io/pi-braid/` with `index.html` as the
entry point.

## How memory-stats.json is refreshed

`memory-stats.json` is generated, not edited. Run from this directory:

```bash
node scripts/refresh-memory-stats.mjs
```

The script reads Braid's memory stores and writes both `memory-stats.json` and an
identical inline `<script id="memory-stats-data">` block into `index.html` (so the
deck also works opened directly from `file://`, where `fetch` is blocked by CORS).
Set `BRAID_MEMORY_DIR` to read from a different Braid memory directory.

Counter sources:

- `episodes` — count of non-empty lines in `~/.pi/agent/braid/memory/episodes.jsonl`
- `semantic` — count of entries in the `memories` array of `~/.pi/agent/braid/memory/semantic.json`

File format: `{ "episodes": N, "semantic": N }`.
