import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const statuses = new Map([
	['open', 'Open'], ['in_progress', 'In progress'], ['in_review', 'In review'],
	['accepted', 'Accepted'], ['resolved', 'Resolved']
]);
const priorities = ['P1', 'P2', 'P3'];

export function renderRiskRegister(data) {
	if (data?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(data.reviewedCommit ?? '') ||
		!/^\d{4}-\d{2}-\d{2}$/.test(data.reviewedAt ?? '') || !Array.isArray(data.findings)) {
		throw new Error('Invalid risk register identity or schema.');
	}
	const ids = new Set();
	for (const finding of data.findings) {
		if (!/^(?:BUG|ARCH|TEST|DOC)-\d{3,}$/.test(finding.id ?? '') || ids.has(finding.id)) throw new Error('Invalid or duplicate risk id.');
		ids.add(finding.id);
		if (!priorities.includes(finding.priority) || !statuses.has(finding.status) ||
			!['bug', 'improvement'].includes(finding.kind) ||
			!['reproduced', 'source_review'].includes(finding.verification) ||
			typeof finding.title !== 'string' || !finding.title.trim() || /[\r\n]/.test(finding.title)) {
			throw new Error(`Invalid risk fields for ${finding.id}.`);
		}
		if (finding.pullRequest !== null && !/^https:\/\/github\.com\/seo-rii\/active-ts\/pull\/[1-9]\d*$/.test(finding.pullRequest ?? '')) {
			throw new Error(`Invalid pull request for ${finding.id}.`);
		}
		if (finding.status === 'in_review' && !finding.pullRequest) throw new Error(`In-review risk ${finding.id} needs a pull request.`);
	}
	const active = data.findings.filter(finding => finding.status !== 'resolved');
	const count = status => data.findings.filter(finding => finding.status === status).length;
	const rows = [...active].sort((left, right) => priorities.indexOf(left.priority) - priorities.indexOf(right.priority) || left.id.localeCompare(right.id, 'en'));
	const lines = [
		'# Risk Register', '',
		'Generated from [risk-register-data.json](risk-register-data.json). Update that file and run `node scripts/render-risk-register.mjs`.', '',
		`Audit baseline: [${data.reviewedCommit.slice(0, 7)}](https://github.com/seo-rii/active-ts/commit/${data.reviewedCommit}), reviewed ${data.reviewedAt}.`, '',
		'Findings remain active while their PRs await merge. Mark an item resolved after its implementation reaches `main` and the required validation passes.', '',
		'## Current State', '',
		'| Metric | Value |', '| --- | ---: |',
		`| Active findings | ${active.length} |`,
		`| Open | ${count('open')} |`, `| In progress | ${count('in_progress')} |`,
		`| In review | ${count('in_review')} |`, `| Accepted | ${count('accepted')} |`,
		`| Resolved | ${count('resolved')} |`,
		`| Active reproduced bugs | ${active.filter(finding => finding.kind === 'bug' && finding.verification === 'reproduced').length} |`,
		`| Active improvement proposals | ${active.filter(finding => finding.kind === 'improvement').length} |`, '',
		'## Active Register', '',
		'| ID | Priority | Finding | Evidence | Status | PR |',
		'| --- | --- | --- | --- | --- | --- |'
	];
	for (const finding of rows) {
		const title = finding.title.replaceAll('|', '\\|');
		const evidence = finding.verification === 'reproduced' ? 'Reproduced' : 'Source review';
		const pr = finding.pullRequest ? `[#${finding.pullRequest.split('/').at(-1)}](${finding.pullRequest})` : 'Pending';
		lines.push(`| ${finding.id} | ${finding.priority} | ${title} | ${evidence} | ${statuses.get(finding.status)} | ${pr} |`);
	}
	if (!rows.length) lines.push('| — | — | All tracked findings are resolved. | — | — | — |');
	lines.push('', '## Historical Audits', '',
		'Older audit details are retained in [risk-register-archive.md](risk-register-archive.md). Their historical mitigation status is separate from the commit-specific active register above.', '',
		'## Maintenance', '',
		'- Keep stable issue IDs when fixes move between branches or PRs.',
		'- Preserve the audit baseline and evidence level when updating status.',
		'- Use `node scripts/render-risk-register.mjs --check` to verify that this page matches its data.', '');
	return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.slice(2).some(argument => argument !== '--check')) throw new Error('Usage: render-risk-register.mjs [--check]');
		const data = JSON.parse(await readFile(new URL('../docs/risk-register-data.json', import.meta.url), 'utf8'));
		const rendered = renderRiskRegister(data);
		const destination = new URL('../docs/risk-register.md', import.meta.url);
		if (process.argv.includes('--check')) {
			if (await readFile(destination, 'utf8') !== rendered) throw new Error('Risk dashboard is stale; run node scripts/render-risk-register.mjs.');
		} else await writeFile(destination, rendered);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
