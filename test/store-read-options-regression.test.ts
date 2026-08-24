import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter, type QueryPlan, type ResolvedModelMeta, type StoreAdapter } from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import {
	normalizeStoreQueryPlan,
	normalizeStoreQueryResult,
	normalizeStoreReadOptions,
	normalizeStoreWriteOptions,
	validateStoreQueryReadOptions
} from '../src/core/store-options.js';
import { normalizeQueryPlanFieldTypes } from '../src/core/field-types.js';

type ReadOptionData = {
	id: number;
	handle: string;
};

const meta: ResolvedModelMeta<ReadOptionData> = {
	model: class {},
	name: 'read_option_record',
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

const emptyPlan: QueryPlan = { where: [], or: [], sort: [], include: [] };

test('store and query option allowlists use captured Set intrinsics', () => {
	const setHas = Set.prototype.has;
	const setAdd = Set.prototype.add;
	let readError: unknown;
	let writeError: unknown;
	let planError: unknown;
	let whereError: unknown;
	let resultError: unknown;
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	Set.prototype.add = function () {
		throw new Error('patched Set.add');
	};
	try {
		try {
			normalizeStoreReadOptions({ selec: ['handle'] }, 'memory store read options');
		} catch (error) {
			readError = error;
		}
		try {
			normalizeStoreWriteOptions({ expectedVerison: 1 }, 'memory store write options');
		} catch (error) {
			writeError = error;
		}
		try {
			normalizeStoreQueryPlan({ ...emptyPlan, limt: 1 } as any, 'id', 'memory query plan');
		} catch (error) {
			planError = error;
		}
		try {
			normalizeStoreQueryPlan(
				{ ...emptyPlan, where: [{ field: 'handle', op: '=', value: 'a', val: 'b' }] } as any,
				'id',
				'memory query plan'
			);
		} catch (error) {
			whereError = error;
		}
		try {
			normalizeStoreQueryResult({ list: [], totla: 1 }, 'Store adapter "memory" query');
		} catch (error) {
			resultError = error;
		}
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
	assert.match(String((readError as Error | undefined)?.message), /memory store read options contains unknown option "selec"/);
	assert.match(
		String((writeError as Error | undefined)?.message),
		/memory store write options contains unknown option "expectedVerison"/
	);
	assert.match(String((planError as Error | undefined)?.message), /memory query plan contains unknown option "limt"/);
	assert.match(String((whereError as Error | undefined)?.message), /memory query plan\.where\[0\] contains unknown option "val"/);
	assert.match(String((resultError as Error | undefined)?.message), /Store adapter "memory" query result contains unknown option "totla"/);
});

test('field-type where allowlists use captured Set intrinsics', () => {
	const typedMeta: ResolvedModelMeta<any> = {
		...meta,
		name: 'typed_read_option_record',
		fieldTypes: new Map([['createdAt', 'date']])
	};
	const originalHas = Set.prototype.has;
	const originalAdd = Set.prototype.add;
	Object.defineProperty(Set.prototype, 'has', {
		configurable: true,
		value() {
			throw new Error('patched Set.has');
		}
	});
	Object.defineProperty(Set.prototype, 'add', {
		configurable: true,
		value() {
			throw new Error('patched Set.add');
		}
	});
	try {
		const normalized = normalizeQueryPlanFieldTypes(typedMeta, {
			...emptyPlan,
			where: [{ field: 'createdAt', op: '=', value: '2026-05-14' }]
		});
		assert.deepEqual(normalized.where, [{ field: 'createdAt', op: '=', value: '2026-05-14T00:00:00.000Z' }]);
		assert.throws(
			() =>
				normalizeQueryPlanFieldTypes(typedMeta, {
					...emptyPlan,
					where: [{ field: 'createdAt', op: '=', value: '2026-05-14', val: 'unexpected' } as any]
				}),
			/where entries\[0\] contains unknown option "val"/
		);
	} finally {
		Object.defineProperty(Set.prototype, 'has', { configurable: true, value: originalHas });
		Object.defineProperty(Set.prototype, 'add', { configurable: true, value: originalAdd });
	}
});

test('query read option metadata must match the query plan metadata when provided', () => {
	const plan = {
		...emptyPlan,
		meta: { datastoreAncestor: { kind: 'tenant', id: 1 }, softDelete: 'with' }
	};

	assert.deepEqual(
		validateStoreQueryReadOptions(
			{ meta: { datastoreAncestor: { kind: 'tenant', id: 1 }, softDelete: 'with' } },
			plan,
			'memory store read options'
		).meta,
		{ datastoreAncestor: { kind: 'tenant', id: 1 }, softDelete: 'with' }
	);
	assert.deepEqual(
		validateStoreQueryReadOptions({ meta: {} }, emptyPlan, 'memory store read options').meta,
		{}
	);
	assert.throws(
		() =>
			validateStoreQueryReadOptions(
				{ meta: { datastoreAncestor: { kind: 'tenant', id: 2 }, softDelete: 'with' } },
				plan,
				'memory store read options'
			),
		/memory store read options\.meta must match the query plan meta/
	);
	assert.throws(
		() =>
			validateStoreQueryReadOptions(
				{ meta: { datastoreAncestor: { kind: 'tenant', id: 1 } } },
				plan,
				'memory store read options'
			),
		/memory store read options\.meta must match the query plan meta/
	);
});

test('Datastore direct read and write options reject unsupported metadata before backend calls', async () => {
	let calls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: () => {
				calls++;
				return {};
			},
			get: async () => {
				calls++;
				return [undefined];
			},
			insert: async () => {
				calls++;
			},
			update: async () => {
				calls++;
			},
			delete: async () => {
				calls++;
			}
		})
	});
	const readOptions = { meta: { softDelete: 'with' } } as any;
	const writeOptions = { meta: { softDelete: 'with' } } as any;

	await assert.rejects(
		() => datastore.get(meta, 1, readOptions),
		/Datastore read options\.meta contains unsupported metadata "softDelete"/
	);
	await assert.rejects(
		() => datastore.getMany(meta, [1], readOptions),
		/Datastore read options\.meta contains unsupported metadata "softDelete"/
	);
	await assert.rejects(
		() => datastore.create(meta, 1, { id: 1, handle: 'created' }, writeOptions),
		/Datastore write options\.meta contains unsupported metadata "softDelete"/
	);
	await assert.rejects(
		() => datastore.update(meta, 1, { id: 1, handle: 'updated' }, writeOptions),
		/Datastore write options\.meta contains unsupported metadata "softDelete"/
	);
	await assert.rejects(
		() => datastore.delete(meta, 1, writeOptions),
		/Datastore write options\.meta contains unsupported metadata "softDelete"/
	);
	assert.equal(calls, 0);
});

