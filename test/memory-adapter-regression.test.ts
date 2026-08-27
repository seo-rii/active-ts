import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsValidationError,
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	defineModel,
	type ResolvedModelMeta
} from '../src/index.js';
import { FIELD_CODEC_QUERY_OPERANDS_ENCODED } from '../src/core/field-codecs.js';

type MemoryIsolationData = {
	id: number;
	name: string;
	profile: { city: string };
};

type MemoryCodecData = {
	id: number;
	token: string;
	score: number;
};

class MemoryCodecRecord extends Model<MemoryCodecData> {}

const tokenCodec = {
	name: 'memory-token-codec',
	encode: (value: unknown) => `stored:${String(value)}`,
	decode: (value: unknown) => String(value).replace(/^stored:/, ''),
	encodeQuery: (value: unknown) => `stored:${String(value)}`
};

defineModel<MemoryCodecData>('memory_codec_record')
	.id('id')
	.validate((input) => input as MemoryCodecData)
	.fieldCodec('token', tokenCodec)
	.attach(MemoryCodecRecord);

const meta: ResolvedModelMeta<MemoryIsolationData> = {
	model: class {},
	name: 'memory_isolation_record',
	store: 'memory',
	idField: 'id',
	readValidation: 'off',
	indexes: [],
	searchIndexes: [{ name: 'name', adapter: 'memory', fields: ['name', 'profile.city'] }],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map(),
	fieldTypes: new Map()
};

const codecMeta: ResolvedModelMeta<MemoryCodecData> = {
	model: MemoryCodecRecord,
	name: 'memory_codec_record',
	store: 'memory',
	idField: 'id',
	readValidation: 'off',
	indexes: [],
	searchIndexes: [],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map([['token', tokenCodec]]),
	fieldTypes: new Map()
};

test('memory store returns cloned rows from direct reads and queries', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(meta, 1, { id: 1, name: 'one', profile: { city: 'Seoul' } });

	const first = await store.get(meta, 1);
	first!.profile.city = 'Busan';
	assert.equal((await store.get(meta, 1))!.profile.city, 'Seoul');

	const [many] = await store.getMany(meta, [1]);
	many!.profile.city = 'Incheon';
	assert.equal((await store.get(meta, 1))!.profile.city, 'Seoul');

	const idsWithMetadata = [1] as any[];
	(idsWithMetadata as any).extra = 2;
	await assert.rejects(
		() => store.getMany(meta, idsWithMetadata as any),
		/memory store ids cannot contain non-index array property "extra"/
	);

	const queried = await store.query(meta, { where: [], or: [], sort: [], include: [] });
	queried.list[0].profile.city = 'Daegu';
	assert.equal((await store.get(meta, 1))!.profile.city, 'Seoul');
});

test('memory store and search miss paths do not materialize empty state', async () => {
	const store = new MemoryStoreAdapter();

	assert.equal(await store.get(meta, 1), null);
	assert.deepEqual(await store.getMany(meta, [1]), [null]);
	assert.deepEqual(await store.query(meta, { where: [], or: [], sort: [], include: [] }), {
		list: [],
		cursor: undefined,
		more: false,
		count: 0
	});
	assert.deepEqual(await store.aggregate(meta, {
		where: [],
		or: [],
		aggregates: [{ op: 'count', as: 'count' }]
	}), { count: 0 });
	await store.delete(meta, 1);
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, name: 'missing', profile: { city: 'Seoul' } }),
		ActiveTsNotFoundError
	);
	assert.deepEqual(store.snapshot(), {});
	assert.deepEqual(await store.schema.plan([meta]), {
		adapter: 'memory',
		changes: [{ type: 'create-collection', target: meta.name }]
	});

	const search = new MemorySearchAdapter();
	assert.deepEqual(await search.search(meta, 'one'), {
		list: [],
		more: false,
		count: 0,
		total: 0
	});
	await search.delete(meta, 1);
	assert.deepEqual(search.snapshot(), {});
});

