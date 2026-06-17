/**
 * Belief Store + Policy Engine
 *
 * Architecture: Heartbeat-driven cognitive scheduling with declarative policies.
 * - Beliefs: Immutable records of agent knowledge with provenance
 * - Policies: Declarative rules - if(trigger) then(action)
 *
 * Inspired by:
 * - arXiv:2604.14178 Heartbeat Scheduling
 * - arXiv:2604.14401 Credo Declarative Control
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("belief-store");

// ── Types ─────────────────────────────────────────────────────────────────

export type BeliefSource = "memory" | "web" | "code" | "parametric" | "user" | "observation";

export interface Belief {
  id: string;
  content: string;
  confidence: number; // 0-1
  timestamp: number; // Date.now()
  source: BeliefSource;
  tags?: string[];
  expiresAt?: number; // Optional TTL
}

export interface BeliefQuery {
  source?: BeliefSource;
  minConfidence?: number;
  maxAge?: number; // ms
  tags?: string[];
  search?: string; // content contains
  limit?: number;
}

export type PolicyTrigger = (store: BeliefStore, ctx: PolicyContext) => boolean | Promise<boolean>;

export type PolicyAction = (ctx: PolicyContext) => void | Promise<void>;

export interface Policy {
  id: string;
  name: string;
  description: string;
  trigger: PolicyTrigger;
  action: PolicyAction;
  priority: number;
  enabled: boolean;
  cooldownMs: number;
  lastActivated: number;
}

export interface PolicyContext {
  sessionId: string;
  turnNumber: number;
  toolStats: Map<string, number>;
  lastTool?: string;
  lastError?: string;
  cwd: string;
}

// ── Belief Store ─────────────────────────────────────────────────────────────

export class BeliefStore {
  private beliefs: Map<string, Belief> = new Map();
  private bySource: Map<BeliefSource, string[]> = new Map();

  constructor(private sessionId: string) {}

  // ── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Atomically add a belief if no belief with the same id exists.
   * Returns `{ added: true, belief }` on success, or
   * `{ added: false, existing }` if a belief with the same id was
   * already present.
   *
   * This is the canonical API for callers that want to know whether
   * their add actually inserted. The plain `add()` method is kept
   * for fire-and-forget callers but uses tryAdd internally so the
   * check-then-set is atomic.
   */
  tryAdd(belief: Belief): { added: true; belief: Belief } | { added: false; existing: Belief } {
    const b: Belief = { ...belief, timestamp: belief.timestamp ?? Date.now() };
    const existing = this.beliefs.get(b.id);
    if (existing) {
      return { added: false, existing };
    }
    this.beliefs.set(b.id, b);
    const ids = this.bySource.get(b.source) ?? [];
    ids.push(b.id);
    this.bySource.set(b.source, ids);
    return { added: true, belief: b };
  }

  /**
   * Add a belief. Idempotent: if a belief with the same id already
   * exists, the call is a silent no-op (logged at debug). The system
   * is designed to handle parallel adds from multiple handlers
   * (heartbeat, enforcement, tool-call observers) that may all
   * observe the same event in the same millisecond, so the dedup
   * is expected behavior, not a bug.
   *
   * Use `tryAdd()` if you need to know whether the add actually
   * inserted (e.g. to decide whether to broadcast a notification).
   */
  add(belief: Belief): void {
    const result = this.tryAdd(belief);
    if (result.added) {
      log.debug("Belief added: " + result.belief.id + " (source=" + result.belief.source + ", conf=" + result.belief.confidence + ")");
    } else {
      // Demoted from warn to debug: the dedup is expected behavior
      // (multiple handlers observing the same event in the same ms
      // produces the same Date.now()-based id). The warn-level log
      // was creating noise in the end-of-loop logs without indicating
      // a real problem - the belief was correctly stored by the first
      // add and is queryable; subsequent adds correctly no-op.
      log.debug("Belief " + belief.id + " already exists, skipping duplicate add");
    }
  }

  update(id: string, patch: Partial<Belief>): boolean {
    const existing = this.beliefs.get(id);
    if (!existing) return false;
    this.beliefs.set(id, { ...existing, ...patch });
    return true;
  }

  delete(id: string): boolean {
    const b = this.beliefs.get(id);
    if (!b) return false;
    this.beliefs.delete(id);
    const ids = this.bySource.get(b.source);
    if (ids) {
      const idx = ids.indexOf(id);
      if (idx >= 0) ids.splice(idx, 1);
    }
    return true;
  }

  get(id: string): Belief | undefined {
    return this.beliefs.get(id);
  }

  query(q: BeliefQuery): Belief[] {
    const now = Date.now();
    let results = Array.from(this.beliefs.values());

    if (q.source) {
      results = results.filter((b) => b.source === q.source);
    }
    if (q.minConfidence !== undefined) {
      results = results.filter((b) => b.confidence >= q.minConfidence!);
    }
    if (q.maxAge !== undefined) {
      results = results.filter((b) => now - b.timestamp <= q.maxAge!);
    }
    if (q.tags && q.tags.length > 0) {
      results = results.filter((b) => b.tags && q.tags!.some((t) => b.tags!.includes(t)));
    }
    if (q.search) {
      const lower = q.search.toLowerCase();
      results = results.filter((b) => b.content.toLowerCase().includes(lower));
    }
    if (q.limit) {
      results = results.slice(0, q.limit);
    }
    return results;
  }

  all(): Belief[] {
    return Array.from(this.beliefs.values());
  }

  count(): number {
    return this.beliefs.size;
  }

  // ── Conviction-weighted selection ─────────────────────────────────────

  byConviction(q: BeliefQuery = {}): Belief[] {
    const now = Date.now();
    const scored = this.query(q).map((b) => {
      const age = now - b.timestamp;
      const recencyBoost = age < 3_600_000 ? 1.0 : age < 86_400_000 ? 0.5 : 0.1;
      return { belief: b, conviction: b.confidence * recencyBoost };
    });

    return scored
      .filter((x) => x.conviction > 0.2)
      .sort((a, b) => b.conviction - a.conviction)
      .map((x) => x.belief);
  }

  toJSON(): object {
    return { sessionId: this.sessionId, beliefs: this.all(), exportedAt: Date.now() };
  }
}

