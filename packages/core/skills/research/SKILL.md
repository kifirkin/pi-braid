---
name: research
description: "Research topics, verify facts, and find information online. Covers web search (DuckDuckGo HTML as primary, SearXNG as unreliable fallback), direct page fetching, fact-checking, literature review, and evidence gathering. Use when looking up information, verifying claims, comparing sources, or finding current data."
validated: 2026-08-16
verdict: KEEP
---

# Research

Research topics, verify facts, and find information online.

---

## When to Use

- Researching or verifying facts
- Current events or time-sensitive information
- Questions about: check, verify, confirm, look up, compare
- Literature review for papers or proposals
- Finding specific information not in training data

---

## Workflow

1. **Formulate query** - specific terms beat broad ones
2. **Search** - use DuckDuckGo HTML search to find relevant pages
3. **Read page** - fetch the actual content with `fetch_content`, not just the search snippet
4. **Synthesize** - answer from the actual content
5. **Cite sources** - include the URL you extracted from

---

## Research Methods

### Method A: Web Search via DuckDuckGo HTML (Primary)

For finding information when you don't have a specific URL, use **DuckDuckGo's HTML interface** - it is reliable, has minimal anti-bot measures, and works well with `fetch_content`.

#### Usage

```bash
fetch_content "https://html.duckduckgo.com/html/?q=your+search+query"
```

**Query parameters:**

- `q` (required): Search query. Supports `site:`, `intitle:`, etc.
- `kl=us-en`: Language/region. Use for locale-specific results.

For a lighter (text-only) variant:

```bash
fetch_content "https://lite.duckduckgo.com/lite/?q=your+query&kl=us-en"
```

**Note:** `fetch_content` converts HTML to clean markdown, giving you structured results with titles, URLs, and snippets. Prompt injection detection may flag results - this is normal for search result pages and does not affect the data.

#### Time-Sensitive Queries

For current events, append year or month to the query:

```bash
fetch_content "https://html.duckduckgo.com/html/?q=AI+regulation+April+2026"
```

Also consider the current date when evaluating result relevance.

---

### Method B: Direct Page Fetching

When you already have a URL or need to read a specific page in depth:

```bash
fetch_content <url>
```

Best for:

- Official documentation
- Specific articles you found via search
- Pages where you need the full content, not just a summary

---

### Method C: Hybrid Search → Fetch (Recommended)

The most effective approach for most research tasks:

1. **Search** with DuckDuckGo HTML to find relevant URLs
2. **Fetch** the 2-3 most promising results with `fetch_content`
3. **Synthesize** across sources
4. **Cite** all sources used

---

### Method D: SearXNG Meta-Search (Unreliable Fallback)

SearXNG aggregates results from multiple engines (Google, Bing, DuckDuckGo) simultaneously. However, **public instances are unreliable** - most block JSON API access, rate-limit aggressively, or go offline.

If you want to try:

```bash
curl -sL --max-time 10 'https://<instance>/search?q=query&format=json'
```

**Do not rely on this.** The JSON API is disabled on most public instances. Use Method A (DuckDuckGo HTML) instead.

---

## Fact Verification

For claims that need verification:

1. Find at least two independent sources
2. Check publication dates (outdated info ≠ wrong info)
3. Note consensus vs disagreement
4. Report confidence level
5. Use `time_range` or date-specific queries for recent claims

## Literature Review

For academic or technical research:

1. Identify key terms from the question
2. Search papers, docs, and technical content
3. Prioritize: top-tier AI conferences, arXiv, official docs, authoritative blogs
4. Extract key claims, methods, and findings
5. Synthesize into coherent narrative
6. Cite sources

## Comparative Research

When comparing options or approaches:

1. Define criteria upfront
2. Gather data for each option against each criterion
3. Note tradeoffs honestly
4. Report the comparison, not just the winner

---

## Evidence Quality

| Source                 | Reliability | Notes                                |
| ---------------------- | ----------- | ------------------------------------ |
| Official documentation | High        | Primary source                       |
| arXiv / peer-reviewed  | High        | Peer-reviewed > preprint             |
| Authoritative blog     | Medium-High | Depends on author expertise          |
| Forum / Q&A            | Medium      | Often outdated, verify independently |
| Social media           | Low         | Last resort, verify everything       |

Always note the source and date when reporting findings.

---

## Troubleshooting

| Problem                              | Solution                                                            |
| ------------------------------------ | ------------------------------------------------------------------- |
| DuckDuckGo returns "no results"      | Try simplifying the query; use `lite.duckduckgo.com` variant        |
| `fetch_content` gets 403 on a result | The site blocks bots; try `curl -A "Mozilla/5.0"` directly          |
| Results are outdated                 | Append month/year to query (e.g., `April 2026`)                     |
| Page content is paywalled            | Try `fetch_content` on the URL anyway - often extracts article text |
| Need real-time data                  | Use DuckDuckGo HTML with very recent date in query                  |