function firestoreClient(overrides: Record<string, unknown> = {}) {
	return {
		collection: () => ({}),
		getAll: async () => [],
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({
				get: async () => ({ exists: false }),
				set: async () => undefined
			}),
		...overrides
	};
}

function datastoreClient(overrides: Record<string, unknown> = {}) {
	return {
		key: (input: unknown) => input,
		get: async () => [undefined],
		save: async () => undefined,
		delete: async () => undefined,
		update: async () => undefined,
		createQuery: () => ({}),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		...overrides
	};
}

async function expectReadOptionsRejected(store: StoreAdapter, label: string) {
	await assert.rejects(
		() => store.get(meta, 1, { select: ['handle'] } as any),
		new RegExp(`${label} store read options does not support select`)
	);
	await assert.rejects(
		() => store.getMany(meta, [1], { native: { force: true } } as any),
		new RegExp(`${label} store read options does not support native`)
	);
	await assert.rejects(
		() => store.query(meta, emptyPlan, null as any),
		new RegExp(`${label} store read options must be a plain object`)
	);
	await assert.rejects(
		() => store.get(meta, 1, { [Symbol('select')]: ['handle'] } as any),
		new RegExp(`${label} store read options cannot contain symbol fields`)
	);
	await assert.rejects(
		() => store.query(meta, emptyPlan, { select: ['handle'] } as any),
		new RegExp(`${label} store read options\\.select must match`)
	);
	await assert.rejects(
		() => store.query(meta, emptyPlan, { select: ['__proto__'] } as any),
		new RegExp(`${label} store read options\\.select\\[0\\]`)
	);
	await assert.rejects(
		() => store.query(meta, emptyPlan, { select: new Array(1) } as any),
		new RegExp(`${label} store read options\\.select\\[0\\] is missing`)
	);
}

