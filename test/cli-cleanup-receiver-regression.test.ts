import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const library = new URL('../src/index.js', import.meta.url).href;

for (const method of ['dispose', 'close']) {
	for (const promised of [false, true]) {
		for (const invalidConfig of [false, true]) {
			test(`CLI preserves default ${method} receiver (${promised ? 'promised' : 'direct'}, ${invalidConfig ? 'failure' : 'success'})`, async () => {
				const directory = await mkdtemp(join(tmpdir(), 'active-ts-cleanup-receiver-'));
				try {
					const marker = join(directory, 'closed');
					const config = join(directory, 'config.mjs');
					await writeFile(config, `
import { writeFile } from 'node:fs/promises';
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(library)};
const config = {
  context: createActiveTs({ stores: { default: new MemoryStoreAdapter() } }),
  models: ${invalidConfig ? 'null' : '[]'},
  resource: { async close() { await writeFile(${JSON.stringify(marker)}, 'closed'); } },
  async ${method}() { await this.resource.close(); }
};
export default ${promised ? 'Promise.resolve(config)' : 'config'};
`);
					const run = () => exec(process.execPath, [cli, 'schema', 'diff', '--config', config]);
					if (invalidConfig) {
						await assert.rejects(run, (error: any) => {
							assert.match(error.stderr, /Config models must be an array/);
							assert.doesNotMatch(error.stderr, /cleanup failed/);
							return true;
						});
					} else {
						const result = await run();
						assert.deepEqual(JSON.parse(result.stdout), []);
						assert.equal(result.stderr, '');
					}
					assert.equal(await readFile(marker, 'utf8'), 'closed');
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			});
		}
	}
}
