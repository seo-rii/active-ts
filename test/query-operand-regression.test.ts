import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySearchAdapter, MemoryStoreAdapter, Model, createActiveTs, defineModel, type SearchAdapter, type StoreAdapter } from '../src/index.js';
import { assertValidWhereOperand, filterRows, setPath, valueFor } from '../src/core/query-utils.js';

type OperandRecordData = {
	id: number;
	score: number;
	title: string;
};

class OperandRecord extends Model<OperandRecordData> {}

defineModel<OperandRecordData>('query_operand_record')
	.id('id')
	.validate((input) => input as OperandRecordData)
	.fieldType('score', 'number')
	.search('memory', ['title'])
	.attach(OperandRecord);

type TypedOperandRecordData = {
	id: number;
	score: number;
	title: string;
	active: boolean;
};

class TypedOperandRecord extends Model<TypedOperandRecordData> {}

defineModel<TypedOperandRecordData>('query_operand_typed_record')
	.id('id')
	.validate((input) => input as TypedOperandRecordData)
	.fieldType('score', 'number')
	.fieldType('title', 'string')
	.fieldType('active', 'boolean')
	.search('memory', ['title'])
	.attach(TypedOperandRecord);

function setup() {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	const Record = OperandRecord.use(context) as unknown as typeof OperandRecord;
	return { context, Record, store };
}

function setupTyped() {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	const Record = TypedOperandRecord.use(context) as unknown as typeof TypedOperandRecord;
	return { context, Record, store };
}

test('query operators reject invalid operand shapes before adapters', async () => {
	const { Record } = setup();

	assert.throws(() => Record.query().where('id', 'in' as any, 1), /requires an array value/);
	assert.throws(() => Record.query().where('score', '>' as any, undefined), /requires a value/);
	assert.throws(() => Record.query().where('score', '>' as any, null), /requires string, number, or Date values/);
	assert.throws(() => Record.query().where('score', '>=' as any, true), /requires string, number, or Date values/);
	assert.throws(() => Record.query().where('title', 'startsWith' as any, undefined), /requires a string value/);
	assert.throws(() => Record.query().where('title', 'textContains' as any, 1), /requires a string value/);
	assert.throws(
		() => Record.query().where('title', 'contains' as any, () => 'late-clone-error'),
		/legacy contains operator is ambiguous/
	);
	assert.throws(
		() => Record.where({ title: ['contains', () => 'late-clone-error'] as any }),
		/legacy contains operator is ambiguous/
	);
	assert.throws(
		() => Record.search('record').where({ title: ['contains', () => 'late-clone-error'] as any }),
		/legacy contains operator is ambiguous/
	);
	assert.throws(() => Record.query().where('title', 'isNull' as any, 'extra'), /does not accept a value/);
	assert.throws(() => Record.query().where('title', 'badOperator' as any, 'value'), /Query operator "badOperator" is not allowed/);
	assert.throws(() => Record.where({ title: ['isNotNull', 'extra'] as any }), /does not accept a value/);
	assert.throws(() => Record.where({ title: ['=', 'safe', 'ignored'] as any }), /does not accept extra operands/);
	assert.throws(() => Record.where({ title: ['isNull', undefined, 'ignored'] as any }), /does not accept extra operands/);
	assert.throws(() => Record.where({ score: ['between', 1, 2, 3] as any }), /does not accept extra operands/);
	assert.throws(() => Record.where({ title: undefined as any }), /query field "title" cannot be undefined/);
	assert.throws(() => Record.search('record').where({ title: ['startsWith', 'safe', 'ignored'] as any }), /does not accept extra operands/);
	assert.throws(() => Record.search('record').where({ title: undefined as any }), /query field "title" cannot be undefined/);
	assert.throws(() => Record.query().where(undefined as any, 1), /query field must be a string/);
	assert.throws(() => Record.query().where(1 as any, 1), /query field must be a string/);
	assert.throws(() => Record.query().orderBy({ direction: 'asc' } as any), /sort field must be a string/);
	assert.throws(() => Record.query().orderBy({ field: 1, direction: 'asc' } as any), /sort field must be a string/);
	Object.defineProperties(Object.prototype, {
		field: { value: 'score', configurable: true },
		direction: { value: 'desc', configurable: true }
	});
	try {
		assert.throws(() => Record.query().orderBy({} as any), /sort field must be a string/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).field;
		delete (Object.prototype as Record<string, unknown>).direction;
	}
	await assert.rejects(
		() => Record.query().aggregate({ total: { op: 'sum', field: 1 as any } }),
		/aggregate field must be a string/
	);
	assert.throws(() => Record.query().where('id', 'in' as any, []), /at least one value/);
	assert.throws(() => Record.where({ id: Array.from({ length: 31 }, (_, index) => index) as any }), /at most 30 values/);
	assert.throws(() => Record.where({ title: { unsafe: true } as any }), /requires string, number, boolean, Date, or null/);
	assert.throws(() => Record.where(null as any), /query where must be a plain object/);
	assert.throws(() => Record.where([{ id: 1 }] as any), /query where must be a plain object/);
	assert.throws(() => Record.where({ [Symbol('tenant')]: 'a' } as any), /cannot contain symbol fields/);
	const hiddenWhere = {};
	Object.defineProperty(hiddenWhere, 'title', { value: 'secret', enumerable: false });
	assert.throws(() => Record.where(hiddenWhere as any), /query where.title must be enumerable/);
	let getterCalls = 0;
	const accessorWhere = Object.defineProperty({}, 'title', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'secret';
		}
	});
	assert.throws(() => Record.where(accessorWhere as any), /query where.title must be a data property/);
	assert.equal(getterCalls, 0);
	assert.throws(() => Record.query().whereAny(null as any), /query where must be a plain object/);
	assert.throws(() => Record.query().whereAny(new Array(1) as any), /whereAny branches\[0\] is missing/);
	assert.throws(() => Record.query().whereAny({ [Symbol('tenant')]: 'a' } as any), /cannot contain symbol fields/);
	assert.throws(() => Record.query().whereAny([] as any), /whereAny\(\) requires at least one branch/);
	assert.throws(() => Record.query().whereAny({} as any), /whereAny branches\[0\] requires at least one where condition/);
	assert.throws(() => Record.query().orWhere({} as any), /orWhere\(\) requires at least one where condition/);
	assert.throws(() => Record.query().where('score', '>' as any, Number.POSITIVE_INFINITY), /finite safe number/);
	assert.throws(() => Record.query().where('title', '=' as any, new Date('invalid')), /requires valid Date values/);
	assert.throws(() => Record.query().where('title', 'in' as any, [new Date('invalid')]), /requires valid Date values/);
	const customDate = new Date('2026-01-01T00:00:00.000Z') as Date & { extra?: string };
	customDate.extra = 'dropped';
	assert.throws(
		() => Record.query().where('title', '=' as any, customDate),
		/Date value cannot contain custom property "extra"/
	);
	assert.throws(
		() => Record.where({ title: ['between', new Date('2026-01-01T00:00:00.000Z'), new Date('invalid')] as any }),
		/requires valid Date values/
	);
	assert.throws(
		() => Record.where({ title: ['between', customDate, new Date('2026-02-01T00:00:00.000Z')] as any }),
		/Date value cannot contain custom property "extra"/
	);
	assert.throws(() => Record.where({ score: ['between', 1] as any }), /requires both bounds/);
	assert.throws(() => Record.where({ score: ['between', 1, '2'] as any }), /requires matching bound types/);
	assert.throws(() => Record.where({ score: ['between', null, null] as any }), /requires string, number, or Date values/);
	assert.throws(() => Record.where({ score: ['between', false, true] as any }), /requires string, number, or Date values/);
	assert.throws(
		() => Record.query().where('title', 'jsonContains' as any, { missing: undefined }),
		/does not support undefined values/
	);
	assert.throws(
		() => Record.query().where('title', 'jsonContains' as any, { at: new Date('2026-05-14T00:00:00.000Z') }),
		/does not support Date values/
	);
	assert.throws(
		() => Record.query().where('title', 'jsonContains' as any, { bytes: new Uint8Array([1, 2, 3]) }),
		/does not support binary values/
	);
	assert.throws(
		() => Record.query().where('title', 'jsonContains' as any, [1, , 3]),
		/Unsupported data value at "\$\[1\]"/
	);
	assert.doesNotThrow(() => Record.where({ id: [1, 2], score: ['between', 1, 2], title: ['isNull'] as any } as any));
});