function modelMetaWithAccessor(property: 'name' | 'idField') {
	let calls = 0;
	const next = { ...meta };
	Object.defineProperty(next, property, {
		enumerable: true,
		configurable: true,
		get() {
			calls++;
			return property === 'name' ? meta.name : meta.idField;
		}
	});
	return {
		model: next as ResolvedModelMeta<ReadOptionData>,
		calls: () => calls
	};
}

function modelMetaWithHidden(property: 'name' | 'idField') {
	const next = { ...meta };
	Object.defineProperty(next, property, {
		enumerable: false,
		configurable: true,
		value: meta[property]
	});
	return next as ResolvedModelMeta<ReadOptionData>;
}

function modelMetaWithMalformedContainer(property: 'fieldTypes' | 'indexes') {
	return { ...meta, [property]: property === 'fieldTypes' ? { get: () => 'number' } : {} } as any;
}

async function expectModelMetadataAccessorsRejected(
	store: StoreAdapter,
	label: string,
	backendCalls: () => number
) {
	const nameAccessor = modelMetaWithAccessor('name');
	await assert.rejects(
		() => store.get(nameAccessor.model, 1),
		new RegExp(`${label} model metadata\\.name must be a data property`)
	);
	assert.equal(nameAccessor.calls(), 0);

	const idFieldAccessor = modelMetaWithAccessor('idField');
	await assert.rejects(
		() => store.query(idFieldAccessor.model, emptyPlan),
		new RegExp(`${label} model metadata\\.idField must be a data property`)
	);
	assert.equal(idFieldAccessor.calls(), 0);

	await assert.rejects(
		() => store.get(modelMetaWithHidden('name'), 1),
		new RegExp(`${label} model metadata\\.name must be enumerable`)
	);
	await assert.rejects(
		() => store.query(modelMetaWithHidden('idField'), emptyPlan),
		new RegExp(`${label} model metadata\\.idField must be enumerable`)
	);
	await assert.rejects(
		() => store.query({ ...meta, idField: 'profile.id' } as any, emptyPlan),
		new RegExp(`${label} model metadata\\.idField "profile\\.id" must be a top-level field`)
	);
	await assert.rejects(
		() => store.query(modelMetaWithMalformedContainer('fieldTypes'), emptyPlan),
		new RegExp(`${label} model metadata\\.fieldTypes must be a Map`)
	);
	await assert.rejects(
		() => store.query(modelMetaWithMalformedContainer('indexes'), emptyPlan),
		new RegExp(`${label} model metadata\\.indexes must be an array`)
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				fieldTypes: new Map([['score', 'money']])
			} as any, emptyPlan),
		new RegExp(`${label} model metadata\\.fieldTypes\\.score must be a valid field type`)
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				fieldTypes: new Map([[Symbol('score'), 'number']])
			} as any, emptyPlan),
		new RegExp(`${label} model metadata\\.fieldTypes key must be a string`)
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				fieldCodecs: new Map([['handle', { name: 'bad_codec', encode: (value: unknown) => value }]])
			} as any, emptyPlan),
		new RegExp(`${label} model metadata\\.fieldCodecs\\.handle\\.decode must be a function`)
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				fieldCodecs: new Map([['handle', { name: 'bad_codec', encode: (value: unknown) => value, decode: (value: unknown) => value, decod: true }]])
			} as any, emptyPlan),
		new RegExp(`${label} model metadata\\.fieldCodecs\\.handle contains unknown option "decod"`)
	);
	const codec = {
		name: 'direct_metadata_codec',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};
	await assert.rejects(
		() =>
			store.query({
				...meta,
				fieldCodecs: new Map([['id', codec]])
			} as any, emptyPlan),
		/Field codec cannot be registered on id field "id" for read_option_record/
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				fieldTypes: new Map([['id', 'number']])
			} as any, emptyPlan),
		/Field type cannot be registered on id field "id" for read_option_record/
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				fieldCodecs: new Map([['profile', codec]]),
				fieldTypes: new Map([['profile.seenAt', 'date']])
			} as any, emptyPlan),
		/field transform paths for read_option_record cannot include both "profile" and nested field "profile\.seenAt"/
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				indexes: [{ name: 'by_handle', fields: ['handle'], uniq: true }]
			} as any, emptyPlan),
		new RegExp(`${label} model metadata\\.indexes\\[0\\] contains unknown option "uniq"`)
	);
	await assert.rejects(
		() =>
			store.query({
				...meta,
				searchIndexes: [{ name: 'by_handle', fields: ['handle'], adaptor: 'memory' }]
			} as any, emptyPlan),
		new RegExp(`${label} model metadata\\.searchIndexes\\[0\\] contains unknown option "adaptor"`)
	);
	assert.equal(backendCalls(), 0);
}

