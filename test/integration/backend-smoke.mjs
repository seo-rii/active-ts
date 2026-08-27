import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	StoreOutboxAdapter,
	createActiveTs,
	createOutboxPlugin,
	datastoreKey,
	datastoreSearchDocumentIdentity,
	defineModel,
	MemoryStoreAdapter,
	Model,
	runSearchSyncWorker
} from '../../build/src/index.js';
import {
	runCacheAdapterContract,
	runSearchAdapterContract,
	runStoreAdapterContract
} from '../../build/src/testing/index.js';
import { createRedisValkeyCacheAdapter } from '../../build/src/adapters/cache/redis-valkey.js';
import { createElasticsearchSearchAdapter } from '../../build/src/adapters/search/elasticsearch.js';
import {
	applyDatastoreIdRepairManifest,
	createDatastoreIdRepairManifest,
	createDatastoreNamespaceStoreFactory,
	createDatastoreStoreAdapter,
	inventoryDatastoreIds
} from '../../build/src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../../build/src/adapters/store/firestore.js';
import { createMongoStoreAdapter } from '../../build/src/adapters/store/mongodb.js';
import { createPostgresStoreAdapter } from '../../build/src/adapters/store/postgresql.js';
import {
	markStoreTrustsDatastoreEntityKeyRows,
	storeTrustsDatastoreEntityKeyRows
} from '../../build/src/core/store-options.js';

const KNOWN_TARGETS = ['postgres', 'mongodb', 'redis', 'elasticsearch', 'datastore', 'firestore'];
const requestedTargets = (process.env.ACTIVE_TS_INTEGRATION_TARGETS ?? 'postgres,mongodb,redis,elasticsearch')
	.split(',')
	.map((item) => item.trim())
	.filter(Boolean);
const unknownTargets = requestedTargets.filter((target) => !KNOWN_TARGETS.includes(target));
assert.deepEqual(unknownTargets, [], `Unknown active-ts integration target(s): ${unknownTargets.join(', ')}`);
const targets = new Set(requestedTargets);

let ran = 0;
const ranTargets = [];
const googleProjectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? 'active-ts-emulator';
const allowRealGoogleBackendSmoke = process.env.ACTIVE_TS_ALLOW_REAL_GCP_BACKEND_SMOKE === 'true';
const allowedRealGoogleBackendProjects = new Set(
	(process.env.ACTIVE_TS_REAL_GCP_BACKEND_PROJECTS ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
);

function assertGoogleBackendSmokeSafety(target, emulatorEnvName) {
	if (process.env[emulatorEnvName]) return;
	if (!allowRealGoogleBackendSmoke) {
		throw new Error(
			`${target} backend smoke requires ${emulatorEnvName}. Set ACTIVE_TS_ALLOW_REAL_GCP_BACKEND_SMOKE=true and include the project in ACTIVE_TS_REAL_GCP_BACKEND_PROJECTS only when intentionally targeting real GCP backends.`
		);
	}
	if (!allowedRealGoogleBackendProjects.has(googleProjectId)) {
		throw new Error(
			`${target} backend smoke real GCP opt-in requires ACTIVE_TS_REAL_GCP_BACKEND_PROJECTS to include "${googleProjectId}".`
		);
	}
}

function isActiveTsExpectedError(error) {
	return typeof error?.constructor?.name === 'string' && error.constructor.name.startsWith('ActiveTs');
}

function formatSmokeValue(value) {
	if (value === undefined) return 'undefined';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function summarizeSmokePlan(plan) {
	if (!plan || typeof plan !== 'object') return plan;
	return {
		where: plan.where,
		or: Array.isArray(plan.or) ? plan.or.length : plan.or,
		sort: plan.sort,
		limit: plan.limit,
		select: plan.select,
		aggregates: plan.aggregates,
		native: plan.native !== undefined,
		meta: plan.meta
	};
}

function rethrowWithBackendSmokeContext(error, context) {
	if (isActiveTsExpectedError(error)) throw error;
	const causeMessage = error instanceof Error ? error.message : String(error);
	const details = error && typeof error === 'object' && 'details' in error ? ` details=${formatSmokeValue(error.details)}` : '';
	const code = error && typeof error === 'object' && 'code' in error ? ` code=${formatSmokeValue(error.code)}` : '';
	throw new Error(`${context} failed:${code}${details} ${causeMessage}`, { cause: error });
}

function diagnosticStoreAdapter(adapter, label) {
	const wrap = (operation, fn, describe) => (...args) => {
		const modelName = args[0]?.name ?? 'unknown-model';
		const extra = describe ? ` ${describe(args)}` : '';
		const rethrow = (error) => {
			rethrowWithBackendSmokeContext(error, `${label} ${operation} ${modelName}${extra}`);
		};
		try {
			return fn(...args).catch(rethrow);
		} catch (error) {
			return Promise.reject(error).catch(rethrow);
		}
	};
	const wrapped = {
		...adapter,
		get: wrap('get', adapter.get, ([, id]) => `id=${formatSmokeValue(id)}`),
		getMany: wrap('getMany', adapter.getMany, ([, ids]) => `ids=${formatSmokeValue(ids)}`),
		query: wrap('query', adapter.query, ([, plan]) => `plan=${formatSmokeValue(summarizeSmokePlan(plan))}`),
		create: wrap('create', adapter.create, ([, id]) => `id=${formatSmokeValue(id)}`),
		update: wrap('update', adapter.update, ([, id]) => `id=${formatSmokeValue(id)}`),
		delete: wrap('delete', adapter.delete, ([, id]) => `id=${formatSmokeValue(id)}`)
	};
	if (adapter.aggregate) {
		wrapped.aggregate = wrap('aggregate', adapter.aggregate, ([, plan]) => `plan=${formatSmokeValue(summarizeSmokePlan(plan))}`);
	}
	if (adapter.transaction) {
		wrapped.transaction = (fn, options) =>
			adapter.transaction(
				typeof fn === 'function'
					? (tx) => fn(diagnosticStoreAdapter(tx, `${label} transaction`))
					: fn,
				options
			);
	}
	if (adapter.schema) {
		wrapped.schema = {
			...adapter.schema,
			plan: wrap('schema.plan', adapter.schema.plan, ([models]) => `models=${formatSmokeValue(models?.map?.((model) => model.name) ?? models)}`),
			apply: wrap('schema.apply', adapter.schema.apply, ([models, options]) => `models=${formatSmokeValue(models?.map?.((model) => model.name) ?? models)} options=${formatSmokeValue(options)}`)
		};
	}
	return storeTrustsDatastoreEntityKeyRows(adapter)
		? markStoreTrustsDatastoreEntityKeyRows(wrapped)
		: wrapped;
}

function quotePostgresSmokeIdentifier(value) {
	assert.match(value, /^[a-z][a-z0-9_-]*$/);
	assert.ok(Buffer.byteLength(value, 'utf8') <= 63, `PostgreSQL smoke identifier is too long: ${value}`);
	return `"${value}"`;
}

function assertNativeAlphaProbeResult(list) {
	assert.equal(list.length, 1);
	assert.equal(list[0].id, 1);
	assert.equal(list[0].name, 'alpha');
	assert.ok(list[0].score === 10 || list[0].score === 30, `unexpected native probe score ${list[0].score}`);
}

if (targets.has('postgres')) {
	const { Pool } = await import('pg');
	const pool = new Pool({
		connectionString: process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/active_ts'
	});
	const postgresSchemaName = `active_ts_smoke_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const postgresSchemaSql = quotePostgresSmokeIdentifier(postgresSchemaName);
	const nativeModelName = `integration_postgres_native_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const nativeTableSql = `${postgresSchemaSql}.${quotePostgresSmokeIdentifier(nativeModelName)}`;
	let postgresSmokeError;
	let postgresCleanupError;
	let postgresSchemaCreated = false;
	try {
		await pool.query(`create schema ${postgresSchemaSql}`);
		postgresSchemaCreated = true;
		const adapter = await createPostgresStoreAdapter({ pool, schema: postgresSchemaName });
		await runStoreAdapterContract(adapter, {
			nativeProbe: async ({ adapter, model }) => {
				const tableSql = `${postgresSchemaSql}.${quotePostgresSmokeIdentifier(model.name)}`;
				const result = await adapter.query(model, {
					where: [],
					or: [],
					sort: [],
					include: [],
					native: {
						payload: {
							text: `select data from ${tableSql} where data->>'name' = $1`,
							values: ['alpha']
						}
					}
				});
				assertNativeAlphaProbeResult(result.list);
			}
		});
		class IntegrationPostgresNativeRecord extends Model {}
		defineModel({ name: nativeModelName })
			.id('id')
			.validate((input) => input)
			.attach(IntegrationPostgresNativeRecord);
		const context = createActiveTs({ stores: { default: adapter } });
		const meta = context.meta(IntegrationPostgresNativeRecord);
		await adapter.schema.apply([meta], { mode: 'safe' });
		await adapter.create(meta, 1, { id: 1, handle: 'native-one', score: 11 });
		const native = await adapter.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: {
					text: `select data from ${nativeTableSql} where data->>'handle' = $1`,
					values: ['native-one']
				}
			}
		});
		assert.deepEqual(native.list, [{ id: 1, handle: 'native-one', score: 11 }]);
		await assert.rejects(
			() =>
				adapter.query(meta, {
					where: [{ field: 'handle', op: '=', value: 'native-one' }],
					or: [],
					sort: [],
					include: [],
					native: { payload: { text: `select data from ${nativeTableSql}` } }
				}),
			/PostgreSQL native SQL query payload cannot be combined with portable query clauses/
		);
		ran++;
		ranTargets.push('postgres');
	} catch (error) {
		postgresSmokeError = error;
	} finally {
		if (postgresSchemaCreated) {
			try {
				await pool.query(`drop schema if exists ${postgresSchemaSql} cascade`);
			} catch (error) {
				postgresCleanupError = error;
			}
		}
		try {
			await pool.end();
		} catch (error) {
			postgresCleanupError = postgresCleanupError === undefined
				? error
				: new AggregateError([postgresCleanupError, error], 'PostgreSQL backend smoke cleanup and pool shutdown failed.');
		}
	}
	if (postgresSmokeError && postgresCleanupError) {
		throw new AggregateError(
			[postgresSmokeError, postgresCleanupError],
			'PostgreSQL backend smoke failed and cleanup failed.'
		);
	}
	if (postgresSmokeError) throw postgresSmokeError;
	if (postgresCleanupError) throw postgresCleanupError;
}

