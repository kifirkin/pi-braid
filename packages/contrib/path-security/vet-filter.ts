/**
 * Vet Filter — tiered security classification for path-security.
 *
 * Flow:
 *   1. Heuristic ALWAYS runs first.
 *      - "no"      → allow immediately (clearly safe)
 *      - "yes"     → dangerous, but DON'T block yet
 *      - "ambiguous" → escalate to LLM judge
 *   2. If heuristic is ambiguous, the LLM judge (utility model → session
 *      model → give up) decides yes/no. If the LLM is unavailable, the
 *      verdict defaults to cautious ("ambiguous, treat as dangerous").
 *   3. The CALLER decides whether "dangerous" means block or warn. By
 *      default, contrib path-security only WHISPERS. Set
 *      `braid.contrib.pathSecurity.block: true` to enable hard blocking.
 *
 * Three-tier inside the LLM call: utility model → session model → skip.
 * Each tier tries once with a 5s timeout. The classifier is in
 * lib/text-classifier.ts — see that file for the LLM call mechanics.
 *
 * Same classifier shape as the text-quality critics elsewhere in braid,
 * but for security instead of quality. "Vet" checks security.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, type ClassificationResult } from "pi-braid/lib";
import * as path from "node:path";
import * as os from "node:os";

const WRITE_DANGER_CRITERIA = {
  systemPrompt:
    "You are a security classifier for an AI coding agent. " +
    "Determine if the given file write or edit targets a path that " +
    "the agent should NOT write to. " +
    "SAFE paths include: the project directory, temp directories, " +
    "~/.pi/ config and memory directories, and skill directories. " +
    "DANGEROUS paths include: system config (/etc/), SSH keys, " +
    "credential files, authentication data, /root/, /boot/, " +
    "package manager databases, and binary directories outside the project. " +
    "Answer only 'yes' or 'no'. 'yes' = DANGEROUS. 'no' = SAFE.",
  userPrompt:
    "Operation: {{toolName}}\nTarget: {{path}}\nProject: {{cwd}}\n" +
    "Is this write dangerous?",
};

const BASH_DANGER_CRITERIA = {
  systemPrompt:
    "You are a security classifier for an AI coding agent. " +
    "Determine if the given bash command is dangerous. " +
    "SAFE operations include: reading files (cat, ls, grep, head, tail), " +
    "running development tools (npm, git, make, cargo, pip, node, python), " +
    "copying or moving files within the home directory, " +
    "listing directories, printing environment info, network requests " +
    "(curl, wget without pipe-to-shell). " +
    "DANGEROUS operations include: deleting the root filesystem (rm -rf /), " +
    "downloading and executing remote code (curl|sh, wget|bash), " +
    "overwriting system config files (/etc/passwd, /etc/shadow, /etc/sudoers), " +
    "modifying SSH keys or authorized_keys, " +
    "making the root filesystem world-writable (chmod 777 /), " +
    "and destroying block devices (dd, mkfs, fdisk). " +
    "Answer only 'yes' or 'no'. 'yes' = DANGEROUS. 'no' = SAFE.",
  userPrompt:
    "Command: {{command}}\nProject: {{cwd}}\n" +
    "Is this bash command dangerous?",
};

function buildAllowlist(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  const homeDir = os.homedir();
  const piHomeDir = path.join(homeDir, ".pi");
  const piAgentDir = path.join(piHomeDir, "agent");
  const skillsDir = path.join(piAgentDir, "skills");
  const projectSkillsDir = path.join(resolvedCwd, "skills");
  return [
    resolvedCwd,
    piHomeDir,
    piAgentDir,
    skillsDir,
    projectSkillsDir,
    os.tmpdir(),
    "/tmp",
    "/var/tmp",
    "/dev",
  ];
}

function isPathAllowed(resolvedPath: string, allowlist: string[]): boolean {
  const normalized = path.resolve(resolvedPath);
  for (const allowed of allowlist) {
    const ra = path.resolve(allowed);
    if (normalized.startsWith(ra + path.sep) || normalized === ra) return true;
  }
  return false;
}

const SYSTEM_BIN_DIRS = new Set([
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
]);

const READ_ONLY_BASH_CMDS = new Set([
  "cat",
  "head",
  "tail",
  "more",
  "less",
  "ls",
  "find",
  "grep",
  "rg",
  "ag",
  "ack",
  "stat",
  "file",
  "wc",
  "du",
  "df",
  "echo",
  "printf",
  "which",
  "type",
  "pwd",
  "date",
  "env",
  "printenv",
  "whoami",
  "id",
  "uname",
  "hostname",
  "pip",
  "pip3",
  "npm",
  "npx",
  "yarn",
  "node",
  "deno",
  "bun",
  "git",
  "curl",
  "wget",
  "make",
  "cmake",
  "cargo",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "docker",
  "podman",
  "bat",
  "glow",
  "jq",
  "yq",
  "tree",
  "xdg-open",
  "open",
  "ps",
  "top",
  "htop",
  "uptime",
  "ping",
  "dig",
  "nslookup",
  "host",
]);

// Hard-deny patterns (always dangerous, no LLM needed)

const HARD_DENY_BASH = [
  /\brm\s+-rf\s+\/(?:\s+|$)/,
  /\bcurl\b.*\|\s*(?:bash|sh|zsh|ksh)\s*$/,
  /\bwget\b.*\|\s*(?:bash|sh|zsh|ksh)\s*$/,
  /(?:>|>>)\s*\/etc\/(?:passwd|shadow|sudoers)\b/,
  /(?:>|>>)\s*\/root\/\.ssh\//,
  /\bchmod\s+(?:-R\s+)?777\s+\//,
  /\bdd\s+if=.*\s+of=\/dev\/(?:sd|nvme|hd)/,
  /\bmkfs(?:\.\w+)?\s+\/dev\//,
  /\b(?:fdisk|parted)\s+\/dev\//,
];

const HARD_DENY_PATH_PATTERNS = [
  /^\/etc\/(?:passwd|shadow|sudoers|hosts|hostname)$/,
  /^\/root\/\.ssh\//,
  /^\/boot\//,
  /^\/proc\/.*\/mem$/,
];

type HeuristicVerdict = "yes" | "no" | "ambiguous";

function heuristicWriteCheck(
  toolName: string,
  filePath: string,
  cwd: string,
): HeuristicVerdict {
  if (!filePath) return "ambiguous";
  const resolved = path.resolve(cwd, filePath);
  const allowlist = buildAllowlist(cwd);

  // Hard-deny paths (system secrets / boot)
  for (const re of HARD_DENY_PATH_PATTERNS) {
    if (re.test(resolved)) return "yes";
  }
  // Allowlist paths
  if (isPathAllowed(resolved, allowlist)) return "no";
  // Outside allowlist but not in hard-deny list → ask the LLM
  return "ambiguous";
}

interface BashPathCheck {
  hasViolation: boolean;
  hasRedirect: boolean;
  isReadOnly: boolean;
}

function checkBashPaths(command: string, cwd: string): BashPathCheck {
  const homeDir = os.homedir();
  const expanded = command
    .replace(/(?<!\w)~(\/[^\s"'|;&]*(?:\s|$|['"|;&]))/g, `${homeDir}$1`)
    .replace(/(?<!\w)~(\s|$|['"|;&])/g, `${homeDir}$1`);

  const resolvedCwd = path.resolve(cwd);
  const allowlist = buildAllowlist(cwd);
  const allAllowed = [...allowlist, ...SYSTEM_BIN_DIRS];
  let hasViolation = false;
  let hasRedirect = false;

  const cdRe = /\bcd\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = cdRe.exec(expanded)) !== null) {
    const r = m[1].startsWith("/") ? m[1] : path.resolve(resolvedCwd, m[1]);
    if (!isPathAllowed(r, allAllowed)) hasViolation = true;
  }

  const absRe = /(?<!\w)(\/[\w%+~@.-][\w%+~@./-]*)/g;
  while ((m = absRe.exec(expanded)) !== null) {
    const ap = m[1];
    if (
      ap.startsWith("/usr/") ||
      ap.startsWith("/bin/") ||
      ap.startsWith("/opt/")
    )
      continue;
    if (!isPathAllowed(ap, allAllowed)) hasViolation = true;
  }

  const redirRe = /[^2]>>?\s*(\/[^\s]+)/g;
  while ((m = redirRe.exec(expanded)) !== null) {
    if (!isPathAllowed(m[1], allAllowed)) {
      hasViolation = true;
      hasRedirect = true;
    }
  }

  const trimmed = command.trimStart();
  let isReadOnly = false;
  for (const cmd of READ_ONLY_BASH_CMDS) {
    if (trimmed.startsWith(cmd + " ") || trimmed === cmd) {
      isReadOnly = true;
      break;
    }
  }

  return { hasViolation, hasRedirect, isReadOnly };
}

function heuristicBashCheck(command: string, cwd: string): HeuristicVerdict {
  // Hard-deny patterns → always yes
  for (const re of HARD_DENY_BASH) {
    if (re.test(command)) return "yes";
  }
  const { hasViolation, hasRedirect, isReadOnly } = checkBashPaths(
    command,
    cwd,
  );
  if (!hasViolation) return "no"; // paths fine, no escalation needed
  if (isReadOnly && !hasRedirect) return "no"; // read-only command, even with weird path
  return "ambiguous"; // write/touch with path outside allowlist
}

export interface VetResult {
  safe: boolean; // false = "dangerous" — caller decides block vs warn
  tier: "heuristic" | "utility" | "session" | "skipped";
  reason: string;
  heuristicVerdict: HeuristicVerdict;
  llmVerdict?: "yes" | "no" | null;
  latencyMs: number;
}

/**
 * Normalize the evolved core classifier's tier onto path-security's VetResult
 * vocabulary. "failed" (LLM cascade exhausted / LLM unavailable) maps to
 * "skipped" — the cautious-unavailable bucket path-security already tracks.
 * Any produced LLM judgment (or binary-gate / cache / heuristic hit) counts
 * as a utility-tier decision.
 */