test('memory store helper paths ignore patched Array transforms', async () => {
	const store = new MemoryStoreAdapter();
	const originalMap = Array.prototype.map;
	const originalFilter = Array.prototype.filter;
	const originalFlatMap = Array.prototype.flatMap;
	let dump: unknown;
	let snapshot: unknown;
	let plan: unknown;
	let uniqueError: unknown;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'filter', {
		configurable: true,
		value() {
			throw new Error('patched Array.filter');
		}
	});
	Object.defineProperty(Array.prototype, 'flatMap', {
		configurable: true,
		value() {
			throw new Error('patched Array.flatMap');
		}
	});
	try {
		await store.seed(meta, [{ id: 1, name: 'one', profile: { city: 'Seoul' } }]);
		dump = store.dump(meta.name);
		snapshot = store.snapshot();
		plan = await store.schema.plan([meta]);
		try {
			await store.schema.plan([
				{
					...meta,
					indexes: [{ name: 'unique_name', fields: ['name'], unique: true }]
				}
			]);
		} catch (error) {
			uniqueError = error;
		}
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: originalMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: originalFilter });
		Object.defineProperty(Array.prototype, 'flatMap', { configurable: true, value: originalFlatMap });
	}
	assert.deepEqual(dump, [{ id: 1, name: 'one', profile: { city: 'Seoul' } }]);
	assert.deepEqual(snapshot, { [meta.name]: [{ id: 1, name: 'one', profile: { city: 'Seoul' } }] });
	assert.deepEqual(plan, { adapter: 'memory', changes: [] });
	assert.match((uniqueError as Error)?.message, /does not support unique indexes/);
});

test('memory store normalizes direct mixed nested OR plans with global constraints', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed(meta, [
		{ id: 1, name: 'a-open', tenantId: 'a', status: 'open', profile: { city: 'Seoul' } },
		{ id: 2, name: 'b-pending', tenantId: 'b', status: 'pending', profile: { city: 'Busan' } },
		{ id: 3, name: 'a-pending', tenantId: 'a', status: 'pending', profile: { city: 'Incheon' } },
		{ id: 4, name: 'b-missing', tenantId: 'b', status: 'missing', profile: { city: 'Daegu' } }
	] as any);

	const result = await store.query(meta, {
		where: [{ field: 'tenantId', op: '=', value: 'a' }],
		or: [
			{
				where: [{ field: 'status', op: '=', value: 'missing' }],
				or: [
					{
						where: [{ field: 'status', op: '=', value: 'pending' }],
						or: [],
						sort: [],
						include: []
					}
				],
				sort: [],
				include: []
			}
		],
		sort: ['id'],
		include: []
	} as any);

	assert.deepEqual(result.list.map((item) => item.id), [3]);
});

