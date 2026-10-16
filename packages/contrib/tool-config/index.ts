import { createLogger } from "../logger.js";
import { readToggleVerdict } from "../module-toggle.js";
import {
  registerSessionStartHandler,
  SessionPhase,
  readGlobalEnabledTools,
  readSettingsFileOutcome,
  writeGlobalEnabledTools,
  type SettingsWriteOutcome,
} from "pi-braid/lib";

const log = createLogger("assistant");

/**
 * Tools this extension never applies an active set without.
 *
 * braid registers its cold tools with `exposure: "deferred"`, so pi declares
 * them to the model only after `tool_search` finds them, and pi registers
 * `tool_search` inactive. The saved list has to name it: this restore replaces
 * the active set after the context-management guard activated the tool at
 * session start, and a list without it turns every deferred tool dark for the
 * rest of the session. Preference stays the operator's - the union is in the
 * apply, not in what `/tools` writes back.
 */
const ALWAYS_ACTIVE = ["tool_search"];
/**
 * Assistant Extension - Tool management.
 *
 * /tools: interactive tool enable/disable
 * /tool-status: show current configuration
 *
 * Persistence: the cross-extension tool list now lives in
 * `~/.pi/agent/settings.json` under `braid.contrib._global.enabled: [...]`
 * (R9 — single source of truth for both extension-level and tool-level
 * disable configuration). Replaces the older dual storage at
 * `~/.pi/braid/tools-config.json` and as a session entry.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";

export default function assistantExtension(pi: ExtensionAPI) {
  const toggle = readToggleVerdict(["toolConfig"]);
  if (toggle.disabled) {
    log.info(
      `[tool-config] disabled via settings (braid.contrib.${toggle.key}: false).`,
    );
    return;
  }

  // Interactive tool enable/disable with fuzzy search and scrollable list.
  // State persisted to session so it survives reloads and branch navigation.
  let toolEnabled: Set<string> = new Set();
  let toolList: ToolInfo[] = [];
  let configVersion = 0;
  // An unreadable settings.json reads as defaults; report it once per runtime
  // rather than on every restore (session_tree restores too).
  let warnedUnreadableSettings = false;

  const settingsWriteMessage = (
    result: Extract<SettingsWriteOutcome, { ok: false }>,
  ): string => {
    if (result.reason === "existing-file-invalid") {
      return (
        `Tool settings not saved: ${result.path} is unreadable or not valid JSON, ` +
        "so it was left unchanged. Fix or remove that file, then toggle again."
      );
    }
    return `Tool settings not saved: could not write ${result.path}. The file was left unchanged.`;
  };

  const persistToolState = (ctx: ExtensionContext) => {
    configVersion++;
    // Single source of truth: ~/.pi/agent/settings.json under
    // braid.contrib._global.enabled — no second storage.
    //
    // The write reports failure as a value; this callback runs inside the TUI
    // input dispatch, where a throw escapes as an uncaught exception and exits
    // pi. Keep the in-memory toggle and tell the user the file was not saved.
    const result = writeGlobalEnabledTools(Array.from(toolEnabled));
    if (!result.ok) {
      log.warn("tool settings were not saved", {
        reason: result.reason,
        path: result.path,
        error: result.error.message,
      });
      ctx.ui.notify(settingsWriteMessage(result), "error");
    }
  };

  const applyToolState = () => {
    // The saved list is the operator's preference, not the whole active set:
    // ALWAYS_ACTIVE rides on top of it, so a restore can never drop the tool
    // braid's deferred tools are found with. pi ignores names the registry
    // does not hold, so an install without that extension is unaffected.
    pi.setActiveTools(Array.from(new Set([...toolEnabled, ...ALWAYS_ACTIVE])));
  };

  const restoreToolState = async (ctx: ExtensionContext) => {
    toolList = pi.getAllTools();
    const names = toolList.map((t) => t.name);

    // Read from the unified settings.json (single source of truth). An
    // unparseable file reads as defaults, indistinguishable from "nothing
    // saved" unless we look; surface it instead of silently dropping the
    // operator's saved choices.
    const read = readSettingsFileOutcome();
    if (read.state === "invalid" && !warnedUnreadableSettings) {
      warnedUnreadableSettings = true;
      log.warn(
        "settings.json is unreadable or invalid; using default tool configuration",
        {
          path: read.path,
          error: read.error.message,
        },
      );
      ctx.ui.notify(
        `Tool settings: ${read.path} is unreadable or not valid JSON, so saved tool ` +
          "choices were ignored and this session keeps its default tool set.",
        "error",
      );
    }

    const saved = readGlobalEnabledTools();
    if (saved && Array.isArray(saved)) {
      // The saved list IS the operator's tool set. A tool it does not name
      // stays off, whether it was turned off in /tools or registered later.
      // Completing the list with every unlisted registry name would re-enable
      // exactly the tools the operator disabled and would override the curated
      // default profile.
      toolEnabled = new Set(saved.filter((t) => names.includes(t)));
      configVersion = 1;
    } else {
      // No saved choice: keep the active set pi-core and the tool-profile
      // mechanism decided. Enabling every registered tool here overwrote the
      // default profile on every session start.
      toolEnabled = new Set(pi.getActiveTools());
      configVersion = 0;
    }
    applyToolState();
  };

  registerSessionStartHandler(pi, SessionPhase.CoreInit, async (_event, ctx) =>
    restoreToolState(ctx),
  );
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
            if (newValue === "enabled") {
              toolEnabled.add(id);
            } else {
              toolEnabled.delete(id);
            }
            applyToolState();
            persistToolState(ctx);
          },
          () => {
            done(undefined);
          },
          { enableSearch: true },
        );

        container.addChild(settingsList);

        // The component interface must delegate handleInput to SettingsList.
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
      const disabled = toolList
        .map((t) => t.name)
        .filter((n) => !enabled.includes(n));
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