test('where shape normalization ignores patched Object keys', () => {
	const { Record } = setup();
	const originalKeys = Object.keys;
	Object.defineProperty(Object, 'keys', {
		configurable: true,
		value() {
			throw new Error('patched Object.keys should not run for where shape normalization');
		}
	});
	try {
		assert.doesNotThrow(() => Record.where({ id: 1 }));
		assert.doesNotThrow(() => Record.search('record').where({ title: 'safe' }));
		assert.doesNotThrow(() => Record.query().where('title', 'jsonContains' as any, { nested: { label: 'safe' } }));
		assert.throws(
			() => Record.where({ title: undefined as any }),
			/query field "title" cannot be undefined/
		);
	} finally {
		Object.defineProperty(Object, 'keys', { configurable: true, value: originalKeys });
	}
});

test('query builder load ignores patched Array transforms on the core path', async () => {
	const store: StoreAdapter = {
		kind: 'query-core-array-store',
		capabilities: {},
		get: async () => null,
		getMany: async () => [],
		query: async () => ({
			list: [{ id: 1, score: 10, title: 'core array safe' }],
			more: false
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const Record = OperandRecord.use(context) as unknown as typeof OperandRecord;
	const builder = Record.query().where({ id: 1 });
	const arrayMap = Array.prototype.map;
	const arrayFilter = Array.prototype.filter;
	const arraySome = Array.prototype.some;
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
	Object.defineProperty(Array.prototype, 'some', {
		configurable: true,
		value() {
			throw new Error('patched Array.some');
		}
	});
	let result;
	try {
		result = await builder.load();
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: arrayFilter });
		Object.defineProperty(Array.prototype, 'some', { configurable: true, value: arraySome });
	}
	assert.equal(result?.list.length, 1);
	assert.equal(result?.list[0].data.title, 'core array safe');
});

test('query builder aggregate ignores patched Array transforms on the core path', async () => {
	const store: StoreAdapter = {
		kind: 'aggregate-core-array-store',
		capabilities: { aggregate: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			throw new Error('aggregate should not fall back to query');
		},
		aggregate: async () => ({
			count: 1,
			total: 10
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const Record = OperandRecord.use(context) as unknown as typeof OperandRecord;
	const builder = Record.query().where({ id: 1 });
	const arrayMap = Array.prototype.map;
	const arrayFilter = Array.prototype.filter;
	const arraySome = Array.prototype.some;
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
	Object.defineProperty(Array.prototype, 'some', {
		configurable: true,
		value() {
			throw new Error('patched Array.some');
		}
	});
	let result;
	try {
		result = await builder.aggregate({
			count: 'count',
			total: { op: 'sum', field: 'score' }
		});
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: arrayFilter });
		Object.defineProperty(Array.prototype, 'some', { configurable: true, value: arraySome });
	}
	assert.deepEqual(result, { count: 1, total: 10 });
});

test('search builder load ignores patched Array transforms on the core path', async () => {
	const search: SearchAdapter = {
		kind: 'search-core-array-search',
		search: async () => ({
			list: [{ id: 1, title: 'core search safe' }],
			more: false
		}),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const Record = OperandRecord.use(context) as unknown as typeof OperandRecord;
	const builder = Record.search('safe');
	const arrayMap = Array.prototype.map;
	const arrayFilter = Array.prototype.filter;
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
	let result;
	try {
		result = await builder.load();
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: arrayFilter });
	}
	assert.equal(result?.list.length, 1);
	assert.equal(result?.list[0].data.id, 1);
});

test('two-argument where treats operator-looking strings as equality values', async () => {
	const { Record, store } = setup();
	await store.seed('query_operand_record', [
		{ id: 1, score: 1, title: 'in' },
		{ id: 2, score: 2, title: 'isNull' },
		{ id: 3, score: 3, title: 'between' }
	]);

	const direct = await Record.query().where('title', 'in').load();
	const nullNamed = await Record.query().where('title', 'isNull').load();

	assert.deepEqual(direct.list.map((item) => item.data.id), [1]);
	assert.deepEqual(nullNamed.list.map((item) => item.data.id), [2]);
	assert.throws(() => Record.query().where('title', 'badOperator' as any, 'value'), /Query operator "badOperator" is not allowed/);
});

test('jsonContains operand validation uses captured WeakSet intrinsics', () => {
	const weakSetHas = WeakSet.prototype.has;
	const weakSetAdd = WeakSet.prototype.add;
	let undefinedError: unknown;
	WeakSet.prototype.has = function () {
		throw new Error('patched WeakSet.has');
	};
	WeakSet.prototype.add = function () {
		throw new Error('patched WeakSet.add');
	};
	try {
		assertValidWhereOperand('jsonContains', { nested: { value: 'safe' } }, undefined, 'profile');
		try {
			assertValidWhereOperand('jsonContains', { nested: { missing: undefined } }, undefined, 'profile');
		} catch (error) {
			undefinedError = error;
		}
	} finally {
		WeakSet.prototype.has = weakSetHas;
		WeakSet.prototype.add = weakSetAdd;
	}
	assert.match(
		String((undefinedError as Error | undefined)?.message),
		/Query operator "jsonContains" on "profile" does not support undefined values/
	);
});

test('query limits reject object values without coercion', () => {
	const { Record } = setup();
	let coercionCalls = 0;
	const hostileLimit = {
		toString() {
			coercionCalls++;
			throw new Error('query limit coercion should not run');
		}
	};

	assert.throws(
		() => Record.query().limit(hostileLimit as any),
		/query limit must be a positive safe integer/
	);
	assert.equal(coercionCalls, 0);
});

test('query operator and sort diagnostics reject hostile values without coercion', () => {
	const { Record } = setup();
	let operatorCoercions = 0;
	const hostileOperator = {
		toString() {
			operatorCoercions++;
			throw new Error('query operator coercion should not run');
		}
	};
	assert.throws(
		() => Record.query().where('title', hostileOperator as any, 'value'),
		/Query operator is not allowed/
	);
	assert.throws(
		() => assertValidWhereOperand(hostileOperator as any, 'value', undefined, 'title'),
		/Query operator is not allowed/
	);
	assert.throws(
		() =>
			filterRows([{ id: 1, score: 1, title: 'safe' }], {
				where: [{ field: 'title', op: hostileOperator as any, value: 'safe' }],
				or: []
			} as any),
		/Query operator is not allowed/
	);
	assert.equal(operatorCoercions, 0);

	let directionCoercions = 0;
	const hostileDirection = {
		toString() {
			directionCoercions++;
			throw new Error('sort direction coercion should not run');
		}
	};
	assert.throws(
		() => Record.query().orderBy({ field: 'title', direction: hostileDirection as any }),
		/Sort direction is not allowed/
	);
	assert.equal(directionCoercions, 0);
});

test('query builder supports direct between bounds', async () => {
	const { Record, store } = setup();
	await store.seed('query_operand_record', [
		{ id: 1, score: 1, title: 'low' },
		{ id: 2, score: 2, title: 'middle' },
		{ id: 3, score: 4, title: 'high' },
		{ id: 4, score: 5, title: 'outside' }
	]);

	const page = await Record.query().where('score', 'between', 2, 4).orderBy('score').load();
	assert.deepEqual(page.list.map((item) => item.data.id), [2, 3]);
	assert.throws(() => Record.query().where('score', 'between' as any, 2), /requires both bounds/);
	assert.throws(() => Record.query().where('score', '>=' as any, 2, 4), /does not accept value2/);
});

test('typed field query operands fail fast before adapter execution', async () => {
	const { context, Record, store } = setupTyped();
	await Record.create({ id: 1, score: 1, title: 'one', active: true });
	store.resetStats();
	const meta = context.meta(TypedOperandRecord);

	await assert.rejects(() => Record.where({ score: '1' as any }).load(), /score.*number field type/);
	await assert.rejects(() => Record.query().where('score', 'in' as any, [1, '2']).load(), /score.*number field type/);
	await assert.rejects(() => Record.where({ title: 1 as any }).load(), /title.*string field type/);
	await assert.rejects(() => Record.where({ active: 'true' as any }).load(), /active.*boolean field type/);
	await assert.rejects(() => Record.query().where('score', 'startsWith' as any, '1').load(), /requires a string field type/);
	await assert.rejects(() => Record.search('one').where({ score: '1' as any }).load(), /score.*number field type/);
	await assert.rejects(
		() => store.query(meta, { where: [{ field: 'score', op: '=', value: '1' }], or: [], sort: [], include: [] }),
		/score.*number field type/
	);
	await assert.rejects(
		() => store.aggregate(meta, { where: [{ field: 'score', op: '=', value: '1' }], or: [], aggregates: [{ op: 'count', as: 'count' }] }),
		/score.*number field type/
	);
	assert.equal(store.stats.query, 0);
	assert.equal(store.stats.aggregate, 0);
});

test('portable range filters do not coerce row values', async () => {
	const { Record, store } = setup();
	await store.seed('query_operand_record', [
		{ id: 1, score: null, title: 'null score' } as any,
		{ id: 2, score: false, title: 'boolean score' } as any,
		{ id: 3, score: '2', title: 'string score' } as any,
		{ id: 4, score: 2, title: 'numeric score' }
	]);

	assert.deepEqual((await Record.query().where('score', '>=', 0).orderBy('id').load()).list.map((item) => item.data.id), [4]);
	assert.deepEqual((await Record.query().where('score', 'between', 0, 3).orderBy('id').load()).list.map((item) => item.data.id), [4]);
	assert.deepEqual((await Record.query().where('title', '>=', 'string').orderBy('id').load()).list.map((item) => item.data.id), [3]);
});

test('direct store plans reject extra where value2 fields for unary and binary operators', async () => {
	const { context, store } = setup();
	const meta = context.meta(OperandRecord);

	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'title', op: '=', value: 'safe', value2: 'ignored' }] as any,
				or: [],
				sort: [],
				include: []
			}),
		/Query operator "=" on "title" does not accept value2/
	);
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'title', op: 'isNull', value: undefined, value2: undefined }] as any,
				or: [],
				sort: [],
				include: []
			}),
		/Query operator "isNull" on "title" does not accept value2/
	);
});

