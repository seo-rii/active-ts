import test from 'node:test';
import assert from 'node:assert/strict';
import {
	type AggregateResult,
	MemoryStoreAdapter,
	Model,
	aggregateRows,
	assertAggregateSpecsCompatibleWithModel,
	createActiveTs,
	defaultAggregateResult,
	defaultAggregateValue,
	defineModel,
	normalizeIncludeSpecs,
	normalizeAggregateRow,
	normalizeAggregateResult,
	type StoreAdapter,
	validateAggregateSpecs
} from '../src/index.js';

const aggregateResultTypeCheck: AggregateResult = { count: 1, label: 'a', at: new Date(), empty: null };
void aggregateResultTypeCheck;
// @ts-expect-error boolean aggregate results are not part of the portable result contract.
const invalidBooleanAggregateResultTypeCheck: AggregateResult = { active: true };
void invalidBooleanAggregateResultTypeCheck;

type AggregateData = {
	id: number;
	status: 'open' | 'closed';
	amount: number;
	label?: string | number;
	active?: boolean;
	payload?: Record<string, unknown> | unknown[];
};

type TypedAggregateData = {
	id: number;
	amount: number;
	title: string;
	seenAt: Date;
};

class AggregateRecord extends Model<AggregateData> {}
class DuplicateAggregateAliasHookRecord extends Model<AggregateData> {}
class BooleanAggregateRecord extends Model<AggregateData> {}
class TypedAggregateRecord extends Model<TypedAggregateData> {}

defineModel<AggregateData>('aggregate_regression_record')
	.id('id')
	.validate((input) => input as AggregateData)
	.fieldType('amount', 'number')
	.attach(AggregateRecord);

defineModel<AggregateData>('aggregate_duplicate_alias_hook_record')
	.id('id')
	.validate((input) => input as AggregateData)
	.hooks({
		beforeAggregate(payload) {
			return {
				plan: {
					...(payload.plan as any),
					aggregates: [
						{ op: 'count', as: 'same' },
						{ op: 'sum', field: 'amount', as: 'same' }
					]
				}
			};
		}
	})
	.attach(DuplicateAggregateAliasHookRecord);

defineModel<AggregateData>('boolean_aggregate_record')
	.id('id')
	.validate((input) => input as AggregateData)
	.fieldType('active', 'boolean')
	.attach(BooleanAggregateRecord);

defineModel<TypedAggregateData>('typed_aggregate_result_record')
	.id('id')
	.validate((input) => input as TypedAggregateData)
	.fieldType('amount', 'number')
	.fieldType('title', 'string')
	.fieldType('seenAt', 'date')
	.attach(TypedAggregateRecord);

function aggregateResultStore(result: AggregateResult): StoreAdapter {
	return {
		kind: 'typed-aggregate-result',
		capabilities: {
			aggregate: true,
			nestedFields: true,
			numericComparisons: true,
			nullOperators: true,
			or: true
		},
		get: async () => null,
		getMany: async () => [],
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		aggregate: async () => result
	};
}

test('aggregate defaults are stable for empty result sets', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;
	await store.seed('aggregate_regression_record', [
		{ id: 1, status: 'open', amount: 10 },
		{ id: 2, status: 'open', amount: 20 }
	]);

	const result = await Record.where({ status: 'closed' }).aggregate({
		count: 'count',
		total: { op: 'sum', field: 'amount' },
		average: { op: 'avg', field: 'amount' },
		lowest: { op: 'min', field: 'amount' },
		highest: { op: 'max', field: 'amount' }
	});

	assert.deepEqual(result, {
		count: 0,
		total: 0,
		average: null,
		lowest: null,
		highest: null
	});
});

test('aggregate helpers preserve empty-set defaults', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;

	assert.equal(await Record.where({ status: 'closed' }).count(), 0);
	assert.equal(await Record.where({ status: 'closed' }).sum('amount'), 0);
	assert.equal(await Record.where({ status: 'closed' }).avg('amount'), null);
	assert.equal(await Record.where({ status: 'closed' }).min('amount'), null);
	assert.equal(await Record.where({ status: 'closed' }).max('amount'), null);
});

