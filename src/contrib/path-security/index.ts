/**
 * Path-Security Extension — Filesystem boundary enforcement.
 *
 * Prevents the agent from operating outside its project directory (cwd)
 * by intercepting tool_call events and validating path parameters.
 *
 * File tools (read, write, edit, grep, find, ls, etc.):
 *   Resolves the `path` parameter against project cwd and blocks if
 *   it escapes to a non-allowlisted directory. Deterministic, no LLM needed.
 *
 * Bash — two-tier hardening:
 *   Tier 1 (regex): Fast pre-filter. Catches obvious escapes (absolute paths
 *     outside allowlist, cd to non-allowed dirs). Legitimate commands
 *     (npm test, git status) pass through with zero latency.
 *   Tier 2 (utility model): Activated when regex finds suspicious patterns.
 *     Uses the configured utility model to semantically classify whether the
 *     command attempts filesystem escape. 2s timeout, deny-by-default fallback
 *     when the model is unavailable (erring on the side of blocking).
 *
 * Allowlisted directories:
 *   - Project cwd (from ctx.cwd)
 *   - ~/.pi/agent/ (skills, config, memory, settings)
 *   - Project's skills/ dir (bundled skills)
 *   - System temp (/tmp, /var/tmp, TMPDIR)
 *   - /dev/null, /dev/stdout, /dev/stderr
 *   - System bin dirs (/usr/bin, /bin, /usr/local/bin — bash only)
 *
 * This is a CONTRIB extension — peripheral, not cognitive architecture.
 * It can be disabled with BRAID_MODULES="-contrib" or toggled individually.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";
import { classify } from "../../lib/text-classifier.js";
import * as path from "node:path";
import * as os from "node:os";
import { onEvent } from "../../lib/event-types.js";

const log = createLogger("path-security");

// ── File tools that accept a `path` parameter ────────────────────────────────

const FILE_PATH_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "render_pdf_page",
  "read_document",
  "analyze_image",
  "file_diff",
  "codebase_graph",
  "codebase_tree",
]);

// ── Build allowlist ──────────────────────────────────────────────────────────

function buildAllowlist(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  const homeDir = os.homedir();
  const piAgentDir = path.join(homeDir, ".pi", "agent");
  const skillsDir = path.join(piAgentDir, "skills");
  const projectSkillsDir = path.join(resolvedCwd, "skills");

  return [
    resolvedCwd,
    piAgentDir,
    skillsDir,
    projectSkillsDir,
    os.tmpdir(),
    "/tmp",
    "/var/tmp",
    "/dev",
  ];
}

/** Check if a resolved path is within any allowlisted directory. */
function isPathAllowed(resolvedPath: string, allowlist: string[]): boolean {
  const normalized = path.resolve(resolvedPath);
  for (const allowed of allowlist) {
    const resolvedAllowed = path.resolve(allowed);
    if (normalized.startsWith(resolvedAllowed + path.sep) || normalized === resolvedAllowed) {
      return true;
    }
  }
  return false;
}

// ── Bash: Tier 1 — Fast regex pre-filter ─────────────────────────────────────

/** System bin directories that are safe for bash to reference. */
const SYSTEM_BIN_DIRS = new Set([
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
]);

/** Regex to match absolute Unix paths in a command string. */
const ABSOLUTE_PATH_RE = /(?<!\w)(\/[\w%+~@.-][\w%+~@.\/-]*)/g;

/** Regex to match `cd <path>` commands. */
const CD_COMMAND_RE = /\bcd\s+(\S+)/gi;

/** Regex to match redirection operators that write outside the project. */
const REDIRECT_OUT_RE = /[^2]>>?\s*(\/[^\s]+)/g;

export interface RegexCheckResult {
  safe: boolean;
  violations: string[];
  suspiciousPaths: string[];
}

/**
 * Tier 1: Fast regex check for obvious path escapes.
 * Catches absolute paths outside allowlist, cd to non-allowed dirs,
 * and redirects to absolute paths. Returns all findings for the utility
 * model to review.
 */