test('direct store plans reject hostile operator and sort values without coercion', async () => {
	const { context, store } = setup();
	const meta = context.meta(OperandRecord);
	let operatorCoercions = 0;
	const hostileOperator = {
		toString() {
			operatorCoercions++;
			throw new Error('store operator coercion should not run');
		}
	};
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'title', op: hostileOperator as any, value: 'safe' }],
				or: [],
				sort: [],
				include: []
			}),
		/Query operator is not allowed/
	);
	assert.equal(operatorCoercions, 0);

	let directionCoercions = 0;
	const hostileDirection = {
		toString() {
			directionCoercions++;
			throw new Error('store sort direction coercion should not run');
		}
	};
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [],
				or: [],
				sort: [{ field: 'title', direction: hostileDirection as any }],
				include: []
			}),
		/Sort direction is not allowed/
	);
	assert.equal(directionCoercions, 0);
});

test('query array operands ignore inherited indexes and reject sparse arrays', () => {
	const { Record } = setup();
	const pollutedArrayPrototype = Object.create(Array.prototype);
	Object.defineProperties(pollutedArrayPrototype, {
		0: { value: 'startsWith', configurable: true },
		1: { value: 'polluted', configurable: true },
		2: { value: 99, configurable: true }
	});

	const inheritedOperator = [] as unknown[];
	Object.setPrototypeOf(inheritedOperator, pollutedArrayPrototype);
	inheritedOperator.length = 2;
	assert.throws(
		() => Record.where({ title: inheritedOperator as any }),
		/Query array operand on "title" must not be sparse/
	);

	const sparseIn = [1, , 3] as unknown[];
	Object.setPrototypeOf(sparseIn, pollutedArrayPrototype);
	assert.throws(
		() => Record.where({ id: sparseIn as any }),
		/Query array operand on "id" must not be sparse/
	);

	const inheritedUpperBound = ['between', 1] as unknown[];
	Object.setPrototypeOf(inheritedUpperBound, pollutedArrayPrototype);
	assert.throws(
		() => Record.where({ score: inheritedUpperBound as any }),
		/Query operator "between" on "score" requires both bounds/
	);

	let getterCalls = 0;
	const accessorIn = [1, 2] as unknown[];
	Object.defineProperty(accessorIn, '1', {
		enumerable: true,
		get() {
			getterCalls++;
			return 2;
		}
	});
	assert.throws(
		() => Record.where({ id: accessorIn as any }),
		/Query array operand on "id" must not contain accessors/
	);
	assert.equal(getterCalls, 0);

	const accessorOperator = ['between', 1, 2] as unknown[];
	Object.defineProperty(accessorOperator, '1', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	assert.throws(
		() => Record.where({ score: accessorOperator as any }),
		/Query array operand on "score" must not contain accessors/
	);
	assert.equal(getterCalls, 0);

	const directAccessorIn = [1, 2] as unknown[];
	Object.defineProperty(directAccessorIn, '0', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	assert.throws(
		() => Record.query().where('id', 'in' as any, directAccessorIn),
		/Query operator "in" on "id" array operand must not contain accessors/
	);
	assert.equal(getterCalls, 0);

	const hiddenOperator = ['in'] as unknown[];
	Object.defineProperty(hiddenOperator, '1', {
		enumerable: false,
		value: [1]
	});
	assert.throws(
		() => Record.where({ id: hiddenOperator as any }),
		/Query array operand on "id"\[1\] must be enumerable/
	);

	const taggedOperator = ['in', [1]] as unknown[];
	Object.defineProperty(taggedOperator, 'extra', {
		enumerable: true,
		value: true
	});
	assert.throws(
		() => Record.where({ id: taggedOperator as any }),
		/Query array operand on "id" cannot contain non-index array property "extra"/
	);

	const hiddenDirectIn = [1] as unknown[];
	Object.defineProperty(hiddenDirectIn, '0', {
		enumerable: false,
		value: 1
	});
	assert.throws(
		() => Record.query().where('id', 'in' as any, hiddenDirectIn),
		/Query operator "in" on "id" array operand\[0\] must be enumerable/
	);

	const taggedDirectIn = [1] as unknown[];
	Object.defineProperty(taggedDirectIn, 'source', {
		enumerable: true,
		value: 'caller'
	});
	assert.throws(
		() => Record.query().where('id', 'in' as any, taggedDirectIn),
		/Query operator "in" on "id" array operand cannot contain non-index array property "source"/
	);

	let iteratorCalls = 0;
	const symbolIn = [1, 2] as unknown[];
	Object.defineProperty(symbolIn, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom query operand iterator should not run');
		}
	});
	assert.throws(
		() => Record.where({ id: symbolIn as any }),
		/Query array operand on "id" cannot contain symbol fields/
	);
	assert.throws(
		() => Record.query().where('id', 'in' as any, symbolIn),
		/Query operator "in" on "id" array operand cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
});

test('jsonContains array operands reject caller-controlled array properties', async () => {
	const { context, Record } = setup();
	const search = new MemorySearchAdapter();
	const meta = context.meta(OperandRecord);
	let forEachCalls = 0;
	const expectedTags = [{ tag: 'safe' }] as any[];
	Object.defineProperty(expectedTags, 'forEach', {
		value() {
			forEachCalls++;
			throw new Error('custom jsonContains forEach should not run');
		}
	});

	assert.throws(
		() => Record.query().where('payload', 'jsonContains' as any, expectedTags),
		/Unsupported data value at "\$" cannot contain non-index array property "forEach"/
	);
	assert.throws(
		() => Record.search('safe').where({ payload: ['jsonContains', expectedTags] as any }),
		/Unsupported data value at "\$" cannot contain non-index array property "forEach"/
	);
	await assert.rejects(
		() => search.search(meta, 'safe', { where: { payload: ['jsonContains', expectedTags] as any } }),
		/Unsupported data value at "\$" cannot contain non-index array property "forEach"/
	);
	assert.equal(forEachCalls, 0);

	const hiddenExpected = { tag: 'safe' };
	Object.defineProperty(hiddenExpected, 'hidden', { value: true, enumerable: false });
	assert.throws(
		() => Record.query().where('payload', 'jsonContains' as any, hiddenExpected),
		/Unsupported non-enumerable data key "\$\.hidden"/
	);
});

test('query and search where operands are snapshotted when builders are configured', async () => {
	const { context, Record, store } = setup();
	const search = context.searchAdapter('memory') as MemorySearchAdapter;
	const meta = context.meta(OperandRecord);
	await store.seed('query_operand_record', [
		{ id: 1, score: 1, title: 'one', payload: { tag: 'a' } },
		{ id: 2, score: 2, title: 'two', payload: { tag: 'b' } }
	] as any);
	await search.index(meta, 1, { id: 1, title: 'one' });
	await search.index(meta, 2, { id: 2, title: 'two' });

	const ids = [1];
	const query = Record.where({ id: ids as any });
	ids.push(2);
	assert.deepEqual((await query.load()).list.map((item) => item.data.id), [1]);

	const directIds = [1];
	const directQuery = Record.query().where('id', 'in' as any, directIds);
	directIds.push(2);
	assert.deepEqual((await directQuery.load()).list.map((item) => item.data.id), [1]);

	const jsonOperand = { tag: 'a' };
	const jsonQuery = Record.query().where('payload', 'jsonContains' as any, jsonOperand);
	jsonOperand.tag = 'b';
	assert.deepEqual((await jsonQuery.load()).list.map((item) => item.data.id), [1]);

	const searchIds = [1];
	const searchQuery = Record.search('').where({ id: searchIds as any });
	searchIds.push(2);
	assert.deepEqual((await searchQuery.load()).list.map((item) => item.data.id), [1]);
});

test('whereAny snapshots branch arrays without caller-controlled array methods', async () => {
	const { Record, store } = setup();
	await store.seed('query_operand_record', [
		{ id: 1, score: 1, title: 'one' },
		{ id: 2, score: 2, title: 'two' }
	]);
	let mapCalls = 0;
	const branches = [{ title: 'one' }] as any[];
	Object.defineProperty(branches, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom map should not run');
		}
	});

	const result = await Record.query().whereAny(branches).load();

	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
	assert.equal(mapCalls, 0);

	const symbolBranches = [{ title: 'one' }] as any[];
	Object.defineProperty(symbolBranches, Symbol('branches'), { value: true });
	assert.throws(() => Record.query().whereAny(symbolBranches), /whereAny branches cannot contain symbol fields/);
});

