/**
 * slot.ts - a process-global slot with a declared shape, a version, and a
 * refusal instead of silent undefined.
 *
 * A slot exists because two module instances must see one value: the polyfill
 * loads from the TypeScript source tree while contrib imports the compiled
 * dist, so a module-level Map is written by one instance and read empty by the
 * other. `globalThis` is the transport; this module is the contract on top of
 * it. A bare string key and a `Record<string, unknown>` cast cannot say what
 * shape a value has or which build wrote it, so a writer whose reader is
 * absent writes into a void and a reader whose writer is absent takes its
 * default without a word.
 *
 * A read checks the stamp before the shape: a value written by a build that
 * declares a different version is refused, naming both versions, rather than
 * reinterpreted. A value with no stamp is handed to `parse` as-is, because a
 * writer that cannot import this module (the standalone providers package)
 * publishes the bare shape and the parse is the contract for it.
 */

import { registerSlot, type SlotHandle, type SlotSnapshot } from "./slot-registry.js";

/** A shape contract's refusal: what was expected and what arrived. */
export interface SlotRefusal {
  refuse: string;
}

/** The shape contract for a slot's value. */
export type SlotParse<T> = (value: unknown) => T | SlotRefusal;

/** What a caller declares about a slot. */
export interface SlotDescriptor<T> {
  /** The `globalThis` property name. */
  key: string;
  /** The shape version this build understands. */
  version: number;
  /** The module that writes the value. Provenance, and a name in refusals. */
  owner: string;
  /** Shape contract: a typed value or a refusal naming expected and actual. */
  parse: SlotParse<T>;
  /** Emit one advisory line when the first write finds no subscriber. */
  requiresSubscriber?: boolean;
  /** `false` makes the slot read-only and refuses `set()`. Defaults true. */
  writesExpected?: boolean;
}

/** The value installed on the global by every write. */
export interface SlotEnvelope {
  /** Shape version of the writing build. */
  v: number;
  /** Epoch ms of the write. */
  at: number;
  /** The module that performed the write. */
  owner: string;
  /** The parsed value. */
  value: unknown;
}

/** A slot's declared contract plus its live state. */
export interface SlotDescription extends SlotSnapshot {
  key: string;
  version: number;
  owner: string;
  writesExpected: boolean;
  requiresSubscriber: boolean;
}

/** A declared slot. */
export interface Slot<T> {
  readonly key: string;
  /** The value. Throws when absent, unparseable, or from another version. */
  get(): T;
  /** The value, or undefined when no value is present. Never defaults. */
  tryGet(): T | undefined;
  /** Install a value. Parses first; a bad value never reaches the global. */
  set(value: T): void;
  /** Remove the value, returning the slot to its absent state. */
  clear(): void;
  /** Observe later writes. Returns an unsubscribe. */
  subscribe(fn: (value: T) => void): () => void;
  /** The contract and live state, as the census reports them. */
  describe(): SlotDescription;
}

type AnySubscriber = (value: unknown) => void;

const SUBSCRIBERS = Symbol.for("pi-braid.slot.subscribers");
const ADVISED = Symbol.for("pi-braid.slot.advisories");
const processGlobals = globalThis as Record<string, unknown>;
const processSymbols = globalThis as unknown as Record<symbol, unknown>;

function subscriberTable(): Map<string, Set<AnySubscriber>> {
  const existing = processSymbols[SUBSCRIBERS];
  if (existing instanceof Map) return existing as Map<string, Set<AnySubscriber>>;
  const created = new Map<string, Set<AnySubscriber>>();
  processSymbols[SUBSCRIBERS] = created;
  return created;
}

function subscribersFor(key: string): Set<AnySubscriber> {
  const table = subscriberTable();
  const existing = table.get(key);
  if (existing) return existing;
  const created = new Set<AnySubscriber>();
  table.set(key, created);
  return created;
}

function advisories(): Set<string> {
  const existing = processSymbols[ADVISED];
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  processSymbols[ADVISED] = created;
  return created;
}

function isSlotRefusal(value: unknown): value is SlotRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { refuse?: unknown }).refuse === "string"
  );
}

function isEnvelope(value: unknown): value is SlotEnvelope {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value) || value instanceof Map) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, "value") &&
    typeof record.v === "number" &&
    Number.isFinite(record.v) &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    typeof record.owner === "string"
  );
}

/**
 * Name a value in a refusal: its type and, where it helps, its content.
 * Parsers use this so "expected ... found ..." names the actual arrival.
 */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 40)}...` : value;
    return `string ${JSON.stringify(shown)}`;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${typeof value} ${String(value)}`;
  }
  if (typeof value === "function") return "a function";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value instanceof Map) return `a Map of ${value.size}`;
  if (value instanceof Set) return `a Set of ${value.size}`;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return "an object with no keys";
  const shown = keys.slice(0, 5).join(", ");
  return `an object with keys [${shown}${keys.length > 5 ? ", ..." : ""}]`;
}