function checkBashRegex(command: string, allowlist: string[], cwd: string): RegexCheckResult {
  const resolvedCwd = path.resolve(cwd);
  const allAllowed = [...allowlist, ...SYSTEM_BIN_DIRS];
  const violations: string[] = [];
  const suspiciousPaths: string[] = [];

  // 1. Check `cd <path>` commands
  CD_COMMAND_RE.lastIndex = 0;
  let cdMatch: RegExpExecArray | null;
  while ((cdMatch = CD_COMMAND_RE.exec(command)) !== null) {
    const cdTarget = cdMatch[1];
    const resolved = cdTarget.startsWith("/")
      ? cdTarget
      : path.resolve(resolvedCwd, cdTarget);
    if (!isPathAllowed(resolved, allAllowed)) {
      violations.push(`cd to ${cdTarget} would escape the project directory`);
      suspiciousPaths.push(cdTarget);
    }
  }

  // 2. Check absolute paths in the command
  ABSOLUTE_PATH_RE.lastIndex = 0;
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = ABSOLUTE_PATH_RE.exec(command)) !== null) {
    const absPath = pathMatch[1];

    // Skip system bin dirs exactly
    if (SYSTEM_BIN_DIRS.has(absPath)) continue;

    // Check if this absolute path is within any allowed directory
    let isAllowed = false;
    for (const allowed of allAllowed) {
      if (absPath.startsWith(allowed + "/") || absPath === allowed) {
        isAllowed = true;
        break;
      }
    }
    if (isAllowed) continue;

    // Allow system commands in bin dirs (e.g., /usr/bin/npm)
    const parentDir = path.dirname(absPath);
    if (SYSTEM_BIN_DIRS.has(parentDir)) continue;

    violations.push(`references absolute path outside project: ${absPath}`);
    suspiciousPaths.push(absPath);
  }

  // 3. Check redirection to absolute paths
  REDIRECT_OUT_RE.lastIndex = 0;
  let redirMatch: RegExpExecArray | null;
  while ((redirMatch = REDIRECT_OUT_RE.exec(command)) !== null) {
    const redirPath = redirMatch[1];
    if (!isPathAllowed(redirPath, allAllowed)) {
      violations.push(`redirects output outside project: ${redirPath}`);
      suspiciousPaths.push(redirPath);
    }
  }

  return {
    safe: violations.length === 0,
    violations,
    suspiciousPaths,
  };
}

// ── Bash: Tier 2 — Utility model classification ──────────────────────────────

const BASH_SAFETY_CRITERIA = {
  systemPrompt:
    "You are a filesystem security classifier. Determine if the given bash " +
    "command attempts to read, write, or operate on files OUTSIDE the " +
    "project's allowed directories. " +
    "Answer only 'yes' or 'no'. 'yes' = command attempts filesystem escape " +
    "(DANGEROUS, should be blocked). 'no' = command is safe (operates only " +
    "within allowed directories or uses standard system tools).",
  userPrompt:
    "Command: {{command}}\n" +
    "Project directory: {{cwd}}\n" +
    "Regex-flagged paths: {{suspicious}}\n" +
    "Does this command attempt filesystem escape?",
};

