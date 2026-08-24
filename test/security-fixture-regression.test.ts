import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { forbiddenSecretPatterns, scanTextForForbiddenSecrets } from './secret-scan-rules.js';

test('repository fixtures avoid secret-scanner bait literals', () => {
	const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
		.split('\n')
		.filter(Boolean)
		.filter((file) =>
			/^(src|test|docs|examples|\.github)\//.test(file) ||
			['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json'].includes(file)
		);
	const matches: string[] = [];
	for (const file of files) {
		const content = readFileSync(file, 'utf8');
		matches.push(...scanTextForForbiddenSecrets(content, file));
	}
	assert.deepEqual(matches, []);
});

test('repository secret guard catches representative token patterns', () => {
	const samples = [
		['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
		['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
		['ghp_', 'a'.repeat(36)].join(''),
		['github', 'pat', 'a'.repeat(24)].join('_'),
		['npm_', 'a'.repeat(36)].join(''),
		['glpat', 'a'.repeat(24)].join('-'),
		['sk', 'proj', 'a'.repeat(24)].join('-'),
		['xoxb', '1234567890-token'].join('-'),
		['AIza', 'a'.repeat(35)].join('')
	];

	for (const sample of samples) {
		assert.equal(
			forbiddenSecretPatterns.some(({ pattern }) => pattern.test(sample)),
			true,
			sample.slice(0, 8)
		);
	}
});
