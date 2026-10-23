import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActiveTsValidationError, type ResolvedModelMeta, type QueryPlan } from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { MemoryStoreAdapter } from '../src/adapters/store/memory.js';

const meta: ResolvedModelMeta = {
	model: class {}, name: 'sort_domain_record', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map()
};
const plan: QueryPlan = { where: [], or: [], sort: [{ field: 'value', direction: 'asc' }], include: [] };

test('PostgreSQL rejects unsupported JSON sort types before silently ranking them', async () => {
	let sql = '';
	const adapter = await createPostgresStoreAdapter({ pool: { async query(text: string) {
		sql = text;
		throw Object.assign(new Error('invalid input syntax for integer'), { code: '22P02' });
	} } });
	await assert.rejects(adapter.query(meta, plan), ActiveTsValidationError);
	assert.match(sql, /else \('active-ts-invalid-sort:'/);
});

test('PostgreSQL scalar sort parity and invalid-domain rejection on a live backend', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async () => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `active_ts_sort_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		const adapter = await createPostgresStoreAdapter({ pool, schema });
		await adapter.schema!.apply([meta], { mode: 'safe' });
		const memory = new MemoryStoreAdapter();
		const rows = [{ id: 1 }, { id: 2, value: null }, { id: 3, value: false }, { id: 4, value: true },
			{ id: 5, value: -1 }, { id: 6, value: 10 }, { id: 7, value: 'alpha' }, { id: 8, value: 'zeta' }];
		await memory.seed(meta, rows);
		for (const row of rows) await adapter.create(meta, row.id, row);
		for (const direction of ['asc', 'desc'] as const) {
			const ordered = { ...plan, sort: [{ field: 'value', direction }, { field: 'id', direction: 'asc' as const }] };
			assert.deepEqual((await adapter.query(meta, ordered)).list, (await memory.query(meta, ordered)).list);
		}
		for (const invalid of [{ nested: 1 }, [2]]) {
			await adapter.create(meta, 9, { id: 9, value: invalid });
			await assert.rejects(adapter.query(meta, { ...plan, limit: 1 }), ActiveTsValidationError);
			// A nonmatching invalid row must not poison an otherwise valid query.
			assert.equal((await adapter.query(meta, { ...plan, where: [{ field: 'id', op: '=', value: 5 }] })).list.length, 1);
			await adapter.delete(meta, 9);
		}
	} finally {
		await pool.query(`drop schema if exists ${schema} cascade`);
		await pool.end();
	}
});
