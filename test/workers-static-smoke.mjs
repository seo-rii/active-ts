import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

// Build the installed tarball, never a source alias. This fixture exercises ORM
// runtime portability with a deterministic SDK-shaped client, without network I/O.
export async function runWorkersStaticSmoke(consumer) {
	const entry = path.join(consumer, 'worker.ts');
	await writeFile(entry, `
import assert from 'node:assert/strict';
import { Model, createActiveTs, defineModel, defineTypedView, ACTIVE_TS_ENTITY_KEY } from 'active-ts';
import { createDatastoreStoreAdapter } from 'active-ts/adapters/store/datastore-injected';

type Row = { id: number; title: string; privateValue: string };
class Record extends Model<Row> { label() { return this.data.title; } }
const summary = defineTypedView<Row>()({
  name: 'summary', resolve: ({ data }) => ({ id: data.id, title: data.title }),
  parse(value): { id: number; title: string } {
    const dto = value as { id: number; title: string };
    if (!dto || typeof dto.id !== 'number' || typeof dto.title !== 'string') throw new TypeError('summary');
    return dto;
  }
});
defineModel<Row>('worker_record').id('id').validate(value => value as Row).view(summary).attach(Record);

export const contract = {
  async test() {
    const KEY = Symbol('sdk-key');
    const row = { id: 17, title: 'public', privateValue: 'hidden' };
    const key = { path: ['worker_record', 17] };
    const calls: string[] = [];
    const providerError = Object.assign(new Error('provider unavailable'), { code: 14, details: 'fixture' });
    let fail = false;
    function query() {
      return { filter() { return this; }, order() { return this; }, limit() { return this; },
        offset() { return this; }, start() { return this; }, select() { return this; }, hasAncestor() { return this; } };
    }
    const client = {
      KEY, projectId: 'fixture', databaseId: 'fixture-db', key(input: unknown) { return input; },
      async get(input: unknown) { calls.push('get'); if (fail) throw providerError; const entity = { ...row, [KEY]: key }; return [Array.isArray(input) ? [entity] : entity]; },
      async save() { calls.push('save'); }, async insert() { calls.push('insert'); },
      async update() { calls.push('update'); }, async delete() { calls.push('delete'); },
      createQuery: query,
      async runQuery() { return [[{ ...row, [KEY]: key }], { moreResults: 'NO_MORE_RESULTS' }]; },
      createAggregationQuery() { return { count() { return this; } }; },
      async runAggregationQuery() { return [[{ count: 1 }]]; },
      transaction() { return { ...this, async run() { calls.push('run'); },
        async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); } }; }
    };
    const store = await createDatastoreStoreAdapter({ client, keySymbol: KEY, keyEncoding: 'native' });
    const context = createActiveTs({ stores: { default: store } });
    const Bound = Record.use(context);
    const found = await Bound.find(17).load();
    assert.ok(found instanceof Record);
    assert.equal(found.label(), 'public');
    const dto: { id: number; title: string } = await found.view(summary);
    assert.deepEqual(dto, { id: 17, title: 'public' });
    assert.equal('privateValue' in dto, false);
    const page = await Bound.query().limit(1).load();
    assert.equal((await page.list[0].view(summary)).id, 17);
    assert.ok((await store.get(context.meta(Record), 17))[ACTIVE_TS_ENTITY_KEY]);
    assert.equal(await Bound.query().count(), 1);
    await context.transaction(async tx => {
      const item = await Record.use(tx).find(17).load();
      assert.ok(item);
      item.data.title = 'changed';
      await item.save();
    });
    assert.ok(calls.includes('commit'));
    assert.ok(calls.includes('update'));
    fail = true;
    await assert.rejects(store.get(context.meta(Record), 17), error => error === providerError);
  }
};
`);
	await exec(process.execPath, [path.join(consumer, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--types', 'node', 'worker.ts'], { cwd: consumer });
	const result = await build({
		entryPoints: [entry], bundle: true, platform: 'neutral', format: 'esm',
		target: 'es2023', conditions: ['workerd', 'worker', 'import', 'default'],
		external: ['node:*'], write: false, metafile: true, logLevel: 'silent'
	});
	const output = result.outputFiles[0].text;
	assert.doesNotMatch(output, /\bimport\s*\(/, 'injected bundle must contain no runtime dynamic import');
	for (const input of Object.keys(result.metafile.inputs)) {
		assert.doesNotMatch(input, /(?:optional-import|cli|adapters\/store\/(?:postgresql|mongodb|firestore|sqlite))\.[cm]?[jt]s$/);
	}
	for (const item of Object.values(result.metafile.outputs)) {
		for (const dependency of item.imports) assert.match(dependency.path, /^node:/);
	}
	await writeFile(path.join(consumer, 'worker.mjs'), output);
	await writeFile(path.join(consumer, 'worker.capnp'), `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "worker", esModule = embed "worker.mjs")],
      compatibilityDate = "2026-10-01",
      compatibilityFlags = ["nodejs_compat"]
    )),
    (name = "internet", network = (allow = []))
  ]
);
`);
	await exec(require.resolve('workerd/bin/workerd'), ['test', 'worker.capnp'], { cwd: consumer, timeout: 60_000 });
	console.log(`Installed Workers static-client fixture passed (${Buffer.byteLength(output)} bundle bytes).`);
}
