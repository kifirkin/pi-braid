/**
 * Braid-OS Daemon Orchestrator — tmux-based worker management.
 * Skeleton for the BRAID-OS-DAEMON-LAYER-PROPOSAL.
 *
 * Usage:
 *   import { DaemonOrchestrator } from "./braid-os/daemon/index.js";
 *   const d = new DaemonOrchestrator();
 *   await d.spawnWorker("code-review", { role: "reviewer" });
 *   await d.listWorkers();
 *   await d.healthCheck();
 */

import { execSync, spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────

export interface DaemonConfig {
  braidRoot: string;
  pidDir: string;
  logDir: string;
  defaultSession: string;
}

export interface WorkerSpec {
  id: string;
  role: string;
  tmuxSession: string;
  piArgs: string[];
  createdAt: number;
  status: "running" | "stopped" | "failed";
}

// ── Defaults ─────────────────────────────────────────────────────────────

const HOME = homedir();
const DEFAULT_CONFIG: DaemonConfig = {
  braidRoot: resolve(join(HOME, "projects", "agents", "pi-braid")),
  pidDir: join(HOME, ".pi-braid"),
  logDir: join(HOME, ".pi-braid", "logs"),
  defaultSession: "braid-daemon",
};

// ── Orchestrator ─────────────────────────────────────────────────────────

export class DaemonOrchestrator {
  private config: DaemonConfig;
  private workers: Map<string, WorkerSpec> = new Map();

  constructor(config?: Partial<DaemonConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Ensure directories exist
    for (const dir of [this.config.pidDir, this.config.logDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    // Load persisted workers
    this.loadState();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Start the daemon orchestrator in the background (tmux). */
  async start(): Promise<void> {
    if (this.isTmuxSessionRunning(this.config.defaultSession)) {
      console.log(`Daemon already running (session: ${this.config.defaultSession})`);
      return;
    }
    execSync(
      `tmux new-session -d -s "${this.config.defaultSession}" -n braid ` +
        `"cd ${this.config.braidRoot} && pi -e src/index.ts 2>&1 | tee -a ${this.config.logDir}/daemon.log"`,
      { stdio: "inherit" },
    );
    writeFileSync(join(this.config.pidDir, "daemon.pid"), String(process.pid));
    console.log(`Daemon started (session: ${this.config.defaultSession})`);
  }

  /** Stop the daemon and all workers. */
  async stop(): Promise<void> {
    for (const [id] of this.workers) {
      await this.killWorker(id);
    }
    if (this.isTmuxSessionRunning(this.config.defaultSession)) {
      execSync(`tmux send-keys -t "${this.config.defaultSession}" C-c`, { stdio: "ignore" });
      execSync(`tmux kill-session -t "${this.config.defaultSession}"`, { stdio: "ignore" });
    }
    console.log("Daemon stopped");
  }

  /** Health check — returns status of daemon and all workers. */
  async healthCheck(): Promise<{ daemon: string; workers: WorkerSpec[] }> {
    const daemonStatus = this.isTmuxSessionRunning(this.config.defaultSession)
      ? "running"
      : "stopped";
    return {
      daemon: daemonStatus,
      workers: Array.from(this.workers.values()).map((w) => ({
        ...w,
        status: this.isTmuxSessionRunning(w.tmuxSession) ? "running" : "stopped",
      })),
    };
  }

  // ── Worker Management ──────────────────────────────────────────────

  /** Spawn a new pi worker with a specific role. */
  async spawnWorker(id: string, opts?: { role?: string; args?: string[] }): Promise<WorkerSpec> {
    if (this.workers.has(id)) throw new Error(`Worker ${id} already exists`);

    const role = opts?.role ?? "worker";
    const tmuxSession = `braid-${role}-${id}`;
    const piArgs = opts?.args ?? ["-e", "src/index.ts"];

    const worker: WorkerSpec = {
      id,
      role,
      tmuxSession,
      piArgs,
      createdAt: Date.now(),
      status: "running",
    };

    // Spawn as a new tmux session
    const cmd = `cd ${this.config.braidRoot} && pi ${piArgs.join(" ")} 2>&1 | tee -a ${this.config.logDir}/${id}.log`;
    execSync(`tmux new-session -d -s "${tmuxSession}" -n "${id}" "${cmd}"`, { stdio: "ignore" });

    this.workers.set(id, worker);
    this.saveState();
    console.log(`Worker ${id} spawned (session: ${tmuxSession}, role: ${role})`);
    return worker;
  }

  /** Kill a worker by ID. */
  async killWorker(id: string): Promise<void> {
    const w = this.workers.get(id);
    if (!w) throw new Error(`Worker ${id} not found`);
    execSync(`tmux send-keys -t "${w.tmuxSession}" C-c`, { stdio: "ignore" });
    execSync(`tmux kill-session -t "${w.tmuxSession}"`, { stdio: "ignore" });
    this.workers.delete(id);
    this.saveState();
  }

  /** List all workers. */
  async listWorkers(): Promise<WorkerSpec[]> {
    return Array.from(this.workers.values());
  }

  // ── Internals ──────────────────────────────────────────────────────

  private isTmuxSessionRunning(name: string): boolean {
    try {
      execSync(`tmux has-session -t "${name}" 2>/dev/null`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private statePath(): string {
    return join(this.config.pidDir, "workers.json");
  }

  private saveState(): void {
    const data = Array.from(this.workers.entries()).map(([id, w]) => ({ id, ...w }));
    writeFileSync(this.statePath(), JSON.stringify(data, null, 2));
  }

  private loadState(): void {
    try {
      const raw = readFileSync(this.statePath(), "utf-8");
      const entries = JSON.parse(raw) as Array<WorkerSpec & { id: string }>;
      for (const e of entries) {
        this.workers.set(e.id, {
          id: e.id,
          role: e.role,
          tmuxSession: e.tmuxSession,
          piArgs: e.piArgs,
          createdAt: e.createdAt,
          status: e.status,
        });
      }
    } catch {
      // No state file yet
    }
  }
}
