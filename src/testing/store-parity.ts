import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryStoreAdapter } from '../adapters/store/memory.js';
import { ActiveTsConfigurationError } from '../core/errors.js';
import { assertSafeSchemaIdentifier } from '../core/safe-keys.js';
import type { AggregatePlan, QueryPlan, ResolvedModelMeta, StoreAdapter, StoreCapabilities } from '../core/types.js';

type Capability = keyof StoreCapabilities;
type ParityRow = { id: number; group: string; score?: number | null; label?: string; mixed?: string | number | boolean | null };
export type StoreParityFixture = {
	seed: number;
	rows: ParityRow[];
	queries: { name: string; plan: QueryPlan; requires: Capability[] }[];
	aggregates: { name: string; plan: AggregatePlan }[];
};

/** Reproducible boundary values plus a seeded insertion permutation. No adapter I/O. */
export function createStoreParityFixture(seed = 0x5eed): StoreParityFixture {
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
		throw new ActiveTsConfigurationError('Store parity seed must be an unsigned 32-bit integer.');
	}
	const labels = ['', 'a', 'aa', 'a\0z', '\uD7FF', '\uE000', '\uFFFF', '\u{10000}', '\u{10FFFF}', '한글', 'a'];
	const mixed = [undefined, null, false, true, -1, 0, 1, '', 'a', '\u{10000}', '\uE000'];
	const rows: ParityRow[] = labels.map((label, index) => ({
		id: index + 1, group: 'base', label, score: index % 5,
		...(mixed[index] === undefined ? {} : { mixed: mixed[index] })
	}));
	const averages = [[1e308, 1e308], [-1e308, -1e308], [Number.MIN_VALUE, Number.MIN_VALUE], [1e308, 1, -1e308], [null, null]];
	for (let group = 0; group < averages.length; group++) {
		for (const score of averages[group]) rows.push({ id: rows.length + 1, group: `average_${group}`, score });
	}
	let state = seed || 0x9e3779b9;
	for (let index = rows.length - 1; index > 0; index--) {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
		const target = (state >>> 0) % (index + 1);
		[rows[index], rows[target]] = [rows[target], rows[index]];
	}
	const base: QueryPlan = { where: [{ field: 'group', op: '=', value: 'base' }], or: [], sort: [], include: [] };
	const queries: StoreParityFixture['queries'] = [];
	for (const direction of ['asc', 'desc'] as const) {
		for (const field of ['label', 'mixed']) {
			queries.push({ name: `${field}-${direction}`, plan: { ...base, sort: [{ field, direction }] }, requires: [] });
			queries.push({ name: `${field}-${direction}-page`, plan: { ...base, sort: [{ field, direction }], offset: 2, limit: 3 }, requires: ['offset'] });
		}
	}
	for (const op of ['=', '<', '>', '<=', '>='] as const) {
		for (const value of ['\uE000', '\u{10000}', 'a\0z']) {
			queries.push({ name: `label-${op}-${JSON.stringify(value)}`, plan: { ...base, where: [...base.where, { field: 'label', op, value }] }, requires: [] });
		}
	}
	for (const value of [null, false, 0, '']) {
		queries.push({ name: `typed-equality-${JSON.stringify(value)}`, plan: { ...base, where: [...base.where, { field: 'mixed', op: '=', value }] }, requires: [] });
	}
	for (const op of ['isNull', 'isNotNull'] as const) {
		queries.push({ name: op, plan: { ...base, where: [...base.where, { field: 'mixed', op, value: undefined }] }, requires: ['nullOperators', 'missingFieldNulls'] });
	}
	const aggregates: StoreParityFixture['aggregates'] = [{
		name: 'string-extrema', plan: { where: base.where, or: [], aggregates: [
			{ op: 'min', field: 'label', as: 'minimum' }, { op: 'max', field: 'label', as: 'maximum' }
		] }
	}];
	for (let group = 0; group < averages.length; group++) {
		aggregates.push({ name: `average_${group}`, plan: {
			where: [{ field: 'group', op: '=', value: `average_${group}` }], or: [],
			aggregates: [{ op: 'avg', field: 'score', as: 'mean' }, { op: 'count', as: 'count' }]
		} });
	}
	return { seed, rows, queries, aggregates };
}

export type StoreAdapterDifferentialOptions = {
	seed?: number;
	/** Must be a disposable model name; omitted names are unique to the run. */
	modelName?: string;
	/** Defaults to a new MemoryStoreAdapter; must be a different adapter instance. */
	reference?: StoreAdapter;
};

