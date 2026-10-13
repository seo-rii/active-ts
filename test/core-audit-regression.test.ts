import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter, MemoryCacheAdapter } from '../src/index.js';

class EncodedProfile extends Model<{ id: number; profile: { score: number; label: string }; other: string }> {}
defineModel<EncodedProfile['data']>('audit_encoded_profile').id('id').validate((data) => data as EncodedProfile['data'])
	.fieldCodec('profile', { name: 'json', encode: (value) => JSON.stringify(value), decode: (value) => JSON.parse(value as string) })
	.attach(EncodedProfile);

for (const fields of [['profile.score'], ['profile.score', 'profile.label'], ['profile']] as const) {
	test(`codec parent is decoded before selecting ${fields.join(',')}`, async () => {
		const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
		const Records = EncodedProfile.use(context);
		await Records.create({ id: 1, profile: { score: 3, label: 'visible' }, other: 'unselected' });
		const result = await Records.query().select(...fields).load();
		assert.deepEqual(result.list[0].data, {
			id: 1,
			profile: fields.length === 1 && fields[0] === 'profile.score' ? { score: 3 } : { score: 3, label: 'visible' }
		});
	});
}

test('aggregate fallback decodes a selected codec parent before reading child values', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, aggregate: { allowQueryFallback: true } });
	const Records = EncodedProfile.use(context);
	await Records.createMany([
		{ id: 1, profile: { score: 3, label: 'a' }, other: 'a' },
		{ id: 2, profile: { score: 5, label: 'b' }, other: 'b' }
	]);
	assert.equal(await Records.query().sum('profile.score'), 8);
	assert.deepEqual(await Records.query().aggregate({ sum: { op: 'sum', field: 'profile.score' }, count: 'count' }), { sum: 8, count: 2 });
});

class SnapshotRecord extends Model<{ id: number; state: string; tag: string }> {}
defineModel<SnapshotRecord['data']>('audit_snapshot_record').id('id').validate((data) => data as SnapshotRecord['data']).attach(SnapshotRecord);

for (const operation of ['query', 'aggregate'] as const) {
	test(`in-flight ${operation} retains its original OR constraints`, async () => {
		const store = new MemoryStoreAdapter();
		await store.seed('audit_snapshot_record', [{ id: 1, state: 'open', tag: 'a' }, { id: 2, state: 'closed', tag: 'b' }]);
		let entered!: () => void;
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let first = true;
		const hook = async () => { if (first) { first = false; entered(); await gate; } };
		const context = createActiveTs({ stores: { default: store }, plugins: [{ name: 'snapshot-gate', hooks: {
			...(operation === 'query' ? { beforeQuery: hook } : { beforeAggregate: hook })
		} }] });
		const query = SnapshotRecord.use(context).query().whereAny({ state: 'open' }, { state: 'closed' });
		const run = async () => operation === 'query' ? (await query.load()).list.map((item) => item.id) : await query.count();
		const pending = run();
		await waiting;
		query.where({ tag: 'b' });
		release();
		assert.deepEqual(await pending, operation === 'query' ? [1, 2] : 2);
		assert.deepEqual(await run(), operation === 'query' ? [2] : 1);
	});
}
