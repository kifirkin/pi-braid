/**
 * Vet Filter — Utility-model security classification for path-security.
 *
 * Each check is a lightweight yes/no classification call. The utility model
 * "vets" (evaluates) tool operations for safety before execution.
 *
 * Three-tier fallback: utility model → session model → heuristic.
 * Heuristics are the current regex/allowlist logic, preserved as graceful
 * degradation — they fire only when no model is available or times out.
 *
 * Parallel to roast-filter.ts in input-polisher, but for security instead
 * of text quality. "Roast" critiques quality; "vet" checks security.
 */
import { classify } from "../../lib/text-classifier.js";
import * as path from "node:path";
import * as os from "node:os";
import { SKILLS_DIR } from "../../index.js";
// ── Classification Criteria ──────────────────────────────────────────────────
/** Is this file write/edit operation targeting a dangerous path? */
const WRITE_DANGER_CRITERIA = {
    systemPrompt: "You are a security classifier for an AI coding agent. " +
        "Determine if the given file write or edit targets a path that " +
        "the agent should NOT write to. " +
        "SAFE paths include: the project directory, temp directories, " +
        "~/.pi/ config and memory directories, and skill directories. " +
        "DANGEROUS paths include: system config (/etc/), SSH keys, " +
        "credential files, authentication data, /root/, /boot/, " +
        "package manager databases, and binary directories outside the project. " +
        "Answer only 'yes' or 'no'. 'yes' = DANGEROUS, should be blocked. " +
        "'no' = SAFE, should be allowed.",
    userPrompt: "Operation: {{toolName}}\nTarget: {{path}}\nProject: {{cwd}}\n" +
        "Is this write operation dangerous?",
};
/** Is this bash command performing a dangerous filesystem operation? */
const BASH_DANGER_CRITERIA = {
    systemPrompt: "You are a security classifier for an AI coding agent. " +
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
        "Answer only 'yes' or 'no'. 'yes' = DANGEROUS, should be blocked. " +
        "'no' = SAFE, should be allowed.",
    userPrompt: "Command: {{command}}\nProject: {{cwd}}\n" + "Is this bash command dangerous?",
};
// ── Shared utilities (used by heuristic fallbacks) ───────────────────────────
function buildAllowlist(cwd) {
    const resolvedCwd = path.resolve(cwd);
    const homeDir = os.homedir();
    const piHomeDir = path.join(homeDir, ".pi");
    const piAgentDir = path.join(piHomeDir, "agent");
    const skillsDir = path.join(piAgentDir, "skills");
    const projectSkillsDir = path.join(resolvedCwd, "skills");
    const bundledSkillsDir = SKILLS_DIR;
    return [
        resolvedCwd,
        piHomeDir,
        piAgentDir,
        skillsDir,
        projectSkillsDir,
        bundledSkillsDir,
        os.tmpdir(),
        "/tmp",
        "/var/tmp",
        "/dev",
    ];
}
function isPathAllowed(resolvedPath, allowlist) {
    const normalized = path.resolve(resolvedPath);
    for (const allowed of allowlist) {
        const ra = path.resolve(allowed);
        if (normalized.startsWith(ra + path.sep) || normalized === ra)
            return true;
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
/** Bash commands that only read files. */
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
// ── Heuristic Fallbacks ──────────────────────────────────────────────────────
/**
 * Heuristic for write safety: check the resolved path against the allowlist.
 * Returns "yes" (dangerous) if the path is outside the allowlist.
 */
function heuristicWriteCheck(toolName, filePath, cwd) {
    if (!filePath)
        return "no";
    const resolved = path.resolve(cwd, filePath);
    const allowlist = buildAllowlist(cwd);
    if (!isPathAllowed(resolved, allowlist)) {
        return "yes";
    }
    return "no";
}
/** Expand ~ and check absolute paths for a command. Returns violation info. */
function checkBashPaths(command, cwd) {
    const homeDir = os.homedir();
    // Expand tilde
    const expanded = command
        .replace(/(?<!\w)~(\/[^\s"'|;&]*(?:\s|$|['"|;&]))/g, `${homeDir}$1`)
        .replace(/(?<!\w)~(\s|$|['"|;&])/g, `${homeDir}$1`);
    const resolvedCwd = path.resolve(cwd);
    const allowlist = buildAllowlist(cwd);
    const allAllowed = [...allowlist, ...SYSTEM_BIN_DIRS];
    let hasViolation = false;
    let hasRedirect = false;
    // Check cd commands
    const cdRe = /\bcd\s+(\S+)/gi;
    let m;
    while ((m = cdRe.exec(expanded)) !== null) {
        const cdTarget = m[1];
        const r = cdTarget.startsWith("/") ? cdTarget : path.resolve(resolvedCwd, cdTarget);
        if (!isPathAllowed(r, allAllowed))
            hasViolation = true;
    }
    // Check absolute paths
    const absRe = /(?<!\w)(\/[\w%+~@.-][\w%+~@./-]*)/g;
    while ((m = absRe.exec(expanded)) !== null) {
        const ap = m[1];
        if (ap.startsWith("/usr/") || ap.startsWith("/bin/") || ap.startsWith("/opt/"))
            continue;
        if (!isPathAllowed(ap, allAllowed))
            hasViolation = true;
    }
    // Check redirects
    const redirRe = /[^2]>>?\s*(\/[^\s]+)/g;
    while ((m = redirRe.exec(expanded)) !== null) {
        const rp = m[1];
        if (!isPathAllowed(rp, allAllowed)) {
            hasViolation = true;
            hasRedirect = true;
        }
    }
    // Check if this is a read-only command
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
/**
 * Heuristic for bash safety: uses the current regex/allowlist logic.
 * Returns "yes" (dangerous) if the command has violations that aren't
 * read-only path-only.
 */
function heuristicBashCheck(command, cwd) {
    // Hard-deny patterns (always dangerous)
    const S = (s) => s;
    const hardDeny = [
        new RegExp(S("\\brm\\s+-rf\\s+\\/(?:\\s+|$)")),
        new RegExp(S("\\bcurl\\b.*\\|\\s*(?:bash|sh|zsh|ksh)\\s*$")),
        new RegExp(S("\\bwget\\b.*\\|\\s*(?:bash|sh|zsh|ksh)\\s*$")),
        new RegExp(S("(?:>|>>)\\s*\\/etc\\/(?:passwd|shadow|sudoers)\\b")),
        new RegExp(S("(?:>|>>)\\s*\\/root\\/\\.ssh\\/")),
        new RegExp(S("\\bchmod\\s+(?:-R\\s+)?777\\s+\\/")),
    ];
    for (const p of hardDeny) {
        if (p.test(command))
            return "yes";
    }
    const { hasViolation, hasRedirect, isReadOnly } = checkBashPaths(command, cwd);
    if (!hasViolation)
        return "no";
    if (!hasRedirect && isReadOnly)
        return "no";
    return "yes"; // deny-by-default for ambiguous
}
/**
 * Vet a file write/edit operation for safety.
 *
 * Three-tier: utility model → session model → heuristic (allowlist check).
 * Safe = operation is allowed. Not safe = operation should be blocked.
 */
export async function vetWriteOperation(toolName, filePath, cwd, ctx) {
    const result = await classify(ctx, WRITE_DANGER_CRITERIA, { toolName, path: filePath, cwd }, {
        maxTokens: 5,
        timeoutMs: 5000,
        fallback: () => heuristicWriteCheck(toolName, filePath, cwd),
    });
    return { safe: result.label !== "yes", tier: result.tier };
}
/**
 * Vet a bash command for safety.
 *
 * Three-tier: utility model → session model → heuristic (regex/allowlist).
 * Safe = command is allowed. Not safe = command should be blocked.
 */
export async function vetBashCommand(command, cwd, ctx) {
    const truncated = command.length > 2000 ? command.slice(0, 2000) + "..." : command;
    const result = await classify(ctx, BASH_DANGER_CRITERIA, { command: truncated, cwd }, {
        maxTokens: 5,
        timeoutMs: 5000,
        fallback: () => heuristicBashCheck(command, cwd),
    });
    return { safe: result.label !== "yes", tier: result.tier };
}
//# sourceMappingURL=vet-filter.js.map