import test from 'node:test';
import assert from 'node:assert/strict';
import { Datastore } from '@google-cloud/datastore';
import { ActiveTsConfigurationError, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';
import { createDatastoreNamespaceStoreFactory, createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

// Datastore orders every integer below every double, and the SDK sends
// integer-valued numbers as integers, so a typed number field holding 10 and
// 9.99 sorts 10 first. typedNumbers: 'double' stores and queries every value
// of a fieldType(..., 'number') path as a double.
const meta: ResolvedModelMeta = { model: class {}, name: 'typed_double_numbers', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
	fieldTypes: new Map([['price', 'number'], ['metrics.score', 'number'], ['prices', 'number'], ['items.qty', 'number'],
		['label', 'string']]) };

const sdkEntityModule = '@google-cloud/datastore/build/src/entity.js';
const { entity: sdkEntity } = await import(sdkEntityModule);
const sdk = new Datastore({ projectId: 'active-ts-unit' });

const row = (id: number) => ({ id, price: 10, label: 'ten', count: 3, ratio: 0.5, metrics: { score: 7, raw: 7 },
	prices: [1, 2.5], items: [{ qty: 2 }, { qty: 0.5 }], big: 1e21 });

function sdkClient(overrides: Record<string, unknown> = {}) {
	const saved: any[] = [];
	const queries: any[] = [];
	const record = async (entity: unknown) => { saved.push(...(Array.isArray(entity) ? entity : [entity])); };
	const runQuery = async (query: any) => {
		queries.push(query);
		const entities = [{ ...row(1), [Datastore.KEY]: sdk.key(['typed_double_numbers', 'number:1']) }];
		return [entities, query.limitVal > 0
			? { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: `${query.startVal ?? 'page'}+1` }
			: { moreResults: 'NO_MORE_RESULTS' }];
	};
	const stored = (key: any) => key?.name === 'number:1' ? { ...row(1), [Datastore.KEY]: key } : undefined;
	const transaction = () => ({ run: async () => undefined, commit: async () => undefined, rollback: async () => undefined,
		get: async (key: any) => [stored(key)], runQuery,
		insert: record, update: record, upsert: record, save: record, delete: async () => undefined });
	const client = { KEY: Datastore.KEY, key: (input: any) => sdk.key(input), get: async () => [undefined],
		insert: record, update: record, upsert: record, save: record, delete: async () => undefined,
		createQuery: (...args: any[]) => (sdk.createQuery as any)(...args), runQuery,
		createAggregationQuery: (query: any) => sdk.createAggregationQuery(query),
		runAggregationQuery: async (aggregate: any) => { queries.push(aggregate.query); return [[{ total: 1 }]]; },
		double: (value: number) => Datastore.double(value), transaction, ...overrides };
	return { client, saved, queries };
}

function properties(entity: { data: unknown }) {
	return sdkEntity.entityToEntityProto({ data: entity.data }).properties;
}

// The wire decoder tags each value with its oneof name; add it to read back
// the encoded protos with the SDK's own decoder.
function wireValue(value: any): any {
	const valueType = Object.keys(value)[0];
	if (valueType === 'arrayValue') return { valueType, arrayValue: { values: value.arrayValue.values.map(wireValue) } };
	if (valueType === 'entityValue') return { valueType, entityValue: { properties: wireProperties(value.entityValue.properties) } };
	return { valueType, ...value };
}
function wireProperties(properties: Record<string, any>) {
	return Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, wireValue(value)]));
}

// The query filters as the SDK sends them, in the order they were applied.
function filterValues(query: any) {
	const proto = sdkEntity.queryToQueryProto(query);
	const filters = proto.filter?.compositeFilter?.filters ?? [];
	return filters.map((filter: any) => [filter.propertyFilter.property.name, filter.propertyFilter.op,
		filter.propertyFilter.value]);
}