test('memory store encodes direct field-codec query operands once', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(codecMeta, 1, { id: 1, token: 'stored:alpha', score: 10 });
	await store.create(codecMeta, 2, { id: 2, token: 'stored:beta', score: 20 });

	const direct = await store.query(codecMeta, {
		where: [{ field: 'token', op: '=', value: 'alpha' }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(direct.list.map((item) => item.id), [1]);

	const aggregate = await store.aggregate(codecMeta, {
		where: [{ field: 'token', op: '=', value: 'alpha' }],
		or: [],
		aggregates: [{ op: 'sum', field: 'score', as: 'scoreSum' }]
	});
	assert.deepEqual(aggregate, { scoreSum: 10 });

	const context = createActiveTs({ stores: { default: store } });
	const Record = MemoryCodecRecord.use(context) as typeof MemoryCodecRecord;
	const throughCore = await Record.where({ token: 'alpha' }).load();
	assert.deepEqual(throughCore.list.map((item) => item.id), [1]);
});

test('memory store rejects forged field-codec encoded markers on direct plans', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(codecMeta, 1, { id: 1, token: 'stored:alpha', score: 10 });

	const queryPlan = {
		where: [{ field: 'token', op: '=', value: 'alpha' }],
		or: [],
		sort: [],
		include: []
	};
	Object.defineProperty(queryPlan, FIELD_CODEC_QUERY_OPERANDS_ENCODED, {
		value: true,
		enumerable: false
	});

	await assert.rejects(
		() => store.query(codecMeta, queryPlan as any),
		/field codec query operand marker is not trusted/
	);

	const aggregatePlan = {
		where: [{ field: 'token', op: '=', value: 'alpha' }],
		or: [],
		aggregates: [{ op: 'sum', field: 'score', as: 'scoreSum' }]
	};
	Object.defineProperty(aggregatePlan, FIELD_CODEC_QUERY_OPERANDS_ENCODED, {
		value: true,
		enumerable: false
	});

	await assert.rejects(
		() => store.aggregate(codecMeta, aggregatePlan as any),
		/field codec query operand marker is not trusted/
	);
});

test('memory store rejects forged field-codec markers with polluted WeakSet methods', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(codecMeta, 1, { id: 1, token: 'stored:alpha', score: 10 });
	const weakSetHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'has')!;
	const weakSetAdd = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'add')!;
	try {
		Object.defineProperty(WeakSet.prototype, 'has', {
			value() {
				return true;
			}
		});
		Object.defineProperty(WeakSet.prototype, 'add', {
			value() {
				throw new Error('patched WeakSet.add should not run');
			}
		});
		const queryPlan = {
			where: [{ field: 'token', op: '=', value: 'alpha' }],
			or: [],
			sort: [],
			include: []
		};
		Object.defineProperty(queryPlan, FIELD_CODEC_QUERY_OPERANDS_ENCODED, {
			value: true,
			enumerable: false
		});

		await assert.rejects(
			() => store.query(codecMeta, queryPlan as any),
			/field codec query operand marker is not trusted/
		);
	} finally {
		Object.defineProperty(WeakSet.prototype, 'has', weakSetHas);
		Object.defineProperty(WeakSet.prototype, 'add', weakSetAdd);
	}
});

test('memory store direct codec queries fail fast without encodeQuery', async () => {
	const store = new MemoryStoreAdapter();
	const noQueryMeta: ResolvedModelMeta<MemoryCodecData> = {
		...codecMeta,
		fieldCodecs: new Map([
			[
				'token',
				{
					name: 'memory-token-no-query-codec',
					encode: tokenCodec.encode,
					decode: tokenCodec.decode
				}
			]
		])
	};
	await store.create(noQueryMeta, 1, { id: 1, token: 'stored:alpha', score: 10 });

	await assert.rejects(
		() =>
			store.query(noQueryMeta, {
				where: [{ field: 'token', op: '=', value: 'alpha' }],
				or: [],
				sort: [],
				include: []
			}),
		/does not support portable query operands/
	);
});

test('memory store direct aggregate rejects field-codec result fields', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(codecMeta, 1, { id: 1, token: 'stored:alpha', score: 10 });

	await assert.rejects(
		() =>
			store.aggregate(codecMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'max', field: 'token', as: 'maxToken' }]
			}),
		/cannot aggregate field "token" because it overlaps field-codec field "token"/
	);
});

test('memory store rejects runtime-only values on direct writes and seeds', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(meta, 1, { id: 1, name: 'one', profile: { city: 'Seoul' } });

	await assert.rejects(
		() =>
			store.create(meta, 2, {
				id: 2,
				name: 'date',
				profile: { city: new Date('2026-05-14T00:00:00.000Z') as any }
			}),
		/stored data date/
	);
	await assert.rejects(
		() =>
			store.update(meta, 1, {
				id: 1,
				name: 'binary',
				profile: { city: new Uint8Array([1, 2, 3]) as any }
			}),
		/stored binary/
	);
	await assert.rejects(
		() =>
			store.seed(meta, [
				{
					id: 3,
					name: 'valid-before-bad',
					profile: { city: 'Seoul' }
				},
				{
					id: 4,
					name: 'seed-date',
					profile: { city: new Date('2026-05-14T00:00:00.000Z') as any }
				}
			]),
		/stored data date/
	);
	assert.deepEqual(store.dump(meta.name), [{ id: 1, name: 'one', profile: { city: 'Seoul' } }]);
});

