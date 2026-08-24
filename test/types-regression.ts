import {
	assertContextBoundCacheAdapter,
	assertContextBoundSearchAdapter,
	assertContextBoundStoreAdapter,
	createActiveTs,
	datastoreAncestorOptions,
	datastoreReadOptions,
	datastoreKey,
	isContextBoundCacheAdapter,
	isContextBoundSearchAdapter,
	isContextBoundStoreAdapter,
	MemoryStoreAdapter,
	Model,
	defineModel,
	type ActiveContext,
	type ActiveTsHookPayload,
	type CacheAdapter,
	type ActiveTsPlugin,
	type DatastoreKey,
	type DatastoreAncestorReadOptions,
	type DatastoreAncestorWriteOptions,
	type DatastoreReadOptions,
	type DatastoreReadPolicy,
	type ModelTransactionOptions,
	type ModelUpsertResult,
	type PolicyInput,
	type QueryPlanner,
	type ScopeInput,
	type SearchAdapter,
	type StoreAdapter,
	type StoreReadOptions,
	type StoreWriteOptions,
	type StoreTransactionOptions,
	type TransactionOptions,
	type ViewInput,
	type PartialModel
} from '../src/index.js';
import type {
	DatastoreIdInventoryClassification,
	DatastoreIdInventoryIssue,
	DatastoreIdInventoryOptions,
	DatastoreIdInventoryReport,
	DatastoreIdRepairApplyReport,
	DatastoreIdRepairDescendantPolicy,
	DatastoreIdRepairManifest,
	DatastoreIdRepairPlanOptions,
	DatastoreModelTransactionOptions,
	DatastoreStoreTransactionOptions,
	DatastoreTransactionNativeOptions,
	DatastoreTransactionOptions
} from '../src/adapters/store/datastore.js';
import {
	applyDatastoreIdRepairManifest,
	createDatastoreIdRepairManifest,
	datastoreModelTransactionOptions,
	datastoreStoreTransactionOptions,
	datastoreTransactionOptions,
	inventoryDatastoreIds
} from '../src/adapters/store/datastore.js';
import type { FirestoreTransactionNativeOptions } from '../src/adapters/store/firestore.js';

type TypeProjectionData = {
	id: number;
	handle: string;
	score: number;
	active: boolean;
};

class TypeProjectionRecord extends Model<TypeProjectionData> {}

defineModel<TypeProjectionData>('type_projection_record')
	.id('id')
	.validate((input) => input as TypeProjectionData)
	.attach(TypeProjectionRecord);

