import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	ActiveTsValidationError, Model, MemoryStoreAdapter, createActiveTs,
	createStoreMiddlewareAdapter, defineModel, type QueryPlan, type StoreAdapter
} from '../src/index.js';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { createNativeSearchAdapter } from '../src/adapters/search/native.js';
import { FIELD_CODEC_QUERY_OPERANDS_ENCODED, encodeQueryPlanFieldCodecs } from '../src/core/field-codecs.js';
import { normalizeQueryPlanFieldTypes } from '../src/core/field-types.js';

type NumericData = { id: number; amount: number; plainNumber?: number };
class NumericRow extends Model<NumericData> {}
defineModel<NumericData>('typed_codec_numeric').id('id')
	.fieldType('amount', 'number').fieldType('plainNumber', 'number')
	.fieldCodec('amount', {
		name: 'numeric-text',
		encode: value => `n:${String(value).padStart(3, '0')}`,
		decode: value => Number(String(value).slice(2)),
		encodeQuery: value => `n:${String(value).padStart(3, '0')}`,
		queryOperators: ['=', '!=', 'in', '>', '<', '>=', '<=', 'between']
	}).attach(NumericRow);

type DateData = { id: number; at: Date };
class DateRow extends Model<DateData> {}
defineModel<DateData>('typed_codec_date').id('id').fieldType('at', 'date')
	.fieldCodec('at', {
		name: 'date-text', encode: value => `d:${String(value)}`,
		decode: value => String(value).slice(2), encodeQuery: value => `d:${String(value)}`,
		queryOperators: ['=', '!=', 'in', '>', '<', '>=', '<=', 'between']
	}).attach(DateRow);

const plan = (where: QueryPlan['where']): QueryPlan => ({ where, or: [], sort: [], include: [] });

for (const backend of ['memory', 'sqlite'] as const) {
	for (const middleware of [false, true]) {
		test(`${backend} typed codecs retain domain semantics through ${middleware ? 'middleware' : 'direct'} queries and aggregates`, async t => {
			const raw: StoreAdapter = backend === 'memory' ? new MemoryStoreAdapter() : await createSqliteStoreAdapter();
			t.after(() => raw.close?.());
			const store: StoreAdapter = middleware ? createStoreMiddlewareAdapter(raw, [async (_operation, next) => next()]) : raw;
			const context = createActiveTs({ stores: { default: store }, aggregate: { allowQueryFallback: true } });
			const NumberModel = NumericRow.use(context), DateModel = DateRow.use(context);
			if (raw.kind === 'sqlite') await raw.schema!.apply([context.meta(NumericRow), context.meta(DateRow)], { mode: 'safe' });
			await NumberModel.create({ id: 1, amount: 42, plainNumber: 1 });
			await NumberModel.create({ id: 2, amount: 7, plainNumber: 2 });
			assert.equal((await NumberModel.find(1).load())!.data.amount, 42);
			assert.deepEqual((await NumberModel.where({ amount: 42 }).load()).list.map(row => row.id), [1]);
			assert.deepEqual((await NumberModel.query().where('amount', 'in', [7, 42]).orderBy('amount').load()).list.map(row => row.id), [2, 1]);
			assert.equal((await NumberModel.query().whereAny({ amount: 42 }, { amount: 7 }).load()).count, 2);
			assert.equal(await NumberModel.where({ plainNumber: 1 }).whereAny({ amount: 42 }, { amount: 7 }).count(), 1);
			assert.equal(await NumberModel.query().where('amount', 'between', 7, 42).count(), 2);
			assert.equal(await NumberModel.where({ amount: 42 }).sum('amount'), 42);
			const direct = await store.query(context.meta(NumericRow), plan([{ field: 'amount', op: '=', value: 42 }]));
			assert.equal(direct.count, 1);
			assert.equal(direct.list[0].amount, 'n:042');
			await assert.rejects(NumberModel.where({ amount: 'n:042' as any }).load(), /must match number field type/);
			await assert.rejects(store.query(context.meta(NumericRow), plan([{ field: 'amount', op: '=', value: 'n:042' }])), /must match number field type/);

			const early = new Date('2026-01-01T00:00:00.000Z'), later = new Date('2026-02-01T00:00:00.000Z');
			await DateModel.create({ id: 1, at: early }); await DateModel.create({ id: 2, at: later });
			assert.deepEqual((await DateModel.where({ at: early }).load()).list.map(row => row.id), [1]);
			assert.equal(await DateModel.query().where('at', 'in', [early, later]).count(), 2);
			assert.equal((await DateModel.query().whereAny({ at: early }, { at: later }).load()).count, 2);
			assert.equal((await DateModel.query().where('at', '>=', early).min('at'))?.getTime(), early.getTime());
			const directDates = await store.query(context.meta(DateRow), plan([{ field: 'at', op: '=', value: early }]));
			assert.equal(directDates.count, 1);
			assert.equal(directDates.list[0].at, 'd:2026-01-01T00:00:00.000Z');
		});
	}
}