test('public entity id inputs reject non-scalar and unsafe numbers before adapters', async () => {
	const { context, Record } = setup();

	await assert.rejects(() => Record.create({ id: Number.MAX_SAFE_INTEGER + 1, score: 1, title: 'unsafe' }), /safe integer/);
	await assert.rejects(() => (Record as any).create({ id: { value: 1 }, score: 1, title: 'object' }), /string or safe integer/);
	await assert.rejects(() => Record.find(Number.NaN as any).load(), /safe integer/);
	await assert.rejects(() => Record.update(Number.POSITIVE_INFINITY as any, { title: 'bad' }), /safe integer/);
	await assert.rejects(() => Record.delete({ value: 1 } as any), /string or safe integer/);
	await assert.rejects(() => Record.find('x'.repeat(1025)).load(), /loadById id is too long/);

	await Record.create({ id: 1, score: 1, title: 'one' });
	await Record.create({ id: 2, score: 2, title: 'two' });
	let idForEachCalls = 0;
	const ids = [1, 2] as any[];
	Object.defineProperty(ids, 'forEach', {
		value() {
			idForEachCalls++;
			throw new Error('custom entity id array forEach should not run');
		}
	});
	const loaded = await context.loadManyNow(Record, ids);
	assert.deepEqual(loaded.map((item) => item?.data.id), [1, 2]);
	assert.equal(idForEachCalls, 0);

	const hiddenIds = [1] as any[];
	Object.defineProperty(hiddenIds, '0', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => context.loadManyNow(Record, hiddenIds),
		/loadManyNow ids\[0\] must be enumerable/
	);

	let idIteratorCalls = 0;
	const symbolIds = [1] as any[];
	Object.defineProperty(symbolIds, Symbol.iterator, {
		value() {
			idIteratorCalls++;
			throw new Error('custom entity id array iterator should not run');
		}
	});
	await assert.rejects(
		() => context.loadManyNow(Record, symbolIds),
		/loadManyNow ids cannot contain symbol fields/
	);
	assert.equal(idIteratorCalls, 0);
});

