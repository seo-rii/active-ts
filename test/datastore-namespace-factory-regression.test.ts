import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	Model,
	createActiveTs,
	defineModel
} from '../src/index.js';
import {
	createDatastoreNamespaceStoreFactory,
	type DatastoreNamespaceStoreFactoryOptions
} from '../src/adapters/store/datastore.js';

type NamespaceFactoryData = {
	id: number;
	value: string;
};

class NamespaceFactoryRecord extends Model<NamespaceFactoryData> {}

defineModel<NamespaceFactoryData>({
	name: 'datastore_namespace_factory_record',
	cache: { ttl: 60 }
})
	.id('id')
	.validate((input) => input as NamespaceFactoryData)
	.attach(NamespaceFactoryRecord);

function namespaceClient(overrides: Record<string, unknown> = {}) {
	const keySymbol = Symbol('datastore-namespace-factory-key');
	const calls = {
		getNamespaces: [] as Array<string | undefined>,
		queryNamespaces: [] as Array<string | undefined>,
		updateNamespaces: [] as Array<string | undefined>,
		deleteNamespaces: [] as Array<string | undefined>,
		transactionNamespaces: [] as Array<string | undefined>
	};
	const read = async (input: any) => {
		const keys = Array.isArray(input) ? input : [input];
		const rows: NamespaceFactoryData[] = [];
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			calls.getNamespaces[calls.getNamespaces.length] = key.namespace;
			const encodedId = key.path[key.path.length - 1];
			const id = typeof encodedId === 'string' && encodedId.startsWith('number:')
				? Number(encodedId.slice('number:'.length))
				: encodedId;
			rows[index] = { id, value: key.namespace ?? 'default' };
		}
		return [Array.isArray(input) ? rows : rows[0]];
	};
	const query = (namespace: string | undefined) => ({
		namespace,
		filter() { return this; },
		order() { return this; },
		limit() { return this; },
		offset() { return this; },
		start() { return this; },
		select() { return this; },
		hasAncestor() { return this; }
	});
	const client: Record<string, any> = {
		KEY: keySymbol,
		key: (input: unknown) => input,
		get: read,
		save: async () => undefined,
		update: async (payload: any) => {
			calls.updateNamespaces[calls.updateNamespaces.length] = payload.key.namespace;
		},
		delete: async (key: any) => {
			calls.deleteNamespaces[calls.deleteNamespaces.length] = key.namespace;
		},
		createQuery: (namespaceOrKind: string, maybeKind?: string) => {
			const namespace = maybeKind === undefined ? undefined : namespaceOrKind;
			calls.queryNamespaces[calls.queryNamespaces.length] = namespace;
			return query(namespace);
		},
		runQuery: async (activeQuery: { namespace?: string }) => [[{
			id: 1,
			value: activeQuery.namespace ?? 'default'
		}], { moreResults: 'NO_MORE_RESULTS' }]
	};
	client.transaction = () => ({
		key: client.key,
		get: async (input: any) => {
			const key = Array.isArray(input) ? input[0] : input;
			calls.transactionNamespaces[calls.transactionNamespaces.length] = key.namespace;
			return await read(input);
		},
		save: client.save,
		update: client.update,
		delete: client.delete,
		createQuery: client.createQuery,
		runQuery: client.runQuery,
		run: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined
	});
	Object.assign(client, overrides);
	return { client, calls };
}

