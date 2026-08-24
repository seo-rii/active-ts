import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	defineModel,
	normalizeAggregateFieldTypes,
	normalizeWhereFieldTypes,
	normalizeWhereShapeFieldTypes,
	type EntityId,
	type QueryResult,
	type ResolvedModelMeta,
	type SearchAdapter,
	type SearchOptions
} from '../src/index.js';

type DateFieldData = {
	id: number;
	label: string;
	seenAt: Date;
};

class DateFieldRecord extends Model<DateFieldData> {}

defineModel<DateFieldData>('date_field_regression_record')
	.id('id')
	.validate((input) => {
		const data = input as DateFieldData;
		if (!data || typeof data.id !== 'number' || typeof data.label !== 'string' || !(data.seenAt instanceof Date)) {
			throw new Error('invalid date record');
		}
		return data;
	})
	.fieldType('seenAt', 'date')
	.search('memory', ['seenAt'])
	.attach(DateFieldRecord);

test('date field types write ISO strings and read Date instances', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = DateFieldRecord.use(context) as unknown as typeof DateFieldRecord;
	const seenAt = new Date('2026-05-14T01:02:03.004Z');

	await Record.create({ id: 1, label: 'created', seenAt });

	assert.deepEqual(store.dump('date_field_regression_record'), [
		{ id: 1, label: 'created', seenAt: '2026-05-14T01:02:03.004Z' }
	]);
	const loaded = await Record.find(1).load();
	assert.ok(loaded?.data.seenAt instanceof Date);
	assert.equal(loaded.data.seenAt.toISOString(), '2026-05-14T01:02:03.004Z');
});

test('date field writes reject custom Date metadata before storage', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = DateFieldRecord.use(context) as unknown as typeof DateFieldRecord;
	const seenAt = new Date('2026-05-14T01:02:03.004Z') as Date & { source?: string };
	seenAt.source = 'fixture';

	await assert.rejects(
		() => Record.create({ id: 1, label: 'custom', seenAt }),
		/Unsupported custom data key "\$\.seenAt\.source"/
	);
	assert.deepEqual(store.dump('date_field_regression_record'), []);
});

test('date field query operands and min max aggregates use canonical dates', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = DateFieldRecord.use(context) as unknown as typeof DateFieldRecord;
	await Record.create({ id: 1, label: 'early', seenAt: new Date('2026-01-01T00:00:00.000Z') });
	await Record.create({ id: 2, label: 'middle', seenAt: new Date('2026-06-01T00:00:00.000Z') });
	await Record.create({ id: 3, label: 'late', seenAt: new Date('2026-12-01T00:00:00.000Z') });

	const range = await Record.query().where('seenAt', '>=', new Date('2026-06-01T00:00:00.000Z'))
		.orderBy('seenAt')
		.load();
	assert.deepEqual(range.list.map((item) => item.data.label), ['middle', 'late']);

	const exact = await Record.where({ seenAt: new Date('2026-01-01T00:00:00.000Z') }).first();
	assert.equal(exact?.data.label, 'early');

	const aggregate = await Record.query().aggregate({
		earliest: { op: 'min', field: 'seenAt' },
		latest: { op: 'max', field: 'seenAt' }
	});
	assert.ok(aggregate.earliest instanceof Date);
	assert.ok(aggregate.latest instanceof Date);
	assert.equal(aggregate.earliest.toISOString(), '2026-01-01T00:00:00.000Z');
	assert.equal(aggregate.latest.toISOString(), '2026-12-01T00:00:00.000Z');
});

test('date field query operands use Date intrinsics instead of overrides', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = DateFieldRecord.use(context) as unknown as typeof DateFieldRecord;
	await Record.create({ id: 1, label: 'early', seenAt: new Date('2026-01-01T00:00:00.000Z') });
	await Record.create({ id: 2, label: 'late', seenAt: new Date('2026-06-01T00:00:00.000Z') });

	class HostileDate extends Date {
		override getTime(): number {
			throw new Error('custom getTime should not run');
		}

		override toISOString(): string {
			throw new Error('custom toISOString should not run');
		}
	}

	const range = await Record.query()
		.where('seenAt', '>=', new HostileDate('2026-06-01T00:00:00.000Z'))
		.load();
	const exact = await Record.where({ seenAt: new HostileDate('2026-01-01T00:00:00.000Z') }).first();

	assert.deepEqual(range.list.map((item) => item.data.label), ['late']);
	assert.equal(exact?.data.label, 'early');
});