/** Deny-by-default fallback — erring on the side of blocking. */
function denySuspicious(): string {
  return "yes";
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function pathSecurityExtension(pi: ExtensionAPI): void {
  onEvent(pi, "tool_call", async (event: any, ctx: ExtensionContext) => {
    const toolName: string = event?.toolName ?? "";
    const input = (event?.input ?? {}) as Record<string, unknown>;
    const cwd: string = (ctx as any).cwd ?? process.cwd();
    const allowlist = buildAllowlist(cwd);

    // ── File tools: check `path` parameter (deterministic, no LLM) ──────
    if (FILE_PATH_TOOLS.has(toolName)) {
      const filePath = (input?.path ?? input?.filePath ?? input?.target ?? "") as string;
      if (!filePath) return;

      const resolved = path.resolve(cwd, filePath);
      if (!isPathAllowed(resolved, allowlist)) {
        const relative = path.relative(cwd, resolved);
        log.warn(
          `[path-security] BLOCKED ${toolName}: ${filePath} → ${resolved} (outside project)`,
        );
        await sendBlockWhisper(ctx, toolName, filePath, resolved, cwd);
        return { blocked: true, reason: `path outside project: ${filePath}` };
      }
    }

    // ── Bash: two-tier hardening ────────────────────────────────────────
    if (toolName === "bash") {
      const command = (input?.command ?? "") as string;
      if (!command) return;

      // Tier 1: Fast regex pre-filter
      const regexResult = checkBashRegex(command, allowlist, cwd);

      if (regexResult.safe) {
        // No suspicious patterns — allow immediately (zero latency)
        return;
      }

      // Tier 2: Utility model classification for suspicious commands
      log.info(
        `[path-security] Regex flagged ${regexResult.violations.length} issue(s), ` +
        `escalating to utility model: ${command.slice(0, 100)}...`,
      );

      try {
        const classification = await classify(
          ctx,
          BASH_SAFETY_CRITERIA,
          {
            command: command.slice(0, 800),
            cwd,
            suspicious: regexResult.suspiciousPaths.join(", "),
          },
          {
            maxTokens: 5,
            timeoutMs: 2000,
            fallback: denySuspicious, // deny-by-default on model failure
          },
        );

        if (classification.label === "yes") {
          log.warn(
            `[path-security] BLOCKED bash (model: ${classification.tier}, ` +
            `confidence: ${classification.confidence}): ${command.slice(0, 100)}`,
          );
          await sendBashBlockWhisper(ctx, command, regexResult.violations, classification, cwd);
          return { blocked: true, reason: `classified as filesystem escape (${classification.tier})` };
        }

        log.info(
          `[path-security] ALLOWED bash (model: ${classification.tier}, ` +
          `confidence: ${classification.confidence}): ${command.slice(0, 100)}`,
        );
      } catch (err) {
        // Classifier threw — deny-by-default for suspicious commands
        log.error(`[path-security] Classifier failed, blocking: ${err}`);
        await sendBashBlockWhisper(ctx, command, regexResult.violations, null, cwd);
        return { blocked: true, reason: "security classifier unavailable — blocked as precaution" };
      }
    }
  });

  log.info("[path-security] loaded — two-tier hardening (regex + utility model)");
}

// ── Steer Helpers ────────────────────────────────────────────────────────────

async function sendBlockWhisper(
  ctx: ExtensionContext,
  toolName: string,
  filePath: string,
  resolved: string,
  cwd: string,
): Promise<void> {
  try {
    const dir = path.basename(cwd);
    const rel = path.relative(cwd, resolved);
    ctx.whisper?.(
      `🔒 ${toolName} blocked — path \`${filePath}\` resolves outside project (${dir}/): ${rel} ` +
      `Keep all file access within the project directory. For skills/config, use the appropriate /command.`,
      { category: "cognitive", priority: "low" },
    );
  } catch {
    // Non-fatal
  }
}

async function sendBashBlockWhisper(
  ctx: ExtensionContext,
  command: string,
  violations: string[],
  classification: { label: string; confidence: number; tier: string; latencyMs: number } | null,
  cwd: string,
): Promise<void> {
  try {
    const dir = path.basename(cwd);
    const tierInfo = classification
      ? `${classification.tier} ${(classification.confidence * 100).toFixed(0)}% (${classification.latencyMs}ms)`
      : "classifier unavailable";
    ctx.whisper?.(
      `🔒 Bash blocked [${tierInfo}] — ${violations[0] || "possible filesystem escape"}. ` +
      `Run commands within \`${dir}/\` using relative paths. ` +
      `System tools (npm, git) resolve from PATH automatically.`,
      { category: "cognitive", priority: "low" },
    );
  } catch {
    // Non-fatal
  }
}
