/**
 * Per-client adapters: the vendor facts the tunnel mechanism consumes.
 *
 * Everything in this file is a fact about one macOS tunnel client - the
 * network-extension bundle id, the app and extension process names, the
 * NE profile the client creates, and the toggle mechanism (a deep-link pair
 * or an NE-profile command) the reconnect flow drives. The mechanism
 * (tunnel.ts) takes them as data and carries no vendor name; a new vendor is
 * one entry here and no logic change.
 *
 * Capabilities are scoped, because probing and toggling need different facts:
 *   - probing needs bundleId, profileName and appProcess. A separate system
 *     extension process (`extensionProcess`) is optional: a client that ships
 *     none is still probed, with the extension leg reported as not applicable.
 *   - toggling additionally needs a well-formed `toggle` mechanism.
 * `probeRefusal` / `toggleRefusal` answer a host that cannot do one of them.
 *
 * Validation state per adapter:
 *   - v2raytun: re-derived from the installed host app (Info.plist scheme,
 *     app-binary route strings, pgrep process names, scutil --nc list).
 *   - happ: re-derived from the installed host app (scutil --nc list bundle
 *     id and profile, app-binary route strings, pgrep process name). The
 *     vendor ships no connect deep link, so the toggle mechanism is the NE
 *     profile (`scutil --nc start|stop "<profile>"`), the documented path.
 *   - incy: no install on this host. Links come from the vendor's
 *     documentation; on-machine facts (bundle id, profile, processes) are
 *     null, so it refuses probing - and therefore toggling - until a host
 *     install supplies them.
 *
 * `installHint` is the one-time install command for a host that does not
 * carry the client; null once the adapter's facts are validated on a host.
 */

export type ClientId = "v2raytun" | "happ" | "incy";

export const CLIENT_IDS: readonly ClientId[] = ["v2raytun", "happ", "incy"];

/**
 * How a client's tunnel is toggled. The reconnect flow turns either kind into
 * two OS commands; the mechanism is data, so a new vendor supplies one and
 * nothing in tunnel.ts changes.
 *   - link: the app's own deep links, opened with `open "<link>"`.
 *   - ne-profile: the network-extension service, driven with
 *     `scutil --nc stop|start "<profile>"` (the path a vendor that ships no
 *     connect deep link documents instead).
 */
export type ToggleMechanism =
  | { kind: "link"; connect: string; disconnect: string }
  | { kind: "ne-profile"; profile: string };

export interface TunnelClientAdapter {
  id: ClientId;
  displayName: string;
  /** NE bundle id whose profiles `scutil --nc list` filters on. */
  bundleId: string | null;
  /** Anchor NE profile name for `scutil --nc status`; siblings are enumerated. */
  profileName: string | null;
  /** `pgrep -x` pattern for the client app process. */
  appProcess: string | null;
  /** `pgrep -f` pattern for a separate system-extension process; null when the client ships none. */
  extensionProcess: string | null;
  /** Toggle mechanism; null when this host has no known way to toggle the client. */
  toggle: ToggleMechanism | null;
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
    toggle: {
      kind: "link",
      connect: "v2raytun://connect",
      disconnect: "v2raytun://disconnect",
    },
    validation:
      "re-derived on this host: Info.plist URL scheme, app-binary route strings, pgrep process names, scutil --nc list profiles",
    installHint: null,
  },
  happ: {
    id: "happ",
    displayName: "Happ",
    bundleId: "su.ffg.happ",
    profileName: "Happ",
    appProcess: "Happ",
    // The tunnel runs in the app's own system extension. Its executable is
    // generically named `Tunnel`, so the appex bundle path is the narrowest
    // fact that identifies it under `pgrep -f` (the probe leg), matching the
    // live process and nothing else on this host. The vendor ships no
    // connect deep link either: `happ://disconnect` exists, `happ://connect`
    // does not, which is why the toggle is the NE profile rather than a link.
    extensionProcess: "Happ.app/Contents/PlugIns/Tunnel.appex",
    toggle: { kind: "ne-profile", profile: "Happ" },
    validation:
      're-derived on this host: scutil --nc list (VPN su.ffg.happ, profile "Happ"), pgrep -x Happ, app-binary route strings (happ://disconnect present, no happ://connect); the NE-profile toggle is documented by scutil, not exercised here',
    installHint: null,
  },
  incy: {
    id: "incy",
    displayName: "Incy",
    bundleId: null,
    profileName: null,
    appProcess: null,
    extensionProcess: null,
    toggle: {
      kind: "link",
      connect: "incy://connect",
      disconnect: "incy://disconnect",
    },
    validation:
      "links from the vendor docs (https://docs.incy.cc/en/deep-links/); on-machine facts unvalidated: no install on this host",
    installHint: "brew install --cask incy",
  },
};

