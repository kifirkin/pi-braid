/**
 * Dangerous Command Detection
 *
 * Detect potentially dangerous bash commands that could cause data loss or security issues.
 */

/**
 * Detect potentially dangerous bash commands.
 * Returns true if the command should be blocked.
 */
export function isDangerousCommand(command: string): boolean {
	const lowerCmd = command.toLowerCase().trim();

	const dangerousPatterns = [
		// Recursive force remove
		/rm\s+-rf\s+\//,
		/rm\s+-rf\s+\*\s*$/,
		/rm\s+-rf\s+\.\s*$/,
		/rm\s+(-rf|-r\s+-f|-f\s+-r)\s+\//,
		/rm\s+-rf\s+\/root/,
		/rm\s+-rf\s+\/home/,
		/rm\s+-rf\s+\/usr/,
		/rm\s+-rf\s+\/etc/,
		/rm\s+-rf\s+\/var/,
		/rm\s+-rf\s+\/bin/,
		/rm\s+-rf\s+\/sbin/,
		/rm\s+-rf\s+\/lib/,

		// System-wide deletion
		/rm\s+(-rf)?\s+\*\s*$/,
		/rm\s+(-rf)?\s+\/\s*$/,

		// Fork bombs and destructive loops
		/:()\s*{\s*:\|:\s*&\s*};/,
		/\}\s*;\s*:\|:/,
		/fork\s*\(\s*\)\s*;.*while/,

		// Sudo without confirmation or with destructive commands
		/sudo\s+rm\s/,
		/sudo\s+dd\s/,
		/sudo\s+mkfs\s/,
		/sudo\s+parted\s/,
		/sudo\s+shutdown/,
		/sudo\s+reboot/,
		/sudo\s+init\s+0/,
		/sudo\s+init\s+6/,
		/sudo\s+-s\s+.*rm/,

		// DD with dangerous targets
		/dd\s+.*of=\/(dev|mmcblk|sd[a-z])/,
		/dd\s+.*of=\/dev\/zero/,

		// Overwrite with zero/destroy
		/>\s*\/dev\/sda/,
		/cat\s+\/dev\/zero\s+>\s+\/dev/,
		/shred\s+-n\s+0/,

		// Chmod dangerous permissions
		/chmod\s+777\s+\/(etc|usr|bin|var|home|root|sbin)/,
		/chmod\s+-r\s+777\s+\/(etc|usr|bin|var|home|root|sbin)/,

		// Chown dangerous ownership changes
		/chown\s+(-r)?\s+.*\/(etc|usr|bin|var|home|root|sbin)/,

		// Git force push to protected branches
		/git\s+push\s+.*\s+--force/,
		/git\s+push\s+origin\s+--force\s+--all/,
		/git\s+push\s+origin\s+--force\s+--tags/,

		// Docker destructive commands
		/docker\s+system\s+prune\s+-a/,
		/docker\s+rm\s+(-f)?\s+--all/,
		/docker\s+rmi\s+(-f)?\s+--all/,
		/docker\s+volume\s+prune/,

		// Package manager destructive
		/apt-get\s+remove\s+(--purge|-p).*--yes/,
		/yum\s+remove\s+.*--yes.*-y/,
		/pacman\s+-[Rr]cc/,

		// Curl/wget to pipe to shell
		/curl\s+.*\|\s*(sh|bash|zsh|python|perl|ruby)/,
		/wget\s+.*\|\s*(sh|bash|zsh|python|perl|ruby)/,
		/curl\s+-s\s+[a-z]+:\/\/.*\|\s*sh/,
		/wget\s+-q\s+-O\s+-\s+.*\|\s*sh/,

		// Eval arbitrary code
		/eval\s+\$/,
		/exec\s+/,

		// Disk wipe commands
		/shred\s+.*-n\s+[3-9]/,
		/nwipe/,
		/secure-delete/,

		// Network penetration
		/nmap\s+.*-o[NG]/,
		/hydra\s+/,
		/john\s+--wordlist/,
		/hashcat\s+.*-m\s+0/,

		// SQL injection patterns
		/drop\s+(table|database)\s+/i,
		/delete\s+from\s+\w+\s*;/i,
		/truncate\s+table/i,
	];

	for (const pattern of dangerousPatterns) {
		if (pattern.test(lowerCmd)) {
			return true;
		}
	}

	// Check for sudo with dangerous flags
	if (lowerCmd.includes("sudo") && (lowerCmd.includes("-rf") || lowerCmd.includes("-r -f"))) {
		return true;
	}

	// Check for rm with multiple directory traversals
	const slashCount = lowerCmd.match(/\/+/g)?.length ?? 0;
	if (lowerCmd.includes("rm ") && (lowerCmd.includes("..") || slashCount > 2)) {
		if (lowerCmd.includes("*") || lowerCmd.includes("?")) {
			return true;
		}
	}

	return false;
}
