import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsValidationError,
	createActiveTs,
	type AggregatePlan,
	type QueryPlan,
	type QueryResult,
	type ResolvedModelMeta,
	type StoreAdapter
} from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';

type PostgresRegressionData = {
	id: number;
	handle: string;
};

const meta: ResolvedModelMeta<PostgresRegressionData> = {
	model: class {},
	name: 'postgres_regression_record',
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

const postgresTokenCodec = {
	name: 'postgres-token-codec',
	encode: (value: unknown) => `stored:${String(value)}`,
	decode: (value: unknown) => String(value).replace(/^stored:/, ''),
	encodeQuery: (value: unknown) => `stored:${String(value)}`
};

const codecMeta: ResolvedModelMeta<PostgresRegressionData> = {
	...meta,
	fieldCodecs: new Map([['handle', postgresTokenCodec]])
};

const postgresActiveTableColumns = [
	{ column_name: 'id', udt_name: 'text', data_type: 'text', is_nullable: 'NO' },
	{ column_name: 'data', udt_name: 'jsonb', data_type: 'jsonb', is_nullable: 'NO' },
	{ column_name: 'created_at', udt_name: 'timestamptz', data_type: 'timestamp with time zone', is_nullable: 'NO' },
	{ column_name: 'updated_at', udt_name: 'timestamptz', data_type: 'timestamp with time zone', is_nullable: 'NO' }
];
const postgresActivePrimaryKey = [{ column_name: 'id' }];

test('PostgreSQL adapter ignores inherited backend result containers', async () => {
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({})
		}
	});

	Object.defineProperties(Object.prototype, {
		rows: { value: [{ id: 'number:1', data: { id: 1, handle: 'polluted' } }], configurable: true },
		rowCount: { value: 1, configurable: true }
	});
	try {
		await assert.rejects(() => adapter.get(meta, 1), /PostgreSQL get result\.rows is required/);
		await assert.rejects(() => adapter.query(meta, emptyPlan), /PostgreSQL query result\.rows is required/);
		await assert.rejects(
			() => adapter.update(meta, 1, { id: 1, handle: 'missing' }),
			/PostgreSQL update result\.rowCount is required/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).rows;
		delete (Object.prototype as Record<string, unknown>).rowCount;
	}
});

test('PostgreSQL adapter requires own backend row fields', async () => {
	let nextResult: unknown = { rows: [], rowCount: 0 };
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => nextResult
		}
	});

	nextResult = { rows: [Object.create({ id: 'number:1', data: { id: 1, handle: 'inherited' } })], rowCount: 1 };
	await assert.rejects(() => adapter.get(meta, 1), /PostgreSQL get row\.id is required/);

	nextResult = { rows: [Object.create({ id: 'number:1', data: { id: 1, handle: 'inherited' } })], rowCount: 1 };
	await assert.rejects(() => adapter.getMany(meta, [1]), /PostgreSQL getMany row\.id is required/);
	await assert.rejects(() => adapter.getMany(meta, new Array(1) as any), /PostgreSQL store ids\[0\] is missing/);

	nextResult = { rows: [Object.create({ id: 'number:1', data: { id: 1, handle: 'inherited' } })], rowCount: 1 };
	await assert.rejects(() => adapter.query(meta, emptyPlan), /PostgreSQL query row\.id is required/);

	nextResult = { rows: null, rowCount: 0 };
	await assert.rejects(() => adapter.query(meta, emptyPlan), /PostgreSQL query result\.rows must be an array/);
	nextResult = { rows: new Array(1), rowCount: 1 };
	await assert.rejects(() => adapter.query(meta, emptyPlan), /PostgreSQL query result\.rows\[0\] is missing/);
});

test('PostgreSQL getMany requested id set uses captured collection intrinsics', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return {
					rows: [
						{ id: 'number:1', data: { id: 1, handle: 'numeric' } },
						{ id: 'string:1', data: { id: '1', handle: 'string' } }
					],
					rowCount: 2
				};
			}
		}
	});
	const setAdd = Set.prototype.add;
	Set.prototype.add = function () {
		throw new Error('patched Set.add');
	};
	try {
		assert.deepEqual(await adapter.getMany(meta as ResolvedModelMeta<any>, [1, '1']), [
			{ id: 1, handle: 'numeric' },
			{ id: '1', handle: 'string' }
		]);
	} finally {
		Set.prototype.add = setAdd;
	}

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].values, [['number:1', 'string:1']]);
});

test('PostgreSQL adapter normalizes direct query count to returned rows', async () => {
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({
				rows: [{ id: 'number:1', data: { id: 1, handle: 'one' } }],
				rowCount: 99
			})
		}
	});

	const result = await adapter.query(meta, emptyPlan);
	assert.deepEqual(result, {
		list: [{ id: 1, handle: 'one' }],
		more: false,
		count: 1
	});
});

test('PostgreSQL direct queries encode field-codec operands before backend access', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});

	await adapter.query(codecMeta, {
		where: [{ field: 'handle', op: '=', value: 'alpha' }],
		or: [],
		sort: [],
		include: []
	});

	assert.equal(calls.length, 1);
	assert.ok(calls[0].values.includes('stored:alpha'));

	const noQueryMeta: ResolvedModelMeta<PostgresRegressionData> = {
		...codecMeta,
		fieldCodecs: new Map([
			[
				'handle',
				{
					name: 'postgres-token-no-query-codec',
					encode: postgresTokenCodec.encode,
					decode: postgresTokenCodec.decode
				}
			]
		])
	};
	await assert.rejects(
		() =>
			adapter.query(noQueryMeta, {
				where: [{ field: 'handle', op: '=', value: 'alpha' }],
				or: [],
				sort: [],
				include: []
			}),
		/does not support portable query operands/
	);
	assert.equal(calls.length, 1);
});

test('PostgreSQL direct aggregate rejects field-codec result fields before backend access', async () => {
	let queryCalls = 0;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				queryCalls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});

	await assert.rejects(
		() =>
			adapter.aggregate!(codecMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'max', field: 'handle', as: 'maxHandle' }]
			}),
		/cannot aggregate field "handle" because it overlaps field-codec field "handle"/
	);
	assert.equal(queryCalls, 0);
});

test('PostgreSQL limited direct queries report more with lookahead rows without cursor support', async () => {
	const queries: string[] = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				queries.push(text);
				return {
					rows: [
						{ id: 'number:1', data: { id: 1, handle: 'one' } },
						{ id: 'number:2', data: { id: 2, handle: 'two' } }
					],
					rowCount: 1
				};
			}
		}
	});

	const result = await adapter.query(meta, { ...emptyPlan, limit: 1 });
	assert.deepEqual(result.list, [{ id: 1, handle: 'one' }]);
	assert.equal(result.count, 1);
	assert.equal(result.more, true);
	assert.equal(result.cursor, undefined);
	assert.match(queries.at(-1) ?? '', /limit 2\b/);
});

test('PostgreSQL offset queries append offset after limit lookahead', async () => {
	const queries: string[] = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				queries.push(text);
				return {
					rows: [{ id: 'number:4', data: { id: 4, handle: 'four' } }],
					rowCount: 1
				};
			}
		}
	});

	const result = await adapter.query(meta, { ...emptyPlan, offset: 3, limit: 1 });
	assert.equal(adapter.capabilities?.offset, true);
	assert.deepEqual(result.list, [{ id: 4, handle: 'four' }]);
	assert.match(queries.at(-1) ?? '', /limit 2 offset 3\b/);
});

test('PostgreSQL adapter snapshots direct model metadata maps before query planning', async () => {
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 })
		}
	});
	const fieldTypes = new Map([['handle', 'string']]) as any;
	let getCalls = 0;
	let entriesCalls = 0;
	Object.defineProperty(fieldTypes, 'get', {
		value() {
			getCalls++;
			throw new Error('custom fieldTypes.get should not run');
		}
	});
	Object.defineProperty(fieldTypes, 'entries', {
		value() {
			entriesCalls++;
			throw new Error('custom fieldTypes.entries should not run');
		}
	});
	const plan: QueryPlan = {
		where: [{ field: 'handle', op: 'startsWith', value: 'a' }],
		or: [],
		sort: [{ field: 'handle', direction: 'asc' }],
		include: []
	};

	assert.deepEqual(await adapter.query({ ...meta, fieldTypes }, plan), { list: [], more: false, count: 0 });
	assert.equal(getCalls, 0);
	assert.equal(entriesCalls, 0);
});

test('PostgreSQL adapter direct array paths ignore patched Array transforms', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const indexedMeta: ResolvedModelMeta<any> = {
		...meta,
		indexes: [{ name: 'handle_profile_idx', fields: ['handle', 'profile.name'], directions: ['asc', 'desc'] }],
		fieldTypes: new Map([['score', 'number']])
	};
	let getManyResult: unknown;
	let nativeQueryResult: unknown;
	let queryResult: unknown;
	let aggregateResult: unknown;
	let schemaPlan: unknown;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				if (text.includes('information_schema.tables')) return { rows: [{}], rowCount: 1 };
				if (text.includes('information_schema.columns')) return { rows: postgresActiveTableColumns, rowCount: 4 };
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: postgresActivePrimaryKey, rowCount: 1 };
				if (text.includes('pg_indexes')) return { rows: [], rowCount: 0 };
				if (text.includes('where id = any')) {
					return { rows: [{ id: 'number:1', data: { id: 1, handle: 'one', score: 3 } }], rowCount: 1 };
				}
				if (text === 'select data from postgres_regression_record') {
					return { rows: [{ data: { id: 2, handle: 'native', score: 4 } }], rowCount: 1 };
				}
				if (text.includes('select coalesce(sum')) {
					return { rows: [{ total: 10 }], rowCount: 1 };
				}
				if (text.startsWith('select id, data from')) {
					return { rows: [{ id: 'number:3', data: { id: 3, handle: 'query', score: 7 } }], rowCount: 1 };
				}
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const descriptors = {
		map: Object.getOwnPropertyDescriptor(Array.prototype, 'map'),
		filter: Object.getOwnPropertyDescriptor(Array.prototype, 'filter'),
		flatMap: Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap'),
		some: Object.getOwnPropertyDescriptor(Array.prototype, 'some')
	};
	for (const name of Object.keys(descriptors) as Array<keyof typeof descriptors>) {
		Object.defineProperty(Array.prototype, name, {
			configurable: true,
			value() {
				throw new Error(`patched Array.${name}`);
			}
		});
	}
	try {
		getManyResult = await adapter.getMany(indexedMeta, [1]);
		nativeQueryResult = await adapter.query(indexedMeta, {
			...emptyPlan,
			native: { payload: { text: 'select data from postgres_regression_record' } }
		});
		queryResult = await adapter.query(indexedMeta, {
			where: [{ field: 'score', op: '>=', value: 3 }],
			or: [{ where: [{ field: 'handle', op: 'startsWith', value: 'q' }], or: [], sort: [], include: [] }],
			sort: [{ field: 'score', direction: 'desc' }],
			include: [],
			limit: 1
		});
		aggregateResult = await adapter.aggregate!(indexedMeta, {
			where: [{ field: 'score', op: '>=', value: 1 }],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		});
		schemaPlan = await adapter.schema!.plan([indexedMeta]);
		await adapter.schema!.apply([indexedMeta], { mode: 'safe' });
	} finally {
		for (const name of Object.keys(descriptors) as Array<keyof typeof descriptors>) {
			const descriptor = descriptors[name];
			if (descriptor) Object.defineProperty(Array.prototype, name, descriptor);
			else delete (Array.prototype as any)[name];
		}
	}

	assert.deepEqual(getManyResult, [{ id: 1, handle: 'one', score: 3 }]);
	assert.deepEqual((nativeQueryResult as any).list, [{ id: 2, handle: 'native', score: 4 }]);
	assert.deepEqual((queryResult as any).list, [{ id: 3, handle: 'query', score: 7 }]);
	assert.equal((queryResult as any).count, 1);
	assert.deepEqual(aggregateResult, { total: 10 });
	assert.deepEqual((schemaPlan as any).changes, [
		{
			type: 'create-index',
			target: 'postgres_regression_record',
			name: 'handle_profile_idx',
			fields: ['handle', 'profile.name'],
			directions: ['asc', 'desc'],
			unique: undefined
		}
	]);
	const createIndexCall = calls.find((call) => call.text.startsWith('create index if not exists '));
	assert.match(createIndexCall?.text ?? '', /ARRAY\['handle'\]/);
	assert.match(createIndexCall?.text ?? '', /ARRAY\['profile', 'name'\]/);
	assert.match(createIndexCall?.text ?? '', /\bdesc\b/i);
});