test('date field string inputs reject ambiguous or rollover dates', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = DateFieldRecord.use(context) as unknown as typeof DateFieldRecord;

	for (const value of ['1', 'May 14, 2026', '2026-02-31', '2026-05-14T10:02:03+09:00']) {
		await assert.rejects(
			() => Record.query().where('seenAt', '=', value as any).load(),
			/valid ISO date string|canonical ISO date string/
		);
	}

	await store.seed('date_field_regression_record', [{ id: 4, label: 'bad', seenAt: 'May 14, 2026' }]);
	await assert.rejects(() => Record.find(4).load(), /canonical ISO date string/);
});

test('date field normalizers reject sparse public arrays', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DateFieldRecord);

	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, null as any),
		/where must be a plain object/
	);
	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, false as any),
		/where must be a plain object/
	);
	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, { seenAt: new Array(1) as any }),
		/date_field_regression_record\.seenAt\[0\] is missing/
	);
	assert.throws(
		() => normalizeWhereFieldTypes(meta, new Array(1) as any),
		/where entries\[0\] is missing/
	);
});

test('date field normalizers snapshot array operands before mapping', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DateFieldRecord);
	const queryValues = ['2026-05-14'] as any[];
	const entries = [{ field: 'seenAt', op: 'in', value: queryValues }] as any[];
	let entriesMapCalls = 0;
	Object.defineProperty(entries, 'map', {
		value() {
			entriesMapCalls++;
			throw new Error('custom date where entries.map should not run');
		}
	});

	assert.deepEqual(normalizeWhereFieldTypes(meta, entries as any), [
		{ field: 'seenAt', op: 'in', value: ['2026-05-14T00:00:00.000Z'] }
	]);
	assert.equal(entriesMapCalls, 0);

	const shapeValues = ['2026-05-15'] as any[];
	assert.deepEqual(normalizeWhereShapeFieldTypes(meta, { seenAt: shapeValues } as any), {
		seenAt: ['2026-05-15T00:00:00.000Z']
	});
	assert.deepEqual(normalizeWhereShapeFieldTypes(meta, { seenAt: ['isNull'] as any }), {
		seenAt: ['isNull']
	});
	assert.deepEqual(normalizeWhereShapeFieldTypes(meta, { seenAt: ['isNotNull'] as any }), {
		seenAt: ['isNotNull']
	});
	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, { seenAt: ['isNull', 'extra'] as any }),
		/does not accept extra operands/
	);
	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, { seenAt: ['=', '2026-05-15', 'extra'] as any }),
		/does not accept extra operands/
	);
	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, { seenAt: ['between', '2026-05-15', '2026-05-16', 'extra'] as any }),
		/does not accept extra operands/
	);

	let queryValueMapCalls = 0;
	const taggedQueryValues = ['2026-05-16'] as any[];
	Object.defineProperty(taggedQueryValues, 'map', {
		value() {
			queryValueMapCalls++;
			throw new Error('custom date query values.map should not run');
		}
	});
	assert.throws(
		() => normalizeWhereFieldTypes(meta, [{ field: 'seenAt', op: 'in', value: taggedQueryValues }] as any),
		/non-index array property "map"/
	);
	assert.equal(queryValueMapCalls, 0);

	let shapeMapCalls = 0;
	const taggedShapeValues = ['2026-05-17'] as any[];
	Object.defineProperty(taggedShapeValues, 'map', {
		value() {
			shapeMapCalls++;
			throw new Error('custom date shape values.map should not run');
		}
	});
	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, { seenAt: taggedShapeValues } as any),
		/non-index array property "map"/
	);
	assert.equal(shapeMapCalls, 0);

	const iteratorValues = ['2026-05-16'] as any[];
	let iteratorCalls = 0;
	Object.defineProperty(iteratorValues, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom date values iterator should not run');
		}
	});
	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, { seenAt: iteratorValues } as any),
		/date_field_regression_record\.seenAt cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
});

test('date field normalizers reject custom Date operand metadata', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DateFieldRecord);
	const seenAt = new Date('2026-01-01T00:00:00.000Z') as Date & { source?: string };
	seenAt.source = 'fixture';

	assert.throws(
		() => normalizeWhereShapeFieldTypes(meta, { seenAt }),
		/Date value cannot contain custom property "source"/
	);
	assert.throws(
		() => normalizeWhereFieldTypes(meta, [{ field: 'seenAt', op: '=', value: seenAt }]),
		/Date value cannot contain custom property "source"/
	);
});

