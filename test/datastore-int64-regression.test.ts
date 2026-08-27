import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ACTIVE_TS_ENTITY_KEY,
	datastoreInt64Id,
	datastoreInt64IdValue,
	datastoreKey,
	isDatastoreInt64Id,
	type DatastoreInt64Id,
	type EntityId,
	type QueryPlan,
	type ResolvedModelMeta
} from '../src/index.js';
import {
	createDatastoreStoreAdapter,
	datastoreInt64Id as datastoreSubpathInt64Id
} from '../src/adapters/store/datastore.js';
import { entityIdFromKey, entityIdKey } from '../src/core/query-utils.js';
import { assertSafeEntityId } from '../src/core/safe-keys.js';
import { normalizeStoreQueryPlan } from '../src/core/store-options.js';

const RESERVED_PREFIX = '\0active-ts:datastore-int64:';

type Int64Row = {
	id: EntityId;
	parentId?: EntityId;
	value: string;
};

const rootMeta: ResolvedModelMeta<Int64Row> = {
	model: class {},
	name: 'datastore_int64_record',
	store: 'default',
	idField: 'id',
	readValidation: 'off',
	indexes: [],
	searchIndexes: [],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map(),
	fieldTypes: new Map()
};

const childMeta: ResolvedModelMeta<Int64Row> = {
	...rootMeta,
	name: 'datastore_int64_child',
	datastore: {
		ancestorFields: ['parentId'],
		ancestor: ({ data }) => data?.parentId === undefined
			? undefined
			: datastoreKey('datastore_int64_parent', data.parentId)
	}
};

type SdkInt = Readonly<{ value: string }>;
type SdkKey = {
	kind: string;
	id?: string | number;
	name?: string;
	parent?: SdkKey;
	namespace?: string;
};

function sdkKey(input: { path: unknown[]; namespace?: string }): SdkKey {
	let parent: SdkKey | undefined;
	for (let index = 0; index < input.path.length; index += 2) {
		const kind = input.path[index];
		const rawId = input.path[index + 1];
		assert.equal(typeof kind, 'string');
		const key: SdkKey = { kind: kind as string, parent };
		if (typeof rawId === 'number') key.id = rawId;
		else if (typeof rawId === 'string') key.name = rawId;
		else key.id = (rawId as SdkInt).value;
		parent = key;
	}
	parent!.namespace = input.namespace;
	return parent!;
}

function keyed<T extends Record<string, unknown>>(row: T, keySymbol: symbol, key: SdkKey): T {
	Object.defineProperty(row, keySymbol, {
		value: key,
		enumerable: false,
		configurable: true
	});
	return row;
}

test('Datastore int64 ids are self-describing without retaining generated identities', () => {
	const selfDescribing = `${RESERVED_PREFIX}-9223372036854775808` as DatastoreInt64Id;
	assert.equal(isDatastoreInt64Id(selfDescribing), true);
	assert.equal(datastoreInt64IdValue(selfDescribing), '-9223372036854775808');
	assert.doesNotThrow(() => assertSafeEntityId(selfDescribing));

	const key = entityIdKey(selfDescribing);
	assert.equal(key, 'datastore-int64:-9223372036854775808');
	assert.equal(entityIdFromKey(key), selfDescribing);
	const normalized = normalizeStoreQueryPlan({
		where: [{ field: 'id', op: '=', value: selfDescribing }],
		or: [],
		sort: [],
		include: []
	}, 'id', 'Datastore int64 query plan');
	assert.equal(normalized.where[0].value, selfDescribing);

	assert.equal(datastoreSubpathInt64Id('9223372036854775807'), datastoreInt64Id('9223372036854775807'));
	assert.equal(isDatastoreInt64Id(`${RESERVED_PREFIX}9007199254740991`), false);
	assert.equal(isDatastoreInt64Id(`${RESERVED_PREFIX}9223372036854775808`), false);
	assert.equal(isDatastoreInt64Id(`${RESERVED_PREFIX}01`), false);
	assert.throws(() => assertSafeEntityId('ordinary\0entity-id'), /must not contain null bytes/);
	assert.throws(() => assertSafeEntityId(`${RESERVED_PREFIX}01`), /must not contain null bytes/);
	assert.throws(() => datastoreInt64Id('0'), /cannot be zero/);
	assert.throws(() => datastoreInt64Id('42'), /safe-integer range/);
	assert.throws(() => datastoreInt64Id('9223372036854775808'), /signed 64-bit integer/);
});