test('built-in store adapters reject unsupported direct read options', async () => {
	const memory = new MemoryStoreAdapter();
	await memory.create(meta, 1, { id: 1, handle: 'memory' });
	await expectReadOptionsRejected(memory, 'memory');
	assert.equal(memory.stats.get, 0);
	assert.equal(memory.stats.getMany, 0);
	assert.equal(memory.stats.query, 0);

	let datastoreCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: any) => input,
			get: async () => {
				datastoreCalls++;
				return [undefined];
			},
			createQuery: () => {
				datastoreCalls++;
				return {};
			}
		})
	});
	await expectReadOptionsRejected(datastore, 'Datastore');
	assert.equal(datastoreCalls, 0);

	let firestoreCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => {
				firestoreCalls++;
				return {};
			},
			getAll: async () => {
				firestoreCalls++;
				return [];
			}
		})
	});
	await expectReadOptionsRejected(firestore, 'Firestore');
	assert.equal(firestoreCalls, 0);

	let mongoCalls = 0;
	const mongo = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => {
					mongoCalls++;
					return {};
				}
			})
		}
	});
	await expectReadOptionsRejected(mongo, 'MongoDB');
	assert.equal(mongoCalls, 0);

	let postgresCalls = 0;
	const postgres = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				postgresCalls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});
	await expectReadOptionsRejected(postgres, 'PostgreSQL');
	assert.equal(postgresCalls, 0);
});

test('built-in store adapters validate direct single ids before backend calls', async () => {
	const unsafeId = {} as any;
	const unsafeRow = { id: unsafeId, handle: 'unsafe' } as any;
	const expected = /read_option_record store id must be a string or safe integer/;

	const memory = new MemoryStoreAdapter();
	await assert.rejects(() => memory.get(meta, unsafeId), expected);
	await assert.rejects(() => memory.create(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => memory.update(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => memory.delete(meta, unsafeId), expected);
	assert.deepEqual(memory.stats, {
		get: 0,
		getMany: 0,
		query: 0,
		aggregate: 0,
		create: 0,
		update: 0,
		delete: 0
	});

	let datastoreCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: () => {
				datastoreCalls++;
				return {};
			},
			insert: async () => {
				datastoreCalls++;
			},
			update: async () => {
				datastoreCalls++;
			},
			delete: async () => {
				datastoreCalls++;
			}
		})
	});
	await assert.rejects(() => datastore.get(meta, unsafeId), expected);
	await assert.rejects(() => datastore.create(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => datastore.update(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => datastore.delete(meta, unsafeId), expected);
	assert.equal(datastoreCalls, 0);

	let firestoreCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => {
				firestoreCalls++;
				return {};
			}
		})
	});
	await assert.rejects(() => firestore.get(meta, unsafeId), expected);
	await assert.rejects(() => firestore.create(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => firestore.update(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => firestore.delete(meta, unsafeId), expected);
	assert.equal(firestoreCalls, 0);

	let mongoCalls = 0;
	const mongo = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => {
					mongoCalls++;
					return {};
				}
			})
		}
	});
	await assert.rejects(() => mongo.get(meta, unsafeId), expected);
	await assert.rejects(() => mongo.create(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => mongo.update(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => mongo.delete(meta, unsafeId), expected);
	assert.equal(mongoCalls, 0);

	let postgresCalls = 0;
	const postgres = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				postgresCalls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});
	await assert.rejects(() => postgres.get(meta, unsafeId), expected);
	await assert.rejects(() => postgres.create(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => postgres.update(meta, unsafeId, unsafeRow), expected);
	await assert.rejects(() => postgres.delete(meta, unsafeId), expected);
	assert.equal(postgresCalls, 0);
});