test('PostgreSQL untyped sort follows active-ts null and mixed-type ordering', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});

	await adapter.query(meta, {
		where: [],
		or: [],
		sort: [{ field: 'score', direction: 'asc' }],
		include: []
	});

	assert.match(
		calls[0].text,
		/then 0 when jsonb_typeof\(\(data #> \$1::text\[\]\)\) = 'boolean' then 1 when jsonb_typeof\(\(data #> \$1::text\[\]\)\) = 'number' then 2 when jsonb_typeof\(\(data #> \$1::text\[\]\)\) = 'string' then 3 else 4/
	);
	assert.match(calls[0].text, /\(\(data #>> \$1::text\[\]\)\)::boolean/);
	assert.match(calls[0].text, /jsonb_typeof\(\(data #> \$1::text\[\]\)\) = 'number'/);
	assert.match(calls[0].text, /\(\(data #>> \$1::text\[\]\)\)::double precision/);
	assert.deepEqual(calls[0].values, [['score']]);
});

test('PostgreSQL typed sort keeps active-ts null placement before casts', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};

	await adapter.query(typedMeta, {
		where: [],
		or: [],
		sort: [{ field: 'score', direction: 'desc' }],
		include: []
	});

	assert.match(calls[0].text, /case when \(data #> \$1::text\[\]\) is null .* then 0 else 1 end\) desc/);
	assert.match(calls[0].text, /\(\(data #>> \$1::text\[\]\)\)::double precision desc/);
	assert.deepEqual(calls[0].values, [['score']]);
});

test('PostgreSQL untyped min and max aggregates fail before text ordering', async () => {
	let queryCalls = 0;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				queryCalls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});

	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'max', field: 'score', as: 'maxScore' }]
			}),
		/requires field type metadata for min\/max field "score"/
	);
	assert.equal(queryCalls, 0);
});

test('PostgreSQL native SQL query rejects portable clauses instead of ignoring them', async () => {
	const calls: string[] = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				calls.push(text);
				return { rows: [{ data: { id: 1, handle: 'unsafe' } }] };
			}
		}
	});
	const native = { payload: { text: 'select data from postgres_regression_record' } };

	await assert.rejects(
		() =>
			adapter.query(meta, {
				...emptyPlan,
				where: [{ field: 'handle', op: '=', value: 'safe' }],
				native
			}),
		/PostgreSQL native SQL query payload cannot be combined with portable query clauses \(where\)/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				...emptyPlan,
				or: [{ where: [{ field: 'handle', op: '=', value: 'safe' }], or: [], sort: [], include: [] }],
				native
			}),
		/PostgreSQL native SQL query payload cannot be combined with portable query clauses \(where\)/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				...emptyPlan,
				sort: [{ field: 'handle', direction: 'asc' }],
				native
			}),
		/PostgreSQL native SQL query payload cannot be combined with portable query clauses \(sort\)/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				...emptyPlan,
				limit: 1,
				native
			}),
		/PostgreSQL native SQL query payload cannot be combined with portable query clauses \(limit\)/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				...emptyPlan,
				offset: 1,
				native
			}),
		/PostgreSQL native SQL query payload cannot be combined with portable query clauses \(offset\)/
	);

	let functionPlan: QueryPlan | undefined;
	const functionResult = await adapter.query(meta, {
		...emptyPlan,
		where: [{ field: 'handle', op: '=', value: 'safe' }],
		native: {
			payload: ({ plan }: { plan: QueryPlan }) => {
				functionPlan = plan;
				return { list: [{ id: 1, handle: 'safe' }], more: false, count: 1 };
			}
		}
	});
	assert.equal(functionPlan?.where.length, 1);
	assert.deepEqual(functionResult.list, [{ id: 1, handle: 'safe' }]);
	assert.deepEqual(calls, []);
});

test('PostgreSQL native SQL query rejects own nullish data columns', async () => {
	let nextRow: unknown = { data: null };
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [nextRow], rowCount: 1 })
		}
	});
	const nativePlan = { ...emptyPlan, native: { payload: { text: 'select data from postgres_regression_record' } } };

	await assert.rejects(
		() => adapter.query(meta, nativePlan),
		/PostgreSQL native query row data must be a plain object/
	);

	nextRow = { data: undefined };
	await assert.rejects(
		() => adapter.query(meta, nativePlan),
		/PostgreSQL native query row data must be a plain object/
	);

	nextRow = { id: 1, handle: 'fallback-row' };
	assert.deepEqual((await adapter.query(meta, nativePlan)).list, [{ id: 1, handle: 'fallback-row' }]);
});

test('PostgreSQL native SQL query validates storage id when data rows include it', async () => {
	let nextRow: unknown = { id: 'number:1', data: { id: 1, handle: 'matched' } };
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [nextRow], rowCount: 1 })
		}
	});
	const nativePlan = { ...emptyPlan, native: { payload: { text: 'select id, data from postgres_regression_record' } } };

	assert.deepEqual((await adapter.query(meta, nativePlan)).list, [{ id: 1, handle: 'matched' }]);
	nextRow = { id: 'number:1', data: { id: 2, handle: 'mismatch' } };
	await assert.rejects(
		() => adapter.query(meta, nativePlan),
		/PostgreSQL native query row data id field "id" must match/
	);
});

test('PostgreSQL native SQL bind values use captured collection intrinsics', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const weakSetHas = WeakSet.prototype.has;
	const weakSetAdd = WeakSet.prototype.add;
	const weakSetDelete = WeakSet.prototype.delete;
	const weakMapHas = WeakMap.prototype.has;
	const weakMapGet = WeakMap.prototype.get;
	const weakMapSet = WeakMap.prototype.set;
	const safeValue = { nested: { value: 'safe' } };
	const circularValue: any = { nested: 'unsafe' };
	circularValue.self = circularValue;
	let circularError: unknown;
	WeakSet.prototype.has = function () {
		throw new Error('patched WeakSet.has');
	};
	WeakSet.prototype.add = function () {
		throw new Error('patched WeakSet.add');
	};
	WeakSet.prototype.delete = function () {
		throw new Error('patched WeakSet.delete');
	};
	WeakMap.prototype.has = function () {
		throw new Error('patched WeakMap.has');
	};
	WeakMap.prototype.get = function () {
		throw new Error('patched WeakMap.get');
	};
	WeakMap.prototype.set = function () {
		throw new Error('patched WeakMap.set');
	};
	try {
		await adapter.query(meta, {
			...emptyPlan,
			native: { payload: { text: 'select data from postgres_regression_record where data @> $1', values: [safeValue] } }
		});
		try {
			await adapter.query(meta, {
				...emptyPlan,
				native: { payload: { text: 'select data from postgres_regression_record where data @> $1', values: [circularValue] } }
			});
		} catch (error) {
			circularError = error;
		}
	} finally {
		WeakSet.prototype.has = weakSetHas;
		WeakSet.prototype.add = weakSetAdd;
		WeakSet.prototype.delete = weakSetDelete;
		WeakMap.prototype.has = weakMapHas;
		WeakMap.prototype.get = weakMapGet;
		WeakMap.prototype.set = weakMapSet;
	}
	assert.equal(calls.length, 1);
	assert.equal(calls[0].text, 'select data from postgres_regression_record where data @> $1');
	assert.notEqual(calls[0].values[0], safeValue);
	assert.equal(JSON.stringify(calls[0].values[0]), '{"nested":{"value":"safe"}}');
	assert.match(String((circularError as Error | undefined)?.message), /must not contain circular references/);
});

test('PostgreSQL factory option allowlists use captured Set intrinsics', async () => {
	const setHas = Set.prototype.has;
	const setAdd = Set.prototype.add;
	let optionError: unknown;
	let nativePayloadError: unknown;
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	Set.prototype.add = function () {
		throw new Error('patched Set.add');
	};
	try {
		try {
			await createPostgresStoreAdapter({ unknown: true } as any);
		} catch (error) {
			optionError = error;
		}
		const adapter = await createPostgresStoreAdapter({
			pool: {
				query: async () => ({ rows: [], rowCount: 0 })
			}
		});
		try {
			await adapter.query(meta, {
				...emptyPlan,
				native: { payload: { text: 'select data from postgres_regression_record', value: [] } }
			});
		} catch (error) {
			nativePayloadError = error;
		}
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
	assert.match(String((optionError as Error | undefined)?.message), /PostgreSQL adapter options contains unknown option "unknown"/);
	assert.match(
		String((nativePayloadError as Error | undefined)?.message),
		/PostgreSQL native payload contains unknown option "value"/
	);
});

test('PostgreSQL native SQL aggregate rejects portable where clauses instead of ignoring them', async () => {
	const calls: string[] = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				calls.push(text);
				return { rows: [{ count: 99 }] };
			}
		}
	});
	const plan: AggregatePlan = {
		where: [{ field: 'handle', op: '=', value: 'safe' }],
		or: [],
		aggregates: [{ op: 'count', as: 'count' }],
		native: { payload: { text: 'select count(*) as count from postgres_regression_record' } }
	};

	await assert.rejects(
		() => adapter.aggregate!(meta, plan),
		/PostgreSQL native SQL aggregate payload cannot be combined with portable aggregate where clauses/
	);
	assert.deepEqual(calls, []);
});

test('PostgreSQL adapter validates direct aggregate row containers', async () => {
	let nextResult: unknown = { rows: [null], rowCount: 1 };
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => nextResult
		}
	});
	const plan = { where: [], or: [], aggregates: [{ op: 'count' as const, as: 'count' }] };

	await assert.rejects(() => adapter.aggregate!(meta, plan), /PostgreSQL aggregate result must be a plain object/);
	nextResult = { rows: [Object.create({ count: 1 })], rowCount: 1 };
	await assert.rejects(() => adapter.aggregate!(meta, plan), /PostgreSQL aggregate result must be a plain object/);
});

