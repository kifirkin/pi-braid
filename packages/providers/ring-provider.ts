/**
 * Ring-backed api-key auth for a route whose provider definition comes from
 * pi-ai rather than from this package.
 *
 * A route in `braid.providers.routes` names a provider id and a key prefix. For
 * the routes this package builds itself (agent-zero, venice-direct) the key ring is the
 * auth source by construction. For any other route pi-ai ships the provider
 * definition, and that definition's api-key auth reads a bare env var
 * (`OPENCODE_API_KEY`, `OPENROUTER_API_KEY`) — a second key source beside the
 * ring: outside the ring's rotation, outside its cross-process cooldown state,
 * and one more secret to keep in the shell. This module re-points such a
 * definition's api-key auth at the route's ring, so the ring is the ONE key
 * source for every configured route and a spent key walks the ring on the next
 * request exactly as it does for agent-zero.
 *
 * The module imports nothing from pi-ai: it reads and replaces `auth.apiKey` on
 * a structurally-typed provider. That keeps it drivable offline (the package's
 * test harness compiles these modules with the local tsc and never loads
 * pi-ai), and it keeps the provider-agnostic contract intact — no provider id,
 * no model id and no env var name appears here; every one of those is an
 * argument or comes from the owner's route table.
 *
 * @module
 */

import { resolveKeyRingAuth, type KeyRingAuthRing } from "./ring-lifecycle";

/**
 * The stored-credential fields the fallback reads. Declared structurally so
 * this module needs no pi-ai auth types; pi-ai's `ApiKeyCredential` is
 * assignable to it.
 */
export interface RingAuthCredential {
  key?: string;
  env?: Record<string, string>;
}

/** One resolved request auth: the api key plus the source label pi-ai reports. */
export interface RingAuthResult {
  auth: { apiKey: string };
  env?: Record<string, string>;
  source: string;
}

/** pi-ai's `ApiKeyAuth`, narrowed to the part ring resolution needs. */
export interface RingApiKeyAuth {
  name: string;
  resolve(input: {
    credential?: RingAuthCredential;
  }): Promise<RingAuthResult | undefined>;
}

/**
 * The provider surface this module reads and rewrites: identity plus the
 * api-key auth to replace. pi-ai's `Provider` is assignable to it.
 */
export interface RingProvider {
  readonly id: string;
  readonly name?: string;
  readonly auth?:
    | { readonly apiKey?: { readonly name?: string } | undefined }
    | undefined;
}

/**
 * Api-key auth backed by a key ring: the ring's active key on every call, so a
 * key exhausted by a 401/403/429 walks the ring on the next request with no
 * reload. The two null-key states stay distinct (see `resolveKeyRingAuth`): a
 * ring with no keys at all is genuinely unconfigured, while a ring whose keys
 * are all momentarily in backoff resolves the transient-exhaustion sentinel so
 * the provider's real error reaches the ring's backoff/rotation instead of
 * being mislabelled as a config error.
 *
 * A ring with no keys configured falls back to the stored credential — the
 * `/login` path pi-ai already reads — and then to nothing. The ring owns the
 * key whenever it has one; the credential exists so that re-pointing a provider
 * at a ring cannot silently disable a credential that provider honoured before.
 */
export function keyRingAuth(
  name: string,
  ring: KeyRingAuthRing,
): RingApiKeyAuth {
  return {
    name,
    resolve: async ({ credential }) => {
      const ringed = resolveKeyRingAuth(name, ring);
      if (ringed) return ringed;
      if (credential?.key) {
        return {
          auth: { apiKey: credential.key },
          env: credential.env,
          source: "stored credential",
        };
      }
      return undefined;
    },
  };
}

/**
 * The same provider with its api-key auth re-pointed at `ring`, or `null` when
 * the definition carries no api-key auth to re-point (an OAuth-only provider:
 * the ring cannot serve it, so the caller must leave the definition alone
 * rather than half-register it).
 *
 * Every other field — models, base URL, headers, the api dispatch and any
 * per-provider stream wrapper — is carried through untouched, so the
 * re-registered provider behaves exactly like the definition it replaces apart
 * from where the key comes from. The auth display name is taken from the
 * definition's own auth, so this module never invents one.
 */
export function withKeyRingAuth<P extends RingProvider>(
  provider: P,
  ring: KeyRingAuthRing,
): P | null {
  const apiKey = provider.auth?.apiKey;
  if (!apiKey) return null;
  const name = apiKey.name || provider.name || provider.id;
  return {
    ...provider,
    auth: { ...provider.auth, apiKey: keyRingAuth(name, ring) },
  } as P;
}
