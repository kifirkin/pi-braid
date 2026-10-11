/**
 * memory_store tool - Persist insights to long-term memory
 *
 * Factory pattern: createMemoryStoreTool(memory, initPromise, recordMemoryToolCall)
 * returns a tool descriptor object matching pi.registerTool's expected shape.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CognitiveMemory, CognitiveMemoryType } from "../../../lib/memory/index.js";
import { deriveProjectIdFromCwd } from "../../../lib/memory/past-insights.js";
import { describeWriteDecision, selectRecentEpisodes } from "../../../lib/memory/write-quality.js";
import { applyWriteGateLogged } from "../../../lib/memory/write-log.js";
import { getMemoryWriteGateConfig } from "../../../lib/config/braid-settings.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { createLogger } from "../../../lib/core/logger.js";
import type { MemoryStoresState } from "../three-memory-stores/index.js";
import { addEpisode, createMemoryStoresState } from "../three-memory-stores/index.js";
import { flushEpisodeAppends } from "../three-memory-stores/episodes-disk.js";

const log = createLogger("memory-agent-bridge/memory-store-tool");

interface MemoryStoreToolDesc {
  name: string;
  label: string;
  promptSnippet: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: any,
    signal: unknown,
    onUpdate: unknown,
    ctx: ExtensionContext | undefined,
  ) => Promise<AgentToolResult<unknown>>;
}

export function createMemoryStoreTool(
  memory: CognitiveMemory,
  initPromise: Promise<void> | null,
  recordMemoryToolCall: (ctx: ExtensionContext | undefined, tool: string) => void,
): MemoryStoreToolDesc {
  return {
    name: "memory_store",
    label: "Store Memory",
    promptSnippet: "Store information in long-term memory",
    description:
      "Persist insights, patterns, and errors to long-term memory for cross-session recall.",
    parameters: Type.Object({
      content: Type.String({
        description: "The information to remember (can be JSON for structured content)",
      }),
      memoryType: StringEnum([
        "insight",
        "pattern",
        "preference",
        "goal",
        "error",
        "episodic",
        "semantic",
        "procedural",
      ]),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
      importance: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, description: "Importance 0-1" }),
      ),
      source: Type.Optional(Type.String({ description: "Where this came from" })),
      ttl: Type.Optional(Type.Number({ description: "Time-to-live in milliseconds", minimum: 0 })),
      consolidateWith: Type.Optional(
        Type.Array(Type.String(), {
          description: "IDs of existing memories to merge into this one (consolidation/merge)",
        }),
      ),
      linkedMemories: Type.Optional(
        Type.Array(Type.String(), {
          description: "IDs of related memories to create bidirectional links with",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        content: string;
        memoryType: string;
        tags?: string[];
        importance?: number;
        source?: string;
        ttl?: number;
        consolidateWith?: string[];
        linkedMemories?: string[];
      },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<
      AgentToolResult<{ id?: string; stored: boolean; episodic_twin_failed?: boolean }>
    > => {
      recordMemoryToolCall(ctx, "memory_store");
      await initPromise;
      try {
        const related: Array<{
          id: string;
          type: "related" | "fixes" | "supersedes" | "example";
          auto: boolean;
        }> = [];
        if (params.linkedMemories) {
          for (const id of params.linkedMemories) {
            related.push({ id, type: "related", auto: false });
          }
        }

        // Consolidation: merge consolidateWith memories into new content, then delete originals
        let consolidatedContent = params.content;
        // Cap the merge markers and log the source IDs: unbounded per-source
        // marker text buries which memories were merged.
        const MAX_CONSOLIDATE_SOURCES = 10;
        const mergedSourceIds: string[] = [];
        if (params.consolidateWith && params.consolidateWith.length > 0) {
          for (const id of params.consolidateWith.slice(0, MAX_CONSOLIDATE_SOURCES)) {
            const existing = memory.getByIdSync(id);
            if (existing) {
              const sep = consolidatedContent.endsWith(".") ? " " : ". ";
              consolidatedContent += `${sep}[merged from: ${existing.content.slice(0, 500)}]`;
              mergedSourceIds.push(id);
              memory.deleteById(id);
            }
          }
          if (params.consolidateWith.length > MAX_CONSOLIDATE_SOURCES) {
            log.warn(
              `[memory-agent-bridge] consolidateWith capped to ${MAX_CONSOLIDATE_SOURCES} sources ` +
                `(${params.consolidateWith.length} requested). ` +
                `Excess sources were not merged.`,
            );
          }
        }

        // Derive projectId from ctx.cwd for provenance tracking,
        // enabling cross-project session isolation.
        const projectId =
          ctx && typeof ctx.cwd === "string" ? deriveProjectIdFromCwd(ctx.cwd) : undefined;

        const m = await memory.store(
          consolidatedContent,
          params.memoryType as CognitiveMemoryType,
          {
            tags: params.tags,
            importance: params.importance,
            source: params.source,
            ttl: params.ttl,
            related: related.length > 0 ? related : undefined,
            projectId,
          },
        );

        // Set when the write gate skips or rejects the episodic twin. The
        // semantic write above already succeeded, so this is a note, not a
        // failure — the agent's intent lives in the unified store either way.
        let episodicTwinNote: string | null = null;
        let twinFlushWarning: string | null = null;

        // When storing episodic type, also add to three-memory-stores
        if (params.memoryType === "episodic" && ctx) {
          let episodicTwinFailed: string | null = null;
          try {
            const threeMem = getExtensionState<MemoryStoresState>(
              ctx,
              "three-memory-stores",
              createMemoryStoresState,
            );
            const twinTask = consolidatedContent.slice(0, 300);
            const gate = applyWriteGateLogged(getMemoryWriteGateConfig(), {
              site: "memoryStoreTwin",
              task: twinTask,
              solution: consolidatedContent,
              recent: selectRecentEpisodes(threeMem.episodes, projectId),
            });
            if (gate.write) {
              addEpisode(
                threeMem,
                twinTask,
                gate.solution,
                "partial",
                [],
                params.tags ?? [],
                projectId,
              );
              // Disk-true tool result: land the append before reporting the
              // twin stored. A failed append is a note, not a failure — the
              // shutdown compaction retries the whole snapshot.
              try {
                await flushEpisodeAppends();
              } catch (flushErr) {
                twinFlushWarning = `Episodic twin append did not land on disk (${flushErr instanceof Error ? flushErr.message : String(flushErr)}); the shutdown compaction retries it.`;
                log.warn(`[memory-agent-bridge] episodic twin flush failed: ${twinFlushWarning}`);
              }
            } else {
              episodicTwinNote = describeWriteDecision(gate.decision);
              log.info(`[memory-agent-bridge] episodic twin ${episodicTwinNote}`);
            }
          } catch (err) {
            // Surface the failure: getExtensionState does not throw on a
            // missing state, so this catch is a real addEpisode error — report
            // it in the response so the caller can retry or investigate.
            episodicTwinFailed = err instanceof Error ? err.message : String(err);
            log.warn(
              `[memory-agent-bridge] episodic twin addEpisode failed: ${episodicTwinFailed}`,
            );
          }
          if (episodicTwinFailed) {
            return {
              content: [
                {
                  type: "text",
                  text: `Stored semantic memory ${m.id}, but episodic twin failed: ${episodicTwinFailed}. The unified memory is saved; the three-stores episode was NOT.`,
                },
              ],
              details: { id: m.id, stored: true, episodic_twin_failed: true },
            };
          }
        }

        // Check for cross-project content conflicts.
        // When the same insight exists from a different project, surface it
        // so the agent can decide whether the cross-project knowledge is
        // relevant or a memory-hallucination risk (HaluMem 2511.03506).
        const conflicts = memory.findCrossProjectConflicts(consolidatedContent, projectId);
        const conflictInfo =
          conflicts.length > 0
            ? conflicts.map(
                (c) =>
                  `[${c.conflict.projectId}] ${c.conflict.content.slice(0, 120)} (overlap: ${(c.overlap * 100).toFixed(0)}%)`,
              )
            : undefined;

        // Include merged source IDs in the response so
        // the user has visibility into the consolidation.
        const storedResponse: {
          content: Array<{ type: "text"; text: string }>;
          details: {
            id: string;
            stored: boolean;
            merged_from?: string[];
            projectId?: string;
            crossProjectConflicts?: string[];
          };
        } = {
          content: [
            { type: "text" as const, text: `Stored memory ${m.id} (${params.memoryType})` },
          ],
          details: { id: m.id, stored: true, projectId },
        };
        if (episodicTwinNote) {
          storedResponse.content[0]!.text += `\nEpisodic twin not written: ${episodicTwinNote}`;
        }
        if (twinFlushWarning) {
          storedResponse.content[0]!.text += `\n${twinFlushWarning}`;
        }
        if (mergedSourceIds.length > 0) {
          storedResponse.details.merged_from = mergedSourceIds;
          storedResponse.content[0]!.text += ` (merged from ${mergedSourceIds.length} source(s))`;
        }
        if (conflictInfo && conflictInfo.length > 0) {
          storedResponse.details.crossProjectConflicts = conflictInfo;
          storedResponse.content[0]!.text +=
            `\n⚠ Cross-project conflict: Similar memory exists from ${conflictInfo.length} other project(s):\n` +
            conflictInfo.map((c: string) => `  - ${c}`).join("\n");
        }
        return storedResponse;
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Skipped: ${e instanceof Error ? e.message : "Unknown error"}`,
            },
          ],
          details: { stored: false },
        };
      }
    },
  };
}