/**
 * Compare portable boundary behavior with a reference adapter. Uses disposable
 * collections/tables, cleans up inserted rows, and leaves schema cleanup to the
 * caller's integration harness. Never pass a production resource.
 */
export async function runStoreAdapterDifferentialContract(candidate: StoreAdapter, options: StoreAdapterDifferentialOptions = {}) {
	const fixture = createStoreParityFixture(options.seed);
	const reference = options.reference ?? new MemoryStoreAdapter();
	if (candidate === reference) throw new ActiveTsConfigurationError('Store parity requires distinct adapter instances.');
	const model: ResolvedModelMeta = {
		model: class {}, name: assertSafeSchemaIdentifier(options.modelName ?? `parity_${randomUUID()}`),
		store: 'default', idField: 'id', readValidation: 'off', indexes: [{ name: 'label', fields: ['label'] }], searchIndexes: [],
		relations: new Map(), hooks: {}, views: new Map(), policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
		fieldTypes: new Map([['label', 'string'], ['score', 'number']])
	};
	const stores: StoreAdapter[] = [reference, candidate];
	const created: { store: StoreAdapter; id: number }[] = [];
	const result = { seed: fixture.seed, queries: 0, aggregates: 0, pages: 0, rejections: 0, skipped: 0 };
	const check = async (name: string, work: () => Promise<void>) => {
		try { await work(); }
		catch (cause) { throw new Error(`Store parity ${candidate.kind} seed=${fixture.seed} case=${name}`, { cause }); }
	};
	let failure: unknown;
	let failed = false;
	try {
		for (const store of stores) {
			await store.schema?.apply([model], { mode: 'safe' });
			for (const row of fixture.rows) {
				assert.equal(await store.get(model, row.id), null, 'Parity model must not contain existing fixture IDs.');
				await store.create(model, row.id, row);
				created.push({ store, id: row.id });
			}
		}
		for (const entry of fixture.queries) {
			if (entry.requires.some((flag) => stores.some((store) => store.capabilities?.[flag] !== true))) { result.skipped++; continue; }
			await check(entry.name, async () => {
				const expected = await reference.query(model, entry.plan);
				const actual = await candidate.query(model, entry.plan);
				assert.deepEqual({ list: actual.list, count: actual.count, more: actual.more }, { list: expected.list, count: expected.count, more: expected.more });
			});
			result.queries++;
		}
		if (stores.every((store) => store.capabilities?.aggregate && store.aggregate)) {
			for (const entry of fixture.aggregates) {
				await check(entry.name, async () => assert.deepEqual(await candidate.aggregate!(model, entry.plan), await reference.aggregate!(model, entry.plan)));
				result.aggregates++;
			}
		} else result.skipped += fixture.aggregates.length;
		for (const store of stores) {
			if (!store.capabilities?.cursor) continue;
			const plan: QueryPlan = { where: [{ field: 'group', op: '=', value: 'base' }], or: [], sort: [{ field: 'label', direction: 'asc' }], include: [] };
			const expected = (await reference.query(model, plan)).list;
			for (const limit of [1, 3, 7]) {
				await check(`${store.kind}-cursor-${limit}`, async () => {
					const rows: unknown[] = []; let cursor: string | undefined;
					for (let page = 0; page <= expected.length; page++) {
						const current = await store.query(model, { ...plan, limit, ...(cursor ? { cursor } : {}) });
						rows.push(...current.list);
						if (!current.more) { assert.deepEqual(rows, expected); return; }
						assert.ok(current.cursor); assert.notEqual(current.cursor, cursor);
						cursor = current.cursor;
					}
					assert.fail('Cursor did not terminate within the fixture bound.');
				});
				result.pages++;
			}
		}
		for (const invalid of [{}, []]) {
			for (const store of stores) {
				const id = fixture.rows.length + created.length + 1;
				await store.create(model, id, { id, group: 'invalid', mixed: invalid });
				created.push({ store, id });
				await check(`${store.kind}-invalid-sort`, async () => {
					await assert.rejects(store.query(model, { where: [], or: [], sort: [{ field: 'mixed', direction: 'asc' }], include: [], limit: 1 }));
				});
				result.rejections++;
			}
		}
		return result;
	} catch (cause) {
		failed = true; failure = cause; throw cause;
	} finally {
		const cleanup = await Promise.allSettled(created.map(async ({ store, id }) => { await store.delete(model, id); }));
		const failures = cleanup.filter((entry) => entry.status === 'rejected');
		if (failures.length) throw new AggregateError([...(failed ? [failure] : []), ...failures.map((entry) => (entry as PromiseRejectedResult).reason)], 'Store parity fixture cleanup failed.');
	}
}
