#!/usr/bin/env node
/**
 * refresh-memory-stats.mjs
 *
 * Reads Braid's memory stores and:
 *   1. Writes memory-stats.json (fetch fallback for http(s) hosting)
 *   2. INLINES the same data into index.html as a <script
 *      id="memory-stats-data" type="application/json"> block — so the
 *      deck works perfectly when opened directly from file:// (no CORS).
 *
 * The HTML's JS reads the embedded block first; if missing, falls back
 * to fetch('memory-stats.json'). This keeps both deployment modes robust.
 *
 * Usage:
 *   node scripts/refresh-memory-stats.mjs
 *
 * Override the braid memory dir with BRAID_MEMORY_DIR.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BRAID_DIR =
  process.env.BRAID_MEMORY_DIR || join(homedir(), ".pi", "agent", "braid");
const OUT_JSON = join(ROOT, "memory-stats.json");
const OUT_HTML = join(ROOT, "index.html"); // GitHub Pages serves the deck from the root index convention; presentation.html is a redirect stub

function countJsonlEntries(path) {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim()) n++;
  }
  return n;
}

function countJsonEntries(path) {
  if (!existsSync(path)) return 0;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(data)) return data.length;
    if (Array.isArray(data?.memories)) return data.memories.length;
    if (Array.isArray(data?.entries)) return data.entries.length;
    return 0;
  } catch {
    return 0;
  }
}

const stats = {
  episodes: countJsonlEntries(join(BRAID_DIR, "memory", "episodes.jsonl")),
  semantic: countJsonEntries(join(BRAID_DIR, "memory", "semantic.json")),
};

// 1. memory-stats.json (fallback for fetch under http(s))
writeFileSync(OUT_JSON, JSON.stringify(stats, null, 2) + "\n", "utf8");
console.log(
  `✓ memory-stats.json → episodes=${stats.episodes} semantic=${stats.semantic}`,
);

// 2. Inline into index.html (primary, makes file:// work)
const EMBED_ID = "memory-stats-data";
const EMBED_TAG = `<script id="${EMBED_ID}" type="application/json">${JSON.stringify(stats)}</script>`;
const escOpen = EMBED_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
  /<\//g,
  "<\\/",
);
const EMBED_REGEX = new RegExp(
  `<script id="${EMBED_ID}" type="application\\/json">[\\s\\S]*?<\\/script>`,
);

let html = readFileSync(OUT_HTML, "utf8");

if (EMBED_REGEX.test(html)) {
  html = html.replace(EMBED_REGEX, EMBED_TAG);
  console.log(`✓ updated embedded <script id="${EMBED_ID}"> block`);
} else if (html.includes("</body>")) {
  html = html.replace("</body>", `${EMBED_TAG}\n</body>`);
  console.log(`✓ injected new <script id="${EMBED_ID}"> before </body>`);
} else {
  html = html + "\n" + EMBED_TAG + "\n";
  console.log(`✓ appended <script id="${EMBED_ID}"> (no </body>)`);
}

writeFileSync(OUT_HTML, html, "utf8");
console.log(`✓ index.html rewritten (${html.length} bytes)`);