function toVetTier(tier: ClassificationResult["tier"]): VetResult["tier"] {
  switch (tier) {
    case "failed":
      return "skipped";
    case "session":
      return "session";
    default:
      return "utility"; // utility | max-power | cache | gate | heuristic
  }
}

export async function vetWriteOperation(
  toolName: string,
  filePath: string,
  cwd: string,
  ctx: ExtensionContext,
): Promise<VetResult> {
  const t0 = Date.now();
  const hVerdict = heuristicWriteCheck(toolName, filePath, cwd);
  if (hVerdict === "no") {
    return {
      safe: true,
      tier: "heuristic",
      reason: "path within allowlist",
      heuristicVerdict: hVerdict,
      latencyMs: Date.now() - t0,
    };
  }
  if (hVerdict === "yes") {
    return {
      safe: false,
      tier: "heuristic",
      reason: "path in hard-deny list",
      heuristicVerdict: hVerdict,
      latencyMs: Date.now() - t0,
    };
  }
  // Ambiguous → ask the LLM. No fallback (we've already used the heuristic).
  const llm = await classify(
    ctx,
    WRITE_DANGER_CRITERIA,
    { toolName, path: filePath, cwd },
    { maxTokens: 5, timeoutMs: 5000, label: "write-danger" },
  );
  if (llm.tier === "failed") {
    // LLM unavailable: cautious default — treat as dangerous
    return {
      safe: false,
      tier: "skipped",
      reason: "heuristic ambiguous, LLM unavailable",
      heuristicVerdict: hVerdict,
      llmVerdict: null,
      latencyMs: Date.now() - t0,
    };
  }
  return {
    safe: llm.label !== "yes",
    tier: toVetTier(llm.tier), // normalize core classifier tiers onto VetResult vocabulary
    reason: `LLM judge: ${llm.label}`,
    heuristicVerdict: hVerdict,
    llmVerdict: llm.label === "yes" ? "yes" : "no",
    latencyMs: Date.now() - t0,
  };
}