test('Datastore int64 ids preserve native keys, payloads, ancestors, cursors, and bulk operations', async () => {
	const keySymbol = Symbol('datastore-int64-key');
	const leafId = datastoreInt64Id('9223372036854775807');
	const parentId = datastoreInt64Id('-9223372036854775808');
	const intCalls: string[] = [];
	const keyPaths: unknown[][] = [];
	const filters: unknown[][] = [];
	const starts: string[] = [];
	const bulkUpserts: any[][] = [];
	const bulkDeletes: any[][] = [];
	let queryCalls = 0;
	const client = {
		KEY: keySymbol,
		int(value: string) {
			intCalls.push(value);
			return Object.freeze({ value });
		},
		key(input: { path: unknown[]; namespace?: string }) {
			keyPaths.push([...input.path]);
			return sdkKey(input);
		},
		async get(key: SdkKey) {
			const data = key.kind === childMeta.name
				? { id: leafId, parentId, value: 'child' }
				: { id: leafId, value: 'root' };
			return [keyed(data, keySymbol, key)];
		},
		async delete(keys: SdkKey[]) {
			bulkDeletes.push(keys);
		},
		async update() {},
		async save(entities: any[]) {
			bulkUpserts.push(entities);
		},
		createQuery() {
			return {
				filter(field: unknown, op: unknown, value: unknown) {
					filters.push([field, op, value]);
					return this;
				},
				limit() { return this; },
				start(cursor: string) {
					starts.push(cursor);
					return this;
				}
			};
		},
		async runQuery() {
			queryCalls++;
			const key = sdkKey({ path: [rootMeta.name, { value: datastoreInt64IdValue(leafId) }] });
			const entity = keyed({ id: leafId, value: 'query' }, keySymbol, key);
			return queryCalls === 1
				? [[entity], { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'int64-cursor' }]
				: [[entity], { moreResults: 'NO_MORE_RESULTS' }];
		}
	};
	const store = await createDatastoreStoreAdapter({ client, keyEncoding: 'native', keySymbol });

	assert.deepEqual(await store.get(rootMeta, leafId), { id: leafId, value: 'root' });
	const parent = datastoreKey('datastore_int64_parent', parentId);
	const child = await store.get(childMeta, leafId, { meta: { datastoreAncestor: parent } });
	assert.deepEqual(child, { id: leafId, parentId, value: 'child' });
	assert.deepEqual((child as any)[ACTIVE_TS_ENTITY_KEY], {
		path: [
			{ kind: 'datastore_int64_parent', id: parentId },
			{ kind: 'datastore_int64_child', id: leafId }
		],
		namespace: undefined
	});

	const plan: QueryPlan = {
		where: [{ field: 'id', op: '=', value: leafId }],
		or: [],
		sort: [],
		include: [],
		limit: 1
	};
	const first = await store.query(rootMeta, plan);
	assert.equal(first.more, true);
	assert.equal(typeof first.cursor, 'string');
	const second = await store.query(rootMeta, { ...plan, cursor: first.cursor });
	assert.equal(second.more, false);
	assert.deepEqual(starts, ['int64-cursor']);
	assert.deepEqual(filters, [
		['id', '=', leafId],
		['id', '=', leafId]
	]);

	await store.bulk.upsertMany(childMeta, [{
		id: leafId,
		data: { id: leafId, parentId, value: 'bulk' },
		options: { meta: { datastoreAncestor: parent } }
	}]);
	await store.bulk.deleteMany(rootMeta, [leafId]);
	assert.equal(bulkUpserts[0][0].data.id, leafId);
	assert.equal((bulkUpserts[0][0].key as SdkKey).id, datastoreInt64IdValue(leafId));
	assert.equal((bulkUpserts[0][0].key as SdkKey).parent?.id, datastoreInt64IdValue(parentId));
	assert.equal(bulkDeletes[0][0].id, datastoreInt64IdValue(leafId));
	assert.equal(intCalls.includes(datastoreInt64IdValue(leafId)), true);
	assert.equal(intCalls.includes(datastoreInt64IdValue(parentId)), true);
	assert.equal(keyPaths.some((path) => path.length === 4), true);
});
