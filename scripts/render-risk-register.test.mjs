import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderRiskRegister } from './render-risk-register.mjs';

const fixture = () => ({ schemaVersion: 1, reviewedCommit: 'a'.repeat(40), reviewedAt: '2026-10-26', findings: [
	{ id: 'BUG-203', priority: 'P1', title: 'Read identity', kind: 'bug', verification: 'reproduced', status: 'in_review', pullRequest: 'https://github.com/seo-rii/active-ts/pull/50' },
	{ id: 'ARCH-020', priority: 'P3', title: 'Testing modules', kind: 'improvement', verification: 'source_review', status: 'open', pullRequest: null }
] });

test('open pull requests remain active and all metrics come from the register', () => {
	const rendered = renderRiskRegister(fixture());
	assert.match(rendered, /\| Active findings \| 2 \|/);
	assert.match(rendered, /\| In review \| 1 \|/);
	assert.match(rendered, /\| Open \| 1 \|/);
	assert.match(rendered, /\| Active reproduced bugs \| 1 \|/);
	assert.match(rendered, /\| Active improvement proposals \| 1 \|/);
	assert.match(rendered, /\[#50\]\(https:\/\/github.com\/seo-rii\/active-ts\/pull\/50\)/);
});

test('resolved findings leave active counts and rendering is independent of input order', () => {
	const data = fixture();
	const reversed = { ...data, findings: [...data.findings].reverse() };
	assert.equal(renderRiskRegister(data), renderRiskRegister(reversed));
	data.findings[0].status = 'resolved';
	const rendered = renderRiskRegister(data);
	assert.match(rendered, /\| Active findings \| 1 \|/);
	assert.match(rendered, /\| Resolved \| 1 \|/);
	assert.doesNotMatch(rendered, /\| BUG-203 \|/);
});

test('register rejects duplicate IDs, invalid statuses, and unsupported review links', () => {
	const duplicate = fixture(); duplicate.findings.push(duplicate.findings[0]);
	assert.throws(() => renderRiskRegister(duplicate), /duplicate risk id/);
	const invalid = fixture(); invalid.findings[0].status = 'done';
	assert.throws(() => renderRiskRegister(invalid), /Invalid risk fields/);
	const missingLink = fixture(); missingLink.findings[0].pullRequest = null;
	assert.throws(() => renderRiskRegister(missingLink), /needs a pull request/);
	const wrongRepo = fixture(); wrongRepo.findings[0].pullRequest = 'https://github.com/other/repo/pull/50';
	assert.throws(() => renderRiskRegister(wrongRepo), /Invalid pull request/);
});

test('checked-in dashboard matches its authoritative data', async () => {
	const data = JSON.parse(await readFile(new URL('../docs/risk-register-data.json', import.meta.url), 'utf8'));
	assert.equal(await readFile(new URL('../docs/risk-register.md', import.meta.url), 'utf8'), renderRiskRegister(data));
});