export async function vetBashCommand(
  command: string,
  cwd: string,
  ctx: ExtensionContext,
): Promise<VetResult> {
  const t0 = Date.now();
  const truncated =
    command.length > 2000 ? command.slice(0, 2000) + "..." : command;
  const hVerdict = heuristicBashCheck(command, cwd);
  if (hVerdict === "no") {
    return {
      safe: true,
      tier: "heuristic",
      reason: "command within safe patterns",
      heuristicVerdict: hVerdict,
      latencyMs: Date.now() - t0,
    };
  }
  if (hVerdict === "yes") {
    return {
      safe: false,
      tier: "heuristic",
      reason: "command matches hard-deny pattern",
      heuristicVerdict: hVerdict,
      latencyMs: Date.now() - t0,
    };
  }
  // Ambiguous → LLM
  const llm = await classify(
    ctx,
    BASH_DANGER_CRITERIA,
    { command: truncated, cwd },
    { maxTokens: 5, timeoutMs: 5000, label: "bash-danger" },
  );
  if (llm.tier === "failed") {
    return {
      safe: false,
      tier: "skipped",
      reason: "heuristic ambiguous, LLM unavailable",
      heuristicVerdict: hVerdict,
      llmVerdict: null,
      latencyMs: Date.now() - t0,
    };
  }
  return {
    safe: llm.label !== "yes",
    tier: toVetTier(llm.tier),
    reason: `LLM judge: ${llm.label}`,
    heuristicVerdict: hVerdict,
    llmVerdict: llm.label === "yes" ? "yes" : "no",
    latencyMs: Date.now() - t0,
  };
}
