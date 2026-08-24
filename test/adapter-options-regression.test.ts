import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	createAesGcmCacheCodec,
	createCodecCacheAdapter
} from '../src/index.js';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';
import { createAlgoliaSearchAdapter } from '../src/adapters/search/algolia.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';

const datastoreClient = (overrides: Record<string, unknown> = {}) => ({
	KEY: Symbol('datastore-key'),
	key: (input: unknown) => input,
	get: async () => [undefined],
	save: async () => undefined,
	delete: async () => undefined,
	update: async () => undefined,
	createQuery: () => ({}),
	runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
	...overrides
});

const firestoreClient = (overrides: Record<string, unknown> = {}) => ({
	collection: () => ({}),
	getAll: async () => [],
	runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
		callback({
			get: async () => ({ exists: false }),
			set: async () => undefined
		}),
	...overrides
});

test('store adapter factories ignore inherited option fields', async () => {
	Object.defineProperty(Object.prototype, 'schema', {
		value: 'bad\0schema',
		configurable: true
	});
	try {
		await createPostgresStoreAdapter({
			pool: {
				query: async () => ({ rows: [], rowCount: 0 })
			}
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).schema;
	}

	Object.defineProperty(Object.prototype, 'dbName', {
		value: 'inherited_db',
		configurable: true
	});
	try {
		await assert.rejects(
			() =>
				createMongoStoreAdapter({
					client: {
						db: () => ({ collection: () => ({}) })
					}
				} as any),
			/MongoDB adapter dbName/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).dbName;
	}

	Object.defineProperty(Object.prototype, 'namespace', {
		value: 'bad\0namespace',
		configurable: true
	});
	try {
		await createDatastoreStoreAdapter({
			client: datastoreClient()
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).namespace;
	}

	Object.defineProperty(Object.prototype, 'aggregateField', {
		value: { count: 'not-a-function' },
		configurable: true
	});
	try {
		await createFirestoreStoreAdapter({
			client: firestoreClient()
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).aggregateField;
	}
});

test('aggregate scan fallback adapter options require booleans', async () => {
	await assert.rejects(
		() =>
			createFirestoreStoreAdapter({
				client: firestoreClient(),
				allowAggregateScanFallback: 'yes'
			} as any),
		/Firestore adapter allowAggregateScanFallback must be a boolean/
	);
	await assert.rejects(
		() =>
			createMongoStoreAdapter({
				dbName: 'test',
				client: { db: () => ({ collection: () => ({}) }) },
				allowAggregateScanFallback: 'yes'
			} as any),
		/MongoDB adapter allowAggregateScanFallback must be a boolean/
	);
	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: datastoreClient(),
				allowAggregateScanFallback: 'yes'
			} as any),
		/Datastore adapter allowAggregateScanFallback must be a boolean/
	);
	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: datastoreClient(),
				allowQueryScanFallback: 'yes'
			} as any),
		/Datastore adapter allowQueryScanFallback must be a boolean/
	);
	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: datastoreClient(),
				keyEncoding: 'legacy'
			} as any),
		/Datastore adapter keyEncoding must be "active-ts" or "native"/
	);
});

