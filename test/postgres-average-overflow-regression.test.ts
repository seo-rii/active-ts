import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActiveTsValidationError, MemoryStoreAdapter, type AggregatePlan, type ResolvedModelMeta } from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';

const model: ResolvedModelMeta = {
	model: class {}, name: 'finite_average', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['value', 'number']])
};
const plan: AggregatePlan = { where: [], or: [], aggregates: [{ op: 'avg', field: 'value', as: 'mean' }] };

test('PostgreSQL averages stay finite when the intermediate sum would overflow', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async (t) => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `active_ts_avg_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		const postgres = await createPostgresStoreAdapter({ pool, schema });
		t.diagnostic((await pool.query('select version() as version')).rows[0].version);
		await postgres.schema!.apply([model], { mode: 'safe' });
		for (const values of [
			[Number.MAX_VALUE, Number.MAX_VALUE], [-Number.MAX_VALUE, -Number.MAX_VALUE],
			[1e308, 1e308], [-1e308, -1e308], [Number.MAX_VALUE, -Number.MAX_VALUE],
			[1e308, 1e308, -1e308, -1e308], [Number.MIN_VALUE, Number.MIN_VALUE],
			[1, 2, 3], [null, null], []
		] as Array<Array<number | null>>) {
			await pool.query(`truncate ${schema}.${model.name}`);
			const memory = new MemoryStoreAdapter();
			for (const [index, value] of values.entries()) {
				const row = { id: index + 1, value };
				await postgres.create(model, row.id, row);
				await memory.create(model, row.id, row);
			}
			// Missing/null values do not increase the denominator.
			await postgres.create(model, 100, { id: 100 });
			await memory.create(model, 100, { id: 100 });
			const expected = await memory.aggregate!(model, plan);
			for (const metadata of [model, { ...model, fieldTypes: new Map() }]) {
				assert.deepEqual(await postgres.aggregate!(metadata, plan), expected, JSON.stringify(values));
			}
		}
		await postgres.create(model, 101, { id: 101, value: 'invalid' });
		await assert.rejects(postgres.aggregate!(model, plan), ActiveTsValidationError);
	} finally {
		await pool.query(`drop schema if exists ${schema} cascade`);
		await pool.end();
	}
});