test('persisted data rejects unsupported object shapes before adapter writes', async () => {
	const { Record, store } = setup();

	await assert.rejects(() => Record.create(null as any), /create data must be a plain object/);
	await assert.rejects(() => Record.create([] as any), /create data must be a plain object/);
	await assert.rejects(() => Record.update(1, null as any), /update patch must be a plain object/);
	await assert.rejects(() => Record.update(1, [] as any), /update patch must be a plain object/);
	await assert.rejects(
		() => (Record as any).create({ id: 1, score: 1, title: 'bad', payload: new Map([['a', 1]]) }),
		/Unsupported data value/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 2, score: 1, title: 'bad', payload: /unsafe/ }),
		/Unsupported data value/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: () => 'unsafe' }),
		/Unsupported data value/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: Symbol('unsafe') }),
		/Unsupported data value/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: 1n }),
		/Unsupported data value/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: Number.NaN }),
		/finite numbers/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: Number.POSITIVE_INFINITY }),
		/finite numbers/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: new Date('invalid') }),
		/valid dates/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: new Date('2026-05-14T00:00:00.000Z') }),
		/Declare a date field type/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: new Uint8Array([1, 2, 3]) }),
		/stored binary value/
	);
	const customDate = new Date('2026-05-14T00:00:00.000Z') as Date & { extra?: string };
	customDate.extra = 'dropped';
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: customDate }),
		/Unsupported custom data key "\$\.payload\.extra"/
	);
	const customBinary = new Uint8Array([1, 2, 3]) as Uint8Array & { extra?: string };
	customBinary.extra = 'dropped';
	await assert.rejects(
		() => (Record as any).create({ id: 3, score: 1, title: 'bad', payload: customBinary }),
		/Unsupported custom data key "\$\.payload\.extra"/
	);
	await (Record as any).create({ id: 3, score: 1, title: 'ok', payload: undefined });
	assert.deepEqual(store.dump('query_operand_record'), [{ id: 3, score: 1, title: 'ok' }]);
	await assert.rejects(
		() => (Record as any).create({ id: 4, score: 1, title: 'bad', payload: [undefined] }),
		/Unsupported data value/
	);
	await assert.rejects(
		() => (Record as any).create({ id: 4, score: 1, title: 'bad', payload: [1, , 3] }),
		/Unsupported data value at "\$\.payload\[1\]"/
	);
	const hiddenArrayItem = ['alpha'] as any[];
	Object.defineProperty(hiddenArrayItem, '0', { enumerable: false, value: 'alpha' });
	await assert.rejects(
		() => (Record as any).create({ id: 4, score: 1, title: 'bad', payload: hiddenArrayItem }),
		/Unsupported data value at "\$\.payload\[0\]" must be enumerable/
	);
	const arrayWithMetadata = ['alpha'] as any[];
	(arrayWithMetadata as any).label = 'tag';
	await assert.rejects(
		() => (Record as any).create({ id: 4, score: 1, title: 'bad', payload: arrayWithMetadata }),
		/Unsupported data value at "\$\.payload" cannot contain non-index array property "label"/
	);
	const hiddenPayload = { visible: 'yes' };
	Object.defineProperty(hiddenPayload, 'hidden', { value: 'no', enumerable: false });
	await assert.rejects(
		() => (Record as any).create({ id: 4, score: 1, title: 'bad', payload: hiddenPayload }),
		/Unsupported non-enumerable data key "\$\.payload\.hidden"/
	);
	let getterCalls = 0;
	const accessorRow: Record<string, unknown> = { id: 4, score: 1, title: 'bad' };
	Object.defineProperty(accessorRow, 'payload', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'secret';
		}
	});
	await assert.rejects(
		() => (Record as any).create(accessorRow),
		/Unsupported data accessor at "\$\.payload"/
	);
	assert.equal(getterCalls, 0);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	await assert.rejects(
		() => (Record as any).create({ id: 5, score: 1, title: 'bad', payload: circular }),
		/Circular data value/
	);
});