test('Datastore cache scopes include project, database, and namespace identity', async () => {
	const defaultNamespace = await createDatastoreStoreAdapter({
		datastoreOptions: { projectId: 'project-a', databaseId: 'db-a' }
	});
	const tenantA = await createDatastoreStoreAdapter({
		datastoreOptions: { projectId: 'project-a', databaseId: 'db-a' },
		namespace: 'tenant-a'
	});
	const tenantB = await createDatastoreStoreAdapter({
		datastoreOptions: { projectId: 'project-a', databaseId: 'db-a' },
		namespace: 'tenant-b'
	});
	const nativeTenantA = await createDatastoreStoreAdapter({
		datastoreOptions: { projectId: 'project-a', databaseId: 'db-a' },
		namespace: 'tenant-a',
		keyEncoding: 'native'
	});
	const sdkNamespace = await createDatastoreStoreAdapter({
		datastoreOptions: { projectId: 'project-a', databaseId: 'db-a', namespace: 'tenant-sdk' }
	});
	const overridden = await createDatastoreStoreAdapter({
		client: datastoreClient({
			getProjectId: async () => {
				throw new Error('must not resolve');
			}
		}),
		cacheScope: 'injected-client-scope'
	});

	assert.equal(defaultNamespace.datastoreNamespace, undefined);
	assert.equal(defaultNamespace.datastoreProjectId, 'project-a');
	assert.equal(defaultNamespace.datastoreDatabaseId, 'db-a');
	assert.equal(defaultNamespace.datastoreKeyEncoding, 'active-ts');
	assert.equal(
		defaultNamespace.cacheScope,
		'datastore|project=9:project-a|database=4:db-a|namespace=-|client=-'
	);
	assert.equal(
		tenantA.cacheScope,
		'datastore|project=9:project-a|database=4:db-a|namespace=8:tenant-a|client=-'
	);
	assert.equal(
		tenantB.cacheScope,
		'datastore|project=9:project-a|database=4:db-a|namespace=8:tenant-b|client=-'
	);
	assert.equal(
		nativeTenantA.cacheScope,
		'datastore|project=9:project-a|database=4:db-a|namespace=8:tenant-a|client=-|keyEncoding=6:native'
	);
	assert.equal(sdkNamespace.datastoreNamespace, 'tenant-sdk');
	assert.equal(
		sdkNamespace.cacheScope,
		'datastore|project=9:project-a|database=4:db-a|namespace=10:tenant-sdk|client=-'
	);
	assert.notEqual(tenantA.cacheScope, tenantB.cacheScope);
	assert.notEqual(tenantA.cacheScope, nativeTenantA.cacheScope);
	assert.equal(nativeTenantA.datastoreKeyEncoding, 'native');
	assert.equal(overridden.cacheScope, 'injected-client-scope');
	assert.equal(overridden.datastoreProjectId, undefined);
	assert.equal(overridden.datastoreDatabaseId, undefined);
});

test('Datastore adapters snapshot SDK project and database identity', async () => {
	const identifiedProject = await createDatastoreStoreAdapter({
		client: datastoreClient({ options: { projectId: 'client-project' } })
	});
	const defaultDatabase = await createDatastoreStoreAdapter({
		client: datastoreClient({ getDatabaseId: () => undefined })
	});
	const namedDatabase = await createDatastoreStoreAdapter({
		client: datastoreClient({ getDatabaseId: () => 'custom-database' })
	});

	assert.equal(identifiedProject.datastoreProjectId, 'client-project');
	assert.equal(defaultDatabase.datastoreDatabaseId, null);
	assert.equal(namedDatabase.datastoreDatabaseId, 'custom-database');
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: datastoreClient({ getDatabaseId: () => '' }) }),
		/getDatabaseId must return a non-empty string/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({
			client: datastoreClient({ options: { projectId: '' } })
		}),
		/client\.options\.projectId must be a non-empty string/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({
			client: datastoreClient({
				getDatabaseId() {
					throw new Error('database identity unavailable');
				}
			})
		}),
		/getDatabaseId failed: database identity unavailable/
	);
});

test('Datastore adapters reject empty namespace aliases from every configuration source', async () => {
	const rejection = /namespace must be a non-empty string without null bytes/;
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: datastoreClient(), namespace: '' }),
		rejection
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({
			datastoreOptions: { projectId: 'project-a', namespace: '' }
		}),
		rejection
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: datastoreClient({ namespace: '' }) }),
		rejection
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({
			client: datastoreClient({ namespace: '' }),
			namespace: 'tenant-a'
		}),
		rejection
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({
			datastoreOptions: { projectId: 'project-a', namespace: '' },
			namespace: 'tenant-a'
		}),
		rejection
	);
});

test('injected Datastore clients use client identity and ignore detached datastoreOptions', async () => {
	let projectLookups = 0;
	const client = datastoreClient({
		namespace: 'client-tenant',
		getProjectId: async () => {
			projectLookups++;
			throw new Error('project lookup is unavailable');
		}
	});
	const first = await createDatastoreStoreAdapter({
		client,
		datastoreOptions: {
			projectId: 'ignored-project',
			databaseId: 'ignored-db',
			namespace: 'ignored-tenant'
		}
	});
	const sameClient = await createDatastoreStoreAdapter({ client });
	const sameClientNative = await createDatastoreStoreAdapter({ client, keyEncoding: 'native' });
	const otherClient = await createDatastoreStoreAdapter({
		client: datastoreClient({ namespace: 'client-tenant' })
	});

	assert.equal(first.datastoreNamespace, 'client-tenant');
	assert.equal(first.datastoreProjectId, undefined);
	assert.match(
		first.cacheScope!,
		/^datastore\|project=-\|database=-\|namespace=13:client-tenant\|client=36:[0-9a-f-]{36}$/
	);
	assert.equal(first.cacheScope, sameClient.cacheScope);
	assert.equal(sameClientNative.cacheScope, `${first.cacheScope}|keyEncoding=6:native`);
	assert.notEqual(first.cacheScope, otherClient.cacheScope);
	assert.equal(first.cacheScope?.includes('ignored'), false);
	assert.equal(projectLookups, 0);
});