test('aggregate normalization ignores inherited result aliases', () => {
	Object.defineProperties(Object.prototype, {
		count: { value: 99, configurable: true },
		total: { value: 123, configurable: true }
	});
	try {
		assert.deepEqual(
			normalizeAggregateResult({}, [
				{ op: 'count', as: 'count' },
				{ op: 'sum', field: 'amount', as: 'total' },
				{ op: 'avg', field: 'amount', as: 'average' }
			]),
			{ count: 0, total: 0, average: null }
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).count;
		delete (Object.prototype as Record<string, unknown>).total;
	}
});

test('aggregate normalization rejects unknown result aliases', () => {
	const specs = [
		{ op: 'count', as: 'count' },
		{ op: 'sum', field: 'amount', as: 'total' }
	] as const;

	assert.throws(
		() => normalizeAggregateResult({ count: 1, total: 3, totla: 3 }, specs as any),
		/Aggregate result contains unknown option "totla"/
	);
	assert.throws(
		() => normalizeAggregateRow({ count: 1, total: 3, totla: 3 }, specs as any),
		/Aggregate result contains unknown option "totla"/
	);

	let getterCalls = 0;
	const accessorRow = Object.defineProperty({ count: 1, total: 3 }, 'extra', {
		enumerable: true,
		get() {
			getterCalls++;
			return 4;
		}
	});
	assert.throws(
		() => normalizeAggregateResult(accessorRow as any, specs as any),
		/Aggregate result\.extra must be a data property/
	);
	assert.equal(getterCalls, 0);
});

