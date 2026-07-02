/**
 * Workspace Snapshot Tool - lightweight Time Travel for Braid.
 *
 * Captures atomic workspace snapshots: file state (only files the agent
 * modified) + session position + extension state reference + working context.
 * Disk-backed, no git dependency, no user repo pollution.
 *
 * Actions:
 *   capture  - snapshot current workspace state
 *   list     - show all snapshots
 *   info     - show single snapshot metadata
 *   diff     - what changed between a snapshot and current workspace
 *   preview  - see what files would be restored (dry run)
 *   restore  - apply files from a snapshot (with preview confirmation)
 *   delete   - remove a snapshot
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";

import {
  captureSnapshot,
  getSnapshot,
  diffSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  getSnapshotInfo,
  type WorkspaceSnapshotMeta,
} from "../../../lib/state/workspace-snapshot.js";
import * as path from "node:path";

import { getVerifierState } from "../../../lib/store/bidirectional-verifier.js";



// ── Tool Registration ────────────────────────────────────────────────────────

const snapshotActions = StringEnum(
  ["capture", "list", "info", "diff", "preview", "restore", "delete"],
  { description: "Snapshot action" },
);

const workspaceSnapshotSchema = Type.Object({
  action: snapshotActions,
  reason: Type.Optional(
    Type.String({ description: "Reason for snapshot. Required for capture." }),
  ),
  id: Type.Optional(
    Type.String({ description: "Snapshot ID. Required for info, diff, preview, restore, delete." }),
  ),
});

export default function workspaceSnapshotExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workspace_snapshot",
    label: "Workspace Snapshot",
    promptSnippet:
      "Time Travel for workspace state: capture, list, diff, preview, restore file snapshots",
    description:
      "Time Travel for your workspace state - capture workspace snapshots (file contents + session position + context) " +
      "so you can return to any point in your editing history. " +
      "Surgical restore: only apply files that actually changed. " +
      "Actions: capture (save current state), list (show history), info (view metadata), " +
      "diff (compare snapshot to current workspace), preview (dry-run restore), " +
      "restore (apply files from snapshot), delete (remove).",
    parameters: workspaceSnapshotSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      const action = params.action as string;
      const reason = params.reason as string | undefined;
      const id = params.id as string | undefined;

      try {
        const result = await executeSnapshotAction(action, reason, id, ctx);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: result.details,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `workspace_snapshot failed: ${msg}`,
            },
          ],
          details: { error: msg },
        };
      }
    },
  });
}

// ── Action Handlers ─────────────────────────────────────────────────────────

interface ActionResult {
  text: string;
  details: unknown;
}

async function executeSnapshotAction(
  action: string,
  reason: string | undefined,
  id: string | undefined,
  ctx: ExtensionContext,
): Promise<ActionResult> {
  const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();

  switch (action) {
    case "capture":
      return handleCapture(ctx, reason, cwd);

    case "list":
      return handleList();

    case "info":
      return handleInfo(id);

    case "diff":
      return handleDiff(id, cwd);

    case "preview":
      return handlePreview(id, cwd);

    case "restore":
      return handleRestore(id, cwd);

    case "delete":
      return handleDelete(id);

    default:
      return {
        text: `Unknown action: ${action}. Use: capture, list, info, diff, preview, restore, delete.`,
        details: { error: "unknown_action" },
      };
  }
}

async function handleCapture(
  ctx: ExtensionContext,
  reason: string | undefined,
  cwd: string,
): Promise<ActionResult> {
  if (!reason) {
    return {
      text: "Snapshot reason is required. Use: workspace_snapshot(action='capture', reason='before risky refactor')",
      details: { error: "missing_reason" },
    };
  }

  // Collect modified files from the bidirectional-verifier (tracks edit/write targets)
  let modifiedFiles: string[] = [];
  try {
    const verifier = getVerifierState(ctx);
    modifiedFiles = Array.from(verifier.editedFiles);

    // Also include files read during this session - they may have been created via write
    for (const filePath of verifier.readFiles) {
      const absPath = filePath.startsWith("/") ? filePath : path.resolve(cwd, filePath);
      if (!modifiedFiles.includes(absPath) && absPath.startsWith(cwd)) {
        modifiedFiles.push(absPath);
      }
    }
  } catch {
    // Bidirectional verifier state not available - fall through
  }
  const meta = await captureSnapshot(ctx, reason, modifiedFiles, cwd);

  if (!meta) {
    return {
      text: "No modified files to snapshot. Use after editing files.",
      details: { snapshots: 0 },
    };
  }

  return {
    text: [
      `[ok] Snapshot **${meta.id}**: ${reason}`,
      `   ${meta.fileCount} file(s) captured`,
      meta.context ? `   Context: "${meta.context.goal}" (${meta.context.planStepCount} plan steps, ${meta.context.decisionCount} decisions, ${meta.context.learningCount} learnings)` : "",
      meta.sessionTag ? `   Session tag: **${meta.sessionTag}**` : "",
      "",
      `Use \`workspace_snapshot(action='list')\` to view all snapshots.`,
      `Use \`workspace_snapshot(action='preview', id='${meta.id}')\` to see what would be restored.`,
    ]
      .filter(Boolean)
      .join("\n"),
    details: { snapshot: meta, snapshots: 1 },
  };
}

async function handleList(): Promise<ActionResult> {
  const info = await getSnapshotInfo();

  if (info.count === 0) {
    return {
      text: "No workspace snapshots available. Capture one with `workspace_snapshot(action='capture', reason='...')`.",
      details: { count: 0, snapshots: [], storageBytes: 0 },
    };
  }

  const storageSize =
    info.storageBytes < 1024
      ? `${info.storageBytes} B`
      : info.storageBytes < 1024 * 1024
        ? `${(info.storageBytes / 1024).toFixed(1)} KB`
        : `${(info.storageBytes / (1024 * 1024)).toFixed(1)} MB`;

  const lines = info.snapshots.map((s: WorkspaceSnapshotMeta) => {
    const age = Math.round((Date.now() - s.timestamp) / 1000);
    const ageStr =
      age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
    return [
      `- **${s.id}**`,
      `  Reason: ${s.reason}`,
      `  ${s.fileCount} file(s), ${ageStr} ago`,
      s.context ? `  Goal: "${s.context.goal.slice(0, 60)}..."` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return {
    text: [
      `## Workspace Snapshots (${info.count}), ~${storageSize}`,
      "",
      ...lines,
      "",
      "Use `workspace_snapshot(action='info', id='<id>')` for details.",
      "Use `workspace_snapshot(action='diff', id='<id>')` to compare with current state.",
      "Use `workspace_snapshot(action='preview', id='<id>')` to dry-run a restore.",
    ].join("\n"),
    details: { count: info.count, snapshots: info.snapshots, storageBytes: info.storageBytes },
  };
}

async function handleInfo(id: string | undefined): Promise<ActionResult> {
  if (!id) {
    return {
      text: "Snapshot ID required. Use: workspace_snapshot(action='info', id='<snap-id>')",
      details: { error: "missing_id" },
    };
  }

  const meta = await getSnapshot(id);
  if (!meta) {
    return {
      text: `Snapshot not found: ${id}. Use workspace_snapshot(action='list') to see available snapshots.`,
      details: { error: "not_found", id },
    };
  }

  const age = Math.round((Date.now() - meta.timestamp) / 1000);
  const ageStr =
    age < 60
      ? `${age}s ago`
      : age < 3600
        ? `${Math.round(age / 60)}m ago`
        : `${Math.round(age / 3600)}h ago`;

  return {
    text: [
      `## Snapshot: ${meta.id}`,
      `**Reason:** ${meta.reason}`,
      `**Taken:** ${new Date(meta.timestamp).toISOString()} (${ageStr})`,
      `**Files:** ${meta.fileCount}`,
      meta.checkpointRef ? `**Checkpoint:** ${meta.checkpointRef}` : "",
      meta.sessionTag ? `**Session tag:** ${meta.sessionTag}` : "",
      "",
      "### Files captured",
      ...meta.files.map((f: string) => `- \`${f}\``),
      "",
      meta.context
        ? [
            "### Working context at capture time",
            `- Goal: "${meta.context.goal}"`,
            `- ${meta.context.planStepCount} plan steps`,
            `- ${meta.context.decisionCount} decisions`,
            `- ${meta.context.learningCount} key learnings`,
          ].join("\n")
        : "",
      "",
      "Use `workspace_snapshot(action='diff', id='<id>')` to compare with current state.",
      "Use `workspace_snapshot(action='preview', id='<id>')` to dry-run a restore.",
    ]
      .filter(Boolean)
      .join("\n"),
    details: { snapshot: meta },
  };
}

async function handleDiff(id: string | undefined, cwd: string): Promise<ActionResult> {
  if (!id) {
    return {
      text: "Snapshot ID required. Use: workspace_snapshot(action='diff', id='<snap-id>')",
      details: { error: "missing_id" },
    };
  }

  const result = await diffSnapshot(id, cwd);
  if (!result) {
    return {
      text: `Snapshot not found: ${id}`,
      details: { error: "not_found", id },
    };
  }

  const { meta, diff } = result;
  const modified = diff.filter((d) => d.status !== "unchanged");
  const unchanged = diff.filter((d) => d.status === "unchanged").length;

  if (modified.length === 0) {
    return {
      text: `No differences from snapshot **${meta.id}** - workspace is identical.`,
      details: { meta, diff },
    };
  }

  const statusIcon = (s: string) => (s === "modified" ? "✏️" : s === "added" ? "➕" : "🗑️");

  return {
    text: [
      `## Diff vs **${meta.id}** (${meta.reason})`,
      `**${modified.length}** file(s) differ from snapshot. **${unchanged}** unchanged.`,
      "",
      ...modified.map(
        (d) => `${statusIcon(d.status)} **${d.filePath}** - ${d.status}`,
      ),
      "",
      "Use `workspace_snapshot(action='preview', id='<id>')` to see restore details.",
      "Use `workspace_snapshot(action='restore', id='<id>')` to restore files from this snapshot.",
    ].join("\n"),
    details: { meta, diff, modifiedCount: modified.length,
      unchangedCount: unchanged },
  };
}

async function handlePreview(id: string | undefined, cwd: string): Promise<ActionResult> {
  if (!id) {
    return {
      text: "Snapshot ID required. Use: workspace_snapshot(action='preview', id='<snap-id>')",
      details: { error: "missing_id" },
    };
  }

  const result = await restoreSnapshot(id, cwd, true);
  if (!result) {
    return {
      text: `Snapshot not found: ${id}`,
      details: { error: "not_found", id },
    };
  }

  const { meta, toRestore, skipped } = result;

  if (toRestore.length === 0) {
    return {
      text: `Preview: no files would change - workspace already matches **${meta.id}**.`,
      details: { meta, toRestore: [], skipped },
    };
  }

  const statusIcon = (s: string) => (s === "modified" ? "✏️" : "➕");

  return {
    text: [
      `## Preview: Restore **${meta.id}** (${meta.reason})`,
      `**${toRestore.length}** file(s) would be restored.`,
      "",
      ...toRestore.map(
        (d) => `${statusIcon(d.status)} \`${d.filePath}\` - ${d.status}`,
      ),
      ...(skipped.length > 0
        ? [
            "",
            `[warn] **${skipped.length}** file(s) skipped (outside workspace or excluded):`,
            ...skipped.map((f: string) => `- \`${f}\``),
          ]
        : []),
      "",
      "Run \`workspace_snapshot(action='restore', id='<id>')\` to apply these changes.",
      "**This is a dry run - no files were modified.**",
    ].join("\n"),
    details: { meta, toRestore, skipped, dryRun: true },
  };
}

async function handleRestore(id: string | undefined, cwd: string): Promise<ActionResult> {
  if (!id) {
    return {
      text: "Snapshot ID required. Use: workspace_snapshot(action='restore', id='<snap-id>')",
      details: { error: "missing_id" },
    };
  }

  const preview = await restoreSnapshot(id, cwd, true);
  if (!preview) {
    return {
      text: `Snapshot not found: ${id}. Run preview first to see what would change.`,
      details: { error: "not_found", id },
    };
  }

  if (preview.toRestore.length === 0) {
    return {
      text: `Restore **${id}**: workspace already matches snapshot. No files changed.`,
      details: { restored: 0, skipped: 0 },
    };
  }

  // Apply the restore
  const result = await restoreSnapshot(id, cwd, false);
  if (!result) {
    return {
      text: `Restore failed for snapshot: ${id}`,
      details: { error: "restore_failed", id },
    };
  }

  const { meta, toRestore, skipped } = result;

  return {
    text: [
      `[ok] Restored **${toRestore.length}** file(s) from **${meta.id}** (${meta.reason}):`,
      "",
      ...toRestore.map(
        (d) => `- \`${d.filePath}\` - ${d.status === "modified" ? "reverted" : "created"}`,
      ),
      skipped.length > 0 ? `[warn] ${skipped.length} file(s) skipped (security policy)` : "",
      "",
      "**History preserved** - this snapshot is still available. Capture a new one after verifying the restore.",
    ].join("\n"),
    details: { restored: toRestore.length, skipped: skipped.length, files: toRestore.map((d) => d.filePath) },
  };
}

async function handleDelete(id: string | undefined): Promise<ActionResult> {
  if (!id) {
    return {
      text: "Snapshot ID required. Use: workspace_snapshot(action='delete', id='<snap-id>')",
      details: { error: "missing_id" },
    };
  }

  const deleted = await deleteSnapshot(id);
  if (!deleted) {
    return {
      text: `Snapshot not found: ${id}`,
      details: { error: "not_found", id },
    };
  }

  return {
    text: `🗑️ Snapshot **${id}** deleted.`,
    details: { deleted: id },
  };
}