test('Datastore cacheScope rejects unsafe explicit values', async () => {
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: datastoreClient(), cacheScope: '' }),
		/Datastore adapter cacheScope must be a non-empty string without null bytes/
	);
});

test('google adapter sdk option snapshots shadow inherited non-writable option names', async () => {
	Object.defineProperty(Object.prototype, 'projectId', {
		value: 'polluted-project',
		writable: false,
		configurable: true
	});
	try {
		const datastore = await createDatastoreStoreAdapter({
			client: datastoreClient(),
			datastoreOptions: { projectId: 'active-ts-datastore' }
		});
		const firestore = await createFirestoreStoreAdapter({
			client: firestoreClient(),
			firestoreOptions: { projectId: 'active-ts-firestore' }
		});
		assert.equal(datastore.kind, 'datastore');
		assert.equal(firestore.kind, 'firestore');
	} finally {
		delete (Object.prototype as Record<string, unknown>).projectId;
	}
});

test('search and cache adapter factories ignore inherited option fields', async () => {
	const algoliaClient = {
		searchSingleIndex: async () => ({ hits: [], page: 0, nbPages: 0, nbHits: 0 }),
		saveObject: async () => undefined,
		deleteObject: async () => undefined
	};
	Object.defineProperty(Object.prototype, 'indexPrefix', {
		value: 42,
		configurable: true
	});
	try {
		await createAlgoliaSearchAdapter({ client: algoliaClient });
		await createElasticsearchSearchAdapter({
			client: {
				search: async () => ({ hits: { hits: [] } }),
				index: async () => undefined,
				delete: async () => undefined
			}
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).indexPrefix;
	}

	Object.defineProperty(Object.prototype, 'prefix', {
		value: 'bad\0prefix',
		configurable: true
	});
	try {
		await createRedisValkeyCacheAdapter({
			client: {
				mGet: async () => [],
				mSet: async () => undefined,
				multi: () => ({ set: () => undefined, exec: async () => undefined }),
				del: async () => undefined
			}
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).prefix;
	}
});

test('search adapter factories reject invalid index prefixes during creation', async () => {
	const algoliaClient = {
		searchSingleIndex: async () => ({ hits: [], page: 0, nbPages: 0, nbHits: 0 }),
		saveObject: async () => undefined,
		deleteObject: async () => undefined
	};
	const elasticClient = {
		search: async () => ({ hits: { hits: [] } }),
		index: async () => undefined,
		delete: async () => undefined
	};

	await assert.rejects(
		() => createAlgoliaSearchAdapter({ client: algoliaClient, indexPrefix: 'tenant\n' }),
		/Algolia index name/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({ client: elasticClient, indexPrefix: 'Tenant_' }),
		/Elasticsearch index name/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({ client: elasticClient, indexPrefix: '_tenant_' }),
		/Elasticsearch index name/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter({ client: algoliaClient, indexPrefix: 'a'.repeat(256) }),
		/Algolia index name .*too long/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({ client: elasticClient, indexPrefix: 'a'.repeat(256) }),
		/Elasticsearch index name .*too long/
	);
	await createAlgoliaSearchAdapter({ client: algoliaClient, indexPrefix: 'Tenant_' });
	await createElasticsearchSearchAdapter({ client: elasticClient, indexPrefix: 'tenant_' });
});

test('adapter factories reject accessor and symbol option fields', async () => {
	let getterCalls = 0;
	const withAccessor = <T extends Record<string, unknown>>(base: T, key: string) => {
		const options = { ...base };
		Object.defineProperty(options, key, {
			enumerable: true,
			get() {
				getterCalls++;
				return key;
			}
		});
		return options;
	};
	const withHidden = <T extends Record<string, unknown>>(base: T, key: string, value: unknown) => {
		const options = { ...base };
		Object.defineProperty(options, key, {
			enumerable: false,
			value
		});
		return options;
	};
	const postgresPool = { query: async () => ({ rows: [], rowCount: 0 }) };
	const mongoClient = { db: () => ({ collection: () => ({}) }) };
	const datastore = datastoreClient();
	const firestore = firestoreClient();
	const redisClient = {
		mGet: async () => [],
		mSet: async () => undefined,
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async () => undefined
	};
	const algoliaClient = {
		searchSingleIndex: async () => ({ hits: [], page: 0, nbPages: 0, nbHits: 0 }),
		saveObject: async () => undefined,
		deleteObject: async () => undefined
	};
	const elasticClient = {
		search: async () => ({ hits: { hits: [] } }),
		index: async () => undefined,
		delete: async () => undefined
	};

	await assert.rejects(
		() => createPostgresStoreAdapter(withAccessor({ pool: postgresPool }, 'schema') as any),
		/PostgreSQL adapter option "schema" must be a data property/
	);
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: postgresPool, schema: 'a'.repeat(64) }),
		/PostgreSQL adapter schema .*too long/
	);
	await assert.rejects(
		() => createMongoStoreAdapter(withAccessor({ client: mongoClient }, 'dbName') as any),
		/MongoDB adapter option "dbName" must be a data property/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter(withAccessor({ client: datastore }, 'namespace') as any),
		/Datastore adapter option "namespace" must be a data property/
	);
	await assert.rejects(
		() => createFirestoreStoreAdapter(withAccessor({ client: firestore }, 'aggregateField') as any),
		/Firestore adapter option "aggregateField" must be a data property/
	);
	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: datastore,
				datastoreOptions: withAccessor({}, 'projectId')
			} as any),
		/Datastore adapter datastoreOptions\.projectId must be a data property/
	);
	await assert.rejects(
		() =>
			createFirestoreStoreAdapter({
				client: firestore,
				firestoreOptions: withAccessor({}, 'projectId')
			} as any),
		/Firestore adapter firestoreOptions\.projectId must be a data property/
	);
	await assert.rejects(
		() => createPostgresStoreAdapter(withHidden({ pool: postgresPool }, 'schema', 'public') as any),
		/PostgreSQL adapter option "schema" must be enumerable/
	);
	await assert.rejects(
		() => createMongoStoreAdapter(withHidden({ client: mongoClient }, 'dbName', 'test') as any),
		/MongoDB adapter option "dbName" must be enumerable/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter(withHidden({ client: datastore }, 'namespace', 'tenant') as any),
		/Datastore adapter option "namespace" must be enumerable/
	);
	await assert.rejects(
		() => createFirestoreStoreAdapter(withHidden({ client: firestore }, 'aggregateField', {}) as any),
		/Firestore adapter option "aggregateField" must be enumerable/
	);
	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: datastore,
				datastoreOptions: withHidden({}, 'projectId', 'project')
			} as any),
		/Datastore adapter datastoreOptions\.projectId must be enumerable/
	);
	await assert.rejects(
		() =>
			createFirestoreStoreAdapter({
				client: firestore,
				firestoreOptions: withHidden({}, 'projectId', 'project')
			} as any),
		/Firestore adapter firestoreOptions\.projectId must be enumerable/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: datastore, datastoreOptions: [] } as any),
		/Datastore adapter datastoreOptions must be a plain object/
	);
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client: firestore, firestoreOptions: [] } as any),
		/Firestore adapter firestoreOptions must be a plain object/
	);
	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: datastore,
				datastoreOptions: { [Symbol('project')]: 'project' }
			} as any),
		/Datastore adapter datastoreOptions cannot contain symbol fields/
	);
	await assert.rejects(
		() =>
			createFirestoreStoreAdapter({
				client: firestore,
				firestoreOptions: { [Symbol('project')]: 'project' }
			} as any),
		/Firestore adapter firestoreOptions cannot contain symbol fields/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter(withAccessor({ client: algoliaClient }, 'indexPrefix') as any),
		/Algolia adapter option "indexPrefix" must be a data property/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter(withAccessor({ client: elasticClient }, 'indexPrefix') as any),
		/Elasticsearch adapter option "indexPrefix" must be a data property/
	);
	await assert.rejects(
		() => createRedisValkeyCacheAdapter(withAccessor({ client: redisClient }, 'prefix') as any),
		/redis-valkey cache option "prefix" must be a data property/
	);
	assert.equal(getterCalls, 0);

	const withAccessorMember = <T extends Record<string, unknown>>(base: T, key: string, value: unknown = async () => undefined) => {
		const target = { ...base };
		Object.defineProperty(target, key, {
			enumerable: true,
			get() {
				getterCalls++;
				return value;
			}
		});
		return target;
	};
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: withAccessorMember({}, 'query') } as any),
		/PostgreSQL adapter pool\.query must be a data property/
	);
	await assert.rejects(
		() => createMongoStoreAdapter({ client: withAccessorMember({}, 'db'), dbName: 'test' } as any),
		/MongoDB adapter client\.db must be a data property/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: withAccessorMember({}, 'key') } as any),
		/Datastore adapter client\.key must be a data property/
	);
	await assert.rejects(
		() =>
			createAlgoliaSearchAdapter({
				client: withAccessorMember(
					{ saveObject: async () => undefined, deleteObject: async () => undefined },
					'searchSingleIndex'
				)
			} as any),
		/Algolia adapter client\.searchSingleIndex must be a data property/
	);
	await assert.rejects(
		() =>
			createElasticsearchSearchAdapter({
				client: withAccessorMember({ index: async () => undefined, delete: async () => undefined }, 'search')
			} as any),
		/Elasticsearch adapter client\.search must be a data property/
	);
	await assert.rejects(
		() =>
			createRedisValkeyCacheAdapter({
				client: withAccessorMember(
					{
						mSet: async () => undefined,
						multi: () => ({ set: () => undefined, exec: async () => undefined }),
						del: async () => undefined
					},
					'mGet'
				)
			} as any),
		/redis-valkey cache client\.mGet must be a data property/
	);
	await assert.rejects(
		() =>
			createRedisValkeyCacheAdapter({
				client: redisClient,
				codec: withAccessorMember(
					{ encode: async (value: unknown) => value, decode: async (value: unknown) => value },
					'name',
					'codec'
				)
			} as any),
		/redis-valkey cache codec name must be a data property/
	);
	assert.equal(getterCalls, 0);

	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: postgresPool, [Symbol('option')]: true } as any),
		/PostgreSQL adapter options cannot contain symbol fields/
	);
	await assert.rejects(
		() => createMongoStoreAdapter({ client: mongoClient, dbName: 'test', [Symbol('option')]: true } as any),
		/MongoDB adapter options cannot contain symbol fields/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: datastore, [Symbol('option')]: true } as any),
		/Datastore adapter options cannot contain symbol fields/
	);
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client: firestore, [Symbol('option')]: true } as any),
		/Firestore adapter options cannot contain symbol fields/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter({ client: algoliaClient, [Symbol('option')]: true } as any),
		/Algolia adapter options cannot contain symbol fields/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({ client: elasticClient, [Symbol('option')]: true } as any),
		/Elasticsearch adapter options cannot contain symbol fields/
	);
	await assert.rejects(
		() => createRedisValkeyCacheAdapter({ client: redisClient, [Symbol('option')]: true } as any),
		/redis-valkey cache options cannot contain symbol fields/
	);
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: postgresPool, schem: 'public' } as any),
		/PostgreSQL adapter options contains unknown option "schem"/
	);
	await assert.rejects(
		() => createMongoStoreAdapter({ client: mongoClient, dbName: 'test', databaseName: 'test' } as any),
		/MongoDB adapter options contains unknown option "databaseName"/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: datastore, nameSpace: 'tenant' } as any),
		/Datastore adapter options contains unknown option "nameSpace"/
	);
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client: firestore, aggregateFields: {} } as any),
		/Firestore adapter options contains unknown option "aggregateFields"/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter({ client: algoliaClient, indexPrefixes: 'dev_' } as any),
		/Algolia adapter options contains unknown option "indexPrefixes"/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({ client: elasticClient, nodes: 'http:\/\/localhost:9200' } as any),
		/Elasticsearch adapter options contains unknown option "nodes"/
	);
	await assert.rejects(
		() => createRedisValkeyCacheAdapter({ client: redisClient, prefx: 'dev:' } as any),
		/redis-valkey cache options contains unknown option "prefx"/
	);
});