test('PostgreSQL schema index discovery rejects non-string names without coercion', async () => {
	let coerced = 0;
	const hostileName = {
		toString() {
			coerced++;
			throw new Error('index name coercion should not run');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				if (text.includes('information_schema.tables')) return { rows: [{}] };
				if (text.includes('information_schema.columns')) return { rows: postgresActiveTableColumns };
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: postgresActivePrimaryKey };
				if (text.includes('pg_indexes')) return { rows: [{ indexname: hostileName }] };
				return { rows: [] };
			}
		}
	});

	await assert.rejects(
		() => adapter.schema!.plan([{ ...meta, indexes: [{ name: 'handle_idx', fields: ['handle'] }] }]),
		/PostgreSQL index row\.indexname must be a string/
	);
	assert.equal(coerced, 0);
});

test('PostgreSQL schema discovery follows current_schema when no schema option is configured', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const pool = {
		query: async (text: string, values: unknown[] = []) => {
			calls.push({ text, values });
			if (text.includes('information_schema.tables')) return { rows: [{}] };
			if (text.includes('information_schema.columns')) return { rows: postgresActiveTableColumns };
			if (/\bfrom\s+pg_index\s/.test(text)) return { rows: postgresActivePrimaryKey };
			if (text.includes('pg_indexes')) return { rows: [] };
			return { rows: [] };
		}
	};
	const defaultSchemaAdapter = await createPostgresStoreAdapter({ pool });

	await defaultSchemaAdapter.schema!.plan([meta]);

	assert.match(calls[0].text, /table_schema = coalesce\(\$1, current_schema\(\)\)/);
	assert.deepEqual(calls[0].values, [null, 'postgres_regression_record']);
	assert.match(calls[1].text, /table_schema = coalesce\(\$1, current_schema\(\)\)/);
	assert.deepEqual(calls[1].values, [null, 'postgres_regression_record']);
	assert.match(calls[2].text, /n\.nspname = coalesce\(\$1, current_schema\(\)\)/);
	assert.deepEqual(calls[2].values, [null, 'postgres_regression_record']);
	assert.match(calls[3].text, /schemaname = coalesce\(\$1, current_schema\(\)\)/);
	assert.deepEqual(calls[3].values, [null, 'postgres_regression_record']);

	calls.length = 0;
	const explicitSchemaAdapter = await createPostgresStoreAdapter({ pool, schema: 'tenant_schema' });
	await explicitSchemaAdapter.schema!.plan([meta]);

	assert.deepEqual(calls[0].values, ['tenant_schema', 'postgres_regression_record']);
	assert.deepEqual(calls[1].values, ['tenant_schema', 'postgres_regression_record']);
	assert.deepEqual(calls[2].values, ['tenant_schema', 'postgres_regression_record']);
	assert.deepEqual(calls[3].values, ['tenant_schema', 'postgres_regression_record']);
});

test('PostgreSQL schema planning rejects existing table shape drift', async () => {
	let columnRows: unknown[] = postgresActiveTableColumns;
	let primaryRows: unknown[] = postgresActivePrimaryKey;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				if (text.includes('information_schema.tables')) return { rows: [{}] };
				if (text.includes('information_schema.columns')) return { rows: columnRows };
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: primaryRows };
				if (text.includes('pg_indexes')) return { rows: [] };
				return { rows: [] };
			}
		}
	});

	assert.deepEqual((await adapter.schema!.plan([meta])).changes, []);

	columnRows = postgresActiveTableColumns.filter((row) => row.column_name !== 'data');
	await assert.rejects(
		() => adapter.schema!.plan([meta]),
		/PostgreSQL table "postgres_regression_record" does not match the active-ts table shape: missing column "data"/
	);

	columnRows = postgresActiveTableColumns.map((row) =>
		row.column_name === 'data' ? { ...row, udt_name: 'text', data_type: 'text' } : row
	);
	await assert.rejects(
		() => adapter.schema!.plan([meta]),
		/PostgreSQL table "postgres_regression_record" does not match the active-ts table shape: column "data" must be jsonb/
	);

	columnRows = postgresActiveTableColumns.map((row) =>
		row.column_name === 'updated_at' ? { ...row, is_nullable: 'YES' } : row
	);
	await assert.rejects(
		() => adapter.schema!.plan([meta]),
		/PostgreSQL table "postgres_regression_record" does not match the active-ts table shape: column "updated_at" must be not null/
	);

	columnRows = postgresActiveTableColumns;
	primaryRows = [{ column_name: 'data' }];
	await assert.rejects(
		() => adapter.schema!.plan([meta]),
		/PostgreSQL table "postgres_regression_record" does not match the active-ts table shape: primary key must be exactly "id"/
	);
});

test('PostgreSQL schema planning rejects same-name index drift', async () => {
	const declared = { ...meta, indexes: [{ name: 'handle_idx', fields: ['handle'], unique: true }] };
	const indexName = 'postgres_regression_record_handle_idx';
	let indexRows: unknown[] = [
		{
			indexname: indexName,
			indexdef: `CREATE UNIQUE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #> ARRAY['handle'::text])))`
		}
	];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				if (text.includes('information_schema.tables')) return { rows: [{}] };
				if (text.includes('information_schema.columns')) return { rows: postgresActiveTableColumns };
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: postgresActivePrimaryKey };
				if (text.includes('pg_indexes')) return { rows: indexRows };
				return { rows: [] };
			}
		}
	});

	assert.deepEqual((await adapter.schema!.plan([declared])).changes, []);

	indexRows = [
		{
			indexname: indexName,
			indexdef: `CREATE UNIQUE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['other'::text])))`
		}
	];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [
		{
			indexname: indexName,
			indexdef: `CREATE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['handle'::text])))`
		}
	];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [
		{
			indexname: indexName,
			indexdef: `CREATE UNIQUE INDEX ${indexName} ON public.postgres_regression_record USING hash (((data #> ARRAY['handle'::text])))`
		}
	];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [
		{
			indexname: indexName,
			indexdef: `CREATE UNIQUE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #> ARRAY['handle'::text]))) WHERE ((data ? 'handle'::text))`
		}
	];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [
		{
			indexname: indexName,
			indexdef: `CREATE UNIQUE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['handle'::text])), ((data #>> ARRAY['other'::text])))`
		}
	];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [{ indexname: indexName }];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" is missing definition metadata/
	);
});

test('PostgreSQL schema planning rejects index direction drift', async () => {
	const declared: ResolvedModelMeta<any> = {
		...meta,
		indexes: [{ name: 'handle_profile_idx', fields: ['handle', 'profile.name'], directions: ['asc', 'desc'] }]
	};
	const indexName = 'postgres_regression_record_handle_profile_idx';
	let indexRows: unknown[] = [
		{
			indexname: indexName,
			indexdef: `CREATE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['handle'::text])), ((data #>> ARRAY['profile'::text, 'name'::text])) DESC)`
		}
	];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				if (text.includes('information_schema.tables')) return { rows: [{}] };
				if (text.includes('information_schema.columns')) return { rows: postgresActiveTableColumns };
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: postgresActivePrimaryKey };
				if (text.includes('pg_indexes')) return { rows: indexRows };
				return { rows: [] };
			}
		}
	});

	assert.deepEqual((await adapter.schema!.plan([declared])).changes, []);

	indexRows = [
		{
			indexname: indexName,
			indexdef: `CREATE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['handle'::text])) DESC, ((data #>> ARRAY['profile'::text, 'name'::text])) DESC)`
		}
	];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_profile_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [
		{
			indexname: indexName,
			indexdef: `CREATE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['handle'::text])), ((data #>> ARRAY['profile'::text, 'name'::text])))`
		}
	];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/PostgreSQL index "handle_profile_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);
});

test('PostgreSQL schema index drift preserves JSON literal case and whitespace', async () => {
	const indexName = 'postgres_regression_record_handle_idx';
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				if (text.includes('information_schema.tables')) return { rows: [{}] };
				if (text.includes('information_schema.columns')) return { rows: postgresActiveTableColumns };
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: postgresActivePrimaryKey };
				if (text.includes('pg_indexes')) {
					return {
						rows: [
							{
								indexname: indexName,
								indexdef: `CREATE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['handle'::text])))`
							}
						]
					};
				}
				return { rows: [] };
			}
		}
	});

	await assert.rejects(
		() => adapter.schema!.plan([{ ...meta, indexes: [{ name: 'handle_idx', fields: ['Handle'] }] }]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);
	await assert.rejects(
		() => adapter.schema!.plan([{ ...meta, indexes: [{ name: 'handle_idx', fields: ['han dle'] }] }]),
		/PostgreSQL index "handle_idx" on "postgres_regression_record" does not match declared fields or uniqueness/
	);
});

test('PostgreSQL schema planning does not infer uniqueness from index names', async () => {
	const declared = { ...meta, indexes: [{ name: 'createuniqueindex_probe', fields: ['handle'] }] };
	const indexName = 'postgres_regression_record_createuniqueindex_probe';
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				if (text.includes('information_schema.tables')) return { rows: [{}] };
				if (text.includes('information_schema.columns')) return { rows: postgresActiveTableColumns };
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: postgresActivePrimaryKey };
				if (text.includes('pg_indexes')) {
					return {
						rows: [
							{
								indexname: indexName,
								indexdef: `CREATE INDEX ${indexName} ON public.postgres_regression_record USING btree (((data #>> ARRAY['handle'::text])))`
							}
						]
					};
				}
				return { rows: [] };
			}
		}
	});

	assert.deepEqual((await adapter.schema!.plan([declared])).changes, []);
});

test('PostgreSQL adapter validates direct row data before returning it', async () => {
	let nextResult: unknown = { rows: [], rowCount: 0 };
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => nextResult
		}
	});

	nextResult = { rows: [{ id: 'number:1', data: { id: 1, handle: 'unsafe', __unsafe: true } }], rowCount: 1 };
	await assert.rejects(() => adapter.get(meta, 1), /Reserved data key/);

	nextResult = { rows: [{ id: 'number:1', data: { id: 1, handle: 'unsafe', __unsafe: true } }], rowCount: 1 };
	await assert.rejects(() => adapter.getMany(meta, [1]), /Reserved data key/);

	nextResult = { rows: [{ id: 'number:1', data: { id: 2, handle: 'wrong-id' } }], rowCount: 1 };
	await assert.rejects(() => adapter.get(meta, 1), /PostgreSQL get row data id field "id" must match/);

	nextResult = { rows: [{ id: 'number:2', data: { id: 2, handle: 'wrong-storage-id' } }], rowCount: 1 };
	await assert.rejects(() => adapter.get(meta, 1), /PostgreSQL get row\.id must match the requested id/);

	nextResult = { rows: [{ id: '1', data: { id: 1, handle: 'legacy' } }], rowCount: 1 };
	await assert.rejects(() => adapter.getMany(meta, [1]), /PostgreSQL getMany row\.id must be a canonical active-ts entity id key/);

	nextResult = { rows: [{ id: 'number:2', data: { id: 2, handle: 'unexpected' } }], rowCount: 1 };
	await assert.rejects(() => adapter.getMany(meta, [1]), /PostgreSQL getMany row id was not requested/);

	nextResult = { rows: [{ id: 'number:1', data: { id: 2, handle: 'wrong-id' } }], rowCount: 1 };
	await assert.rejects(() => adapter.getMany(meta, [1]), /PostgreSQL getMany row data id field "id" must match/);

	nextResult = {
		rows: [
			{ id: 'number:1', data: { id: 1, handle: 'one' } },
			{ id: 'number:1', data: { id: 1, handle: 'again' } }
		],
		rowCount: 2
	};
	await assert.rejects(() => adapter.getMany(meta, [1]), /PostgreSQL getMany returned duplicate row ids/);

	nextResult = { rows: [{ id: 'number:1', data: { id: 1, handle: 'one' } }], rowCount: 1 };
	const duplicateRows = await adapter.getMany(meta, [1, 1]);
	assert.deepEqual(duplicateRows, [
		{ id: 1, handle: 'one' },
		{ id: 1, handle: 'one' }
	]);
	assert.notEqual(duplicateRows[0], duplicateRows[1]);

	nextResult = { rows: [{ id: 'number:1', data: { id: 1, handle: 'unsafe', __unsafe: true } }], rowCount: 1 };
	await assert.rejects(() => adapter.query(meta, emptyPlan), /Reserved data key/);

	nextResult = { rows: [{ id: 'number:1', data: { id: 2, handle: 'wrong-id' } }], rowCount: 1 };
	await assert.rejects(() => adapter.query(meta, emptyPlan), /PostgreSQL query row data id field "id" must match/);

	nextResult = { rows: [{ id: 'boolean:true', data: { id: 'boolean:true', handle: 'noncanonical' } }], rowCount: 1 };
	await assert.rejects(() => adapter.query(meta, emptyPlan), /PostgreSQL query row\.id must be a canonical active-ts entity id key/);

	const rows = [{ id: 'number:1', data: { id: 1, handle: 'safe' } }] as any[];
	let mapCalls = 0;
	Object.defineProperty(rows, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom PostgreSQL rows.map should not run');
		}
	});
	nextResult = { rows, rowCount: 1 };
	assert.deepEqual(await adapter.query(meta, emptyPlan), {
		list: [{ id: 1, handle: 'safe' }],
		more: false,
		count: 1
	});
	assert.equal(mapCalls, 0);
});