async function projectionTypes() {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	await context.schemaApply([TypeProjectionRecord], { mode: 'off' });
	await context.schemaApply([TypeProjectionRecord], { mode: 'safe' });
	await context.transaction(async (tx) => {
		const typedTx: ActiveContext = tx;
		void typedTx;
	}, { isolation: 'serializable', readOnly: true, timeoutMs: 100, join: 'error' });

	await TypeProjectionRecord.transaction(async (tx) => {
		const typedTx: ActiveContext = tx;
		void typedTx;
	}, { isolation: 'readCommitted' });

	const bulkRows: readonly TypeProjectionData[] = [
		{ id: 1, handle: 'one', score: 1, active: true },
		{ id: 2, handle: 'two', score: 2, active: false }
	];
	const createdMany: TypeProjectionRecord[] = await TypeProjectionRecord.createMany(bulkRows);
	const upsertedMany: Array<ModelUpsertResult<TypeProjectionRecord>> = await TypeProjectionRecord.upsertMany(bulkRows);
	if (upsertedMany[0]?.operation === 'update') {
		const updatedScore: number = upsertedMany[0].item.data.score;
		void updatedScore;
	}
	await TypeProjectionRecord.deleteMany([1, 2] as const);
	void createdMany;

	// @ts-expect-error createMany rows must satisfy the complete model data type
	await TypeProjectionRecord.createMany([{ id: 3, handle: 'missing fields' }]);

	// @ts-expect-error deleteMany only accepts typed entity ids
	await TypeProjectionRecord.deleteMany([true]);

	const txOptions: TransactionOptions = { store: 'default', join: 'reuse', readOnly: false };
	const savepointTxOptions: TransactionOptions = { store: 'default', join: 'savepoint' };
	const modelTxOptions: ModelTransactionOptions = { join: 'savepoint', readOnly: false };
	const storeTxOptions: StoreTransactionOptions = { isolation: 'repeatableRead', timeoutMs: 50 };
	const datastoreNativeOptions: DatastoreTransactionNativeOptions = {
		gaxOptions: { timeout: 100 },
		commitGaxOptions: { timeout: 200 },
		rollbackGaxOptions: { timeout: 300 }
	};
	const datastoreTypedStoreTxOptions: DatastoreStoreTransactionOptions = datastoreStoreTransactionOptions({
		native: datastoreNativeOptions
	});
	const datastoreTypedContextTxOptions: DatastoreTransactionOptions = datastoreTransactionOptions({
		store: 'default',
		native: datastoreNativeOptions
	});
	const datastoreTypedModelTxOptions: DatastoreModelTransactionOptions = datastoreModelTransactionOptions({
		native: datastoreNativeOptions
	});
	const firestoreNativeOptions: FirestoreTransactionNativeOptions = { maxAttempts: 3 };
	const firestoreReadOnlyNativeOptions: FirestoreTransactionNativeOptions = { readOnly: true, readTime: {} };
	const datastoreStoreTxOptions: StoreTransactionOptions = { native: datastoreNativeOptions };
	const datastoreInventoryOptions: DatastoreIdInventoryOptions = {
		client: {},
		kind: 'type_projection_record',
		onIssue: (issue: DatastoreIdInventoryIssue) => {
			const classification: Exclude<DatastoreIdInventoryClassification, 'match'> = issue.classification;
			void classification;
		}
	};
	const datastoreInventoryReport: Promise<DatastoreIdInventoryReport> = inventoryDatastoreIds(
		datastoreInventoryOptions
	);
	const datastoreRepairReport: DatastoreIdInventoryReport = {
		inventoryId: '123e4567-e89b-42d3-a456-426614174000',
		issueDigest: 'sha256:289e3a95b71db9b0cf4aed28d2f1d5003546bcf7631b3110a2328fd197872682',
		kind: 'type_projection_record',
		idField: 'id',
		scanned: 1,
		pages: 1,
		counts: {
			match: 0,
			'type-mismatch': 1,
			'value-mismatch': 0,
			'missing-payload-id': 0,
			'invalid-payload-id': 0,
			'unsupported-key': 0
		}
	};
	const datastoreRepairIssue: DatastoreIdInventoryIssue = {
		inventoryId: datastoreRepairReport.inventoryId,
		issueIndex: 0,
		classification: 'type-mismatch',
		key: { path: [{ kind: 'type_projection_record', storage: 'id', value: '1' }] },
		payload: { type: 'string', value: '1' },
		reason: 'type drift'
	};
	const datastoreRepairPlanOptions: DatastoreIdRepairPlanOptions = {
		report: datastoreRepairReport,
		issues: [datastoreRepairIssue],
		target: 'gcp:active-ts-types/(default)',
		policy: 'key-wins',
		excludeFromIndexes: []
	};
	const datastoreRepairDescendantPolicy: DatastoreIdRepairDescendantPolicy = 'verified-none';
	const datastoreRepairManifest: DatastoreIdRepairManifest =
		createDatastoreIdRepairManifest(datastoreRepairPlanOptions);
	const datastoreRepairApplyReport: Promise<DatastoreIdRepairApplyReport> =
		applyDatastoreIdRepairManifest({
			client: {},
			manifest: datastoreRepairManifest,
			target: datastoreRepairManifest.target,
			confirm: datastoreRepairManifest.digest,
			transaction: datastoreNativeOptions
		});
	const firestoreStoreTxOptions: StoreTransactionOptions = { native: firestoreNativeOptions };
	const parentKey = datastoreKey('type_parent_record', 1);
	const childKey: DatastoreKey = datastoreKey('type_projection_record', 2, { parent: parentKey });
	const ancestorOptions = datastoreAncestorOptions(parentKey);
	const ancestorReadOptions: DatastoreAncestorReadOptions = ancestorOptions;
	const ancestorWriteOptions: DatastoreAncestorWriteOptions = ancestorOptions;
	const storeReadOptions: StoreReadOptions = ancestorReadOptions;
	const storeWriteOptions: StoreWriteOptions = ancestorWriteOptions;
	const datastoreReadPolicy: DatastoreReadPolicy = { readTime: Date.now() };
	const datastoreHistoricalReadOptions: DatastoreReadOptions = datastoreReadOptions({
		readTime: new Date(),
		ancestor: parentKey
	});
	const datastoreConsistencyReadOptions: StoreReadOptions = datastoreReadOptions({ consistency: 'eventual' });
	void txOptions;
	void savepointTxOptions;
	void modelTxOptions;
	void storeTxOptions;
	void datastoreTypedStoreTxOptions;
	void datastoreTypedContextTxOptions;
	void datastoreTypedModelTxOptions;
	void datastoreStoreTxOptions;
	void datastoreInventoryReport;
	void datastoreRepairApplyReport;
	void datastoreRepairDescendantPolicy;
	void firestoreStoreTxOptions;
	void firestoreReadOnlyNativeOptions;
	void childKey;
	void storeReadOptions;
	void storeWriteOptions;
	void datastoreReadPolicy;
	void datastoreHistoricalReadOptions;
	void datastoreConsistencyReadOptions;

	// @ts-expect-error model transaction helpers choose the model store
	const badModelTxOptions: ModelTransactionOptions = { store: 'default' };
	void badModelTxOptions;

	// @ts-expect-error unsupported transaction isolation names are rejected at compile time
	const badStoreTxOptions: StoreTransactionOptions = { isolation: 'snapshot' };
	void badStoreTxOptions;

	// @ts-expect-error Datastore transaction native option keys are adapter-specific
	const badDatastoreNativeOptions: DatastoreTransactionNativeOptions = { gaxOption: { timeout: 100 } };
	void badDatastoreNativeOptions;

	// @ts-expect-error Datastore typed transaction aliases reject misspelled native keys inline
	const badDatastoreStoreTxOptions: DatastoreStoreTransactionOptions = { native: { gaxOption: { timeout: 100 } } };
	void badDatastoreStoreTxOptions;

	// @ts-expect-error Datastore transaction helper rejects misspelled native keys inline
	datastoreTransactionOptions({ native: { gaxOption: { timeout: 100 } } });

	// @ts-expect-error Datastore ID inventory callbacks only receive issue classifications
	const badDatastoreInventoryIssue: DatastoreIdInventoryIssue = { classification: 'match' };
	void badDatastoreInventoryIssue;

	// @ts-expect-error Datastore ID repair policies are a closed union
	createDatastoreIdRepairManifest({ ...datastoreRepairPlanOptions, policy: 'prefer-key' });

	applyDatastoreIdRepairManifest({
		client: {},
		manifest: datastoreRepairManifest,
		target: datastoreRepairManifest.target,
		// @ts-expect-error Applying a Datastore ID repair manifest requires an approved digest string
		confirm: false
	});

	// @ts-expect-error Datastore model transaction helper chooses the model store
	datastoreModelTransactionOptions({ store: 'default' });

	// @ts-expect-error Datastore ancestor options only accept DatastoreKey values
	datastoreAncestorOptions({ kind: 'type_parent_record', id: 1 });

	// @ts-expect-error Datastore direct ancestor options reject unrelated metadata keys
	const badAncestorReadOptions: DatastoreAncestorReadOptions = { meta: { datastoreAncestor: parentKey, softDelete: 'with' } };
	void badAncestorReadOptions;

	// @ts-expect-error Datastore read options cannot combine point-in-time and consistency modes
	datastoreReadOptions({ readTime: Date.now(), consistency: 'strong' });

	// @ts-expect-error Datastore read consistency is a closed union
	datastoreReadOptions({ consistency: 'cached' });

	// @ts-expect-error Firestore transaction maxAttempts must be numeric
	const badFirestoreNativeOptions: FirestoreTransactionNativeOptions = { maxAttempts: '3' };
	void badFirestoreNativeOptions;

	const projected = await TypeProjectionRecord.query().select('handle').first();
	const projectedFind = await TypeProjectionRecord.query().select('handle').find(1).load();
	await TypeProjectionRecord.query().ancestor(parentKey).load();
	await TypeProjectionRecord.under(parentKey).load();
	const ancestorFind = await TypeProjectionRecord.ancestor(parentKey).find(1).load();
	const historicalFind = await TypeProjectionRecord.find(1).readAt(new Date()).load();
	const historicalQuery = await TypeProjectionRecord.query().readAt(Date.now()).load();
	const eventualQuery = await TypeProjectionRecord.query().readConsistency('eventual').load();
	void historicalFind;
	void historicalQuery;
	void eventualQuery;
	const ancestorUpdated = await TypeProjectionRecord.ancestor(parentKey).find(1).update({ handle: 'next' });
	const ancestorDeleted: boolean = await TypeProjectionRecord.ancestor(parentKey).find(1).delete();
	void ancestorDeleted;
	if (ancestorFind) {
		const fullAncestorScore: number = ancestorFind.data.score;
		void fullAncestorScore;
	}
	if (ancestorUpdated) {
		const updatedHandle: string = ancestorUpdated.data.handle;
		void updatedHandle;
	}
	if (projectedFind) {
		const maybeFindScore: number | undefined = projectedFind.data.score;
		void maybeFindScore;

		// @ts-expect-error query find preserves projection type
		const fullFindScore: number = projectedFind.data.score;
		void fullFindScore;
	}
	if (!projected) return;
	const projectedId: number = projected.data.id;
	const handle: string = projected.data.handle;
	const maybeScore: number | undefined = projected.data.score;
	const typed: PartialModel<
		TypeProjectionRecord,
		Partial<TypeProjectionData> & Pick<TypeProjectionData, 'id' | 'handle'>
	> = projected;
	void projectedId;
	void handle;
	void maybeScore;
	void typed;

	// @ts-expect-error non-selected fields are optional on partial projection data
	const score: number = projected.data.score;
	void score;

	// @ts-expect-error partial model instances cannot be saved directly
	await projected.save();

	const full = await TypeProjectionRecord.query().first();
	if (full) {
		const fullScore: number = full.data.score;
		void fullScore;
		await full.save();
	}

	await TypeProjectionRecord.query().aggregate({ count: 'count' });
	await TypeProjectionRecord.query().aggregate({ total: { op: 'sum', field: 'score' } });
	await TypeProjectionRecord.query().aggregate({ latestHandle: { op: 'max', field: 'handle' } });
	await TypeProjectionRecord.query().max('handle');

	// @ts-expect-error count aggregates count rows and do not accept a field
	await TypeProjectionRecord.query().aggregate({ count: { op: 'count', field: 'score' } });

	// @ts-expect-error non-count aggregates require an explicit field
	await TypeProjectionRecord.query().aggregate({ total: { op: 'sum' } });

	// @ts-expect-error sum aggregates require a known number field
	await TypeProjectionRecord.query().sum('handle');

	// @ts-expect-error avg aggregates require a known number field
	await TypeProjectionRecord.query().avg('active');

	// @ts-expect-error boolean fields are not comparable for max aggregates
	await TypeProjectionRecord.query().max('active');

	// @ts-expect-error boolean fields are not comparable for aggregate max selections
	await TypeProjectionRecord.query().aggregate({ highestActive: { op: 'max', field: 'active' } });

	TypeProjectionRecord.query().where('score', 'between', 1, 10);
	TypeProjectionRecord.query().where('handle', 'isNull');
	TypeProjectionRecord.query().where({ score: ['between', 1, 10] });
	TypeProjectionRecord.query().where({ handle: ['isNull'] });

	// @ts-expect-error invalid direct where operators are rejected at compile time
	TypeProjectionRecord.query().where('score', 'badOperator', 1);

	// @ts-expect-error direct in requires an array operand
	TypeProjectionRecord.query().where('score', 'in', 1);

	// @ts-expect-error direct between requires both bounds
	TypeProjectionRecord.query().where('score', 'between', 1);

	// @ts-expect-error unary where operators do not accept operands
	TypeProjectionRecord.query().where({ handle: ['isNull', 'extra'] });

	// @ts-expect-error object-shape in lists use the explicit in tuple form
	TypeProjectionRecord.query().where({ score: [1, 2] });

	const searchHit = (await TypeProjectionRecord.search('handle').load()).list[0];
	if (searchHit) {
		const maybeSearchScore: number | undefined = searchHit.data.score;
		void maybeSearchScore;

		// @ts-expect-error search hits without include are partial model instances
		await searchHit.save();
	}

	const includedSearchHit = (await TypeProjectionRecord.search('handle').include('owner').load()).list[0];
	if (includedSearchHit) {
		const includedScore: number = includedSearchHit.data.score;
		void includedScore;
		await includedSearchHit.save();
	}
}

