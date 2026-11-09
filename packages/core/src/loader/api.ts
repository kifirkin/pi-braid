/**
 * Subagent API for extension toggling.
 *
 * One command, `/modules`, with a verb as its first argument:
 *
 *   /modules                  - TUI: open the extension list; RPC: print its rows as text
 *   /modules on <ref>         - Enable an extension or module group
 *   /modules off <ref>        - Disable an extension or module group
 *   /modules toggle <ref>     - Flip the effective state
 *   /modules all on|off       - Apply to every extension in the manifest
 *   /modules reset            - Clear in-process overrides (persisted state stays)
 *   /modules list             - Print the rows as text in every mode
 *
 * Reference targets are extension IDs (e.g. "enforcement") or module group
 * names (e.g. "memory", which expands to every extension in the group). A
 * reference the resolver does not know is refused with the offending text
 * alone; argument completion and `list` are the places that enumerate what is
 * accepted.
 *
 * The six command names this file used to register remain as forwarding
 * aliases for one release: modules-enable, modules-disable, modules-toggle,
 * modules-reset, modules-list, modules-status. Each maps its whole argument
 * onto the equivalent argv, so a script written against the old names keeps
 * working until it is pointed at `/modules`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type AutocompleteItem,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";

import { createLogger } from "../lib/core/logger.js";
import {
  getModuleStates,
  getModuleRefs,
  resetModuleOverrides,
  setModuleEnabled,
  toggleModule,
  type ModuleOrigin,
} from "./loader.js";

const log = createLogger("modules-api");

/** One extension as both the TUI list and the text rows present it. */
interface ModuleRow {
  id: string;
  description: string;
  value: "on" | "off";
  values: ["on", "off"];
}

/** The verb table, shared by the handler's usage lines and completion. */
const VERBS: Record<string, string> = {
  on: "Enable an extension or module group",
  off: "Disable an extension or module group",
  toggle: "Flip the effective state",
  all: "Apply on or off to every extension",
  reset: "Clear in-process overrides (persisted state stays)",
  list: "Print every extension as text",
};

const USAGE =
  "Usage: /modules [on|off|toggle|reset|all|list] <ref>\n" +
  "A ref is an extension id or a module group name. Tab completes both.";

