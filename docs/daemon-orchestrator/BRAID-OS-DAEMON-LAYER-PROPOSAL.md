# Braid-OS: A Daemon Layer Orchestrator for pi-braid

## Master-Slave Architecture with Raft-Inspired Leader Election

**Version**: 0.1 (Proposal)  
**Date**: 2026-04-19  
**Status**: Research proposal — architectural design

---

## Executive Summary

This document proposes **Braid-OS**, a daemon layer orchestrator that transforms pi-braid from an extension-packed agent into a persistent, multi-agent operating system.

**Current state**: pi-braid is a 27-extension monolith that runs within pi-coding-agent's session lifecycle.

**Proposed state**: Braid-OS runs as a singleton daemon from `~/.pi-braid/`, manages multiple pi-agent workers via tmux, and provides a persistent state layer with user interfaces (tmux/TUI, web, telegram).

**Core innovations**:
1. **Daemon as Master**: Singleton, persistent, headless orchestrator
2. **tmux Workers**: pi subagents as tmux sessions (lightweight, observable)
3. **Raft-Inspired Leader Election**: Stable master node with automatic failover
4. **Aethon-Inspired Instantiation**: Reference-based worker spawning (not duplication)
5. **HECTOR-Inspired Hierarchy**: Three-layer coordination (user ↔ daemon ↔ workers)
6. **Institutional Governance**: Parsonian AGIL framework for multi-agent coordination

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Related Work](#2-related-work)
3. [Architecture Overview](#3-architecture-overview)
4. [Core Components](#4-core-components)
5. [Daemon Master Layer](#5-daemon-master-layer)
6. [Worker Layer (tmux Subagents)](#6-worker-layer-tmux-subagents)
7. [Leader Election (Raft-Inspired)](#7-leader-election-raft-inspired)
8. [Aethon-Inspired Instantiation](#8-aethon-inspired-instantiation)
9. [HECTOR-Inspired Hierarchy](#9-hector-inspired-hierarchy)
10. [User Interfaces](#10-user-interfaces)
11. [State Management](#11-state-management)
12. [Implementation Plan](#12-implementation-plan)
13. [Research Papers](#13-research-papers)

---

## 1. Motivation

### 1.1 Current Limitations

**pi-braid runs within pi-coding-agent's lifecycle:**
```
pi start → pi-braid loads → session runs → pi end → pi-braid dies
```

**Problems:**
1. **No persistence**: State dies with session
2. **No background work**: Can't run long tasks while user does other things
3. **No multi-agent**: Single agent, single session
4. **No user interface**: Just CLI
5. **No resilience**: Session crash = work lost

### 1.2 Why This Matters

From **AIBuildAI (2604.14455)**:
> "Hierarchical agent architecture in which a manager agent coordinates three specialized sub-agents"

From **Aethon (2604.12129)**:
> "Agents become lightweight, composable execution identities that can be spawned, specialized, and governed at scale"

From **HECTOR (2604.10892)**:
> "Three hierarchical layers: (I) bidirectional human-fleet interaction, (II) rolling assignment to teams, (III) dynamic coordination within teams"

### 1.3 Proposed Solution

```
┌─────────────────────────────────────────────────────────────┐
│                        USER                                 │
│                    (tmux / web / telegram)                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    BRAID-OS DAEMON                         │
│                    (Master / Leader)                       │
│  ┌─────────────┬──────────────┬──────────────────────┐  │
│  │   Session   │     Task     │    Worker             │  │
│  │   Manager   │     Queue    │    Registry           │  │
│  └─────────────┴──────────────┴──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  tmux:worker-1 │ │  tmux:worker-2  │ │  tmux:worker-N  │
│  (pi subagent) │ │  (pi subagent)  │ │  (pi subagent)  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## 2. Related Work

### 2.1 Relevant Papers

| Paper | arXiv | Key Contribution | Applicable To |
|-------|-------|-----------------|---------------|
| **Aethon** | 2604.12129 | Reference-based replication, copy-on-write semantics | Fast worker instantiation |
| **AIBuildAI** | 2604.14455 | Manager + Designer + Coder + Tuner hierarchy | Worker specialization |
| **Governance by Design** | 2604.11337 | Parsonian AGIL framework for agent societies | Institutional coordination |
| **HECTOR** | 2604.10892 | Three-layer human-centric coordination | User-daemon-worker hierarchy |
| **CoopEval** | 2604.15267 | Cooperation-sustaining mechanisms | Multi-agent coordination |
| **Autogenesis** | 2604.15034 | Self-evolution with rollback | Worker self-improvement |
| **Evo-MedAgent** | 2604.14475 | Three memory stores | Daemon state management |

### 2.2 Existing Systems

| System | Approach | Strengths | Weaknesses |
|--------|----------|-----------|------------|
| Claude Code | Single agent | Simple | No persistence, no background |
| GitHub Copilot | IDE plugin | Integrated | Closed, expensive |
| Cursor | Multi-agent | Good UI | Cloud-only |
| OpenAI Agents SDK | Pool of agents | Scalable | No local control |
| LangGraph | Graph-based | Flexible | Complex, no persistence |

### 2.3 Why tmux?

**tmux provides**:
- **Process isolation**: Each worker is a separate tmux session
- **Observable**: `tmux capture-pane` to see live output
- **Persistent**: Sessions survive terminal close
- **Lightweight**: < 1MB overhead per session
- **Controllable**: `tmux send-keys` to inject commands
- **Familiar**: Works with existing pi workflow

---

## 3. Architecture Overview

### 3.1 Three-Layer Architecture (HECTOR-Inspired)

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER I: Human-Daemon Interaction                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │    tmux     │  │    web      │  │  telegram   │           │
│  │   TUI       │  │   UI        │  │   Bot       │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│         │               │                │                      │
│         └───────────────┼────────────────┘                      │
│                         ▼                                       │
│              ┌─────────────────┐                               │
│              │   API Gateway   │                               │
│              │  (REST/WS)     │                               │
│              └─────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER II: Daemon Master (Braid-OS)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Session   │  │    Task     │  │   Worker    │             │
│  │   Manager   │  │   Queue     │  │   Registry  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   State     │  │   Belief   │  │    Health    │             │
│  │   Store     │  │   Engine   │  │   Monitor    │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Leader    │  │    Task     │  │   Memory    │             │
│  │   Election  │  │   Router   │  │   Pool      │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER III: Worker Pool (tmux Sessions)                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Generalist │  │ Specialist  │  │ Specialist  │             │
│  │  Worker-1   │  │  Worker-2   │  │  Worker-3   │             │
│  │  (pi)       │  │  (pi+code)  │  │  (pi+web)   │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                              │                                  │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│        ┌─────────┐     ┌─────────┐     ┌─────────┐             │
│        │ memory/ │     │ memory/ │     │ memory/ │             │
│        │ state   │     │ state   │     │ state   │             │
│        └─────────┘     └─────────┘     └─────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Responsibilities

| Layer | Component | Responsibility |
|-------|-----------|---------------|
| I | tmux TUI | Direct daemon interaction |
| I | web UI | Remote daemon control |
| I | telegram Bot | Mobile daemon access |
| II | Session Manager | Track user sessions, context |
| II | Task Queue | Distribute work to workers |
| II | Worker Registry | Track worker state, health |
| II | State Store | Persistent state (Aethon-inspired) |
| II | Belief Engine | Declarative coordination (Credo) |
| II | Leader Election | Raft-inspired master election |
| II | Task Router | Match tasks to workers |
| III | Generalist Worker | Any task |
| III | Specialist Workers | Domain-specific tasks |

---

## 4. Core Components

### 4.1 Braid-OS Daemon

```typescript
// braid-os/daemon/index.ts

interface BraidOSDaemon {
    // Lifecycle
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;

    // Session management
    createSession(userId: string): Session;
    getSession(sessionId: string): Session | null;
    destroySession(sessionId: string): void;

    // Worker management
    spawnWorker(config: WorkerConfig): Worker;
    destroyWorker(workerId: string): void;
    getWorker(workerId: string): Worker | null;
    listWorkers(): Worker[];

    // Task management
    submitTask(task: Task): TaskId;
    getTask(taskId: TaskId): Task | null;
    cancelTask(taskId: TaskId): void;
    getTaskQueue(): Task[];

    // Health
    getHealth(): DaemonHealth;
    getMetrics(): DaemonMetrics;
}

interface DaemonConfig {
    port: number;
    tmuxBaseSession: string;
    maxWorkers: number;
    workerTimeout: number;
    stateDir: string;
    logDir: string;
}
```

### 4.2 Worker (tmux Subagent)

```typescript
// braid-os/worker/worker.ts

interface Worker {
    id: string;
    session: string;  // tmux session name
    state: WorkerState;
    specialty: WorkerSpecialty;
    capabilities: string[];
    currentTask: Task | null;
    memory: WorkerMemory;
    health: WorkerHealth;
}

type WorkerState = "idle" | "busy" | "suspended" | "dead";
type WorkerSpecialty = "generalist" | "coding" | "web" | "research" | "debug";

interface WorkerConfig {
    specialty: WorkerSpecialty;
    capabilities: string[];
    memoryLimit: number;
    timeout: number;
    extensions: string[];  // pi-braid extensions to load
}
```

### 4.3 Session (User Context)

```typescript
// braid-os/session/session.ts

interface Session {
    id: string;
    userId: string;
    createdAt: number;
    lastActive: number;
    context: SessionContext;
    workers: string[];  // Worker IDs assigned to this session
    tasks: string[];    // Task IDs for this session
    beliefs: Belief[];   // Session-specific beliefs
    preferences: UserPreferences;
}

interface SessionContext {
    cwd: string;
    project: string | null;
    history: ConversationEntry[];
    variables: Record<string, unknown>;
}
```

---

## 5. Daemon Master Layer

### 5.1 Session Manager

```typescript
// braid-os/daemon/session-manager.ts

export class SessionManager {
    private sessions: Map<string, Session> = new Map();

    async createSession(userId: string): Promise<Session> {
        const session: Session = {
            id: generateSessionId(),
            userId,
            createdAt: Date.now(),
            lastActive: Date.now(),
            context: {
                cwd: process.cwd(),
                project: null,
                history: [],
                variables: {}
            },
            workers: [],
            tasks: [],
            beliefs: [],
            preferences: DEFAULT_PREFERENCES
        };

        this.sessions.set(session.id, session);
        await this.persistSession(session);
        return session;
    }

    async getSession(sessionId: string): Promise<Session | null> {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.lastActive = Date.now();
        }
        return session ?? null;
    }

    async destroySession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        // Release all workers
        for (const workerId of session.workers) {
            await this.releaseWorker(workerId);
        }

        this.sessions.delete(sessionId);
        await this.deletePersistedSession(sessionId);
    }
}
```

### 5.2 Task Queue

```typescript
// braid-os/daemon/task-queue.ts

interface Task {
    id: TaskId;
    sessionId: string;
    type: TaskType;
    priority: number;
    description: string;
    input: TaskInput;
    status: TaskStatus;
    assignedWorker: string | null;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    result: TaskResult | null;
    error: TaskError | null;
}

type TaskType = "general" | "coding" | "research" | "web" | "debug";
type TaskStatus = "queued" | "assigned" | "running" | "completed" | "failed" | "cancelled";

export class TaskQueue {
    private queue: PriorityQueue<Task> = new PriorityQueue(
        (a, b) => b.priority - a.priority
    );
    private running: Map<TaskId, Task> = new Map();

    submit(task: Task): TaskId {
        this.queue.push(task);
        this.notifyWorkers();
        return task.id;
    }

    async assignTask(workerId: string, capabilities: string[]): Promise<Task | null> {
        // Find highest priority task that matches capabilities
        const task = this.queue.pop(
            t => t.type === "general" || capabilities.includes(t.type)
        );

        if (!task) return null;

        task.status = "assigned";
        task.assignedWorker = workerId;
        task.startedAt = Date.now();
        this.running.set(task.id, task);

        return task;
    }

    complete(taskId: TaskId, result: TaskResult): void {
        const task = this.running.get(taskId);
        if (!task) return;

        task.status = "completed";
        task.completedAt = Date.now();
        task.result = result;
        this.running.delete(taskId);
    }
}
```

### 5.3 Worker Registry

```typescript
// braid-os/daemon/worker-registry.ts

export class WorkerRegistry {
    private workers: Map<string, Worker> = new Map();
    private tmux: TmuxService;

    async spawnWorker(config: WorkerConfig): Promise<Worker> {
        const sessionName = `braid-worker-${generateId()}`;

        // Create tmux session
        await this.tmux.createSession(sessionName, {
            attach: false,
            persistent: true
        });

        // Start pi-agent in session
        await this.tmux.sendCommand(
            sessionName,
            `pi --session ${sessionName} --extensions ${config.extensions.join(",")}`
        );

        const worker: Worker = {
            id: generateWorkerId(),
            session: sessionName,
            state: "idle",
            specialty: config.specialty,
            capabilities: config.capabilities,
            currentTask: null,
            memory: { episodes: [], heuristics: [], toolReliability: {} },
            health: { uptime: 0, tasksCompleted: 0, errors: 0 }
        };

        this.workers.set(worker.id, worker);
        return worker;
    }

    async destroyWorker(workerId: string): Promise<void> {
        const worker = this.workers.get(workerId);
        if (!worker) return;

        // Detach and kill tmux session
        await this.tmux.killSession(worker.session);
        this.workers.delete(workerId);
    }

    getAvailableWorkers(): Worker[] {
        return [...this.workers.values()]
            .filter(w => w.state === "idle");
    }

    assignTask(workerId: string, task: Task): void {
        const worker = this.workers.get(workerId);
        if (!worker) return;

        worker.state = "busy";
        worker.currentTask = task;

        // Send task to worker via tmux
        this.tmux.sendCommand(worker.session, task.input.prompt);
    }
}
```

---

## 6. Worker Layer (tmux Subagents)

### 6.1 Worker Lifecycle

```
┌──────────┐    spawn     ┌──────────┐    assign    ┌──────────┐
│  DEAD    │ ──────────▶  │  IDLE    │ ──────────▶  │  BUSY    │
└──────────┘              └──────────┘              └──────────┘
     ▲                        │                        │
     │                        │ timeout                │ complete/error
     │                        ▼                        ▼
     │                   ┌──────────┐              ┌──────────┐
     └───────────────────│ SUSPENDED │◀───────────│ RUNNING  │
                        └──────────┘   suspend    └──────────┘
```

### 6.2 tmux Worker Service

```typescript
// braid-os/worker/tmux-service.ts

export class TmuxService {
    private sessionPrefix = "braid-worker-";

    async createSession(name: string, config: TmuxConfig): Promise<void> {
        const session = this.sessionPrefix + name;

        await exec(`tmux new-session -d -s ${session} -c ~/.pi-braid`);

        if (config.persistent) {
            // Prevent session from dying on detach
            await exec(`tmux set-option -t ${session} remain-on-exit on`);
        }
    }

    async sendCommand(session: string, command: string): Promise<void> {
        await exec(`tmux send-keys -t ${session} "${escape(command)}" C-m`);
    }

    async captureOutput(session: string, lines: number = 100): Promise<string> {
        const result = await exec(
            `tmux capture-pane -t ${session} -p -S -${lines}`
        );
        return result.stdout;
    }

    async killSession(session: string): Promise<void> {
        await exec(`tmux kill-session -t ${session}`);
    }

    async listSessions(): Promise<string[]> {
        const result = await exec("tmux list-sessions -F '#{session_name}'");
        return result.stdout
            .split("\n")
            .filter(s => s.startsWith(this.sessionPrefix));
    }

    async attachUser(session: string): Promise<void> {
        // For user to interact with worker directly
        await exec(`tmux attach-session -t ${session}`);
    }
}
```

### 6.3 Worker Memory (Aethon-Inspired)

```typescript
// braid-os/worker/memory.ts

interface WorkerMemory {
    // Aethon-inspired: layered memory with copy-on-write
    layers: MemoryLayers;

    // Evo-MedAgent-inspired: three memory stores
    episodes: Episode[];        // Case-based reasoning
    heuristics: HeuristicRule[];  // Evolving rules
    toolReliability: ToolStats;  // Per-tool trustworthiness
}

interface MemoryLayers {
    base: MemoryReference;       // Shared base (Aethon)
    session: MemoryOverlay;       // Session-specific (copy-on-write)
    task: MemoryDelta[];         // Task-specific changes
}

// Reference-based (Aethon): don't duplicate, reference shared memory
interface MemoryReference {
    id: string;
    path: string;  // Path to shared memory file
    version: number;
}

// Copy-on-write: fork memory on write
interface MemoryOverlay {
    parent: string;  // Parent layer ID
    delta: MemoryDelta;
}

interface MemoryDelta {
    added: Record<string, unknown>;
    modified: Record<string, { old: unknown; new: unknown }>;
    deleted: string[];
}
```

---

## 7. Leader Election (Raft-Inspired)

### 7.1 Why Raft-Inspired?

We need a **singleton daemon** that:
1. Survives crashes
2. Can failover to a backup
3. Maintains state consistency
4. Is simple to implement

**Full Raft is overkill** for single-machine. We use **Raft-inspired** patterns.

### 7.2 Leader Election Protocol

```typescript
// braid-os/daemon/leader-election.ts

interface LeaderElection {
    // Raft-inspired: leader, candidate, follower
    state: "leader" | "candidate" | "follower";

    // Term (Raft-inspired)
    currentTerm: number;
    votedFor: string | null;

    // Leader info
    leaderId: string | null;
    lastHeartbeat: number;

    // Election timeout (randomized)
    electionTimeout: number;
    heartbeatInterval: number;
}

const DEFAULT_CONFIG = {
    electionTimeoutMin: 1500,   // ms
    electionTimeoutMax: 3000,   // ms
    heartbeatInterval: 500,     // ms
    maxRetries: 3
};

// For single machine: use lock file
// For multi-machine: would use Raft consensus

export class SingleMachineLeaderElection {
    private lockFile: string;
    private state: LeaderElection;
    private isLeader: boolean = false;

    async acquireLeadership(): Promise<boolean> {
        try {
            // Try to acquire exclusive lock
            await fs.writeFile(this.lockFile, JSON.stringify({
                pid: process.pid,
                startedAt: Date.now(),
                term: this.state.currentTerm
            }), { flag: "wx" });  // Exclusive create

            this.isLeader = true;
            this.startHeartbeat();
            return true;
        } catch (err) {
            if (err.code === "EEXIST") {
                // Another instance holds the lock
                return false;
            }
            throw err;
        }
    }

    async renewLeadership(): Promise<boolean> {
        if (!this.isLeader) return false;

        try {
            await fs.writeFile(this.lockFile, JSON.stringify({
                pid: process.pid,
                startedAt: Date.now(),
                term: this.state.currentTerm,
                renewedAt: Date.now()
            }));
            return true;
        } catch {
            // Lost leadership
            this.isLeader = false;
            return false;
        }
    }

    async checkLeadership(): Promise<"leader" | " follower" | "none"> {
        try {
            const content = await fs.readFile(this.lockFile, "utf-8");
            const lock = JSON.parse(content);

            if (lock.pid === process.pid) {
                return "leader";
            }

            // Check if leader is alive (staleness)
            if (Date.now() - lock.renewedAt > DEFAULT_CONFIG.electionTimeoutMax) {
                // Leader is dead, try to acquire
                return await this.acquireLeadership() ? "leader" : "none";
            }

            return "follower";
        } catch {
            // No lock file, try to acquire
            return await this.acquireLeadership() ? "leader" : "none";
        }
    }

    private startHeartbeat(): void {
        setInterval(async () => {
            if (!this.isLeader) return;
            await this.renewLeadership();
        }, DEFAULT_CONFIG.heartbeatInterval);
    }
}
```

### 7.3 Multi-Machine Raft (Future)

For distributed deployment:

```typescript
// braid-os/daemon/distributed-leader-election.ts

interface RaftNode {
    id: string;
    address: string;
    state: "leader" | "candidate" | "follower";
    currentTerm: number;
    log: LogEntry[];
    commitIndex: number;
    lastApplied: number;

    // Raft RPC
    requestVote(other: RaftNode): Promise<VoteResponse>;
    appendEntries(other: RaftNode, entries: LogEntry[]): Promise<AppendResponse>;
}

class DistributedLeaderElection {
    private nodes: RaftNode[] = [];
    private myself: RaftNode;

    async startElection(): Promise<void> {
        this.myself.state = "candidate";
        this.myself.currentTerm++;

        const votes = [this.myself.id];

        for (const node of this.nodes) {
            if (node.id === this.myself.id) continue;

            const response = await this.myself.requestVote(node);
            if (response.voteGranted) {
                votes.push(node.id);
            }
        }

        if (votes.length > this.nodes.length / 2) {
            this.myself.state = "leader";
        } else {
            this.myself.state = "follower";
        }
    }
}
```

---

## 8. Aethon-Inspired Instantiation

### 8.1 The Problem

Starting a new worker = slow:
```
1. Create tmux session     ~10ms
2. Start pi process         ~500ms
3. Load extensions          ~1000ms
4. Initialize state         ~200ms
Total:                      ~1700ms
```

### 8.2 Aethon Solution: Reference-Based Workers

From **Aethon (2604.12129)**:
> "Aethon represents each instance as a compositional view over stable definitions, layered memory, and local contextual overlays. By shifting instantiation from duplication to reference, Aethon decouples creation cost from inherited structure."

```typescript
// braid-os/worker/aethon-worker.ts

interface AethonWorker {
    // Stable definitions (shared, not copied)
    definitions: WorkerDefinitions;

    // Layered memory (copy-on-write)
    memory: LayeredMemory;

    // Local context (session-specific)
    context: LocalContext;
}

interface WorkerDefinitions {
    extensions: string[];       // pi-braid extensions
    capabilities: string[];     // What worker can do
    tools: ToolDefinition[];   // Tool schemas
    systemPrompt: string;      // Base system prompt
}

interface LayeredMemory {
    base: MemoryLayer;         // Shared read-only base
    session: MemoryLayer;      // Session overlay (copy-on-write)
    task: MemoryLayer;         // Task delta
}

interface LocalContext {
    sessionId: string;
    cwd: string;
    userId: string;
    variables: Record<string, unknown>;
}

// Worker factory using Aethon pattern
class AethonWorkerFactory {
    private baseDefinitions: WorkerDefinitions;
    private baseMemory: MemoryLayer;

    async createWorker(
        sessionId: string,
        specialty: WorkerSpecialty
    ): Promise<AethonWorker> {

        // Reference base definitions (no copying)
        const definitions = this.baseDefinitions;

        // Copy-on-write memory: fork from base
        const sessionMemory = await this.forkMemory(this.baseMemory);

        // Create local context
        const context: LocalContext = {
            sessionId,
            cwd: process.cwd(),
            userId: getCurrentUser(),
            variables: {}
        };

        return {
            definitions,
            memory: {
                base: this.baseMemory,     // Shared reference
                session: sessionMemory,     // Forked
                task: { data: {}, version: 0 }
            },
            context
        };
    }

    private async forkMemory(parent: MemoryLayer): Promise<MemoryLayer> {
        // Instead of copying, create a fork reference
        // Actual data is shared until first write (copy-on-write)
        return {
            id: generateId(),
            parentId: parent.id,
            data: {},  // Empty until written
            version: 0
        };
    }
}
```

### 8.3 Fast Worker Spawn

```typescript
// braid-os/worker/fast-spawn.ts

class FastWorkerSpawner {
    // Pre-warmed workers (reference ready, just need tmux)
    private warmPool: Worker[] = [];
    private warmPoolSize = 3;

    async initialize(): Promise<void> {
        // Pre-create workers but don't start pi yet
        for (let i = 0; i < this.warmPoolSize; i++) {
            const worker = await this.createPreWarmedWorker();
            this.warmPool.push(worker);
        }
    }

    async spawn(sessionId: string): Promise<Worker> {
        // Fast path: grab from warm pool
        const warmWorker = this.warmPool.pop();
        if (warmWorker) {
            // Just update context, don't recreate
            await this.updateContext(warmWorker, sessionId);
            await this.resumeWorker(warmWorker);
            return warmWorker;
        }

        // Slow path: create new
        return await this.createNewWorker(sessionId);
    }

    private async resumeWorker(worker: Worker): Promise<void> {
        // Worker is pre-warmed, just send resume command
        await tmux.sendCommand(worker.session, "resume");
    }
}
```

---

## 9. HECTOR-Inspired Hierarchy

### 9.1 Three Layers (from HECTOR)

**HECTOR paper** defines:
1. Layer I: Human-fleet bidirectional interaction
2. Layer II: Rolling task assignment to teams
3. Layer III: Dynamic coordination within teams

**Applied to Braid-OS**:

| HECTOR Layer | Braid-OS Layer | Responsibility |
|-------------|-----------------|----------------|
| I | User Interfaces | tmux TUI, web, telegram |
| II | Task Router + Queue | Match tasks to workers |
| III | Worker Coordination | Within-worker task handling |

### 9.2 Bidirectional Communication

```typescript
// braid-os/layer1/user-communication.ts

interface UserCommunication {
    // User → Daemon
    sendCommand(command: string): void;
    setPreference(key: string, value: unknown): void;
    interrupt(taskId: string): void;

    // Daemon → User
    onTaskUpdate(callback: (task: Task) => void): void;
    onWorkerUpdate(callback: (worker: Worker) => void): void;
    onSystemMessage(callback: (msg: SystemMessage) => void): void;
}

// System messages (daemon-initiated)
type SystemMessage =
    | { type: "task_started"; taskId: string }
    | { type: "task_completed"; taskId: string; result: unknown }
    | { type: "worker_idle"; workerId: string }
    | { type: "memory_warning"; workerId: string; usage: number }
    | { type: "health_check"; status: DaemonHealth };
```

### 9.3 Task Routing (Layer II)

```typescript
// braid-os/layer2/task-router.ts

interface TaskRouter {
    // Match task to best worker
    route(task: Task): string | null;

    // Load balancing
    getLoad(workerId: string): number;
}

class HECTORRouter implements TaskRouter {
    // Layer II: Rolling assignment based on capability + load

    async route(task: Task): Promise<string | null> {
        // 1. Filter workers by capability
        const capableWorkers = this.getWorkersByCapability(task.type);

        if (capableWorkers.length === 0) {
            return null;  // No capable worker
        }

        // 2. Score by multiple factors
        const scores = capableWorkers.map(w => ({
            worker: w,
            score: this.calculateScore(w, task)
        }));

        // 3. Select highest score
        scores.sort((a, b) => b.score - a.score);

        return scores[0]?.worker.id ?? null;
    }

    private calculateScore(worker: Worker, task: Task): number {
        // Multi-factor scoring (HECTOR-inspired)
        const factors = {
            capability: worker.capabilities.includes(task.type) ? 1.0 : 0.0,
            load: 1.0 - (this.getLoad(worker.id) / 100),
            reliability: this.getReliability(worker.id),  // From Evo-MedAgent
            specialty: worker.specialty === task.type ? 1.2 : 1.0,
            memoryFit: this.getMemoryFit(worker, task)
        };

        return (
            factors.capability * 0.4 +
            factors.load * 0.2 +
            factors.reliability * 0.2 +
            factors.specialty * 0.1 +
            factors.memoryFit * 0.1
        );
    }

    private getLoad(workerId: string): number {
        const worker = this.workers.get(workerId);
        if (!worker) return 100;
        if (worker.state === "idle") return 0;
        if (worker.state === "busy") return 100;
        return 50;
    }

    private getReliability(workerId: string): number {
        const stats = this.memory.toolReliability.get(workerId);
        if (!stats || stats.attempts === 0) return 0.5;
        return stats.successes / stats.attempts;
    }

    private getMemoryFit(worker: Worker, task: Task): number {
        // Does worker have relevant episodes?
        const episodes = worker.memory.episodes;
        const relevant = episodes.filter(e =>
            semanticSimilarity(e.task, task.description) > 0.7
        );
        return Math.min(relevant.length / 5, 1.0);
    }
}
```

### 9.4 Worker Coordination (Layer III)

```typescript
// braid-os/layer3/worker-coordination.ts

interface WorkerCoordinator {
    // Coordinate subtasks within a worker
    decompose(task: Task): Subtask[];
    coordinate(subtasks: Subtask[]): Promise<SubtaskResult[]>;
}

class HierarchicalWorkerCoordinator implements WorkerCoordinator {
    // Layer III: Dynamic coordination within worker

    async decompose(task: Task): Promise<Subtask[]> {
        // Use planning to break down task
        const plan = await this.invokePlanning(task);

        return plan.steps.map((step, i) => ({
            id: `${task.id}-${i}`,
            parentId: task.id,
            description: step.description,
            tool: step.tool,
            dependencies: step.dependsOn ?? [],
            status: "pending" as const
        }));
    }

    async coordinate(subtasks: Subtask[]): Promise<SubtaskResult[]> {
        // Execute in dependency order
        const results: SubtaskResult[] = [];
        const completed = new Set<string>();

        for (const subtask of this.topologicalSort(subtasks)) {
            // Wait for dependencies
            await this.waitForDependencies(subtask, completed);

            // Execute
            const result = await this.executeSubtask(subtask);

            results.push(result);
            completed.add(subtask.id);
        }

        return results;
    }

    private async executeSubtask(subtask: Subtask): Promise<SubtaskResult> {
        try {
            // Execute via worker's tmux session
            await this.tmux.sendCommand(
                subtask.workerSession,
                `use tool ${subtask.tool} with ${subtask.description}`
            );

            // Wait for completion
            const result = await this.waitForResult(subtask.id);

            return { ...subtask, status: "completed", result };
        } catch (err) {
            return { ...subtask, status: "failed", error: err.message };
        }
    }
}
```

---

## 10. User Interfaces

### 10.1 Interface Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    USER INTERFACES                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   tmux      │  │    web      │  │   telegram   │       │
│  │   TUI       │  │   UI        │  │   Bot        │       │
│  │             │  │             │  │             │       │
│  │  braid tui  │  │  braid-web  │  │  @braidbot  │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│          │                │                │               │
│          └────────────────┼────────────────┘               │
│                           ▼                                │
│              ┌─────────────────────┐                      │
│              │    API Gateway      │                      │
│              │  REST + WebSocket   │                      │
│              └─────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 tmux TUI

```bash
# braid-tui: Direct interaction with daemon
braid tui
```

```
┌─────────────────────────────────────────────────────────────┐
│  Braid-OS TUI                              [Connected]    │
├─────────────────────────────────────────────────────────────┤
│  Workers: 3/5 active    Tasks: 2 running    Mem: 67%       │
├─────────────────────────────────────────────────────────────┤
│  > _                                                         │
│                                                               │
│  [1] worker-1: idle        [coding]     uptime: 2h          │
│  [2] worker-2: busy         [web]        task: research    │
│  [3] worker-3: idle         [general]    uptime: 45m        │
├─────────────────────────────────────────────────────────────┤
│  Commands: submit | status | attach | interrupt | quit       │
└─────────────────────────────────────────────────────────────┘
```

### 10.3 REST API

```typescript
// braid-os/api/rest.ts

const API_ROUTES = {
    // Session
    "POST /session": "Create new session",
    "GET /session/:id": "Get session info",
    "DELETE /session/:id": "Destroy session",

    // Tasks
    "POST /task": "Submit new task",
    "GET /task/:id": "Get task status",
    "DELETE /task/:id": "Cancel task",

    // Workers
    "GET /workers": "List all workers",
    "POST /workers": "Spawn new worker",
    "DELETE /workers/:id": "Destroy worker",
    "POST /workers/:id/suspend": "Suspend worker",
    "POST /workers/:id/resume": "Resume worker",

    // Daemon
    "GET /health": "Get daemon health",
    "GET /metrics": "Get daemon metrics",
    "POST /daemon/restart": "Restart daemon"
};
```

### 10.4 WebSocket Events

```typescript
// braid-os/api/websocket.ts

interface WebSocketEvents {
    // Client → Server
    "task:submit": (task: TaskInput) => void;
    "task:cancel": (taskId: string) => void;
    "worker:attach": (workerId: string) => void;

    // Server → Client
    "task:update": (task: Task) => void;
    "worker:update": (worker: Worker) => void;
    "system:message": (msg: SystemMessage) => void;
}
```

---

## 11. State Management

### 11.1 State Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    STATE STORE                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │  Session   │  │   Task     │  │   Worker    │           │
│  │   State   │  │   State    │  │   State     │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Belief   │  │  Memory    │  │  Metrics   │         │
│  │   State    │  │   Pool     │  │   State    │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
│              ┌─────────────────────┐                         │
│              │    State Store     │                         │
│              │  (SQLite/LevelDB)   │                         │
│              └─────────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

### 11.2 Persistence

```typescript
// braid-os/state/persistence.ts

interface StatePersistence {
    save(): Promise<void>;
    load(): Promise<void>;
    checkpoint(): Promise<void>;
}

class CheckpointPersistence implements StatePersistence {
    private db: LevelDB;
    private checkpointInterval = 60000;  // 1 minute

    async save(): Promise<void> {
        const state = this.captureState();
        const key = `checkpoint-${Date.now()}`;
        await this.db.put(key, JSON.stringify(state));
    }

    async load(): Promise<void> {
        // Find latest checkpoint
        const keys = await this.db.keys();
        const checkpoints = keys.filter(k => k.startsWith("checkpoint-"));

        if (checkpoints.length === 0) return;

        checkpoints.sort();
        const latest = checkpoints[checkpoints.length - 1];
        const state = JSON.parse(await this.db.get(latest));

        this.restoreState(state);
    }

    async checkpoint(): Promise<void> {
        // Incremental checkpoint (only changes)
        const delta = this.captureDelta();
        if (Object.keys(delta).length > 0) {
            await this.db.put(`delta-${Date.now()}`, JSON.stringify(delta));
        }
    }
}
```

---

## 12. Implementation Plan

### 12.1 Phase 1: Core Daemon (Week 1-2)

**Goal**: Basic daemon that runs and spawns workers

| Task | Effort | Description |
|------|--------|-------------|
| Daemon skeleton | 1 day | Start/stop/health |
| tmux integration | 2 days | Create/destroy/send sessions |
| Worker spawn | 2 days | Basic pi subagent |
| Session management | 1 day | Create/destroy sessions |
| Task queue | 2 days | Submit/complete tasks |

### 12.2 Phase 2: User Interfaces (Week 3)

**Goal**: Provide ways to interact with daemon

| Task | Effort | Description |
|------|--------|-------------|
| REST API | 2 days | CRUD operations |
| tmux TUI | 2 days | Terminal interface |
| WebSocket | 1 day | Real-time updates |
| Telegram bot | 2 days | Mobile access |

### 12.3 Phase 3: Advanced Features (Week 4-5)

**Goal**: Production-ready features

| Task | Effort | Description |
|------|--------|-------------|
| Leader election | 2 days | Single-machine lock file |
| Aethon workers | 3 days | Fast instantiation |
| State persistence | 2 days | Survive restarts |
| Belief engine | 2 days | Declarative coordination |

### 12.4 Phase 4: Research Integration (Week 6+)

**Goal**: Implement research findings

| Task | Effort | Description |
|------|--------|-------------|
| HECTOR routing | 2 days | Capability + load routing |
| Evo-MedAgent memories | 3 days | Three memory stores |
| Health monitoring | 2 days | Worker health |
| Metrics | 1 day | Performance tracking |

---

## 13. Research Papers

### 13.1 Core References

| Paper | arXiv | Contribution |
|-------|-------|-------------|
| **Aethon** | 2604.12129 | Reference-based replication, copy-on-write for fast instantiation |
| **AIBuildAI** | 2604.14455 | Hierarchical manager + specialized sub-agents |
| **Governance by Design** | 2604.11337 | Parsonian AGIL framework for agent societies |
| **HECTOR** | 2604.10892 | Three-layer human-centric hierarchical coordination |

### 13.2 Supporting References

| Paper | arXiv | Contribution |
|-------|-------|-------------|
| **CoopEval** | 2604.15267 | Cooperation-sustaining mechanisms |
| **Autogenesis** | 2604.15034 | Self-evolution with rollback |
| **Evo-MedAgent** | 2604.14475 | Three memory stores |
| **Credo** | 2604.14401 | Declarative belief + policy system |
| **Heartbeat** | 2604.14178 | Proactive cognitive scheduling |

---

## Appendix A: File Structure

```
braid-os/
├── daemon/
│   ├── index.ts              # Main daemon entry
│   ├── session-manager.ts    # Session lifecycle
│   ├── task-queue.ts         # Task distribution
│   ├── worker-registry.ts    # Worker tracking
│   ├── leader-election.ts    # Raft-inspired election
│   ├── state-store.ts        # State persistence
│   └── health-monitor.ts     # Health checks
│
├── worker/
│   ├── worker.ts             # Worker interface
│   ├── tmux-service.ts       # tmux operations
│   ├── aethon-worker.ts     # Reference-based workers
│   ├── fast-spawn.ts         # Pre-warmed workers
│   └── memory/
│       ├── layered-memory.ts # Copy-on-write memory
│       └── memory-pool.ts    # Shared memory pool
│
├── layer1/                   # User interfaces
│   ├── api/
│   │   ├── rest.ts          # REST endpoints
│   │   └── websocket.ts     # WebSocket events
│   ├── tui/
│   │   └── braid-tui.ts     # Terminal UI
│   └── telegram/
│       └── braid-bot.ts     # Telegram bot
│
├── layer2/                   # Task routing
│   ├── task-router.ts        # HECTOR-style routing
│   └── load-balancer.ts      # Load balancing
│
├── layer3/                   # Worker coordination
│   ├── task-decomposer.ts   # Break down tasks
│   └── subtask-coordinator.ts # Coordinate subtasks
│
├── belief/                   # Credo-inspired
│   ├── belief-engine.ts     # Belief store
│   └── policy-engine.ts     # Policy evaluation
│
├── memory/                   # Evo-MedAgent-inspired
│   ├── episodes.ts           # Case-based episodes
│   ├── heuristics.ts         # Evolving rules
│   └── tool-reliability.ts  # Success tracking
│
└── utils/
    ├── logger.ts
    ├── config.ts
    └── errors.ts
```

---

## Appendix B: Configuration

```yaml
# ~/.pi-braid/config.yaml

daemon:
  port: 8080
  state_dir: ~/.pi-braid/state
  log_dir: ~/.pi-braid/logs
  max_workers: 5

tmux:
  base_session: braid-worker
  prefix: braid-worker-

leader:
  election_timeout_min: 1500
  election_timeout_max: 3000
  heartbeat_interval: 500

worker:
  default_timeout: 3600
  memory_limit_mb: 2048
  extensions:
    - metacognition
    - enforcement
    - context-manager
    - scratchpad
    - browser

memory:
  max_episodes: 1000
  max_heuristics: 500
  prune_threshold: 0.3

api:
  cors: true
  api_key_required: false

interfaces:
  tui:
    enabled: true
  web:
    enabled: true
    port: 3000
  telegram:
    enabled: false
    bot_token: ""
```

---

**Status**: Proposal v0.1  
**Next Steps**: 
1. Review with research team
2. Prototype daemon skeleton
3. Test tmux integration
