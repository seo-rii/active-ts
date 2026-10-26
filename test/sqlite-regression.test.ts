import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { link, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsValidationError,
	Model,
	createActiveTs,
	defineModel,
	type QueryPlan,
	type ResolvedModelMeta,
	type StoreAdapter
} from '../src/index.js';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';
import { aggregateRows } from '../src/core/aggregate.js';
import { runStoreAdapterContract } from '../src/testing/index.js';

const emptyPlan: QueryPlan = { where: [], or: [], sort: [], include: [] };

function metadata(name: string, overrides: Partial<ResolvedModelMeta> = {}): ResolvedModelMeta {
	return {
		model: class {}, name, store: 'default', idField: 'id', readValidation: 'off',
		indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
		policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
		fieldTypes: new Map([['score', 'number']]), ...overrides
	};
}

async function fixture(t: TestContext, model = metadata('active_sqlite_record')) {
	const store = await createSqliteStoreAdapter();
	t.after(() => store.close());
	await store.schema!.apply([model], { mode: 'safe' });
	return { store, model };
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

test('SQLite real engine satisfies every advertised shared store contract', async (t) => {
	const store = await createSqliteStoreAdapter();
	t.after(() => store.close());
	assert.equal(store.kind, 'sqlite');
	assert.equal(store.capabilities?.transaction, true);
	assert.equal(store.capabilities?.savepoint, false);
	assert.equal(store.capabilities?.transactionConflictDetection, false);
	assert.equal(store.capabilities?.uniqueIndex, true);
	assert.equal(store.capabilities?.optimisticLock, true);
	await runStoreAdapterContract(store);
});

test('SQLite persists records across file close/reopen and closes owned handles', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-sqlite-'));
	const filename = path.join(directory, 'records.sqlite');
	const model = metadata('persistent_record');
	const opened: Awaited<ReturnType<typeof createSqliteStoreAdapter>>[] = [];
	try {
		const first = await createSqliteStoreAdapter({ filename }); opened.push(first);
		await first.schema!.apply([model], { mode: 'safe' });
		await first.create(model, 'saved', { id: 'saved', score: 7 });
		await first.close();
		await assert.rejects(() => first.get(model, 'saved'), /closed/i);
		const second = await createSqliteStoreAdapter({ filename }); opened.push(second);
		assert.deepEqual(await second.get(model, 'saved'), { id: 'saved', score: 7 });
		assert.deepEqual((await second.schema!.plan([model])).changes, []);
	} finally {
		for (const store of opened) await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('SQLite injected connections remain caller-owned after adapter close', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		const store = await createSqliteStoreAdapter({ database });
		await store.close();
		assert.equal(database.prepare('select 7 as value').get()!.value, 7);
		await assert.rejects(() => store.get(metadata('closed_record'), 1), /closed/i);
	} finally { database.close(); }
});

test('SQLite CRUD preserves typed IDs, duplicate batch order and missing rows', async (t) => {
	const { store, model } = await fixture(t);
	await store.create(model, 1, { id: 1, score: 2, nested: { label: 'number' } });
	await store.create(model, '1', { id: '1', score: 10, nested: { label: 'string' } });
	assert.deepEqual((await store.getMany(model, ['1', 999, 1, '1'])).map((row) => row?.nested.label ?? null), ['string', null, 'number', 'string']);
	await assert.rejects(() => store.create(model, 1, { id: 1, score: 5 }), ActiveTsConflictError);
	await store.update(model, 1, { id: 1, score: 3 });
	assert.deepEqual(await store.get(model, 1), { id: 1, score: 3 });
	assert.deepEqual(await store.get(model, '1'), { id: '1', score: 10, nested: { label: 'string' } });
	await assert.rejects(() => store.update(model, 999, { id: 999, score: 3 }), ActiveTsNotFoundError);
	await store.delete(model, 1);
	assert.equal(await store.get(model, 1), null);
	await store.delete(model, 1);
});

test('SQLite portable queries compare typed numbers, OR branches and literal string prefixes', async (t) => {
	const { store, model } = await fixture(t);
	for (const row of [
		{ id: 1, score: 2, label: 'A_%\\one', nested: { active: true } },
		{ id: 2, score: 10, label: 'Aplain', nested: { active: false } },
		{ id: 3, score: 20, label: 'a_%\\two', nested: { active: true } }
	]) await store.create(model, row.id, row);
	const query = async (where: QueryPlan['where'], extra: Partial<QueryPlan> = {}) =>
		(await store.query(model, { ...emptyPlan, where, sort: [{ field: 'id', direction: 'asc' }], ...extra })).list.map((row) => row.id);
	assert.deepEqual(await query([{ field: 'score', op: 'between', value: 2, value2: 10 }]), [1, 2]);
	assert.deepEqual(await query([{ field: 'score', op: '>', value: 2 }]), [2, 3]);
	assert.deepEqual(await query([{ field: 'id', op: 'in', value: [1, 3] }]), [1, 3]);
	assert.deepEqual(await query([{ field: 'nested.active', op: '=', value: true }]), [1, 3]);
	assert.deepEqual(await query([{ field: 'label', op: 'startsWith', value: 'A_%\\' }]), [1]);
	assert.deepEqual(await query([], { or: [
		{ ...emptyPlan, where: [{ field: 'score', op: '=', value: 2 }] },
		{ ...emptyPlan, where: [{ field: 'score', op: '=', value: 20 }] }
	] }), [1, 3]);
});

test('SQLite null operators include missing fields without coercing booleans or strings', async (t) => {
	const { store, model } = await fixture(t);
	for (const row of [{ id: 1 }, { id: 2, value: null }, { id: 3, value: false }, { id: 4, value: 0 }, { id: 5, value: '' }]) {
		await store.create(model, row.id, row);
	}
	const ids = async (where: QueryPlan['where']) => (await store.query(model, { ...emptyPlan, where, sort: [{ field: 'id', direction: 'asc' }] })).list.map((row) => row.id);
	assert.deepEqual(await ids([{ field: 'value', op: 'isNull', value: undefined }]), [1, 2]);
	assert.deepEqual(await ids([{ field: 'value', op: 'isNotNull', value: undefined }]), [3, 4, 5]);
	assert.deepEqual(await ids([{ field: 'value', op: '=', value: false }]), [3]);
	assert.deepEqual(await ids([{ field: 'value', op: '=', value: 0 }]), [4]);
	assert.deepEqual(await ids([{ field: 'value', op: '!=', value: 0 }]), [2, 3, 5]);
});

test('SQLite ordering, offset and projection preserve domain values and page metadata', async (t) => {
	const { store, model } = await fixture(t);
	for (const row of [{ id: 1, score: 10 }, { id: 2, score: 2 }, { id: 3, score: 20 }]) {
		await store.create(model, row.id, { ...row, secret: 'unselected', nested: { label: String(row.id), secret: true } });
	}
	const result = await store.query(model, {
		...emptyPlan, sort: [{ field: 'score', direction: 'asc' }], offset: 1, limit: 1, select: ['nested.label']
	});
	assert.deepEqual(result.list, [{ id: 1, nested: { label: '1' } }]);
	assert.equal(result.count, 1);
	assert.equal(result.more, true);
});

test('SQLite supports Model codec filtering, nested projection and date hydration', async (t) => {
	class Encoded extends Model<{ id: number; token: string; createdAt: Date; profile: { score: number; private: string } }> {}
	defineModel<Encoded['data']>('active_sqlite_encoded').id('id').validate((data) => data as Encoded['data'])
		.fieldCodec('token', { name: 'prefix', encode: (value) => `encoded:${value}`, decode: (value) => String(value).slice(8), encodeQuery: (value) => `encoded:${value}` })
		.fieldCodec('profile', { name: 'json', encode: (value) => JSON.stringify(value), decode: (value) => JSON.parse(value) })
		.fieldType('createdAt', 'date').attach(Encoded);
	const store = await createSqliteStoreAdapter(); t.after(() => store.close());
	const context = createActiveTs({ stores: { default: store }, aggregate: { allowQueryFallback: true } });
	await store.schema!.apply([context.meta(Encoded)], { mode: 'safe' });
	const Records = Encoded.use(context);
	const date = new Date('2026-01-02T03:04:05.000Z');
	await Records.create({ id: 1, token: 'secret', createdAt: date, profile: { score: 3, private: 'hidden' } });
	assert.equal((await Records.query().where({ token: 'secret' }).first())?.data.createdAt.getTime(), date.getTime());
	assert.equal((await store.get(context.meta(Encoded), 1)).token, 'encoded:secret');
	assert.deepEqual((await Records.query().select('profile.score').first())?.data, { id: 1, profile: { score: 3 } });
	assert.equal(await Records.sum('profile.score'), 3);
});

test('SQLite average CTEs do not shadow model tables with the same names', async (t) => {
	for (const name of ['active_ts_rows', 'active_ts_scale', 'active_ts_scales']) {
		const { store, model } = await fixture(t, metadata(name));
		await store.create(model, 1, { id: 1, score: 10 });
		await store.create(model, 2, { id: 2, score: 20 });
		assert.deepEqual(await store.aggregate!(model, {
			where: [], or: [], aggregates: [{ op: 'avg', field: 'score', as: 'mean' }]
		}), { mean: 15 });
	}
});

test('SQLite aggregates count missing input rows without including them in numeric inputs', async (t) => {
	const { store, model } = await fixture(t);
	await store.create(model, 1, { id: 1, score: 3 });
	await store.create(model, 2, { id: 2 });
	await store.create(model, 3, { id: 3, score: 5 });
	const aggregates = [
		{ op: 'count', as: 'count' }, { op: 'sum', field: 'score', as: 'sum' },
		{ op: 'avg', field: 'score', as: 'avg' }, { op: 'min', field: 'score', as: 'min' },
		{ op: 'max', field: 'score', as: 'max' }
	] as const;
	assert.deepEqual(await store.aggregate!(model, { where: [], or: [], aggregates: [...aggregates] }), { count: 3, sum: 8, avg: 4, min: 3, max: 5 });
});

test('SQLite unique indexes enforce constraints across create and update', async (t) => {
	const model = metadata('active_sqlite_unique', { indexes: [{ name: 'email', fields: ['email'], unique: true }] });
	const { store } = await fixture(t, model);
	assert.deepEqual((await store.schema!.plan([model])).changes, []);
	await store.create(model, 1, { id: 1, email: 'a@example.test' });
	await store.create(model, 2, { id: 2, email: 'b@example.test' });
	await assert.rejects(() => store.create(model, 3, { id: 3, email: 'a@example.test' }), ActiveTsConflictError);
	await assert.rejects(() => store.update(model, 2, { id: 2, email: 'a@example.test' }), ActiveTsConflictError);
	assert.equal((await store.get(model, 2)).email, 'b@example.test');
	await store.create(model, 4, { id: 4 });
	await store.create(model, 5, { id: 5, email: null });
});

test('SQLite optimistic locking detects stale update/delete without altering committed rows', async (t) => {
	const { store, model } = await fixture(t);
	await store.create(model, 1, { id: 1, version: 1, score: 2 });
	await store.update(model, 1, { id: 1, version: 2, score: 3 }, { expectedVersion: 1 });
	await assert.rejects(() => store.update(model, 1, { id: 1, version: 3, score: 99 }, { expectedVersion: 1 }), ActiveTsConflictError);
	await assert.rejects(() => store.delete(model, 1, { expectedVersion: 1 }), ActiveTsConflictError);
	assert.equal((await store.get(model, 1)).score, 3);
	await store.delete(model, 1, { expectedVersion: 2 });
	await assert.rejects(() => store.delete(model, 1, { expectedVersion: 2 }), ActiveTsNotFoundError);
});

test('SQLite async transactions rollback awaited writes and close escaped handles', async (t) => {
	const { store, model } = await fixture(t);
	let retained!: StoreAdapter;
	const failure = new Error('rollback requested');
	await assert.rejects(() => store.transaction!(async (tx) => {
		retained = tx;
		await tx.create(model, 1, { id: 1, score: 3 });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal((await tx.get(model, 1)).score, 3);
		throw failure;
	}), (error) => error === failure);
	assert.equal(await store.get(model, 1), null);
	await assert.rejects(() => retained.get(model, 1), /closed/i);
	await assert.rejects(() => retained.create(model, 2, { id: 2 }), /closed/i);
});

test('SQLite failed savepoints isolate child writes and keep the parent usable', async (t) => {
	const { store, model } = await fixture(t);
	let child!: StoreAdapter;
	await store.transaction!(async (tx) => {
		await tx.create(model, 1, { id: 1, score: 1 });
		await assert.rejects(() => tx.savepoint!(async (nested) => {
			child = nested;
			await nested.create(model, 2, { id: 2, score: 2 });
			await new Promise<void>((resolve) => setImmediate(resolve));
			throw new Error('child rollback');
		}), /child rollback/);
		assert.equal(await tx.get(model, 2), null);
		await tx.create(model, 3, { id: 3, score: 3 });
	});
	assert.deepEqual((await store.getMany(model, [1, 2, 3])).map((row) => row?.score ?? null), [1, null, 3]);
	await assert.rejects(() => child.get(model, 1), /closed/i);
});

test('SQLite serializes outside root writes after rollback and rejects root calls from the callback', async (t) => {
	const { store, model } = await fixture(t);
	const entered = gate(), resume = gate();
	const transaction = store.transaction!(async (tx) => {
		await tx.create(model, 1, { id: 1 });
		await assert.rejects(() => store.create(model, 2, { id: 2 }), /transaction|root|callback/i);
		entered.release();
		await resume.promise;
		throw new Error('rollback owner');
	});
	const observed = transaction.then(() => undefined, (error: unknown) => error);
	await Promise.race([entered.promise, observed.then((error) => { throw error ?? new Error('transaction settled before concurrency barrier'); })]);
	let outsideFinished = false;
	const outside = store.create(model, 3, { id: 3 }).then(() => { outsideFinished = true; });
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(outsideFinished, false);
	} finally { resume.release(); }
	assert.match(String(await observed), /rollback owner/);
	await outside;
	assert.deepEqual((await store.getMany(model, [1, 2, 3])).map((row) => row?.id ?? null), [null, null, 3]);
});