export default async function modulesApiExtension(pi: ExtensionAPI): Promise<void> {
  const run = async (argv: string[], ctx: ExtensionCommandContext): Promise<void> => {
    const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
      ctx.ui.notify?.(message, type);
    };
    const verb = (argv[0] ?? "").toLowerCase();

    if (argv.length === 0) {
      if (ctx.mode === "tui") {
        await openModuleList(ctx);
      } else {
        notify(renderRows(), "info");
      }
      return;
    }

    switch (verb) {
      case "list": {
        notify(renderRows(), "info");
        return;
      }
      case "on":
      case "off": {
        const ref = argv[1]?.trim().toLowerCase();
        if (!ref) {
          notify(`Usage: /modules ${verb} <ref>\n${USAGE}`, "warning");
          return;
        }
        const on = verb === "on";
        if (!setModuleEnabled(ref, on)) {
          notify(refusal(ref, verb), "error");
          return;
        }
        notify(`"${ref}" ${on ? "enabled" : "disabled"} (applies at the next start).`, "info");
        return;
      }
      case "toggle": {
        const ref = argv[1]?.trim().toLowerCase();
        if (!ref) {
          notify(`Usage: /modules toggle <ref>\n${USAGE}`, "warning");
          return;
        }
        const before = getModuleStates();
        const state = toggleModule(ref, ctx);
        if (state === null) {
          notify(refusal(ref, "toggle"), "error");
          return;
        }
        const after = getModuleStates();
        const changed = Object.keys(after).some((id) => before[id].enabled !== after[id].enabled);
        if (!changed) {
          notify(`"${ref}" is always on and cannot be changed.`, "error");
          return;
        }
        notify(`"${ref}" toggled ${state ? "ON" : "OFF"} (applies at the next start).`, "info");
        return;
      }
      case "all": {
        const mode = argv[1]?.trim().toLowerCase();
        if (mode !== "on" && mode !== "off") {
          notify("Usage: /modules all <on|off>", "warning");
          return;
        }
        const on = mode === "on";
        let applied = 0;
        let refused = 0;
        for (const id of Object.keys(getModuleStates())) {
          if (setModuleEnabled(id, on)) applied++;
          else refused++;
        }
        notify(
          `"${on ? "on" : "off"}" applied to ${applied} extension(s)` +
            (refused > 0
              ? `; ${refused} always-on extension(s) cannot be disabled.`
              : " (applies at the next start)."),
          refused > 0 ? "warning" : "info",
        );
        return;
      }
      case "reset": {
        resetModuleOverrides(ctx);
        notify(
          "Runtime overrides reset. Persisted braid.modules entries (if any) still apply.",
          "info",
        );
        return;
      }
      default: {
        notify(`Unknown verb "${verb}".\n${USAGE}`, "warning");
      }
    }
  };

  pi.registerCommand("modules", {
    description:
      "Enable or disable extensions. No argument opens the list (text in RPC mode). " +
      "Usage: /modules on|off|toggle <ref>, /modules all on|off, /modules reset, /modules list",
    getArgumentCompletions: completeModules,
    handler: (args, ctx) => run(splitArgs(args), ctx),
  });

  pi.registerCommand("modules-enable", {
    description: "Alias of /modules on <ref>. Retained for one release.",
    getArgumentCompletions: completeRefs("on"),
    handler: (args, ctx) => run([...forwarded("on", args)], ctx),
  });
  pi.registerCommand("modules-disable", {
    description: "Alias of /modules off <ref>. Retained for one release.",
    getArgumentCompletions: completeRefs("off"),
    handler: (args, ctx) => run([...forwarded("off", args)], ctx),
  });
  pi.registerCommand("modules-toggle", {
    description: "Alias of /modules toggle <ref>. Retained for one release.",
    getArgumentCompletions: completeRefs("toggle"),
    handler: (args, ctx) => run([...forwarded("toggle", args)], ctx),
  });
  pi.registerCommand("modules-reset", {
    description: "Alias of /modules reset. Retained for one release.",
    handler: async (_args, ctx) => run(["reset"], ctx),
  });
  pi.registerCommand("modules-list", {
    description: "Alias of /modules list. Retained for one release.",
    handler: async (_args, ctx) => run(["list"], ctx),
  });
  pi.registerCommand("modules-status", {
    description: "Alias of /modules list. Retained for one release.",
    handler: async (_args, ctx) => run(["list"], ctx),
  });

  log.info("Module API registered: /modules (+ six forwarding aliases)");
}

// ── Argument parsing ────────────────────────────────────────────────────────

/** Split a command's argument string into argv; quoted runs stay one token. */
function splitArgs(args: string | undefined): string[] {
  const text = (args ?? "").trim();
  if (!text) return [];
  const argv: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    argv.push(match[1] ?? match[2] ?? match[3]);
  }
  return argv;
}

/** The argv an old name forwards: its whole argument is the ref. */
function forwarded(verb: string, args: string | undefined): string[] {
  return [verb, (args ?? "").trim()];
}

/** Why a reference was refused, naming the rule instead of listing refs. */
function refusal(ref: string, verb: string): string {
  if (!getModuleRefs().includes(ref)) {
    return (
      `Unknown reference "${ref}". Tab completes extension ids and module groups; ` +
      "/modules list shows every extension."
    );
  }
  if (verb === "off") return `Cannot disable "${ref}": every extension it names is always on.`;
  return `Nothing to ${verb} for "${ref}".`;
}

// ── Completion ──────────────────────────────────────────────────────────────

