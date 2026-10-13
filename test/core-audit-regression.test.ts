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

for (const failure of ['validation', 'codec', 'hook'] as const) {
	test(`failed read ${failure} cannot publish a cache entry`, async () => {
		class CachedRecord extends Model<{ id: number; value: number }> {}
		const name = `audit_invalid_cache_${failure}`;
		let rejectHook = failure === 'hook';
		const builder = defineModel<CachedRecord['data']>({ name, cache: { ttl: 300 } }).id('id')
			.validate((data: any) => { if (typeof data.value !== 'number') throw Error('number required'); return data; })
			.readValidation('error');
		if (failure === 'codec') builder.fieldCodec('value', { name: 'number', encode: (value) => value, decode: (value) => {
			if (typeof value !== 'number') throw Error('number required'); return value;
		} });
		builder.attach(CachedRecord);
		const store = new MemoryStoreAdapter();
		const cache = new MemoryCacheAdapter();
		const context = createActiveTs({ stores: { default: store }, caches: { default: cache }, plugins: [{ name: 'failing-read-hook', hooks: {
			afterInstantiate() { if (rejectHook) throw Error('read hook failed'); }
		} }] });
		const Records = CachedRecord.use(context);
		await store.seed(name, [{ id: 1, value: failure === 'hook' ? 1 : 'broken' }]);
		await assert.rejects(() => Records.find(1).load(), /number required|read hook failed/);
		assert.deepEqual(cache.snapshot(), {});
		rejectHook = false;
		await store.update(context.meta(CachedRecord), 1, { id: 1, value: 7 });
		assert.equal((await Records.find(1).load())?.data.value, 7);
	});
}

class HistoricalChild extends Model<{ id: number }> {}
class HistoricalParent extends Model<{ id: number; childId: number }> {}
defineModel<HistoricalChild['data']>('audit_history_child').id('id').validate((data) => data as HistoricalChild['data']).attach(HistoricalChild);
defineModel<HistoricalParent['data']>('audit_history_parent').id('id').validate((data) => data as HistoricalParent['data'])
	.ref('child', () => HistoricalChild, { localKey: 'childId', foreignKey: 'id' }).attach(HistoricalParent);

for (const source of ['point', 'query'] as const) {
	for (const operation of ['include', 'ref', 'retained'] as const) {
		test(`historical ${source} models reject ${operation} relations before hooks or reads`, async () => {
			let relationHooks = 0;
			let childReads = 0;
			let capturedRef: any;
			const store: import('../src/index.js').StoreAdapter = {
				kind: 'history-fixture', capabilities: { datastoreReadPolicy: true },
				async get() { return null; },
				async getMany(meta, ids) { if (meta.name === 'audit_history_child') childReads++; return ids.map((id) => ({ id, childId: 1 })); },
				async query() { return { list: [{ id: 1, childId: 1 }], count: 1, more: false }; },
				async create() {}, async update() {}, async delete() {}
			};
			const context = createActiveTs({ stores: { default: store }, lazyWarnings: false, plugins: [{ name: 'history-hooks', hooks: {
				beforeRelationLoad() { relationHooks++; }
			} }] });
			const Parents = HistoricalParent.use(context);
			// Direct LazyRef construction must enforce the same owner provenance.
			if (operation === 'retained') {
				const { LazyRef } = await import('../src/core/lazy-ref.js');
				const row = source === 'point' ? await Parents.find(1).readAt(1700000000000).load() : await Parents.query().readAt(1700000000000).first();
				assert.ok(row);
				capturedRef = new LazyRef(context, row, context.meta(HistoricalParent).relations.get('child')!, true);
				assert.throws(() => capturedRef.prime(null), /readAt|historical/);
				await assert.rejects(async () => capturedRef.load({ hooks: false }), /readAt|historical/);
			} else {
				const row = source === 'point' ? await Parents.find(1).readAt(1700000000000).load() : await Parents.query().readAt(1700000000000).first();
				assert.ok(row);
				await assert.rejects(async () => operation === 'include' ? await row.include('child') : await row.ref('child'), /readAt|historical/);
			}
			assert.equal(relationHooks, 0);
			assert.equal(childReads, 0);
		});
	}
}

for (const support of ['none', 'equality', 'one-direction', 'ordering'] as const) {
	test(`codec ordering requires explicit comparison preservation: ${support}`, async () => {
		class SortRecord extends Model<{ id: number; score: number }> {}
		const encode = (value: number) => support === 'ordering' ? String(value).padStart(8, '0') : String(value);
		defineModel<SortRecord['data']>(`audit_codec_sort_${support.replace('-', '_')}`).id('id')
			.validate((data) => data as SortRecord['data']).fieldCodec('score', {
				name: 'number-text', encode, decode: Number,
				...(support === 'none' ? {} : { encodeQuery: encode }),
				...(support === 'one-direction' ? { queryOperators: ['>'] as const } : {}),
				...(support === 'ordering' ? { queryOperators: ['<', '>'] as const } : {})
			}).attach(SortRecord);
		const store = new MemoryStoreAdapter();
		const Records = SortRecord.use(createActiveTs({ stores: { default: store } }));
		await Records.createMany([{ id: 1, score: 2 }, { id: 2, score: 10 }]);
		if (support === 'ordering') {
			assert.equal((await Records.query().orderBy('score').limit(1).first())?.data.score, 2);
			assert.equal((await Records.query().orderBy({ field: 'score', direction: 'desc' }).limit(1).first())?.data.score, 10);
		} else {
			await assert.rejects(() => Records.query().orderBy('score').limit(1).load(), /codec.*sort|portable.*order/i);
			assert.equal(store.stats.query, 0);
		}
	});
}

test('sorting below an encoded codec parent fails before the store query', async () => {
	const store = new MemoryStoreAdapter();
	const Records = EncodedProfile.use(createActiveTs({ stores: { default: store } }));
	await assert.rejects(() => Records.query().orderBy('profile.score').load(), /codec.*sort|exact codec/i);
	assert.equal(store.stats.query, 0);
});

for (const field of ['version', 'version.counter']) {
	test(`metadata rejects a codec overlapping optimistic version: ${field}`, () => {
		class VersionRecord extends Model<{ id: number; version: number }> {}
		assert.throws(() => defineModel<VersionRecord['data']>(`audit_version_${field.replace('.', '_')}`).id('id')
			.fieldCodec(field, { name: 'number-text', encode: String, decode: Number }).attach(VersionRecord), /codec.*version|version.*codec/i);
	});
}

test('ordinary numeric version saves remain supported', async () => {
	class VersionRecord extends Model<{ id: number; version: number; name: string }> {}
	defineModel<VersionRecord['data']>('audit_plain_version').id('id').validate((data) => data as VersionRecord['data']).attach(VersionRecord);
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const row = await VersionRecord.use(context).create({ id: 1, version: 1, name: 'before' });
	row.data.name = 'after';
	await row.save();
	assert.deepEqual(await store.get(context.meta(VersionRecord), 1), { id: 1, version: 2, name: 'after' });
});
