import { createLogger } from "../../../lib/logger.js";

const log = createLogger("assistant");
/**
 * Assistant Extension - Tool management.
 *
 * /tools: interactive tool enable/disable
 * /tool-status: show current configuration
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@mariozechner/pi-tui";
import { loadState, saveState } from "../../../lib/async-storage.js";

const TOOLS_CONFIG_TYPE = "tools-config";

/** Path to disk-persisted tools config - survives pi restarts */
const TOOLS_DISK_PATH = path.join(os.homedir(), ".pi", "agent", "tools-config.json");

interface ToolsConfigData {
  enabledTools: string[];
  version: number;
}

export default function assistantExtension(pi: ExtensionAPI) {
  // ── /tools Command ─────────────────────────────────────────────────
  // Interactive tool enable/disable with fuzzy search and scrollable list.
  // State persisted to session so it survives reloads and branch navigation.
  let toolEnabled: Set<string> = new Set();
  let toolList: ToolInfo[] = [];
  let configVersion = 0;

  const persistToolState = () => {
    configVersion++;
    // Persist to session (for branch navigation)
    pi.appendEntry<ToolsConfigData>(TOOLS_CONFIG_TYPE, {
      enabledTools: Array.from(toolEnabled),
      version: configVersion,
    });
    // Persist to disk (survives pi restarts)
    saveState(TOOLS_DISK_PATH, {
      enabledTools: Array.from(toolEnabled),
      version: configVersion,
    });
  };

  const applyToolState = () => {
    pi.setActiveTools(Array.from(toolEnabled));
  };

  const restoreToolState = async (ctx: ExtensionContext) => {
    toolList = pi.getAllTools();

    // Priority 1: Load from disk (survives pi restarts)
    let diskData: ToolsConfigData | null = null;
    try {
      diskData = await loadState<ToolsConfigData>(TOOLS_DISK_PATH);
    } catch {
      // Non-fatal - fallback to session entries
      /* Non-fatal: restoreToolState disk read failed */
    }

    if (diskData?.enabledTools && typeof diskData.version === "number") {
      const names = toolList.map((t) => t.name);
      toolEnabled = new Set(diskData.enabledTools.filter((t) => names.includes(t)));
      // Always enable newly registered tools not in saved config
      for (const name of names) {
        if (!diskData.enabledTools.includes(name)) {
          toolEnabled.add(name);
        }
      }
      configVersion = diskData.version;
      applyToolState();
      return;
    }

    // Priority 2: Find latest config in session entries (for branch navigation)
    let maxVersion = -1;
    let saved: string[] | undefined;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as { customType?: string }).customType === TOOLS_CONFIG_TYPE
      ) {
        const data = (entry as { data?: ToolsConfigData }).data;
        if (data?.enabledTools && typeof data.version === "number") {
          if (data.version > maxVersion) {
            maxVersion = data.version;
            saved = data.enabledTools;
          }
        }
      }
    }

    if (saved) {
      const names = toolList.map((t) => t.name);
      toolEnabled = new Set(saved.filter((t) => names.includes(t)));
      // Always enable newly registered tools not in saved config
      for (const name of names) {
        if (!saved.includes(name)) {
          toolEnabled.add(name);
        }
      }
      configVersion = maxVersion;
    } else {
      // Fallback: auto-enable extension tools + current active tools.
      // This ensures extension tools (think, finalize, memory_*, etc.)
      // are enabled by default even without saved config.
      const activeTools = pi.getActiveTools();
      const allTools = pi.getAllTools();
      const extensionToolNames = allTools.map((t) => t.name);
      toolEnabled = new Set([...activeTools, ...extensionToolNames]);
      configVersion = 0;
    }
    applyToolState();
  };

  pi.on("session_start", async (_event, ctx) => restoreToolState(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreToolState(ctx));

  pi.registerCommand("tools", {
    description: "Enable/disable tools with fuzzy search",
    handler: async (_args, ctx) => {
      toolList = pi.getAllTools();

      // Build settings items for each tool (SettingsList handles its own search)
      const buildItems = (): SettingItem[] =>
        toolList.map((tool) => ({
          id: tool.name,
          label: tool.name,
          currentValue: toolEnabled.has(tool.name) ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        }));

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();

        // Title header
        container.addChild(
          new (class {
            render(_width: number) {
              return [theme.fg("accent", theme.bold("Tool Configuration"))];
            }
            invalidate() {}
          })(),
        );

        const settingsList = new SettingsList(
          buildItems(),
          Math.min(toolList.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            // Toggle tool on value change
            if (newValue === "enabled") {
              toolEnabled.add(id);
            } else {
              toolEnabled.delete(id);
            }
            applyToolState();
            persistToolState();
          },
          () => {
            // Close dialog
            done(undefined);
          },
          { enableSearch: true },
        );

        container.addChild(settingsList);

        // Return proper component interface - must delegate handleInput to SettingsList
        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            // CRITICAL: SettingsList only receives input when handleInput is called
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.registerCommand("tool-status", {
    description: "Show current tool configuration",
    handler: async (_args, ctx) => {
      toolList = pi.getAllTools();
      const enabled = Array.from(toolEnabled);
      const disabled = toolList.map((t) => t.name).filter((n) => !enabled.includes(n));
      ctx.ui.notify(
        enabled.length +
          " enabled, " +
          disabled.length +
          " disabled (version " +
          configVersion +
          ")",
        "info",
      );
    },
  });
}