/** Complete the first token with verbs, later tokens with references. */
function completeModules(prefix: string): AutocompleteItem[] | null {
  const text = prefix ?? "";
  const space = text.indexOf(" ");
  if (space === -1) {
    const typed = text.toLowerCase();
    return Object.entries(VERBS)
      .filter(([verb]) => verb.startsWith(typed))
      .map(([verb, description]) => ({ value: verb, label: verb, description }));
  }
  const verb = text.slice(0, space).toLowerCase();
  const tail = text.slice(space + 1);
  if (verb === "all") return completeValues(tail, ["on", "off"]);
  if (verb === "on" || verb === "off" || verb === "toggle") {
    const typed = tail.toLowerCase();
    return getModuleRefs()
      .filter((ref) => ref.startsWith(typed))
      .map((ref) => ({ value: `${verb} ${ref}`, label: ref }));
  }
  return null;
}

/** Completion for an old name: the whole argument text is the reference. */
function completeRefs(verb: string) {
  return (prefix: string): AutocompleteItem[] | null => {
    const typed = (prefix ?? "").toLowerCase();
    return getModuleRefs()
      .filter((ref) => ref.startsWith(typed))
      .map((ref) => ({ value: ref, label: ref, description: `Forwarded to /modules ${verb}` }));
  };
}

function completeValues(prefix: string, values: string[]): AutocompleteItem[] {
  const typed = (prefix ?? "").toLowerCase();
  return values
    .filter((value) => value.startsWith(typed))
    .map((value) => ({ value, label: value }));
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** Every extension as one row, plus the config source that resolved them. */
function moduleRows(): { rows: ModuleRow[]; source: string } {
  const states = getModuleStates();
  const rows = Object.entries(states).map(([id, info]) => ({
    id,
    description: describe(info.desc, info.origin, info.enabled, info.loaded),
    value: (info.enabled ? "on" : "off") as ModuleRow["value"],
    values: ["on", "off"] as ModuleRow["values"],
  }));
  return { rows, source: Object.values(states)[0]?.source ?? "?" };
}

/** The one description both surfaces show: what it does, where its state came
 *  from, and whether a restart is still owed. */
function describe(desc: string, origin: ModuleOrigin, enabled: boolean, loaded: boolean): string {
  const tail = enabled === loaded ? origin : `${origin}; restart to apply`;
  return `${desc} (${tail})`;
}

/** The rows as text, for RPC mode and the `list` verb. */
function renderRows(): string {
  const { rows, source } = moduleRows();
  const lines = [`Extensions (${rows.length}, config: ${source}):`];
  const width = Math.min(28, Math.max(...rows.map((row) => row.id.length)));
  for (const row of rows) {
    lines.push(`  ${row.value.padEnd(3)} ${row.id.padEnd(width)}  ${row.description}`);
  }
  lines.push("");
  lines.push(
    "Toggle: /modules toggle <ref>   Enable: /modules on <ref>   Disable: /modules off <ref>",
  );
  lines.push("Reset: /modules reset            All: /modules all on|off");
  return lines.join("\n");
}

// ── TUI ─────────────────────────────────────────────────────────────────────

/** The TUI list: one toggle per extension, written through the same resolver
 *  the verbs use. */
async function openModuleList(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new (class {
        render(_width: number) {
          return [theme.fg("accent", theme.bold("Extensions"))];
        }
        invalidate() {}
      })(),
    );

    const rows = moduleRows().rows;
    const items: SettingItem[] = rows.map((row) => ({
      id: row.id,
      label: row.id,
      description: row.description,
      currentValue: row.value,
      values: [...row.values],
    }));

    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 18),
      getSettingsListTheme(),
      (id, newValue) => {
        const on = newValue === "on";
        if (!setModuleEnabled(id, on)) {
          // The list already flipped its own value; put it back so the row
          // never claims a state the resolver refused.
          list.updateValue(id, "on");
          ctx.ui.notify?.(`"${id}" is always on and cannot be disabled.`, "error");
          tui.requestRender();
          return;
        }
        const info = getModuleStates()[id];
        const item = items.find((candidate) => candidate.id === id);
        if (info && item) item.description = describe(info.desc, info.origin, on, info.loaded);
        tui.requestRender();
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
      handleMouse(event: Parameters<SettingsList["handleMouse"]>[0]) {
        const result = list.handleMouse?.(event);
        tui.requestRender();
        return result;
      },
    };
  });
}
