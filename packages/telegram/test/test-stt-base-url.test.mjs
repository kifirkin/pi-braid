/**
 * test-stt-base-url.test.mjs — chat-mode STT default baseUrl
 * derived from the userland venice catalog. HERMETIC: every catalog read
 * targets a mkdtempSync temp file — NO real-HOME reads (the default
 * ~/.pi/agent/venice-models.json is never touched; the one no-arg call runs
 * with VENICE_CATALOG_FILE pointed at a temp file — the env override the
 * canonical reader convention honors first).
 *
 * Covers: (1) catalog with https baseUrl → returned; (2) absent file → null;
 * (3) malformed JSON / non-https / wrong shape → null; (4) resolution order
 * in chat mode: env > catalog > legacy default; (5) env override wins over
 * catalog; (6) transcriptions mode unaffected (catalog NOT used — it is a
 * chat-completions proxy, not an /audio/transcriptions route); plus
 * never-throws on unreadable paths.
 *
 * Fixture URLs are neutral examples (gateway.example / env-override.example)
 * — no deployment URLs in tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCatalogBaseUrl } from "../dist/lib/venice-catalog-base-url.js";
// DEFAULT_STT_CHAT_BASE_URL lives in transcribe.ts (index.ts imports it; it is
// not re-exported) — import it from the same dist module transcribe.test.mjs uses.
import { DEFAULT_STT_CHAT_BASE_URL } from "../dist/lib/transcribe.js";
import { resolveSttBaseUrl } from "../dist/index.js";

const CATALOG_URL = "https://gateway.example/v1";
const ENV_URL = "https://env-override.example/v1";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "w91-stt-"));
}

function writeCatalog(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(
    p,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return p;
}

// ── readCatalogBaseUrl (lib/venice-catalog-base-url.ts) ─────────────────────

test("readCatalogBaseUrl: valid catalog with https baseUrl → returned", () => {
  const dir = makeTempDir();
  try {
    const p = writeCatalog(dir, "catalog.json", {
      baseUrl: CATALOG_URL,
      models: [],
    });
    assert.equal(readCatalogBaseUrl(p), CATALOG_URL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalogBaseUrl: absent file → null", () => {
  const dir = makeTempDir();
  try {
    assert.equal(readCatalogBaseUrl(join(dir, "missing.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalogBaseUrl: malformed JSON → null (never throws)", () => {
  const dir = makeTempDir();
  try {
    const p = writeCatalog(dir, "broken.json", "{not json");
    assert.equal(readCatalogBaseUrl(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalogBaseUrl: non-https / missing / non-string baseUrl → null", () => {
  const dir = makeTempDir();
  try {
    assert.equal(
      readCatalogBaseUrl(
        writeCatalog(dir, "http.json", {
          baseUrl: "http://insecure.example/v1",
        }),
      ),
      null,
    );
    assert.equal(readCatalogBaseUrl(writeCatalog(dir, "empty.json", {})), null);
    assert.equal(
      readCatalogBaseUrl(writeCatalog(dir, "number.json", { baseUrl: 12345 })),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalogBaseUrl: non-object JSON (array / null literal) → null", () => {
  const dir = makeTempDir();
  try {
    assert.equal(
      readCatalogBaseUrl(writeCatalog(dir, "array.json", "[1,2,3]")),
      null,
    );
    assert.equal(
      readCatalogBaseUrl(writeCatalog(dir, "null.json", "null")),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalogBaseUrl: unreadable path (directory) → null, never throws", () => {
  const dir = makeTempDir();
  try {
    assert.equal(readCatalogBaseUrl(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalogBaseUrl: honors $VENICE_CATALOG_FILE (canonical reader convention)", () => {
  const dir = makeTempDir();
  const prev = process.env.VENICE_CATALOG_FILE;
  try {
    const p = writeCatalog(dir, "env-pointed.json", {
      baseUrl: CATALOG_URL,
      models: [],
    });
    process.env.VENICE_CATALOG_FILE = p;
    assert.equal(readCatalogBaseUrl(), CATALOG_URL);
  } finally {
    if (prev === undefined) delete process.env.VENICE_CATALOG_FILE;
    else process.env.VENICE_CATALOG_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveSttBaseUrl (index.ts assembly seam) ──────────────────────────────

test("resolveSttBaseUrl (chat): env > catalog > legacy default", () => {
  assert.equal(
    resolveSttBaseUrl({
      env: ENV_URL,
      catalogBaseUrl: CATALOG_URL,
      mode: "chat",
    }),
    ENV_URL,
  );
  assert.equal(
    resolveSttBaseUrl({ catalogBaseUrl: CATALOG_URL, mode: "chat" }),
    CATALOG_URL,
  );
  assert.equal(
    resolveSttBaseUrl({ catalogBaseUrl: null, mode: "chat" }),
    DEFAULT_STT_CHAT_BASE_URL,
  );
  assert.equal(resolveSttBaseUrl({}), DEFAULT_STT_CHAT_BASE_URL);
});

test("resolveSttBaseUrl: env override wins over catalog (both modes)", () => {
  assert.equal(
    resolveSttBaseUrl({ env: ENV_URL, catalogBaseUrl: CATALOG_URL }),
    ENV_URL,
  );
  assert.equal(
    resolveSttBaseUrl({
      env: ENV_URL,
      catalogBaseUrl: CATALOG_URL,
      mode: "transcriptions",
    }),
    ENV_URL,
  );
});

test("resolveSttBaseUrl: transcriptions mode ignores the catalog (unchanged legacy fallback)", () => {
  assert.equal(
    resolveSttBaseUrl({ catalogBaseUrl: CATALOG_URL, mode: "transcriptions" }),
    DEFAULT_STT_CHAT_BASE_URL,
  );
});

test("resolveSttBaseUrl: empty-string env override still wins (legacy ?? semantics)", () => {
  assert.equal(resolveSttBaseUrl({ env: "", catalogBaseUrl: CATALOG_URL }), "");
});
