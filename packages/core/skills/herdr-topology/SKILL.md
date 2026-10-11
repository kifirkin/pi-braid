---
name: herdr-topology
description: "Deep topology guidance for driving Herdr terminal panes and coding agents through the herdr_layout, herdr_pane, and herdr_agent tools: the workspace/tab/pane model, opaque ID handling, read sources and output recovery, agent lifecycle states, and orchestrator field procedures (fresh-restart over nudge-resume, staged-prompt verification, pane hygiene). Load when actually controlling Herdr, not on first mention."
triggers:
  - "driving herdr panes or agents"
  - "herdr_layout / herdr_pane / herdr_agent in use"
  - "multi-pane worker coordination"
validated: 2026-09-07
verdict: KEEP
---

# Herdr Topology

Progressive-disclosure companion to the Herdr tools. The tool descriptors
carry one line each; this file carries the deep form. Herdr itself is used
**only when the user explicitly mentions Herdr** - if you are reading this,
that gate has already been satisfied.

## The containment model

Workspaces contain tabs; tabs contain panes. Herdr recognizes coding agents
occupying panes and exposes them by name.

- Creating a workspace or tab also creates its root pane; splitting an
  existing pane creates another pane. There is no "create empty container".
- Layout actions (`herdr_layout`) never start an agent or an ordinary
  command - they only shape and inspect topology.
- A pane exists whether or not an agent occupies it. `herdr_agent start`
  requires an existing, available shell pane and never creates, splits, or
  moves layout.

## IDs are opaque: read, never construct

Identifiers (`w1`, `w1:t1`, `w1:p1` shapes) are opaque stable handles. Read
them from tool results:

- `workspace_create` returns the workspace, its tab, and the root pane.
- `tab_create` returns the tab and the root pane.
- `pane_split` returns the new pane.

Never predict or reuse IDs from earlier outputs after a move or close:
closed IDs are not reused, and a pane moved into another workspace gets a
new workspace-qualified ID. Closed panes and tabs should be treated as gone.

## Caller context and focus

Creation defaults to the caller's current working directory and preserves
the UI focus. `pane_split` defaults to the caller's pane and picks right or
down from its geometry - split a wide pane right, a narrow or tall pane
down, and avoid repeated same-direction splits that produce unusably narrow
columns or short rows.

Keep the user's focus where it is unless they asked to switch context. Do
not close workspaces, tabs, panes, or sessions you did not create unless
the user explicitly asks.

## Panes: raw terminal control

`herdr_pane` targets opaque pane IDs and deliberately does not validate
agent identity or interpret agent lifecycle. Use it for shells, tests,
servers, builds, logs, and other ordinary processes.

- `run` submits a command atomically with Enter; `send_text` types literal
  text without pressing Enter; `send_keys` writes logical terminal keys
  (`esc`, `enter`, `ctrl+c`, ...).
- `send_text`, `send_keys`, and `run` exit clean with empty CLI stdout, while
  the tool wrapper demands JSON on every call: a succeeded action can surface
  as the false error `Expected JSON output from herdr pane send-text ...`.
  Treat that error as indeterminate - read the pane and confirm what actually
  landed before any recovery send.
- `wait_output` searches the selected snapshot immediately - output that
  already exists can match without waiting. Use a literal `match` or a Rust
  `regex`; omit `timeout` for an indefinite wait.
- Read sources: `visible` (rendered viewport), `recent` (rendered output
  with soft wraps), `recent-unwrapped` (soft wraps joined - prefer for logs
  and transcripts), `detection` (bottom-buffer snapshot used for agent
  detection). Use `format: ansi` only when styling is evidence.
- Reads are truncated (about 2000 lines / 50KB). Increasing `--lines` cannot
  recover alternate-screen content (full-screen UIs); if a completed
  response is not in scrollback, ask the process to write its full output to
  a file in a temp directory and read that file instead.
- `--lines` is unreliable on recent and recent-unwrapped reads: the CLI can
  return an empty snapshot with a clean exit even when scrollback holds the
  content (visible reads with `--lines` return normally). Omit `--lines` for
  recent sources or switch to `--source visible`; `wait_output` with
  `--lines` can likewise miss matches the same command without it finds.
- The pane running the current agent process refuses to close itself.

## Agents: lifecycle control

`herdr_agent` drives a recognized coding agent in an existing pane. Use
prompt, wait, read, and send_keys instead of raw pane input.

- **Targets** are a unique live agent name or the pane ID currently hosting
  that agent - never terminal IDs or bare agent-kind labels. Names must
  match `[a-z][a-z0-9_-]{0,31}`, be unique among live agents, and follow the
  pane's current occupant; a name is cleared when the agent exits or is
  released.