test('built-in store adapter option allowlists use captured Set intrinsics', async () => {
	const setHas = Set.prototype.has;
	const setAdd = Set.prototype.add;
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	Set.prototype.add = function () {
		throw new Error('patched Set.add');
	};
	try {
		await assert.rejects(
			() => createPostgresStoreAdapter({ unknown: true } as any),
			/PostgreSQL adapter options contains unknown option "unknown"/
		);
		await assert.rejects(
			() => createMongoStoreAdapter({ unknown: true } as any),
			/MongoDB adapter options contains unknown option "unknown"/
		);
		await assert.rejects(
			() => createDatastoreStoreAdapter({ unknown: true } as any),
			/Datastore adapter options contains unknown option "unknown"/
		);
		await assert.rejects(
			() => createFirestoreStoreAdapter({ unknown: true } as any),
			/Firestore adapter options contains unknown option "unknown"/
		);
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
});

test('cache codec factories ignore inherited option fields', () => {
	Object.defineProperty(Object.prototype, 'kind', {
		value: 'polluted-kind',
		configurable: true
	});
	try {
		const cache = createCodecCacheAdapter(new MemoryCacheAdapter(), {
			name: 'identity',
			encode: (value) => value,
			decode: (value) => value
		});
		assert.equal(cache.kind, 'memory+identity');
	} finally {
		delete (Object.prototype as Record<string, unknown>).kind;
	}

	Object.defineProperty(Object.prototype, 'key', {
		value: Buffer.alloc(32),
		configurable: true
	});
	try {
		assert.throws(() => createAesGcmCacheCodec({} as any), /AES-GCM cache codec key/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).key;
	}

	Object.defineProperty(Object.prototype, 'version', {
		value: 'bad:version',
		configurable: true
	});
	try {
		assert.doesNotThrow(() => createAesGcmCacheCodec({ key: Buffer.alloc(32) }));
	} finally {
		delete (Object.prototype as Record<string, unknown>).version;
	}
});

test('cache codec factories reject accessor and symbol option fields', () => {
	let getterCalls = 0;
	const codec = {
		name: 'identity',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};
	const cacheOptions = Object.defineProperty({}, 'kind', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'custom';
		}
	});
	assert.throws(
		() => createCodecCacheAdapter(new MemoryCacheAdapter(), codec, cacheOptions as any),
		/codec cache adapter options "kind" must be a data property/
	);
	assert.equal(getterCalls, 0);
	assert.throws(
		() => createCodecCacheAdapter(new MemoryCacheAdapter(), codec, { [Symbol('kind')]: 'custom' } as any),
		/codec cache adapter options cannot contain symbol fields/
	);
	assert.throws(
		() => createCodecCacheAdapter(new MemoryCacheAdapter(), codec, { kin: 'custom' } as any),
		/codec cache adapter options contains unknown option "kin"/
	);
	const hiddenCacheOptions = Object.defineProperty({}, 'kind', {
		enumerable: false,
		value: 'custom'
	});
	assert.throws(
		() => createCodecCacheAdapter(new MemoryCacheAdapter(), codec, hiddenCacheOptions as any),
		/codec cache adapter options "kind" must be enumerable/
	);

	const aesOptions = Object.defineProperty({}, 'key', {
		enumerable: true,
		get() {
			getterCalls++;
			return Buffer.alloc(32);
		}
	});
	assert.throws(
		() => createAesGcmCacheCodec(aesOptions as any),
		/AES-GCM cache codec options "key" must be a data property/
	);
	assert.equal(getterCalls, 0);
	assert.throws(
		() => createAesGcmCacheCodec({ key: Buffer.alloc(32), [Symbol('key')]: 'hidden' } as any),
		/AES-GCM cache codec options cannot contain symbol fields/
	);
	assert.throws(
		() => createAesGcmCacheCodec({ key: Buffer.alloc(32), keyVersion: 'v2' } as any),
		/AES-GCM cache codec options contains unknown option "keyVersion"/
	);
	const hiddenAesOptions = Object.defineProperty({}, 'key', {
		enumerable: false,
		value: Buffer.alloc(32)
	});
	assert.throws(
		() => createAesGcmCacheCodec(hiddenAesOptions as any),
		/AES-GCM cache codec options "key" must be enumerable/
	);
});
