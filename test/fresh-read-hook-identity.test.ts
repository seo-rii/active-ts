import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemorySearchAdapter, MemoryStoreAdapter, Model } from '../src/index.js';

type RecordData = { id: number; title: string; secret: string };

for (const path of ['search include', 'single fresh read'] as const) {
	for (const substitution of [false, true]) {
		test(`${path} ${substitution ? 'rejects coordinated hook ID and row substitution' : 'isolates hook ID snapshots from authoritative reads'}`, async () => {
			class Record extends Model<RecordData> {}
			class Child extends Model<{ id: number; parentId: number }> {}
			const name = `fresh_hook_${path === 'search include' ? 'search' : 'single'}_${substitution ? 'substitute' : 'observe'}`;
			defineModel<{ id: number; parentId: number }>(`${name}_child`).id('id').attach(Child);
			defineModel<RecordData>({ name, search: 'memory' }).id('id').search('memory', ['title'])
				.hasMany('children', () => Child, { localKey: 'id', foreignKey: 'parentId' }).attach(Record);
			const store = new MemoryStoreAdapter();
			const search = new MemorySearchAdapter();
			const reads: Array<Array<string | number>> = [];
			const getMany = store.getMany.bind(store);
			store.getMany = async (meta, ids, options) => {
				reads.push([...ids]);
				return getMany(meta, ids, options);
			};
			const context = createActiveTs({
				stores: { default: store }, search: { memory: search },
				plugins: [{
					name: 'mutating-fresh-read-hook',
					hooks: {
						beforeRead(payload) {
							if (payload.model?.name === name && !substitution) payload.ids![0] = 2;
						},
						afterRead(payload) {
							if (payload.model?.name !== name) return;
							if (substitution) {
								payload.ids![0] = 2;
								payload.result[0] = { id: 2, title: 'private', secret: 'row-two' };
							} else {
								assert.deepEqual(payload.ids, [1], 'afterRead needs a fresh snapshot of the requested IDs');
								payload.ids!.length = 0;
							}
						}
					}
				}]
			});
			const expected = { id: 1, title: 'public', secret: 'row-one' };
			await store.seed(name, [expected, { id: 2, title: 'private', secret: 'row-two' }]);
			await search.index(context.meta(Record), 1, expected);
			const load = async () => {
				if (path === 'single fresh read') return await context.loadByIdFresh(Record, 1);
				const result = await Record.use(context).search('public').include('children').load();
				assert.equal(result.count, 1);
				return result.list[0];
			};
			if (substitution) {
				await assert.rejects(load, /afterRead result\[0\] id field "id" must match the requested id/);
			} else {
				assert.deepEqual((await load())?.data, expected);
			}
			assert.deepEqual(reads, [[1]], 'hook metadata must not redirect the store read');
		});
	}
}
