import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function openSearchHealthCommand(workflowPath: string) {
	const lines = readFileSync(workflowPath, 'utf8').split('\n');
	const serviceStart = lines.indexOf('      opensearch:');
	assert.notEqual(serviceStart, -1, `${workflowPath} must declare the OpenSearch service`);
	const serviceLines: string[] = [];
	for (const line of lines.slice(serviceStart + 1)) {
		if (line.trim() && !line.startsWith('        ')) break;
		serviceLines.push(line);
	}
	const option = serviceLines.find((line) => line.trimStart().startsWith('--health-cmd '));
	assert.ok(option, `${workflowPath} must configure an OpenSearch health command`);
	// Decode the outer CLI quoting first. Docker receives one command argument,
	// then executes its contents separately with CMD-SHELL.
	const decoded = spawnSync('/bin/sh', ['-c', `set -- ${option.trim()}; printf '%s\\0' "$@"`], {
		encoding: 'utf8', timeout: 5_000
	});
	assert.ifError(decoded.error);
	assert.equal(decoded.status, 0, decoded.stderr);
	const args = decoded.stdout.split('\0');
	assert.equal(args.pop(), '');
	assert.equal(args.length, 2, 'Docker must receive exactly one --health-cmd argument');
	assert.equal(args[0], '--health-cmd');
	return args[1];
}

for (const workflow of ['integration', 'release']) {
	for (const [state, curlExit] of [['unavailable', 7], ['ready', 0]] as const) {
		test(`${workflow} OpenSearch health command preserves the ${state} backend result and full URL`, () => {
			const command = openSearchHealthCommand(`.github/workflows/${workflow}.yml`);
			const directory = mkdtempSync(join(tmpdir(), 'active-ts-health-'));
			const argumentFile = join(directory, 'curl-arguments');
			try {
				writeFileSync(join(directory, 'curl'), [
					'#!/bin/sh',
					'printf \'%s\\0\' "$@" > "$ACTIVE_TS_HEALTH_ARGS_FILE"',
					'exit "$ACTIVE_TS_HEALTH_CURL_EXIT"',
					''
				].join('\n'), { mode: 0o700 });
				const result = spawnSync('/bin/sh', ['-c', command], {
					encoding: 'utf8', timeout: 5_000,
					env: {
						...process.env,
						PATH: `${directory}:${process.env.PATH ?? ''}`,
						ACTIVE_TS_HEALTH_ARGS_FILE: argumentFile,
						ACTIVE_TS_HEALTH_CURL_EXIT: String(curlExit)
					}
				});
				assert.ifError(result.error);
				assert.equal(result.status, curlExit, 'CMD-SHELL must preserve the curl exit status');
				assert.deepEqual(readFileSync(argumentFile, 'utf8').split('\0'), [
					'-fsS',
					'http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=1s',
					''
				]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
}