test('memory store seed snapshots row arrays before mapping', async () => {
	const store = new MemoryStoreAdapter();
	const rows = [{ id: 1, name: 'one', profile: { city: 'Seoul' } }] as any[];
	let mapCalls = 0;
	Object.defineProperty(rows, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom rows.map should not run');
		}
	});

	await store.seed(meta, rows);

	assert.equal(mapCalls, 0);
	assert.deepEqual(store.dump(meta.name), [{ id: 1, name: 'one', profile: { city: 'Seoul' } }]);

	const symbolRows = [{ id: 2, name: 'two', profile: { city: 'Busan' } }] as any[];
	let iteratorCalls = 0;
	Object.defineProperty(symbolRows, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom rows iterator should not run');
		}
	});

	await assert.rejects(() => store.seed(meta, symbolRows), /memory store seed rows cannot contain symbol fields/);
	assert.equal(iteratorCalls, 0);
});

test('memory store seed validates model and row inputs before mutation', async () => {
	const store = new MemoryStoreAdapter();

	await assert.rejects(() => store.seed(meta, undefined as any), /seed rows must be an array/);
	await assert.rejects(() => store.seed(meta, new Array(1) as any), /memory store seed rows\[0\] is missing/);
	await assert.rejects(() => store.seed('bad/name', []), /memory store seed model name/);
	await assert.rejects(
		() => store.seed({ ...meta, idField: 'profile.city' }, [{ profile: { city: 'bad' } }]),
		/memory store seed model metadata\.idField "profile\.city" must be a top-level field/
	);
	Object.defineProperty(Object.prototype, 'id', {
		value: 9,
		writable: true,
		configurable: true
	});
	try {
		await assert.rejects(
			() => store.seed(meta, [{ name: 'inherited id', profile: { city: 'Seoul' } } as any]),
			/memory_isolation_record seed row is missing id field "id"/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).id;
	}
	assert.deepEqual(store.snapshot(), {});
});

test('memory store seed rejects duplicate ids before overwriting fixtures', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed(meta, [{ id: 1, name: 'original', profile: { city: 'Seoul' } }]);

	await assert.rejects(
		() => store.seed(meta, [{ id: 1, name: 'replacement', profile: { city: 'Busan' } }]),
		(error: unknown) =>
			error instanceof ActiveTsConflictError &&
			/Cannot seed memory_isolation_record:number:1 because it already exists/.test(error.message)
	);
	assert.deepEqual(store.dump(meta.name), [{ id: 1, name: 'original', profile: { city: 'Seoul' } }]);

	const batchStore = new MemoryStoreAdapter();
	await assert.rejects(
		() =>
			batchStore.seed(meta, [
				{ id: 2, name: 'first', profile: { city: 'Incheon' } },
				{ id: 2, name: 'second', profile: { city: 'Daegu' } }
			]),
		(error: unknown) =>
			error instanceof ActiveTsConflictError &&
			/seed batch contains duplicate ids/.test(error.message)
	);
	assert.deepEqual(batchStore.snapshot(), {});
});

test('memory store update is update-only and rejects missing rows', async () => {
	const store = new MemoryStoreAdapter();

	await assert.rejects(() => store.getMany(meta, new Array(1) as any), /memory store ids\[0\] is missing/);
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, name: 'bad options', profile: { city: 'Seoul' } }, null as any),
		/memory store write options must be a plain object/
	);
	await assert.rejects(
		() =>
			store.update(meta, 1, { id: 1, name: 'bad version', profile: { city: 'Seoul' } }, {
				expectedVersion: '1'
			} as any),
		/memory store write options\.expectedVersion/
	);
	await assert.rejects(
		() =>
			store.update(meta, 1, { id: 1, name: 'symbol options', profile: { city: 'Seoul' } }, {
				[Symbol('expectedVersion')]: 1
			} as any),
		/memory store write options cannot contain symbol fields/
	);
	await assert.rejects(
		() => store.update(meta, 404, { id: 404, name: 'missing', profile: { city: 'Seoul' } }),
		(error: unknown) =>
			error instanceof ActiveTsNotFoundError &&
			/Cannot update memory_isolation_record:404 because it does not exist/.test(error.message)
	);
	assert.deepEqual(store.dump(meta.name), []);
});

