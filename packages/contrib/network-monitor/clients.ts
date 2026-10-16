/**
 * Per-client adapters: the vendor facts the tunnel mechanism consumes.
 *
 * Everything in this file is a fact about one macOS tunnel client - the
 * network-extension bundle id, the app and extension process names, the
 * deep-link routes, the NE profile name the client creates. The mechanism
 * (tunnel.ts) takes them as data and carries no vendor name.
 *
 * Validation state per adapter:
 *   - v2raytun: re-derived from the installed host app (Info.plist scheme,
 *     app-binary route strings, ps/pgrep process names, scutil --nc list).
 *   - happ / incy: no install on this host. Routes come from the vendors'
 *     documentation where the docs define them and stay null where the docs
 *     do not; on-machine facts are null. `clientRefusal` refuses every
 *     action on such an adapter - probing included - until a host install
 *     supplies the missing facts.
 *
 * `installHint` is the one-time install command for a host that does not
 * carry the client.
 */

export type ClientId = "v2raytun" | "happ" | "incy";

export const CLIENT_IDS: readonly ClientId[] = ["v2raytun", "happ", "incy"];

export interface TunnelClientAdapter {
  id: ClientId;
  displayName: string;
  /** NE bundle id whose profiles `scutil --nc list` filters on. */
  bundleId: string | null;
  /** Anchor NE profile name for `scutil --nc status`; siblings are enumerated. */
  profileName: string | null;
  /** `pgrep -x` pattern for the client app process. */
  appProcess: string | null;
  /** `pgrep -f` pattern for the client's system-extension process. */
  extensionProcess: string | null;
  /** Deep link that disconnects the tunnel. */
  disconnectLink: string | null;
  /** Deep link that connects the tunnel. */
  connectLink: string | null;
  /** One-line provenance and validation state, surfaced in refusals. */
  validation: string;
  /** One-time install command for a host that does not carry the client. */
  installHint: string | null;
}

export const TUNNEL_CLIENTS: Record<ClientId, TunnelClientAdapter> = {
  v2raytun: {
    id: "v2raytun",
    displayName: "v2RayTun",
    bundleId: "com.databridges.privacy.v2RayTun",
    profileName: "v2RayTun",
    appProcess: "v2RayTun",
    extensionProcess: "com.databridges.privacy.v2RayTun.snextension",
    disconnectLink: "v2raytun://disconnect",
    connectLink: "v2raytun://connect",
    validation:
      "re-derived on this host: Info.plist URL scheme, app-binary route strings, ps/pgrep process names, scutil --nc list profiles",
    installHint: null,
  },
  happ: {
    id: "happ",
    displayName: "Happ",
    // Vendor docs document happ://add and happ://routing/* links only; no
    // VPN connect/disconnect route is documented, so none is claimed here.
    bundleId: null,
    profileName: null,
    appProcess: null,
    extensionProcess: null,
    disconnectLink: null,
    connectLink: null,
    validation:
      "unvalidated: no install on this host; vendor dev docs (https://www.happ.su/main/dev-docs) document happ://add and happ://routing/add|onadd|off, not VPN control links",
    installHint: "brew install --cask happ",
  },
  incy: {
    id: "incy",
    displayName: "Incy",
    bundleId: null,
    profileName: null,
    appProcess: null,
    extensionProcess: null,
    disconnectLink: "incy://disconnect",
    connectLink: "incy://connect",
    validation:
      "links from the vendor docs (https://docs.incy.cc/en/deep-links/); on-machine facts unvalidated: no install on this host",
    installHint: "brew install --cask incy",
  },
};

/** Facts the probe ladder and the reconnect flow need before a client is acted on. */
const REQUIRED_FACTS: ReadonlyArray<keyof TunnelClientAdapter> = [
  "bundleId",
  "profileName",
  "appProcess",
  "extensionProcess",
  "disconnectLink",
  "connectLink",
];

export function missingFacts(a: TunnelClientAdapter): string[] {
  return REQUIRED_FACTS.filter((key) => a[key] === null);
}

/** An adapter with every required fact present; the shape the tools consume. */
export interface OperableClient {
  id: ClientId;
  displayName: string;
  bundleId: string;
  profileName: string;
  appProcess: string;
  extensionProcess: string;
  disconnectLink: string;
  connectLink: string;
}

/** Narrow an adapter to an operable client; null while any fact is missing. */
export function operableClient(a: TunnelClientAdapter): OperableClient | null {
  const {
    id,
    displayName,
    bundleId,
    profileName,
    appProcess,
    extensionProcess,
    disconnectLink,
    connectLink,
  } = a;
  if (
    bundleId === null ||
    profileName === null ||
    appProcess === null ||
    extensionProcess === null ||
    disconnectLink === null ||
    connectLink === null
  ) {
    return null;
  }
  return {
    id,
    displayName,
    bundleId,
    profileName,
    appProcess,
    extensionProcess,
    disconnectLink,
    connectLink,
  };
}

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

/**
 * Fail-closed gate. A client adapter with any missing fact returns a refusal
 * naming what is missing and how the client would be installed; null means
 * the adapter is operable. A refusal is also the whole answer for probing:
 * without the machine facts there is no reliable probe, and a guessed probe
 * verdict is worse than none.
 */
export function clientRefusal(a: TunnelClientAdapter): string | null {
  const missing = missingFacts(a);
  if (missing.length === 0) return null;
  return (
    `Client "${a.id}" is not operable on this host: no ${missing.join(", ")}. ` +
    `Validation state: ${a.validation}.` +
    (a.installHint ? ` Install: ${a.installHint}.` : "") +
    " Nothing was probed and nothing was toggled."
  );
}
