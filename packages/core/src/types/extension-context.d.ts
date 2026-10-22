/**
 * @fileoverview Extension context type seat for pi-braid.
 *
 * Braid uses pi-core's own `ExtensionContext` and does not augment it. A local
 * augmentation would let braid compile against members no runtime provides; the
 * one that lived here declared `ctx.whisper`, `ctx.enforcer` and
 * `ctx.analytics`, none of which pi ever sets, and no code called them.
 *
 * What the context actually carries (pi-core 1.2.0 and 1.4.0 declare the same
 * member set, member for member):
 *
 * - `ui`, `mode`, `hasUI`, `cwd`
 * - `sessionManager`, `modelRegistry`, `model`, `scopedModels`, `thinkingLevel`
 * - `isIdle()`, `isProjectTrusted()`, `signal`, `abort()`, `hasPendingMessages()`
 * - `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`
 *
 * Tool `execute` receives this context as its fifth argument, typed
 * `ExtensionToolContext`: the same members plus `tools` and `executeTool()`.
 * Command handlers receive `ExtensionCommandContext`, which adds session
 * control (`getSystemPromptOptions`, `waitForIdle`, `newSession`, `fork`,
 * `navigateTree`, `switchSession`, `reload`) that is only safe in
 * user-initiated commands.
 *
 * The `pi` object (`ExtensionAPI`) has no `model` member, and no
 * `modelRegistry` member: a tool that needs the active model reads it from the
 * `ctx` argument.
 */
export type { ExtensionContext } from "@earendil-works/pi-coding-agent";