/** Which capability a refusal is about: probing needs less than toggling. */
export type Capability = "probe" | "toggle";

/** Adapter facts the probe ladder needs; all three are mandatory. */
const PROBE_FACTS = ["bundleId", "profileName", "appProcess"] as const;

/** True when a toggle mechanism is present and carries non-empty targets. */
export function wellFormedToggle(t: ToggleMechanism | null): boolean {
  if (t === null) return false;
  if (t.kind === "link") {
    return t.connect.length > 0 && t.disconnect.length > 0;
  }
  return t.profile.length > 0;
}

/** Missing facts for one capability: the probe facts, plus a toggle for "toggle". */
export function missingFacts(
  a: TunnelClientAdapter,
  capability: Capability,
): string[] {
  const missing: string[] = PROBE_FACTS.filter((key) => a[key] === null);
  if (capability === "toggle" && !wellFormedToggle(a.toggle)) {
    missing.push("toggle mechanism");
  }
  return missing;
}

/** An adapter with every probe fact present; the shape the probe consumes. */
export interface ProbeClient {
  id: ClientId;
  displayName: string;
  bundleId: string;
  profileName: string;
  appProcess: string;
  extensionProcess: string | null;
}

/** An adapter that can be probed and toggled. */
export interface OperableClient extends ProbeClient {
  toggle: ToggleMechanism;
}

function narrow(a: TunnelClientAdapter): ProbeClient | null {
  const {
    id,
    displayName,
    bundleId,
    profileName,
    appProcess,
    extensionProcess,
  } = a;
  if (bundleId === null || profileName === null || appProcess === null) {
    return null;
  }
  return {
    id,
    displayName,
    bundleId,
    profileName,
    appProcess,
    extensionProcess,
  };
}

/** Narrow an adapter to its probe facts; null while any is missing. */
export function probeClient(a: TunnelClientAdapter): ProbeClient | null {
  return narrow(a);
}

/** Narrow an adapter to a probe+toggle client; null while any fact is missing. */
export function operableClient(a: TunnelClientAdapter): OperableClient | null {
  const probe = narrow(a);
  if (probe === null || a.toggle === null || !wellFormedToggle(a.toggle)) {
    return null;
  }
  return { ...probe, toggle: a.toggle };
}

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

const CAPABILITY_TEXT: Record<Capability, string> = {
  probe: "probed",
  toggle: "toggled",
};

/**
 * Fail-closed gate for one capability. A refusal names what is missing and
 * how the client would be installed; null means the adapter can do it. The
 * refusal is the whole answer: without the machine facts there is no reliable
 * probe, and a probe verdict guessed from no facts is worse than none.
 */
export function capabilityRefusal(
  a: TunnelClientAdapter,
  capability: Capability,
): string | null {
  const missing = missingFacts(a, capability);
  if (missing.length === 0) return null;
  return (
    `Client "${a.id}" is not operable on this host: cannot be ` +
    `${CAPABILITY_TEXT[capability]}; no ${missing.join(", ")}. ` +
    `Validation state: ${a.validation}.` +
    (a.installHint ? ` Install: ${a.installHint}.` : "") +
    ` Nothing was ${capability === "probe" ? "probed" : "probed or toggled"}.`
  );
}

export function probeRefusal(a: TunnelClientAdapter): string | null {
  return capabilityRefusal(a, "probe");
}

export function toggleRefusal(a: TunnelClientAdapter): string | null {
  return capabilityRefusal(a, "toggle");
}