test('built-in store adapters reject accessor-backed direct model metadata before backend calls', async () => {
	const memory = new MemoryStoreAdapter();
	await expectModelMetadataAccessorsRejected(
		memory,
		'memory store',
		() => memory.stats.get + memory.stats.query
	);

	let datastoreCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: () => {
				datastoreCalls++;
				return {};
			},
			createQuery: () => {
				datastoreCalls++;
				return {};
			},
			runQuery: async () => {
				datastoreCalls++;
				return [[], {}];
			}
		})
	});
	await expectModelMetadataAccessorsRejected(datastore, 'Datastore', () => datastoreCalls);

	let firestoreCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => {
				firestoreCalls++;
				return {};
			},
			getAll: async () => {
				firestoreCalls++;
				return [];
			}
		})
	});
	await expectModelMetadataAccessorsRejected(firestore, 'Firestore', () => firestoreCalls);

	let mongoCalls = 0;
	const mongo = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => {
					mongoCalls++;
					return {};
				}
			})
		}
	});
	await expectModelMetadataAccessorsRejected(mongo, 'MongoDB', () => mongoCalls);

	let postgresCalls = 0;
	const postgres = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				postgresCalls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});
	await expectModelMetadataAccessorsRejected(postgres, 'PostgreSQL', () => postgresCalls);
});

test('memory store seed rejects accessor-backed direct model metadata', async () => {
	const memory = new MemoryStoreAdapter();

	const nameAccessor = modelMetaWithAccessor('name');
	await assert.rejects(
		() => memory.seed(nameAccessor.model, []),
		/memory store seed model metadata\.name must be a data property/
	);
	assert.equal(nameAccessor.calls(), 0);

	const idFieldAccessor = modelMetaWithAccessor('idField');
	await assert.rejects(
		() => memory.seed(idFieldAccessor.model, []),
		/memory store seed model metadata\.idField must be a data property/
	);
	assert.equal(idFieldAccessor.calls(), 0);
	await assert.rejects(
		() => memory.seed(meta, [{ handle: 'missing id' }] as any),
		/read_option_record seed row is missing id field "id"/
	);
	await assert.rejects(
		() => memory.seed('read_option_record', [{ handle: 'missing id' }] as any),
		/read_option_record seed row is missing id field "id"/
	);
	await assert.rejects(
		() => memory.seed(meta, [{ id: { nested: 1 }, handle: 'bad id' }] as any),
		/read_option_record seed row\.id must be a string or safe integer/
	);
	assert.deepEqual(memory.snapshot(), {});
});