test('PostgreSQL adapter maps own duplicate key errors to conflicts', async () => {
	let nextError: unknown = Object.assign(new Error('duplicate key'), { code: '23505' });
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				throw nextError;
			}
		}
	});

	await assert.rejects(() => adapter.create(meta, 1, { id: 1, handle: 'duplicate' }), ActiveTsConflictError);
	Object.defineProperty(Object.prototype, 'code', {
		value: '23505',
		configurable: true
	});
	try {
		nextError = new Error('plain insert failure');
		await assert.rejects(() => adapter.create(meta, 1, { id: 1, handle: 'plain' }), /plain insert failure/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).code;
	}
	let codeGetterCalls = 0;
	nextError = Object.defineProperty(new Error('accessor insert failure'), 'code', {
		enumerable: true,
		get() {
			codeGetterCalls++;
			return '23505';
		}
	});
	await assert.rejects(() => adapter.create(meta, 1, { id: 1, handle: 'accessor' }), /accessor insert failure/);
	assert.equal(codeGetterCalls, 0);
});

test('PostgreSQL versioned missing writes report not found separately from stale conflicts', async () => {
	let exists = false;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				if (text.startsWith('select 1 from')) {
					return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
				}
				return { rows: [], rowCount: 0 };
			}
		}
	});

	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'missing' }, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	await assert.rejects(
		() => adapter.delete(meta, 1, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	exists = true;
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'stale' }, { expectedVersion: 1 }),
		ActiveTsConflictError
	);
	await assert.rejects(
		() => adapter.delete(meta, 1, { expectedVersion: 1 }),
		ActiveTsConflictError
	);
});

