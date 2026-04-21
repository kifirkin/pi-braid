import { createLogger } from "../../lib/logger.js";

const log = createLogger("web-fetch");
/**
 * Secret pattern detection for outgoing requests.
 * Ported from scurl's SecretDefender.
 */

export interface SecretPattern {
	name: string;
	pattern: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
	{ name: "AWS Access Key ID", pattern: /AKIA[0-9A-Z]{16}/ },
	{ name: "AWS Secret Key", pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/ },
	{ name: "GitHub PAT (classic)", pattern: /ghp_[A-Za-z0-9]{36}/ },
	{ name: "GitHub PAT (fine-grained)", pattern: /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/ },
	{ name: "GitHub OAuth", pattern: /gho_[A-Za-z0-9]{36}/ },
	{ name: "GitHub App Token", pattern: /ghs_[A-Za-z0-9]{36}/ },
	{ name: "GitHub Refresh Token", pattern: /ghr_[A-Za-z0-9]{36}/ },
	{ name: "GitLab PAT", pattern: /glpat-[A-Za-z0-9\-]{20}/ },
	{ name: "npm Token", pattern: /npm_[A-Za-z0-9]{36}/ },
	{ name: "PyPI Token", pattern: /pypi-[A-Za-z0-9\-_]{50,}/ },
	{ name: "Slack Bot Token", pattern: /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}/ },
	{ name: "Slack User Token", pattern: /xoxp-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}/ },
	{ name: "Stripe Live Key", pattern: /sk_live_[A-Za-z0-9]{24,}/ },
	{ name: "Stripe Test Key", pattern: /sk_test_[A-Za-z0-9]{24,}/ },
	{ name: "Google API Key", pattern: /AIza[0-9A-Za-z\-_]{35}/ },
	{ name: "Twilio API Key", pattern: /SK[0-9a-fA-F]{32}/ },
	{ name: "SendGrid API Key", pattern: /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/ },
	{ name: "DigitalOcean PAT", pattern: /dop_v1_[a-f0-9]{64}/ },
	{ name: "Discord Bot Token", pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/ },
	{ name: "Private Key (PEM)", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
	{ name: "Password in URL", pattern: /:\/\/[^:]+:[^@]+@/ },
	{ name: "Anthropic API Key", pattern: /sk-ant-[A-Za-z0-9\-_]{80,}/ },
	{ name: "OpenAI API Key", pattern: /sk-[A-Za-z0-9]{48,}/ },
];

export interface SecretScanResult {
	found: boolean;
	pattern?: SecretPattern;
	location?: string;
}

function scanForSecrets(text: string): SecretPattern | null {
	for (const p of SECRET_PATTERNS) {
		if (p.pattern.test(text)) return p;
	}
	return null;
}

export function scanUrl(url: string): SecretScanResult {
	const match = scanForSecrets(url);
	if (match) return { found: true, pattern: match, location: "URL" };

	try {
		const parsed = new URL(url);
		for (const [, value] of parsed.searchParams) {
			const m = scanForSecrets(value);
			if (m) return { found: true, pattern: m, location: "query parameter" };
		}
	} catch {
		// Invalid URL, skip
 /* Non-fatal: secret extraction not available */
	}

	return { found: false };
}

export function scanHeaders(headers: Record<string, string>): SecretScanResult {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "authorization") continue;
		const m = scanForSecrets(value);
		if (m) return { found: true, pattern: m, location: `header '${name}'` };
	}
	return { found: false };
}