test('store option normalizers ignore inherited option keys', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(meta, 1, { id: 1, handle: 'created' });

	Object.defineProperty(Object.prototype, 'select', {
		value: ['handle'],
		configurable: true
	});
	try {
		assert.deepEqual(await store.get(meta, 1, {}), { id: 1, handle: 'created' });
		assert.deepEqual((await store.query(meta, emptyPlan, {})).list, [{ id: 1, handle: 'created' }]);
	} finally {
		delete (Object.prototype as Record<string, unknown>).select;
	}
	await assert.rejects(
		() => store.get(meta, 1, { selec: ['handle'] } as any),
		/memory store read options contains unknown option "selec"/
	);

	Object.defineProperty(Object.prototype, 'expectedVersion', {
		value: 99,
		configurable: true
	});
	try {
		await store.update(meta, 1, { id: 1, handle: 'updated' }, {});
		assert.deepEqual(await store.get(meta, 1), { id: 1, handle: 'updated' });
	} finally {
		delete (Object.prototype as Record<string, unknown>).expectedVersion;
	}
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, handle: 'typo' }, { expectedVerison: 0 } as any),
		/memory store write options contains unknown option "expectedVerison"/
	);

	let getterCalls = 0;
	const accessorReadOptions = Object.defineProperty({}, 'select', {
		enumerable: true,
		get() {
			getterCalls++;
			return ['handle'];
		}
	});
	await assert.rejects(
		() => store.get(meta, 1, accessorReadOptions as any),
		/store option "select" must be a data property/
	);
	assert.equal(getterCalls, 0);

	const hiddenReadOptions = Object.defineProperty({}, 'select', {
		enumerable: false,
		value: ['handle']
	});
	await assert.rejects(
		() => store.get(meta, 1, hiddenReadOptions as any),
		/store option "select" must be enumerable/
	);

	const hiddenWriteOptions = Object.defineProperty({}, 'expectedVersion', {
		enumerable: false,
		value: 99
	});
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, handle: 'hidden' }, hiddenWriteOptions as any),
		/store option "expectedVersion" must be enumerable/
	);

	let selectMapCalls = 0;
	const customSelect = ['handle'] as any[];
	Object.defineProperty(customSelect, 'map', {
		value() {
			selectMapCalls++;
			throw new Error('custom read option select map should not run');
		}
	});
	await assert.rejects(
		() => store.get(meta, 1, { select: customSelect } as any),
		/memory store read options does not support select read options/
	);
	assert.equal(selectMapCalls, 0);

	const accessorQueryPlan = Object.defineProperty({ ...emptyPlan }, 'limit', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(
		() => store.query(meta, accessorQueryPlan as any),
		/memory query plan\.limit must be a data property/
	);
	assert.equal(getterCalls, 0);

	await assert.rejects(
		() => store.query(meta, { ...emptyPlan, [Symbol('plan')]: true } as any),
		/memory query plan cannot contain symbol fields/
	);
	await assert.rejects(
		() => store.query(meta, { ...emptyPlan, limt: 1 } as any),
		/memory query plan contains unknown option "limt"/
	);
	const hiddenPlan = { ...emptyPlan };
	Object.defineProperty(hiddenPlan, 'limit', { value: 1, enumerable: false });
	await assert.rejects(
		() => store.query(meta, hiddenPlan as any),
		/memory query plan\.limit must be enumerable/
	);
	const hiddenWhereEntry = { field: 'handle', op: '=', value: 'a' };
	Object.defineProperty(hiddenWhereEntry, 'debug', { value: true, enumerable: false });
	await assert.rejects(
		() => store.query(meta, { ...emptyPlan, where: [hiddenWhereEntry] } as any),
		/memory query plan\.where\[0\]\.debug must be enumerable/
	);
	await assert.rejects(
		() => store.query(meta, { ...emptyPlan, where: [{ field: 'handle', op: '=', value: 'a', val: 'b' }] } as any),
		/memory query plan\.where\[0\] contains unknown option "val"/
	);
	await assert.rejects(
		() => store.query(meta, { ...emptyPlan, sort: [{ field: 'handle', directon: 'desc' }] } as any),
		/memory query plan\.sort\[0\] contains unknown option "directon"/
	);
	await assert.rejects(
		() => store.query(meta, { ...emptyPlan, native: { payload: {}, adaptor: 'memory' } } as any),
		/memory query plan\.native contains unknown option "adaptor"/
	);
	await assert.rejects(
		() =>
			store.query(meta, {
				...emptyPlan,
				or: [{ where: [{ field: 'handle', op: '=', value: 'a' }], or: [], sort: ['handle'], include: [] }]
			} as any),
		/memory query plan\.or\[0\]\.sort must be empty/
	);
	const hiddenAggregatePlan = { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] };
	Object.defineProperty(hiddenAggregatePlan, 'meta', { value: { debug: true }, enumerable: false });
	await assert.rejects(
		() => store.aggregate(meta, hiddenAggregatePlan as any),
		/memory aggregate plan\.meta must be enumerable/
	);
	await assert.rejects(
		() => store.aggregate(meta, { where: [], or: [], aggregats: [{ op: 'count', as: 'count' }] } as any),
		/memory aggregate plan contains unknown option "aggregats"/
	);
	await assert.rejects(
		() => store.aggregate(meta, { where: [], or: [], aggregates: [{ op: 'count', as: 'count', filed: 'id' }] } as any),
		/Aggregate spec at index 0 contains unknown option "filed"/
	);
});

