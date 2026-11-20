/**
 * Standing preferences, one section per surface this session can reach.
 *
 * The section exists because a rule that must fire at a specific moment cannot
 * be retrieved by association. Retrieval scores a rule's text against the text
 * arriving now, so a rule about button labels fires only when an incoming
 * message happens to resemble it, and a rule about the reply's language fires
 * only when the incoming message happens to resemble that. Both of those are
 * false negatives with no signal: the rule is in the store, the store was read,
 * and the prompt still does not carry it.
 *
 * So presence is not scored. A surface is in play when the tool set says so -
 * the session's enabled tools are a fact, while "the conversation looks like it
 * is about buttons" is an inference - and a rule filed for a surface that is not
 * in play is not rendered at all. The one exception is the reply surface, which
 * is in play whenever a turn is, which is exactly when this prompt is built: no
 * tool can prove it and none is asked for.
 *
 * A rule bound to nothing is not hidden. It renders in one short block labelled
 * unbound, because that is the honest state of a rule nothing can fire, and a
 * silently dropped rule is the failure this whole instrument exists to remove.
 *
 * Rendering only. The store is read, never written, and the refusals live in the
 * checker: a build that merely renders cannot lose the guarantee that the store
 * and its rendered projection agree.
 */
import type { PromptSection } from "./section.js";
import { linesSection } from "./section.js";
import { createLogger } from "../../../lib/core/logger.js";
import {
  readPreferences,
  type PreferenceEntry,
  type PreferencesRead,
} from "../../../lib/preferences/store.js";

const log = createLogger("prompt-builder/preferences");

/**
 * What a surface needs for the rule to apply.
 *
 * `tools` names the tools that carry the surface: any one of them being enabled
 * is the whole test. `null` marks a surface that is in play without a tool, and
 * there is exactly one such surface, because the prompt is only ever built for a
 * turn that is about to happen.
 */
export interface SurfaceBinding {
  /** The value a store entry writes in `surface`. */
  readonly surface: string;
  /** How the surface reads in the prompt. */
  readonly label: string;
  readonly tools: readonly string[] | null;
}

/**
 * The closed vocabulary of surfaces. A store entry naming anything else is
 * reported rather than rendered: an unknown surface is a rule whose gate this
 * build cannot evaluate, and guessing would put it in front of the model at
 * moments nobody chose.
 */
export const SURFACE_BINDINGS: readonly SurfaceBinding[] = [
  {
    surface: "telegram",
    label: "the Telegram channel",
    tools: ["telegram_send"],
  },
  {
    surface: "reply",
    label: "every reply",
    tools: null,
  },
];

/**
 * Section-name prefix. One section per surface rather than one for the file: the
 * prompt is a cached prefix, so a change to one surface's rules re-sends that
 * block alone.
 */
export const PREFERENCES_SECTION_PREFIX = "preferences-";

/** What the composition did, for the caller that wants to report it. */
export interface PreferencesReport {
  /** Rules rendered, per surface, in prompt order. */
  readonly rendered: ReadonlyArray<{ readonly surface: string; readonly count: number }>;
  /** Rules rendered in the unbound block. */
  readonly unbound: number;
  /** Surfaces a rule names that this build has no binding for, in store order. */
  readonly unknownSurfaces: readonly string[];
  /** Entries the store reader could not use. */
  readonly rejected: number;
  /** Why the store could not be read at all, or null. */
  readonly storeError: string | null;
}

/** The sections plus what they came from. */
export interface PreferenceSections {
  readonly sections: PromptSection[];
  readonly report: PreferencesReport;
}

/** One rule as one prompt line; the store's own wording, flattened to a line. */
function ruleLine(entry: PreferenceEntry): string {
  const rule = entry.rule.replace(/\s+/g, " ").trim();
  if (!entry.examples || entry.examples.length === 0) return `- ${rule}`;
  const examples = entry.examples.map((example) => `"${example}"`).join(", ");
  return `- ${rule} (e.g. ${examples})`;
}

