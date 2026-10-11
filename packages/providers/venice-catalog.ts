// venice-catalog.ts — userland venice catalog seam.
//
// The agent-zero provider's model catalog (Venice's models, 93 entries incl. pricing)
// and its
// private gateway base URL are owner-private and must NOT ship in the public
// repo. The provider registers only when the userland catalog file exists.
// Resolution order: $VENICE_CATALOG_FILE, else ~/.pi/agent/venice-models.json.
// Absent or malformed -> null (provider not registered; the key-ring
// plumbing is unaffected). The file is owner-controlled (chmod 600)
// and loaded at extension load; a wrong shape degrades to "no provider"
// rather than crashing the session.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// The SDK's ProviderModelConfig is a discriminated union (chat | image |
// classifier). The catalog holds chat models, and that is the variant whose
// fields the route registration reads (reasoning, thinkingLevelMap,
// contextWindow, maxTokens, compat). Extract picks the variant out of the
// SDK's own union, so those fields are never restated here.
export type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

export interface VeniceCatalog {
  baseUrl: string;
  models: ChatModelConfig[];
}

export function defaultVeniceCatalogPath(): string {
  return (
    process.env.VENICE_CATALOG_FILE ??
    join(homedir(), ".pi", "agent", "venice-models.json")
  );
}

export function loadVeniceCatalog(filePath?: string): VeniceCatalog | null {
  const p = filePath ?? defaultVeniceCatalogPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.baseUrl !== "string" ||
      !raw.baseUrl.startsWith("https://") ||
      !Array.isArray(raw.models)
    ) {
      return null;
    }
    const models = raw.models.filter(
      (m: unknown): m is ChatModelConfig =>
        !!m &&
        typeof m === "object" &&
        typeof (m as { id?: unknown }).id === "string",
    );
    return models.length > 0 ? { baseUrl: raw.baseUrl, models } : null;
  } catch {
    return null;
  }
}
