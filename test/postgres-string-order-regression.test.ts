import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ResolvedModelMeta, QueryPlan } from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { MemoryStoreAdapter } from '../src/adapters/store/memory.js';

const meta: ResolvedModelMeta = {
	model: class {}, name: 'string_order_record', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['value', 'string']])
};
const plan: QueryPlan = { where: [], or: [], sort: [{ field: 'value', direction: 'asc' }], include: [] };
const strings = ['', 'Z', 'a', 'é', 'e\u0301', '\uD7FE', '\uD7FF', '\uD7FFa', '\uD7FF\uE000',
	'\uD7FF\uE000\u{10000}', '\u{10000}', '\u{10000}a', '\u{10001}', '\u{1F600}', '\u{10FFFF}', '\uE000', '\uFFFF'];

test('PostgreSQL string comparisons request explicit collation and reversible UTF-16 order keys', async () => {
	const sql: string[] = [];
	const adapter = await createPostgresStoreAdapter({ pool: { async query(text: string) { sql.push(text); return { rows: [] }; } } });
	await adapter.query(meta, { ...plan, where: [{ field: 'value', op: '>', value: 'Z' }] });
	assert.match(sql[0], /regexp_replace/);
	assert.match(sql[0], /collate "C"/);
	await adapter.query(meta, { ...plan, sort: [], where: [{ field: 'value', op: '=', value: 'Z' }] });
	assert.match(sql[1], /collate "C"/);
	assert.doesNotMatch(sql[1], /regexp_replace/);
});

test('PostgreSQL UTF-16 order, ranges, and min/max agree with Memory on a live backend', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async () => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `active_ts_strings_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		const adapter = await createPostgresStoreAdapter({ pool, schema });
		await adapter.schema!.apply([meta], { mode: 'safe' });
		const memory = new MemoryStoreAdapter();
		const rows = strings.map((value, id) => ({ id, value }));
		await memory.seed(meta, rows);
		for (const row of rows) await adapter.create(meta, row.id, row);
		for (const declared of [meta, { ...meta, fieldTypes: new Map() }]) {
			for (const direction of ['asc', 'desc'] as const) {
				const ordered = { ...plan, sort: [{ field: 'value', direction }] };
				assert.deepEqual((await adapter.query(declared, ordered)).list, (await memory.query(declared, ordered)).list);
			}
			for (const value of strings) {
				for (const op of ['=', '!=', '>', '>=', '<', '<='] as const) {
					const filtered = { ...plan, where: [{ field: 'value', op, value }] };
					assert.deepEqual((await adapter.query(declared, filtered)).list, (await memory.query(declared, filtered)).list, `${op} ${value}`);
				}
			}
			for (const clause of [
				{ field: 'value', op: 'between', value: '\uD7FF', value2: '\uE000' },
				{ field: 'value', op: 'in', value: ['Z', 'a', '\u{10000}'] }
			] as QueryPlan['where']) {
				assert.deepEqual((await adapter.query(declared, { ...plan, where: [clause] })).list,
					(await memory.query(declared, { ...plan, where: [clause] })).list);
			}
		}
		// Every input must round-trip through min/max, including literal escape-prefix sequences.
		for (const value of strings) {
			for (const op of ['min', 'max'] as const) {
				const aggregate = { where: [{ field: 'value', op: '=' as const, value }], or: [], aggregates: [{ op, field: 'value', as: 'result' }] };
				assert.deepEqual(await adapter.aggregate!(meta, aggregate), { result: value });
			}
		}
		for (const op of ['min', 'max'] as const) {
			const aggregate = { where: [], or: [], aggregates: [{ op, field: 'value', as: 'result' }] };
			assert.deepEqual(await adapter.aggregate!(meta, aggregate), await memory.aggregate!(meta, aggregate));
		}
	} finally {
		await pool.query(`drop schema if exists ${schema} cascade`);
		await pool.end();
	}
});