test('encoded plans skip only codec domain types and still validate ordinary fields and forged markers', async () => {
	const store = new MemoryStoreAdapter(), context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(NumericRow);
	const encoded = encodeQueryPlanFieldCodecs(meta, plan([{ field: 'amount', op: '=', value: 42 }]));
	assert.equal(normalizeQueryPlanFieldTypes(meta, encoded).where[0].value, 'n:042');
	encoded.where.push({ field: 'plainNumber', op: '=', value: 'invalid' });
	assert.throws(() => normalizeQueryPlanFieldTypes(meta, encoded), /must match number field type/);
	encoded.where.pop();
	encoded.where[0] = { field: 'amount', op: '=', value: Symbol('invalid') };
	assert.throws(() => normalizeQueryPlanFieldTypes(meta, encoded), ActiveTsValidationError);
	const forged = plan([{ field: 'amount', op: '=', value: 'n:042' }]);
	Object.defineProperty(forged, FIELD_CODEC_QUERY_OPERANDS_ENCODED, { value: true });
	await assert.rejects(store.query(meta, forged), /marker is not trusted/);
	await store.create(meta, 1, { id: 1, amount: 'n:042' });
	await store.create(meta, 2, { id: 2, amount: 'n:007' });
	const mixed = encodeQueryPlanFieldCodecs(meta, {
		...plan([{ field: 'amount', op: '!=', value: 7 }]),
		or: [plan([{ field: 'amount', op: '=', value: 42 }]), plan([{ field: 'amount', op: '=', value: 7 }])]
	});
	assert.deepEqual((await store.query(meta, mixed)).list.map(row => row.id), [1]);
});

test('native search marks every encoded branch when one or several typed codec fields are searched', async () => {
	for (const fields of [['first'], ['first', 'second']]) {
		class SearchRow extends Model<{ id: number; first: Date; second: Date }> {}
		let encodes = 0;
		const codec = {
			name: 'native-date-text', encode: (value: unknown) => `d:${String(value)}`,
			decode: (value: unknown) => String(value).slice(2),
			encodeQuery: (value: unknown) => { encodes++; return `d:${String(value)}`; },
			queryOperators: ['textContains'] as const
		};
		defineModel<SearchRow['data']>({ name: `typed_codec_native_${fields.length}`, search: 'native' })
			.id('id').fieldType('first', 'date').fieldCodec('first', codec)
			.fieldType('second', 'date').fieldCodec('second', codec).search('native', fields).attach(SearchRow);
		const store = new MemoryStoreAdapter();
		const context = createActiveTs({ stores: { default: store }, search: { native: createNativeSearchAdapter(store) } });
		const Row = SearchRow.use(context);
		await Row.create({ id: 1, first: new Date('2026-01-01T00:00:00.000Z'), second: new Date('2026-02-01T00:00:00.000Z') });
		const result = await Row.search('2026').load();
		assert.equal(result.count, 1);
		const first = result.list[0].data.first;
		assert.ok(first instanceof Date);
		assert.equal(first.getTime(), new Date('2026-01-01T00:00:00.000Z').getTime());
		assert.equal(encodes, fields.length);
	}
});

test('PostgreSQL codec predicates and ordering use the encoded storage type rather than the domain declaration', async () => {
	const calls: Array<{ text: string; values: any[] }> = [];
	const store = await createPostgresStoreAdapter({ pool: {
		async query(text: string, values: any[] = []) {
			calls.push({ text, values });
			return { rows: [], rowCount: 0 };
		}
	} });
	const context = createActiveTs({ stores: { default: createStoreMiddlewareAdapter(store, []) } });
	for (const [model, field, domain, encoded] of [
		[NumericRow, 'amount', 42, 'n:042'],
		[DateRow, 'at', new Date('2026-01-01T00:00:00.000Z'), 'd:2026-01-01T00:00:00.000Z']
	] as const) {
		const meta = context.meta(model);
		await context.store('default').query(meta, plan([{ field, op: '=', value: domain }]));
		const call = calls.at(-1)!;
		assert.equal(call.values.at(-1), encoded);
		assert.match(call.text, /jsonb_typeof\([^)]*\) = 'string'/);
		assert.match(call.text, /= \$\d+::text/);
		assert.doesNotMatch(call.text, /::double precision|::timestamptz/);
		await store.query(meta, { ...plan([{ field, op: 'in', value: [domain] }]), sort: [{ field, direction: 'asc' }] });
		const ordered = calls.at(-1)!;
		assert.ok(ordered.values.some(value => Array.isArray(value) && value[0] === encoded));
		assert.match(ordered.text, /::text\[\]/);
		assert.match(ordered.text, /when jsonb_typeof\(.+?\) = 'boolean' then 1/);
		assert.doesNotMatch(ordered.text, /::timestamptz/);
	}
});

test('PostgreSQL typed codecs round-trip queries, ordering, native counts and decoded aggregate fallback', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async () => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `typed_codec_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		const store = await createPostgresStoreAdapter({ pool, schema });
		const context = createActiveTs({ stores: { default: createStoreMiddlewareAdapter(store, []) }, aggregate: { allowQueryFallback: true } });
		await store.schema!.apply([context.meta(NumericRow), context.meta(DateRow)], { mode: 'safe' });
		const Numbers = NumericRow.use(context), Dates = DateRow.use(context);
		await Numbers.create({ id: 1, amount: 42 }); await Numbers.create({ id: 2, amount: 7 });
		assert.deepEqual((await Numbers.where({ amount: 42 }).load()).list.map(row => row.id), [1]);
		assert.deepEqual((await Numbers.query().where('amount', 'in', [42, 7]).orderBy('amount').load()).list.map(row => row.id), [2, 1]);
		assert.equal(await Numbers.query().whereAny({ amount: 42 }, { amount: 7 }).count(), 2);
		assert.equal(await Numbers.where({ amount: 42 }).sum('amount'), 42);
		const early = new Date('2026-01-01T00:00:00.000Z'), later = new Date('2026-02-01T00:00:00.000Z');
		await Dates.create({ id: 1, at: early }); await Dates.create({ id: 2, at: later });
		assert.deepEqual((await Dates.where({ at: early }).load()).list.map(row => row.id), [1]);
		assert.equal(await Dates.query().where('at', 'in', [early, later]).count(), 2);
		assert.equal((await Dates.query().where('at', '>=', early).min('at'))?.getTime(), early.getTime());
	} finally {
		try { await pool.query(`drop schema if exists ${schema} cascade`); }
		finally { await pool.end(); }
	}
});
