import assert from 'node:assert/strict';
import { createPostgresStoreAdapter } from '../../build/src/adapters/store/postgresql.js';

// The backend runner owns the isolated schema, pool and cleanup.
export async function runPostgresSchemaContract({ pool, schema }) {
	assert.match(schema, /^active_ts_smoke_[a-f0-9]+$/);
	const meta = { model: class {}, name: 'audit_docs', store: 'default', idField: 'id', readValidation: 'off',
		indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(), policies: new Map(),
		scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map() };
	const shape = '(id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())';
	const adapter = await createPostgresStoreAdapter({ pool, schema });
	const left = { ...meta, name: 'audit_user', indexes: [{ name: 'email', fields: ['email'], unique: true }] };
	const right = { ...meta, name: 'audit', indexes: [{ name: 'user_email', fields: ['email'], unique: true }] };
	await adapter.schema.apply([left, right], { mode: 'safe' });
	assert.deepEqual((await adapter.schema.plan([left, right])).changes, []);
	await adapter.schema.apply([left, right], { mode: 'safe' });
	for (const model of [left, right]) {
		await adapter.create(model, 1, { id: 1, email: 'duplicate@example.test' });
		await assert.rejects(() => adapter.create(model, 2, { id: 2, email: 'duplicate@example.test' }));
	}
	console.log('PASS distinct physical names enforce uniqueness on both tables and remain idempotent');

	const legacy = { ...meta, name: 'legacy', indexes: [{ name: 'email', fields: ['email'], unique: true }] };
	await pool.query(`create table ${schema}.legacy ${shape}`);
	await pool.query(`create unique index legacy_email on ${schema}.legacy (((data #> ARRAY['email'])))`);
	assert.deepEqual((await adapter.schema.apply([legacy], { mode: 'safe' })).changes, []);
	const legacyIndexes = await pool.query('select indexname from pg_indexes where schemaname = $1 and tablename = $2', [schema, 'legacy']);
	assert.equal(legacyIndexes.rows.length, 2);
	console.log('PASS matching legacy index is retained without duplicate migration');

	for (const [offset, keys] of [
		"((data #> ARRAY['email'])), id", "id, ((data #> ARRAY['email']))", "((data #> ARRAY['email'])::text)"
	].entries()) {
		const name = `drift_${offset}`;
		await pool.query(`create table ${schema}.${name} ${shape}`);
		await pool.query(`create unique index ${name}_email on ${schema}.${name} (${keys})`);
		await assert.rejects(() => adapter.schema.plan([{ ...legacy, name }]), /does not match/);
	}
	console.log('PASS extra leading/trailing keys and expression casts fail schema validation');
}
