import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ResolvedModelMeta } from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';

const meta: ResolvedModelMeta = {
	model: class {}, name: 'index_health_record', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [{ name: 'value_idx', fields: ['value'], unique: true }], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map()
};
const name = 'index_health_record_value_idx';

for (const health of [{ indisvalid: false, indisready: true }, { indisvalid: true, indisready: false }, {}, { indisvalid: 'true', indisready: true }]) {
	test(`PostgreSQL schema rejects unhealthy declared index ${JSON.stringify(health)} before DDL`, async () => {
		const adapter = await createPostgresStoreAdapter({ pool: { async query(sql: string) {
			if (sql.includes('information_schema.tables')) return { rows: [{}] };
			if (sql.includes('information_schema.columns')) return { rows: ['id', 'data', 'created_at', 'updated_at'].map((column_name, index) => ({ column_name, udt_name: ['text', 'jsonb', 'timestamptz', 'timestamptz'][index], is_nullable: 'NO' })) };
			if (sql.includes('from pg_index i')) return { rows: [{ column_name: 'id' }] };
			if (sql.includes('pg_indexes')) {
				assert.match(sql, /i.indisvalid, i.indisready/);
				return { rows: [{ ...health, indexname: name, indexdef: `CREATE UNIQUE INDEX ${name} ON public.${meta.name} USING btree (((data #> ARRAY['value'::text])))` }] };
			}
			throw new Error(`Unexpected SQL: ${sql}`);
		} } });
		await assert.rejects(adapter.schema!.plan([meta]), /not valid and ready/);
		await assert.rejects(adapter.schema!.apply([meta], { mode: 'safe' }), /Repair or rebuild/);
	});
}

test('PostgreSQL detects a real failed concurrent unique index and accepts its repaired replacement', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async () => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `active_ts_health_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		const adapter = await createPostgresStoreAdapter({ pool, schema });
		await adapter.schema!.apply([{ ...meta, indexes: [] }], { mode: 'safe' });
		await adapter.create(meta, 1, { id: 1, value: 'duplicate' });
		await adapter.create(meta, 2, { id: 2, value: 'duplicate' });
		await assert.rejects(pool.query(`create unique index concurrently ${name} on ${schema}.${meta.name} (((data #> ARRAY['value'])))`), /duplicate/);
		await assert.rejects(adapter.schema!.plan([meta]), /not valid and ready/);
		await assert.rejects(adapter.schema!.apply([meta], { mode: 'safe' }), /not valid and ready/);
		await pool.query(`drop index ${schema}.${name}`);
		await adapter.delete(meta, 2);
		await adapter.schema!.apply([meta], { mode: 'safe' });
		assert.deepEqual((await adapter.schema!.plan([meta])).changes, []);
	} finally {
		await pool.query(`drop schema if exists ${schema} cascade`);
		await pool.end();
	}
});