test('search where filters reject invalid operand shapes before filtering', async () => {
	const { context, Record } = setup();
	const search = new MemorySearchAdapter();
	const meta = context.meta(OperandRecord);
	let getterCalls = 0;
	const accessorWhere = Object.defineProperty({}, 'title', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'secret';
		}
	});

	assert.throws(() => Record.search({ text: 'record' } as any), /Search query/);
	assert.throws(() => Record.search('record').where({ __secret: 'x' } as any), /Reserved query field/);
	assert.throws(() => Record.search('record').where({ [Symbol('tenant')]: 'a' } as any), /cannot contain symbol fields/);
	const hiddenWhere = {};
	Object.defineProperty(hiddenWhere, 'title', { value: 'secret', enumerable: false });
	assert.throws(() => Record.search('record').where(hiddenWhere as any), /search where.title must be enumerable/);
	assert.throws(() => Record.search('record').where(accessorWhere as any), /search where.title must be a data property/);
	assert.equal(getterCalls, 0);
	assert.throws(
		() => Record.search('record').where({ title: ['textContains', 1] as any }),
		/requires a string value/
	);
	assert.throws(
		() => Record.search('record').where({ title: undefined as any }),
		/query field "title" cannot be undefined/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: { [Symbol('tenant')]: 'a' } as any }),
		/cannot contain symbol fields/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: accessorWhere as any }),
		/memory search options\.where.title must be a data property/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: hiddenWhere as any }),
		/memory search options\.where.title must be enumerable/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: { title: undefined as any } }),
		/where field "title" cannot be undefined/
	);
	assert.equal(getterCalls, 0);
	await assert.rejects(
		() => search.search(meta, 'record', { where: { id: ['in', 1] as any } }),
		/requires an array value/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: { score: ['between', 1, undefined] as any } }),
		/requires both bounds/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: { title: ['isNull', 'extra'] as any } }),
		/does not accept a value/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: { title: ['startsWith', 'record', 'ignored'] as any } }),
		/does not accept extra operands/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: { title: ['jsonContains', { at: new Date('2026-05-14T00:00:00.000Z') }] as any } }),
		/does not support Date values/
	);
	await assert.rejects(
		() => search.search(meta, 'record', { where: null as any }),
		/where must be a plain object/
	);
	assert.throws(() => Record.search('record').where(null as any), /search where must be a plain object/);
});

test('text operators do not match missing fields through string coercion', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const BoundRecord = OperandRecord.use(context) as unknown as typeof OperandRecord;
	await store.seed('query_operand_record', [
		{ id: 1, score: 1 },
		{ id: 2, score: 2, title: 'undefined' },
		{ id: 3, score: 3, title: 'under' }
	]);

	const contains = await BoundRecord.query().where('title', 'textContains', 'def').load();
	assert.deepEqual(contains.list.map((item) => item.data.id), [2]);
	const caseInsensitive = await BoundRecord.query().where('title', 'textContains', 'DEF').load();
	assert.deepEqual(caseInsensitive.list.map((item) => item.data.id), [2]);

	const prefix = await BoundRecord.query().where('title', 'startsWith', 'und').load();
	assert.deepEqual(prefix.list.map((item) => item.data.id), [2, 3]);
});

test('not-equal filters require the field to exist', async () => {
	const directFiltered = filterRows(
		[
			{ id: 1, title: 'one' },
			{ id: 2 },
			{ id: 3, title: null },
			{ id: 4, title: 'two' }
		],
		{
			where: [{ field: 'title', op: '!=', value: 'one' }],
			or: []
		}
	);
	assert.deepEqual(directFiltered.map((item) => item.id), [3, 4]);

	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const BoundRecord = OperandRecord.use(context) as unknown as typeof OperandRecord;
	await store.seed('query_operand_record', [
		{ id: 1, score: 1, title: 'one' },
		{ id: 2, score: 2 },
		{ id: 3, score: 3, title: null },
		{ id: 4, score: 4, title: 'two' }
	] as any);

	const result = await BoundRecord.query().where('title', '!=', 'one').load();
	assert.deepEqual(result.list.map((item) => item.data.id), [3, 4]);
});

test('portable array and text filters avoid caller-controlled row array methods', () => {
	let includesCalls = 0;
	const tags = ['safe'] as any[];
	Object.defineProperty(tags, 'includes', {
		value() {
			includesCalls++;
			throw new Error('custom array includes should not run');
		}
	});
	assert.throws(
		() =>
			filterRows([{ id: 1, tags }], {
				where: [{ field: 'tags', op: 'arrayContains', value: 'safe' }],
				or: []
			}),
		/arrayContains row value "tags" cannot contain non-index array property "includes"/
	);
	assert.equal(includesCalls, 0);

	const ids = [1] as any[];
	Object.defineProperty(ids, 'includes', {
		value() {
			includesCalls++;
			throw new Error('custom query includes should not run');
		}
	});
	assert.throws(
		() =>
			filterRows([{ id: 1 }], {
				where: [{ field: 'id', op: 'in', value: ids }],
				or: []
			}),
		/Query operator "in" on "id" array operand cannot contain non-index array property "includes"/
	);
	assert.equal(includesCalls, 0);

	let getterCalls = 0;
	const titles = [] as any[];
	Object.defineProperty(titles, '0', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'needle';
		}
	});
	titles.length = 1;
	assert.throws(
		() =>
			filterRows([{ id: 2, titles }], {
				where: [{ field: 'titles', op: 'textContains', value: 'needle' }],
				or: []
			}),
		/textContains row value\[0\] must be a data property/
	);
	assert.equal(getterCalls, 0);

	const sparseTags = new Array(1);
	assert.throws(
		() =>
			filterRows([{ id: 3, tags: sparseTags }], {
				where: [{ field: 'tags', op: 'arrayContains', value: 'safe' }],
				or: []
			}),
		/arrayContains row value "tags"\[0\] is missing\. Sparse arrays are not allowed\./
	);

	const sparseTitles = new Array(1);
	assert.throws(
		() =>
			filterRows([{ id: 4, titles: sparseTitles }], {
				where: [{ field: 'titles', op: 'textContains', value: 'needle' }],
				or: []
			}),
		/textContains row value\[0\] is missing\. Sparse arrays are not allowed\./
	);
});