test('PostgreSQL adapter casts typed in-list parameters', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([
			['score', 'number'],
			['seenAt', 'date'],
			['active', 'boolean']
		])
	};

	await adapter.query(typedMeta, {
		where: [{ field: 'score', op: 'in', value: [1, 2] }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(typedMeta, {
		where: [{ field: 'seenAt', op: 'in', value: ['2026-05-14T00:00:00.000Z'] }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(typedMeta, {
		where: [{ field: 'active', op: 'in', value: [true] }],
		or: [],
		sort: [],
		include: []
	});

	assert.match(calls[0].text, /= any\(\$2::double precision\[\]\)/);
	assert.match(calls[1].text, /= any\(\$2::timestamptz\[\]\)/);
	assert.match(calls[2].text, /= any\(\$2::boolean\[\]\)/);
});

test('PostgreSQL scalar filters guard JSON value types', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});

	await adapter.query(meta, {
		where: [{ field: 'handle', op: '=', value: '1' }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(meta, {
		where: [{ field: 'score', op: '=', value: 1 }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(meta, {
		where: [{ field: 'active', op: '=', value: true }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(meta, {
		where: [{ field: 'deletedAt', op: '=', value: null }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(meta, {
		where: [{ field: 'score', op: '>', value: 1 }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(meta, {
		where: [{ field: 'status', op: 'in', value: ['1', 1, null] }],
		or: [],
		sort: [],
		include: []
	});
	await adapter.query(meta, {
		where: [{ field: 'handle', op: '!=', value: '1' }],
		or: [],
		sort: [],
		include: []
	});

	assert.match(calls[0].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'string'/);
	assert.match(calls[0].text, /\(data #>> \$1::text\[\]\) = \$2::text/);
	assert.deepEqual(calls[0].values, [['handle'], '1']);
	assert.match(calls[1].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'number'/);
	assert.match(calls[1].text, /\(data #>> \$1::text\[\]\)::double precision = \$2::double precision/);
	assert.match(calls[2].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'boolean'/);
	assert.match(calls[2].text, /\(data #>> \$1::text\[\]\)::boolean = \$2::boolean/);
	assert.match(calls[3].text, /coalesce\(\(data #> \$1::text\[\]\) = 'null'::jsonb, false\)/);
	assert.match(calls[4].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'number'/);
	assert.match(calls[4].text, /\(data #>> \$1::text\[\]\)::double precision > \$2::double precision/);
	assert.match(calls[5].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'string'/);
	assert.match(calls[5].text, /= any\(\$2::text\[\]\)/);
	assert.match(calls[5].text, /jsonb_typeof\(data #> \$3::text\[\]\) = 'number'/);
	assert.match(calls[5].text, /= any\(\$4::double precision\[\]\)/);
	assert.match(calls[5].text, /coalesce\(\(data #> \$5::text\[\]\) = 'null'::jsonb, false\)/);
	assert.deepEqual(calls[5].values, [['status'], ['1'], ['status'], [1], ['status']]);
	assert.match(
		calls[6].text,
		/data #> \$1::text\[\] is not null and not \(coalesce\(\(jsonb_typeof\(data #> \$2::text\[\]\) = 'string'/
	);
	assert.deepEqual(calls[6].values, [['handle'], ['handle'], '1']);
});

test('PostgreSQL adapter maps typed JSON cast backend errors', async () => {
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const pgCastError = Object.assign(new Error('invalid input syntax for type double precision'), { code: '22P02' });
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				throw pgCastError;
			}
		}
	});

	await assert.rejects(
		() =>
			adapter.query(typedMeta, {
				...emptyPlan,
				sort: [{ field: 'score', direction: 'asc' }]
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsValidationError);
			assert.match(error.message, /PostgreSQL query failed because stored JSON field data could not be cast/);
			return true;
		}
	);

	await assert.rejects(
		() =>
			adapter.aggregate!(typedMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsValidationError);
			assert.match(error.message, /PostgreSQL aggregate failed because stored JSON field data could not be cast/);
			return true;
		}
	);
});

test('PostgreSQL numeric aggregates guard stored JSON number types before casting', async () => {
	let sql = '';
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				sql = text;
				return { rows: [{ total: 3, average: 1.5 }], rowCount: 1 };
			}
		}
	});

	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [
				{ op: 'sum', field: 'score', as: 'total' },
				{ op: 'avg', field: 'score', as: 'average' }
			]
		}),
		{ total: 3, average: 1.5 }
	);
	assert.match(sql, /jsonb_typeof/);
	assert.match(sql, /active-ts-invalid-numeric-aggregate/);
});

test('PostgreSQL typed field filters reject mismatched operands before SQL execution', async () => {
	let calls = 0;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				calls++;
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([
			['score', 'number'],
			['handle', 'string'],
			['active', 'boolean']
		])
	};

	await assert.rejects(
		() =>
			adapter.query(typedMeta, {
				where: [{ field: 'score', op: '=', value: '1' }],
				or: [],
				sort: [],
				include: []
			}),
		/score.*number field type/
	);
	await assert.rejects(
		() =>
			adapter.query(typedMeta, {
				where: [{ field: 'score', op: 'in', value: [1, '2'] }],
				or: [],
				sort: [],
				include: []
			}),
		/score.*number field type/
	);
	await assert.rejects(
		() =>
			adapter.query(typedMeta, {
				where: [{ field: 'handle', op: '=', value: 1 }],
				or: [],
				sort: [],
				include: []
			}),
		/handle.*string field type/
	);
	await assert.rejects(
		() =>
			adapter.query(typedMeta, {
				where: [{ field: 'active', op: '=', value: 'true' }],
				or: [],
				sort: [],
				include: []
			}),
		/active.*boolean field type/
	);

	await assert.rejects(
		() =>
			adapter.query(typedMeta, {
				where: [{ field: 'score', op: 'startsWith', value: '1' }],
				or: [],
				sort: [],
				include: []
			}),
		/requires a string field type/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(typedMeta, {
				where: [{ field: 'score', op: '=', value: '1' }],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/score.*number field type/
	);
	assert.equal(calls, 0);
});

test('PostgreSQL date operands require declared date fields', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const date = new Date('2026-05-14T00:00:00.000Z');

	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'seenAt', op: '=', value: date }],
				or: [],
				sort: [],
				include: []
			}),
		/PostgreSQL date query operands require field type "date"/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [{ field: 'seenAt', op: 'in', value: [date] }],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/PostgreSQL date query operands require field type "date"/
	);
	assert.equal(calls.length, 0);

	await adapter.query({
		...meta,
		fieldTypes: new Map([['seenAt', 'date']])
	}, {
		where: [{ field: 'seenAt', op: '=', value: date }],
		or: [],
		sort: [],
		include: []
	});
	assert.match(calls[0].text, /::timestamptz/);
	assert.deepEqual(calls[0].values, [['seenAt'], '2026-05-14T00:00:00.000Z']);
});

test('PostgreSQL startsWith guards untyped JSON values by JSON string type', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});

	await adapter.query(meta, {
		where: [{ field: 'handle', op: 'startsWith', value: '1' }],
		or: [],
		sort: [],
		include: []
	});

	assert.match(calls[0].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'string'/);
	assert.match(calls[0].text, /\(data #>> \$1::text\[\]\) like \$2 escape/);
	assert.deepEqual(calls[0].values, [['handle'], '1%']);
});

test('PostgreSQL adapter rejects inherited pool and transaction methods', async () => {
	const hiddenPool = Object.defineProperty({}, 'query', {
		enumerable: false,
		value: async () => ({ rows: [], rowCount: 0 })
	});
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: hiddenPool } as any),
		/PostgreSQL adapter pool\.query must be enumerable/
	);

	Object.defineProperties(Object.prototype, {
		query: { value: async () => ({ rows: [], rowCount: 0 }), configurable: true },
		connect: { value: async () => ({}), configurable: true }
	});
	try {
		await assert.rejects(
			() => createPostgresStoreAdapter({ pool: {} } as any),
			/PostgreSQL adapter pool\.query must be a function/
		);
		const adapter = await createPostgresStoreAdapter({
			pool: {
				query: async () => ({ rows: [], rowCount: 0 }),
				connect: async () => ({})
			}
		});
		await assert.rejects(
			() => adapter.transaction!(async () => undefined),
			/PostgreSQL transaction client\.query must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).query;
		delete (Object.prototype as Record<string, unknown>).connect;
	}
});

test('PostgreSQL transaction rejects malformed callbacks before connecting', async () => {
	let connectCalls = 0;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => {
				connectCalls++;
				return {
					query: async () => ({ rows: [], rowCount: 0 }),
					release() {}
				};
			}
		}
	});

	await assert.rejects(
		() => adapter.transaction!(null as any),
		/PostgreSQL transaction callback must be a function/
	);
	assert.equal(connectCalls, 0);
});

test('PostgreSQL transaction applies portable transaction options', async () => {
	const calls: Array<{ text: string; values?: unknown[] }> = [];
	const client = {
		query: async (text: string, values?: unknown[]) => {
			calls.push({ text, values });
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls.push({ text: 'release' });
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	const result = await adapter.transaction!(
		async () => 'committed',
		{ isolation: 'serializable', readOnly: true, timeoutMs: 250 }
	);

	assert.equal(result, 'committed');
	assert.deepEqual(calls, [
		{ text: 'begin isolation level serializable read only', values: undefined },
		{ text: 'select set_config($1, $2, true)', values: ['statement_timeout', '250ms'] },
		{ text: 'commit', values: undefined },
		{ text: 'release' }
	]);
});

test('PostgreSQL transaction rejects unsupported native transaction options before connecting', async () => {
	let connectCalls = 0;
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => {
				connectCalls++;
				return {
					query: async () => ({ rows: [], rowCount: 0 }),
					release() {}
				};
			}
		}
	});

	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { native: { vendor: true } }),
		/PostgreSQL transaction options\.native is not supported/
	);
	assert.equal(connectCalls, 0);
});

test('PostgreSQL low-level transaction adapters close after callbacks settle', async () => {
	const calls: string[] = [];
	const client = {
		query: async (text: string) => {
			calls.push(text);
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls.push('release');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let leaked!: StoreAdapter;

	await adapter.transaction!(async (tx) => {
		leaked = tx;
	});

	await assert.rejects(
		() => leaked.get(meta, 1),
		/closed PostgreSQL store transaction adapter after callback finished/
	);
	assert.deepEqual(calls, ['begin', 'commit', 'release']);
});

test('PostgreSQL savepoints recover failed statements and preserve the parent transaction', async () => {
	const calls: string[] = [];
	const duplicate = Object.assign(new Error('duplicate child row'), { code: '23505' });
	const client = {
		query: async (query: any, values?: unknown[]) => {
			const text = typeof query === 'string' ? query : query.text;
			if (text.startsWith('insert into ') && values?.[0] === 'number:2') {
				calls.push('insert:2:failed');
				throw duplicate;
			}
			if (text.startsWith('insert into ')) calls.push(`insert:${String(values?.[0]).replace('number:', '')}`);
			else calls.push(text);
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	assert.equal(adapter.capabilities?.savepoint, false);

	await adapter.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.savepoint, true);
		assert.ok(tx.savepoint);
		await tx.create(meta, 1, { id: 1, handle: 'parent-before' });
		await assert.rejects(
			() => tx.savepoint!(async (savepointTx) => {
				await assert.rejects(
					() => savepointTx.create(meta, 2, { id: 2, handle: 'duplicate' }),
					ActiveTsConflictError
				);
			}),
			/cannot be released after a statement failed.*duplicate child row/
		);
		await tx.create(meta, 3, { id: 3, handle: 'parent-after' });
		await tx.savepoint!(async (savepointTx) => {
			await savepointTx.create(meta, 4, { id: 4, handle: 'child-commit' });
			await savepointTx.savepoint!(async (nestedTx) => {
				await nestedTx.create(meta, 5, { id: 5, handle: 'nested-commit' });
			});
		});
	});

	assert.deepEqual(calls, [
		'begin',
		'insert:1',
		'savepoint active_ts_savepoint_1',
		'insert:2:failed',
		'rollback to savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1',
		'insert:3',
		'savepoint active_ts_savepoint_2',
		'insert:4',
		'savepoint active_ts_savepoint_3',
		'insert:5',
		'release savepoint active_ts_savepoint_3',
		'release savepoint active_ts_savepoint_2',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL savepoint recovery failures poison the parent transaction', async () => {
	const calls: string[] = [];
	const recoveryError = new Error('rollback to savepoint failed');
	const client = {
		query: async (text: string) => {
			calls.push(text);
			if (text.startsWith('rollback to savepoint ')) throw recoveryError;
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await assert.rejects(
		() => adapter.transaction!(async (tx) => {
			await assert.rejects(
				() => tx.savepoint!(async () => {
					throw new Error('child failed');
				}),
				/PostgreSQL savepoint failed and recovery failed/
			);
		}),
		/cannot commit after a statement failed.*rollback to savepoint failed/
	);
	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'rollback to savepoint active_ts_savepoint_1',
		'rollback',
		'release-client'
	]);
});

test('PostgreSQL outer savepoints recover nested savepoint creation failures', async () => {
	const calls: string[] = [];
	const nestedError = new Error('nested savepoint creation failed');
	const client = {
		query: async (query: any, values?: unknown[]) => {
			const text = typeof query === 'string' ? query : query.text;
			calls.push(text.startsWith('insert into ') ? `insert:${String(values?.[0])}` : text);
			if (text === 'savepoint active_ts_savepoint_2') throw nestedError;
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await adapter.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.savepoint!(async (outer) => {
				await outer.savepoint!(async () => undefined);
			}),
			(error: unknown) => error === nestedError
		);
		await tx.create(meta, 11, { id: 11, handle: 'parent-continues' });
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'savepoint active_ts_savepoint_2',
		'rollback to savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1',
		'insert:number:11',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL outer savepoints recover nested savepoint recovery failures', async () => {
	const calls: string[] = [];
	const recoveryError = new Error('nested savepoint recovery failed');
	const client = {
		query: async (text: string, values?: unknown[]) => {
			calls.push(text.startsWith('insert into ') ? `insert:${String(values?.[0])}` : text);
			if (text === 'rollback to savepoint active_ts_savepoint_2') throw recoveryError;
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await adapter.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.savepoint!(async (outer) => {
				await outer.savepoint!(async () => {
					throw new Error('nested callback failed');
				});
			}),
			/PostgreSQL savepoint failed and recovery failed.*nested callback failed/
		);
		await tx.create(meta, 12, { id: 12, handle: 'parent-continues' });
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'savepoint active_ts_savepoint_2',
		'rollback to savepoint active_ts_savepoint_2',
		'rollback to savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1',
		'insert:number:12',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL savepoint recovery failures defer hooks until the parent rollback', async () => {
	const events: string[] = [];
	const client = {
		query: async (text: string) => {
			events.push(`sql:${text}`);
			if (text.startsWith('rollback to savepoint ')) throw new Error('savepoint recovery failed');
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			events.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await tx.afterRollback(() => {
				events.push('parent-afterRollback');
			});
			await assert.rejects(
				() => tx.transaction(
					async (savepoint) => {
						await savepoint.afterRollback(() => {
							events.push('child-afterRollback');
						});
						throw new Error('child failed');
					},
					{ join: 'savepoint' }
				),
				/PostgreSQL savepoint failed and recovery failed/
			);
			events.push('child-error-caught');
		}),
		/cannot commit after a statement failed.*savepoint recovery failed/
	);

	assert.deepEqual(events, [
		'sql:begin',
		'sql:savepoint active_ts_savepoint_1',
		'sql:rollback to savepoint active_ts_savepoint_1',
		'child-error-caught',
		'sql:rollback',
		'release-client',
		'parent-afterRollback',
		'child-afterRollback'
	]);
});

test('PostgreSQL confirmed outer rollback runs nested savepoint rollback hooks', async () => {
	const events: string[] = [];
	const client = {
		query: async (text: string, values?: unknown[]) => {
			events.push(text.startsWith('insert into ') ? `sql:insert:${String(values?.[0])}` : `sql:${text}`);
			if (text === 'rollback to savepoint active_ts_savepoint_2') {
				throw new Error('nested savepoint recovery failed');
			}
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			events.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await context.transaction(async (tx) => {
		await assert.rejects(
			() => tx.transaction(
				async (outer) => {
					await outer.afterRollback(() => {
						events.push('outer-afterRollback');
					});
					await outer.transaction(
						async (inner) => {
							await inner.afterRollback(() => {
								events.push('inner-afterRollback');
							});
							throw new Error('nested callback failed');
						},
						{ join: 'savepoint' }
					);
				},
				{ join: 'savepoint' }
			),
			/PostgreSQL savepoint failed and recovery failed.*nested callback failed/
		);
		events.push('outer-error-caught');
		await tx.store('default').create(meta, 13, { id: 13, handle: 'parent-continues' });
	});

	assert.deepEqual(events, [
		'sql:begin',
		'sql:savepoint active_ts_savepoint_1',
		'sql:savepoint active_ts_savepoint_2',
		'sql:rollback to savepoint active_ts_savepoint_2',
		'sql:rollback to savepoint active_ts_savepoint_1',
		'sql:release savepoint active_ts_savepoint_1',
		'outer-afterRollback',
		'inner-afterRollback',
		'outer-error-caught',
		'sql:insert:number:13',
		'sql:commit',
		'release-client'
	]);
});

test('PostgreSQL failed final rollbacks discard clients and skip rollback hooks', async () => {
	const deferred: string[] = [];
	let releasedWith: unknown;
	let reportedError: unknown;
	const client = {
		query: async (text: string) => {
			if (text.startsWith('rollback to savepoint ')) throw new Error('savepoint recovery failed');
			if (text === 'rollback') throw new Error('root rollback failed');
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release(error?: unknown) {
			releasedWith = error;
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await tx.afterRollback(() => {
				deferred.push('parent');
			});
			await tx.transaction(
				async (savepoint) => {
					await savepoint.afterRollback(() => {
						deferred.push('child');
					});
					throw new Error('child failed');
				},
				{ join: 'savepoint' }
			);
		}),
		(error: unknown) => {
			reportedError = error;
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /transaction failed and rollback failed/);
			return true;
		}
	);

	assert.deepEqual(deferred, []);
	assert.equal(releasedWith, reportedError);
});

test('PostgreSQL savepoints order retained parent native work after rollback', async () => {
	const calls: string[] = [];
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls.push(text);
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let rootPool!: { query: (text: string) => Promise<unknown> };
	let markStarted!: () => void;
	let releaseChild!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const childBarrier = new Promise<void>((resolve) => {
		releaseChild = resolve;
	});

	await adapter.transaction!(async (tx) => {
		await tx.query(meta, {
			...emptyPlan,
			native: {
				payload: ({ pool }: any) => {
					rootPool = pool;
					return { list: [] };
				}
			}
		});
		const child = tx.savepoint!(async () => {
			markStarted();
			await childBarrier;
			throw new Error('rollback child');
		});
		await started;
		const parentNative = rootPool.query('insert parent native');
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls.includes('insert parent native'), false);
		releaseChild();
		await assert.rejects(() => child, /rollback child/);
		await parentNative;
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'rollback to savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1',
		'insert parent native',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL rejects retained root native work from released savepoint lineages', async () => {
	const calls: string[] = [];
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls.push(text);
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let rootPool!: { query: (text: string) => Promise<unknown> };
	let releaseStaleLineage!: () => void;
	let releaseActiveSavepoint!: () => void;
	let markActiveSavepointStarted!: () => void;
	const staleLineageBarrier = new Promise<void>((resolve) => {
		releaseStaleLineage = resolve;
	});
	const activeSavepointBarrier = new Promise<void>((resolve) => {
		releaseActiveSavepoint = resolve;
	});
	const activeSavepointStarted = new Promise<void>((resolve) => {
		markActiveSavepointStarted = resolve;
	});

	await adapter.transaction!(async (tx) => {
		await tx.query(meta, {
			...emptyPlan,
			native: {
				payload: ({ pool }: any) => {
					rootPool = pool;
					return { list: [] };
				}
			}
		});
		let staleNative!: Promise<unknown>;
		await tx.savepoint!(async () => {
			staleNative = staleLineageBarrier.then(() => rootPool.query('insert stale native'));
		});
		const activeSavepoint = tx.savepoint!(async () => {
			markActiveSavepointStarted();
			await activeSavepointBarrier;
			throw new Error('rollback active savepoint');
		});
		await activeSavepointStarted;
		try {
			releaseStaleLineage();
			await assert.rejects(
				() => staleNative,
				/closed PostgreSQL store savepoint transaction after callback finished/
			);
			assert.equal(calls.includes('insert stale native'), false);
		} finally {
			releaseActiveSavepoint();
		}
		await assert.rejects(() => activeSavepoint, /rollback active savepoint/);
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1',
		'savepoint active_ts_savepoint_2',
		'rollback to savepoint active_ts_savepoint_2',
		'release savepoint active_ts_savepoint_2',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL attributes retained ancestor native failures to the active savepoint', async () => {
	const calls: string[] = [];
	const nativeError = new Error('retained ancestor native failure');
	const client = {
		query: async (query: any, values?: unknown[]) => {
			const text = typeof query === 'string' ? query : query.text;
			if (text === 'select retained ancestor failure') {
				calls.push('ancestor-native-failed');
				throw nativeError;
			}
			if (text.startsWith('insert into ')) calls.push(`insert:${String(values?.[0])}`);
			else calls.push(text);
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let rootPool!: { query: (text: string) => Promise<unknown> };

	await adapter.transaction!(async (tx) => {
		await tx.query(meta, {
			...emptyPlan,
			native: {
				payload: ({ pool }: any) => {
					rootPool = pool;
					return { list: [] };
				}
			}
		});
		await assert.rejects(
			() => tx.savepoint!(async () => {
				await assert.rejects(
					() => rootPool.query('select retained ancestor failure'),
					(error: unknown) => error === nativeError
				);
			}),
			/cannot be released after a statement failed.*retained ancestor native failure/
		);
		await tx.create(meta, 8, { id: 8, handle: 'parent-continues' });
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'ancestor-native-failed',
		'rollback to savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1',
		'insert:number:8',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL attributes retained outer adapter failures to the active nested savepoint', async () => {
	const calls: string[] = [];
	const nestedError = new Error('retained outer adapter failure');
	const client = {
		query: async (query: any, values?: unknown[]) => {
			const text = typeof query === 'string' ? query : query.text;
			if (text.startsWith('insert into ')) {
				calls.push(`insert:${String(values?.[0])}`);
				if (values?.[0] === 'number:9') throw nestedError;
			} else {
				calls.push(text);
			}
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await adapter.transaction!(async (tx) => {
		await tx.savepoint!(async (outer) => {
			await assert.rejects(
				() => outer.savepoint!(async () => {
					await outer.create(meta, 9, { id: 9, handle: 'nested-failure' });
				}),
				(error: unknown) => error === nestedError
			);
			await outer.create(meta, 10, { id: 10, handle: 'outer-continues' });
		});
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'savepoint active_ts_savepoint_2',
		'insert:number:9',
		'rollback to savepoint active_ts_savepoint_2',
		'release savepoint active_ts_savepoint_2',
		'insert:number:10',
		'release savepoint active_ts_savepoint_1',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL child native pools keep their savepoint scope across async lineages', async () => {
	const calls: string[] = [];
	const nativeError = new Error('external child native failure');
	const client = {
		query: async (query: any, values?: unknown[]) => {
			const text = typeof query === 'string' ? query : query.text;
			if (text === 'select external child failure') {
				calls.push('child-native-failed');
				throw nativeError;
			}
			if (text.startsWith('insert into ')) calls.push(`insert:${String(values?.[0])}`);
			else calls.push(text);
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let providePool!: (pool: { query: (text: string) => Promise<unknown> }) => void;
	const childPool = new Promise<{ query: (text: string) => Promise<unknown> }>((resolve) => {
		providePool = resolve;
	});
	const externalQuery = childPool.then((pool) => pool.query('select external child failure'));

	await adapter.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.savepoint!(async (child) => {
				await child.query(meta, {
					...emptyPlan,
					native: {
						payload: ({ pool }: any) => {
							providePool(pool);
							return { list: [] };
						}
					}
				});
				await assert.rejects(() => externalQuery, (error: unknown) => error === nativeError);
			}),
			/cannot be released after a statement failed.*external child native failure/
		);
		await tx.create(meta, 7, { id: 7, handle: 'parent-continues' });
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'child-native-failed',
		'rollback to savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1',
		'insert:number:7',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL savepoints scope native query drains and retained pools', async () => {
	const calls: string[] = [];
	const nativeError = Object.assign(new Error('ignored savepoint native failure'), { code: '23505' });
	const client = {
		query: async (query: any, values?: unknown[]) => {
			const text = typeof query === 'string' ? query : query.text;
			calls.push(text.startsWith('insert into ') ? `insert:${String(values?.[0])}` : text);
			if (text === 'select child native failure') throw nativeError;
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls.push('release-client');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let releasedPool!: { query: (text: string) => Promise<unknown> };
	let rolledBackPool!: { query: (text: string) => Promise<unknown> };

	await adapter.transaction!(async (tx) => {
		await tx.savepoint!(async (savepointTx) => {
			await savepointTx.query(meta, {
				...emptyPlan,
				native: {
					payload: async ({ pool }: any) => {
						releasedPool = pool;
						await pool.query('select child native success');
						return { list: [] };
					}
				}
			});
		});
		await assert.rejects(
			() => releasedPool.query('select escaped released savepoint'),
			/closed PostgreSQL native transaction query handle after released/
		);

		await assert.rejects(
			() => tx.savepoint!(async (savepointTx) => {
				await savepointTx.query(meta, {
					...emptyPlan,
					native: {
						payload: ({ pool }: any) => {
							rolledBackPool = pool;
							void pool.query('select child native failure');
							return { list: [] };
						}
					}
				});
			}),
			/ignored savepoint native failure/
		);
		await assert.rejects(
			() => rolledBackPool.query('select escaped rolled back savepoint'),
			/closed PostgreSQL native transaction query handle after rollback/
		);
		await tx.create(meta, 6, { id: 6, handle: 'parent-continues' });
	});

	assert.deepEqual(calls, [
		'begin',
		'savepoint active_ts_savepoint_1',
		'select child native success',
		'release savepoint active_ts_savepoint_1',
		'savepoint active_ts_savepoint_2',
		'select child native failure',
		'rollback to savepoint active_ts_savepoint_2',
		'release savepoint active_ts_savepoint_2',
		'insert:number:6',
		'commit',
		'release-client'
	]);
});

test('PostgreSQL transactions finish operations started before callbacks settle', async () => {
	const calls: string[] = [];
	let releaseInsert!: () => void;
	const holdInsert = new Promise<void>((resolve) => {
		releaseInsert = resolve;
	});
	let callbackReturned!: () => void;
	const callbackDidReturn = new Promise<void>((resolve) => {
		callbackReturned = resolve;
	});
	const client = {
		query: async (text: string) => {
			if (text.startsWith('insert into ')) {
				calls[calls.length] = 'insert:start';
				await holdInsert;
				calls[calls.length] = 'insert:finish';
				return { rows: [], rowCount: 1 };
			}
			calls[calls.length] = text;
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let pendingCreate!: Promise<void>;

	const pendingTransaction = adapter.transaction!(async (tx) => {
		pendingCreate = tx.create(meta, 1, { id: 1, handle: 'pending' });
		callbackReturned();
	});
	await callbackDidReturn;
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseInsert();
	await pendingTransaction;
	await pendingCreate;

	assert.deepEqual(calls, [
		'begin',
		'insert:start',
		'insert:finish',
		'commit',
		'release'
	]);
});

test('PostgreSQL transactions finish unreturned native SQL before commit', async () => {
	const calls: string[] = [];
	let markNativeQueryStarted!: () => void;
	const nativeQueryStarted = new Promise<void>((resolve) => {
		markNativeQueryStarted = resolve;
	});
	let releaseNativeQuery!: () => void;
	const holdNativeQuery = new Promise<void>((resolve) => {
		releaseNativeQuery = resolve;
	});
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			if (text === 'select late native') {
				calls[calls.length] = 'native:start';
				markNativeQueryStarted();
				await holdNativeQuery;
				calls[calls.length] = 'native:finish';
				return { rows: [], rowCount: 0, command: 'SELECT' };
			}
			calls[calls.length] = text;
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let leakedPool: any;
	let transactionSettled = false;

	const transaction = adapter.transaction!(async (tx) => {
		await tx.query(meta, {
			...emptyPlan,
			native: {
				payload: ({ pool }: any) => {
					leakedPool = pool;
					void pool.query('select late native');
					return { list: [] };
				}
			}
		});
	}).finally(() => {
		transactionSettled = true;
	});
	await nativeQueryStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		assert.equal(transactionSettled, false);
		assert.deepEqual(calls, ['begin', 'native:start']);
	} finally {
		releaseNativeQuery();
	}
	await transaction;

	assert.deepEqual(calls, ['begin', 'native:start', 'native:finish', 'commit', 'release']);
	await assert.rejects(
		() => leakedPool.query('select after transaction'),
		/closed PostgreSQL native transaction query handle after callback finished/
	);
});

test('PostgreSQL transactions finish native payloads started before callbacks settle', async () => {
	const calls: string[] = [];
	let markPayloadStarted!: () => void;
	const payloadStarted = new Promise<void>((resolve) => {
		markPayloadStarted = resolve;
	});
	let releasePayload!: () => void;
	const holdPayload = new Promise<void>((resolve) => {
		releasePayload = resolve;
	});
	let markCallbackReturned!: () => void;
	const callbackReturned = new Promise<void>((resolve) => {
		markCallbackReturned = resolve;
	});
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls[calls.length] = text;
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let nativePayload!: Promise<QueryResult>;
	let leakedPool!: { query: (query: unknown) => Promise<unknown> };

	const transaction = adapter.transaction!(async (tx) => {
		nativePayload = tx.query(meta, {
			...emptyPlan,
			native: {
				payload: async ({ pool }: any) => {
					leakedPool = pool;
					markPayloadStarted();
					await holdPayload;
					await pool.query('select delayed native');
					return { list: [] };
				}
			}
		});
		await payloadStarted;
		markCallbackReturned();
	});
	await callbackReturned;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await assert.rejects(
		() => leakedPool.query('select leaked native payload'),
		/closed PostgreSQL native transaction query handle after callback finished/
	);
	releasePayload();
	await transaction;
	await nativePayload;

	assert.deepEqual(calls, ['begin', 'select delayed native', 'commit', 'release']);
});

test('PostgreSQL transactions observe unreturned native SQL failures', async () => {
	const calls: string[] = [];
	const statementError = Object.assign(new Error('ignored native query failure'), { code: '23505' });
	let markNativeQueryStarted!: () => void;
	const nativeQueryStarted = new Promise<void>((resolve) => {
		markNativeQueryStarted = resolve;
	});
	let releaseNativeQuery!: () => void;
	const holdNativeQuery = new Promise<void>((resolve) => {
		releaseNativeQuery = resolve;
	});
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			if (text === 'select ignored failure') {
				calls[calls.length] = 'native:start';
				markNativeQueryStarted();
				await holdNativeQuery;
				calls[calls.length] = 'native:fail';
				throw statementError;
			}
			calls[calls.length] = text;
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	const transaction = adapter.transaction!(async (tx) => {
		await tx.query(meta, {
			...emptyPlan,
			native: {
				payload: ({ pool }: any) => {
					void pool.query('select ignored failure');
					return { list: [] };
				}
			}
		});
	});
	const rejected = assert.rejects(transaction, (error: unknown) => {
		assert.ok(error instanceof ActiveTsConfigurationError);
		assert.match(error.message, /cannot commit after a statement failed.*ignored native query failure/);
		assert.equal(error.cause, statementError);
		return true;
	});
	await nativeQueryStarted;
	releaseNativeQuery();
	await rejected;

	assert.deepEqual(calls, ['begin', 'native:start', 'native:fail', 'rollback', 'release']);
});

test('PostgreSQL transactions retain unreturned native SQL preflight failures', async () => {
	const calls: string[] = [];
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls[calls.length] = text;
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	const queryObject = Object.assign(Object.create({ submit() {} }), {
		text: 'select ignored query object'
	});
	const probes: Array<{
		run: (pool: any) => Promise<unknown>;
		message: RegExp;
	}> = [
		{
			run: (pool) => pool.query('commit'),
			message: /transaction control statements/
		},
		{
			run: (pool) => pool.query('select ignored callback', () => undefined),
			message: /callback arguments.*Await the returned Promise/
		},
		{
			run: (pool) => pool.query(queryObject),
			message: /query objects are not supported.*plain pg query configuration object/
		}
	];

	for (let index = 0; index < probes.length; index++) {
		const before = calls.length;
		await assert.rejects(
			() =>
				adapter.transaction!(async (tx) => {
					await tx.query(meta, {
						...emptyPlan,
						native: {
							payload: ({ pool }: any) => {
								void probes[index].run(pool);
								return { list: [] };
							}
						}
					});
					await new Promise<void>((resolve) => setImmediate(resolve));
					await tx.create(meta, 20 + index, { id: 20 + index, handle: `must-roll-back-${index}` });
				}),
			probes[index].message
		);
		const transactionCalls = calls.slice(before);
		assert.equal(transactionCalls[0], 'begin');
		assert.match(transactionCalls[1], /^insert into /);
		assert.deepEqual(transactionCalls.slice(2), ['rollback', 'release']);
	}
});

test('PostgreSQL savepoint barriers retain prior unreturned native preflight failures', async () => {
	const calls: string[] = [];
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls[calls.length] = text;
			return { rows: [], rowCount: 1, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	let nativePool!: { query: (query: string) => Promise<unknown> };

	await assert.rejects(
		() => adapter.transaction!(async (tx) => {
			await tx.query(meta, {
				...emptyPlan,
				native: {
					payload: ({ pool }: any) => {
						nativePool = pool;
						return { list: [] };
					}
				}
			});
			void nativePool.query('commit');
			await tx.savepoint!(async () => undefined);
			await tx.create(meta, 80, { id: 80, handle: 'must-roll-back' });
		}),
		/transaction control statements/
	);

	assert.deepEqual(calls.slice(0, 3), [
		'begin',
		'savepoint active_ts_savepoint_1',
		'release savepoint active_ts_savepoint_1'
	]);
	assert.match(calls[3], /^insert into /);
	assert.deepEqual(calls.slice(4), ['rollback', 'release']);
});

test('PostgreSQL transactions reject caught statement failures before commit', async () => {
	const calls: string[] = [];
	const statementError = Object.assign(new Error('duplicate row aborted transaction'), { code: '23505' });
	const client = {
		query: async (text: string) => {
			if (text.startsWith('insert into ')) {
				calls[calls.length] = 'insert';
				throw statementError;
			}
			calls[calls.length] = text;
			return { rows: [], rowCount: 0, command: text === 'commit' ? 'ROLLBACK' : text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await assert.rejects(
					() => tx.create(meta, 1, { id: 1, handle: 'duplicate' }),
					ActiveTsConflictError
				);
				return 'must-not-commit';
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsConfigurationError);
			assert.match(error.message, /cannot commit after a statement failed.*duplicate row aborted transaction/);
			assert.equal(error.cause, statementError);
			return true;
		}
	);
	assert.deepEqual(calls, ['begin', 'insert', 'rollback', 'release']);
});

test('PostgreSQL transactions reject rollback command results from commit', async () => {
	const calls: string[] = [];
	const client = {
		query: async (text: string) => {
			calls[calls.length] = text;
			return {
				rows: [],
				rowCount: 0,
				command: text === 'commit' ? 'ROLLBACK' : text.toUpperCase()
			};
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await assert.rejects(
		() => adapter.transaction!(async () => 'must-not-commit'),
		/commit returned command "ROLLBACK" instead of "COMMIT"/
	);
	assert.deepEqual(calls, ['begin', 'commit', 'rollback', 'release']);
});

test('PostgreSQL transactions reject malformed commit results', async () => {
	const calls: string[] = [];
	let accessorReads = 0;
	const accessorResult = Object.defineProperty({}, 'command', {
		get() {
			accessorReads++;
			return 'COMMIT';
		}
	});
	const commitResults: unknown[] = [
		undefined,
		[],
		{},
		Object.create({ command: 'COMMIT' }),
		accessorResult
	];
	let commitIndex = 0;
	const client = {
		query: async (text: string) => {
			calls[calls.length] = text;
			if (text === 'commit') return commitResults[commitIndex++];
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	for (let index = 0; index < commitResults.length; index++) {
		await assert.rejects(
			() => adapter.transaction!(async () => 'must-not-commit'),
			index < 2 ? /commit result must be an object/ : /command must be an own string data property/
		);
	}
	assert.equal(accessorReads, 0);
	assert.equal(commitIndex, commitResults.length);
	assert.deepEqual(calls, [
		'begin', 'commit', 'release',
		'begin', 'commit', 'release',
		'begin', 'commit', 'release',
		'begin', 'commit', 'release',
		'begin', 'commit', 'release'
	]);
});

test('PostgreSQL commit transport failures skip rollback callbacks', async () => {
	const calls: string[] = [];
	const deferred: string[] = [];
	const commitError = new Error('connection lost while committing');
	let releasedWith: unknown;
	let reportedError: unknown;
	const client = {
		query: async (text: string) => {
			calls[calls.length] = text;
			if (text === 'commit') throw commitError;
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release(error?: unknown) {
			releasedWith = error;
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await tx.afterCommit(() => {
					deferred[deferred.length] = 'commit';
				});
				await tx.afterRollback(() => {
					deferred[deferred.length] = 'rollback';
				});
				return 'unknown';
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsConfigurationError);
			assert.match(error.message, /commit outcome is unknown.*connection lost while committing/);
			assert.equal(error.cause, commitError);
			reportedError = error;
			return true;
		}
	);
	assert.deepEqual(calls, ['begin', 'commit', 'release']);
	assert.deepEqual(deferred, []);
	assert.equal(releasedWith, reportedError);
});

test('PostgreSQL transactions allow caught preflight failures before SQL execution', async () => {
	const calls: string[] = [];
	const client = {
		query: async (text: string) => {
			calls[calls.length] = text;
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	const result = await adapter.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.create(meta, 1, { id: 2, handle: 'mismatched' }),
			ActiveTsValidationError
		);
		return 'committed';
	});

	assert.equal(result, 'committed');
	assert.deepEqual(calls, ['begin', 'commit', 'release']);
});

test('PostgreSQL transaction native SQL rejects transaction control statements', async () => {
	const calls: string[] = [];
	const client = {
		query: async (query: any) => {
			calls.push(typeof query === 'string' ? query : query.text);
			return { rows: [], rowCount: 0 };
		},
		release() {}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: { payload: { text: "select 'commit'; commit" } }
				});
			}),
		/transaction control statements/
	);
	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: { payload: { text: 'select 1 as foo$tag$; commit; select 1 as bar$tag$' } }
				});
			}),
		/transaction control statements/
	);
	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: { payload: { text: 'select 1 -- comment\r; commit' } }
				});
			}),
		/transaction control statements/
	);
	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: { payload: { text: "select E'\\''; commit" } }
				});
			}),
		/transaction control statements/
	);
	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: {
						payload: async ({ pool }: any) => {
							await pool.query({ text: 'rollback' });
							return { list: [] };
						}
					}
				});
			}),
		/transaction control statements/
	);
	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: {
						payload: async ({ pool }: any) => {
							await pool.query("prepare transaction 'active_ts_repro'");
							return { list: [] };
						}
					}
				});
			}),
		/transaction control statements/
	);
	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: {
						payload: async ({ pool }: any) => {
							await pool.query("/* outer /* inner */ still outer */ prepare transaction 'active_ts_nested'");
							return { list: [] };
						}
					}
				});
			}),
		/transaction control statements/
	);
	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: {
						payload: async ({ pool }: any) => {
							await pool.query('set session characteristics as transaction read only');
							return { list: [] };
						}
					}
				});
			}),
		/transaction control statements/
	);
	assert.deepEqual(calls, [
		'begin',
		'rollback',
		'begin',
		'rollback',
		'begin',
		'rollback',
		'begin',
		'rollback',
		'begin',
		'rollback',
		'begin',
		'rollback',
		'begin',
		'rollback',
		'begin',
		'rollback'
	]);
});