test('memory store direct writes validate payload ids before state checks', async () => {
	const store = new MemoryStoreAdapter();
	await store.create(meta, 1, { id: 1, name: 'existing', profile: { city: 'Seoul' } });

	await assert.rejects(
		() => store.create(meta, 1, { id: 2, name: 'wrong-create-id', profile: { city: 'Busan' } }),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/id field "id" must match the operation id/.test(error.message)
	);
	await assert.rejects(
		() => store.update(meta, 404, { id: 405, name: 'wrong-update-id', profile: { city: 'Incheon' } }),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/id field "id" must match the operation id/.test(error.message)
	);
	assert.deepEqual(store.dump(meta.name), [{ id: 1, name: 'existing', profile: { city: 'Seoul' } }]);
});

test('memory store optimistic locks require an own version field', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed(meta, [{ id: 10, name: 'unversioned', profile: { city: 'Seoul' } }]);
	Object.defineProperty(Object.prototype, 'version', {
		value: 1,
		configurable: true
	});
	try {
		await assert.rejects(
			() => store.update(meta, 10, { id: 10, name: 'updated', profile: { city: 'Busan' }, version: 2 } as any, { expectedVersion: 1 }),
			(error: unknown) =>
				error instanceof ActiveTsConflictError &&
				/Optimistic lock failed/.test(error.message)
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).version;
	}
	assert.deepEqual(store.dump(meta.name), [{ id: 10, name: 'unversioned', profile: { city: 'Seoul' } }]);
});

test('memory transactions reject concurrent writes after unversioned point reads', async () => {
	for (const readMany of [false, true]) {
		const store = new MemoryStoreAdapter();
		await store.seed(meta, [{ id: 20, name: 'initial', profile: { city: 'Seoul' } }]);
		let markFirstRead!: () => void;
		let releaseFirst!: () => void;
		const firstRead = new Promise<void>((resolve) => {
			markFirstRead = resolve;
		});
		const firstMayCommit = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = store.transaction(async (tx) => {
			const row = readMany ? (await tx.getMany(meta, [20]))[0] : await tx.get(meta, 20);
			assert.equal(row?.name, 'initial');
			markFirstRead();
			await firstMayCommit;
			await tx.update(meta, 20, { id: 20, name: 'first', profile: { city: 'Busan' } });
		});

		await firstRead;
		let secondError: unknown;
		try {
			await store.transaction(async (tx) => {
				assert.equal((await tx.get(meta, 20))?.name, 'initial');
				await tx.update(meta, 20, { id: 20, name: 'second', profile: { city: 'Incheon' } });
			});
		} catch (error) {
			secondError = error;
		} finally {
			releaseFirst();
		}

		await assert.rejects(
			() => first,
			(error: unknown) =>
				error instanceof ActiveTsConflictError && /transactional point read/.test(error.message)
		);
		if (secondError !== undefined) throw secondError;
		assert.deepEqual(store.dump(meta.name), [
			{ id: 20, name: 'second', profile: { city: 'Incheon' } }
		]);
	}
});