test('SQLite read-only transactions and unsupported transaction options fail before writes', async (t) => {
	const { store, model } = await fixture(t);
	await store.create(model, 1, { id: 1 });
	await store.transaction!(async (tx) => {
		assert.equal((await tx.get(model, 1)).id, 1);
		await assert.rejects(() => tx.create(model, 2, { id: 2 }), /read.only/i);
	}, { readOnly: true, isolation: 'serializable' });
	for (const options of [{ isolation: 'readCommitted' }, { timeoutMs: 1 }, { native: {} }]) {
		let calls = 0;
		await assert.rejects(() => store.transaction!(async () => { calls++; }, options as any));
		assert.equal(calls, 0);
	}
});

test('SQLite rejects unsupported cursor, native and containment capabilities explicitly', async (t) => {
	const { store, model } = await fixture(t);
	for (const extra of [
		{ cursor: 'opaque' }, { native: { payload: {} } },
		{ where: [{ field: 'tags', op: 'arrayContains', value: 'x' }] },
		{ where: [{ field: 'label', op: 'textContains', value: 'x' }] }
	]) await assert.rejects(() => store.query(model, { ...emptyPlan, ...extra } as QueryPlan), /support|cursor|native/i);
});

test('SQLite schema uniqueness is enforced by the database connection itself', async () => {
	const database = new DatabaseSync(':memory:');
	const store = await createSqliteStoreAdapter({ database });
	const model = metadata('active_sqlite_physical_unique', { indexes: [{ name: 'email', fields: ['email'], unique: true }] });
	try {
		await store.schema!.apply([model], { mode: 'safe' });
		await store.create(model, 1, { id: 1, email: 'same@example.test' });
		assert.throws(() => database.prepare('insert into active_sqlite_physical_unique (id, data) values (?, ?)')
			.run('number:2', JSON.stringify({ id: 2, email: 'same@example.test' })), /UNIQUE constraint failed/i);
		assert.equal(await store.get(model, 2), null);
	} finally { await store.close(); database.close(); }
});

