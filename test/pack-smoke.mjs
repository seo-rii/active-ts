import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { scanTextForForbiddenSecrets } from '../build/test/secret-scan-rules.js';

const exec = promisify(execFile);
const root = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), 'active-ts-pack-'));
const PUBLIC_ROOT_RUNTIME_EXPORTS = [
	'ACTIVE_TS_ENTITY_KEY',
	'ActiveContext',
	'ActiveFunctionCache',
	'ActiveTsCommittedTransactionError',
	'ActiveTsCommittedWriteError',
	'ActiveTsConfigurationError',
	'ActiveTsConflictError',
	'ActiveTsError',
	'ActiveTsNotFoundError',
	'ActiveTsUnknownTransactionOutcomeError',
	'ActiveTsValidationError',
	'FindBuilder',
	'LazyRef',
	'MemoryCacheAdapter',
	'MemoryOutboxAdapter',
	'MemorySearchAdapter',
	'MemoryStoreAdapter',
	'Model',
	'ModelBuilder',
	'QueryBuilder',
	'SearchBuilder',
	'StoreOutboxAdapter',
	'aggregateRows',
	'applyFieldTypeTransforms',
	'applyModelMeta',
	'assertAggregateSpecsCompatibleWithModel',
	'assertContextBoundCacheAdapter',
	'assertContextBoundSearchAdapter',
	'assertContextBoundStoreAdapter',
	'assertCursorMatchesSort',
	'assertOutsideActiveTransaction',
	'assertSafeAggregateAlias',
	'attachModelMeta',
	'clearDefaultContext',
	'compareRowToCursor',
	'compareRowsBySort',
	'createActiveTs',
	'createActiveTsAsync',
	'createAesGcmCacheCodec',
	'createCacheMiddlewareAdapter',
	'createCodecCacheAdapter',
	'createFunctionCache',
	'createOutboxPlugin',
	'createSearchMiddlewareAdapter',
	'createSoftDeletePlugin',
	'createStoreMiddlewareAdapter',
	'cursorValues',
	'datastoreAncestorOptions',
	'datastoreInt64Id',
	'datastoreInt64IdValue',
	'datastoreKey',
	'datastoreReadOptions',
	'datastoreSearchDocumentIdentity',
	'decodeCursor',
	'defaultAggregateResult',
	'defaultAggregateValue',
	'defineModel',
	'encodeCursor',
	'entity',
	'field',
	'fromArkType',
	'fromTypia',
	'fromValibot',
	'fromZod',
	'getCurrentDefaultContext',
	'getDefaultContext',
	'getFunctionCacheDiagnostics',
	'getModelMeta',
	'getRelation',
	'hasMany',
	'id',
	'index',
	'isContextBoundCacheAdapter',
	'isContextBoundSearchAdapter',
	'isContextBoundStoreAdapter',
	'isDatastoreInt64Id',
	'isPartialModel',
	'markSearchDocumentIdentity',
	'mergeHooks',
	'modelMeta',
	'normalizeAggregateFieldTypes',
	'normalizeAggregatePlanFieldTypes',
	'normalizeAggregateResult',
	'normalizeAggregateRow',
	'normalizeIncludeSpecs',
	'normalizeOutboxEvent',
	'normalizeQueryPlanFieldTypes',
	'normalizeWhereFieldTypes',
	'normalizeWhereShapeFieldTypes',
	'ref',
	'relation',
	'relationPreloadSelectFields',
	'resetLazyLoadWarnings',
	'restore',
	'runHookList',
	'runSearchSyncWorker',
	'safeErrorMessage',
	'sanitizeHooks',
	'searchIndex',
	'setDefaultContext',
	'softDelete',
	'sortWithStableId',
	'toHookList',
	'trackStoreTransactionWork',
	'typedField',
	'validateAggregateSpecs'
];
const PUBLIC_SUBPATH_SMOKE_EXPORTS = {
	'./adapters/store/datastore': [
		'applyDatastoreIdRepairManifest',
		'createDatastoreIdRepairManifest',
		'createDatastoreIndexYaml',
		'createDatastoreNamespaceStoreFactory',
		'createDatastoreStoreAdapter',
		'datastoreInt64Id',
		'datastoreInt64IdValue',
		'datastoreModelTransactionOptions',
		'datastoreStoreTransactionOptions',
		'datastoreTransactionOptions',
		'inventoryDatastoreIds',
		'isDatastoreInt64Id'
	],
	'./adapters/store/firestore': ['createFirestoreStoreAdapter'],
	'./adapters/store/memory': ['MemoryStoreAdapter'],
	'./adapters/store/mongodb': ['createMongoStoreAdapter'],
	'./adapters/store/postgresql': ['createPostgresStoreAdapter'],
	'./adapters/cache/memory': ['MemoryCacheAdapter'],
	'./adapters/cache/redis-valkey': ['createRedisValkeyCacheAdapter'],
	'./adapters/search/algolia': ['createAlgoliaSearchAdapter'],
	'./adapters/search/elasticsearch': ['createElasticsearchSearchAdapter'],
	'./adapters/search/memory': ['MemorySearchAdapter'],
	'./adapters/search/native': ['createNativeSearchAdapter'],
	'./testing': [
		'ActiveTestContext',
		'captureLazyLoadWarnings',
		'createAdapterContractSuite',
		'createCacheAdapterContractSuite',
		'createIntegrationHarness',
		'createSearchAdapterContractSuite',
		'createTestContext',
		'expectNoLazyLoadWarnings',
		'fixture',
		'getCurrentTestContext',
		'resetTestContext',
		'runCacheAdapterContract',
		'runSearchAdapterContract',
		'runStoreAdapterContract',
		'seed',
		'snapshotStore',
		'withTestContext'
	]
};