test('memory transaction conflict revisions do not depend on the global Symbol constructor', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed(meta, [{ id: 21, name: 'initial', profile: { city: 'Seoul' } }]);
	const symbolDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Symbol')!;
	const fixedSymbol = Symbol('fixed-memory-revision');
	Object.defineProperty(globalThis, 'Symbol', {
		...symbolDescriptor,
		value: new Proxy(Symbol, { apply: () => fixedSymbol })
	});
	try {
		let markFirstRead!: () => void;
		let releaseFirst!: () => void;
		const firstRead = new Promise<void>((resolve) => {
			markFirstRead = resolve;
		});
		const firstMayCommit = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = store.transaction(async (tx) => {
			const row = await tx.get(meta, 21);
			assert.equal(row?.name, 'initial');
			markFirstRead();
			await firstMayCommit;
			await tx.update(meta, 21, { id: 21, name: 'first', profile: { city: 'Busan' } });
		});

		await firstRead;
		try {
			await store.transaction(async (tx) => {
				const row = await tx.get(meta, 21);
				assert.ok(row);
				await tx.update(meta, 21, { ...row, name: 'second', profile: { city: 'Incheon' } });
			});
		} finally {
			releaseFirst();
		}

		await assert.rejects(
			() => first,
			(error: unknown) => error instanceof ActiveTsConflictError
		);
	} finally {
		Object.defineProperty(globalThis, 'Symbol', symbolDescriptor);
	}
	assert.equal((await store.get(meta, 21))?.name, 'second');
});

test('memory store retains missing-row tombstones only while an older transaction needs them', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed(meta, [
		{ id: 31, name: 'reset-one', profile: { city: 'Seoul' } },
		{ id: 32, name: 'reset-two', profile: { city: 'Busan' } }
	]);
	store.reset();
	for (let id = 100; id < 1_100; id++) {
		await store.create(meta, id, { id, name: 'temporary', profile: { city: 'Seoul' } });
		await store.delete(meta, id);
	}
	const internal = store as unknown as {
		rowRevisions: Map<string, Map<string, number>>;
		rowRevisionTombstones: Map<string, Map<string, number>>;
		activeTransactionSnapshots: Map<number, number>;
	};
	assert.equal(internal.rowRevisions.size, 0);
	assert.equal(internal.rowRevisionTombstones.size, 0);

	let markMissingRead!: () => void;
	let releaseTransaction!: () => void;
	const missingRead = new Promise<void>((resolve) => {
		markMissingRead = resolve;
	});
	const mayFinish = new Promise<void>((resolve) => {
		releaseTransaction = resolve;
	});
	const transaction = store.transaction(async (tx) => {
		assert.equal(await tx.get(meta, 30), null);
		markMissingRead();
		await mayFinish;
	});

	await missingRead;
	assert.equal(internal.activeTransactionSnapshots.size, 1);
	await store.create(meta, 30, { id: 30, name: 'created', profile: { city: 'Busan' } });
	await store.delete(meta, 30);
	assert.equal(internal.rowRevisions.get(meta.name)?.size, 1);
	assert.equal(internal.rowRevisionTombstones.get(meta.name)?.size, 1);
	releaseTransaction();

	await assert.rejects(
		() => transaction,
		(error: unknown) => error instanceof ActiveTsConflictError
	);
	assert.equal(internal.activeTransactionSnapshots.size, 0);
	assert.equal(internal.rowRevisions.size, 0);
	assert.equal(internal.rowRevisionTombstones.size, 0);
});

test('memory store row revision overflow rejects every mutation before changing data', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed(meta, [{ id: 40, name: 'original', profile: { city: 'Seoul' } }]);
	const internal = store as unknown as {
		rowRevisionGeneration: number;
		activeTransactionSnapshots: Map<number, number>;
	};
	internal.rowRevisionGeneration = Number.MAX_SAFE_INTEGER;
	const exhausted = (error: unknown) =>
		error instanceof ActiveTsConfigurationError && /row revision counter is exhausted/.test(error.message);

	await assert.rejects(
		() => store.create(meta, 41, { id: 41, name: 'new', profile: { city: 'Busan' } }),
		exhausted
	);
	await assert.rejects(
		() => store.update(meta, 40, { id: 40, name: 'updated', profile: { city: 'Busan' } }),
		exhausted
	);
	await assert.rejects(() => store.delete(meta, 40), exhausted);
	await assert.rejects(
		() =>
			store.transaction(async (tx) => {
				await tx.update(meta, 40, { id: 40, name: 'transaction', profile: { city: 'Incheon' } });
			}),
		exhausted
	);
	assert.throws(() => store.reset(), exhausted);

	assert.deepEqual(store.dump(meta.name), [
		{ id: 40, name: 'original', profile: { city: 'Seoul' } }
	]);
	assert.equal(internal.activeTransactionSnapshots.size, 0);
});

