/**
 * Agent Observatory — real-time monitoring system
 *
 * Captures Event Bus events, agent state, and tool usage metrics,
 * streams them via WebSocket to a three.js-based visualization frontend.
 *
 * Architecture:
 *   pi-braid Event Bus → Metrics Collector → WebSocket Server
 *                                              ↓
 *   pi-web-ui (custom panel) ← Three.js Visualization
 *
 * The observatory is non-blocking — it never slows down the agent.
 * Metrics are batched and sent asynchronously.
 */

import { createLogger } from "./logger.js";
import { eventBus } from "./event-bus.js";

const log = createLogger("observatory");

// ── Metrics Types ───────────────────────────────────────────────────────────

export interface AgentEventMetric {
  type: string;
  timestamp: number;
  turn: number;
  data: Record<string, unknown>;
}

export interface ToolCallMetric {
  toolName: string;
  turn: number;
  timestamp: number;
  duration: number;
  success: boolean;
  error?: string;
}

export interface AgentStateSnapshot {
  turn: number;
  timestamp: number;
  goal: string;
  phase: string;
  toolCount: number;
  errorCount: number;
  contextUsage: number;
  activeModules: string[];
}

export interface ObservatoryMetrics {
  events: AgentEventMetric[];
  toolCalls: ToolCallMetric[];
  stateSnapshots: AgentStateSnapshot[];
  sessionId: string;
  startTime: number;
}

// ── Metrics Collector ──────────────────────────────────────────────────────

class MetricsCollector {
  private metrics: ObservatoryMetrics = {
    events: [],
    toolCalls: [],
    stateSnapshots: [],
    sessionId: "",
    startTime: Date.now(),
  };

  private maxEvents = 1000;
  private subscribers: Set<(metrics: ObservatoryMetrics) => void> = new Set();

  constructor() {
    this.metrics.sessionId = `session_${Date.now()}`;
    this.wireEventBus();
  }

  private wireEventBus(): void {
    // Capture all Event Bus events
    eventBus.on("turn_complete", (event) => {
      this.metrics.events.push({
        type: "turn_complete",
        timestamp: Date.now(),
        turn: event.turn,
        data: { duration: event.duration },
      });
      this.trim();
      this.notify();
    });

    eventBus.on("timer_fire", (event) => {
      this.metrics.events.push({
        type: "timer_fire",
        timestamp: Date.now(),
        turn: 0,
        data: { reason: event.reason, id: event.id },
      });
      this.trim();
      this.notify();
    });

    eventBus.on("enforcement_violation", (event) => {
      this.metrics.events.push({
        type: "enforcement_violation",
        timestamp: Date.now(),
        turn: 0,
        data: { rule: event.rule, severity: event.severity },
      });
      this.trim();
      this.notify();
    });

    eventBus.on("memory_evict", (event) => {
      this.metrics.events.push({
        type: "memory_evict",
        timestamp: Date.now(),
        turn: 0,
        data: { reason: event.reason, count: event.count },
      });
      this.trim();
      this.notify();
    });

    eventBus.on("context_full", (event) => {
      this.metrics.events.push({
        type: "context_full",
        timestamp: Date.now(),
        turn: 0,
        data: { usagePercent: event.usagePercent },
      });
      this.trim();
      this.notify();
    });

    eventBus.on("heartbeat_tick", (event) => {
      this.metrics.events.push({
        type: "heartbeat_tick",
        timestamp: Date.now(),
        turn: event.turn,
        data: { tickCount: event.tickCount },
      });
      this.trim();
      this.notify();
    });
  }

  private trim(): void {
    if (this.metrics.events.length > this.maxEvents) {
      this.metrics.events = this.metrics.events.slice(-this.maxEvents);
    }
    if (this.metrics.toolCalls.length > this.maxEvents) {
      this.metrics.toolCalls = this.metrics.toolCalls.slice(-this.maxEvents);
    }
    if (this.metrics.stateSnapshots.length > 100) {
      this.metrics.stateSnapshots = this.metrics.stateSnapshots.slice(-100);
    }
  }

  private notify(): void {
    for (const sub of this.subscribers) {
      try {
        sub({ ...this.metrics });
      } catch {}
    }
  }

  recordToolCall(metric: ToolCallMetric): void {
    this.metrics.toolCalls.push(metric);
    this.trim();
    this.notify();
  }

  recordStateSnapshot(snapshot: AgentStateSnapshot): void {
    this.metrics.stateSnapshots.push(snapshot);
    this.trim();
    this.notify();
  }