void projectionTypes;

function extensionContextTypes(context: ActiveContext) {
	const hook = (payload: ActiveTsHookPayload) => {
		const typedContext: ActiveContext = payload.context;
		typedContext.isInTransaction();
	};

	const plugin: ActiveTsPlugin = {
		name: 'typed-plugin',
		setup(setupContext) {
			const typedContext: ActiveContext = setupContext;
			typedContext.cache('default');
		},
		hooks: {
			beforeQuery: hook
		}
	};
	void context.invalidateModel(TypeProjectionRecord, 1);
	void context.invalidateModelExternal(TypeProjectionRecord, 1);

	const planner: QueryPlanner = {
		routeQuery(input) {
			const typedContext: ActiveContext = input.context;
			typedContext.storeForQuery(input.model, input.plan);
			return undefined;
		},
		routeAggregate(input) {
			const typedContext: ActiveContext = input.context;
			typedContext.storeForAggregate(input.model, input.plan);
			return undefined;
		},
		routeSearch(input) {
			const typedContext: ActiveContext = input.context;
			typedContext.searchAdapter(input.requested ?? 'memory');
			return undefined;
		},
		schemaSearchAdapters(input) {
			const typedContext: ActiveContext = input.context;
			typedContext.meta(input.model.model);
			return ['memory'];
		}
	};

	const viewInput = null as unknown as ViewInput<TypeProjectionRecord, TypeProjectionData>;
	const viewContext: ActiveContext = viewInput.context;
	viewContext.meta(TypeProjectionRecord);

	const policyInput = null as unknown as PolicyInput<TypeProjectionRecord, TypeProjectionData>;
	const policyContext: ActiveContext = policyInput.context;
	policyContext.isTransactionContext();

	const scopeInput = null as unknown as ScopeInput<TypeProjectionData>;
	const scopeContext: ActiveContext = scopeInput.context;
	scopeContext.store(scopeInput.model.store);

	const guardedStore: StoreAdapter = assertContextBoundStoreAdapter(context.store('default'));
	const memoryTransactionCapability: boolean = new MemoryStoreAdapter().capabilities.transaction;
	const memorySavepointCapability: boolean = new MemoryStoreAdapter().capabilities.savepoint;
	void memoryTransactionCapability;
	void memorySavepointCapability;
	if (guardedStore.savepoint) {
		void guardedStore.savepoint(async (savepointStore) => {
			const typedSavepointStore: StoreAdapter = savepointStore;
			return typedSavepointStore.kind;
		});
	}
	const maybeCache = context.cache('default');
	const guardedSearch: SearchAdapter = assertContextBoundSearchAdapter(context.searchAdapter('memory'));
	if (isContextBoundStoreAdapter(guardedStore)) {
		const narrowedStore: StoreAdapter = guardedStore;
		void narrowedStore;
	}
	if (maybeCache && isContextBoundCacheAdapter(maybeCache)) {
		const guardedCache: CacheAdapter = assertContextBoundCacheAdapter(maybeCache);
		void guardedCache;
	}
	if (isContextBoundSearchAdapter(guardedSearch)) {
		const narrowedSearch: SearchAdapter = guardedSearch;
		void narrowedSearch;
	}

	void context;
	void plugin;
	void planner;
}

void extensionContextTypes;