test('SQLite schema health rejects a same-named index with extra uniqueness keys', async () => {
	const database = new DatabaseSync(':memory:');
	const store = await createSqliteStoreAdapter({ database });
	const model = metadata('active_sqlite_index_health', { indexes: [{ name: 'email', fields: ['email'], unique: true }] });
	try {
		await store.schema!.apply([model], { mode: 'safe' });
		const index = database.prepare("select name from sqlite_schema where type = 'index' and tbl_name = ? and sql is not null")
			.get(model.name)!;
		const quoted = `"${String(index.name).replaceAll('"', '""')}"`;
		database.exec(`drop index ${quoted}`);
		database.exec(`create unique index ${quoted} on active_sqlite_index_health (json_extract(data, '$.email'), id)`);
		// This healthy SQLite index enforces (email,id), which does not satisfy
		// the model's email-only constraint. Planning must not accept it unchanged.
		let unchanged = false;
		try { unchanged = (await store.schema!.plan([model])).changes.length === 0; }
		catch (error) { assert.match(String(error), /schema|index|definition|mismatch/i); }
		assert.equal(unchanged, false);
	} finally { await store.close(); database.close(); }
});

test('SQLite schema health does not accept an incompatible existing table', async () => {
	const database = new DatabaseSync(':memory:');
	const store = await createSqliteStoreAdapter({ database });
	try {
		database.exec('create table active_sqlite_bad_table (id integer primary key, data integer)');
		const model = metadata('active_sqlite_bad_table');
		await assert.rejects(() => store.schema!.apply([model], { mode: 'safe' }), /table|schema|column|definition/i);
		assert.equal(database.prepare("select type from pragma_table_info('active_sqlite_bad_table') where name = 'data'").get()!.type, 'INTEGER');
	} finally { await store.close(); database.close(); }
});