  subscribe(cb: (metrics: ObservatoryMetrics) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getMetrics(): ObservatoryMetrics {
    return { ...this.metrics, events: [...this.metrics.events] };
  }

  getEventsSince(timestamp: number): AgentEventMetric[] {
    return this.metrics.events.filter((e) => e.timestamp > timestamp);
  }

  getToolCallsSince(timestamp: number): ToolCallMetric[] {
    return this.metrics.toolCalls.filter((t) => t.timestamp > timestamp);
  }

  reset(): void {
    this.metrics = {
      events: [],
      toolCalls: [],
      stateSnapshots: [],
      sessionId: `session_${Date.now()}`,
      startTime: Date.now(),
    };
  }
}

// ── WebSocket Server ──────────────────────────────────────────────────────

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

interface ObservatoryServerConfig {
  port: number;
  host: string;
}

const DEFAULT_CONFIG: ObservatoryServerConfig = {
  port: 4199,
  host: "localhost",
};

class ObservatoryServer {
  private wss: WebSocketServer | null = null;
  private collector: MetricsCollector;
  private config: ObservatoryServerConfig;
  private connectedClients = 0;

  constructor(
    collector: MetricsCollector,
    config: Partial<ObservatoryServerConfig> = {},
  ) {
    this.collector = collector;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    const server = createServer();
    this.wss = new WebSocketServer({ server });

    this.wss.on("connection", (ws) => {
      this.connectedClients++;
      log.info(`[observatory] Client connected (${this.connectedClients} total)`);

      // Send current state on connection
      ws.send(JSON.stringify({
        type: "metrics_snapshot",
        payload: this.collector.getMetrics(),
      }));

      // Subscribe to live updates
      const unsub = this.collector.subscribe((metrics) => {
        try {
          ws.send(JSON.stringify({
            type: "metrics_update",
            payload: metrics,
          }));
        } catch {}
      });

      ws.on("close", () => {
        this.connectedClients--;
        unsub();
        log.info(`[observatory] Client disconnected (${this.connectedClients} remaining)`);
      });

      ws.on("error", () => {
        this.connectedClients--;
        unsub();
      });
    });

    // Handle port-in-use — never crash the host process
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const fallbackPort = this.config.port + 1;
        log.warn(`[observatory] Port ${this.config.port} in use, trying ${fallbackPort}...`);
        this.config = { ...this.config, port: fallbackPort };
        server.listen(fallbackPort, this.config.host);
      } else {
        log.error(`[observatory] Server error: ${err.message}`);
        this.wss = null;
      }
    });

    server.listen(this.config.port, this.config.host);
    log.info(`[observatory] Server started at ws://${this.config.host}:${this.config.port}`);
  }

  stop(): void {
    this.wss?.close();
    log.info("[observatory] Server stopped");
  }

  getClientCount(): number {
    return this.connectedClients;
  }

  isRunning(): boolean {
    return this.wss !== null;
  }

  getPort(): number {
    return this.config.port;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _collector: MetricsCollector | null = null;
let _server: ObservatoryServer | null = null;

export function getCollector(): MetricsCollector {
  if (!_collector) {
    _collector = new MetricsCollector();
  }
  return _collector;
}

export function getServer(): ObservatoryServer {
  if (!_server) {
    _server = new ObservatoryServer(getCollector());
  }
  return _server;
}

/**
 * Start the observatory (collector + WebSocket server).
 */
export function startObservatory(config?: Partial<ObservatoryServerConfig>): void {
  const collector = getCollector();
  const server = new ObservatoryServer(collector, config);
  _server = server;
  server.start();
  log.info("[observatory] Observatory started — listening on ws://localhost:4199");
}

/**
 * Stop the observatory.
 */
export function stopObservatory(): void {
  _server?.stop();
  _server = null;
  log.info("[observatory] Observatory stopped");
}

/**
 * Get observatory status.
 */
export function getObservatoryStatus(): string {
  const server = _server;
  const collector = _collector;
  const lines: string[] = [];

  lines.push("=== Agent Observatory ===");
  lines.push(`Server running: ${server?.isRunning() ? "yes" : "no"}`);
  if (server) {
    lines.push(`Clients: ${server.getClientCount()}`);
    const port = server?.getPort() ?? DEFAULT_CONFIG.port;
    lines.push(`Port: ${port}`);
  }
  if (collector) {
    const metrics = collector.getMetrics();
    lines.push(`Events captured: ${metrics.events.length}`);
    lines.push(`Tool calls tracked: ${metrics.toolCalls.length}`);
    lines.push(`State snapshots: ${metrics.stateSnapshots.length}`);
    lines.push(`Session: ${metrics.sessionId}`);
    lines.push(`Running for: ${((Date.now() - metrics.startTime) / 1000).toFixed(0)}s`);
  }

  return lines.join("\n");
}
