import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ResolvedModelMeta } from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';

const meta: ResolvedModelMeta = {
	model: class {}, name: 'keyword_record', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map()
};
const fields = ['where', 'collate', 'desc', 'text_ops', 'nulls first', "label' WHERE value"];

test('PostgreSQL schema matches quoted keyword fields while rejecting actual index options', async () => {
	for (const field of fields) {
		const declared = { ...meta, indexes: [{ name: 'keyword_idx', fields: [field], unique: true }] };
		const expression = `(data #> ARRAY['${field.replaceAll("'", "''")}'::text])`;
		const definition = `CREATE UNIQUE INDEX keyword_record_keyword_idx ON public.keyword_record USING btree (${expression})`;
		let suffix = '';
		const adapter = await createPostgresStoreAdapter({ pool: {
			async query(sql: string) {
				if (sql.includes('information_schema.tables')) return { rows: [{}] };
				if (sql.includes('information_schema.columns')) return { rows: [
					{ column_name: 'id', udt_name: 'text', is_nullable: 'NO' },
					{ column_name: 'data', udt_name: 'jsonb', is_nullable: 'NO' },
					{ column_name: 'created_at', udt_name: 'timestamptz', is_nullable: 'NO' },
					{ column_name: 'updated_at', udt_name: 'timestamptz', is_nullable: 'NO' }
				] };
				if (sql.includes('from pg_index i')) return { rows: [{ column_name: 'id' }] };
				if (sql.includes('pg_indexes')) return { rows: [{
					indisvalid: true, indisready: true, indexname: 'keyword_record_keyword_idx', indexdef: definition + suffix
				}] };
				throw new Error(`Unexpected SQL: ${sql}`);
			}
		} });
		assert.deepEqual((await adapter.schema!.plan([declared])).changes, [], field);
		suffix = ' WHERE (id IS NOT NULL)';
		await assert.rejects(adapter.schema!.plan([declared]), /does not match declared fields or uniqueness/);
	}
});

test('PostgreSQL keyword indexes remain idempotent and enforce uniqueness on a live backend', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async () => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `active_ts_keywords_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		const adapter = await createPostgresStoreAdapter({ pool, schema });
		for (const [position, field] of fields.entries()) {
			const declared = { ...meta, name: `keyword_${position}`, indexes: [{ name: 'keyword_idx', fields: [field], unique: true }] };
			await adapter.schema!.apply([declared], { mode: 'safe' });
			assert.deepEqual((await adapter.schema!.plan([declared])).changes, [], field);
			await adapter.create(declared, 1, { id: 1, [field]: 'duplicate' });
			await assert.rejects(adapter.create(declared, 2, { id: 2, [field]: 'duplicate' }), /already exists/);
			assert.deepEqual((await adapter.schema!.apply([declared], { mode: 'safe' })).changes, [], field);
		}
	} finally {
		await pool.query(`drop schema if exists ${schema} cascade`);
		await pool.end();
	}
});
