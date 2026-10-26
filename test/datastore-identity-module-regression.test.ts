import test from 'node:test';
import assert from 'node:assert/strict';
import { datastorePhysicalCacheScope, resolveDatastorePhysicalIdentity } from '../src/adapters/store/datastore-identity.js';

test('Datastore identity resolution keeps injected credentials lazy and snapshots physical metadata', async () => {
	let lookups = 0;
	const client = {
		options: { servicePath: 'localhost', port: 8088 },
		getProjectId: async () => { lookups++; return 'resolved-project'; },
		getDatabaseId: () => undefined
	};
	const injected = await resolveDatastorePhysicalIdentity(client, true);
	assert.equal(injected.projectId, undefined);
	assert.equal(injected.databaseId, null);
	assert.equal(lookups, 0);
	const owned = await resolveDatastorePhysicalIdentity(client, false);
	assert.equal(owned.projectId, 'resolved-project');
	assert.equal(lookups, 1);
	client.options.port = 9999;
	assert.match(owned.endpoint!, /8088/);
	assert.doesNotMatch(owned.endpoint!, /9999/);
});

test('Datastore identity encoding distinguishes missing, default and delimiter-bearing coordinates', () => {
	const client = {};
	const identity = { projectId: 'p', databaseId: null, endpoint: 'host|namespace=1:x' };
	const scope = datastorePhysicalCacheScope(client, identity, 'tenant', 'active-ts');
	assert.notEqual(scope, datastorePhysicalCacheScope(client, { ...identity, endpoint: 'host' }, 'x|namespace=6:tenant', 'active-ts'));
	assert.notEqual(scope, datastorePhysicalCacheScope(client, { ...identity, databaseId: undefined }, 'tenant', 'active-ts'));
	assert.notEqual(scope, datastorePhysicalCacheScope(client, { ...identity, databaseId: 'default' }, 'tenant', 'active-ts'));
	assert.notEqual(scope, datastorePhysicalCacheScope(client, identity, 'tenant', 'native'));
});

test('Datastore identity discovery never executes metadata accessors or inherited Object fields', async () => {
	let reads = 0;
	const bad = Object.create({ get getDatabaseId() { reads++; return () => undefined; } });
	await assert.rejects(resolveDatastorePhysicalIdentity(bad, true), /data property/);
	assert.equal(reads, 0);
	Object.defineProperty(Object.prototype, 'options', { configurable: true, value: { projectId: 'polluted', servicePath: 'wrong' } });
	try {
		assert.deepEqual(await resolveDatastorePhysicalIdentity({}, true), { projectId: undefined, databaseId: undefined, endpoint: undefined });
	} finally { delete (Object.prototype as Record<string, unknown>).options; }
});