test('built-in store adapters reject unsafe direct model names before backend calls', async () => {
	const badMeta = { ...meta, name: '__reserved' };
	const memory = new MemoryStoreAdapter();
	await assert.rejects(() => memory.get(badMeta, 1), /memory store model metadata\.name/);

	let datastoreCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: () => {
				datastoreCalls++;
				return {};
			},
			createQuery: () => {
				datastoreCalls++;
				return {};
			},
			runQuery: async () => [[], {}]
		})
	});
	await assert.rejects(() => datastore.get(badMeta, 1), /Datastore model metadata\.name/);
	await assert.rejects(() => datastore.query(badMeta, emptyPlan), /Datastore model metadata\.name/);
	assert.equal(datastoreCalls, 0);
	const longMeta = { ...meta, name: 'a'.repeat(64) };
	await assert.rejects(() => datastore.get(longMeta, 1), /Datastore kind name .*too long/);
	assert.equal(datastoreCalls, 0);

	let firestoreCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => {
				firestoreCalls++;
				return {};
			},
			getAll: async () => []
		})
	});
	await assert.rejects(() => firestore.get(badMeta, 1), /Firestore model metadata\.name/);
	assert.equal(firestoreCalls, 0);
	await assert.rejects(() => firestore.get(longMeta, 1), /Firestore collection name .*too long/);
	assert.equal(firestoreCalls, 0);

	let mongoCalls = 0;
	const mongo = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => {
					mongoCalls++;
					return {};
				}
			})
		}
	});
	await assert.rejects(() => mongo.get(badMeta, 1), /MongoDB model metadata\.name/);
	assert.equal(mongoCalls, 0);
	await assert.rejects(() => mongo.get(longMeta, 1), /MongoDB collection name .*too long/);
	assert.equal(mongoCalls, 0);

	let postgresCalls = 0;
	const postgres = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				postgresCalls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});
	await assert.rejects(() => postgres.get(badMeta, 1), /PostgreSQL model metadata\.name/);
	assert.equal(postgresCalls, 0);
	await assert.rejects(() => postgres.get(longMeta, 1), /PostgreSQL table name .*too long/);
	assert.equal(postgresCalls, 0);
});

test('built-in store adapters normalize direct query plans before backend calls', async () => {
	const memory = new MemoryStoreAdapter();
	await assert.rejects(
		() =>
			memory.query(meta, {
				...emptyPlan,
				where: [{ field: '__proto__', op: '=', value: 'polluted' }]
			} as any),
		/memory query plan\.where\[0\]\.field/
	);
	assert.equal(memory.stats.query, 0);
	let mapCalls = 0;
	const mappedWhere = [{ field: 'handle', op: '=', value: 'a' }] as any[];
	Object.defineProperty(mappedWhere, 'map', {
		configurable: true,
		value() {
			mapCalls++;
			return [];
		}
	});
	await memory.query(meta, { ...emptyPlan, where: mappedWhere } as any);
	assert.equal(mapCalls, 0);
	const symbolSort = [] as any[];
	Object.defineProperty(symbolSort, Symbol.iterator, {
		configurable: true,
		value: function* () {
			yield 'polluted';
		}
	});
	await assert.rejects(
		() => memory.query(meta, { ...emptyPlan, sort: symbolSort } as any),
		/memory query plan\.sort cannot contain symbol fields/
	);

	let postgresCalls = 0;
	const postgres = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				postgresCalls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});
	await assert.rejects(
		() => postgres.query(meta, { ...emptyPlan, select: ['handle'] } as any),
		/Store adapter "postgresql" does not support select/
	);
	assert.equal(postgresCalls, 0);

	let mongoCollections = 0;
	const mongo = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => {
					mongoCollections++;
					return {};
				}
			})
		}
	});
	await assert.rejects(
		() => mongo.query(meta, { ...emptyPlan, cursor: 'cursor-1' } as any),
		/Store adapter "mongodb" does not support active-ts keyset cursor pagination/
	);
	assert.equal(mongoCollections, 0);

	let firestoreCollections = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => {
				firestoreCollections++;
				return {};
			},
			getAll: async () => []
		})
	});
	await assert.rejects(
		() =>
			firestore.query(meta, {
				...emptyPlan,
				or: [{ where: [{ field: 'handle', op: '=', value: 'a' }], or: [], sort: [], include: [] }]
			} as any),
		/Store adapter "firestore" does not support orWhere/
	);
	assert.equal(firestoreCollections, 0);

	let datastoreQueries = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: any) => input,
			createQuery: () => {
				datastoreQueries++;
				return {};
			},
			runQuery: async () => [[], {}]
		})
	});
	assert.deepEqual(
		await datastore.query(meta, { ...emptyPlan, select: ['profile.name'] } as any),
		{ list: [], more: false }
	);
	assert.equal(datastore.capabilities?.nestedFields, true);
	assert.equal(datastoreQueries, 1);
});
