/**
 * Test: arXiv citations in src/ resolve to real papers.
 *
 * HISTORY (see docs/ARXIV-CITATIONS-AUDIT.md, 2026-06-15):
 *   The codebase contained 4 fabricated arXiv citations
 *   (2604.19768, 2604.19117, 2604.15224, 2604.14881) -- all
 *   returned HTTP 404 from arxiv.org. They had been hallucinated
 *   by a language model at some point in the codebase's history.
 *
 * FIX: removed the 4 fabricated citations and replaced them with
 * either a real citation or an inline English description without
 * a fake paper. This test pins the rule: every arXiv: ID in src/
 * must resolve to a real paper (HTTP 200 from arxiv.org).
 *
 * The test is allow-listed: it scans src/ and only fails if it
 * finds a citation that doesn't resolve. The 3 real papers
 * (2604.00478, 2604.14178, 2604.14401) are still cited.
 */

import { strict as assert } from "node:assert";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

const ARXIV_RE = /ar[Xx]iv:(\d{4}\.\d{4,5})/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

const cited = new Set();
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf-8");
  for (const m of src.matchAll(ARXIV_RE)) {
    cited.add(m[1]);
  }
}

console.log(`Found ${cited.size} unique arXiv citations in src/:`);
for (const id of [...cited].sort()) console.log(`  - arXiv:${id}`);

// Verify each one resolves to arxiv.org. We use a HEAD request to
// avoid downloading the full page. If arxiv.org is unreachable, we
// skip (network errors don't fail the test, only 404s do).
async function check(id) {
  const url = `https://arxiv.org/abs/${id}`;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return { id, status: res.status, ok: res.ok };
  } catch (e) {
    return { id, status: 0, ok: null, error: e.message };
  }
}

const results = await Promise.all([...cited].map(check));

const broken = results.filter(r => r.ok === false);
const unreachable = results.filter(r => r.ok === null);

if (broken.length > 0) {
  console.error("\n❌ BROKEN arXiv citations (HTTP non-200):");
  for (const b of broken) {
    console.error(`  - arXiv:${b.id} -> HTTP ${b.status}`);
  }
  assert.equal(
    broken.length,
    0,
    `Found ${broken.length} broken arXiv citations. Remove or replace them. ` +
      `See docs/ARXIV-CITATIONS-AUDIT.md for the audit.`,
  );
}

if (unreachable.length > 0) {
  console.warn("\n⚠ arxiv.org unreachable for some IDs (network error, test skipped):");
  for (const u of unreachable) {
    console.warn(`  - arXiv:${u.id}: ${u.error}`);
  }
}

console.log(
  `\n✅ arXiv citation check: ${cited.size} cited, ${results.length - broken.length} resolve, ` +
    `${broken.length} broken.`,
);