test('aggregate spec validation rejects inherited spec fields', () => {
	const inherited = Object.create({ op: 'sum', as: 'total', field: 'amount' });
	assert.throws(() => validateAggregateSpecs([inherited as any]), /must be a plain object/);
	assert.throws(() => validateAggregateSpecs(new Array(1) as any), /Aggregate specs\[0\] is missing/);
	assert.throws(() => defaultAggregateResult(new Array(1) as any), /Aggregate specs\[0\] is missing/);
	assert.throws(() => defaultAggregateResult([{} as any]), /Aggregate operator is not allowed/);
	assert.throws(() => defaultAggregateValue({ op: 'cnt', as: 'count' } as any), /Aggregate operator "cnt" is not allowed/);
	assert.throws(() => defaultAggregateValue({ op: 'count', as: 'count', filed: 'id' } as any), /unknown option "filed"/);
	assert.throws(
		() => normalizeAggregateResult({}, [{ op: 'count', as: '__proto__' } as any]),
		/Reserved aggregate alias/
	);
	assert.throws(
		() => normalizeAggregateResult([] as any, [{ op: 'count', as: 'length' }]),
		/Aggregate result must be a plain object/
	);
	assert.throws(
		() => normalizeAggregateResult(new (class AggregateRow {})() as any, [{ op: 'count', as: 'count' }]),
		/Aggregate result must be a plain object/
	);
	assert.throws(
		() => aggregateRows(new Array(1) as any, [{ op: 'count', as: 'count' }]),
		/Aggregate rows\[0\] is missing/
	);
	let iteratorCalls = 0;
	const iteratorRows = [{ amount: 1 }] as unknown[];
	Object.defineProperty(iteratorRows, Symbol.iterator, {
		configurable: true,
		value: function* () {
			iteratorCalls++;
			yield { amount: 99 };
		}
	});
	assert.throws(
		() => aggregateRows(iteratorRows as any, [{ op: 'sum', field: 'amount', as: 'total' }]),
		/Aggregate rows cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	let mapCalls = 0;
	const mappedSpecs = [{ op: 'count', as: 'count' }] as any[];
	Object.defineProperty(mappedSpecs, 'map', {
		configurable: true,
		value() {
			mapCalls++;
			return [];
		}
	});
	assert.deepEqual(validateAggregateSpecs(mappedSpecs), [{ op: 'count', as: 'count' }]);
	assert.deepEqual(normalizeAggregateResult({}, mappedSpecs), { count: 0 });
	assert.deepEqual(normalizeAggregateRow({ count: 2 }, mappedSpecs), { count: 2 });
	assert.equal(mapCalls, 0);
	assert.throws(
		() => validateAggregateSpecs([{ op: 'count', as: 'count', field: 'amount' } as any]),
		/Aggregate "count" does not accept a field for count/
	);
	let getterCalls = 0;
	const accessorSpec = Object.defineProperty({ op: 'sum', as: 'total' }, 'field', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'amount';
		}
	});
	assert.throws(
		() => validateAggregateSpecs([accessorSpec as any]),
		/Aggregate spec at index 0\.field must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenSpec = Object.defineProperty({ op: 'sum', as: 'total' }, 'field', {
		enumerable: false,
		value: 'amount'
	});
	assert.throws(
		() => validateAggregateSpecs([hiddenSpec as any]),
		/Aggregate spec at index 0\.field must be enumerable/
	);
	assert.throws(
		() => validateAggregateSpecs([{ op: 'count', as: 'count', [Symbol('spec')]: true } as any]),
		/Aggregate spec at index 0 cannot contain symbol fields/
	);
	const accessorRow = Object.defineProperty({}, 'count', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	assert.throws(
		() => normalizeAggregateResult(accessorRow as any, [{ op: 'count', as: 'count' }]),
		/Aggregate result\.count must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenRow = Object.defineProperty({}, 'count', {
		enumerable: false,
		value: 1
	});
	assert.throws(
		() => normalizeAggregateResult(hiddenRow as any, [{ op: 'count', as: 'count' }]),
		/Aggregate result\.count must be enumerable/
	);
	const accessorAggregateRow = Object.defineProperty({ id: 1 }, 'amount', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	assert.throws(
		() => aggregateRows([accessorAggregateRow], [{ op: 'sum', field: 'amount', as: 'total' }]),
		/Aggregate field "amount" segment "amount" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenAggregateRow = Object.defineProperty({ id: 1 }, 'amount', {
		enumerable: false,
		value: 1
	});
	assert.throws(
		() => aggregateRows([hiddenAggregateRow], [{ op: 'sum', field: 'amount', as: 'total' }]),
		/Aggregate field "amount" segment "amount" must be enumerable/
	);
	assert.throws(
		() => normalizeAggregateResult({ count: 1, [Symbol('row')]: true } as any, [{ op: 'count', as: 'count' }]),
		/Aggregate result cannot contain symbol fields/
	);
	Object.defineProperties(Object.prototype, {
		op: { value: 'sum', configurable: true },
		as: { value: 'total', configurable: true },
		field: { value: 'amount', configurable: true }
	});
	try {
		assert.throws(() => validateAggregateSpecs([{} as any]), /Aggregate operator is not allowed/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).op;
		delete (Object.prototype as Record<string, unknown>).as;
		delete (Object.prototype as Record<string, unknown>).field;
	}
	class AggregateSpecClass {
		op = 'sum';
		as = 'total';
		field = 'amount';
	}
	assert.throws(() => validateAggregateSpecs([new AggregateSpecClass() as any]), /must be a plain object/);
});

test('aggregate and query selection allowlists use captured Set intrinsics', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;
	let specs: unknown;
	let result: unknown;
	let includes: unknown;
	let aggregateSelectionError: unknown;
	let searchWhereError: unknown;
	const setHas = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!;
	const setAdd = Object.getOwnPropertyDescriptor(Set.prototype, 'add')!;
	Object.defineProperties(Set.prototype, {
		has: {
			configurable: true,
			value() {
				throw new Error('patched Set.has');
			}
		},
		add: {
			configurable: true,
			value() {
				throw new Error('patched Set.add');
			}
		}
	});
	try {
		specs = validateAggregateSpecs([
			{ op: 'count', as: 'count' },
			{ op: 'sum', field: 'amount', as: 'total' }
		]);
		result = normalizeAggregateResult(
			{ count: 1, total: 3 },
			[
				{ op: 'count', as: 'count' },
				{ op: 'sum', field: 'amount', as: 'total' }
			]
		);
		includes = normalizeIncludeSpecs(['author', 'author', { posts: true }]);
		try {
			await Record.query().aggregate({ total: { op: 'sum', field: 'amount', filed: 'amount' } as any });
		} catch (error) {
			aggregateSelectionError = error;
		}
		try {
			Record.search('needle').where({ id: 1 }).where({ id: 2 });
		} catch (error) {
			searchWhereError = error;
		}
	} finally {
		Object.defineProperty(Set.prototype, 'has', setHas);
		Object.defineProperty(Set.prototype, 'add', setAdd);
	}

	assert.deepEqual(specs, [
		{ op: 'count', as: 'count' },
		{ op: 'sum', as: 'total', field: 'amount' }
	]);
	assert.deepEqual(result, { count: 1, total: 3 });
	assert.deepEqual(includes, ['author', 'posts']);
	assert.match(
		(aggregateSelectionError as Error).message,
		/aggregate selection\.total contains unknown option "filed"/
	);
	assert.match(
		(searchWhereError as Error).message,
		/Search where cannot merge multiple filters for field "id"/
	);
});

test('aggregate avg state uses captured Map intrinsics', () => {
	const originals = {
		get: Object.getOwnPropertyDescriptor(Map.prototype, 'get')!,
		set: Object.getOwnPropertyDescriptor(Map.prototype, 'set')!,
		entries: Object.getOwnPropertyDescriptor(Map.prototype, 'entries')!
	};
	const calls = { get: 0, set: 0, entries: 0 };
	Object.defineProperties(Map.prototype, {
		get: {
			configurable: true,
			value() {
				calls.get++;
				throw new Error('patched Map.get');
			}
		},
		set: {
			configurable: true,
			value() {
				calls.set++;
				throw new Error('patched Map.set');
			}
		},
		entries: {
			configurable: true,
			value() {
				calls.entries++;
				throw new Error('patched Map.entries');
			}
		}
	});
	try {
		assert.deepEqual(
			aggregateRows(
				[
					{ amount: 1 },
					{ amount: 2 },
					{ amount: 3 }
				],
				[{ op: 'avg', field: 'amount', as: 'average' }]
			),
			{ average: 2 }
		);
		assert.deepEqual(calls, { get: 0, set: 0, entries: 0 });
	} finally {
		Object.defineProperties(Map.prototype, originals);
	}
});

test('aggregate operator diagnostics reject hostile values without coercion', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;
	let coercionCalls = 0;
	const hostileOperator = {
		toString() {
			coercionCalls++;
			throw new Error('aggregate operator coercion should not run');
		}
	};

	assert.throws(
		() => validateAggregateSpecs([{ op: hostileOperator as any, as: 'count' } as any]),
		/Aggregate operator is not allowed/
	);
	await assert.rejects(
		() => Record.query().aggregate({ count: { op: hostileOperator as any } as any }),
		/Aggregate operator is not allowed/
	);
	assert.equal(coercionCalls, 0);
});

test('aggregate specs reject duplicate aliases from direct plans and hooks', async () => {
	assert.throws(
		() =>
			validateAggregateSpecs([
				{ op: 'count', as: 'same' },
				{ op: 'sum', field: 'amount', as: 'same' }
			]),
		/Duplicate aggregate alias "same"/
	);

	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = DuplicateAggregateAliasHookRecord.use(context) as unknown as typeof DuplicateAggregateAliasHookRecord;

	await assert.rejects(() => Record.count(), /Duplicate aggregate alias "same"/);
	assert.equal(store.stats.aggregate, 0);
	assert.equal(store.stats.query, 0);
});

test('aggregate selection rejects malformed public inputs without raw type errors', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;

	await assert.rejects(() => Record.query().aggregate(null as any), /aggregate selection must be a plain object/);
	await assert.rejects(() => Record.query().aggregate([] as any), /aggregate selection must be a plain object/);
	await assert.rejects(
		() => Record.query().aggregate({ [Symbol('total')]: 'count' } as any),
		/aggregate selection cannot contain symbol fields/
	);
	await assert.rejects(
		() => Record.query().aggregate({ total: null as any }),
		/Aggregate spec at index 0 must be a plain object/
	);
	await assert.rejects(
		() => Record.query().aggregate({ total: 1 as any }),
		/Aggregate spec at index 0 must be a plain object/
	);
	await assert.rejects(
		() => Record.query().aggregate({ total: [] as any }),
		/Aggregate spec at index 0 must be a plain object/
	);
	await assert.rejects(
		() => Record.query().aggregate({ total: { op: 'sum', field: '__amount' } as any }),
		/Reserved aggregate field/
	);
	let specReads = 0;
	const accessorSpec = Object.defineProperty({ field: 'amount' }, 'op', {
		enumerable: true,
		get() {
			specReads++;
			return 'sum';
		}
	});
	await assert.rejects(
		() => Record.query().aggregate({ total: accessorSpec as any }),
		/aggregate selection\.total\.op must be a data property/
	);
	assert.equal(specReads, 0);
	await assert.rejects(
		() => Record.query().aggregate({ total: { op: 'sum', field: 'amount', filed: 'amount' } as any }),
		/aggregate selection\.total contains unknown option "filed"/
	);
	const hiddenSelection = Object.defineProperty({}, 'total', {
		enumerable: false,
		value: 'count'
	});
	await assert.rejects(
		() => Record.query().aggregate(hiddenSelection as any),
		/aggregate selection\.total must be enumerable/
	);
	Object.defineProperty(Object.prototype, 'field', {
		value: 'amount',
		configurable: true
	});
	try {
	await assert.rejects(
		() => Record.query().aggregate({ total: { op: 'sum' } as any }),
		/Aggregate "total" requires a field/
	);
	await assert.rejects(
		() => Record.query().aggregate({ total: { op: 'count', field: 'amount' } as any }),
		/Aggregate "total" does not accept a field for count/
	);
	} finally {
		delete (Object.prototype as Record<string, unknown>).field;
	}
});

test('aggregate min and max reject non-scalar values', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;
	await store.seed('aggregate_regression_record', [
		{ id: 1, status: 'open', amount: 10, payload: { score: 1 } },
		{ id: 2, status: 'open', amount: 20, payload: { score: 2 } }
	]);

	await assert.rejects(
		() => Record.query().aggregate({ highestPayload: { op: 'max', field: 'payload' } } as any),
		/Aggregate "highestPayload" expected scalar comparable values/
	);
});