function readRefusal(
  key: string,
  expectedVersion: number,
  foundVersion: string,
  detail: string,
): Error {
  return new Error(
    `slot "${key}": expected version ${expectedVersion}, found ${foundVersion}; ${detail}`,
  );
}

function validateDescriptor<T>(descriptor: SlotDescriptor<T>): void {
  if (typeof descriptor.key !== "string" || descriptor.key.length === 0) {
    throw new Error("defineSlot: key must be a non-empty string");
  }
  if (!Number.isInteger(descriptor.version) || descriptor.version < 1) {
    throw new Error(`defineSlot("${descriptor.key}"): version must be a positive integer`);
  }
  if (typeof descriptor.owner !== "string" || descriptor.owner.length === 0) {
    throw new Error(`defineSlot("${descriptor.key}"): owner must name the writing module`);
  }
  if (typeof descriptor.parse !== "function") {
    throw new Error(`defineSlot("${descriptor.key}"): parse must be a function`);
  }
}

/**
 * Declare a slot. Registration happens here, on first definition; a second
 * definition of the same key (the other module instance) is counted by the
 * registry and keeps the first handle.
 */
export function defineSlot<T>(descriptor: SlotDescriptor<T>): Slot<T> {
  validateDescriptor(descriptor);
  const { key, version, owner, parse } = descriptor;
  const writesExpected = descriptor.writesExpected !== false;
  const requiresSubscriber = descriptor.requiresSubscriber === true;

  const read = (): T => {
    const raw = processGlobals[key];
    if (raw === undefined) {
      throw readRefusal(
        key,
        version,
        "no version (absent)",
        `no writer has run in this process (expected owner: ${owner})`,
      );
    }
    if (isEnvelope(raw)) {
      if (raw.v !== version) {
        throw readRefusal(
          key,
          version,
          `version ${raw.v}`,
          `this build understands version ${version}; the value was written by a build declaring version ${raw.v}, so its shape may differ (owner: ${raw.owner})`,
        );
      }
      const parsed = parse(raw.value);
      if (isSlotRefusal(parsed)) {
        throw readRefusal(key, version, `version ${raw.v}`, `parse refused: ${parsed.refuse}`);
      }
      return parsed;
    }
    const parsed = parse(raw);
    if (isSlotRefusal(parsed)) {
      throw readRefusal(key, version, "no version (unstamped)", `parse refused: ${parsed.refuse}`);
    }
    return parsed;
  };

  const snapshot = (): SlotSnapshot => {
    const raw = processGlobals[key];
    if (raw === undefined) {
      return {
        present: false,
        ageMs: null,
        subscribers: subscribersFor(key).size,
      };
    }
    const stamp = isEnvelope(raw) ? raw : undefined;
    return {
      present: true,
      ageMs: stamp ? Math.max(0, Date.now() - stamp.at) : null,
      subscribers: subscribersFor(key).size,
    };
  };

  const slot: Slot<T> = {
    key,
    get: read,
    tryGet: () => (processGlobals[key] === undefined ? undefined : read()),
    set: (value) => {
      if (!writesExpected) {
        throw new Error(
          `slot "${key}" (owner ${owner}) is read-only: the descriptor declares writesExpected: false`,
        );
      }
      const parsed = parse(value);
      if (isSlotRefusal(parsed)) {
        throw new Error(
          `slot "${key}": write refused at version ${version}; parse refused: ${parsed.refuse}`,
        );
      }
      processGlobals[key] = {
        v: version,
        at: Date.now(),
        owner,
        value: parsed,
      } satisfies SlotEnvelope;
      const subscribers = subscribersFor(key);
      if (requiresSubscriber && subscribers.size === 0) {
        const advised = advisories();
        if (!advised.has(key)) {
          advised.add(key);
          console.warn(
            `[braid] slot advisory: "${key}" (owner ${owner}) was written with no subscriber in this process; nothing will read it`,
          );
        }
      }
      for (const fn of subscribers) fn(parsed);
    },
    clear: () => {
      delete processGlobals[key];
    },
    subscribe: (fn) => {
      const subscriber = fn as AnySubscriber;
      const subscribers = subscribersFor(key);
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    describe: () => ({
      key,
      version,
      owner,
      writesExpected,
      requiresSubscriber,
      ...snapshot(),
    }),
  };

  const handle: SlotHandle = {
    key,
    version,
    owner,
    writesExpected,
    requiresSubscriber,
    snapshot,
  };
  registerSlot(handle);
  return slot;
}
