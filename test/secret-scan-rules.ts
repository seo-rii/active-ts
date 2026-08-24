export const forbiddenFixtureLiterals = [
	Buffer.from(['plain', 'secret'].join('-'), 'utf8').toString('base64url'),
	['plain', 'secret'].join('-'),
	['other', 'secret'].join('-'),
	['short', 'secret'].join('-')
];

export const forbiddenSecretPatterns: Array<{ name: string; pattern: RegExp }> = [
	{ name: 'private key block', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
	{ name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/ },
	{ name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/ },
	{ name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36,255}\b/ },
	{ name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/ },
	{ name: 'OpenAI key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
	{ name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	{ name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ }
];

export function scanTextForForbiddenSecrets(content: string, label: string) {
	const matches: string[] = [];
	for (const literal of forbiddenFixtureLiterals) {
		if (content.includes(literal)) matches.push(`${label}: forbidden fixture literal`);
	}
	for (const { name, pattern } of forbiddenSecretPatterns) {
		if (pattern.test(content)) matches.push(`${label}: ${name}`);
	}
	return matches;
}