test('PostgreSQL transaction native SQL rejects callback query overloads', async () => {
	const calls: string[] = [];
	const client = {
		query: async (text: string) => {
			calls[calls.length] = text;
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	const result = await adapter.transaction!(async (tx) =>
		tx.query(meta, {
			...emptyPlan,
			native: {
				payload: async ({ pool }: any) => {
					await assert.rejects(
						() => pool.query('select callback', () => undefined),
						/callback arguments.*Await the returned Promise/
					);
					await assert.rejects(
						() => pool.query('select callback', [], () => undefined),
						/callback arguments.*Await the returned Promise/
					);
					await assert.rejects(
						() => pool.query({ text: 'select callback', callback: () => undefined }),
						/callback arguments.*Await the returned Promise/
					);
					const queryObject = Object.assign(Object.create({ submit() {} }), {
						text: 'select query object'
					});
					await assert.rejects(
						() => pool.query(queryObject),
						/query objects are not supported.*plain pg query configuration object/
					);
					return { list: [], more: false };
				}
			}
		})
	);

	assert.deepEqual(result, {
		list: [],
		cursor: undefined,
		more: false,
		count: 0,
		total: undefined
	});
	assert.deepEqual(calls, ['begin', 'commit', 'release']);
});

test('PostgreSQL transaction query-object callbacks cannot hide statement failures', async () => {
	const calls: string[] = [];
	const statementError = Object.assign(new Error('query callback failure'), { code: '23505' });
	let deliveredError: unknown;
	const client = {
		query: (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls[calls.length] = text;
			if (typeof query === 'object' && typeof query.callback === 'function') {
				queueMicrotask(() => query.callback(statementError));
				return undefined;
			}
			return Promise.resolve({
				rows: [],
				rowCount: 0,
				command: text === 'commit' ? 'ROLLBACK' : text.toUpperCase()
			});
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.query(meta, {
					...emptyPlan,
					native: {
						payload: async ({ pool }: any) => {
							await pool.query({
								text: 'select callback failure',
								callback: (error: unknown) => {
									deliveredError = error;
								}
							});
							return { list: [] };
						}
					}
				});
				return 'must-not-commit';
			}),
		/callback arguments.*Await the returned Promise/
	);
	assert.equal(deliveredError, undefined);
	assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});

test('PostgreSQL transaction snapshots dynamic query configs before pg dispatch', async () => {
	const calls: string[] = [];
	let deliveredCallback = false;
	const client = {
		query: (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls[calls.length] = text;
			if (typeof query === 'object' && typeof query.callback === 'function') {
				queueMicrotask(() => query.callback(new Error('dynamic callback should not run')));
				return undefined;
			}
			return Promise.resolve({ rows: [], rowCount: 0, command: text.toUpperCase() });
		},
		release() {
			calls[calls.length] = 'release';
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	const dynamicConfig = new Proxy(
		{ text: 'select dynamic config' },
		{
			get(target, property, receiver) {
				if (property === 'callback') {
					return () => {
						deliveredCallback = true;
					};
				}
				return Reflect.get(target, property, receiver);
			}
		}
	);

	await adapter.transaction!(async (tx) => {
		await tx.query(meta, {
			...emptyPlan,
			native: {
				payload: async ({ pool }: any) => {
					await pool.query(dynamicConfig);
					return { list: [] };
				}
			}
		});
	});

	assert.equal(deliveredCallback, false);
	assert.deepEqual(calls, ['begin', 'select dynamic config', 'commit', 'release']);
});

test('PostgreSQL transaction native SQL allows CASE END expressions', async () => {
	const calls: string[] = [];
	const client = {
		query: async (query: any) => {
			const text = typeof query === 'string' ? query : query.text;
			calls.push(text);
			if (/case when true then/.test(text)) {
				return {
					rows: [{ data: { id: 1, handle: 'case-expression' } }],
					rowCount: 1,
					command: 'SELECT'
				};
			}
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release() {}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	const result = await adapter.transaction!(async (tx) =>
		tx.query(meta, {
			...emptyPlan,
			native: {
				payload: {
					text: "select case when true then jsonb_build_object('id', 1, 'handle', 'case-expression') end as data"
				}
			}
		})
	);

	assert.deepEqual(result.list, [{ id: 1, handle: 'case-expression' }]);
	assert.deepEqual(calls, [
		'begin',
		"select case when true then jsonb_build_object('id', 1, 'handle', 'case-expression') end as data",
		'commit'
	]);
});

test('PostgreSQL transaction release failures do not mask primary errors', async () => {
	const calls: string[] = [];
	const client = {
		query: async (text: string) => {
			calls.push(text);
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release: () => {
			calls.push('release');
			throw new Error('release failed');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await assert.rejects(
		() =>
			adapter.transaction!(async () => {
				throw new Error('work failed');
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /work failed/);
			assert.match(((error as any).releaseError as Error).message, /release failed/);
			return true;
		}
	);
	assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});

test('PostgreSQL transaction release error attachment ignores polluted descriptor prototypes', async () => {
	Object.defineProperties(Object.prototype, {
		get: { value: () => undefined, configurable: true },
		set: { value: () => undefined, configurable: true },
		value: { value: 'polluted descriptor value', configurable: true },
		writable: { value: false, configurable: true }
	});
	try {
		const client = {
			query: async () => ({ rows: [], rowCount: 0 }),
			release: () => {
				throw new Error('release failed');
			}
		};
		const adapter = await createPostgresStoreAdapter({
			pool: {
				query: async () => ({ rows: [], rowCount: 0 }),
				connect: async () => client
			}
		});

		await assert.rejects(
			() =>
				adapter.transaction!(async () => {
					throw new Error('work failed');
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /work failed/);
				assert.match(((error as any).releaseError as Error).message, /release failed/);
				return true;
			}
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).get;
		delete (Object.prototype as Record<string, unknown>).set;
		delete (Object.prototype as Record<string, unknown>).value;
		delete (Object.prototype as Record<string, unknown>).writable;
	}
});

test('PostgreSQL transaction release failures surface after successful commit', async () => {
	const calls: string[] = [];
	const client = {
		query: async (text: string) => {
			calls.push(text);
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release: () => {
			calls.push('release');
			throw new Error('release failed');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});

	await assert.rejects(
		() => adapter.transaction!(async () => 'committed'),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.match(error.message, /committed but release failed.*release failed/);
			assert.match((error.cause as Error).message, /release failed/);
			assert.equal(error.result, 'committed');
			return true;
		}
	);
	assert.deepEqual(calls, ['begin', 'commit', 'release']);
});

test('PostgreSQL committed release failures run active context afterCommit tasks', async () => {
	const calls: string[] = [];
	const deferred: string[] = [];
	const client = {
		query: async (text: string) => {
			calls.push(text);
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release: () => {
			calls.push('release');
			throw new Error('release failed');
		}
	};
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => client
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await tx.afterCommit(() => {
					deferred.push('commit');
				});
				await tx.afterRollback(() => {
					deferred.push('rollback');
				});
				return 'committed';
			}),
		/committed but release failed/
	);
	assert.deepEqual(calls, ['begin', 'commit', 'release']);
	assert.deepEqual(deferred, ['commit']);
});

test('PostgreSQL adapter snapshots pool methods at creation', async () => {
	const calls: string[] = [];
	const txClient = {
		query: async (text: string) => {
			calls.push(`tx:${text}`);
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release: () => {
			calls.push('release');
		}
	};
	const pool = {
		query: async (text: string) => {
			calls.push(`pool:${text}`);
			return { rows: [], rowCount: 0 };
		},
		connect: async () => {
			calls.push('connect');
			return txClient;
		}
	};
	const adapter = await createPostgresStoreAdapter({ pool });
	pool.query = async () => {
		throw new Error('mutated postgres pool query should not run');
	};
	pool.connect = async () => {
		throw new Error('mutated postgres pool connect should not run');
	};

	assert.equal(await adapter.get(meta, 1), null);
	await adapter.transaction!(async (tx) => {
		assert.equal(await tx.get(meta, 1), null);
	});
	assert.deepEqual(calls, [
		'pool:select id, data from postgres_regression_record where id = $1',
		'connect',
		'tx:begin',
		'tx:select id, data from postgres_regression_record where id = $1',
		'tx:commit',
		'release'
	]);
});

test('PostgreSQL schema apply shortens long generated index names without collisions', async () => {
	const calls: string[] = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				calls.push(text);
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const sharedLongIndexPrefix = `lookup_${'x'.repeat(80)}`;
	const longMeta: ResolvedModelMeta = {
		...meta,
		name: 'postgres_regression_long_index_names',
		indexes: [
			{ name: `${sharedLongIndexPrefix}_alpha`, fields: ['handle'] },
			{ name: `${sharedLongIndexPrefix}_omega`, fields: ['handle'] }
		]
	};

	await adapter.schema!.apply([longMeta], { mode: 'safe' });

	const indexNames = calls
		.filter((sql) => sql.startsWith('create index if not exists '))
		.map((sql) => {
			const match = sql.match(/^create index if not exists (?:"([^"]+)"|([^\s]+))/);
			assert.ok(match, `expected index identifier in SQL: ${sql}`);
			return match[1] ?? match[2];
		});
	assert.equal(indexNames.length, 2);
	assert.equal(new Set(indexNames).size, 2);
	for (const name of indexNames) {
		assert.ok(Buffer.byteLength(name, 'utf8') <= 63, `expected ${name} to fit PostgreSQL identifier limit`);
		assert.match(name, /_[a-f0-9]{12}$/);
	}
});

test('PostgreSQL unique schema indexes preserve JSON scalar types', async () => {
	const calls: string[] = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => {
				calls.push(text);
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const typedIndexMeta: ResolvedModelMeta = {
		...meta,
		name: 'postgres_regression_typed_unique_index',
		indexes: [
			{ name: 'unique_id', fields: ['id'], unique: true },
			{ name: 'handle_lookup', fields: ['handle'] }
		]
	};

	await adapter.schema!.apply([typedIndexMeta], { mode: 'safe' });

	const uniqueSql = calls.find((sql) => sql.startsWith('create unique index if not exists '));
	const lookupSql = calls.find((sql) => sql.startsWith('create index if not exists '));
	assert.ok(uniqueSql, 'expected unique index SQL');
	assert.ok(lookupSql, 'expected non-unique index SQL');
	assert.match(uniqueSql, /data #> ARRAY\['id'\]/);
	assert.doesNotMatch(uniqueSql, /data #>> ARRAY\['id'\]/);
	assert.match(lookupSql, /data #>> ARRAY\['handle'\]/);
});

test('PostgreSQL JSON field paths accept core-safe non-SQL-identifier segments', async () => {
	const calls: Array<{ text: string; values: any[] }> = [];
	const adapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: any[] = []) => {
				calls.push({ text, values });
				return { rows: [], rowCount: 0 };
			}
		}
	});
	const dashedFieldMeta: ResolvedModelMeta = {
		...meta,
		name: 'postgres_regression_dashed_field',
		indexes: [{ name: 'profile_first_name', fields: ['profile.first-name'] }]
	};

	await adapter.query(dashedFieldMeta, {
		where: [{ field: 'profile.first-name', op: '=', value: 'Ada' }],
		or: [],
		sort: [{ field: 'profile.last-name', direction: 'asc' }],
		include: []
	});

	assert.match(calls[0].text, /data #>> \$1::text\[\]/);
	assert.match(calls[0].text, /order by .*jsonb_typeof\(\(data #> \$3::text\[\]\)\) = 'number'/);
	assert.match(calls[0].text, /\(\(data #>> \$3::text\[\]\)\)::double precision/);
	assert.deepEqual(calls[0].values, [['profile', 'first-name'], 'Ada', ['profile', 'last-name']]);

	calls.length = 0;
	await adapter.schema!.apply([dashedFieldMeta], { mode: 'safe' });

	const indexSql = calls.find((call) => call.text.startsWith('create index if not exists '));
	assert.ok(indexSql, 'expected index SQL');
	assert.match(indexSql.text, /data #>> ARRAY\['profile', 'first-name'\]/);
});