- **Names do not survive a server restart.** They live in the herdr server's
  memory, so restored panes come back nameless and a name-targeted call answers
  `agent target X not found` while the same pane hosts a live agent (observed
  2026-09-20 after a machine-sleep restart). Keep your own registry (worker id →
  pane id), and after any restart target panes by ID. Read `not found` as "the
  name is gone", never as "the worker is gone".
- **Naming discipline**: encode wave + role in the name (a wave tag plus the pane's role); never reuse a live
  agent's name; a replacement worker gets a fresh name, not the dead one's; the tool clears the
  name on exit - do not re-register it for a different agent.
- **Lifecycle states**: `working`, `blocked`, `done`, `idle`, `unknown`.
  `prompt` and `wait` default to the first settled `idle`, `done`, or
  `blocked` state - that default is enough for normal helper work; do not
  restate it with `until`.
- **Dispatch is fire-and-forget**: pass `wait: false` whenever you prompt an
  agent you will babysit (timers plus `get` checks). The default `wait: true`
  blocks the calling turn until the agent settles - on a long run that is the
  whole run - and a timed-out wait does NOT mean the prompt failed; check `get`
  before re-sending. Only prompt with the default when blocking is the intent.
  (Observed 2026-10-09: a helper that had read only the native `herdr` docs
  omitted `wait:false` and hung its dispatcher; the native `herdr` skill is
  model-disabled on this machine, this skill is the operating surface.)
- `idle` means ready for input with the tab seen in the focused UI; `done`
  is the same underlying readiness after unseen background work finishes.
  Focusing the tab (or targeting the pane/agent) marks it seen; CLI reads do
  not. `blocked` means an approval or question UI was recognized - inspect
  with `get`/`read` before sending input. `unknown` means an agent is
  present but unclassified: uncertain, never completed.
- `send_keys` validates all keys before writing any bytes.

## Field procedures (orchestrator-proven)

### Fresh restart beats nudge-resume

When a worker agent keeps dying to provider errors (repeated kills,
balance/auth failures, transport resets), stop nudging the broken agent.
Start a fresh agent in a fresh pane and hand it a compact resume prompt:
what the task was, what is done, where the artifacts are. Nudge-resume
stacks retries on a session whose context may already be poisoned; a fresh
agent costs one pane and inherits a clean state.

### Verify staged, then fire

Before sending a prompt (or any Enter): confirm the text actually staged in
the target pane - read the pane and look for the prompt text sitting in the
input area - before the Enter that fires it. A blind Enter can submit a
stale, partial, or foreign line. `send_text` stages without Enter; `prompt`
stages and fires atomically. When a staged-then-fired sequence must be
split, verify the staged bytes between the two steps.

### Staged-not-fire: the post-prompt recovery default

A `prompt` (or `run`) sometimes only STAGES the text: wait reports "no observed state change
within 5000ms", the state_change_seq is frozen, the agent stays idle. The prompt is sitting in
the input area, unfired. Confirmed repeatedly across worker and orchestrator panes, including
an orchestrator's own receive path.

As of herdr 0.9.3 (2026-10-09), `agent prompt` submission is hardened: the
CLI sends the prompt and Enter before reporting success, and with `--wait` it
requires observed working/blocked activity, so unrelated state changes cannot
complete the wait (#3506, #3685). A prompt to an agent waiting at an approval
or question dialog is rejected with `agent_blocked` instead of sending
text+Enter (#2788). The staged-not-fire recovery below stays as-is until the
new behavior is re-confirmed live on 0.9.3.

Recovery, in order:

1. Do NOT re-prompt - a re-prompt stacks a second message on top of the staged one.
2. Read the pane (`recent-unwrapped`) - the staged text is visible in the input area.
3. Fire it: `herdr_pane send_keys ["enter"]`.
4. Wait again (15-20s) for working/blocked/done.

The CLI's stall error names the observed status and the frozen
state_change_seq but not the pane, and the submitted text may still be
staged in the input area - which is why step 2 reads before step 3 fires.
Until the tool itself verifies the transition, retries once with an
explicit Enter, and fails hard naming the pane and state, never treat a
prompt call's success as proof of execution; confirm with a read or a
settled wait.

Treat this as the default follow-up after every prompt timeout, not an edge case.

### False done: lifecycle 'done' is not work done

A turn aborted by a provider error (WAF 403, empty response) settles the lifecycle to `done`
with zero work done and zero deliverables. Worst observed: an agent reported done 3× in a row
with spend frozen at $0.009.

Every checkpoint verifies:

- spend delta since the last checkpoint (pane read),
- deliverable existence on disk (`ls`),
- git status, for implementation waves.

Lifecycle status alone is never evidence of progress.

### Liveness under fragile windows (provider instability)

- After ANY early death, run a SHORT liveness timer (240s), not the normal 900s babysit -
  early death needs early detection.
- Liveness check, in order: (1) the worker's session file - last entry timestamp, `stopReason`,
  `errorMessage`; (2) pane read (`recent-unwrapped`) - spend growth = alive, frozen spend with
  403 fragments in the tail suggests death. After a restart the pane's counters and lifecycle
  state are RESTORED, not live, so frozen spend alone proves nothing. Do not wait for lifecycle
  states.
- Two deaths in the same session: test session-poisoning with a FRESH pane, fresh session, and a
  neutral prompt (no error vocabulary). If the fresh session also dies after several clean
  turns, the cause is key/pool-level, not history-level.
- Cooldown relaunches: 10 min between attempts. If death repeats after cooldown, the flag is
  persistent - STOP retrying (each retry costs a turn and pollutes logs), defer the wave,
  escalate the diagnosis.
- During an active provider flag: NO NEW WORKERS - fresh sessions draw from the shared key pool.
  Worker-dependent queue freezes; orchestrator-native work continues.

### Stall-check order: the transcript is the oracle, not the pane

Observed 2026-09-20: a pane reported `working` after a machine-sleep restart; the orchestrator
read its frozen spend counters as a dead stream, sent Escape, and aborted a LIVE resuming turn
(the transcript then showed `stopReason: "aborted"`, and the worker needed a re-prompt). The
`working` state was restored state from before the restart - the run it belonged to had died the
evening before with a provider error.

Before Escape, in order:

1. Read the worker's session file: the last entry's timestamp and the last assistant entry's
   `stopReason` / `errorMessage`. An entry landing within the last minutes = live; a tail that
   has not moved across the gap = terminal.
2. A frozen context/spend counter is NOT a stall criterion - counters are restored with the
   session and cannot distinguish a live turn from a dead one.
3. Text sitting in the input area is a staged-prompt problem (see above), not a stall.
4. Escape only when the transcript shows a terminal state AND nothing new for the full timeout.
   Prefer a steer or a fresh restart over Escape: Escape destroys in-flight reasoning.
5. **Escape is the right tool for a frozen maintenance phase, not for a turn.** A pane stuck at
   `Auto-compacting...` (or any similar braid maintenance phase) with byte-identical counters and
   cost across two checks minutes apart, and a transcript that has not moved, is a stalled
   compaction: its summarizer stream died and nothing will retry. Pressing Escape there cancels the
   maintenance phase only and the agent resumes immediately - observed 2026-09-20, where a worker
   that had been frozen for 25 minutes was writing again within seconds of the cancel. Two checks
   minutes apart are what separate this from a genuinely slow phase; one sample proves nothing.

### Babysit cadence (timer tool)

- Normal research/impl worker: 900s cadence, `tag` = wave/worker id, count-bounded (max 8 fires,
  then re-arm manually). Cancel the timer explicitly when the wave closes - a stale babysit
  fired twice after its wave closed once already.
- Early-death risk: 240s liveness first, then 900s cadence once spend grows.
- Content per fire: pane read (spend/state), deliverable ls, ONE Telegram line to the owner.

### Workspace-per-project

All wave workers live in one Herdr workspace, cwd = the project root; deliverables go to the
orchestrator-owned docs repo; the git tree stays untouched (git status empty verified at every
close). If a file turns up dirty, verify before blaming a worker: auto-mechanics (e.g. a
doc-status manifest) can dirty a file on their own - git restore if stale.

### Pane hygiene when coordinated work finishes

When a batch of delegated work completes: collect final outputs first
(reads survive a close, in-flight state does not), then have idle agents
exit, close the panes you created, and consolidate the tab back to what the
user had. Leave the user's own focus pane untouched. An orphaned agent
left running holds a name, a pane, and possibly a bill.

## Relation to the other surfaces

- The one-line per-tool guidance in the prompt (ownership-priority renderer)
  is the always-visible form; this skill is the on-demand deep form.
- `herdr_layout` results are the single source of topology truth; everything
  else takes IDs from there.
- Orchestration-level concerns (spawn patterns, worker lifecycles, context
  handoff between agents) live in the subagent-orchestration skill; this
  file only covers the terminal topology underneath them.