if (targets.has('mongodb')) {
	const { MongoClient } = await import('mongodb');
	const client = new MongoClient(process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017');
	const dbName = `active_ts_${randomUUID().replace(/-/g, '')}`;
	try {
		await client.connect();
		const cacheScope = `mongodb|db=${dbName}`;
		const adapter = await createMongoStoreAdapter({
			client,
			dbName,
			cacheScope,
			allowAggregateScanFallback: true
		});
		assert.equal(adapter.cacheScope, cacheScope);
		await runStoreAdapterContract(adapter, {
			nativeProbe: async ({ adapter, model }) => {
				const result = await adapter.query(model, {
					where: [],
					or: [],
					sort: [],
					include: [],
					native: {
						payload: async ({ collection }) => ({
							list: await collection
								.find({ name: 'alpha' }, { projection: { _id: 0, id: 1, name: 1, score: 1 } })
								.toArray()
						})
					}
				});
				assertNativeAlphaProbeResult(result.list);
			}
		});
		const nativeModelName = `integration_mongodb_native_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		class IntegrationMongoNativeRecord extends Model {}
		defineModel({ name: nativeModelName })
			.id('id')
			.validate((input) => input)
			.attach(IntegrationMongoNativeRecord);
		const context = createActiveTs({ stores: { default: adapter } });
		const meta = context.meta(IntegrationMongoNativeRecord);
		try {
			await adapter.create(meta, 1, { id: 1, handle: 'native-one', score: 11 });
			const native = await adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					payload: async ({ collection }) => ({
						list: await collection
							.find({ handle: 'native-one' }, { projection: { _id: 0, id: 1, handle: 1, score: 1 } })
							.toArray()
					})
				}
			});
			assert.deepEqual(native.list, [{ id: 1, handle: 'native-one', score: 11 }]);
		} finally {
			await adapter.delete(meta, 1).catch(() => undefined);
		}

		const bulkModelName = `integration_mongodb_bulk_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		let rejectDeleteHooks = false;
		class IntegrationMongoBulkRecord extends Model {}
		defineModel({ name: bulkModelName })
			.id('id')
			.validate((input) => input)
			.index('handle', { name: 'handle_unique', unique: true })
			.hooks({
				afterDelete: ({ id }) => {
					if (rejectDeleteHooks && id === 301) throw new Error('MongoDB deleteMany rollback probe');
				}
			})
			.attach(IntegrationMongoBulkRecord);
		const bulkContext = createActiveTs({ stores: { default: adapter } });
		const BulkRecord = IntegrationMongoBulkRecord.use(bulkContext);
		const bulkMeta = bulkContext.meta(IntegrationMongoBulkRecord);
		await adapter.schema.apply([bulkMeta], { mode: 'safe' });

		await BulkRecord.create({ id: 102, handle: 'create-blocker' });
		await assert.rejects(
			() => BulkRecord.createMany([
				{ id: 101, handle: 'create-first' },
				{ id: 102, handle: 'create-conflict' }
			]),
			/already exists/
		);
		assert.equal(await adapter.get(bulkMeta, 101), null);
		assert.equal((await adapter.get(bulkMeta, 102)).handle, 'create-blocker');

		await BulkRecord.create({ id: 201, handle: 'upsert-original' });
		await BulkRecord.create({ id: 202, handle: 'upsert-conflict' });
		await assert.rejects(
			() => BulkRecord.upsertMany([
				{ id: 201, handle: 'upsert-mutated' },
				{ id: 203, handle: 'upsert-conflict' }
			]),
			/already exists/
		);
		assert.equal((await adapter.get(bulkMeta, 201)).handle, 'upsert-original');
		assert.equal(await adapter.get(bulkMeta, 203), null);

		await BulkRecord.create({ id: 301, handle: 'delete-first' });
		await BulkRecord.create({ id: 302, handle: 'delete-second' });
		rejectDeleteHooks = true;
		await assert.rejects(
			() => BulkRecord.deleteMany([301, 302]),
			/MongoDB deleteMany rollback probe/
		);
		rejectDeleteHooks = false;
		assert.deepEqual(
			(await adapter.getMany(bulkMeta, [301, 302])).map((row) => row?.handle),
			['delete-first', 'delete-second']
		);
		ran++;
		ranTargets.push('mongodb');
	} finally {
		await client.db(dbName).dropDatabase().catch(() => undefined);
		await client.close();
	}
}

if (targets.has('redis')) {
	const { createClient } = await import('redis');
	const client = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
	const prefix = `active-ts:${randomUUID()}:`;
	try {
		await client.connect();
		const cache = await createRedisValkeyCacheAdapter({ client, prefix });
		await runCacheAdapterContract(cache);
		ran++;
		ranTargets.push('redis');
	} finally {
		await client.quit().catch(() => undefined);
	}
}

if (targets.has('datastore')) {
	assertGoogleBackendSmokeSafety('Datastore', 'DATASTORE_EMULATOR_HOST');
	const { Datastore } = await import('@google-cloud/datastore');
	const namespace = `active_ts_${randomUUID().replace(/-/g, '')}`;
	const client = new Datastore({ projectId: googleProjectId });
	const namespaceStoreFactory = await createDatastoreNamespaceStoreFactory({
		datastoreOptions: { projectId: googleProjectId },
		cacheScopePrefix: `datastore|project=${googleProjectId}|database=-`,
		allowAggregateScanFallback: true,
		allowQueryScanFallback: true
	});
	const emptyNamespaceRejection = /namespace must be a non-empty string/;
	await assert.rejects(() => namespaceStoreFactory.forNamespace(''), emptyNamespaceRejection);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client, namespace: '' }),
		emptyNamespaceRejection
	);
	await assert.rejects(
		() => inventoryDatastoreIds({ client, kind: 'active_ts_empty_namespace_probe', namespace: '' }),
		emptyNamespaceRejection
	);
	assert.throws(
		() => datastoreKey('active_ts_empty_namespace_probe', 1, { namespace: '' }),
		emptyNamespaceRejection
	);
	const implicitDefaultStore = await namespaceStoreFactory.forNamespace();
	const explicitDefaultStore = await namespaceStoreFactory.forNamespace(undefined);
	assert.equal(implicitDefaultStore.datastoreNamespace, undefined);
	assert.equal(explicitDefaultStore.datastoreNamespace, undefined);
	assert.equal(implicitDefaultStore.datastoreProjectId, googleProjectId);
	assert.equal(explicitDefaultStore.datastoreProjectId, googleProjectId);
	assert.equal(implicitDefaultStore.cacheScope, explicitDefaultStore.cacheScope);
	const defaultAliasKind = `active_ts_default_alias_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const defaultNamespaceKey = client.key({ path: [defaultAliasKind, 1] });
	const emptyNamespaceKey = client.key({ path: [defaultAliasKind, 1], namespace: '' });
	const defaultAliasRepairTarget =
		`datastore:${googleProjectId}/(default)@${process.env.DATASTORE_EMULATOR_HOST ?? 'googleapis.com'}`;
	try {
		await client.save({ key: defaultNamespaceKey, data: { id: '1', marker: 'default-namespace' } });
		const [emptyNamespaceAlias] = await client.get(emptyNamespaceKey);
		assert.equal(emptyNamespaceAlias.marker, 'default-namespace');
		assert.equal(emptyNamespaceAlias.id, '1');
		const defaultIssues = [];
		const defaultInventory = await inventoryDatastoreIds({
			client,
			kind: defaultAliasKind,
			onIssue: (issue) => defaultIssues.push(issue)
		});
		assert.equal(defaultInventory.namespace, undefined);
		assert.equal(defaultInventory.counts['type-mismatch'], 1);
		assert.equal(defaultIssues.length, 1);
		assert.equal(Object.hasOwn(defaultIssues[0].key, 'namespace'), false);
		const defaultManifest = createDatastoreIdRepairManifest({
			report: defaultInventory,
			issues: defaultIssues,
			target: defaultAliasRepairTarget,
			policy: 'key-wins',
			excludeFromIndexes: []
		});
		assert.equal(Object.hasOwn(defaultManifest, 'namespace'), false);
		assert.equal(Object.hasOwn(defaultManifest.operations[0].source, 'namespace'), false);
		assert.equal(Object.hasOwn(defaultManifest.operations[0].target, 'namespace'), false);
		assert.deepEqual(await applyDatastoreIdRepairManifest({
			client,
			manifest: defaultManifest,
			target: defaultAliasRepairTarget,
			confirm: defaultManifest.digest
		}), { total: 1, processed: 1, repaired: 1, alreadyRepaired: 0, indeterminate: 0 });
		const [repairedDefault] = await client.get(defaultNamespaceKey);
		const [repairedAlias] = await client.get(emptyNamespaceKey);
		assert.equal(repairedDefault.id, 1);
		assert.equal(repairedAlias.id, 1);
		const finalDefaultInventory = await inventoryDatastoreIds({ client, kind: defaultAliasKind });
		assert.equal(finalDefaultInventory.counts.match, 1);
		assert.equal(finalDefaultInventory.counts['type-mismatch'], 0);
	} finally {
		await client.delete(defaultNamespaceKey).catch(() => undefined);
		await client.delete(emptyNamespaceKey).catch(() => undefined);
	}
	const adapter = await namespaceStoreFactory.forNamespace(namespace);
	const diagnosticAdapter = diagnosticStoreAdapter(adapter, 'datastore');
	await runStoreAdapterContract(diagnosticAdapter, {
		nativeProbe: async ({ adapter, model }) => {
			if (adapter.capabilities?.transaction === false) return;
			const result = await adapter.query(model, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					payload: async ({ client, model: nativeModel, plan }) => {
						assert.equal(nativeModel.name, model.name);
						assert.equal(plan.native !== undefined, true);
						const query = client.createQuery(namespace, model.name).filter('name', '=', 'alpha');
						const [entities] = await client.runQuery(query);
						return {
							list: entities.map(({ id, name, score }) => ({ id, name, score }))
						};
					}
				}
			});
			assertNativeAlphaProbeResult(result.list);
		}
	});
	const nativeModelName = `integration_datastore_native_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const nativeKeyModelName = `integration_datastore_native_key_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const aggregateModelName = `integration_datastore_aggregate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const nestedModelName = `integration_datastore_nested_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const bulkModelName = `integration_datastore_bulk_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const nestedParentKind = `integration_datastore_nested_parent_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
	class IntegrationDatastoreNativeRecord extends Model {}
	class IntegrationDatastoreNativeKeyRecord extends Model {}
	class IntegrationDatastoreAggregateRecord extends Model {}
	class IntegrationDatastoreNestedRecord extends Model {}
	class IntegrationDatastoreBulkRecord extends Model {}
	defineModel({ name: nativeModelName })
		.id('id')
		.validate((input) => input)
		.attach(IntegrationDatastoreNativeRecord);
	defineModel({ name: nativeKeyModelName })
		.id('id')
		.validate((input) => input)
		.attach(IntegrationDatastoreNativeKeyRecord);
	defineModel({ name: aggregateModelName })
		.id('id')
		.fieldType('score', 'number')
		.validate((input) => input)
		.attach(IntegrationDatastoreAggregateRecord);
	defineModel({ name: nestedModelName })
		.id('id')
		.fieldType('metadata.createdAt', 'number')
		.fieldCodec('metadata.category', {
			name: 'integration-stored-category',
			encode: (value) => `stored:${String(value)}`,
			decode: (value) => String(value).slice('stored:'.length),
			encodeQuery: (value) => `stored:${String(value)}`
		})
		.index('metadata.createdAt', { name: 'by_metadata_created_at', directions: ['desc'] })
		.validate((input) => input)
		.datastore({
			ancestor: ({ data }) => data ? datastoreKey(nestedParentKind, data.parentId) : undefined,
			ancestorFields: ['parentId']
		})
		.attach(IntegrationDatastoreNestedRecord);
	defineModel({ name: bulkModelName })
		.id('id')
		.validate((input) => input)
		.fieldCodec('secret', {
			name: 'integration-bulk-secret',
			encode: (value) => `stored:${String(value)}`,
			decode: (value) => String(value).slice('stored:'.length)
		})
		.hooks({
			afterCreate({ data }) {
				if (data.handle === 'rollback') throw new Error('integration bulk rollback');
			}
		})
		.attach(IntegrationDatastoreBulkRecord);
	const context = createActiveTs({ stores: { default: adapter } });
	const nativeMeta = context.meta(IntegrationDatastoreNativeRecord);
	const nativeKeyMeta = context.meta(IntegrationDatastoreNativeKeyRecord);
	const aggregateMeta = context.meta(IntegrationDatastoreAggregateRecord);
	const NestedRecord = IntegrationDatastoreNestedRecord.use(context);
	const BulkRecord = IntegrationDatastoreBulkRecord.use(context);
	const bulkMeta = context.meta(IntegrationDatastoreBulkRecord);
	const nestedParent = datastoreKey(nestedParentKind, 7);
	const nestedBulkLeftParent = datastoreKey(nestedParentKind, 8);
	const nestedBulkRightParent = datastoreKey(nestedParentKind, 9);
	const alternateNamespace = `active_ts_${randomUUID().replace(/-/g, '')}`;
	const alternateNamespaceAdapter = await namespaceStoreFactory.forNamespace(alternateNamespace);
	assert.notEqual(adapter.cacheScope, alternateNamespaceAdapter.cacheScope);
	try {
		await adapter.create(nativeMeta, 9001, { id: 9001, handle: 'primary-namespace' });
		await alternateNamespaceAdapter.create(nativeMeta, 9001, { id: 9001, handle: 'alternate-namespace' });
		assert.equal((await adapter.get(nativeMeta, 9001))?.handle, 'primary-namespace');
		assert.equal((await alternateNamespaceAdapter.get(nativeMeta, 9001))?.handle, 'alternate-namespace');
		assert.ok(alternateNamespaceAdapter.transaction);
		await alternateNamespaceAdapter.transaction(async (transaction) => {
			await transaction.update(nativeMeta, 9001, { id: 9001, handle: 'alternate-transaction' });
		});
		assert.equal((await alternateNamespaceAdapter.get(nativeMeta, 9001))?.handle, 'alternate-transaction');
		assert.equal((await adapter.get(nativeMeta, 9001))?.handle, 'primary-namespace');
	} finally {
		await adapter.delete(nativeMeta, 9001).catch(() => undefined);
		await alternateNamespaceAdapter.delete(nativeMeta, 9001).catch(() => undefined);
	}
	try {
		await diagnosticAdapter.create(nativeMeta, 1, { id: 1, handle: 'native-one', score: 11 });
		const native = await diagnosticAdapter.query(nativeMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: async ({ client, model }) => {
					const query = client.createQuery(namespace, model.name).filter('handle', '=', 'native-one');
					const [entities] = await client.runQuery(query);
					return {
						list: entities.map(({ id, handle, score }) => ({ id, handle, score }))
					};
				}
			}
		});
		assert.deepEqual(native.list, [{ id: 1, handle: 'native-one', score: 11 }]);
	} finally {
		await diagnosticAdapter.delete(nativeMeta, 1).catch(() => undefined);
	}
	const nativeKeyAdapter = await createDatastoreStoreAdapter({
		client,
		namespace,
		keyEncoding: 'native',
		allowAggregateScanFallback: true,
		allowQueryScanFallback: true
	});
	assert.equal(nativeKeyAdapter.datastoreProjectId, googleProjectId);
	const driftKey = client.key({
		path: ['active_ts_inventory_parent', 'parent', nativeKeyModelName, 23],
		namespace
	});
	const movedDriftSourceKey = client.key({
		path: ['active_ts_inventory_parent', 'parent', nativeKeyModelName, 24],
		namespace
	});
	const movedDriftTargetKey = client.key({
		path: ['active_ts_inventory_parent', 'parent', nativeKeyModelName, '24'],
		namespace
	});
	const idRepairTarget = `datastore:${googleProjectId}/(default)@${process.env.DATASTORE_EMULATOR_HOST ?? 'googleapis.com'}`;
	try {
		await assert.rejects(
			() => nativeKeyAdapter.create(nativeKeyMeta, 0, { id: 0, handle: 'incomplete' }),
			/must be a positive integer for native Datastore key encoding/
		);
		await nativeKeyAdapter.create(nativeKeyMeta, 17, { id: 17, handle: 'numeric' });
		await nativeKeyAdapter.create(nativeKeyMeta, '17', { id: '17', handle: 'string' });
		assert.deepEqual(await nativeKeyAdapter.getMany(nativeKeyMeta, [17, '17']), [
			{ id: 17, handle: 'numeric' },
			{ id: '17', handle: 'string' }
		]);
		assert.ok(nativeKeyAdapter.transaction);
		await nativeKeyAdapter.transaction(async (tx) => {
			assert.equal(tx.datastoreProjectId, googleProjectId);
		}, { readOnly: true });
		await nativeKeyAdapter.transaction(async (tx) => {
			assert.equal(tx.datastoreProjectId, googleProjectId);
			assert.deepEqual(await tx.get(nativeKeyMeta, 17), { id: 17, handle: 'numeric' });
			await tx.update(nativeKeyMeta, 17, { id: 17, handle: 'numeric-updated' });
			await tx.create(nativeKeyMeta, 'number:17', { id: 'number:17', handle: 'literal-prefix' });
		});
		assert.deepEqual(await nativeKeyAdapter.getMany(nativeKeyMeta, [17, '17', 'number:17']), [
			{ id: 17, handle: 'numeric-updated' },
			{ id: '17', handle: 'string' },
			{ id: 'number:17', handle: 'literal-prefix' }
		]);
		await nativeKeyAdapter.bulk.upsertMany(nativeKeyMeta, [
			{ id: 31, data: { id: 31, handle: 'bulk-numeric' } },
			{ id: '31', data: { id: '31', handle: 'bulk-string' } }
		]);
		await nativeKeyAdapter.bulk.upsertMany(nativeKeyMeta, [
			{ id: 32, data: { id: 32, handle: 'bulk-atomic-a' } },
			{ id: 33, data: { id: 33, handle: 'bulk-atomic-b' } }
		], { atomic: true });
		assert.deepEqual(await nativeKeyAdapter.getMany(nativeKeyMeta, [31, '31', 32, 33]), [
			{ id: 31, handle: 'bulk-numeric' },
			{ id: '31', handle: 'bulk-string' },
			{ id: 32, handle: 'bulk-atomic-a' },
			{ id: 33, handle: 'bulk-atomic-b' }
		]);
		await nativeKeyAdapter.bulk.deleteMany(nativeKeyMeta, [31, '31']);
		await nativeKeyAdapter.bulk.deleteMany(nativeKeyMeta, [32, 33], { atomic: true });
		assert.deepEqual(await nativeKeyAdapter.getMany(nativeKeyMeta, [31, '31', 32, 33]), [null, null, null, null]);
		const [numericEntity] = await client.get(client.key({ path: [nativeKeyModelName, 17], namespace }));
		const [stringEntity] = await client.get(client.key({ path: [nativeKeyModelName, '17'], namespace }));
		assert.equal(numericEntity[Datastore.KEY].name, undefined);
		assert.equal(Number(numericEntity[Datastore.KEY].id), 17);
		assert.equal(stringEntity[Datastore.KEY].name, '17');
		assert.equal(stringEntity[Datastore.KEY].id, undefined);
		const nativeKeyRows = await nativeKeyAdapter.query(nativeKeyMeta, {
			where: [],
			or: [],
			sort: [],
			include: []
		});
		assert.equal(nativeKeyRows.list.length, 3);
		assert.equal(nativeKeyRows.list.some((row) => row.id === 17), true);
		assert.equal(nativeKeyRows.list.some((row) => row.id === '17'), true);
		assert.equal(nativeKeyRows.list.some((row) => row.id === 'number:17'), true);
		const nativeKeyOnlyRows = await nativeKeyAdapter.query(nativeKeyMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['id']
		});
		assert.deepEqual(
			nativeKeyOnlyRows.list.map((row) => `${typeof row.id}:${String(row.id)}`).sort(),
			['number:17', 'string:17', 'string:number:17']
		);
		const pagedRows = [];
		let cursor;
		let more = true;
		let pageCount = 0;
		while (more && pageCount < 5) {
			const page = await nativeKeyAdapter.query(nativeKeyMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				limit: 2,
				cursor
			});
			pagedRows.push(...page.list);
			more = page.more === true;
			cursor = page.cursor;
			if (more) assert.equal(typeof cursor, 'string');
			pageCount++;
		}
		assert.equal(more, false);
		assert.equal(pageCount >= 2, true);
		assert.equal(pagedRows.length, 3);
		assert.equal(new Set(pagedRows.map((row) => `${typeof row.id}:${String(row.id)}`)).size, 3);
		await client.save({
			key: driftKey,
			data: { id: '23', handle: 'type-drift' }
		});
		const inventoryIssues = [];
		const inventory = await inventoryDatastoreIds({
			client,
			kind: nativeKeyModelName,
			namespace,
			onIssue: (issue) => {
				inventoryIssues.push(issue);
			}
		});
		assert.equal(inventory.scanned, 4);
		assert.equal(inventory.counts.match, 3);
		assert.equal(inventory.counts['type-mismatch'], 1);
		assert.equal(inventoryIssues.length, 1);
		assert.deepEqual(inventoryIssues[0].key.path, [
			{ kind: 'active_ts_inventory_parent', storage: 'name', value: 'parent' },
			{ kind: nativeKeyModelName, storage: 'id', value: '23' }
		]);
		const keyWinsManifest = createDatastoreIdRepairManifest({
			report: inventory,
			issues: inventoryIssues,
			target: idRepairTarget,
			policy: 'key-wins',
			excludeFromIndexes: ['handle']
		});
		assert.deepEqual(await applyDatastoreIdRepairManifest({
			client,
			manifest: keyWinsManifest,
			target: idRepairTarget,
			confirm: keyWinsManifest.digest
		}), { total: 1, processed: 1, repaired: 1, alreadyRepaired: 0, indeterminate: 0 });
		const [repairedDrift] = await client.get(driftKey);
		assert.equal(repairedDrift.id, 23);
		const [excludedKeyWinsRows] = await client.runQuery(
			client.createQuery(namespace, nativeKeyModelName).filter('handle', '=', 'type-drift')
		);
		assert.equal(excludedKeyWinsRows.length, 0);
		const keyWinsInventory = await inventoryDatastoreIds({
			client,
			kind: nativeKeyModelName,
			namespace
		});
		assert.equal(keyWinsInventory.counts.match, 4);
		assert.equal(keyWinsInventory.counts['type-mismatch'], 0);

		await client.save({
			key: movedDriftSourceKey,
			data: { id: '24', handle: 'move-type-drift' }
		});
		const movedIssues = [];
		const movedInventory = await inventoryDatastoreIds({
			client,
			kind: nativeKeyModelName,
			namespace,
			onIssue: (issue) => {
				movedIssues.push(issue);
			}
		});
		const payloadWinsManifest = createDatastoreIdRepairManifest({
			report: movedInventory,
			issues: movedIssues,
			target: idRepairTarget,
			policy: 'payload-wins',
			allowKeyMoves: true,
			descendantPolicy: 'verified-none',
			excludeFromIndexes: ['handle']
		});
		assert.deepEqual(await applyDatastoreIdRepairManifest({
			client,
			manifest: payloadWinsManifest,
			target: idRepairTarget,
			confirm: payloadWinsManifest.digest
		}), { total: 1, processed: 1, repaired: 1, alreadyRepaired: 0, indeterminate: 0 });
		const [missingMovedSource] = await client.get(movedDriftSourceKey);
		const [movedTarget] = await client.get(movedDriftTargetKey);
		assert.equal(missingMovedSource, undefined);
		assert.equal(movedTarget.id, '24');
		const [excludedPayloadWinsRows] = await client.runQuery(
			client.createQuery(namespace, nativeKeyModelName).filter('handle', '=', 'move-type-drift')
		);
		assert.equal(excludedPayloadWinsRows.length, 0);
		const finalInventory = await inventoryDatastoreIds({
			client,
			kind: nativeKeyModelName,
			namespace
		});
		assert.equal(finalInventory.scanned, 5);
		assert.equal(finalInventory.counts.match, 5);
	} finally {
		await nativeKeyAdapter.delete(nativeKeyMeta, 17).catch(() => undefined);
		await nativeKeyAdapter.delete(nativeKeyMeta, '17').catch(() => undefined);
		await nativeKeyAdapter.delete(nativeKeyMeta, 'number:17').catch(() => undefined);
		await nativeKeyAdapter.bulk.deleteMany(nativeKeyMeta, [31, '31', 32, 33]).catch(() => undefined);
		await client.delete(driftKey).catch(() => undefined);
		await client.delete(movedDriftSourceKey).catch(() => undefined);
		await client.delete(movedDriftTargetKey).catch(() => undefined);
	}
	try {
		await diagnosticAdapter.create(aggregateMeta, 1, { id: 1, score: 10 });
		await diagnosticAdapter.create(aggregateMeta, 2, { id: 2, score: 30 });
		assert.deepEqual(
			await diagnosticAdapter.aggregate(aggregateMeta, {
				where: [],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'totalScore' },
					{ op: 'avg', field: 'score', as: 'averageScore' },
					{ op: 'min', field: 'score', as: 'minScore' },
					{ op: 'max', field: 'score', as: 'maxScore' }
				]
			}),
			{ count: 2, totalScore: 40, averageScore: 20, minScore: 10, maxScore: 30 }
		);
	} finally {
		await diagnosticAdapter.delete(aggregateMeta, 1).catch(() => undefined);
		await diagnosticAdapter.delete(aggregateMeta, 2).catch(() => undefined);
	}
	try {
		const created = await BulkRecord.createMany([
			{ id: 71, handle: 'created-a', secret: 'alpha' },
			{ id: 72, handle: 'created-b', secret: 'beta' }
		]);
		assert.deepEqual(created.map((record) => record.data.secret), ['alpha', 'beta']);
		const upserted = await BulkRecord.upsertMany([
			{ id: 71, handle: 'updated-a', secret: 'next-alpha' },
			{ id: 73, handle: 'upsert-created', secret: 'gamma' }
		]);
		assert.deepEqual(upserted.map((result) => result.operation), ['update', 'create']);
		assert.equal((await adapter.get(bulkMeta, 71)).secret, 'stored:next-alpha');
		await BulkRecord.deleteMany([72, 999, 73]);
		assert.deepEqual(await adapter.getMany(bulkMeta, [72, 73]), [null, null]);
		await assert.rejects(
			() => BulkRecord.createMany([
				{ id: 74, handle: 'before-rollback', secret: 'delta' },
				{ id: 75, handle: 'rollback', secret: 'epsilon' }
			]),
			/integration bulk rollback/
		);
		assert.deepEqual(await adapter.getMany(bulkMeta, [74, 75]), [null, null]);
	} finally {
		await adapter.delete(bulkMeta, 71).catch(() => undefined);
		await adapter.delete(bulkMeta, 72).catch(() => undefined);
		await adapter.delete(bulkMeta, 73).catch(() => undefined);
		await adapter.delete(bulkMeta, 74).catch(() => undefined);
		await adapter.delete(bulkMeta, 75).catch(() => undefined);
	}
	try {
		const ancestorCreated = await NestedRecord.createMany([
			{ id: 4, parentId: 8, metadata: { category: 'bulk-left', createdAt: 80 } },
			{ id: 4, parentId: 9, metadata: { category: 'bulk-right', createdAt: 90 } }
		]);
		assert.deepEqual(ancestorCreated.map((record) => record.data.parentId), [8, 9]);
		assert.equal(
			(await NestedRecord.ancestor(nestedBulkLeftParent).find(4).load())?.data.metadata.category,
			'bulk-left'
		);
		assert.equal(
			(await NestedRecord.ancestor(nestedBulkRightParent).find(4).load())?.data.metadata.category,
			'bulk-right'
		);
		const storedBulkLeftKey = client.key({
			path: [nestedParentKind, 'number:8', nestedModelName, 'number:4'],
			namespace
		});
		const storedBulkRightKey = client.key({
			path: [nestedParentKind, 'number:9', nestedModelName, 'number:4'],
			namespace
		});
		const [storedBulkLeft] = await client.get(storedBulkLeftKey);
		const [storedBulkRight] = await client.get(storedBulkRightKey);
		assert.equal(storedBulkLeft.metadata.category, 'stored:bulk-left');
		assert.equal(storedBulkRight.metadata.category, 'stored:bulk-right');
		await NestedRecord.create({
			id: 1,
			parentId: 7,
			metadata: { category: 'group-a', createdAt: 10 }
		});
		await NestedRecord.create({
			id: 2,
			parentId: 7,
			metadata: { category: 'group-b', createdAt: 30 }
		});
		await NestedRecord.create({
			id: 3,
			parentId: 7,
			metadata: { category: 'group-c', createdAt: 20 }
		});
		const keyOnlyRecords = await NestedRecord.ancestor(nestedParent).select('id').load();
		assert.deepEqual(
			keyOnlyRecords.list.map((record) => record.data.id).sort((left, right) => left - right),
			[1, 2, 3]
		);
		assert.equal(keyOnlyRecords.list.every((record) => Object.keys(record.data).length === 1), true);
		const storedNestedKey = client.key({
			path: [nestedParentKind, 'number:7', nestedModelName, 'number:1'],
			namespace
		});
		const [storedNested] = await client.get(storedNestedKey);
		assert.equal(storedNested.metadata.category, 'stored:group-a');
		const selected = await NestedRecord
			.ancestor(nestedParent)
			.where('metadata.category', '=', 'group-a')
			.select('metadata.category')
			.load();
		assert.deepEqual(selected.list.map((record) => record.data), [{
			id: 1,
			metadata: { category: 'group-a' }
		}]);
		const offsetPage = await NestedRecord
			.ancestor(nestedParent)
			.where('metadata.createdAt', '>', 0)
			.orderBy('-metadata.createdAt')
			.select('metadata.createdAt')
			.offset(1)
			.limit(1)
			.load();
		assert.deepEqual(offsetPage.list.map((record) => record.data.metadata.createdAt), [20]);
		assert.equal(offsetPage.more, true);
		const createdAtValues = [];
		let nestedCursor;
		let nestedMore = true;
		let nestedPageCount = 0;
		while (nestedMore && nestedPageCount < 5) {
			const nestedQuery = NestedRecord
				.ancestor(nestedParent)
				.where('metadata.createdAt', '>', 0)
				.orderBy('-metadata.createdAt')
				.select('metadata.createdAt')
				.limit(2);
			if (nestedCursor) nestedQuery.cursor(nestedCursor);
			const page = await nestedQuery.load();
			createdAtValues.push(...page.list.map((record) => record.data.metadata.createdAt));
			nestedMore = page.more === true;
			nestedCursor = page.cursor;
			if (nestedMore) assert.equal(typeof nestedCursor, 'string');
			nestedPageCount++;
		}
		assert.deepEqual(createdAtValues, [30, 20, 10]);
		assert.equal(nestedMore, false);
		assert.equal(nestedPageCount >= 2, true);
		assert.equal(await NestedRecord.ancestor(nestedParent).sum('metadata.createdAt'), 60);
		assert.equal(
			(await NestedRecord.ancestor(nestedParent).readConsistency('strong').find(1).load())?.data.id,
			1
		);
		const historicalReadTime = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await NestedRecord.ancestor(nestedParent).find(3).update({
			metadata: { category: 'group-c', createdAt: 40 }
		});
		assert.equal(
			(await NestedRecord.ancestor(nestedParent).find(3).load())?.data.metadata.createdAt,
			40
		);
		const emulatorReadTime = Date.now();
		const pointInTime = process.env.DATASTORE_EMULATOR_HOST ? emulatorReadTime : historicalReadTime;
		assert.equal(
			(await NestedRecord.ancestor(nestedParent).readAt(pointInTime).find(3).load())?.data.metadata.createdAt,
			process.env.DATASTORE_EMULATOR_HOST ? 40 : 20
		);
		assert.equal(
			await NestedRecord.ancestor(nestedParent).readAt(pointInTime).sum('metadata.createdAt'),
			process.env.DATASTORE_EMULATOR_HOST ? 80 : 60
		);
	} finally {
		await NestedRecord.ancestor(nestedBulkLeftParent).find(4).delete().catch(() => undefined);
		await NestedRecord.ancestor(nestedBulkRightParent).find(4).delete().catch(() => undefined);
		await NestedRecord.ancestor(nestedParent).find(1).delete().catch(() => undefined);
		await NestedRecord.ancestor(nestedParent).find(2).delete().catch(() => undefined);
		await NestedRecord.ancestor(nestedParent).find(3).delete().catch(() => undefined);
	}
	ran++;
	ranTargets.push('datastore');
}

if (targets.has('datastore') && targets.has('elasticsearch')) {
	assertGoogleBackendSmokeSafety('Datastore', 'DATASTORE_EMULATOR_HOST');
	const { Datastore } = await import('@google-cloud/datastore');
	const { Client } = await import('@elastic/elasticsearch');
	const namespace = `active_ts_outbox_search_${randomUUID().replace(/-/g, '')}`;
	const indexPrefix = `active-ts-outbox-search-${randomUUID()}-`.toLowerCase();
	const client = new Datastore({ projectId: googleProjectId });
	const elasticsearchClient = new Client({ node: process.env.ELASTICSEARCH_URL ?? 'http://127.0.0.1:9200' });
	const parentKind = 'integration_datastore_outbox_search_parent';
	const modelName = `integration_datastore_outbox_search_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const outboxModelName = `integration_datastore_outbox_event_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	class IntegrationDatastoreOutboxSearchRecord extends Model {}
	defineModel({ name: modelName, search: 'elasticsearch' })
		.id('id')
		.validate((input) => input)
		.datastore({
			ancestor: ({ data }) => data ? datastoreKey(parentKind, data.parentId) : undefined,
			ancestorFields: ['parentId']
		})
		.search('elasticsearch', ['title', 'parentId'])
		.attach(IntegrationDatastoreOutboxSearchRecord);
	try {
		const datastore = await createDatastoreStoreAdapter({
			client,
			namespace,
			allowQueryScanFallback: true
		});
		const search = await createElasticsearchSearchAdapter({ client: elasticsearchClient, indexPrefix });
		let eventId = 0;
		const outbox = new StoreOutboxAdapter({ store: 'default', modelName: outboxModelName });
		const context = createActiveTs({
			stores: { default: datastore },
			search: { elasticsearch: search },
			defaultSearch: 'elasticsearch',
			plugins: [createOutboxPlugin({ outbox, id: () => `datastore-outbox-search-${++eventId}` })]
		});
		const Record = IntegrationDatastoreOutboxSearchRecord.use(context);
		const meta = context.meta(IntegrationDatastoreOutboxSearchRecord);
		const leftAncestor = datastoreKey(parentKind, 10, { namespace });
		const rightAncestor = datastoreKey(parentKind, 20, { namespace });
		await Record.create({ id: 1, parentId: 10, title: 'backend left needle' });
		await Record.create({ id: 1, parentId: 20, title: 'backend right needle' });
		const createEvents = await outbox.list();
		assert.deepEqual(
			createEvents.map((event) => ({
				id: event.id,
				operation: event.operation,
				modelIdentity: event.modelIdentity,
				modelDatastoreAncestor: event.modelDatastoreAncestor,
				hasData: event.data !== undefined
			})),
			[
				{
					id: 'datastore-outbox-search-1',
					operation: 'create',
					modelIdentity: datastoreSearchDocumentIdentity(meta, 1, leftAncestor),
					modelDatastoreAncestor: leftAncestor,
					hasData: false
				},
				{
					id: 'datastore-outbox-search-2',
					operation: 'create',
					modelIdentity: datastoreSearchDocumentIdentity(meta, 1, rightAncestor),
					modelDatastoreAncestor: rightAncestor,
					hasData: false
				}
			]
		);
		assert.equal(await runSearchSyncWorker({
			outbox,
			search,
			models: [IntegrationDatastoreOutboxSearchRecord],
			context,
			allowUnsafeDrainFallback: true
		}), 2);
		const indexName = `${indexPrefix}${meta.name}`.toLowerCase();
		await elasticsearchClient.indices.refresh({ index: indexName });
		const indexed = await search.search(meta, 'needle', { limit: 10 });
		assert.deepEqual(
			indexed.list.map((item) => `${item.id}:${item.parentId}`).sort(),
			['1:10', '1:20']
		);

		await Record.ancestor(datastoreKey(parentKind, 10)).find(1).delete();
		const deleteEvents = await outbox.list();
		assert.deepEqual(
			deleteEvents.map((event) => ({
				id: event.id,
				operation: event.operation,
				modelIdentity: event.modelIdentity,
				modelDatastoreAncestor: event.modelDatastoreAncestor,
				hasData: event.data !== undefined
			})),
			[
				{
					id: 'datastore-outbox-search-3',
					operation: 'delete',
					modelIdentity: datastoreSearchDocumentIdentity(meta, 1, leftAncestor),
					modelDatastoreAncestor: leftAncestor,
					hasData: false
				}
			]
		);
		assert.equal(await runSearchSyncWorker({
			outbox,
			search,
			models: [IntegrationDatastoreOutboxSearchRecord],
			context,
			allowUnsafeDrainFallback: true
		}), 1);
		await elasticsearchClient.indices.refresh({ index: indexName });
		const afterDelete = await search.search(meta, 'needle', { limit: 10 });
		assert.deepEqual(
			afterDelete.list.map((item) => `${item.id}:${item.parentId}`).sort(),
			['1:20']
		);
	} finally {
		const cleanupDatastore = await createDatastoreStoreAdapter({
			client,
			namespace,
			allowQueryScanFallback: true
		});
		const cleanupContext = createActiveTs({ stores: { default: cleanupDatastore } });
		const cleanupMeta = cleanupContext.meta(IntegrationDatastoreOutboxSearchRecord);
		await cleanupDatastore.delete(cleanupMeta, 1, { meta: { datastoreAncestor: datastoreKey(parentKind, 10) } }).catch(() => undefined);
		await cleanupDatastore.delete(cleanupMeta, 1, { meta: { datastoreAncestor: datastoreKey(parentKind, 20) } }).catch(() => undefined);
		await elasticsearchClient.indices.delete({ index: `${indexPrefix}*` }).catch(() => undefined);
		await elasticsearchClient.close();
	}
}

if (targets.has('firestore')) {
	assertGoogleBackendSmokeSafety('Firestore', 'FIRESTORE_EMULATOR_HOST');
	const { Firestore, AggregateField } = await import('@google-cloud/firestore');
	const client = new Firestore({ projectId: googleProjectId });
	try {
		const adapter = await createFirestoreStoreAdapter({
			client,
			aggregateField: AggregateField,
			allowAggregateScanFallback: true
		});
		await runStoreAdapterContract(adapter, {
			nativeProbe: async ({ adapter, model }) => {
				const result = await adapter.query(model, {
					where: [],
					or: [],
					sort: [],
					include: [],
					native: {
						payload: async ({ client, model: nativeModel, plan }) => {
							assert.equal(nativeModel.name, model.name);
							assert.equal(plan.native !== undefined, true);
							const snap = await client.collection(model.name).where('name', '==', 'alpha').get();
							return {
								list: snap.docs.map((doc) => {
									const { id, name, score } = doc.data();
									return { id, name, score };
								})
							};
						}
					}
				});
				assertNativeAlphaProbeResult(result.list);
			}
		});
		const nativeModelName = `integration_firestore_native_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		const aggregateModelName = `integration_firestore_aggregate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		const bulkModelName = `integration_firestore_bulk_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		class IntegrationFirestoreNativeRecord extends Model {}
		class IntegrationFirestoreAggregateRecord extends Model {}
		class IntegrationFirestoreBulkRecord extends Model {}
		defineModel({ name: nativeModelName })
			.id('id')
			.validate((input) => input)
			.attach(IntegrationFirestoreNativeRecord);
		defineModel({ name: aggregateModelName })
			.id('id')
			.fieldType('score', 'number')
			.validate((input) => input)
			.attach(IntegrationFirestoreAggregateRecord);
		defineModel({ name: bulkModelName })
			.id('id')
			.validate((input) => input)
			.fieldCodec('secret', {
				name: 'integration-firestore-bulk-secret',
				encode: (value) => `stored:${String(value)}`,
				decode: (value) => String(value).slice('stored:'.length)
			})
			.hooks({
				afterCreate({ data }) {
					if (data.handle === 'rollback') throw new Error('integration Firestore bulk rollback');
				}
			})
			.attach(IntegrationFirestoreBulkRecord);
		const context = createActiveTs({ stores: { default: adapter } });
		const nativeMeta = context.meta(IntegrationFirestoreNativeRecord);
		const aggregateMeta = context.meta(IntegrationFirestoreAggregateRecord);
		const bulkMeta = context.meta(IntegrationFirestoreBulkRecord);
		const BulkRecord = IntegrationFirestoreBulkRecord.use(context);
		try {
			await adapter.create(nativeMeta, 1, { id: 1, handle: 'native-one', score: 11 });
			const native = await adapter.query(nativeMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					payload: async ({ client, model }) => {
						const snap = await client.collection(model.name).where('handle', '==', 'native-one').get();
						return {
							list: snap.docs.map((doc) => {
								const { id, handle, score } = doc.data();
								return { id, handle, score };
							})
						};
					}
				}
			});
			assert.deepEqual(native.list, [{ id: 1, handle: 'native-one', score: 11 }]);
		} finally {
			await adapter.delete(nativeMeta, 1).catch(() => undefined);
		}
		try {
			await adapter.create(aggregateMeta, 1, { id: 1, score: 10 });
			await adapter.create(aggregateMeta, 2, { id: 2, score: 30 });
			assert.deepEqual(
				await adapter.aggregate(aggregateMeta, { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] }),
				{ count: 2 }
			);
			assert.deepEqual(
				await adapter.aggregate(aggregateMeta, { where: [], or: [], aggregates: [{ op: 'min', field: 'score', as: 'minScore' }] }),
				{ minScore: 10 }
			);
			assert.deepEqual(
				await adapter.aggregate(aggregateMeta, { where: [], or: [], aggregates: [{ op: 'max', field: 'score', as: 'maxScore' }] }),
				{ maxScore: 30 }
			);
		} finally {
			await adapter.delete(aggregateMeta, 1).catch(() => undefined);
			await adapter.delete(aggregateMeta, 2).catch(() => undefined);
		}
		try {
			await BulkRecord.createMany([
				{ id: 71, handle: 'created-a', secret: 'alpha' },
				{ id: 72, handle: 'created-b', secret: 'beta' }
			]);
			const upserted = await BulkRecord.upsertMany([
				{ id: 71, handle: 'updated-a', secret: 'next-alpha' },
				{ id: 72, handle: 'updated-b', secret: 'next-beta' },
				{ id: 73, handle: 'upsert-created', secret: 'gamma' }
			]);
			assert.deepEqual(upserted.map((result) => result.operation), ['update', 'update', 'create']);
			assert.equal((await adapter.get(bulkMeta, 71)).secret, 'stored:next-alpha');
			await BulkRecord.deleteMany([72, 999, 73]);
			assert.deepEqual(await adapter.getMany(bulkMeta, [72, 73]), [null, null]);
			await assert.rejects(
				() => BulkRecord.createMany([
					{ id: 74, handle: 'before-rollback', secret: 'delta' },
					{ id: 75, handle: 'rollback', secret: 'epsilon' }
				]),
				/integration Firestore bulk rollback/
			);
			assert.deepEqual(await adapter.getMany(bulkMeta, [74, 75]), [null, null]);
		} finally {
			await adapter.delete(bulkMeta, 71).catch(() => undefined);
			await adapter.delete(bulkMeta, 72).catch(() => undefined);
			await adapter.delete(bulkMeta, 73).catch(() => undefined);
			await adapter.delete(bulkMeta, 74).catch(() => undefined);
			await adapter.delete(bulkMeta, 75).catch(() => undefined);
		}
		ran++;
		ranTargets.push('firestore');
	} finally {
		await client.terminate().catch(() => undefined);
	}
}