// ── Policy Engine ─────────────────────────────────────────────────────────────

export class PolicyEngine {
  private policies: Map<string, Policy> = new Map();

  constructor(private store: BeliefStore) {}

  register(policy: Policy): void {
    const p: Policy = {
      ...policy,
      lastActivated: policy.lastActivated ?? 0,
      enabled: policy.enabled !== false,
    };
    this.policies.set(p.id, p);
    log.info("Policy registered: " + p.id + " (" + p.name + ")");
  }

  unregister(id: string): boolean {
    return this.policies.delete(id);
  }

  async evaluate(ctx: PolicyContext): Promise<Policy[]> {
    const now = Date.now();
    const fired: Policy[] = [];

    const sorted = Array.from(this.policies.values())
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const policy of sorted) {
      if (policy.cooldownMs > 0 && now - policy.lastActivated < policy.cooldownMs) {
        continue;
      }
      try {
        const shouldFire = await Promise.resolve(policy.trigger(this.store, ctx));
        if (shouldFire) {
          log.info("Policy fired: " + policy.id + " (" + policy.name + ")");
          await Promise.resolve(policy.action(ctx));
          policy.lastActivated = now;
          fired.push(policy);
        }
      } catch (err) {
        log.error("Policy " + policy.id + " error: " + String(err));
      }
    }
    return fired;
  }

  list(): Policy[] {
    return Array.from(this.policies.values());
  }
}

// ── Session Factory ─────────────────────────────────────────────────────────────

const stores = new Map<string, BeliefStore>();
const engines = new Map<string, PolicyEngine>();

export function createBeliefStore(sessionId: string): BeliefStore {
  if (stores.has(sessionId)) return stores.get(sessionId)!;
  const store = new BeliefStore(sessionId);
  stores.set(sessionId, store);
  log.info("BeliefStore created for session " + sessionId);
  return store;
}

export function getBeliefStore(sessionId: string): BeliefStore | undefined {
  return stores.get(sessionId);
}

export function createPolicyEngine(sessionId: string): PolicyEngine {
  const store = createBeliefStore(sessionId);
  if (engines.has(sessionId)) return engines.get(sessionId)!;
  const engine = new PolicyEngine(store);
  engines.set(sessionId, engine);
  return engine;
}

export function getPolicyEngine(sessionId: string): PolicyEngine | undefined {
  return engines.get(sessionId);
}

export function cleanupSession(sessionId: string): void {
  stores.delete(sessionId);
  engines.delete(sessionId);
  log.info("BeliefStore + PolicyEngine cleaned up for session " + sessionId);
}
