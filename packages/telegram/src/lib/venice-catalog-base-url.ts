/**
 * venice-catalog-base-url.ts — chat-mode STT default baseUrl from the
 * userland venice catalog.
 *
 * Canonical reader: packages/providers/venice-catalog.ts (loadVeniceCatalog /
 * defaultVeniceCatalogPath). This module is a dependency-free mirror of its
 * path resolution + baseUrl validation ONLY — telegram is zero-dep BY DESIGN,
 * so there is NO package edge to providers and NO model parsing here. The
 * deployed STT credential is a gateway-era key that Venice direct rejects;
 * the catalog's baseUrl is the gateway that accepts it (the same pairing the
 * providers extension already uses for all model traffic).
 *
 * Resolution: $VENICE_CATALOG_FILE, else ~/.pi/agent/venice-models.json.
 * Valid JSON object with a string baseUrl starting "https://" → that baseUrl;
 * absent file, malformed JSON, wrong shape, or any read error → null. Never
 * throws (best-effort: the STT path degrades to the legacy default instead of
 * crashing extension load).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Read the userland venice catalog's gateway baseUrl (best-effort, never throws). */
export function readCatalogBaseUrl(filePath?: string): string | null {
  const p =
    filePath ??
    process.env.VENICE_CATALOG_FILE ??
    join(homedir(), ".pi", "agent", "venice-models.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.baseUrl !== "string" ||
      !raw.baseUrl.startsWith("https://")
    ) {
      return null;
    }
    return raw.baseUrl;
  } catch {
    return null;
  }
}