test('date field where normalizer rejects accessor entries without invoking them', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DateFieldRecord);
	let fieldReads = 0;
	const accessorField = Object.defineProperty({ op: '=', value: '2026-05-14' }, 'field', {
		enumerable: true,
		get() {
			fieldReads++;
			return 'seenAt';
		}
	});

	assert.throws(
		() => normalizeWhereFieldTypes(meta, [accessorField as any]),
		/where entries\[0\]\.field must be a data property/
	);
	assert.equal(fieldReads, 0);

	let valueReads = 0;
	const accessorValue = Object.defineProperty({ field: 'seenAt', op: '=' }, 'value', {
		enumerable: true,
		get() {
			valueReads++;
			return '2026-05-14';
		}
	});

	assert.throws(
		() => normalizeWhereFieldTypes(meta, [accessorValue as any]),
		/where entries\[0\]\.value must be a data property/
	);
	assert.equal(valueReads, 0);

	const hiddenField = Object.defineProperty({ op: '=', value: '2026-05-14' }, 'field', {
		enumerable: false,
		value: 'seenAt'
	});
	assert.throws(
		() => normalizeWhereFieldTypes(meta, [hiddenField as any]),
		/where entries\[0\]\.field must be enumerable/
	);

	assert.throws(
		() => normalizeWhereFieldTypes(meta, [{ field: 'seenAt', op: '=', value: '2026-05-14', val: '2026-05-15' }] as any),
		/where entries\[0\] contains unknown option "val"/
	);
});

test('date field where normalizer rejects hostile operators without coercion', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DateFieldRecord);
	let coercionCalls = 0;
	const hostileOperator = {
		toString() {
			coercionCalls++;
			throw new Error('date where operator coercion should not run');
		}
	};

	assert.throws(
		() => normalizeWhereFieldTypes(meta, [{ field: 'seenAt', op: hostileOperator as any, value: '2026-05-14' }] as any),
		/Query operator is not allowed/
	);
	assert.equal(coercionCalls, 0);
});

test('date field aggregate normalizer rejects accessor specs and results without invoking them', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DateFieldRecord);
	let specReads = 0;
	const accessorSpec = Object.defineProperty({ field: 'seenAt', as: 'latest' }, 'op', {
		enumerable: true,
		get() {
			specReads++;
			return 'max';
		}
	});

	assert.throws(
		() => normalizeAggregateFieldTypes(meta, [accessorSpec as any], { latest: '2026-05-14T00:00:00.000Z' }),
		/Aggregate spec at index 0\.op must be a data property/
	);
	assert.equal(specReads, 0);

	let resultReads = 0;
	const accessorResult = Object.defineProperty({}, 'latest', {
		enumerable: true,
		get() {
			resultReads++;
			return '2026-05-14T00:00:00.000Z';
		}
	});

	assert.throws(
		() => normalizeAggregateFieldTypes(
			meta,
			[{ op: 'max', field: 'seenAt', as: 'latest' }],
			accessorResult as any
		),
		/Aggregate field types result\.latest must be a data property/
	);
	assert.equal(resultReads, 0);
});

test('date field search in-list operands are all canonicalized', async () => {
	let captured: SearchOptions | undefined;
	const search: SearchAdapter = {
		kind: 'capture-date-search',
		capabilities: {
			where: true,
			whereOperators: { in: true },
			cursor: false,
			native: false,
			index: false
		},
		async search(_model: ResolvedModelMeta, _query: string, options: SearchOptions): Promise<QueryResult> {
			captured = options;
			return { list: [{ id: 1, label: 'hit', seenAt: '2026-01-01T00:00:00.000Z' }] };
		},
		async index(_model: ResolvedModelMeta, _id: EntityId, _data: any) {},
		async delete(_model: ResolvedModelMeta, _id: EntityId) {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: search }
	});
	const Record = DateFieldRecord.use(context) as unknown as typeof DateFieldRecord;

	await Record.search('hit')
		.where({ seenAt: ['2026-01-01', '2026-02-01'] as any })
		.load();

	assert.deepEqual(captured?.where, {
		seenAt: ['in', ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']]
	});
});

test('date field search projection stores canonical ISO values', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const search = new MemorySearchAdapter();
	const meta = context.meta(DateFieldRecord);

	await search.index(meta, 1, {
		id: 1,
		label: 'indexed',
		seenAt: new Date('2026-05-14T01:02:03.004Z')
	});

	assert.deepEqual(search.snapshot('date_field_regression_record'), [
		{ id: 1, seenAt: '2026-05-14T01:02:03.004Z' }
	]);
});

test('direct memory search canonicalizes date where operands', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const search = new MemorySearchAdapter();
	const meta = context.meta(DateFieldRecord);

	await search.index(meta, 1, {
		id: 1,
		label: 'early',
		seenAt: new Date('2026-01-01T00:00:00.000Z')
	});
	await search.index(meta, 2, {
		id: 2,
		label: 'late',
		seenAt: new Date('2026-02-01T00:00:00.000Z')
	});

	const result = await search.search(meta, '', {
		where: { seenAt: new Date('2026-01-01T00:00:00.000Z') as any }
	});
	assert.deepEqual(result.list.map((item) => item.id), [1]);
});
