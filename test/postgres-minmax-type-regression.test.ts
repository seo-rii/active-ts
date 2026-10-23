import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActiveTsValidationError, type ResolvedModelMeta, type FieldType } from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';

const meta: ResolvedModelMeta = {
	model: class {}, name: 'minmax_type_record', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['value', 'number']])
};

test('PostgreSQL min/max reports invalid aggregate input as a validation error', async () => {
	const adapter = await createPostgresStoreAdapter({ pool: {
		async query() { throw Object.assign(new Error('invalid input syntax'), { code: '22P02' }); }
	} });
	for (const op of ['min', 'max'] as const) {
		await assert.rejects(adapter.aggregate!(meta, { where: [], or: [], aggregates: [{ op, field: 'value', as: 'result' }] }), ActiveTsValidationError);
	}
});

test('PostgreSQL min/max rejects mixed JSON types and preserves null/empty aggregates on a live backend', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async () => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `active_ts_minmax_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		const adapter = await createPostgresStoreAdapter({ pool, schema });
		for (const [type, valid, invalid] of [
			['number', 2, '9'], ['number', 2, true], ['number', 2, [9]],
			['string', 'alpha', 9], ['string', 'alpha', { label: 'zeta' }],
			['date', '2026-01-01T00:00:00.000Z', 20260101]
		] as Array<[FieldType, unknown, unknown]>) {
			const declared = { ...meta, fieldTypes: new Map([['value', type]]) };
			await adapter.schema!.apply([declared], { mode: 'safe' });
			await pool.query(`truncate ${schema}.${meta.name}`);
			for (const op of ['min', 'max'] as const) {
				assert.deepEqual(await adapter.aggregate!(declared, { where: [], or: [], aggregates: [{ op, field: 'value', as: 'result' }] }), { result: null });
			}
			await adapter.create(declared, 1, { id: 1, value: valid });
			await adapter.create(declared, 2, { id: 2, value: null });
			await adapter.create(declared, 3, { id: 3 });
			for (const op of ['min', 'max'] as const) {
				const expected = type === 'date' ? new Date(valid as string) : valid;
				assert.deepEqual(await adapter.aggregate!(declared, { where: [], or: [], aggregates: [{ op, field: 'value', as: 'result' }] }), { result: expected });
			}
			await adapter.create(declared, 4, { id: 4, value: invalid });
			for (const op of ['min', 'max'] as const) {
				await assert.rejects(adapter.aggregate!(declared, { where: [], or: [], aggregates: [{ op, field: 'value', as: 'result' }] }), ActiveTsValidationError);
			}
		}
	} finally {
		await pool.query(`drop schema if exists ${schema} cascade`);
		await pool.end();
	}
});