test('SQLite adapters sharing an injected connection share transaction ownership guards', async () => {
	const database = new DatabaseSync(':memory:');
	const first = await createSqliteStoreAdapter({ database });
	const second = await createSqliteStoreAdapter({ database });
	const model = metadata('active_sqlite_shared_connection');
	try {
		await first.schema!.apply([model], { mode: 'safe' });
		await first.transaction!(async (tx) => {
			await tx.create(model, 1, { id: 1 });
			await assert.rejects(() => second.get(model, 1), /transaction|root|callback/i);
			await assert.rejects(() => second.create(model, 2, { id: 2 }), /transaction|root|callback/i);
		});
		assert.equal((await second.get(model, 1)).id, 1);
		assert.equal(await second.get(model, 2), null);
	} finally { await first.close(); await second.close(); database.close(); }
});

test('SQLite independent file connections do not expose uncommitted transaction data', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-sqlite-connections-'));
	const filename = path.join(directory, 'records.sqlite');
	const first = await createSqliteStoreAdapter({ filename });
	const second = await createSqliteStoreAdapter({ filename });
	const model = metadata('connection_isolation');
	const entered = gate(), resume = gate();
	let pending: Promise<unknown> | undefined;
	try {
		await first.schema!.apply([model], { mode: 'safe' });
		await first.create(model, 1, { id: 1, score: 1 });
		pending = first.transaction!(async (tx) => {
			await tx.update(model, 1, { id: 1, score: 2 });
			entered.release();
			await resume.promise;
		});
		await Promise.race([entered.promise, pending.then(() => { throw new Error('transaction settled before isolation barrier'); })]);
		assert.equal((await second.get(model, 1)).score, 1);
		resume.release();
		await pending;
		assert.equal((await second.get(model, 1)).score, 2);
	} finally {
		resume.release();
		await pending?.catch(() => {});
		await first.close(); await second.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('SQLite file cache scopes follow physical database identity across reopen and path aliases', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-sqlite-cache-'));
	const filename = path.join(directory, 'records.sqlite');
	const symbolicAlias = path.join(directory, 'symbolic.sqlite');
	const hardAlias = path.join(directory, 'hard.sqlite');
	const opened: Awaited<ReturnType<typeof createSqliteStoreAdapter>>[] = [];
	try {
		const first = await createSqliteStoreAdapter({ filename }); opened.push(first);
		assert.equal(typeof first.cacheScope, 'string');
		assert.ok(first.cacheScope);
		await first.close();
		await symlink(filename, symbolicAlias);
		await link(filename, hardAlias);
		for (const filename of [path.join(directory, 'records.sqlite'), symbolicAlias, hardAlias]) {
			const reopened = await createSqliteStoreAdapter({ filename }); opened.push(reopened);
			assert.equal(reopened.cacheScope, first.cacheScope);
		}
		const separate = await createSqliteStoreAdapter({ filename: path.join(directory, 'separate.sqlite') }); opened.push(separate);
		assert.notEqual(separate.cacheScope, first.cacheScope);
	} finally {
		for (const store of opened) await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('SQLite memory cache scopes isolate databases and share an injected connection identity', async () => {
	const database = new DatabaseSync(':memory:');
	const opened: Awaited<ReturnType<typeof createSqliteStoreAdapter>>[] = [];
	try {
		const first = await createSqliteStoreAdapter(); opened.push(first);
		const second = await createSqliteStoreAdapter(); opened.push(second);
		const injected = await createSqliteStoreAdapter({ database }); opened.push(injected);
		const injectedAgain = await createSqliteStoreAdapter({ database }); opened.push(injectedAgain);
		const explicit = await createSqliteStoreAdapter({ cacheScope: 'application-managed-sqlite-scope' }); opened.push(explicit);
		assert.equal(new Set([first.cacheScope, second.cacheScope, injected.cacheScope]).size, 3);
		assert.equal(injected.cacheScope, injectedAgain.cacheScope);
		assert.equal(explicit.cacheScope, 'application-managed-sqlite-scope');
	} finally {
		for (const store of opened) await store.close();
		database.close();
	}
});

test('SQLite native string and date min/max preserve field types through Model queries', async (t) => {
	class Typed extends Model<{ id: number; label: string; createdAt: Date }> {}
	defineModel<Typed['data']>('active_sqlite_typed_aggregate').id('id').validate((data) => data as Typed['data'])
		.fieldType('label', 'string').fieldType('createdAt', 'date').attach(Typed);
	const store = await createSqliteStoreAdapter(); t.after(() => store.close());
	const context = createActiveTs({ stores: { default: store } });
	await store.schema!.apply([context.meta(Typed)], { mode: 'safe' });
	const Records = Typed.use(context);
	await Records.create({ id: 1, label: '2', createdAt: new Date('2026-10-02T00:00:00.000Z') });
	await Records.create({ id: 2, label: '10', createdAt: new Date('2026-02-01T00:00:00.000Z') });
	await Records.create({ id: 3, label: '9', createdAt: new Date('2026-12-01T00:00:00.000Z') });
	assert.equal(await Records.min('label'), '10');
	assert.equal(await Records.max('label'), '9');
	assert.deepEqual(await Records.min('createdAt'), new Date('2026-02-01T00:00:00.000Z'));
	assert.deepEqual(await Records.max('createdAt'), new Date('2026-12-01T00:00:00.000Z'));
});

test('SQLite sum and average reject booleans and numeric-looking strings instead of coercing them', async (t) => {
	const { store, model } = await fixture(t);
	await store.create(model, 1, { id: 1, score: 3 });
	await store.create(model, 2, { id: 2, score: 5 });
	for (const score of [true, false, '7', 'invalid']) {
		await store.update(model, 2, { id: 2, score });
		for (const op of ['sum', 'avg'] as const) {
			await assert.rejects(() => store.aggregate!(model, {
				where: [], or: [], aggregates: [{ op, field: 'score', as: 'result' }]
			}), ActiveTsValidationError);
		}
	}
	await store.update(model, 2, { id: 2, score: 7 });
	assert.deepEqual(await store.aggregate!(model, {
		where: [], or: [], aggregates: [{ op: 'sum', field: 'score', as: 'sum' }, { op: 'avg', field: 'score', as: 'avg' }]
	}), { sum: 10, avg: 5 });
});

test('SQLite unique indexes distinguish scalar types and explicit null from missing values', async (t) => {
	const model = metadata('active_sqlite_typed_unique', { indexes: [{ name: 'value', fields: ['value'], unique: true }] });
	const { store } = await fixture(t, model);
	for (const row of [{ id: 1, value: false }, { id: 2, value: 0 }, { id: 3, value: '0' }, { id: 4, value: null }, { id: 5 }, { id: 6 }]) {
		await store.create(model, row.id, row);
	}
	for (const value of [false, 0, '0', null]) {
		await assert.rejects(() => store.create(model, 7, { id: 7, value }), ActiveTsConflictError);
	}
	assert.deepEqual((await store.getMany(model, [1, 2, 3, 4])).map((row) => row!.value), [false, 0, '0', null]);
	await assert.rejects(() => store.create(model, 7, { id: 7, value: { key: 'object' } }), ActiveTsValidationError);
});

test('SQLite schema rejects compatible column names when JSON CHECK or STRICT constraints are absent', async () => {
	for (const definition of [
		'create table active_sqlite_table_constraints (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL) STRICT',
		'create table active_sqlite_table_constraints (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)))'
	]) {
		const database = new DatabaseSync(':memory:');
		const store = await createSqliteStoreAdapter({ database });
		try {
			database.exec(definition);
			await assert.rejects(() => store.schema!.apply([metadata('active_sqlite_table_constraints')], { mode: 'safe' }), ActiveTsConfigurationError);
		} finally { await store.close(); database.close(); }
	}
});

test('SQLite adding a unique index rejects existing object values and rolls back every schema change', async () => {
	const database = new DatabaseSync(':memory:');
	const store = await createSqliteStoreAdapter({ database });
	const original = metadata('active_sqlite_existing_objects');
	const additional = metadata('active_sqlite_schema_rollback');
	const indexed = { ...original, indexes: [
		{ name: 'email', fields: ['email'] },
		{ name: 'value', fields: ['value'], unique: true }
	] };
	try {
		await store.schema!.apply([original], { mode: 'safe' });
		await store.create(original, 1, { id: 1, email: 'a@example.test', value: { nested: 'object' } });
		await assert.rejects(() => store.schema!.apply([additional, indexed], { mode: 'safe' }), ActiveTsValidationError);
		assert.equal(database.prepare("select count(*) as count from sqlite_schema where name = ? or (tbl_name = ? and type = 'index' and sql is not null)")
			.get(additional.name, original.name)!.count, 0);
		assert.deepEqual((await store.get(original, 1)).value, { nested: 'object' });
		await store.update(original, 1, { id: 1, email: 'a@example.test', value: 'scalar' });
		await store.schema!.apply([additional, indexed], { mode: 'safe' });
		assert.deepEqual((await store.schema!.plan([additional, indexed])).changes, []);
	} finally { await store.close(); database.close(); }
});

test('SQLite factory rejects closed or prototype-spoofed injected connections without invoking own methods', async () => {
	const closed = new DatabaseSync(':memory:');
	closed.close();
	await assert.rejects(() => createSqliteStoreAdapter({ database: closed }), ActiveTsConfigurationError);
	const spoofed = Object.create(DatabaseSync.prototype) as DatabaseSync;
	let methodReads = 0;
	Object.defineProperty(spoofed, 'prepare', { get() { methodReads++; throw new Error('own method must not run'); } });
	await assert.rejects(() => createSqliteStoreAdapter({ database: spoofed }), ActiveTsConfigurationError);
	assert.equal(methodReads, 0);
});

test('SQLite numeric aggregates preserve finite JavaScript numbers beyond safe integer extraction', async (t) => {
	const { store, model } = await fixture(t);
	const score = 2 ** 53;
	await store.create(model, 1, { id: 1, score });
	await store.create(model, 2, { id: 2, score });
	assert.deepEqual(await store.aggregate!(model, { where: [], or: [], aggregates: [
		{ op: 'sum', field: 'score', as: 'sum' }, { op: 'avg', field: 'score', as: 'avg' },
		{ op: 'min', field: 'score', as: 'min' }, { op: 'max', field: 'score', as: 'max' }
	] }), { sum: score * 2, avg: score, min: score, max: score });
});

test('SQLite average preserves finite extremes, cancellation and subnormal residues', async (t) => {
	const { store, model } = await fixture(t);
	const spec = [{ op: 'avg' as const, field: 'score', as: 'mean' }];
	const cases = [
		[1e308, 1e308], [-1e308, -1e308], [Number.MAX_VALUE, Number.MAX_VALUE],
		[1e308, 1, -1e308], [Number.MIN_VALUE, Number.MIN_VALUE],
		[1e308, Number.MIN_VALUE * 4, -1e308], [], [null, null]
	];
	let id = 0;
	for (const [group, values] of cases.entries()) {
		const rows = values.map((score) => ({ id: id++, group, score }));
		for (const row of rows) await store.create(model, row.id, row);
		assert.deepEqual(await store.aggregate!(model, {
			where: [{ field: 'group', op: '=', value: group }], or: [], aggregates: spec
		}), aggregateRows(rows, spec));
	}
});

test('SQLite validates every matching sort value before applying the page limit', async (t) => {
	const { store, model } = await fixture(t);
	await store.create(model, 1, { id: 1, score: 1 });
	await store.create(model, 2, { id: 2, score: 2 });
	for (const score of [{ nested: 1 }, [1, 2]]) {
		await store.update(model, 2, { id: 2, score });
		for (const direction of ['asc', 'desc'] as const) {
			await assert.rejects(() => store.query(model, {
				...emptyPlan, sort: [{ field: 'score', direction }], limit: 1
			}), /sort values must be scalar/);
		}
		// Invalid rows outside the query's input set do not poison its order.
		assert.deepEqual((await store.query(model, {
			...emptyPlan, where: [{ field: 'id', op: '=', value: 1 }],
			sort: [{ field: 'score', direction: 'asc' }], limit: 1
		})).list, [{ id: 1, score: 1 }]);
	}
});

test('SQLite Unicode comparisons, pages and extrema follow JavaScript UTF-16 order', async (t) => {
	const model = metadata('active_sqlite_unicode_order', { fieldTypes: new Map([['label', 'string']]) });
	const { store } = await fixture(t, model);
	const labels = ['\uE000', '\u{10000}', '\uD7FF', '\uD7FFx', '\u{10FFFF}', '\uFFFF', '', 'a', 'aa', 'a\0z'];
	for (const [id, label] of labels.entries()) await store.create(model, id, { id, label });
	const ordered = [...labels].sort();
	for (const direction of ['asc', 'desc'] as const) {
		const expected = direction === 'asc' ? ordered : [...ordered].reverse();
		assert.deepEqual((await store.query(model, {
			...emptyPlan, sort: [{ field: 'label', direction }], offset: 2, limit: 5
		})).list.map((row) => row.label), expected.slice(2, 7));
	}
	for (const bound of labels) {
		for (const op of ['=', '>', '<'] as const) {
			const matches = labels.filter((value) => op === '=' ? value === bound : op === '>' ? value > bound : value < bound);
			assert.deepEqual((await store.query(model, {
				...emptyPlan, where: [{ field: 'label', op, value: bound }], sort: [{ field: 'label', direction: 'asc' }]
			})).list.map((row) => row.label), matches.sort());
		}
	}
	assert.deepEqual(await store.aggregate!(model, { where: [], or: [], aggregates: [
		{ op: 'min', field: 'label', as: 'min' }, { op: 'max', field: 'label', as: 'max' }
	] }), { min: ordered[0], max: ordered.at(-1) });
});
