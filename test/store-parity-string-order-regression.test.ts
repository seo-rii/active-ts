import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { MemoryStoreAdapter, type AggregatePlan, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';
import { createStoreParityFixture, runStoreAdapterDifferentialContract } from '../src/testing/index.js';

// Datastore, Firestore and MongoDB compare strings by code point (UTF-8 byte
// order), which places U+E000-U+FFFF above supplementary characters; UTF-16
// code units place them below. This memory store stores the fixture's
// characters from U+E000 up as consecutive supplementary characters, so
// JavaScript's UTF-16 comparison of the stored strings is the code point
// order of the original ones.
const stored = new Map([[0xe000, 0x10000], [0xffff, 0x10001], [0x10000, 0x10002], [0x10ffff, 0x10003]]);
const original = new Map([...stored].map(([from, to]) => [to, from]));

function mapStrings<T>(value: T, table: Map<number, number>): T {
	if (typeof value === 'string') {
		return String.fromCodePoint(...Array.from(value, (char) => table.get(char.codePointAt(0)!) ?? char.codePointAt(0)!)) as T;
	}
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, table)) as T;
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, table)])) as T;
	}
	return value;
}

function storedPlan<T extends QueryPlan | AggregatePlan>(plan: T): T {
	return { ...plan, where: plan.where.map((where) => ({ ...where, value: mapStrings(where.value, stored),
		...('value2' in where ? { value2: mapStrings(where.value2, stored) } : {}) })) };
}

function codePointOrderStore(utf16StringOrder: boolean, results = (result: any, plan: QueryPlan) => result) {
	return new (class extends MemoryStoreAdapter {
		override readonly capabilities = { ...new MemoryStoreAdapter().capabilities, utf16StringOrder };
		override async create(...[model, id, data, options]: Parameters<MemoryStoreAdapter['create']>) {
			return mapStrings(await super.create(model, id, mapStrings(data, stored), options), original);
		}
		override async get(...args: Parameters<MemoryStoreAdapter['get']>) {
			return mapStrings(await super.get(...args), original);
		}
		override async query(...[model, plan, options]: Parameters<MemoryStoreAdapter['query']>) {
			const result = await super.query(model, storedPlan(plan), options);
			return results({ ...result, list: mapStrings(result.list, original) }, plan);
		}
		override async aggregate(...[model, plan]: Parameters<MemoryStoreAdapter['aggregate']>) {
			return mapStrings(await super.aggregate(model, storedPlan(plan)), original);
		}
	})();
}

const UTF16_CASES = 14;

test('Differential contract skips only string-order cases for stores without UTF-16 string order', async () => {
	for (const seed of [17, 29]) {
		const result = await runStoreAdapterDifferentialContract(codePointOrderStore(false), { seed });
		assert.deepEqual(result, { seed, queries: 29 - 13, aggregates: 6 - 1, pages: 6, rejections: 4, skipped: UTF16_CASES });
	}
	await assert.rejects(runStoreAdapterDifferentialContract(codePointOrderStore(true), { seed: 17 }), /seed=17 case=label-asc/);
	const reference = codePointOrderStore(false);
	assert.equal((await runStoreAdapterDifferentialContract(new MemoryStoreAdapter(), { seed: 17, reference })).skipped, UTF16_CASES);
});

test('Store parity fixture marks exactly the cases whose result depends on string order', async () => {
	const fixture = createStoreParityFixture(17);
	const model: ResolvedModelMeta = { model: class {}, name: 'parity_string_order', store: 'default', idField: 'id',
		readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
		policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
		fieldTypes: new Map([['label', 'string'], ['score', 'number']]) };
	const utf16 = new MemoryStoreAdapter();
	const codePoint = codePointOrderStore(false);
	for (const row of fixture.rows) {
		await utf16.create(model, row.id, row);
		await codePoint.create(model, row.id, row);
	}
	let marked = 0;
	for (const entry of fixture.queries) {
		const sensitive = !isDeepStrictEqual((await utf16.query(model, entry.plan)).list, (await codePoint.query(model, entry.plan)).list);
		assert.equal(entry.requires.includes('utf16StringOrder'), sensitive, entry.name);
		if (sensitive) marked++;
	}
	for (const entry of fixture.aggregates) {
		const sensitive = !isDeepStrictEqual(await utf16.aggregate(model, entry.plan), await codePoint.aggregate(model, entry.plan));
		assert.equal(entry.requires.includes('utf16StringOrder'), sensitive, entry.name);
		if (sensitive) marked++;
	}
	assert.equal(marked, UTF16_CASES);
});

test('Differential contract still reports non-string-order divergences without UTF-16 string order', async () => {
	const wrongCount = codePointOrderStore(false, (result) => ({ ...result, count: result.count + 1 }));
	await assert.rejects(runStoreAdapterDifferentialContract(wrongCount, { seed: 17 }), /case=label-asc-page/);
	// Cursor pages are compared with the store's own full order instead of skipped.
	const lostPage = codePointOrderStore(false, (result, plan) => plan.cursor ? { ...result, list: [], more: false } : result);
	await assert.rejects(runStoreAdapterDifferentialContract(lostPage, { seed: 17 }), /case=memory-cursor-1/);
});

test('Built-in store adapters declare UTF-16 string order truthfully', async () => {
	const sqlite = await createSqliteStoreAdapter();
	try {
		const stores = {
			memory: new MemoryStoreAdapter(),
			sqlite,
			postgres: await createPostgresStoreAdapter({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }),
			mongodb: await createMongoStoreAdapter({ dbName: 'test', client: { db: () => ({ collection: () => ({}) }) } }),
			datastore: await createDatastoreStoreAdapter({ client: { key: (input: unknown) => input, get: async () => [undefined],
				save: async () => undefined, delete: async () => undefined, update: async () => undefined, createQuery: () => ({}),
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }] } }),
			firestore: await createFirestoreStoreAdapter({ client: { collection: () => ({}), getAll: async () => [],
				runTransaction: async () => undefined } })
		};
		const declared = Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, store.capabilities?.utf16StringOrder]));
		assert.deepEqual(declared, { memory: true, sqlite: true, postgres: true, mongodb: false, datastore: false, firestore: false });
		await sqlite.transaction!(async (tx) => assert.equal(tx.capabilities?.utf16StringOrder, true));
		await stores.memory.transaction(async (tx) => assert.equal(tx.capabilities?.utf16StringOrder, true));
	} finally {
		await sqlite.close();
	}
});