test('aggregate sum and avg reject corrupted numeric row values', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;
	await store.seed('aggregate_regression_record', [
		{ id: 1, status: 'open', amount: 10 },
		{ id: 2, status: 'open', amount: '2' }
	] as any);

	await assert.rejects(
		() => Record.query().aggregate({ total: { op: 'sum', field: 'amount' } }),
		/Aggregate "total" expected numeric values in field "amount"/
	);
	assert.throws(
		() => aggregateRows([{ amount: 1 }, { amount: '2' }], [{ op: 'avg', field: 'amount', as: 'average' }]),
		/Aggregate "average" expected numeric values in field "amount"/
	);
});

test('aggregate min and max reject mixed scalar types', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;
	await store.seed('aggregate_regression_record', [
		{ id: 1, status: 'open', amount: 10, label: '10' },
		{ id: 2, status: 'open', amount: 20, label: 2 }
	]);

	await assert.rejects(
		() => Record.query().aggregate({ lowestLabel: { op: 'min', field: 'label' } }),
		/Aggregate "lowestLabel" expected comparable values of one scalar type/
	);
});

test('aggregate min and max results must match declared field types', async () => {
	const NumberRecord = TypedAggregateRecord.use(createActiveTs({
		stores: { default: aggregateResultStore({ min: '2' as any }) }
	})) as unknown as typeof TypedAggregateRecord;
	await assert.rejects(
		() => NumberRecord.min('amount'),
		/Aggregate "min" result for field "amount" must match number field type/
	);

	const StringRecord = TypedAggregateRecord.use(createActiveTs({
		stores: { default: aggregateResultStore({ max: 2 as any }) }
	})) as unknown as typeof TypedAggregateRecord;
	await assert.rejects(
		() => StringRecord.max('title'),
		/Aggregate "max" result for field "title" must match string field type/
	);

	const DateRecord = TypedAggregateRecord.use(createActiveTs({
		stores: { default: aggregateResultStore({ max: 2 as any }) }
	})) as unknown as typeof TypedAggregateRecord;
	await assert.rejects(
		() => DateRecord.max('seenAt'),
		/typed_aggregate_result_record\.seenAt must be a Date or ISO date string/
	);

	const ValidDateRecord = TypedAggregateRecord.use(createActiveTs({
		stores: { default: aggregateResultStore({ max: '2026-05-14T00:00:00.000Z' }) }
	})) as unknown as typeof TypedAggregateRecord;
	const latest = await ValidDateRecord.max('seenAt');
	assert.ok(latest instanceof Date);
	assert.equal(latest.toISOString(), '2026-05-14T00:00:00.000Z');
});

