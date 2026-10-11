/**
 * EXTERNAL_TOOL_GUIDELINES — last-resort map for UNOWNED third-party tools.
 *
 * Dependency-inversion rule: a tool's guideline
 * is declared by its OWNING package via `pi.registerTool({ ..., promptGuidelines })`
 * — never hardcoded in braid-core. This map is the DOCUMENTED EXCEPTION for
 * third-party packages we cannot patch (their code ships in node_modules and
 * their registrations are owned by others). When such a package later
 * self-registers promptGuidelines, its line automatically wins (render
 * priority 1 beats this map) and the entry can be deleted here.
 *
 * Same style contract as TOOL_GUIDELINES: strategy only (when / when-not /
 * key args / caveat), no restatement of the description, no `|`, no newlines.
 *
 * The registered tool DESCRIPTIONS of herdr_* are trimmed
 * to 1-2 lines at the provider-payload layer (tool-description-trim.ts,
 * before_provider_request) and the deep topology guidance lives in the
 * herdr-topology SKILL (progressive disclosure). This map keeps its
 * render-fallback role (priority 3) — still load-bearing if pi-herdr ever
 * stops self-registering promptGuidelines.
 */
export const EXTERNAL_TOOL_GUIDELINES: Record<string, string> = {
  // @ogulcancelik/pi-herdr (npm extension) — pane/agent topology control.
  // One-line purpose + the when-not gate (user must explicitly
  // mention Herdr); subagent-lifecycle procedure lives in the
  // subagent-orchestration SKILL.md, not here. The when-gate clause
  // is VERBATIM-LOCKED (brief contract — do not reword).
  herdr_layout:
    "when: create/inspect Herdr workspaces/tabs/panes (only when the user explicitly mentions Herdr); caveat: layout only, never starts agents or commands",
  herdr_pane:
    "when: run/read shells, tests, servers, or logs in a pane (only when the user explicitly mentions Herdr); when-not: recognized coding agents (herdr_agent)",
  herdr_agent:
    "when: manage a recognized coding agent in an existing Herdr pane (only when the user explicitly mentions Herdr); caveat: target is a live agent name or the hosting pane ID",

  // fetch_content (pi-web-access npm extension) — URL fetching: readable
  // markdown (default), raw exact body, or an answer to a prompt. One
  // strategy row; per-call auth/proxy and video/GitHub specifics ride the
  // registered description.
  fetch_content:
    "when: fetch URL(s) as readable markdown (default), raw exact body, or a prompt-answered extraction; when-not: JS-driven interactive flows (browser_*); args: url/urls + mode + prompt for answer/video; caveat: forceClone for oversized GitHub repos",
};