test('field path helpers ignore inherited values and never write through inherited containers', async () => {
	Object.defineProperties(Object.prototype, {
		id: { value: 99, writable: true, configurable: true },
		title: { value: 'polluted-title', configurable: true },
		profile: { value: {}, configurable: true },
		secret: { value: 'polluted-secret', configurable: true }
	});
		try {
			assert.equal(valueFor({}, 'title'), undefined);
			let fieldReads = 0;
			const accessorSource = Object.defineProperty({}, 'profile', {
				enumerable: true,
				get() {
					fieldReads++;
					return { name: 'Ada' };
				}
			});
			assert.throws(
				() => valueFor(accessorSource, 'profile.name'),
				/field path "profile\.name" segment "profile" must be a data property/
			);
			assert.equal(fieldReads, 0);
			const hiddenSource = Object.defineProperty({}, 'profile', {
				enumerable: false,
				value: { name: 'Ada' }
			});
			assert.throws(
				() => valueFor(hiddenSource, 'profile.name'),
				/field path "profile\.name" segment "profile" must be enumerable/
			);
			const hiddenLeafSource = { profile: Object.defineProperty({}, 'name', { enumerable: false, value: 'Ada' }) };
			assert.throws(
				() => valueFor(hiddenLeafSource, 'profile.name'),
				/field path "profile\.name" segment "profile\.name" must be enumerable/
			);
			const target: Record<string, unknown> = {};
			setPath(target, 'profile.name', 'Ada');
			assert.deepEqual(target, { profile: { name: 'Ada' } });
			assert.equal(((Object.prototype as any).profile as Record<string, unknown>).name, undefined);
			assert.throws(() => valueFor({}, 'profile\0name'), /field path must not contain null bytes/);
			assert.throws(() => setPath({}, 'profile\0name', 'Ada'), /field path must not contain null bytes/);
			const hiddenContainer = Object.defineProperty({}, 'profile', {
				enumerable: false,
				value: {}
			});
			assert.throws(
				() => setPath(hiddenContainer as Record<string, unknown>, 'profile.name', 'Ada'),
				/Cannot set field path "profile\.name" because "profile" must be enumerable/
			);
			const accessorContainer = Object.defineProperty({}, 'profile', {
				enumerable: true,
				get() {
					fieldReads++;
					return {};
				}
			});
			assert.throws(
				() => setPath(accessorContainer as Record<string, unknown>, 'profile.name', 'Ada'),
				/Cannot set field path "profile\.name" because "profile" must be a data property/
			);
			const accessorLeaf = { profile: {} };
			Object.defineProperty(accessorLeaf.profile, 'name', {
				enumerable: true,
				set() {
					fieldReads++;
				}
			});
			assert.throws(
				() => setPath(accessorLeaf, 'profile.name', 'Ada'),
				/Cannot set field path "profile\.name" because "profile\.name" must be a data property/
			);
			const hiddenLeafTarget = { profile: Object.defineProperty({}, 'name', {
				enumerable: false,
				value: 'old',
				writable: true
			}) };
			assert.throws(
				() => setPath(hiddenLeafTarget, 'profile.name', 'Ada'),
				/Cannot set field path "profile\.name" because "profile\.name" must be enumerable/
			);
			assert.equal(fieldReads, 0);

			const store = new MemoryStoreAdapter();
		const context = createActiveTs({ stores: { default: store } });
		const BoundRecord = OperandRecord.use(context) as unknown as typeof OperandRecord;
		await store.seed('query_operand_record', [
			{ id: 1, score: 1, title: 'own', payload: {} },
			{ id: 2, score: 2 }
		]);

		const inheritedTitle = await BoundRecord.where({ title: 'polluted-title' }).load();
		assert.deepEqual(inheritedTitle.list.map((item) => item.data.id), []);

		const inheritedJson = await BoundRecord.query()
			.where('payload', 'jsonContains', { secret: 'polluted-secret' })
			.load();
		assert.deepEqual(inheritedJson.list.map((item) => item.data.id), []);

		const directFiltered = filterRows([{ title: 'missing id' }] as any[], {
			where: [{ field: 'title', op: '=', value: 'polluted-title' }],
			or: []
		});
		assert.deepEqual(directFiltered, []);
	} finally {
		delete (Object.prototype as Record<string, unknown>).id;
		delete (Object.prototype as Record<string, unknown>).title;
		delete (Object.prototype as Record<string, unknown>).profile;
		delete (Object.prototype as Record<string, unknown>).secret;
	}
});

test('nested projection rejects scalar prefix collisions with validation errors', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const BoundRecord = OperandRecord.use(context) as unknown as typeof OperandRecord;
	await store.seed('query_operand_record', [
		{ id: 1, score: 1, title: 'one', profile: 'scalar-prefix' }
	]);

	await assert.rejects(
		() => BoundRecord.query().select('profile', 'profile.label').load(),
		/select fields cannot include both "profile" and nested field "profile\.label"/
	);
});

test('partial projection omits missing selected fields instead of materializing undefined', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const BoundRecord = OperandRecord.use(context) as unknown as typeof OperandRecord;
	await store.seed('query_operand_record', [{ id: 1, score: 1, title: 'one' }]);

	const result = await BoundRecord.query().select('title', 'missing').load();
	assert.deepEqual(result.list[0].data, { id: 1, title: 'one' });
});

test('portable row filtering evaluates nested OR branches recursively', () => {
	const rows = [
		{ id: 1, score: 1, title: 'one' },
		{ id: 2, score: 2, title: 'two' },
		{ id: 3, score: 3, title: 'three' }
	];

	const result = filterRows(rows, {
		where: [],
		or: [
			{
				where: [{ field: 'title', op: '=', value: 'missing' }],
				or: [
					{
						where: [{ field: 'score', op: '=', value: 2 }],
						or: [],
						sort: [],
						include: []
					}
				],
				sort: [],
				include: []
			}
		]
	});

	assert.deepEqual(result.map((row) => row.id), [2]);
});

test('portable row filtering snapshots top-level rows and plan arrays', () => {
	let rowFilterCalls = 0;
	let whereEveryCalls = 0;
	let orSomeCalls = 0;
	let accessorCalls = 0;
	const rows = [{ id: 1, score: 1, title: 'one' }] as any[];
	Object.defineProperty(rows, 'filter', {
		value() {
			rowFilterCalls++;
			throw new Error('custom row filter should not run');
		}
	});
	const where = [{ field: 'title', op: '=', value: 'one' }] as any[];
	Object.defineProperty(where, 'every', {
		value() {
			whereEveryCalls++;
			throw new Error('custom where every should not run');
		}
	});
	const or = [] as any[];
	Object.defineProperty(or, 'some', {
		value() {
			orSomeCalls++;
			throw new Error('custom or some should not run');
		}
	});

	const result = filterRows(rows, { where, or });
	assert.deepEqual(result.map((row) => row.id), [1]);
	assert.equal(rowFilterCalls, 0);
	assert.equal(whereEveryCalls, 0);
	assert.equal(orSomeCalls, 0);

	const accessorPlan = Object.defineProperty({ or: [] }, 'where', {
		enumerable: true,
		get() {
			accessorCalls++;
			return [];
		}
	});
	assert.throws(
		() => filterRows([{ id: 1 }], accessorPlan as any),
		/portable filter plan\.where must be a data property/
	);
	assert.equal(accessorCalls, 0);
});

