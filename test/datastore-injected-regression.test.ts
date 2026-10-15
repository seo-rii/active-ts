import test from 'node:test';
import assert from 'node:assert/strict';
import { Datastore } from '@google-cloud/datastore';
import { createDatastoreStoreAdapter, createDatastoreNamespaceStoreFactory } from '../src/adapters/store/datastore-injected.js';
import { createDatastoreStoreAdapter as createConvenienceAdapter } from '../src/adapters/store/datastore.js';
import { Model, createActiveTs, defineModel, ACTIVE_TS_ENTITY_KEY } from '../src/index.js';

test('static injection preserves the real SDK native numeric and name key identities without network I/O', async () => {
	const client = new Datastore({ projectId: 'active-ts-static-fixture', databaseId: 'fixture' });
	const keys: any[] = [];
	client.get = (async (key: any) => {
		keys.push(key);
		return [{ id: key.id === undefined ? key.name : Number(key.id), value: 'kept', [Datastore.KEY]: key }];
	}) as any;
	class Row extends Model<{ id: number | string; value: string }> {}
	defineModel('injected_sdk_row').id('id').validate(value => value as { id: number | string; value: string }).attach(Row);
	const store = await createDatastoreStoreAdapter({ client, keySymbol: Datastore.KEY, keyEncoding: 'native' });
	const meta = createActiveTs({ stores: { default: store } }).meta(Row);
	const numeric = await store.get(meta, 17);
	const named = await store.get(meta, '17');
	assert.equal(numeric.id, 17);
	assert.equal(named.id, '17');
	assert.equal(keys[0].id, 17);
	assert.equal(keys[0].name, undefined);
	assert.equal(keys[1].name, '17');
	assert.equal(keys[1].id, undefined);
	assert.equal(numeric[ACTIVE_TS_ENTITY_KEY].path[0].id, 17);
	assert.equal(named[ACTIVE_TS_ENTITY_KEY].path[0].id, '17');
});

test('injected entry rejects absent clients without trying runtime SDK resolution', async () => {
	await assert.rejects(createDatastoreStoreAdapter({} as any), /requires client/);
	await assert.rejects(createDatastoreNamespaceStoreFactory({} as any), /requires client/);
});

test('convenience and injected entries produce the same scoped adapter for a supplied SDK client', async () => {
	const client = new Datastore({ projectId: 'active-ts-static-fixture', databaseId: 'fixture' });
	const options = { client, keySymbol: Datastore.KEY, keyEncoding: 'native' as const, namespace: 'tenant' };
	const injected = await createDatastoreStoreAdapter(options);
	const convenience = await createConvenienceAdapter(options);
	assert.equal(injected.cacheScope, convenience.cacheScope);
	assert.equal(injected.datastoreNamespace, 'tenant');
});