test('Datastore namespace store factories isolate keys, caches, queries, writes, and transactions', async () => {
	const { client, calls } = namespaceClient();
	const factory = await createDatastoreNamespaceStoreFactory({ client });
	const alpha = await factory.forNamespace('alpha');
	const beta = await factory.forNamespace('beta');
	const alphaAgain = await factory.forNamespace('alpha');
	const defaultNamespace = await factory.forNamespace();

	assert.equal(alpha.datastoreNamespace, 'alpha');
	assert.equal(beta.datastoreNamespace, 'beta');
	assert.equal(defaultNamespace.datastoreNamespace, undefined);
	assert.notEqual(alpha.cacheScope, beta.cacheScope);
	assert.notEqual(alpha.cacheScope, defaultNamespace.cacheScope);
	assert.equal(alpha.cacheScope, alphaAgain.cacheScope);

	const sharedCache = new MemoryCacheAdapter();
	const alphaContext = createActiveTs({
		stores: { default: alpha },
		caches: { default: sharedCache }
	});
	const betaContext = createActiveTs({
		stores: { default: beta },
		caches: { default: sharedCache }
	});
	const AlphaRecord = NamespaceFactoryRecord.use(alphaContext) as unknown as typeof NamespaceFactoryRecord;
	const BetaRecord = NamespaceFactoryRecord.use(betaContext) as unknown as typeof NamespaceFactoryRecord;

	assert.equal((await AlphaRecord.find(1).load())?.data.value, 'alpha');
	assert.equal((await AlphaRecord.find(1).load())?.data.value, 'alpha');
	assert.equal((await BetaRecord.find(1).load())?.data.value, 'beta');
	assert.deepEqual(calls.getNamespaces, ['alpha', 'beta']);

	const meta = alphaContext.meta(NamespaceFactoryRecord);
	assert.equal((await beta.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: []
	})).list[0].value, 'beta');
	await alpha.update(meta, 2, { id: 2, value: 'updated' });
	await beta.delete(meta, 2);
	assert.deepEqual(calls.queryNamespaces, ['beta']);
	assert.deepEqual(calls.updateNamespaces, ['alpha']);
	assert.deepEqual(calls.deleteNamespaces, ['beta']);

	await alpha.transaction!(async (transaction) => {
		assert.equal(transaction.datastoreNamespace, 'alpha');
		assert.equal((await transaction.get(meta, 1))?.value, 'alpha');
	});
	assert.deepEqual(calls.transactionNamespaces, ['alpha']);
});

test('Datastore namespace store factories derive explicit collision-safe cache scopes', async () => {
	const { client } = namespaceClient();
	const factory = await createDatastoreNamespaceStoreFactory({
		client,
		cacheScopePrefix: 'project=admin'
	});
	const alpha = await factory.forNamespace('alpha');
	const beta = await factory.forNamespace('beta');
	const root = await factory.forNamespace();

	assert.equal(alpha.cacheScope, 'datastore|scope=13:project=admin|keyEncoding=9:active-ts|namespace=5:alpha');
	assert.equal(beta.cacheScope, 'datastore|scope=13:project=admin|keyEncoding=9:active-ts|namespace=4:beta');
	assert.equal(root.cacheScope, 'datastore|scope=13:project=admin|keyEncoding=9:active-ts|namespace=-');
	assert.equal(Object.isFrozen(factory), true);

	const suffix = '|keyEncoding=9:active-ts|namespace=';
	const deceptiveNamespace = `tail${suffix}4:beta`;
	const deceptivePrefix = `x${suffix}${deceptiveNamespace.length}:tail`;
	const leftFactory = await createDatastoreNamespaceStoreFactory({ client, cacheScopePrefix: 'x' });
	const rightFactory = await createDatastoreNamespaceStoreFactory({ client, cacheScopePrefix: deceptivePrefix });
	assert.notEqual(
		(await leftFactory.forNamespace(deceptiveNamespace)).cacheScope,
		(await rightFactory.forNamespace('beta')).cacheScope
	);
});

test('Datastore namespace store factories reject ambiguous or unsafe namespace configuration', async () => {
	const { client } = namespaceClient();
	await assert.rejects(
		() => createDatastoreNamespaceStoreFactory({ client, datastoreOptions: {} }),
		/cannot combine client with datastoreOptions/
	);
	await assert.rejects(
		() => createDatastoreNamespaceStoreFactory({ client, namespace: 'fixed' } as any),
		/unknown option "namespace"/
	);
	await assert.rejects(
		() => createDatastoreNamespaceStoreFactory({ client, cacheScope: 'shared' } as any),
		/unknown option "cacheScope"/
	);
	await assert.rejects(
		() => createDatastoreNamespaceStoreFactory({
			datastoreOptions: { projectId: 'test', namespace: 'fixed' }
		}),
		/datastoreOptions cannot set namespace/
	);
	const fixed = namespaceClient({ namespace: 'fixed' });
	await assert.rejects(
		() => createDatastoreNamespaceStoreFactory({ client: fixed.client }),
		/requires a namespace-neutral client/
	);

	let accessorCalls = 0;
	const accessorOptions = Object.defineProperty({ client }, 'cacheScopePrefix', {
		enumerable: true,
		get() {
			accessorCalls++;
			return 'unsafe';
		}
	});
	await assert.rejects(
		() => createDatastoreNamespaceStoreFactory(accessorOptions as DatastoreNamespaceStoreFactoryOptions),
		/"cacheScopePrefix" must be a data property/
	);
	assert.equal(accessorCalls, 0);

	const factory = await createDatastoreNamespaceStoreFactory({ client });
	await assert.rejects(() => factory.forNamespace(''), /namespace must be a non-empty string/);
	await assert.rejects(() => factory.forNamespace('bad\0namespace'), /namespace must be a non-empty string/);
});