try {
	const packDir = path.join(temp, 'pack');
	const installDir = path.join(temp, 'consumer');
	await exec('mkdir', ['-p', packDir, installDir]);
	const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: root });
	const [packResult] = JSON.parse(packJsonFromStdout(stdout));
	const { filename, files } = packResult;
	const packedPaths = new Set(files.map((file) => file.path));
	const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
	for (const peer of Object.keys(packageJson.peerDependencies ?? {})) {
		assert.equal(packageJson.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must remain an optional peer dependency`);
		assert.equal(packageJson.dependencies?.[peer], undefined, `${peer} must not be a runtime dependency`);
	}
	assertPackageExportsAreStable(packageJson, packedPaths);
	assertPackedPackageTargetsExist(packageJson, packedPaths);
	assertPackedPathsStayInAllowedSurface(packedPaths);
	assert.equal(packedPaths.has('docs/risk-register.md'), false);
	assert.equal(packedPaths.has('docs/risk-register-archive.md'), false);
	assert.equal(packedPaths.has('docs/quickstart.md'), true);
	await assertPackedMarkdownLinksResolve(root, packedPaths, ['README.md', ...[...packedPaths].filter((file) => file.startsWith('docs/') && file.endsWith('.md'))]);
	await assertPackedFilesAvoidSecrets(root, files);
	await assertPackedSourceMapsResolve(root, packedPaths);
	const tarball = path.join(packDir, filename);

	await writeFile(path.join(installDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	await exec('npm', ['install', '--ignore-scripts', tarball], { cwd: installDir });
	await exec(
		'npm',
		[
			'install',
			'--ignore-scripts',
			'--save-dev',
			`typescript@${packageJson.devDependencies.typescript}`,
			`@types/node@${packageJson.devDependencies['@types/node']}`
		],
		{ cwd: installDir }
	);
	for (const peer of Object.keys(packageJson.peerDependencies ?? {})) {
		await assert.rejects(
			readFile(path.join(installDir, 'node_modules', peer, 'package.json'), 'utf8'),
			(error) => error?.code === 'ENOENT',
			`${peer} must not be installed in the consumer package`
		);
	}
	await writeFile(
		path.join(installDir, 'no-peer-runtime-smoke.mjs'),
		`
import assert from 'node:assert/strict';

const specifiers = ${JSON.stringify(['active-ts', ...Object.keys(installedPublicSubpathSmokeExports())])};
for (const specifier of specifiers) {
  const module = await import(specifier);
  assert.equal(typeof module, 'object', specifier + ' must load without optional peers installed');
}
`
	);
	await exec('node', ['no-peer-runtime-smoke.mjs'], { cwd: installDir });
	const mongodbPackageJson = JSON.parse(
		await readFile(path.join(root, 'node_modules', 'mongodb', 'package.json'), 'utf8')
	);
	await exec(
		'npm',
		['install', '--ignore-scripts', '--save-dev', `mongodb@${mongodbPackageJson.version}`],
		{ cwd: installDir }
	);
	await writeFile(
		path.join(installDir, 'require-smoke.cjs'),
		"require('active-ts');\n"
	);
	await assert.rejects(
		exec('node', ['require-smoke.cjs'], { cwd: installDir }),
		(error) =>
			typeof error?.stderr === 'string' &&
			error.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'),
		'CommonJS require() must remain outside the ESM-only package contract'
	);
	await writeFile(
		path.join(installDir, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2023',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					strict: true,
					skipLibCheck: false,
					types: ['node'],
					noEmit: true
				},
				include: ['smoke.ts']
			},
			null,
			2
		)
	);
	await writeFile(
		path.join(installDir, 'smoke.ts'),
		`
import {
	ActiveFunctionCache,
	ActiveTsUnknownTransactionOutcomeError,
	createAesGcmCacheCodec,
	createActiveTs,
	createCacheMiddlewareAdapter,
	createCodecCacheAdapter,
	createFunctionCache,
	createOutboxPlugin,
	createSearchMiddlewareAdapter,
	createSoftDeletePlugin,
	createStoreMiddlewareAdapter,
	datastoreAncestorOptions,
	datastoreInt64Id,
	datastoreInt64IdValue,
	datastoreReadOptions,
	datastoreKey,
	datastoreSearchDocumentIdentity,
	defineModel,
	fromArkType,
	fromTypia,
	fromValibot,
	fromZod,
	getFunctionCacheDiagnostics,
	isDatastoreInt64Id,
	markSearchDocumentIdentity,
	normalizeOutboxEvent,
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemorySearchAdapter,
	type ActiveContext,
	type ActiveTsPlugin,
	type ArkTypeAdapterOptions,
	type CacheAdapter,
	type CacheCodec,
	type CacheMiddleware,
	type DatastoreAncestorInput,
	type DatastoreAncestorReadOptions,
	type DatastoreAncestorResolver,
	type DatastoreAncestorWriteOptions,
	type DatastoreInt64Id,
	type DatastoreReadOptions,
	type DatastoreReadPolicy,
	type DatastoreKey,
	type DatastoreModelMeta,
	type FunctionCacheGetOptions,
	type FunctionCacheOptions,
	MemoryStoreAdapter,
	Model,
	type ModelUpsertResult,
	type EntityId,
	type OutboxAdapter,
	type OutboxEvent,
	type OutboxPluginOptions,
	restore,
	runSearchSyncWorker,
	type SearchAdapter,
	type SearchMiddleware,
	type SearchWriteOptions,
	type SearchSyncWorkerOptions,
	type ResolvedModelMeta,
	type SchemaPlan,
	softDelete,
	type SoftDeleteOptions,
	type StoreAdapter,
	StoreOutboxAdapter,
	type StoreMiddleware,
	type StoreOutboxAdapterOptions,
	type StoreOutboxSchemaApplyOptions,
	type Validator
} from 'active-ts';
import {
	ActiveTestContext,
	captureLazyLoadWarnings,
	createAdapterContractSuite,
	createCacheAdapterContractSuite,
	createIntegrationHarness,
	createSearchAdapterContractSuite,
	createTestContext,
	expectNoLazyLoadWarnings,
	fixture,
	getCurrentTestContext,
	resetTestContext,
	runCacheAdapterContract,
	runSearchAdapterContract,
	runStoreAdapterContract,
	seed,
	snapshotStore,
	type AdapterContractSuite,
	type CacheAdapterContractSuite,
	type IntegrationHarness,
	type IntegrationHarnessApi,
	type IntegrationHarnessContextHandle,
	type SearchAdapterContractSuite,
	type SearchAdapterContractOptions,
	type StoreAdapterContractOptions,
	type StoreContractModel,
	type TestContextOptions,
	withTestContext
} from 'active-ts/testing';
import { createPostgresStoreAdapter, type PostgresStoreOptions } from 'active-ts/adapters/store/postgresql';
import {
	createMongoStoreAdapter,
	type MongoStoreAdapter,
	type MongoStoreOptions,
	type MongoStoreTransactionOptions,
	type MongoTransactionNativeOptions
} from 'active-ts/adapters/store/mongodb';
import {
	applyDatastoreIdRepairManifest,
	createDatastoreIdRepairManifest,
	createDatastoreIndexYaml,
	createDatastoreNamespaceStoreFactory,
	createDatastoreStoreAdapter,
	datastoreInt64Id as datastoreSubpathInt64Id,
	datastoreInt64IdValue as datastoreSubpathInt64IdValue,
	datastoreModelTransactionOptions,
	datastoreStoreTransactionOptions,
	datastoreTransactionOptions,
	inventoryDatastoreIds,
	isDatastoreInt64Id as isDatastoreSubpathInt64Id,
	type DatastoreBulkDeleteEntry,
	type DatastoreBulkMutationOptions,
	type DatastoreBulkOperations,
	type DatastoreBulkUpsertEntry,
	type DatastoreIdInventoryIssue,
	type DatastoreIdInventoryOptions,
	type DatastoreIdInventoryReport,
	type DatastoreIdRepairApplyOptions,
	type DatastoreIdRepairApplyReport,
	type DatastoreIdRepairDescendantPolicy,
	type DatastoreIdRepairManifest,
	type DatastoreIdRepairPlanOptions,
	type DatastoreIdRepairPolicy,
	type DatastoreInt64Id as DatastoreSubpathInt64Id,
	type DatastoreKeyEncoding,
	type DatastoreModelTransactionOptions,
	type DatastoreNamespaceStoreFactory,
	type DatastoreNamespaceStoreFactoryOptions,
	type DatastoreStoreOptions,
	type DatastoreStoreAdapter,
	type DatastoreStoreTransactionOptions,
	type DatastoreTransactionOptions,
	type DatastoreTransactionNativeOptions
} from 'active-ts/adapters/store/datastore';
import type { FirestoreStoreOptions, FirestoreTransactionNativeOptions } from 'active-ts/adapters/store/firestore';
import { createRedisValkeyCacheAdapter, type RedisValkeyOptions } from 'active-ts/adapters/cache/redis-valkey';
import type { AlgoliaOptions } from 'active-ts/adapters/search/algolia';
import type { ElasticsearchOptions } from 'active-ts/adapters/search/elasticsearch';
import { createNativeSearchAdapter } from 'active-ts/adapters/search/native';
type PackedUserData = { id: EntityId; name: string };
type PackedCommentData = { id: EntityId; parentId: EntityId; body: string; updatedAt: number };
class PackedUser extends Model<PackedUserData> {}
class PackedComment extends Model<PackedCommentData> {}

const packedParentKey: DatastoreKey = datastoreKey('packed_parent', 10);
const packedInt64Id: DatastoreInt64Id = datastoreInt64Id('9223372036854775807');
const packedSubpathInt64Id: DatastoreSubpathInt64Id = datastoreSubpathInt64Id('-9223372036854775808');
const packedInt64Decimal: string = datastoreInt64IdValue(packedInt64Id);
const packedSubpathInt64Decimal: string = datastoreSubpathInt64IdValue(packedSubpathInt64Id);
const packedInt64Check: boolean = isDatastoreInt64Id(packedSubpathInt64Id);
const packedSubpathInt64Check: boolean = isDatastoreSubpathInt64Id(packedInt64Id);
const packedCommentAncestor: DatastoreAncestorResolver<PackedCommentData> = ({ data }) =>
	data ? datastoreKey('packed_parent', data.parentId) : packedParentKey;
const packedCommentDatastore = {
	ancestor: packedCommentAncestor,
	ancestorFields: ['parentId'],
	unindexed: ['body']
} satisfies DatastoreModelMeta<PackedCommentData>;
const packedAncestorInput: DatastoreAncestorInput<PackedCommentData> = {
	model: { name: 'packed_comment', idField: 'id' },
	id: 1,
	data: { id: 1, parentId: 10, body: 'typed', updatedAt: 1 }
};
const packedResolvedAncestor: DatastoreKey | undefined = packedCommentAncestor(packedAncestorInput);

defineModel<PackedUserData>('packed_user')
  .id('id')
  .validate((input) => input as PackedUserData)
  .fieldType('name', 'string')
  .attach(PackedUser);

defineModel<PackedCommentData>({ name: 'packed_comment', store: 'datastore', search: 'memory' })
  .id('id')
  .validate((input) => input as PackedCommentData)
  .fieldType('updatedAt', 'number')
  .index('updatedAt', { name: 'by_updated_at', directions: ['desc'] })
  .search('memory', ['body'])
  .datastore(packedCommentDatastore)
  .attach(PackedComment);

const store = new MemoryStoreAdapter();
const context = createActiveTs({ stores: { default: store } });
const User = PackedUser.use(context) as typeof PackedUser;
await User.create({ id: 1, name: 'typed' });
const packedCreatedMany: PackedUser[] = await User.createMany([{ id: 2, name: 'bulk-created' }]);
const packedUpsertedMany: Array<ModelUpsertResult<PackedUser>> = await User.upsertMany([
  { id: 1, name: 'bulk-updated' },
  { id: 3, name: 'bulk-upserted' }
]);
await User.deleteMany([2, 3]);
const packedUpsertOperation: 'create' | 'update' | undefined = packedUpsertedMany[0]?.operation;
const loaded = await User.find(1).load();
const loadedName: string | undefined = loaded?.data.name;
const offsetLoadedName: string | undefined = (await User.query().offset(0).limit(1).load()).list[0]?.data.name;
const packedHistoricalQuery = User.query().readAt(new Date());
const packedEventualQuery = User.query().readConsistency('eventual');
const packedHistoricalFind = User.find(1).readAt(Date.now());
const packedCommentMeta: ResolvedModelMeta<PackedCommentData> = context.meta(PackedComment);
const packedCommentIndexYaml: string = createDatastoreIndexYaml(packedCommentMeta);
declare const packedDatastoreStore: Awaited<ReturnType<typeof createDatastoreStoreAdapter>>;
const packedDatastoreTypedStore: DatastoreStoreAdapter = packedDatastoreStore;
const packedDatastoreBulk: DatastoreBulkOperations = packedDatastoreTypedStore.bulk;
const packedDatastoreBulkOptions: DatastoreBulkMutationOptions = { chunkSize: 100 };
const packedDatastoreBulkUpsertEntry: DatastoreBulkUpsertEntry = {
	id: 1,
	data: { id: 1, parentId: 10, body: 'bulk', updatedAt: 1 }
};
const packedDatastoreBulkDeleteEntry: DatastoreBulkDeleteEntry = {
	id: 1,
	options: { meta: { datastoreAncestor: packedParentKey } }
};
const packedCommentSchemaPlan: Promise<SchemaPlan> | undefined = packedDatastoreStore.schema?.plan([packedCommentMeta]);
const testContext = createTestContext();
const activeTestContext: ActiveTestContext = testContext;
const testContextName: string = testContext.context.meta(PackedUser).name;
const contract: typeof runStoreAdapterContract = runStoreAdapterContract;
const cacheContract: typeof runCacheAdapterContract = runCacheAdapterContract;
const searchContract: typeof runSearchAdapterContract = runSearchAdapterContract;
const adapterSuite: typeof createAdapterContractSuite = createAdapterContractSuite;
const cacheSuite: typeof createCacheAdapterContractSuite = createCacheAdapterContractSuite;
const searchSuite: typeof createSearchAdapterContractSuite = createSearchAdapterContractSuite;
const harnessFactory: typeof createIntegrationHarness = createIntegrationHarness;
const withContext: typeof withTestContext = withTestContext;
const seedHelper: typeof seed = seed;
const fixtureHelper: typeof fixture = fixture;
const snapshotHelper: typeof snapshotStore = snapshotStore;
const resetHelper: typeof resetTestContext = resetTestContext;
const currentHelper: typeof getCurrentTestContext = getCurrentTestContext;
const captureHelper: typeof captureLazyLoadWarnings = captureLazyLoadWarnings;
const warningHelper: typeof expectNoLazyLoadWarnings = expectNoLazyLoadWarnings;
const datastoreFactory: typeof createDatastoreStoreAdapter = createDatastoreStoreAdapter;
const datastoreNamespaceFactory: typeof createDatastoreNamespaceStoreFactory = createDatastoreNamespaceStoreFactory;
const datastoreYamlFactory: typeof createDatastoreIndexYaml = createDatastoreIndexYaml;
const postgresFactory: typeof createPostgresStoreAdapter = createPostgresStoreAdapter;
const redisFactory: typeof createRedisValkeyCacheAdapter = createRedisValkeyCacheAdapter;
const nativeSearchFactory: typeof createNativeSearchAdapter = createNativeSearchAdapter;
const cacheAdapter: CacheAdapter = new MemoryCacheAdapter();
const searchAdapter = new MemorySearchAdapter();
const markedSearchHit = markSearchDocumentIdentity(
	{ id: 1, name: 'typed' },
	datastoreSearchDocumentIdentity({ name: 'packed_user' }, 1, datastoreKey('packed_parent', 10))
);
const customSearchAdapter: SearchAdapter = {
	kind: 'packed-custom-search',
	capabilities: { where: false, cursor: false, native: false, index: true, revisionWrites: true },
	search: async () => ({ list: [markedSearchHit] }),
	index: async () => undefined,
	delete: async () => undefined
};
const cacheCodec: CacheCodec = {
	name: 'packed-identity',
	encode: async (value) => value,
	decode: async (value) => value
};
const codecCacheAdapter: CacheAdapter = createCodecCacheAdapter(cacheAdapter, cacheCodec);
const aesCodec: CacheCodec<string | Buffer> = createAesGcmCacheCodec({ key: Buffer.alloc(32) });
const functionCacheOptions: FunctionCacheOptions<number, string> = {
	prefix: 'packed_fn',
	cache: false,
	factory: async (input) => String(input)
};
const functionCache: ActiveFunctionCache<number, string> = createFunctionCache(functionCacheOptions);
const functionCacheClass: ActiveFunctionCache<number, string> = new ActiveFunctionCache(functionCacheOptions);
const functionCacheGetOptions: FunctionCacheGetOptions = { refresh: true };
const functionCacheDiagnostics = getFunctionCacheDiagnostics();
const storeMiddleware: StoreMiddleware = async (_middlewareContext, next) => next();
const cacheMiddleware: CacheMiddleware = async (_middlewareContext, next) => next();
const searchMiddleware: SearchMiddleware = async (_middlewareContext, next) => next();
const middlewareStore: StoreAdapter = createStoreMiddlewareAdapter(store, [storeMiddleware]);
const middlewareCache: CacheAdapter = createCacheMiddlewareAdapter(cacheAdapter, [cacheMiddleware]);
const middlewareSearch: SearchAdapter = createSearchMiddlewareAdapter(customSearchAdapter, [searchMiddleware]);
const outboxEvent: OutboxEvent = {
	id: 'packed-event-1',
	model: 'packed_user',
	modelId: 1,
	modelDatastoreProjectId: 'packed-project',
	operation: 'create',
	createdAt: new Date().toISOString()
};
const normalizedOutboxEvent: OutboxEvent = normalizeOutboxEvent(outboxEvent);
const memoryOutbox = new MemoryOutboxAdapter();
const outboxAdapter: OutboxAdapter = memoryOutbox;
const outboxOptions: OutboxPluginOptions = {
	outbox: outboxAdapter,
	includeData: true,
	allowUnsafeTransactionDeferredAppend: false
};
const outboxPlugin: ActiveTsPlugin = createOutboxPlugin(outboxOptions);
const storeOutboxOptions: StoreOutboxAdapterOptions = {
	context,
	revisionModelName: 'packed_search_revision'
};
const storeOutboxInstance = new StoreOutboxAdapter(storeOutboxOptions);
const storeOutboxTransactionStore: string = storeOutboxInstance.transactionStore;
const storeOutbox: OutboxAdapter = storeOutboxInstance;
const storeOutboxSchemaApplyOptions: StoreOutboxSchemaApplyOptions = { mode: 'safe' };
const storeOutboxSchemaPlan: Promise<SchemaPlan> = storeOutboxInstance.schemaPlan();
const storeOutboxSchemaApply: Promise<SchemaPlan> = storeOutboxInstance.schemaApply(storeOutboxSchemaApplyOptions);
const searchWriteOptions: SearchWriteOptions = { revision: 1 };
const reserveSearchRevision: OutboxAdapter['reserveSearchRevision'] = storeOutbox.reserveSearchRevision;
const searchSyncWorker: typeof runSearchSyncWorker = runSearchSyncWorker;
const searchSyncOptions: SearchSyncWorkerOptions = {
	outbox: outboxAdapter,
	search: customSearchAdapter,
	models: [PackedUser],
	allowUnsafeDrainFallback: false,
	allowUnsafeUnfencedSearchWrites: false
};
const broadLeaseSearchSyncOptions: SearchSyncWorkerOptions = {
	outbox: storeOutbox,
	search: customSearchAdapter,
	models: [PackedUser]
};
const memorySearchSyncOptions: SearchSyncWorkerOptions<typeof memoryOutbox> = {
	outbox: memoryOutbox,
	search: customSearchAdapter,
	models: [PackedUser]
};
const storeSearchSyncOptions: SearchSyncWorkerOptions<typeof storeOutboxInstance> = {
	outbox: storeOutboxInstance,
	search: customSearchAdapter,
	models: [PackedUser],
	context
};
const storeSearchSyncWithoutContext = {
	outbox: storeOutboxInstance,
	search: customSearchAdapter,
	models: [PackedUser]
};
// @ts-expect-error Concrete lease outboxes require context for durable repair reconciliation.
const invalidStoreSearchSyncOptions: SearchSyncWorkerOptions<typeof storeOutboxInstance> = storeSearchSyncWithoutContext;
const softDeleteOptions: SoftDeleteOptions = { field: 'deletedAt', materializedNulls: true };
const softDeletePlugin: ActiveTsPlugin = createSoftDeletePlugin(softDeleteOptions);
const softDeleteHelper: typeof softDelete = softDelete;
const restoreHelper: typeof restore = restore;
const typiaValidator: Validator<PackedUserData> = fromTypia((input) => input as PackedUserData);
const zodValidator: Validator<PackedUserData> = fromZod({ parse: (input) => input as PackedUserData });
const valibotValidator: Validator<PackedUserData> = fromValibot({}, {
	parse: (_schema, input) => input as PackedUserData
});
const arkTypeOptions: ArkTypeAdapterOptions = { isProblem: (value) => value === 'problem' };
const arkTypeValidator: Validator<PackedUserData> = fromArkType((input) => input as PackedUserData, arkTypeOptions);
const contractRows: StoreContractModel[] = [{ id: 1, name: 'typed', score: 10 }];
const testOptions: TestContextOptions = { lazyLoadWarnings: 'capture' };
const storeContractOptions: StoreAdapterContractOptions = {
	nativeProbe: async ({ adapter, model }) => {
		await adapter.query(model, {
			native: { payload: (input: { model: { name: string } }) => input.model.name },
			where: [],
			or: [],
			sort: [],
			include: []
		});
	}
};
const searchContractOptions: SearchAdapterContractOptions = {
	settleMs: 1,
	pollIntervalMs: 1,
	nativeProbe: async ({ adapter, model }) => {
		await adapter.search({ ...model, searchIndexes: [] }, 'ignored', { native: { query: {} } });
	}
};
const storeSuite: AdapterContractSuite = { memory: new MemoryStoreAdapter() };
const cacheContractSuite: CacheAdapterContractSuite = {};
const searchContractSuite: SearchAdapterContractSuite = {};
const integrationHarness: IntegrationHarness = {
  name: 'packed',
  start: async () => ({}),
  stop: async () => undefined,
  createStore: async () => new MemoryStoreAdapter()
};
const createdIntegrationHarness: IntegrationHarnessApi = createIntegrationHarness(integrationHarness);
const integrationContextHandle: IntegrationHarnessContextHandle = await createdIntegrationHarness.createContext();
await integrationContextHandle.close();
await createdIntegrationHarness.runStoreContract(storeContractOptions);
const postgresOptions = { connectionString: 'postgres://localhost/active_ts' } satisfies PostgresStoreOptions;
const mongoOptions = {
	dbName: 'active_ts',
	cacheScope: 'mongodb|cluster=primary|db=active_ts',
	allowAggregateScanFallback: true
} satisfies MongoStoreOptions;
const mongoTransactionNativeOptions = {
	readConcern: { level: 'snapshot' },
	writeConcern: { w: 'majority' },
	readPreference: 'primary',
	maxCommitTimeMS: 1_000
} satisfies MongoTransactionNativeOptions;
const mongoTransactionOptions = {
	readOnly: false,
	timeoutMs: 2_000,
	native: mongoTransactionNativeOptions
} satisfies MongoStoreTransactionOptions;
declare const packedMongoStore: Awaited<ReturnType<typeof createMongoStoreAdapter>>;
const packedTypedMongoStore: MongoStoreAdapter = packedMongoStore;
const packedGenericMongoStore: StoreAdapter = packedMongoStore;
const packedMongoTransaction = packedMongoStore.transaction?.(async (transactionStore) => {
	const genericTransactionStore: StoreAdapter = transactionStore;
	return genericTransactionStore.kind;
}, mongoTransactionOptions);
// @ts-expect-error MongoDB does not accept the portable isolation option.
packedMongoStore.transaction?.(async () => undefined, { isolation: 'serializable' });
// @ts-expect-error MongoDB driver transaction options reject unknown read-concern levels.
packedMongoStore.transaction?.(async () => undefined, { native: { readConcern: { level: 'invalid' } } });
// @ts-expect-error MongoDB transaction native options reject unrelated client options.
packedMongoStore.transaction?.(async () => undefined, { native: { retryWrites: true } });
declare const packedUnknownOutcome: ActiveTsUnknownTransactionOutcomeError;
const packedUnknownOutcomeValue: 'unknown' = packedUnknownOutcome.outcome;
const packedUnknownOutcomePhase: 'commit' | 'abort' = packedUnknownOutcome.phase;
const datastoreOptions = {
	namespace: 'active-ts',
	keyEncoding: 'native',
	allowAggregateScanFallback: true,
	allowQueryScanFallback: true,
	requireAncestorTransactionQueries: true
} satisfies DatastoreStoreOptions;
const defaultDatastoreOptions = { namespace: undefined } satisfies DatastoreStoreOptions;
const datastoreNamespaceFactoryOptions = {
	client: {},
	cacheScopePrefix: 'project=packed'
} satisfies DatastoreNamespaceStoreFactoryOptions;
const datastoreNamespaceFactoryPromise: Promise<DatastoreNamespaceStoreFactory> =
	createDatastoreNamespaceStoreFactory(datastoreNamespaceFactoryOptions);
declare const packedDatastoreNamespaceFactory: DatastoreNamespaceStoreFactory;
const packedNamespaceStorePromise: Promise<StoreAdapter> = packedDatastoreNamespaceFactory.forNamespace('packed');
const packedDefaultNamespaceStorePromise: Promise<StoreAdapter> = packedDatastoreNamespaceFactory.forNamespace();
// @ts-expect-error namespace selection belongs to forNamespace().
const invalidDatastoreNamespaceFactoryOptions: DatastoreNamespaceStoreFactoryOptions = { namespace: 'fixed' };
const datastoreKeyEncoding: DatastoreKeyEncoding = 'native';
const datastoreInventoryOptions = {
	client: {
		createQuery: () => ({ limit() { return this; } }),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	},
	kind: 'packed_user',
	onIssue: (issue: DatastoreIdInventoryIssue) => void issue
} satisfies DatastoreIdInventoryOptions;
const datastoreInventoryReport: Promise<DatastoreIdInventoryReport> = inventoryDatastoreIds(
	datastoreInventoryOptions
);
const datastoreRepairPolicy: DatastoreIdRepairPolicy = 'key-wins';
const datastoreRepairDescendantPolicy: DatastoreIdRepairDescendantPolicy = 'verified-none';
const datastoreRepairPlanOptions = {
	report: {
		inventoryId: '123e4567-e89b-42d3-a456-426614174000',
		issueDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		kind: 'packed_user',
		idField: 'id',
		scanned: 0,
		pages: 1,
		counts: {
			match: 0,
			'type-mismatch': 0,
			'value-mismatch': 0,
			'missing-payload-id': 0,
			'invalid-payload-id': 0,
			'unsupported-key': 0
		}
	},
	issues: [],
	target: 'gcp:packed/(default)',
	policy: datastoreRepairPolicy,
	excludeFromIndexes: ['body']
} satisfies DatastoreIdRepairPlanOptions;
const datastoreRepairManifest: DatastoreIdRepairManifest =
	createDatastoreIdRepairManifest(datastoreRepairPlanOptions);
const datastoreRepairApplyOptions = {
	client: {},
	manifest: datastoreRepairManifest,
	target: datastoreRepairManifest.target,
	confirm: datastoreRepairManifest.digest
} satisfies DatastoreIdRepairApplyOptions;
const datastoreRepairApplyPromise: Promise<DatastoreIdRepairApplyReport> =
	applyDatastoreIdRepairManifest(datastoreRepairApplyOptions);
void datastoreRepairApplyPromise;
void datastoreRepairDescendantPolicy;
const packedAncestorOptions = datastoreAncestorOptions(packedParentKey);
const packedAncestorReadOptions: DatastoreAncestorReadOptions = packedAncestorOptions;
const packedAncestorWriteOptions: DatastoreAncestorWriteOptions = packedAncestorOptions;
const packedReadPolicy: DatastoreReadPolicy = { readTime: Date.now() };
const packedReadOptions: DatastoreReadOptions = datastoreReadOptions({
	readTime: new Date(),
	ancestor: packedParentKey
});
const datastoreTransactionNative = {
	gaxOptions: { timeout: 1000 },
	commitGaxOptions: { timeout: 2000 }
} satisfies DatastoreTransactionNativeOptions;
const datastoreStoreTxOptions = {
	native: datastoreTransactionNative
} satisfies DatastoreStoreTransactionOptions;
const datastoreContextTransactionOptions = {
	store: 'default',
	native: datastoreTransactionNative
} satisfies DatastoreTransactionOptions;
const datastoreModelTxOptions = datastoreModelTransactionOptions({
	native: datastoreTransactionNative
}) satisfies DatastoreModelTransactionOptions;
const datastoreStoreTxHelperOptions = datastoreStoreTransactionOptions({
	native: datastoreTransactionNative
});
const datastoreContextTxHelperOptions = datastoreTransactionOptions({
	store: 'default',
	native: datastoreTransactionNative
});
const firestoreOptions = {
	firestoreOptions: { projectId: 'active-ts' },
	allowAggregateScanFallback: true
} satisfies FirestoreStoreOptions;
const firestoreTransactionNative = { maxAttempts: 3 } satisfies FirestoreTransactionNativeOptions;
const redisOptions = { prefix: 'active-ts' } satisfies RedisValkeyOptions;
const algoliaOptions = { indexPrefix: 'active_ts' } satisfies AlgoliaOptions;
const elasticsearchOptions = {
	indexPrefix: 'active_ts',
	requireRevisionWrites: true
} satisfies ElasticsearchOptions;
const noInternalTracker: 'trackTransactionModelInstance' extends keyof ActiveContext ? never : true = true;
const noInternalStore: 'internalStore' extends keyof ActiveContext ? never : true = true;
const noInternalCache: 'internalCache' extends keyof ActiveContext ? never : true = true;
const noInternalSearch: 'internalSearchAdapter' extends keyof ActiveContext ? never : true = true;
void loadedName;
void offsetLoadedName;
void packedCommentMeta;
void packedCommentIndexYaml;
void packedCommentSchemaPlan;
void packedCommentDatastore;
void packedAncestorInput;
void packedResolvedAncestor;
void testContextName;
void activeTestContext;
void noInternalTracker;
void noInternalStore;
void noInternalCache;
void noInternalSearch;
void contract;
void cacheContract;
void searchContract;
void adapterSuite;
void cacheSuite;
void searchSuite;
void harnessFactory;
void withContext;
void seedHelper;
void fixtureHelper;
void snapshotHelper;
void resetHelper;
void currentHelper;
void captureHelper;
void warningHelper;
void datastoreFactory;
void datastoreNamespaceFactory;
void datastoreYamlFactory;
void postgresFactory;
void redisFactory;
void nativeSearchFactory;
void cacheAdapter;
void searchAdapter;
void customSearchAdapter;
void markedSearchHit;
void cacheCodec;
void codecCacheAdapter;
void aesCodec;
void functionCache;
void functionCacheClass;
void functionCacheGetOptions;
void functionCacheDiagnostics;
void storeMiddleware;
void cacheMiddleware;
void searchMiddleware;
void middlewareStore;
void middlewareCache;
void middlewareSearch;
void normalizedOutboxEvent;
void storeOutboxTransactionStore;
void outboxEvent;
void outboxAdapter;
void outboxOptions;
void outboxPlugin;
void storeOutboxOptions;
void storeOutbox;
void searchWriteOptions;
void reserveSearchRevision;
void searchSyncWorker;
void searchSyncOptions;
void softDeleteOptions;
void softDeletePlugin;
void softDeleteHelper;
void restoreHelper;
void typiaValidator;
void zodValidator;
void valibotValidator;
void arkTypeOptions;
void arkTypeValidator;
void contractRows;
void testOptions;
void storeContractOptions;
void searchContractOptions;
void storeSuite;
void cacheContractSuite;
void searchContractSuite;
void integrationHarness;
void createdIntegrationHarness;
void integrationContextHandle;
void postgresOptions;
void mongoOptions;
void packedTypedMongoStore;
void packedGenericMongoStore;
void packedMongoTransaction;
void packedUnknownOutcomeValue;
void packedUnknownOutcomePhase;
void datastoreOptions;
void datastoreNamespaceFactoryOptions;
void datastoreNamespaceFactoryPromise;
void packedNamespaceStorePromise;
void invalidDatastoreNamespaceFactoryOptions;
void datastoreKeyEncoding;
void packedInt64Id;
void packedSubpathInt64Id;
void packedInt64Decimal;
void packedSubpathInt64Decimal;
void packedInt64Check;
void packedSubpathInt64Check;
void packedParentKey;
void packedAncestorOptions;
void packedAncestorReadOptions;
void packedAncestorWriteOptions;
void packedReadPolicy;
void packedReadOptions;
void packedHistoricalQuery;
void packedEventualQuery;
void packedHistoricalFind;
void packedCreatedMany;
void packedUpsertOperation;
void datastoreTransactionNative;
void datastoreStoreTxOptions;
void datastoreContextTransactionOptions;
void datastoreModelTxOptions;
void datastoreStoreTxHelperOptions;
void datastoreContextTxHelperOptions;
void firestoreOptions;
void firestoreTransactionNative;
void redisOptions;
void algoliaOptions;
void elasticsearchOptions;
`
	);
	await exec(path.join(installDir, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], { cwd: installDir });
	await writeFile(
		path.join(installDir, 'smoke.mjs'),
		`
import assert from 'node:assert/strict';
import * as activeTs from 'active-ts';
import {
  createActiveTs,
  datastoreInt64Id,
  datastoreInt64IdValue,
  datastoreKey,
  datastoreReadOptions,
  defineModel,
  isDatastoreInt64Id,
  MemoryStoreAdapter,
  Model
} from 'active-ts';
import { createTestContext } from 'active-ts/testing';
import {
  createDatastoreIdRepairManifest,
  createDatastoreIndexYaml,
  createDatastoreNamespaceStoreFactory,
  createDatastoreStoreAdapter,
  datastoreInt64Id as datastoreSubpathInt64Id,
  datastoreInt64IdValue as datastoreSubpathInt64IdValue,
  inventoryDatastoreIds,
  isDatastoreInt64Id as isDatastoreSubpathInt64Id
} from 'active-ts/adapters/store/datastore';
import { createPostgresStoreAdapter } from 'active-ts/adapters/store/postgresql';
import { createRedisValkeyCacheAdapter } from 'active-ts/adapters/cache/redis-valkey';
import { createNativeSearchAdapter } from 'active-ts/adapters/search/native';

assert.equal('createTestContext' in activeTs, false);
assert.deepEqual(Object.keys(activeTs).sort(), ${JSON.stringify(PUBLIC_ROOT_RUNTIME_EXPORTS, null, 2)});

class PackedUser extends Model {}
class PackedComment extends Model {}

defineModel('packed_user')
  .id('id')
  .validate((input) => input)
  .fieldType('name', 'string')
  .attach(PackedUser);

const packedInt64Id = datastoreInt64Id('9223372036854775807');
const packedSubpathInt64Id = datastoreSubpathInt64Id('-9223372036854775808');
assert.equal(isDatastoreInt64Id(packedInt64Id), true);
assert.equal(isDatastoreSubpathInt64Id(packedSubpathInt64Id), true);
assert.equal(datastoreInt64IdValue(packedInt64Id), '9223372036854775807');
assert.equal(datastoreSubpathInt64IdValue(packedSubpathInt64Id), '-9223372036854775808');

defineModel({ name: 'packed_comment', store: 'datastore' })
  .id('id')
  .validate((input) => input)
  .fieldType('updatedAt', 'number')
  .index('updatedAt', { name: 'by_updated_at', directions: ['desc'] })
  .datastore({
    ancestor: ({ data }) => data ? datastoreKey('packed_parent', data.parentId) : datastoreKey('packed_parent', 10),
    ancestorFields: ['parentId'],
    unindexed: ['body']
  })
  .attach(PackedComment);

const store = new MemoryStoreAdapter();
const context = createActiveTs({ stores: { default: store } });
const User = PackedUser.use(context);
await User.create({ id: 1, name: 'installed' });
const installedCreatedMany = await User.createMany([{ id: 2, name: 'bulk-created' }]);
const installedUpsertedMany = await User.upsertMany([
  { id: 1, name: 'bulk-updated' },
  { id: 3, name: 'bulk-upserted' }
]);
await User.deleteMany([2, 3]);
assert.equal(installedCreatedMany[0].data.name, 'bulk-created');
assert.deepEqual(installedUpsertedMany.map((result) => result.operation), ['update', 'create']);
assert.equal((await User.find(1).load()).data.name, 'bulk-updated');
assert.equal((await User.query().offset(0).limit(1).load()).list[0].data.name, 'bulk-updated');
assert.equal(createTestContext().context.meta(PackedUser).name, 'packed_user');
const commentMeta = context.meta(PackedComment);
const commentIndexYaml = createDatastoreIndexYaml(commentMeta);
assert.match(commentIndexYaml, /ancestor: yes/);
assert.match(commentIndexYaml, /name: "updatedAt"/);
assert.equal(commentMeta.datastore.ancestor({
  model: commentMeta,
  id: 1,
  data: { id: 1, parentId: 10, body: 'runtime', updatedAt: 1 }
}).path[0].kind, 'packed_parent');
assert.deepEqual(commentMeta.datastore.ancestorFields, ['parentId']);
assert.deepEqual(commentMeta.datastore.unindexed, ['body']);
assert.equal(typeof createDatastoreIndexYaml, 'function');
assert.equal(typeof createDatastoreNamespaceStoreFactory, 'function');
const packedDatastoreSelects = [];
const packedDatastoreQuery = {
  hasAncestor() { return this; },
  filter(field, operator, value) {
    packedDatastoreFilters.push({ field, operator, value });
    return this;
  },
  order() { return this; },
  offset(value) {
    packedDatastoreOffsets.push(value);
    return this;
  },
  limit() { return this; },
  start(cursor) {
    packedDatastoreStarts.push(cursor);
    return this;
  },
  select(fields) {
    packedDatastoreSelects.push(fields);
    return this;
  }
};
const packedDatastoreFilters = [];
const packedDatastoreOffsets = [];
const packedDatastoreStarts = [];
let packedDatastoreResponse = [
  [{ id: 1, name: 'packed', profile: { city: 'Seoul' } }],
  { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'packed-sdk-cursor' }
];
let packedDatastoreSdkReadOptions;
const packedDatastoreBulkUpserts = [];
const packedDatastoreBulkDeletes = [];
const packedDatastoreKeySymbol = Symbol('packed-datastore-key');
const packedDatastoreClient = {
	options: { projectId: 'packed-project' },
	getDatabaseId: () => 'custom-database',
  key: (input) => ({ input }),
  get: async () => [null],
  delete: async (keys) => { packedDatastoreBulkDeletes.push(keys); },
  save: async (entities) => { packedDatastoreBulkUpserts.push(entities); },
  createQuery: () => packedDatastoreQuery,
  runQuery: async (_query, options) => {
    packedDatastoreSdkReadOptions = options;
    return packedDatastoreResponse;
  },
  update: async () => undefined
};
const injectedDatastoreStore = await createDatastoreStoreAdapter({
  keySymbol: packedDatastoreKeySymbol,
  namespace: 'packed',
  client: packedDatastoreClient
});
const packedNamespaceFactory = await createDatastoreNamespaceStoreFactory({
  client: packedDatastoreClient,
  keySymbol: packedDatastoreKeySymbol,
  cacheScopePrefix: 'datastore|project=packed'
});
const packedAlphaStore = await packedNamespaceFactory.forNamespace('alpha');
const packedBetaStore = await packedNamespaceFactory.forNamespace('beta');
const packedRootStore = await packedNamespaceFactory.forNamespace();
assert.equal(Object.isFrozen(packedNamespaceFactory), true);
assert.equal(packedAlphaStore.datastoreNamespace, 'alpha');
assert.equal(packedBetaStore.datastoreNamespace, 'beta');
assert.equal(packedRootStore.datastoreNamespace, undefined);
assert.equal(packedAlphaStore.datastoreProjectId, 'packed-project');
assert.equal(packedRootStore.datastoreProjectId, 'packed-project');
assert.equal(packedAlphaStore.datastoreDatabaseId, 'custom-database');
assert.equal(packedRootStore.datastoreDatabaseId, 'custom-database');
assert.equal(packedAlphaStore.datastoreKeyEncoding, 'active-ts');
assert.equal(packedRootStore.datastoreKeyEncoding, 'active-ts');
assert.notEqual(packedAlphaStore.cacheScope, packedBetaStore.cacheScope);
assert.notEqual(packedAlphaStore.cacheScope, packedRootStore.cacheScope);
assert.equal(
  (await packedNamespaceFactory.forNamespace('alpha')).cacheScope,
  packedAlphaStore.cacheScope
);
assert.equal(
  (await packedNamespaceFactory.forNamespace()).cacheScope,
  packedRootStore.cacheScope
);
const packedInventory = await inventoryDatastoreIds({
  client: {
    createQuery: () => packedDatastoreQuery,
    runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
  },
  keySymbol: Symbol('packed-inventory-key'),
  kind: 'packed_user'
});
assert.equal(packedInventory.scanned, 0);
assert.equal(packedInventory.counts.match, 0);
assert.equal(packedInventory.namespace, undefined);
assert.equal(
  packedInventory.issueDigest,
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
);
const packedRepairManifest = createDatastoreIdRepairManifest({
  report: packedInventory,
  issues: [],
  target: 'gcp:packed-smoke/(default)',
  policy: 'key-wins',
  excludeFromIndexes: []
});
assert.equal(packedRepairManifest.format, 'active-ts/datastore-id-repair');
assert.equal(packedRepairManifest.operations.length, 0);
assert.equal(Object.hasOwn(packedRepairManifest, 'namespace'), false);
assert.match(packedRepairManifest.digest, /^sha256:[0-9a-f]{64}$/);
assert.equal(injectedDatastoreStore.kind, 'datastore');
assert.equal(injectedDatastoreStore.datastoreNamespace, 'packed');
assert.equal(injectedDatastoreStore.datastoreProjectId, 'packed-project');
assert.equal(injectedDatastoreStore.datastoreDatabaseId, 'custom-database');
assert.equal(injectedDatastoreStore.datastoreKeyEncoding, 'active-ts');
assert.equal(injectedDatastoreStore.capabilities.datastoreAncestor, true);
assert.equal(injectedDatastoreStore.capabilities.datastoreReadPolicy, true);
assert.equal(injectedDatastoreStore.capabilities.transaction, false);
assert.equal(injectedDatastoreStore.capabilities.cursor, true);
assert.equal(injectedDatastoreStore.capabilities.offset, true);
assert.equal(injectedDatastoreStore.capabilities.nestedFields, true);
assert.equal(Object.isFrozen(injectedDatastoreStore.bulk), true);
await injectedDatastoreStore.bulk.upsertMany(context.meta(PackedUser), [
  { id: 4, data: { id: 4, name: 'bulk-packed' } }
]);
await injectedDatastoreStore.bulk.deleteMany(context.meta(PackedUser), [4]);
assert.deepEqual(packedDatastoreBulkUpserts[0][0].key.input, {
  path: ['packed_user', 'number:4'],
  namespace: 'packed'
});
assert.deepEqual(packedDatastoreBulkDeletes[0][0].input, {
  path: ['packed_user', 'number:4'],
  namespace: 'packed'
});
const packedDatastorePage = await injectedDatastoreStore.query(context.meta(PackedUser), {
  where: [{ field: 'name', op: '=', value: 'packed' }],
  or: [],
  sort: [],
  include: [],
  select: ['profile.city'],
  limit: 1
});
assert.equal(packedDatastorePage.more, true);
assert.equal(typeof packedDatastorePage.cursor, 'string');
assert.deepEqual(packedDatastorePage.list, [{ id: 1, profile: { city: 'Seoul' } }]);
packedDatastoreResponse = [[], { moreResults: 'NO_MORE_RESULTS' }];
const packedDatastoreNextPage = await injectedDatastoreStore.query(context.meta(PackedUser), {
  where: [{ field: 'name', op: '=', value: 'packed' }],
  or: [],
  sort: [],
  include: [],
  select: ['profile.city'],
  limit: 1,
  cursor: packedDatastorePage.cursor
});
assert.equal(packedDatastoreNextPage.more, false);
assert.deepEqual(packedDatastoreFilters, [
  { field: 'name', operator: '=', value: 'packed' },
  { field: 'name', operator: '=', value: 'packed' }
]);
assert.deepEqual(packedDatastoreStarts, ['packed-sdk-cursor']);
await injectedDatastoreStore.query(context.meta(PackedUser), {
  where: [],
  or: [],
  sort: [],
  include: [],
  meta: { datastoreRead: { readTime: 1700000000000 } }
});
assert.deepEqual(packedDatastoreSdkReadOptions, { readTime: 1700000000000 });
packedDatastoreResponse = [
  [{ id: 2, name: 'offset', profile: { city: 'Busan' } }],
  { moreResults: 'NO_MORE_RESULTS' }
];
const packedDatastoreOffsetPage = await injectedDatastoreStore.query(context.meta(PackedUser), {
  where: [],
  or: [],
  sort: [],
  include: [],
  offset: 1,
  limit: 1
});
assert.deepEqual(packedDatastoreOffsetPage.list, [{ id: 2, name: 'offset', profile: { city: 'Busan' } }]);
assert.deepEqual(packedDatastoreOffsets, [1]);
packedDatastoreResponse = [
  [{ id: 3, name: 'key-only-fallback' }],
  { moreResults: 'NO_MORE_RESULTS' }
];
const packedKeyOnlyPage = await injectedDatastoreStore.query(context.meta(PackedUser), {
  where: [],
  or: [],
  sort: [],
  include: [],
  select: ['id']
});
assert.deepEqual(packedKeyOnlyPage.list, [{ id: 3 }]);
assert.deepEqual(packedDatastoreSelects, ['__key__']);
const packedFallbackDatastoreStore = await createDatastoreStoreAdapter({ client: packedDatastoreClient });
const packedFallbackKeyOnlyPage = await packedFallbackDatastoreStore.query(context.meta(PackedUser), {
  where: [],
  or: [],
  sort: [],
  include: [],
  select: ['id']
});
assert.deepEqual(packedFallbackKeyOnlyPage.list, [{ id: 3 }]);
assert.deepEqual(packedDatastoreSelects, ['__key__']);
const injectedDatastoreSchemaPlan = await injectedDatastoreStore.schema.plan([commentMeta]);
assert.equal(injectedDatastoreSchemaPlan.adapter, 'datastore');
assert.equal(injectedDatastoreSchemaPlan.status, 'manual');
assert.equal(injectedDatastoreSchemaPlan.changes.length > 0, true);
assert.equal(typeof createPostgresStoreAdapter, 'function');
assert.equal(typeof createRedisValkeyCacheAdapter, 'function');
assert.equal(typeof createNativeSearchAdapter, 'function');
assert.equal(typeof activeTs.markSearchDocumentIdentity, 'function');
assert.equal(typeof activeTs.datastoreSearchDocumentIdentity, 'function');
assert.equal(activeTs.datastoreAncestorOptions(datastoreKey('packed_parent', 10)).meta.datastoreAncestor.path[0].kind, 'packed_parent');
assert.deepEqual(datastoreReadOptions({ consistency: 'eventual' }).meta.datastoreRead, { consistency: 'eventual' });
assert.equal(activeTs.markSearchDocumentIdentity(
  { id: 1 },
  activeTs.datastoreSearchDocumentIdentity({ name: 'packed_user' }, 1, datastoreKey('packed_parent', 10))
).id, 1);
const publicSubpaths = ${JSON.stringify(installedPublicSubpathSmokeExports(), null, 2)};
for (const [specifier, names] of Object.entries(publicSubpaths)) {
  const mod = await import(specifier);
  for (const name of names) {
    assert.equal(typeof mod[name], 'function', specifier + ' must export ' + name);
  }
}
const noPeerFactoryValidationCases = [
  ['active-ts/adapters/store/datastore', 'createDatastoreStoreAdapter', { namespace: 'bad\\0namespace' }, /namespace/],
  ['active-ts/adapters/store/datastore', 'createDatastoreStoreAdapter', { namespace: '' }, /namespace must be a non-empty string/],
  ['active-ts/adapters/store/datastore', 'createDatastoreStoreAdapter', { namespace: 'packed', datastoreOptions: { namespace: '' } }, /namespace must be a non-empty string/],
  ['active-ts/adapters/store/datastore', 'createDatastoreNamespaceStoreFactory', { namespace: 'fixed' }, /namespace/],
  ['active-ts/adapters/store/firestore', 'createFirestoreStoreAdapter', { aggregateField: 1 }, /aggregateField/],
  ['active-ts/adapters/store/mongodb', 'createMongoStoreAdapter', {}, /dbName/],
  ['active-ts/adapters/store/postgresql', 'createPostgresStoreAdapter', { schema: '' }, /schema/],
  ['active-ts/adapters/cache/redis-valkey', 'createRedisValkeyCacheAdapter', { url: 1 }, /url/],
  ['active-ts/adapters/search/algolia', 'createAlgoliaSearchAdapter', {}, /appId/],
  ['active-ts/adapters/search/elasticsearch', 'createElasticsearchSearchAdapter', {}, /node/]
];
for (const [specifier, factoryName, options, message] of noPeerFactoryValidationCases) {
  const mod = await import(specifier);
  await assert.rejects(() => mod[factoryName](options), message);
}
await assert.rejects(
  () => import('active-ts/adapters/store/google-query-constraints'),
  (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
);
`
	);
	await exec('node', ['smoke.mjs'], { cwd: installDir });
	const bin = path.join(installDir, 'node_modules', '.bin', 'active-ts');
	const help = await exec(bin, [], { cwd: installDir });
	assert.match(help.stdout, /active-ts/);
	assert.match(help.stdout, /schema diff/);
	const cliConfig = path.join(installDir, 'active-ts.config.mjs');
	await writeFile(
		cliConfig,
		`
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from 'active-ts';

class PackedCliRecord extends Model {}

defineModel('packed_cli_record')
  .id('id')
  .index('name', { name: 'by_name' })
  .validate((input) => input)
  .attach(PackedCliRecord);

export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
export const models = [PackedCliRecord];
`
	);
	const diff = await exec(bin, ['schema', 'diff', '--config', cliConfig, '--name', 'pack_smoke_cli'], {
		cwd: installDir
	});
	assert.match(diff.stdout, /packed_cli_record/);
	assert.equal(diff.stderr, '');

assert.ok(packageJson.files.includes('build/src'));
assert.ok(packageJson.files.includes('src'));
await readFile(path.join(installDir, 'node_modules', 'active-ts', 'src', 'index.ts'), 'utf8');
} finally {
	await rm(temp, { recursive: true, force: true });
}

function installedPublicSubpathSmokeExports() {
	return Object.fromEntries(
		Object.entries(PUBLIC_SUBPATH_SMOKE_EXPORTS).map(([subpath, names]) => [
			`active-ts${subpath.slice(1)}`,
			names
		])
	);
}

async function assertPackedMarkdownLinksResolve(rootDir, packedPaths, markdownFiles) {
	const missing = [];
	for (const file of markdownFiles) {
		if (!packedPaths.has(file)) continue;
		const content = await readFile(path.join(rootDir, file), 'utf8');
		const links = content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
		for (const match of links) {
			const target = match[1].trim();
			if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('mailto:')) continue;
			const withoutFragment = target.split('#')[0].split('?')[0];
			if (!withoutFragment || !withoutFragment.endsWith('.md')) continue;
			const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), withoutFragment));
			if (!packedPaths.has(resolved)) missing.push(`${file} -> ${target}`);
		}
	}
	assert.deepEqual(missing, []);
}

async function assertPackedFilesAvoidSecrets(rootDir, files) {
	const matches = [];
	for (const file of files) {
		if (!isPackedTextFile(file.path)) continue;
		const content = await readFile(path.join(rootDir, file.path), 'utf8');
		matches.push(...scanTextForForbiddenSecrets(content, file.path));
	}
	assert.deepEqual(matches, []);
}

async function assertPackedSourceMapsResolve(rootDir, packedPaths) {
	const issues = [];
	for (const file of packedPaths) {
		if (!file.startsWith('build/src/') || !file.endsWith('.map')) continue;
		const sourceMap = JSON.parse(await readFile(path.join(rootDir, file), 'utf8'));
		if ('sourcesContent' in sourceMap) issues.push(`${file}: must not embed sourcesContent`);
		if (!Array.isArray(sourceMap.sources)) {
			issues.push(`${file}: sources must be an array`);
			continue;
		}
		for (const source of sourceMap.sources) {
			if (typeof source !== 'string') {
				issues.push(`${file}: source must be a string`);
				continue;
			}
			if (source.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(source)) {
				issues.push(`${file}: source ${source} must be relative`);
				continue;
			}
			const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
			if (!normalized.startsWith('src/')) issues.push(`${file}: source ${source} resolves outside src`);
			if (!packedPaths.has(normalized)) issues.push(`${file}: source ${source} resolves to missing ${normalized}`);
		}
	}
	assert.deepEqual(issues, []);
}

function isPackedTextFile(filePath) {
	const extension = path.extname(filePath);
	return (
		['.js', '.json', '.map', '.md', '.mjs', '.ts', '.txt'].includes(extension) ||
		['CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md'].includes(path.basename(filePath))
	);
}

function assertPackedPackageTargetsExist(packageJson, packedPaths) {
	const targets = new Set();
	addPackageTarget(targets, packageJson.main);
	addPackageTarget(targets, packageJson.types);
	for (const value of Object.values(packageJson.bin ?? {})) addPackageTarget(targets, value);
	for (const value of Object.values(packageJson.exports ?? {})) addExportTargets(targets, value);
	const missing = [...targets].filter((target) => !packedPaths.has(target)).sort();
	assert.deepEqual(missing, []);
}

function assertPackageExportsAreStable(packageJson, packedPaths) {
	const expectedExportNames = ['.', ...Object.keys(PUBLIC_SUBPATH_SMOKE_EXPORTS)].sort();
	const actualExportNames = Object.keys(packageJson.exports ?? {}).sort();
	assert.deepEqual(actualExportNames, expectedExportNames);
	for (const [subpath, value] of Object.entries(packageJson.exports ?? {})) {
		assert.equal(value && typeof value === 'object' && !Array.isArray(value), true, `${subpath} export must be an object`);
		assert.deepEqual(Object.keys(value).sort(), ['import', 'types'], `${subpath} export conditions`);
		const importTarget = packageTargetPath(value.import);
		const typesTarget = packageTargetPath(value.types);
		assert.match(importTarget, /^build\/src\/.+\.js$/, `${subpath} import target must be built JavaScript`);
		assert.match(typesTarget, /^build\/src\/.+\.d\.ts$/, `${subpath} types target must be built declarations`);
		assert.equal(importTarget.slice(0, -'.js'.length), typesTarget.slice(0, -'.d.ts'.length), `${subpath} import/types target stem`);
		assert.equal(packedPaths.has(importTarget), true, `${subpath} import target must be packed`);
		assert.equal(packedPaths.has(typesTarget), true, `${subpath} types target must be packed`);
	}
}

function assertPackedPathsStayInAllowedSurface(packedPaths) {
	const disallowed = [...packedPaths].filter((file) =>
		/^(build\/test|build\/examples|test|examples|\.github)\//.test(file) ||
		['docs/risk-register.md', 'docs/risk-register-archive.md', 'pnpm-lock.yaml'].includes(file)
	);
	const outsideAllowedSurface = [...packedPaths].filter((file) => !isAllowedPackedPath(file));
	assert.deepEqual(disallowed.sort(), []);
	assert.deepEqual(outsideAllowedSurface.sort(), []);
}

function isAllowedPackedPath(file) {
	return (
		file === 'package.json' ||
		['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md'].includes(file) ||
		file.startsWith('build/src/') ||
		file.startsWith('src/') ||
		[
			'docs/adapters.md',
			'docs/concepts.md',
			'docs/extensions.md',
			'docs/plugins.md',
			'docs/quickstart.md',
			'docs/security.md',
			'docs/testing.md'
		].includes(file)
	);
}

function addExportTargets(targets, value) {
	if (typeof value === 'string') {
		addPackageTarget(targets, value);
		return;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return;
	for (const nested of Object.values(value)) addExportTargets(targets, nested);
}

function addPackageTarget(targets, value) {
	if (typeof value !== 'string') return;
	targets.add(packageTargetPath(value));
}

function packageTargetPath(value) {
	assert.equal(typeof value, 'string');
	return value.replace(/^\.\//, '');
}

function packJsonFromStdout(stdout) {
	const start = stdout.lastIndexOf('\n[');
	if (start >= 0) return stdout.slice(start + 1);
	const trimmed = stdout.trimStart();
	if (trimmed.startsWith('[')) return trimmed;
	throw new Error(`npm pack did not print JSON output: ${stdout.slice(0, 200)}`);
}