function assertDoubleEncoded(entity: { data: any }) {
	const encoded = properties(entity);
	assert.deepEqual(encoded.price, { doubleValue: 10 });
	assert.deepEqual(encoded.metrics.entityValue.properties.score, { doubleValue: 7 });
	assert.deepEqual(encoded.metrics.entityValue.properties.raw, { integerValue: '7' }, 'untyped sibling keeps SDK encoding');
	assert.deepEqual(encoded.prices.arrayValue.values, [{ doubleValue: 1 }, { doubleValue: 2.5 }]);
	assert.deepEqual(encoded.items.arrayValue.values.map((item: any) => item.entityValue.properties.qty),
		[{ doubleValue: 2 }, { doubleValue: 0.5 }]);
	assert.deepEqual(encoded.count, { integerValue: '3' }, 'untyped numbers keep SDK encoding');
	assert.deepEqual(encoded.ratio, { doubleValue: 0.5 });
	assert.deepEqual(encoded.big, { doubleValue: 1e21 }, 'unsafe integers are still exact doubles');
	assert.deepEqual(encoded.label, { stringValue: 'ten' });
	// The SDK decodes doubles to plain JavaScript numbers.
	const decoded = sdkEntity.entityFromEntityProto({ properties: wireProperties(encoded) });
	assert.deepEqual(decoded, { ...row(entity.data.id), id: entity.data.id });
	assert.equal(typeof decoded.price, 'number');
}

test('Datastore typedNumbers: "double" writes every typed number as a double on every write path', async () => {
	const { client, saved } = sdkClient();
	const store = await createDatastoreStoreAdapter({ client, typedNumbers: 'double' });
	const input = row(1);
	await store.create(meta, 1, input);
	await store.update(meta, 1, row(1));
	await store.bulk.upsertMany(meta, [{ id: 2, data: row(2) }]);
	await store.transaction!(async (tx) => {
		await tx.create(meta, 3, row(3));
		await tx.update(meta, 1, row(1));
	});
	const factory = await createDatastoreNamespaceStoreFactory({ client, typedNumbers: 'double' });
	await (await factory.forNamespace('tenant')).create(meta, 4, row(4));
	assert.deepEqual(saved.map((entity) => entity.data.id), [1, 1, 2, 3, 1, 4]);
	for (const entity of saved) assertDoubleEncoded(entity);
	assert.deepEqual(input, row(1), 'caller data is not replaced by SDK wrappers');
});

test('Datastore typedNumbers: "double" sends typed number query, aggregate and min/max operands as doubles', async () => {
	const { client, queries } = sdkClient();
	const store = await createDatastoreStoreAdapter({ client, typedNumbers: 'double', allowQueryScanFallback: true });
	const where: QueryPlan['where'] = [
		{ field: 'price', op: '=', value: 10 },
		{ field: 'price', op: '!=', value: 10 },
		{ field: 'price', op: '>', value: 9.5 },
		{ field: 'price', op: '>=', value: 10 },
		{ field: 'price', op: '<', value: 11 },
		{ field: 'price', op: '<=', value: 11.5 },
		{ field: 'price', op: 'in', value: [10, 9.99] },
		{ field: 'price', op: 'between', value: 9, value2: 12 },
		{ field: 'metrics.score', op: '>', value: 1 }
	];
	const expected = [
		[['price', 'EQUAL', { doubleValue: 10 }]],
		[['price', 'NOT_EQUAL', { doubleValue: 10 }]],
		[['price', 'GREATER_THAN', { doubleValue: 9.5 }]],
		[['price', 'GREATER_THAN_OR_EQUAL', { doubleValue: 10 }]],
		[['price', 'GREATER_THAN', { nullValue: 0 }], ['price', 'LESS_THAN', { doubleValue: 11 }]],
		[['price', 'GREATER_THAN', { nullValue: 0 }], ['price', 'LESS_THAN_OR_EQUAL', { doubleValue: 11.5 }]],
		[['price', 'IN', { arrayValue: { values: [{ doubleValue: 10 }, { doubleValue: 9.99 }] } }]],
		[['price', 'GREATER_THAN_OR_EQUAL', { doubleValue: 9 }], ['price', 'LESS_THAN_OR_EQUAL', { doubleValue: 12 }]],
		[['metrics.score', 'GREATER_THAN', { doubleValue: 1 }]]
	];
	for (const [index, condition] of where.entries()) {
		queries.length = 0;
		await store.query(meta, { where: [condition], or: [], sort: [{ field: condition.field, direction: 'asc' }], include: [] });
		assert.deepEqual(filterValues(queries[0]), expected[index], JSON.stringify(condition));
	}

	// A portable candidate query keeps the exact double bound on the typed field
	// instead of widening it to an integer, which would sort below every double.
	queries.length = 0;
	await store.query(meta, { where: [{ field: 'untyped', op: '=', value: 'x' }, { field: 'price', op: '>', value: 9.5 }],
		or: [], sort: [], include: [] });
	assert.deepEqual(filterValues(queries[0]), [['untyped', 'EQUAL', { stringValue: 'x' }],
		['price', 'GREATER_THAN', { doubleValue: 9.5 }]]);

	queries.length = 0;
	await store.aggregate!(meta, { where: [{ field: 'price', op: '>', value: 9.5 }], or: [],
		aggregates: [{ op: 'sum', field: 'price', as: 'total' }] });
	assert.deepEqual(filterValues(queries[0]), [['price', 'GREATER_THAN', { doubleValue: 9.5 }]]);

	queries.length = 0;
	await store.aggregate!(meta, { where: [{ field: 'price', op: '>=', value: 9 }], or: [],
		aggregates: [{ op: 'min', field: 'price', as: 'cheapest' }] });
	assert.deepEqual(filterValues(queries[0]), [['price', 'GREATER_THAN_OR_EQUAL', { doubleValue: 9 }]]);
	assert.deepEqual(sdkEntity.queryToQueryProto(queries[0]).order, [{ property: { name: 'price' }, direction: 'ASCENDING' }]);

	queries.length = 0;
	await store.transaction!(async (tx) => {
		await tx.query(meta, { where: [{ field: 'price', op: '<', value: 10 }], or: [], sort: [], include: [] });
	});
	assert.deepEqual(filterValues(queries[0]), [['price', 'GREATER_THAN', { nullValue: 0 }],
		['price', 'LESS_THAN', { doubleValue: 10 }]]);
});

