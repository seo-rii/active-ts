import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';
import { createActiveTs, Model, defineModel } from '../src/index.js';

class ReadonlyRecord extends Model<{ id: number; value: string }> {}
defineModel('readonly_snapshot_record').id('id').attach(ReadonlyRecord);

test('SQLite read-only transactions keep snapshots without reserving the writer lock', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-readonly-'));
	const filename = path.join(directory, 'data.sqlite');
	const reader = new DatabaseSync(filename);
	const writer = new DatabaseSync(filename);
	const store = await createSqliteStoreAdapter({ database: reader });
	try {
		reader.exec('PRAGMA journal_mode = WAL');
		writer.exec('PRAGMA busy_timeout = 0');
		const meta = createActiveTs({ stores: { default: store } }).meta(ReadonlyRecord);
		await store.schema!.apply([meta], { mode: 'safe' });
		await store.create(meta, 1, { id: 1, value: 'before' });
		await store.transaction!(async (tx) => {
			assert.equal((await tx.get(meta, 1))?.value, 'before');
			writer.exec('BEGIN IMMEDIATE');
			writer.prepare('UPDATE readonly_snapshot_record SET data = ? WHERE id = ?')
				.run(JSON.stringify({ id: 1, value: 'after' }), 'number:1');
			writer.exec('COMMIT');
			assert.equal((await tx.get(meta, 1))?.value, 'before');
			await assert.rejects(() => tx.update(meta, 1, { id: 1, value: 'blocked' }), /read-only/);
		}, { readOnly: true, isolation: 'serializable' });
		assert.equal((await store.get(meta, 1))?.value, 'after');
	} finally {
		await store.close(); reader.close(); writer.close();
		await rm(directory, { recursive: true, force: true });
	}
});