/** The line that opens a surface's block, naming the surface it governs. */
function surfaceHeader(label: string): string {
  return `Standing owner preferences for ${label} (in force; follow them every time):`;
}

/** The line that opens the unbound block, and says what the state means. */
const UNBOUND_HEADER = "Unbound preferences (no surface; nothing fires them until one is named):";

function isPresent(binding: SurfaceBinding, toolNames: readonly string[]): boolean {
  if (binding.tools === null) return true;
  return binding.tools.some((tool) => toolNames.includes(tool));
}

/**
 * Compose the sections for one store read and one tool set. Pure, so the gate
 * over it is a fixture rather than a story: no disk, no clock, no session.
 */
export function preferenceSectionsFrom(
  read: PreferencesRead,
  toolNames: readonly string[],
): PreferenceSections {
  if (!read.ok) {
    return {
      sections: [],
      report: {
        rendered: [],
        unbound: 0,
        unknownSurfaces: [],
        rejected: 0,
        storeError: read.error,
      },
    };
  }

  const bySurface = new Map<string, PreferenceEntry[]>();
  const unbound: PreferenceEntry[] = [];
  const unknownSurfaces: string[] = [];
  for (const entry of read.entries) {
    const surface = (entry.surface ?? "").trim();
    if (surface === "") {
      unbound.push(entry);
      continue;
    }
    const binding = SURFACE_BINDINGS.find((candidate) => candidate.surface === surface);
    if (binding === undefined) {
      if (!unknownSurfaces.includes(surface)) unknownSurfaces.push(surface);
      continue;
    }
    const bucket = bySurface.get(binding.surface);
    if (bucket === undefined) bySurface.set(binding.surface, [entry]);
    else bucket.push(entry);
  }

  const sections: PromptSection[] = [];
  const rendered: Array<{ surface: string; count: number }> = [];
  for (const binding of SURFACE_BINDINGS) {
    const rules = bySurface.get(binding.surface);
    if (rules === undefined || rules.length === 0) continue;
    if (!isPresent(binding, toolNames)) continue;
    sections.push(
      linesSection(`${PREFERENCES_SECTION_PREFIX}${binding.surface}`, [
        surfaceHeader(binding.label),
        ...rules.map(ruleLine),
      ]),
    );
    rendered.push({ surface: binding.surface, count: rules.length });
  }

  if (unbound.length > 0) {
    sections.push(
      linesSection(`${PREFERENCES_SECTION_PREFIX}unbound`, [
        UNBOUND_HEADER,
        ...unbound.map(ruleLine),
      ]),
    );
  }

  return {
    sections,
    report: {
      rendered,
      unbound: unbound.length,
      unknownSurfaces,
      rejected: read.rejected.length,
      storeError: null,
    },
  };
}

/**
 * A defect in the store is reported once per process. The prompt is rebuilt on
 * every turn, so a warning per turn would be the same line repeated until the
 * author stopped reading it.
 */
const reported = new Set<string>();

function reportOnce(key: string, text: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  log.warn(text);
}

/**
 * Compose from the live store. A caller that already read the store passes it in
 * so a turn reads the file once.
 */
export function preferenceSections(
  toolNames: readonly string[],
  read: PreferencesRead = readPreferences(),
): PreferenceSections {
  const composed = preferenceSectionsFrom(read, toolNames);
  const { report } = composed;
  if (report.storeError !== null) {
    reportOnce(
      `store:${read.path}:${report.storeError}`,
      `preferences: store at ${read.path} ${report.storeError}; no preference rendered`,
    );
  }
  if (report.rejected > 0) {
    reportOnce(
      `rejected:${read.path}:${report.rejected}`,
      `preferences: ${report.rejected} entr${report.rejected === 1 ? "y" : "ies"} in ${read.path} could not be read; run the preference gate for the reasons`,
    );
  }
  if (report.unknownSurfaces.length > 0) {
    reportOnce(
      `surface:${read.path}:${report.unknownSurfaces.join(",")}`,
      `preferences: ${read.path} files rules under unknown surfaces (${report.unknownSurfaces.join(", ")}); they are not rendered`,
    );
  }
  return composed;
}