test('Datastore typed number encoding defaults to the SDK encoding', async () => {
	for (const typedNumbers of [undefined, 'sdk'] as const) {
		const { client, saved, queries } = sdkClient();
		const store = await createDatastoreStoreAdapter({ client, ...(typedNumbers ? { typedNumbers } : {}) });
		await store.create(meta, 1, row(1));
		const encoded = properties(saved[0]);
		assert.deepEqual(encoded.price, { integerValue: '10' });
		assert.deepEqual(encoded.prices.arrayValue.values, [{ integerValue: '1' }, { doubleValue: 2.5 }]);
		assert.deepEqual(encoded.big, { doubleValue: 1e21 });
		await store.query(meta, { where: [{ field: 'price', op: '=', value: 10 }], or: [], sort: [], include: [] });
		assert.deepEqual(filterValues(queries[0]), [['price', 'EQUAL', { integerValue: '10' }]]);
	}
});

test('Datastore continuation cursors do not cross typed number encodings', async () => {
	const { client } = sdkClient();
	const plan: QueryPlan = { where: [], or: [], sort: [{ field: 'price', direction: 'asc' }], include: [], limit: 1 };
	const sdkStore = await createDatastoreStoreAdapter({ client });
	const doubleStore = await createDatastoreStoreAdapter({ client, typedNumbers: 'double' });
	const sdkCursor = (await sdkStore.query(meta, plan)).cursor;
	const doubleCursor = (await doubleStore.query(meta, plan)).cursor;
	assert.ok(sdkCursor && doubleCursor);
	await sdkStore.query(meta, { ...plan, cursor: sdkCursor });
	await doubleStore.query(meta, { ...plan, cursor: doubleCursor });
	await assert.rejects(doubleStore.query(meta, { ...plan, cursor: sdkCursor }), /cursor/i);
	await assert.rejects(sdkStore.query(meta, { ...plan, cursor: doubleCursor }), /cursor/i);
});

test('Datastore typedNumbers is validated and requires client.double()', async () => {
	const { client } = sdkClient();
	for (const typedNumbers of ['float', true, 1, null]) {
		await assert.rejects(createDatastoreStoreAdapter({ client, typedNumbers } as any),
			/Datastore adapter typedNumbers must be "sdk" or "double"/);
		await assert.rejects(createDatastoreNamespaceStoreFactory({ client, typedNumbers } as any),
			/Datastore adapter typedNumbers must be "sdk" or "double"/);
	}
	const { client: withoutDouble } = sdkClient({ double: undefined });
	await assert.rejects(createDatastoreStoreAdapter({ client: withoutDouble, typedNumbers: 'double' }),
		(error: unknown) => error instanceof ActiveTsConfigurationError && /requires client\.double\(\)/.test(error.message));
	await assert.rejects(createDatastoreNamespaceStoreFactory({ client: withoutDouble, typedNumbers: 'double' }),
		/requires client\.double\(\)/);
	await createDatastoreStoreAdapter({ client: withoutDouble });
	await createDatastoreStoreAdapter({ client: withoutDouble, typedNumbers: 'sdk' });
});