if (targets.has('elasticsearch')) {
	const { Client } = await import('@elastic/elasticsearch');
	const client = new Client({ node: process.env.ELASTICSEARCH_URL ?? 'http://127.0.0.1:9200' });
	const prefix = `active-ts-${randomUUID()}-`.toLowerCase();
	class IntegrationSearchRecord extends Model {}
	class IntegrationAncestorSearchRecord extends Model {}
	defineModel({ name: 'integration_search_record', search: 'elasticsearch' })
		.id('id')
		.validate((input) => input)
		.search('elasticsearch', ['title'])
		.attach(IntegrationSearchRecord);
	defineModel({ name: 'integration_ancestor_search_record', search: 'elasticsearch' })
		.id('id')
		.validate((input) => input)
		.datastore({
			ancestor: ({ data }) => datastoreKey('integration_ancestor_search_parent', data.parentId),
			ancestorFields: ['parentId']
		})
		.search('elasticsearch', ['title'])
		.attach(IntegrationAncestorSearchRecord);
	try {
		const search = await createElasticsearchSearchAdapter({ client, indexPrefix: prefix });
		await runSearchAdapterContract(search, {
			settleMs: 10000,
			pollIntervalMs: 500,
			nativeProbe: async ({ adapter, model }) => {
				const nativeProbeIndex = `${prefix}${model.name}`.toLowerCase();
				try {
					await adapter.index(model, 900, {
						id: 900,
						title: 'native probe needle',
						score: 90,
						tags: ['native'],
						profile: { city: 'Seoul' }
					});
					await client.indices.refresh({ index: nativeProbeIndex });
					const nativeOnlyModel = { ...model, searchIndexes: [] };
					const result = await adapter.search(nativeOnlyModel, 'ignored', {
						native: { query: { match: { title: 'native probe needle' } } }
					});
					assert.deepEqual(result.list.map((item) => item.id), [900]);
				} finally {
					await adapter.delete(model, 900).catch(() => undefined);
					await client.indices.refresh({ index: nativeProbeIndex }).catch(() => undefined);
				}
			}
		});
		const context = createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			search: { elasticsearch: search },
			defaultSearch: 'elasticsearch'
		});
		const meta = context.meta(IntegrationSearchRecord);
		const ancestorMeta = context.meta(IntegrationAncestorSearchRecord);
		await search.index(meta, 1, { id: 1, title: 'needle title' });
		await client.indices.refresh({ index: `${prefix}${meta.name}`.toLowerCase() });
		const result = await search.search(meta, 'needle', { limit: 10 });
		assert.deepEqual(result.list.map((item) => item.id), [1]);
		await search.index(ancestorMeta, 1, { id: 1, parentId: 10, title: 'left ancestor needle' });
		await search.index(ancestorMeta, 1, { id: 1, parentId: 20, title: 'right ancestor needle' });
		await client.indices.refresh({ index: `${prefix}${ancestorMeta.name}`.toLowerCase() });
		const ancestorResult = await search.search(ancestorMeta, 'needle', { limit: 10 });
		assert.deepEqual(
			ancestorResult.list.map((item) => `${item.id}:${item.parentId}`).sort(),
			['1:10', '1:20']
		);
		ran++;
		ranTargets.push('elasticsearch');
	} finally {
		await client.indices.delete({ index: `${prefix}*` }).catch(() => undefined);
		await client.close();
	}
}

assert.ok(ran > 0, 'No integration targets were selected.');
assert.deepEqual(
	[...ranTargets].sort(),
	[...targets].sort(),
	'Every requested active-ts integration target must run.'
);
console.log(`active-ts integration smoke passed for ${ran} target(s): ${ranTargets.join(', ')}.`);
