/**
 * Task Tool — Dedicated task management for the pi agent.
 *
 * Extracted from the scratchpad monolith (was 8 sub-actions of scratchpad).
 * Uses the same persisted task store (mutateTaskStore / loadTaskStore).
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { mutateTaskStore, loadTaskStore } from "./persistence.js";
import type { TaskItem } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function resolveProjectSlugFromCtx(ctx: ExtensionContext): string {
  const cwd = (ctx as { cwd?: string }).cwd ?? "";
  // Inlined from persistence.ts to avoid circular dep
  const slug = cwd.replace(/[/:]/g, "-").replace(/^-+|-+$/g, "") || "default";
  return slug;
}

// ── Schema ────────────────────────────────────────────────────────────────

const taskActions = Type.Union([
  Type.Literal("add"),
  Type.Literal("list"),
  Type.Literal("complete"),
  Type.Literal("fail"),
  Type.Literal("next"),
  Type.Literal("remove"),
  Type.Literal("stats"),
  Type.Literal("clear"),
]);

export const taskParams = Type.Object({
  action: taskActions,
  text: Type.Optional(Type.String({ description: "Task description. Required for action=add." })),
  task_id: Type.Optional(Type.String({ description: "Task ID. Required for action=complete|fail|remove." })),
  priority: Type.Optional(Type.Number({ description: "Priority 0-10 (default 5). Only used with action=add." })),
  dependencies: Type.Optional(Type.Array(Type.String(), { description: "Task dependencies. Only used with action=add." })),
});

// ── Execute ───────────────────────────────────────────────────────────────

export async function taskExecute(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: any,
  _onUpdate: any,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const action = params.action as string;
  const text = (params.text as string) ?? "";
  const task_id = params.task_id as string | undefined;
  const priority = params.priority as number | undefined;
  const dependencies = params.dependencies as string[] | undefined;
  const slug = resolveProjectSlugFromCtx(ctx);
  let resultText = "";

  switch (action) {
    case "add": {
      const task: TaskItem = {
        id: generateTaskId(),
        text,
        priority: priority ?? 5,
        dependencies: dependencies ?? [],
        status: "pending",
        created_at: Date.now(),
        updated_at: Date.now(),
        tags: [],
      };
      await mutateTaskStore(slug, (store) => {
        store.tasks.push(task);
        return store;
      });
      resultText = `Task added: ${text} (id: ${task.id})`;
      break;
    }

    case "list": {
      const store = await loadTaskStore(slug);
      const byStatus: Record<string, TaskItem[]> = {
        pending: [],
        in_progress: [],
        completed: [],
        failed: [],
      };
      for (const t of store.tasks) {
        (byStatus[t.status] ??= []).push(t);
      }
      resultText = `Tasks: ${store.tasks.length} total (${byStatus.pending.length} pending, ${byStatus.in_progress.length} in progress, ${byStatus.completed.length} completed, ${byStatus.failed.length} failed)`;
      break;
    }

    case "complete": {
      const store = await loadTaskStore(slug);
      const t = store.tasks.find((t) => t.id === task_id);
      if (t) {
        t.status = "completed";
        t.updated_at = Date.now();
        await mutateTaskStore(slug, () => store);
        resultText = `Task completed: ${t.text}`;
      } else resultText = `Task not found: ${task_id}`;
      break;
    }

    case "fail": {
      const store = await loadTaskStore(slug);
      const t = store.tasks.find((t) => t.id === task_id);
      if (t) {
        t.status = "failed";
        t.updated_at = Date.now();
        await mutateTaskStore(slug, () => store);
        resultText = `Task failed: ${t.text}`;
      } else resultText = `Task not found: ${task_id}`;
      break;
    }

    case "next": {
      const store = await loadTaskStore(slug);
      const next = store.tasks.find((t) => t.status === "pending");
      if (next) resultText = `Next task: ${next.text} (id: ${next.id})`;
      else resultText = "No pending tasks.";
      break;
    }

    case "remove": {
      const store = await loadTaskStore(slug);
      const idx = store.tasks.findIndex((t) => t.id === task_id);
      if (idx >= 0) {
        const removed = store.tasks.splice(idx, 1)[0];
        await mutateTaskStore(slug, () => store);
        resultText = `Task removed: ${removed.text}`;
      } else resultText = `Task not found: ${task_id}`;
      break;
    }

    case "stats": {
      const store = await loadTaskStore(slug);
      const byStatus = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
      for (const t of store.tasks) {
        if (t.status in byStatus) byStatus[t.status as keyof typeof byStatus]++;
      }
      resultText = `Task stats: ${store.tasks.length} total, ${byStatus.pending} pending, ${byStatus.in_progress} in-progress, ${byStatus.completed} completed, ${byStatus.failed} failed`;
      break;
    }

    case "clear": {
      const before = (await loadTaskStore(slug)).tasks.length;
      await mutateTaskStore(slug, (store) => {
        store.tasks = [];
        return store;
      });
      resultText = `Task store cleared: ${before} tasks removed`;
      break;
    }

    default:
      resultText = `Unknown action: ${action}. Use: add, list, complete, fail, next, remove, stats, clear.`;
  }

  return {
    content: [{ type: "text" as const, text: resultText }],
    details: { action },
  };
}
