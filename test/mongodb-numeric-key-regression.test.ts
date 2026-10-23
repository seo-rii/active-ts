import test from 'node:test';
import assert from 'node:assert/strict';
import { BSON } from 'mongodb';
import type { ResolvedModelMeta } from '../src/index.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';

const meta: ResolvedModelMeta = {
	model: class {}, name: 'numeric_key_record', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
	fieldTypes: new Map([['2', 'number'], ['1', 'number'], ['label', 'number']])
};

for (const fields of [['2', '1'], ['label', '2', '1']]) {
	test(`MongoDB preserves numeric compound order through sort, BSON creation, and discovery: ${fields}`, async () => {
		let exists = false;
		let indexes: unknown[] = [];
		let sortEntries: Array<[string, number]> = [];
		const collection = {
			find() { return {
				sort(spec: Map<string, number>) { sortEntries = [...spec]; return this; },
				async toArray() {
					return [
						{ _id: 'string:a', id: 'a', label: 0, '2': 2, '1': 1 },
						{ _id: 'string:b', id: 'b', label: 0, '2': 1, '1': 2 }
					].sort((a: any, b: any) => {
						for (const [field, direction] of sortEntries) if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * direction;
						return 0;
					});
				}
			}; },
			async indexes(options: unknown) { assert.deepEqual(options, { raw: true }); return indexes; },
			async createIndex(spec: Map<string, number>, options: { name: string; unique?: boolean }) {
				assert.deepEqual([...spec.keys()], fields);
				indexes = [BSON.serialize({ v: 2, name: options.name, key: spec, unique: options.unique })];
				return options.name;
			}
		};
		const adapter = await createMongoStoreAdapter({ dbName: 'test', client: { db() { return {
			collection() { return collection; },
			listCollections() { return { async toArray() { return exists ? [{ name: meta.name, type: 'collection' }] : []; } }; },
			async createCollection() { exists = true; }
		}; } } });
		const declared = { ...meta, indexes: [{ name: 'ordered_idx', fields, unique: true }] };
		const result = await adapter.query(declared, { where: [], or: [], sort: fields.map((field) => ({ field, direction: 'asc' })), include: [] });
		assert.deepEqual(result.list.map((row) => row.id), ['b', 'a']);
		assert.deepEqual(sortEntries.map(([field]) => field), fields);
		await adapter.schema!.apply([declared], { mode: 'safe' });
		// Ordinary JS deserialization would reorder these keys and lose the proof.
		assert.notDeepEqual(Object.keys(BSON.deserialize(indexes[0] as Buffer).key), fields);
		assert.deepEqual((await adapter.schema!.plan([declared])).changes, []);
		indexes.push(
			BSON.serialize({ v: 2, name: 'unrelated_hashed', key: { other: 'hashed' } }),
			BSON.serialize({ v: 2, name: 'unrelated_wildcard', key: { '$**': 1 } }),
			BSON.serialize({ v: 2, name: 'unrelated_text', key: { _fts: 'text', _ftsx: 1 }, weights: { title: 1 } }),
			BSON.serialize({ v: 2, name: 'unrelated_custom', key: { other: 2 } })
		);
		assert.deepEqual((await adapter.schema!.plan([declared])).changes, []);
		indexes = [BSON.serialize({ v: 2, name: 'ordered_idx', key: new Map([...fields].reverse().map((field) => [field, 1])), unique: true })];
		await assert.rejects(adapter.schema!.plan([declared]), /does not match declared fields or uniqueness/);
		indexes = [BSON.serialize({ v: 2, name: 'ordered_idx', key: new Map(fields.map((field) => [field, -1])), unique: true })];
		await assert.rejects(adapter.schema!.plan([declared]), /does not match declared fields or uniqueness/);
		indexes = [BSON.serialize({ v: 2, name: 'ordered_idx', key: new Map(fields.map((field) => [field, 1])), unique: false })];
		await assert.rejects(adapter.schema!.plan([declared]), /does not match declared fields or uniqueness/);
		indexes = [{ v: 2, name: 'ordered_idx', key: Object.fromEntries(fields.map((field) => [field, 1])), unique: true }];
		await assert.rejects(adapter.schema!.plan([declared]), /require raw BSON or an ordered Map/);
	});
}