test('aggregate min and max reject custom Date metadata', () => {
	const customDate = new Date('2026-05-14T00:00:00.000Z') as Date & { extra?: string };
	customDate.extra = 'dropped';
	const symbolDate = new Date('2026-05-15T00:00:00.000Z');
	Object.defineProperty(symbolDate, Symbol('extra'), { value: true });
	const specs = [{ op: 'max', field: 'seenAt', as: 'latest' }] as const;

	assert.throws(
		() => normalizeAggregateResult({ latest: customDate }, specs as any),
		/Aggregate "latest" Date value cannot contain custom property "extra"/
	);
	assert.throws(
		() => aggregateRows([{ seenAt: customDate }], specs as any),
		/Aggregate "latest" Date value cannot contain custom property "extra"/
	);
	assert.throws(
		() => normalizeAggregateResult({ latest: symbolDate }, specs as any),
		/Aggregate "latest" Date value cannot contain symbol fields/
	);
});

test('aggregate min and max reject boolean values', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AggregateRecord.use(context) as unknown as typeof AggregateRecord;
	await store.seed('aggregate_regression_record', [
		{ id: 1, status: 'open', amount: 10, active: false },
		{ id: 2, status: 'open', amount: 20, active: true }
	]);

	await assert.rejects(
		() => Record.query().aggregate({ highestActive: { op: 'max', field: 'active' } } as any),
		/Aggregate "highestActive" expected scalar comparable values/
	);
	const meta = context.meta(AggregateRecord);
	assert.throws(
		() =>
			assertAggregateSpecsCompatibleWithModel(
				{ ...meta, fieldTypes: new Map([['active', 'boolean']]) },
				[{ op: 'min', field: 'active', as: 'lowestActive' }],
				'test aggregate'
			),
		/test aggregate "lowestActive" does not support boolean min\/max fields/
	);
});

test('core rejects incompatible aggregate specs before custom adapters', async () => {
	let aggregateReached = false;
	const context = createActiveTs({
		stores: {
			default: {
				kind: 'custom-aggregate',
				capabilities: {
					aggregate: true,
					or: true,
					nestedFields: true,
					numericComparisons: true,
					nullOperators: true
				},
				get: async () => null,
				getMany: async () => [],
				query: async () => ({ list: [], more: false }),
				create: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined,
				aggregate: async () => {
					aggregateReached = true;
					return { highestActive: 1 };
				}
			}
		}
	});
	const Record = BooleanAggregateRecord.use(context) as unknown as typeof BooleanAggregateRecord;

	await assert.rejects(
		() => Record.query().aggregate({ highestActive: { op: 'max', field: 'active' } } as any),
		/Aggregate "highestActive" does not support boolean min\/max fields/
	);
	assert.equal(aggregateReached, false);
});