test('portable row filtering snapshots where entry predicate fields', () => {
	let fieldGetterCalls = 0;
	const accessorEntry = Object.defineProperties({}, {
		field: {
			enumerable: true,
			get() {
				fieldGetterCalls++;
				return 'title';
			}
		},
		op: { enumerable: true, value: '=' },
		value: { enumerable: true, value: 'one' }
	});
	assert.throws(
		() => filterRows([{ id: 1, title: 'one' }], { where: [accessorEntry as any], or: [] }),
		/portable filter plan\.where\[0\]\.field must be a data property/
	);
	assert.equal(fieldGetterCalls, 0);

	const inheritedEntry = Object.create({ field: 'title' });
	Object.defineProperties(inheritedEntry, {
		op: { enumerable: true, value: '=' },
		value: { enumerable: true, value: 'one' }
	});
	assert.throws(
		() => filterRows([{ id: 1, title: 'one' }], { where: [inheritedEntry], or: [] }),
		/portable filter plan\.where\[0\] must be a plain object/
	);

	const hiddenEntry = { field: 'title', op: '=', value: 'one' };
	Object.defineProperty(hiddenEntry, 'op', { enumerable: false, value: '=' });
	assert.throws(
		() => filterRows([{ id: 1, title: 'one' }], { where: [hiddenEntry as any], or: [] }),
		/portable filter plan\.where\[0\]\.op must be enumerable/
	);

	assert.throws(
		() => filterRows([{ id: 1, title: 'one' }], {
			where: [{ field: 'title', op: '=', value: 'one', val: 'typo' } as any],
			or: []
		}),
		/portable filter plan\.where\[0\] contains unknown option "val"/
	);
	assert.throws(
		() => filterRows([{ id: 1, title: 'one' }], {
			where: [{ field: 'title', op: 'contains', value: () => 'late clone error' } as any],
			or: []
		}),
		/legacy contains operator is ambiguous/
	);
});

test('portable jsonContains filtering avoids caller-controlled row array methods', () => {
	let someCalls = 0;
	let getterCalls = 0;
	const tags = ['safe'] as any[];
	Object.defineProperty(tags, 'some', {
		value() {
			someCalls++;
			throw new Error('custom jsonContains some should not run');
		}
	});
	assert.throws(
		() =>
			filterRows([{ id: 1, tags }], {
				where: [{ field: 'tags', op: 'jsonContains', value: 'safe' }],
				or: []
			}),
		/jsonContains array value cannot contain non-index array property "some"/
	);
	assert.equal(someCalls, 0);

	const accessorRow = {
		payload: Object.defineProperty({}, 'tag', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'safe';
			}
		})
	};
	assert.throws(
		() =>
			filterRows([accessorRow], {
				where: [{ field: 'payload', op: 'jsonContains', value: { tag: 'safe' } }],
				or: []
			}),
		/jsonContains value at "tag" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenExpected = { tag: 'safe' };
	Object.defineProperty(hiddenExpected, 'hidden', { enumerable: false, value: true });
	assert.throws(
		() =>
			filterRows([{ id: 2, payload: { tag: 'safe' } }], {
				where: [{ field: 'payload', op: 'jsonContains', value: hiddenExpected }],
				or: []
			}),
		/Unsupported non-enumerable data key "\$\.hidden"/
	);
	const hiddenValue = { tag: 'safe' };
	Object.defineProperty(hiddenValue, 'tag', { enumerable: false, value: 'safe' });
	assert.throws(
		() =>
			filterRows([{ id: 3, payload: hiddenValue }], {
				where: [{ field: 'payload', op: 'jsonContains', value: { tag: 'safe' } }],
				or: []
			}),
		/jsonContains value at "tag" must be enumerable/
	);
	const hiddenArrayValue = ['safe'] as any[];
	Object.defineProperty(hiddenArrayValue, '0', { enumerable: false, value: 'safe' });
	assert.throws(
		() =>
			filterRows([{ id: 4, tags: hiddenArrayValue }], {
				where: [{ field: 'tags', op: 'jsonContains', value: 'safe' }],
				or: []
			}),
		/jsonContains array value\[0\] must be enumerable/
	);
	const sparseArrayValue = new Array(1);
	assert.throws(
		() =>
			filterRows([{ id: 9, tags: sparseArrayValue }], {
				where: [{ field: 'tags', op: 'jsonContains', value: 'safe' }],
				or: []
			}),
		/jsonContains array value\[0\] is missing\. Sparse arrays are not allowed\./
	);
	assert.deepEqual(
		filterRows(
			[
				{ id: 7, tags: ['alpha', { label: 'beta' }] },
				{ id: 8, tags: ['alpha'] }
			],
			{
				where: [{ field: 'tags', op: 'jsonContains', value: ['alpha', { label: 'beta' }] }],
				or: []
			}
		).map((row) => row.id),
		[7]
	);
	assert.throws(
		() =>
			filterRows([{ id: 5, payload: { tag: 'safe' } }], {
				where: [{ field: 'payload', op: 'jsonContains', value: new Date('2026-05-14T00:00:00.000Z') }],
				or: []
			}),
		/Query operator "jsonContains" on "payload" does not support Date values/
	);
	assert.throws(
		() =>
			filterRows([{ id: 6, payload: new Date('2026-05-14T00:00:00.000Z') }], {
				where: [{ field: 'payload', op: 'jsonContains', value: {} }],
				or: []
			}),
		/jsonContains value must be a plain object or array/
	);
});

test('portable jsonContains object filtering ignores patched Array every', () => {
	const arrayEvery = Object.getOwnPropertyDescriptor(Array.prototype, 'every');
	Object.defineProperty(Array.prototype, 'every', {
		configurable: true,
		value() {
			throw new Error('patched Array.every');
		}
	});
	try {
		const rows = filterRows(
			[
				{ id: 1, payload: { tag: 'safe', nested: { value: 1 } } },
				{ id: 2, payload: { tag: 'other', nested: { value: 1 } } }
			],
			{
				where: [{ field: 'payload', op: 'jsonContains', value: { tag: 'safe', nested: { value: 1 } } }],
				or: []
			}
		);
		assert.deepEqual(
			rows.map((row) => row.id),
			[1]
		);
	} finally {
		if (arrayEvery) Object.defineProperty(Array.prototype, 'every', arrayEvery);
		else delete (Array.prototype as any).every;
	}
});