test('memory cache returns cloned values and snapshots set input values', async () => {
	const cache = new MemoryCacheAdapter();
	const value = { id: 1, profile: { city: 'Seoul' } };
	await cache.setMany([['row', value]]);
	value.profile.city = 'Busan';

	const [first] = await cache.getMany(['row']);
	assert.equal(first.profile.city, 'Seoul');
	first.profile.city = 'Incheon';
	const [second] = await cache.getMany(['row']);
	assert.equal(second.profile.city, 'Seoul');
});

test('memory cache direct operations ignore patched Array map', async () => {
	const cache = new MemoryCacheAdapter();
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	let hits: unknown[] = [];
	let snapshot: Record<string, { value: unknown; expires?: number }> = {};
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	try {
		await cache.setMany([['array-map-key', { ok: true }]]);
		hits = await cache.getMany(['array-map-key', 'array-map-miss']);
		snapshot = cache.snapshot();
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
	}

	assert.deepEqual(hits, [{ ok: true }, undefined]);
	assert.deepEqual(snapshot['array-map-key'].value, { ok: true });
});

test('memory search returns cloned indexed documents', async () => {
	const search = new MemorySearchAdapter();
	await search.index(meta, 1, { id: 1, name: 'one', profile: { city: 'Seoul' } });

	const result = await search.search(meta, 'one');
	result.list[0].profile.city = 'Busan';
	const second = await search.search(meta, 'one');
	assert.equal(second.list[0].profile.city, 'Seoul');
});

test('memory search direct operations ignore patched Array transforms', async () => {
	const search = new MemorySearchAdapter();
	await search.index(meta, 1, { id: 1, name: 'alpha', profile: { city: 'Seoul' } });
	await search.index(meta, 2, { id: 2, name: 'alpha', profile: { city: 'Busan' } });
	const originals = {
		map: Object.getOwnPropertyDescriptor(Array.prototype, 'map')!,
		filter: Object.getOwnPropertyDescriptor(Array.prototype, 'filter')!,
		some: Object.getOwnPropertyDescriptor(Array.prototype, 'some')!,
		slice: Object.getOwnPropertyDescriptor(Array.prototype, 'slice')!
	};
	let result: Awaited<ReturnType<MemorySearchAdapter['search']>> | undefined;
	let snapshot: unknown;
	Object.defineProperties(Array.prototype, {
		map: {
			configurable: true,
			value() {
				throw new Error('patched Array.map');
			}
		},
		filter: {
			configurable: true,
			value() {
				throw new Error('patched Array.filter');
			}
		},
		some: {
			configurable: true,
			value() {
				throw new Error('patched Array.some');
			}
		},
		slice: {
			configurable: true,
			value() {
				throw new Error('patched Array.slice');
			}
		}
	});
	try {
		result = await search.search(meta, 'alpha', { limit: 1 });
		snapshot = search.snapshot();
	} finally {
		Object.defineProperties(Array.prototype, {
			map: originals.map,
			filter: originals.filter,
			some: originals.some,
			slice: originals.slice
		});
	}

	assert.equal(result?.count, 1);
	assert.equal(result?.total, 2);
	assert.equal(result?.more, true);
	assert.deepEqual((snapshot as Record<string, unknown[]>)[meta.name].length, 2);
});

test('memory test snapshots do not create missing collections or indexes', () => {
	const store = new MemoryStoreAdapter();
	assert.deepEqual(store.dump('missing_collection'), []);
	assert.deepEqual(store.snapshot(), {});
	assert.throws(() => store.dump('__unsafe'), /memory collection name/);

	const search = new MemorySearchAdapter();
	assert.deepEqual(search.snapshot('missing_index'), []);
	assert.deepEqual(search.snapshot(), {});
	assert.throws(() => search.snapshot('__unsafe'), /memory search model name/);
	assert.throws(() => search.clear('__unsafe'), /memory search model name/);
	assert.deepEqual(search.snapshot(), {});
});
