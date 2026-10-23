import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ResolvedModelMeta } from '../src/index.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';

const meta: ResolvedModelMeta = {
	model: class {}, name: 'timestamp_record', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map()
};

test('PostgreSQL creates populate both timestamps independently of column defaults', async () => {
	let sql = '';
	const adapter = await createPostgresStoreAdapter({ pool: { async query(text: string, values: unknown[]) {
		sql = text;
		assert.deepEqual(values, ['number:1', { id: 1 }]);
		return { rows: [], rowCount: 1 };
	} } });
	await adapter.create(meta, 1, { id: 1 });
	assert.match(sql, /\(id, data, created_at, updated_at\) values \(\$1, \$2, now\(\), now\(\)\)/);
});

test('PostgreSQL accepts and writes tables without timestamp defaults on a live backend', {
	skip: !process.env.ACTIVE_TS_TEST_POSTGRES_URL
}, async () => {
	const packageName = 'pg';
	const { Pool } = await import(packageName);
	const pool = new Pool({ connectionString: process.env.ACTIVE_TS_TEST_POSTGRES_URL });
	const schema = `active_ts_timestamp_${randomUUID().replaceAll('-', '')}`;
	try {
		await pool.query(`create schema ${schema}`);
		await pool.query(`create table ${schema}.${meta.name} (id text primary key, data jsonb not null, created_at timestamptz not null, updated_at timestamptz not null)`);
		const adapter = await createPostgresStoreAdapter({ pool, schema });
		assert.deepEqual((await adapter.schema!.plan([meta])).changes, []);
		await adapter.schema!.apply([meta], { mode: 'safe' });
		await adapter.create(meta, 1, { id: 1, value: 'original' });
		const before = (await pool.query(`select created_at, updated_at from ${schema}.${meta.name}`)).rows[0];
		assert.ok(before.created_at instanceof Date);
		assert.deepEqual(before.created_at, before.updated_at);
		await adapter.update(meta, 1, { id: 1, value: 'changed' });
		const after = (await pool.query(`select created_at, updated_at from ${schema}.${meta.name}`)).rows[0];
		assert.deepEqual(after.created_at, before.created_at);
		assert.ok(after.updated_at >= before.updated_at);
		assert.equal((await adapter.get(meta, 1))!.value, 'changed');
	} finally {
		await pool.query(`drop schema if exists ${schema} cascade`);
		await pool.end();
	}
});
