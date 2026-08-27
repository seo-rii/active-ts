import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	ACTIVE_TS_ENTITY_KEY,
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	createOutboxPlugin,
	createSearchMiddlewareAdapter,
	createStoreMiddlewareAdapter,
	datastoreKey,
	datastoreReadOptions,
	defineModel,
	type AggregatePlan,
	type DatastoreKey,
	type QueryPlan,
	type ResolvedModelMeta,
	type SearchAdapter,
	type StoreAdapter
} from '../src/index.js';
import {
	createDatastoreIndexYaml,
	createDatastoreStoreAdapter,
	inventoryDatastoreIds,
	type DatastoreIdInventoryIssue
} from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { assertGoogleInequalitySortOrder, assertGoogleMinMaxInequalityOrder } from '../src/adapters/store/google-query-constraints.js';
import { encodeAggregatePlanFieldCodecs, encodeQueryPlanFieldCodecs } from '../src/core/field-codecs.js';
import {
	datastoreAncestorFromEntityKey,
	datastoreKeyIdentity,
	datastoreScopedAncestorMatches
} from '../src/core/datastore-key.js';
import {
	datastoreSearchDocumentIdentity,
	markSearchDocumentIdentity,
	searchDocumentIdentity
} from '../src/core/search-utils.js';
import {
	markStoreTrustsDatastoreEntityKeyRows,
	storeTrustsDatastoreEntityKeyRows
} from '../src/core/store-options.js';

type GoogleRegressionData = {
	id: number;
	handle: string;
	score?: number;
};

type DatastoreSearchData = {
	id: number;
	parentId: number;
	childId: number;
	title: string;
	handle: string;
};
type DatastoreNamespacedAncestorData = GoogleRegressionData & {
	parentId: number;
	parentNamespace?: string;
};
type DatastoreEncodedAggregateData = {
	id: number;
	parentId: number;
	score: number;
	handle: string;
};
type DatastoreObjectEncodedAncestorData = {
	id: number;
	parentId: number;
	handle: string;
};
type DatastoreObjectEncodedSearchData = {
	id: number;
	parentId: number;
	title: string;
	handle: string;
};
type DatastoreNestedEncodedAncestorData = {
	id: number;
	profile: {
		parentId: number;
		label: string;
	};
	score: number;
	handle: string;
};
type DatastoreDescendantProjectionData = {
	id: number;
	rootId: number;
	parentId: number;
	title: string;
};
type DatastoreDescendantRelationOwnerData = {
	id: number;
	rootId: number;
	parentId: number;
	childId: number;
};
type DatastoreDescendantFallbackRelationOwnerData = {
	id: number;
	rootId: number;
	childId: number;
};
type DatastoreInferredRelationOwnerData = {
	id: number;
	parentId: number;
	childId: number;
	handle: string;
};
type DatastoreInferredRelationChildData = {
	id: number;
	parentId: number;
	title: string;
};
type DatastoreNamespacedOwnerRelationData = {
	id: number;
	parentId: number;
	parentNamespace?: string;
	childId: number;
};
type DatastorePreloadRelationOwnerData = {
	id: number;
	parentId: number;
	childId: number;
};
type DatastorePreloadRelationChildData = {
	id: number;
	parentId: number;
	title: string;
	body?: string;
};
type DatastoreConstantAncestorData = {
	id: number;
	title: string;
};
type DatastoreDynamicAncestorData = {
	id: number;
	parentKind: string;
	parentId: number;
	handle: string;
	score: number;
};

class DatastoreEntityKeyRecord extends Model<GoogleRegressionData> {}
class DatastoreAncestorRecord extends Model<GoogleRegressionData & { parentId: number; body?: string }> {}
class DatastoreNamespacedAncestorRecord extends Model<DatastoreNamespacedAncestorData> {}
class DatastoreRelationOwnerRecord extends Model<{ id: number; parentId: number; childId: number }> {}
class DatastoreNamespacedRelationOwnerRecord extends Model<{ id: number; parentId: number; parentNamespace?: string; childId: number }> {}
class DatastoreSearchRecord extends Model<DatastoreSearchData> {}
class DatastoreEncodedAncestorRecord extends Model<GoogleRegressionData & { parentId: number }> {}
class DatastoreEncodedAncestorFieldRecord extends Model<DatastoreEncodedAggregateData> {}
class DatastoreEncodedAggregateRecord extends Model<DatastoreEncodedAggregateData> {}
class DatastoreObjectEncodedAncestorRecord extends Model<DatastoreObjectEncodedAncestorData> {}
class DatastoreObjectEncodedSearchRecord extends Model<DatastoreObjectEncodedSearchData> {}
class DatastoreNestedEncodedAncestorRecord extends Model<DatastoreNestedEncodedAncestorData> {}
class DatastoreDescendantProjectionRecord extends Model<DatastoreDescendantProjectionData> {}
class DatastoreImplicitDescendantProjectionRecord extends Model<DatastoreDescendantProjectionData> {}
class DatastoreDescendantRelationOwnerRecord extends Model<DatastoreDescendantRelationOwnerData> {}
class DatastoreDescendantDirectRelationOwnerRecord extends Model<DatastoreDescendantRelationOwnerData> {}
class DatastoreDescendantFallbackRelationOwnerRecord extends Model<DatastoreDescendantFallbackRelationOwnerData> {}
class DatastoreDescendantDirectFallbackRelationOwnerRecord extends Model<DatastoreDescendantFallbackRelationOwnerData> {}
class DatastoreImplicitDescendantFallbackRelationOwnerRecord extends Model<DatastoreDescendantFallbackRelationOwnerData> {}
class DatastoreMissingRelationAncestorRecord extends Model<{ id: number; childId: number }> {}
class DatastoreTransactionRecord extends Model<GoogleRegressionData> {}
class DatastoreInferredRelationOwnerRecord extends Model<DatastoreInferredRelationOwnerData> {}
class DatastoreInferredRelationChildRecord extends Model<DatastoreInferredRelationChildData> {}
class DatastoreNamespacedOwnerRelationRecord extends Model<DatastoreNamespacedOwnerRelationData> {}
class DatastorePreloadRelationOwnerRecord extends Model<DatastorePreloadRelationOwnerData> {}
class DatastorePreloadRelationChildRecord extends Model<DatastorePreloadRelationChildData> {}
class DatastoreConstantAncestorRecord extends Model<DatastoreConstantAncestorData> {}
class DatastoreDynamicAncestorRecord extends Model<DatastoreDynamicAncestorData> {}
class DatastoreImplicitDynamicAncestorRecord extends Model<DatastoreDynamicAncestorData> {}

defineModel<GoogleRegressionData>('datastore_entity_key_record')
	.id('id')
	.validate((input) => input as GoogleRegressionData)
	.attach(DatastoreEntityKeyRecord);

defineModel<GoogleRegressionData & { parentId: number; body?: string }>('datastore_ancestor_record')
	.id('id')
	.validate((input) => input as GoogleRegressionData & { parentId: number; body?: string })
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('parent_record', data.parentId) : undefined,
		unindexed: ['body']
	})
	.attach(DatastoreAncestorRecord);

defineModel<DatastoreNamespacedAncestorData>('datastore_namespaced_ancestor_record')
	.id('id')
	.validate((input) => input as DatastoreNamespacedAncestorData)
	.datastore({
		ancestor: ({ data }) => data
			? datastoreKey(
					'parent_record',
					data.parentId,
					data.parentNamespace === undefined ? undefined : { namespace: data.parentNamespace }
				)
			: undefined
	})
	.attach(DatastoreNamespacedAncestorRecord);

defineModel<{ id: number; parentId: number; childId: number }>({ name: 'datastore_relation_owner_record', store: 'memory' })
	.id('id')
	.validate((input) => input as { id: number; parentId: number; childId: number })
	.ref('child', () => DatastoreAncestorRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('parent_record', data.parentId)
	})
	.attach(DatastoreRelationOwnerRecord);

defineModel<{ id: number; parentId: number; parentNamespace?: string; childId: number }>({
	name: 'datastore_namespaced_relation_owner_record',
	store: 'memory'
})
	.id('id')
	.validate((input) => input as { id: number; parentId: number; parentNamespace?: string; childId: number })
	.ref('child', () => DatastoreNamespacedAncestorRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey(
			'parent_record',
			data.parentId,
			data.parentNamespace === undefined ? undefined : { namespace: data.parentNamespace }
		)
	})
	.attach(DatastoreNamespacedRelationOwnerRecord);

defineModel<DatastoreSearchData>('datastore_search_record')
	.id('id')
	.validate((input) => input as DatastoreSearchData)
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('parent_record', data.parentId) : undefined,
		ancestorFields: ['parentId']
	})
	.search('memory', ['title', 'parentId', 'childId'])
	.ref('child', () => DatastoreAncestorRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('parent_record', data.parentId)
	})
	.attach(DatastoreSearchRecord);

defineModel<DatastoreConstantAncestorData>('datastore_constant_ancestor_record')
	.id('id')
	.validate((input) => input as DatastoreConstantAncestorData)
	.datastore({
		ancestor: () => datastoreKey('constant_parent_record', 1),
		ancestorFields: []
	})
	.attach(DatastoreConstantAncestorRecord);

defineModel<DatastoreDynamicAncestorData>('datastore_dynamic_ancestor_record')
	.id('id')
	.validate((input) => input as DatastoreDynamicAncestorData)
	.fieldType('score', 'number')
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey(data.parentKind, data.parentId) : undefined,
		ancestorFields: ['parentKind', 'parentId']
	})
	.attach(DatastoreDynamicAncestorRecord);

defineModel<DatastoreDynamicAncestorData>('datastore_implicit_dynamic_ancestor_record')
	.id('id')
	.validate((input) => input as DatastoreDynamicAncestorData)
	.fieldType('score', 'number')
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey(data.parentKind, data.parentId) : undefined
	})
	.attach(DatastoreImplicitDynamicAncestorRecord);

function markedDatastoreSearchHit(meta: ResolvedModelMeta, data: DatastoreSearchData) {
	return markSearchDocumentIdentity(
		data,
		datastoreSearchDocumentIdentity(meta, data.id, datastoreKey('parent_record', data.parentId))
	);
}

function sdkDatastoreEntityKey(path: Array<string | number>) {
	class SdkDatastoreEntityKey {}
	const key = new SdkDatastoreEntityKey() as { path: Array<string | number> };
	Object.defineProperty(key, 'path', {
		enumerable: true,
		get() {
			return path;
		}
	});
	return key;
}

function nativeSdkDatastoreEntityKey({
	path,
	namespace
}: {
	path: Array<string | number>;
	namespace?: string;
}) {
	let parent: Record<string, unknown> | undefined;
	for (let index = 0; index < path.length; index += 2) {
		const id = path[index + 1];
		const key: Record<string, unknown> = {
			namespace,
			id: typeof id === 'number' ? id : undefined,
			name: typeof id === 'string' ? id : undefined,
			kind: path[index],
			parent
		};
		Object.defineProperty(key, 'path', {
			enumerable: true,
			get() {
				return path.slice(0, index + 2);
			}
		});
		parent = key;
	}
	return parent;
}

defineModel<GoogleRegressionData & { parentId: number }>('datastore_encoded_ancestor_record')
	.id('id')
	.validate((input) => input as GoogleRegressionData & { parentId: number })
	.fieldCodec('parentId', {
		name: 'encoded-parent-id',
		encode: (value) => `parent:${String(value)}`,
		decode: (value) => Number(String(value).slice('parent:'.length)),
		encodeQuery: (value) => `parent:${String(value)}`
	})
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('parent_record', data.parentId) : undefined
	})
	.attach(DatastoreEncodedAncestorRecord);

defineModel<DatastoreEncodedAggregateData>('datastore_encoded_ancestor_field_record')
	.id('id')
	.validate((input) => input as DatastoreEncodedAggregateData)
	.fieldType('score', 'number')
	.fieldCodec('parentId', {
		name: 'encoded-ancestor-field-parent-id',
		encode: (value) => `parent:${String(value)}`,
		decode: (value) => Number(String(value).slice('parent:'.length)),
		encodeQuery: (value) => `parent:${String(value)}`
	})
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('parent_record', data.parentId) : undefined,
		ancestorFields: ['parentId']
	})
	.attach(DatastoreEncodedAncestorFieldRecord);

defineModel<DatastoreEncodedAggregateData>('datastore_encoded_aggregate_record')
	.id('id')
	.validate((input) => input as DatastoreEncodedAggregateData)
	.fieldType('score', 'number')
	.fieldCodec('score', {
		name: 'encoded-score',
		encode: (value) => Number(value) * 10,
		decode: (value) => Number(value) / 10,
		encodeQuery: (value) => Number(value) * 10
	})
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('parent_record', data.parentId) : undefined,
		ancestorFields: ['parentId']
	})
	.attach(DatastoreEncodedAggregateRecord);

defineModel<DatastoreObjectEncodedAncestorData>('datastore_object_encoded_ancestor_record')
	.id('id')
	.validate((input) => input as DatastoreObjectEncodedAncestorData)
	.fieldCodec('parentId', {
		name: 'object-encoded-parent-id',
		encode: (value) => ({ value: Number(value) }),
		decode: (value) => {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return Number((value as { value?: unknown }).value);
			}
			return Number(value);
		},
		encodeQuery: (value) => ({ value: Number(value) })
	})
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('object_parent_record', data.parentId) : undefined
	})
	.attach(DatastoreObjectEncodedAncestorRecord);

defineModel<DatastoreObjectEncodedSearchData>('datastore_object_encoded_search_record')
	.id('id')
	.validate((input) => input as DatastoreObjectEncodedSearchData)
	.fieldCodec('parentId', {
		name: 'object-encoded-search-parent-id',
		encode: (value) => ({ value: Number(value) }),
		decode: (value) => {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return Number((value as { value?: unknown }).value);
			}
			return Number(value);
		},
		encodeQuery: (value) => ({ value: Number(value) })
	})
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('object_search_parent_record', data.parentId) : undefined,
		ancestorFields: ['parentId']
	})
	.search('memory', ['title', 'parentId'])
	.attach(DatastoreObjectEncodedSearchRecord);

defineModel<DatastoreNestedEncodedAncestorData>('datastore_nested_encoded_ancestor_record')
	.id('id')
	.validate((input) => input as DatastoreNestedEncodedAncestorData)
	.fieldType('score', 'number')
	.fieldCodec('profile', {
		name: 'encoded-profile',
		encode: (value) => JSON.stringify(value),
		decode: (value) => JSON.parse(String(value))
	})
	.datastore({
		ancestor: ({ data }) => {
			const profile = data?.profile;
			return profile && typeof profile === 'object'
				? datastoreKey('nested_parent_record', profile.parentId)
				: undefined;
		},
		ancestorFields: ['profile.parentId']
	})
	.attach(DatastoreNestedEncodedAncestorRecord);

defineModel<DatastoreDescendantProjectionData>('datastore_descendant_projection_record')
	.id('id')
	.validate((input) => input as DatastoreDescendantProjectionData)
	.datastore({
		ancestor: ({ data }) => data
			? datastoreKey('descendant_projection_parent', data.parentId, {
					parent: datastoreKey('descendant_projection_root', data.rootId)
				})
			: undefined,
		ancestorFields: ['rootId', 'parentId']
	})
	.attach(DatastoreDescendantProjectionRecord);

defineModel<DatastoreDescendantProjectionData>('datastore_implicit_descendant_projection_record')
	.id('id')
	.validate((input) => input as DatastoreDescendantProjectionData)
	.datastore({
		ancestor: ({ data }) => data
			? datastoreKey('implicit_descendant_projection_parent', data.parentId, {
					parent: datastoreKey('implicit_descendant_projection_root', data.rootId)
				})
			: undefined
	})
	.attach(DatastoreImplicitDescendantProjectionRecord);

defineModel<DatastoreDescendantRelationOwnerData>({
	name: 'datastore_descendant_relation_owner_record',
	store: 'memory'
})
	.id('id')
	.validate((input) => input as DatastoreDescendantRelationOwnerData)
	.ref('child', () => DatastoreDescendantProjectionRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('descendant_projection_root', data.rootId),
		preload: ['title']
	})
	.attach(DatastoreDescendantRelationOwnerRecord);

defineModel<DatastoreDescendantRelationOwnerData>({
	name: 'datastore_descendant_direct_relation_owner_record',
	store: 'memory'
})
	.id('id')
	.validate((input) => input as DatastoreDescendantRelationOwnerData)
	.ref('child', () => DatastoreDescendantProjectionRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('descendant_projection_root', data.rootId)
	})
	.attach(DatastoreDescendantDirectRelationOwnerRecord);

defineModel<DatastoreDescendantFallbackRelationOwnerData>({
	name: 'datastore_descendant_fallback_relation_owner_record',
	store: 'memory'
})
	.id('id')
	.validate((input) => input as DatastoreDescendantFallbackRelationOwnerData)
	.ref('child', () => DatastoreDescendantProjectionRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('descendant_projection_root', data.rootId),
		preload: ['title']
	})
	.hasMany('children', () => DatastoreDescendantProjectionRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('descendant_projection_root', data.rootId),
		preload: ['title']
	})
	.attach(DatastoreDescendantFallbackRelationOwnerRecord);

defineModel<DatastoreDescendantFallbackRelationOwnerData>({
	name: 'datastore_descendant_direct_fallback_relation_owner_record',
	store: 'memory'
})
	.id('id')
	.validate((input) => input as DatastoreDescendantFallbackRelationOwnerData)
	.ref('child', () => DatastoreDescendantProjectionRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('descendant_projection_root', data.rootId)
	})
	.attach(DatastoreDescendantDirectFallbackRelationOwnerRecord);

defineModel<DatastoreDescendantFallbackRelationOwnerData>({
	name: 'datastore_implicit_descendant_fallback_relation_owner_record',
	store: 'memory'
})
	.id('id')
	.validate((input) => input as DatastoreDescendantFallbackRelationOwnerData)
	.ref('child', () => DatastoreImplicitDescendantProjectionRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('implicit_descendant_projection_root', data.rootId),
		preload: ['title', 'rootId', 'parentId']
	})
	.attach(DatastoreImplicitDescendantFallbackRelationOwnerRecord);

defineModel<DatastoreInferredRelationChildData>('datastore_inferred_relation_child_record')
	.id('id')
	.validate((input) => input as DatastoreInferredRelationChildData)
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('inferred_parent_record', data.parentId) : undefined,
		ancestorFields: ['parentId']
	})
	.attach(DatastoreInferredRelationChildRecord);

defineModel<DatastoreInferredRelationOwnerData>({ name: 'datastore_inferred_relation_owner_record', store: 'memory' })
	.id('id')
	.validate((input) => input as DatastoreInferredRelationOwnerData)
	.ref('child', () => DatastoreInferredRelationChildRecord, {
		localKey: 'childId',
		foreignKey: 'id'
	})
	.hasMany('children', () => DatastoreInferredRelationChildRecord, {
		localKey: 'parentId',
		foreignKey: 'parentId'
	})
	.attach(DatastoreInferredRelationOwnerRecord);

defineModel<DatastoreNamespacedOwnerRelationData>('datastore_namespaced_owner_relation_record')
	.id('id')
	.validate((input) => input as DatastoreNamespacedOwnerRelationData)
	.datastore({
		ancestor: ({ data }) => data
			? datastoreKey(
					'owner_parent_record',
					data.parentId,
					data.parentNamespace === undefined ? undefined : { namespace: data.parentNamespace }
				)
			: undefined,
		ancestorFields: ['parentId', 'parentNamespace']
	})
	.ref('child', () => DatastoreAncestorRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('parent_record', data.parentId)
	})
	.attach(DatastoreNamespacedOwnerRelationRecord);

defineModel<DatastorePreloadRelationChildData>('datastore_preload_relation_child_record')
	.id('id')
	.validate((input) => input as DatastorePreloadRelationChildData)
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('preload_parent_record', data.parentId) : undefined,
		ancestorFields: ['parentId']
	})
	.attach(DatastorePreloadRelationChildRecord);

defineModel<DatastorePreloadRelationOwnerData>({
	name: 'datastore_preload_relation_owner_record',
	store: 'memory'
})
	.id('id')
	.validate((input) => input as DatastorePreloadRelationOwnerData)
	.ref('child', () => DatastorePreloadRelationChildRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('preload_parent_record', data.parentId),
		preload: ['title']
	})
	.ref('legacyChild', () => DatastoreAncestorRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('parent_record', data.parentId),
		preload: ['handle']
	})
	.ref('legacyChildWithParent', () => DatastoreAncestorRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: ({ data }) => datastoreKey('parent_record', data.parentId),
		preload: ['handle', 'parentId']
	})
	.attach(DatastorePreloadRelationOwnerRecord);

defineModel<{ id: number; childId: number }>({ name: 'datastore_missing_relation_ancestor_record', store: 'memory' })
	.id('id')
	.validate((input) => input as { id: number; childId: number })
	.ref('child', () => DatastoreAncestorRecord, {
		localKey: 'childId',
		foreignKey: 'id',
		ancestor: () => undefined
	})
	.attach(DatastoreMissingRelationAncestorRecord);

defineModel<GoogleRegressionData>('datastore_transaction_record')
	.id('id')
	.validate((input) => input as GoogleRegressionData)
	.attach(DatastoreTransactionRecord);

const meta: ResolvedModelMeta<GoogleRegressionData> = {
	model: class {},
	name: 'google_regression_record',
	store: 'default',
	idField: 'id',
	readValidation: 'off',
	indexes: [],
	searchIndexes: [],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map(),
	fieldTypes: new Map()
};

const ancestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
	model: DatastoreAncestorRecord,
	name: 'datastore_ancestor_record',
	store: 'default',
	idField: 'id',
	readValidation: 'off',
	indexes: [],
	searchIndexes: [],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map(),
	fieldTypes: new Map(),
	datastore: {
		ancestor: ({ data }) => data ? datastoreKey('parent_record', data.parentId) : undefined,
		unindexed: ['body']
	}
};

function firestoreClient(overrides: Record<string, unknown> = {}) {
	return {
		collection: () => ({
			doc: () => ({
				get: async () => ({ exists: false }),
				create: async () => undefined
			})
		}),
		getAll: async () => [],
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({
				get: async () => ({ exists: false }),
				set: async () => undefined
			}),
		...overrides
	};
}

function datastoreClient(overrides: Record<string, unknown> = {}) {
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	return {
		KEY: Symbol('datastore-key'),
		key: (input: unknown) => input,
		get: async (input: unknown) => Array.isArray(input) ? [[]] : [null],
		save: async () => undefined,
		delete: async () => undefined,
		update: async () => undefined,
		createQuery: () => query,
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		...overrides
	};
}

test('Google transaction adapters reject unsupported savepoint joins before callbacks run', async () => {
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => [null],
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
				get: async () => ({ exists: false }),
				create: async () => undefined,
				set: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	for (const adapter of [datastore, firestore]) {
		assert.equal(adapter.capabilities?.savepoint, false);
		let nestedCalls = 0;
		const context = createActiveTs({ stores: { default: adapter } });
		await context.transaction(async (tx) => {
			const scopedStore = tx.store('default');
			assert.equal(scopedStore.capabilities?.savepoint, false);
			assert.equal(scopedStore.savepoint, undefined);
			await assert.rejects(
				() => tx.transaction(
					async () => {
						nestedCalls++;
					},
					{ join: 'savepoint' }
				),
				/does not support transaction savepoints/
			);
		});
		assert.equal(nestedCalls, 0);
	}
});

test('Google manual schema plans reject slash-containing index fields', async () => {
	const unsafeMeta = { ...meta, indexes: [{ name: 'unsafe_path', fields: ['profile/name'] }] };
	const firestore = await createFirestoreStoreAdapter({ client: firestoreClient() });
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });

	await assert.rejects(
		() => firestore.schema!.plan([unsafeMeta]),
		/Firestore schema index field "profile\/name" cannot contain "\/"/
	);
	await assert.rejects(
		() => datastore.schema!.plan([unsafeMeta]),
		/Datastore schema index field "profile\/name" cannot contain "\/"/
	);
	await assert.rejects(
		() =>
			datastore.query(meta, {
				where: [{ field: 'profile/name', op: '=', value: 'x' }],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore query field "profile\/name" cannot contain "\/"/
	);
});

test('Datastore schema boundaries reject ancestor accessors without invoking them', async () => {
	let ownAccessorCalls = 0;
	const ownAccessorDatastore = { ancestorFields: [] };
	Object.defineProperty(ownAccessorDatastore, 'ancestor', {
		enumerable: true,
		get() {
			ownAccessorCalls++;
			throw new Error('own ancestor accessor should not run');
		}
	});
	const ownAccessorMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		indexes: [{ name: 'idx_handle', fields: ['handle'] }],
		datastore: ownAccessorDatastore as any
	};
	let inheritedAccessorCalls = 0;
	const inheritedDatastore = Object.create(Object.defineProperty({}, 'ancestor', {
		enumerable: true,
		get() {
			inheritedAccessorCalls++;
			throw new Error('inherited ancestor accessor should not run');
		}
	}));
	Object.defineProperty(inheritedDatastore, 'ancestorFields', {
		value: [],
		enumerable: true,
		configurable: true,
		writable: true
	});
	const inheritedAccessorMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		indexes: [{ name: 'idx_handle', fields: ['handle'] }],
		datastore: inheritedDatastore as any
	};
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });

	await assert.rejects(
		() => datastore.schema!.plan([ownAccessorMeta]),
		/Datastore schema model "google_regression_record"\.datastore\.ancestor must be a data property/
	);
	assert.throws(
		() => createDatastoreIndexYaml(ownAccessorMeta),
		/Datastore schema model "google_regression_record"\.datastore\.ancestor must be a data property/
	);
	await assert.rejects(
		() => datastore.schema!.plan([inheritedAccessorMeta]),
		/Datastore schema model "google_regression_record"\.datastore\.ancestor must be an own data property/
	);
	assert.throws(
		() => createDatastoreIndexYaml(inheritedAccessorMeta),
		/Datastore schema model "google_regression_record"\.datastore\.ancestor must be an own data property/
	);
	assert.equal(ownAccessorCalls, 0);
	assert.equal(inheritedAccessorCalls, 0);
});

test('Datastore schema and writes reject unindexed identity and index overlaps', async () => {
	const unindexedIndexMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		indexes: [{ name: 'handle_lookup', fields: ['handle'] }],
		datastore: { unindexed: ['handle'] }
	};
	const unindexedIdMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		datastore: { unindexed: ['id'] }
	};
	let ancestorCalls = 0;
	let keyCalls = 0;
	const unindexedIdAncestorMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		datastore: {
			ancestor: () => {
				ancestorCalls++;
				throw new Error('ancestor resolver should not run for invalid unindexed metadata');
			},
			unindexed: ['id']
		}
	};
	const malformedUnindexedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		datastore: { unindexed: 'id' as any }
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: () => {
				keyCalls++;
				throw new Error('Datastore key factory should not run for invalid unindexed metadata');
			},
			insert: async () => {
				assert.fail('Datastore insert should not run for invalid unindexed metadata');
			}
		})
	});

	await assert.rejects(
		() => datastore.schema!.plan([unindexedIndexMeta]),
		/Datastore unindexed field "handle" for google_regression_record overlaps indexed field "handle" in index "handle_lookup"/
	);
	assert.throws(
		() => createDatastoreIndexYaml(unindexedIndexMeta),
		/Datastore unindexed field "handle" for google_regression_record overlaps indexed field "handle" in index "handle_lookup"/
	);
	await assert.rejects(
		() => datastore.create(unindexedIdMeta, 1, { id: 1, handle: 'one' }),
		/Datastore unindexed field "id" for google_regression_record cannot overlap id field "id"/
	);
	await assert.rejects(
		() => datastore.create(unindexedIdAncestorMeta, 1, { id: 1, handle: 'one' }),
		/Datastore unindexed field "id" for google_regression_record cannot overlap id field "id"/
	);
	await assert.rejects(
		() => datastore.schema!.plan([malformedUnindexedMeta]),
		/Datastore unindexed fields for google_regression_record must be a non-empty array/
	);
	await assert.rejects(
		() => datastore.create(malformedUnindexedMeta, 1, { id: 1, handle: 'one' }),
		/Datastore unindexed fields for google_regression_record must be a non-empty array/
	);
	assert.equal(ancestorCalls, 0);
	assert.equal(keyCalls, 0);
});

test('Datastore adapter transactions use SDK transaction commit and rollback', async () => {
	const calls: string[] = [];
	const inserted: unknown[] = [];
	const updated: unknown[] = [];
	const deleted: unknown[] = [];
	const query = {
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `query.filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		order(field: string, options: { descending?: boolean }) {
			calls[calls.length] = `query.order:${field}:${options.descending ? 'desc' : 'asc'}`;
			return this;
		},
		limit(value: number) {
			calls[calls.length] = `query.limit:${value}`;
			return this;
		},
		select(fields: string[]) {
			calls[calls.length] = `query.select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	let nextTransactionBehavior: { runError?: Error; commitError?: Error } = {};
	const createTransaction = (behavior: { runError?: Error; commitError?: Error } = {}) => ({
		run: async (options?: unknown) => {
			calls[calls.length] = options === undefined ? 'tx.run' : `tx.run:${JSON.stringify(options)}`;
			if (behavior.runError) throw behavior.runError;
		},
		commit: async (options?: unknown) => {
			calls[calls.length] = options === undefined ? 'tx.commit' : `tx.commit:${JSON.stringify(options)}`;
			if (behavior.commitError) throw behavior.commitError;
		},
		rollback: async (options?: unknown) => {
			calls[calls.length] = options === undefined ? 'tx.rollback' : `tx.rollback:${JSON.stringify(options)}`;
		},
		createAggregationQuery: () => {
			calls[calls.length] = 'tx.createAggregationQuery';
			return {
				count(alias: string) {
					calls[calls.length] = `tx.aggregate.count:${alias}`;
					return this;
				}
			};
		},
		runAggregationQuery: async () => {
			calls[calls.length] = 'tx.runAggregationQuery';
			return [[{ count: 3 }], {}];
		},
		get: async () => [null],
		runQuery: async () => {
			calls[calls.length] = 'tx.runQuery';
			return [[{ id: 1, handle: 'one', score: 7 }], { moreResults: 'NO_MORE_RESULTS' }];
		},
		insert: async (entity: unknown) => {
			calls[calls.length] = 'tx.insert';
			inserted[inserted.length] = entity;
		},
		update: async (entity: unknown) => {
			calls[calls.length] = 'tx.update';
			updated[updated.length] = entity;
		},
		delete: async (key: unknown) => {
			calls[calls.length] = 'tx.delete';
			deleted[deleted.length] = key;
		}
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: (options?: unknown) => {
				calls[calls.length] = options === undefined
					? 'client.transaction'
					: `client.transaction:${JSON.stringify(options)}`;
				const transaction = createTransaction(nextTransactionBehavior);
				nextTransactionBehavior = {};
				return transaction;
			},
			createQuery: () => {
				calls[calls.length] = 'client.createQuery';
				return query;
			},
			createAggregationQuery: () => ({}),
			runAggregationQuery: async () => assert.fail('root runAggregationQuery should not run inside transaction'),
			insert: async () => assert.fail('root insert should not run inside transaction'),
			runQuery: async () => assert.fail('root runQuery should not run inside transaction')
		})
	});

	assert.equal(datastore.capabilities?.transaction, true);
	assert.equal(datastore.capabilities?.native, true);
	assert.equal(datastore.capabilities?.cursor, true);
	const result = await datastore.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.transaction, false);
		assert.equal(tx.capabilities?.native, true);
		assert.equal(tx.capabilities?.aggregate, true);
		assert.equal(tx.capabilities?.cursor, false);
		assert.equal(tx.schema, undefined);
		const nativeResult = await tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: async ({ client: nativeClient }: { client: any }) => {
					calls[calls.length] = 'native.payload';
					await assert.rejects(
						() => nativeClient.insert({}),
						/Datastore transaction native store reads cannot perform SDK writes/
					);
					await assert.rejects(
						() => nativeClient.update({}),
						/Datastore transaction native store reads cannot perform SDK writes/
					);
					await assert.rejects(
						() => nativeClient.delete({}),
						/Datastore transaction native store reads cannot perform SDK writes/
					);
					await nativeClient.runQuery(query);
					return { list: [{ id: 4, handle: 'native-tx' }] };
				}
			}
		});
		assert.deepEqual(nativeResult.list, [{ id: 4, handle: 'native-tx' }]);
		const nativeAggregate = await tx.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'count' }],
			native: {
				payload: async ({ client: nativeClient }: { client: any }) => {
					calls[calls.length] = 'native.aggregate.payload';
					await assert.rejects(
						() => nativeClient.insert({}),
						/Datastore transaction native store reads cannot perform SDK writes/
					);
					await assert.rejects(
						() => nativeClient.update({}),
						/Datastore transaction native store reads cannot perform SDK writes/
					);
					await assert.rejects(
						() => nativeClient.delete({}),
						/Datastore transaction native store reads cannot perform SDK writes/
					);
					await nativeClient.runAggregationQuery({});
					return { count: 8 };
				}
			}
		});
		assert.deepEqual(nativeAggregate, { count: 8 });
		await tx.create(meta, 1, { id: 1, handle: 'one' });
		assert.equal((await tx.get(meta, 1))?.handle, 'one');
		await tx.update(meta, 1, { id: 1, handle: 'updated' });
		assert.equal((await tx.get(meta, 1))?.handle, 'updated');
		await assert.rejects(
			() => tx.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					payload: () => assert.fail('dirty transaction native query payload should not run')
				}
			}),
			/Datastore transaction native store reads cannot run after buffered writes/
		);
		await assert.rejects(
			() => tx.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				native: {
					payload: () => assert.fail('dirty transaction native aggregate payload should not run')
				}
			}),
			/Datastore transaction native store reads cannot run after buffered writes/
		);
		await tx.query(meta, { where: [], or: [], sort: [], include: [] });
		assert.deepEqual(
			await tx.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
			{ count: 1 }
		);
		assert.deepEqual(
			await tx.aggregate!(typedMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'min', field: 'score', as: 'minScore' }]
			}),
			{ minScore: null }
		);
		await tx.delete(meta, 1);
		assert.equal(await tx.get(meta, 1), null);
		await tx.create(meta, 5, { id: 5, handle: 'persisted' });
		assert.equal((await tx.get(meta, 5))?.handle, 'persisted');
		return 'committed';
	});

	assert.equal(result, 'committed');
	assert.deepEqual(calls, [
		'client.transaction',
		'tx.run',
		'native.payload',
		'tx.runQuery',
		'native.aggregate.payload',
		'tx.runAggregationQuery',
		'client.createQuery',
		'tx.runQuery',
		'client.createQuery',
		'tx.runQuery',
		'client.createQuery',
		'tx.runQuery',
		'tx.insert',
		'tx.commit'
	]);
	assert.equal(inserted.length, 1);
	assert.equal(updated.length, 0);
	assert.equal(deleted.length, 0);

	calls.length = 0;
	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.create(meta, 2, { id: 2, handle: 'rolled-back' });
			throw new Error('rollback me');
		}),
		/rollback me/
	);
	assert.deepEqual(calls, ['client.transaction', 'tx.run', 'tx.rollback']);

	calls.length = 0;
	await datastore.transaction!(
		async (tx) => {
			await assert.rejects(
				() => tx.create(meta, 3, { id: 3, handle: 'blocked' }),
				/Datastore transaction is read-only/
			);
		},
		{ readOnly: true }
	);
	assert.deepEqual(calls, [
		'client.transaction:{"readOnly":true}',
		'tx.run:{"readOnly":true}',
		'tx.commit'
	]);

	calls.length = 0;
	await assert.rejects(
		() => datastore.transaction!(
			async (tx) => {
				await tx.get(meta, 1, { native: { payload: 'direct-read' } } as any);
			},
			{ readOnly: true }
		),
		/Datastore transaction is read-only and cannot run native store reads/
	);
	assert.deepEqual(calls, [
		'client.transaction:{"readOnly":true}',
		'tx.run:{"readOnly":true}',
		'tx.rollback'
	]);

	calls.length = 0;
	await assert.rejects(
		() => datastore.transaction!(
			async (tx) => {
				await tx.getMany(meta, [1], { native: { payload: 'direct-read-many' } } as any);
			},
			{ readOnly: true }
		),
		/Datastore transaction is read-only and cannot run native store reads/
	);
	assert.deepEqual(calls, [
		'client.transaction:{"readOnly":true}',
		'tx.run:{"readOnly":true}',
		'tx.rollback'
	]);

	calls.length = 0;
	await assert.rejects(
		() => datastore.transaction!(
			async (tx) => {
				await tx.query(meta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					native: {
						payload: () => {
							calls[calls.length] = 'native.readonly';
							return { list: [] };
						}
					}
				});
			},
			{ readOnly: true }
		),
		/Datastore transaction is read-only and cannot run native store reads/
	);
	assert.deepEqual(calls, [
		'client.transaction:{"readOnly":true}',
		'tx.run:{"readOnly":true}',
		'tx.rollback'
	]);

	calls.length = 0;
	await assert.rejects(
		() => datastore.transaction!(
			async (tx) => {
				await tx.aggregate!(meta, {
					where: [],
					or: [],
					aggregates: [{ op: 'count', as: 'count' }],
					native: {
						payload: () => {
							calls[calls.length] = 'native.readonly.aggregate';
							return { count: 0 };
						}
					}
				});
			},
			{ readOnly: true }
		),
		/Datastore transaction is read-only and cannot run native store reads/
	);
	assert.deepEqual(calls, [
		'client.transaction:{"readOnly":true}',
		'tx.run:{"readOnly":true}',
		'tx.rollback'
	]);

	calls.length = 0;
	nextTransactionBehavior = { runError: new Error('begin failed') };
	await assert.rejects(
		() => datastore.transaction!(async () => assert.fail('callback should not run after begin failure')),
		/begin failed/
	);
	assert.deepEqual(calls, ['client.transaction', 'tx.run']);

	calls.length = 0;
	nextTransactionBehavior = { commitError: new Error('commit failed') };
	await assert.rejects(
		() => datastore.transaction!(async () => 'commit failure'),
		/commit failed/
	);
	assert.deepEqual(calls, ['client.transaction', 'tx.run', 'tx.commit']);

	calls.length = 0;
	const nativeOptions = {
		gaxOptions: { timeout: 1000 },
		commitGaxOptions: { timeout: 2000 },
		rollbackGaxOptions: { timeout: 3000 }
	};
	await datastore.transaction!(async () => {
		nativeOptions.commitGaxOptions.timeout = 9000;
		return 'native commit';
	}, { native: nativeOptions });
	assert.deepEqual(calls, [
		'client.transaction',
		'tx.run:{"gaxOptions":{"timeout":1000}}',
		'tx.commit:{"timeout":2000}'
	]);

	calls.length = 0;
	await assert.rejects(
		() => datastore.transaction!(async () => {
			throw new Error('native rollback');
		}, {
			native: {
				gaxOptions: { timeout: 1100 },
				rollbackGaxOptions: { timeout: 3300 }
			}
		}),
		/native rollback/
	);
	assert.deepEqual(calls, [
		'client.transaction',
		'tx.run:{"gaxOptions":{"timeout":1100}}',
		'tx.rollback:{"timeout":3300}'
	]);
});

test('Datastore read-only direct transactions expose adapter namespace', async () => {
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'readonly_tenant',
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => [null],
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				createAggregationQuery: () => assert.fail('read-only namespace test should not aggregate'),
				runAggregationQuery: async () => assert.fail('read-only namespace test should not aggregate'),
				insert: async () => assert.fail('read-only namespace test should not write'),
				update: async () => assert.fail('read-only namespace test should not write'),
				delete: async () => assert.fail('read-only namespace test should not write')
			}),
			createQuery: () => assert.fail('read-only namespace test should not query root'),
			createAggregationQuery: () => assert.fail('read-only namespace test should not aggregate root'),
			runAggregationQuery: async () => assert.fail('read-only namespace test should not aggregate root')
		})
	});

	await datastore.transaction!(
		async (tx) => {
			assert.equal(tx.datastoreNamespace, 'readonly_tenant');
			assert.equal(storeTrustsDatastoreEntityKeyRows(tx), true);
		},
		{ readOnly: true }
	);
});

test('Datastore ancestor-transaction mode rejects unscoped portable transaction queries', async () => {
	const calls: string[] = [];
	const parent = datastoreKey('parent_record', 10);
	const query = {
		hasAncestor(key: unknown) {
			calls[calls.length] = `hasAncestor:${JSON.stringify(key)}`;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: (...args: unknown[]) => {
				calls[calls.length] = `createQuery:${JSON.stringify(args)}`;
				return query;
			},
			transaction: () => ({
				run: async (options?: unknown) => {
					calls[calls.length] = options === undefined ? 'run' : `run:${JSON.stringify(options)}`;
				},
				commit: async () => {
					calls[calls.length] = 'commit';
				},
				rollback: async () => {
					calls[calls.length] = 'rollback';
				},
				get: async () => [null],
				runQuery: async () => {
					calls[calls.length] = 'runQuery';
					return [[{ id: 1, parentId: 10, handle: 'scoped' }], { moreResults: 'NO_MORE_RESULTS' }];
				},
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		}),
		allowAggregateScanFallback: true,
		requireAncestorTransactionQueries: true
	});

	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.query(meta, { where: [], or: [], sort: [], include: [] });
		}),
		/requires meta\.datastoreAncestor/
	);
	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.aggregate!(meta, { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] });
		}),
		/requires meta\.datastoreAncestor/
	);
	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.query(meta, { where: [], or: [], sort: [], include: [] });
		}, { readOnly: true }),
		/requires meta\.datastoreAncestor/
	);
	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.aggregate!(meta, { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] });
		}, { readOnly: true }),
		/requires meta\.datastoreAncestor/
	);
	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: async () => assert.fail('unscoped native transaction query payload should not run') }
			});
		}),
		/requires meta\.datastoreAncestor/
	);
	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				native: { payload: async () => assert.fail('unscoped native transaction aggregate payload should not run') }
			});
		}),
		/requires meta\.datastoreAncestor/
	);
	assert.equal(calls.includes('createQuery:[]'), false);
	assert.equal(calls.includes('runQuery'), false);

	const result = await datastore.transaction!(async (tx) =>
		tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: parent }
		})
	);
	assert.deepEqual(result, { list: [{ id: 1, parentId: 10, handle: 'scoped' }], more: false });
	assert.equal(calls.includes('runQuery'), true);
	assert.equal(
		calls.includes('hasAncestor:{"input":{"path":["parent_record","number:10"]}}'),
		true
	);
	const nativeScopedResult = await datastore.transaction!(async (tx) =>
		tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: parent },
			native: { payload: async () => ({ list: [{ id: 2, parentId: 10, handle: 'native-scoped' }] }) }
		})
	);
	assert.deepEqual(nativeScopedResult.list, [{ id: 2, parentId: 10, handle: 'native-scoped' }]);
});

test('Datastore context transactions forward safe native SDK options', async () => {
	const calls: string[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async (options?: unknown) => {
					calls[calls.length] = options === undefined
						? 'tx.run'
						: `tx.run:${JSON.stringify(options)}`;
				},
				commit: async (options?: unknown) => {
					calls[calls.length] = options === undefined
						? 'tx.commit'
						: `tx.commit:${JSON.stringify(options)}`;
				},
				rollback: async (options?: unknown) => {
					calls[calls.length] = options === undefined
						? 'tx.rollback'
						: `tx.rollback:${JSON.stringify(options)}`;
				},
				get: async () => [null],
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const nativeOptions = {
		gaxOptions: { timeout: 1000 },
		commitGaxOptions: { timeout: 2000 },
		rollbackGaxOptions: { timeout: 3000 }
	};

	const result = await context.transaction(async () => {
		nativeOptions.commitGaxOptions.timeout = 9000;
		return 'context-native';
	}, { native: nativeOptions });

	assert.equal(result, 'context-native');
	assert.deepEqual(calls, [
		'tx.run:{"gaxOptions":{"timeout":1000}}',
		'tx.commit:{"timeout":2000}'
	]);

	calls.length = 0;
	await assert.rejects(
		() =>
			context.transaction(async () => {
				throw new Error('context native rollback');
			}, {
				native: {
					gaxOptions: { timeout: 1100 },
					rollbackGaxOptions: { timeout: 3300 }
				}
			}),
		/context native rollback/
	);
	assert.deepEqual(calls, [
		'tx.run:{"gaxOptions":{"timeout":1100}}',
		'tx.rollback:{"timeout":3300}'
	]);
});

test('Datastore low-level transaction adapters close after callbacks settle', async () => {
	const transaction = {
		run: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined,
		get: async () => [null],
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		insert: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => transaction
		})
	});
	let leaked!: StoreAdapter;

	await datastore.transaction!(async (tx) => {
		leaked = tx;
	});

	await assert.rejects(
		() => leaked.query(meta, { where: [], or: [], sort: [], include: [] }),
		/closed Datastore store transaction adapter after callback finished/
	);
});

test('Datastore transactions finish operations started before callbacks settle', async () => {
	const calls: string[] = [];
	let releaseRead!: () => void;
	const holdRead = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let callbackReturned!: () => void;
	const callbackDidReturn = new Promise<void>((resolve) => {
		callbackReturned = resolve;
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => {
					calls[calls.length] = 'run';
				},
				commit: async () => {
					calls[calls.length] = 'commit';
				},
				rollback: async () => {
					calls[calls.length] = 'rollback';
				},
				get: async () => {
					calls[calls.length] = 'get';
					await holdRead;
					return [null];
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => {
					calls[calls.length] = 'insert';
				},
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	let pendingCreate!: Promise<void>;

	const pendingTransaction = datastore.transaction!(async (tx) => {
		pendingCreate = tx.create(meta, 1, { id: 1, handle: 'pending' });
		callbackReturned();
	});
	await callbackDidReturn;
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseRead();
	await pendingTransaction;
	await pendingCreate;

	assert.deepEqual(calls, ['run', 'get', 'insert', 'commit']);
});

test('Datastore transactions drain and close native transaction clients', async () => {
	const calls: string[] = [];
	let releaseNativeRead!: () => void;
	const holdNativeRead = new Promise<void>((resolve) => {
		releaseNativeRead = resolve;
	});
	let callbackReturned!: () => void;
	const callbackDidReturn = new Promise<void>((resolve) => {
		callbackReturned = resolve;
	});
	const transaction = {
		run: async () => {
			calls.push('run');
		},
		commit: async () => {
			calls.push('commit');
		},
		rollback: async () => {
			calls.push('rollback');
		},
		get: async () => {
			calls.push('get:start');
			await holdNativeRead;
			calls.push('get:finish');
			return [null];
		},
		runQuery: async () => {
			calls.push('runQuery:start');
			await holdNativeRead;
			calls.push('runQuery:finish');
			return [[], { moreResults: 'NO_MORE_RESULTS' }];
		},
		runAggregationQuery: async () => {
			calls.push('runAggregationQuery:start');
			await holdNativeRead;
			calls.push('runAggregationQuery:finish');
			return [[{ count: 0 }], {}];
		},
		insert: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => transaction
		})
	});
	let retainedNativeClient: any;

	const pendingTransaction = datastore.transaction!(async (tx) => {
		await tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
				native: {
				payload: async ({ client }: { client: any }) => {
					retainedNativeClient = client;
					await assert.rejects(
						() => client.get({}, () => undefined),
						/Datastore transaction native client\.get does not support callback overloads/
					);
					await assert.rejects(
						() => client.runQuery({}, () => undefined),
						/Datastore transaction native client\.runQuery does not support callback overloads/
					);
					await assert.rejects(
						() => client.runAggregationQuery({}, () => undefined),
						/Datastore transaction native client\.runAggregationQuery does not support callback overloads/
					);
					void client.get({});
					void client.runQuery({});
					void client.runAggregationQuery({});
					return { list: [] };
				}
			}
		});
		callbackReturned();
	});
	await callbackDidReturn;
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		assert.deepEqual(calls, ['run', 'get:start', 'runQuery:start', 'runAggregationQuery:start']);
	} finally {
		releaseNativeRead();
	}
	await pendingTransaction;
	assert.deepEqual(calls, [
		'run',
		'get:start',
		'runQuery:start',
		'runAggregationQuery:start',
		'get:finish',
		'runQuery:finish',
		'runAggregationQuery:finish',
		'commit'
	]);

	await assert.rejects(
		() => retainedNativeClient.get({}),
		/closed Datastore store transaction after callback finished/
	);
	await assert.rejects(
		() => retainedNativeClient.runQuery({}),
		/closed Datastore store transaction after callback finished/
	);
	await assert.rejects(
		() => retainedNativeClient.runAggregationQuery({}),
		/closed Datastore store transaction after callback finished/
	);
	await assert.rejects(
		() => retainedNativeClient.insert({}),
		/closed Datastore store transaction after callback finished/
	);
	assert.deepEqual(retainedNativeClient.key({ path: ['record', 1] }), { path: ['record', 1] });
	const postCloseQuery = retainedNativeClient.createQuery('record');
	await assert.rejects(
		() => postCloseQuery.run(),
		/closed Datastore store transaction after callback finished/
	);
	assert.deepEqual(calls, [
		'run',
		'get:start',
		'runQuery:start',
		'runAggregationQuery:start',
		'get:finish',
		'runQuery:finish',
		'runAggregationQuery:finish',
		'commit'
	]);
});

test('Datastore native builders stay transaction-scoped and tracked during drain', async () => {
	const calls: string[] = [];
	let markPayloadStarted!: () => void;
	const payloadStarted = new Promise<void>((resolve) => {
		markPayloadStarted = resolve;
	});
	let releasePayload!: () => void;
	const holdPayload = new Promise<void>((resolve) => {
		releasePayload = resolve;
	});
	const rawQuery = {
		filters: [] as Array<{ field: string; op: string; value: unknown }>,
		filter(field: string, op: string, value: unknown) {
			calls.push('query.filter');
			this.filters.push({ field, op, value });
			return this;
		},
		async run() {
			calls.push('root query.run');
			return [[], { moreResults: 'NO_MORE_RESULTS' }];
		},
		runStream() {
			calls.push('root query.runStream');
			throw new Error('root query stream escaped transaction guard');
		}
	};
	const rawAggregateQuery = {
		count() {
			calls.push('aggregate.count');
			return this;
		},
		async run() {
			calls.push('root aggregate.run');
			return [[{ count: 1 }], {}];
		}
	};
	const transaction = {
		run: async () => {
			calls.push('run');
		},
		commit: async () => {
			calls.push('commit');
		},
		rollback: async () => {
			calls.push('rollback');
		},
		get: async () => [null],
		createQuery: () => {
			calls.push('tx.createQuery');
			return rawQuery;
		},
		createAggregationQuery: (query: unknown) => {
			assert.equal(query, rawQuery);
			calls.push('tx.createAggregationQuery');
			return rawAggregateQuery;
		},
		runQuery: async (query: unknown) => {
			assert.equal(query, rawQuery);
			calls.push('tx.runQuery');
			return [[], { moreResults: 'NO_MORE_RESULTS' }];
		},
		runAggregationQuery: async (query: unknown) => {
			assert.equal(query, rawAggregateQuery);
			calls.push('tx.runAggregationQuery');
			return [[{ count: 1 }], {}];
		},
		insert: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => transaction,
			createQuery: () => assert.fail('root createQuery should not run for native transaction builders')
		})
	});
	let retainedQuery: any;
	let retainedAggregateQuery: any;

	const pendingTransaction = datastore.transaction!(async (tx) => {
		void tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: async ({ client }: { client: any }) => {
					calls.push('payload:start');
					markPayloadStarted();
					await holdPayload;
					const query = client.createQuery('record').filter('handle', '=', 'one');
					retainedQuery = query;
					assert.equal(query.scope, client);
					assert.equal(Object.getPrototypeOf(query), null);
					assert.equal(query.__proto__, undefined);
					assert.equal(Object.getOwnPropertyDescriptor(query, 'scope'), undefined);
					query.filter('self', '=', query);
					assert.equal(query.filters[1].value, query);
					assert.equal(query.filters[1].value.scope, client);
					assert.throws(
						() => query.runStream(),
						/Datastore transaction native query builder\.runStream is not supported/
					);
					await assert.rejects(
						() => query.run(() => undefined),
						/Datastore transaction native client\.runQuery does not support callback overloads/
					);
					await query.run();
					const aggregateQuery = client.createAggregationQuery(query).count('count');
					retainedAggregateQuery = aggregateQuery;
					assert.equal(aggregateQuery.query, query);
					assert.equal(Object.getPrototypeOf(aggregateQuery), null);
					assert.equal(Object.getOwnPropertyDescriptor(aggregateQuery, 'query'), undefined);
					await aggregateQuery.run();
					return { list: [] };
				}
			}
		});
	});
	await payloadStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		assert.deepEqual(calls, ['run', 'payload:start']);
	} finally {
		releasePayload();
	}
	await pendingTransaction;
	assert.deepEqual(calls, [
		'run',
		'payload:start',
		'tx.createQuery',
		'query.filter',
		'query.filter',
		'tx.runQuery',
		'tx.createAggregationQuery',
		'aggregate.count',
		'tx.runAggregationQuery',
		'commit'
	]);

	await assert.rejects(
		() => retainedQuery.run(),
		/closed Datastore store transaction after callback finished/
	);
	await assert.rejects(
		() => retainedAggregateQuery.run(),
		/closed Datastore store transaction after callback finished/
	);
	assert.deepEqual(calls, [
		'run',
		'payload:start',
		'tx.createQuery',
		'query.filter',
		'query.filter',
		'tx.runQuery',
		'tx.createAggregationQuery',
		'aggregate.count',
		'tx.runAggregationQuery',
		'commit'
	]);
});

test('Datastore native builder facades hide root fallback scopes', async () => {
	const calls: string[] = [];
	let rootRunQueryCalls = 0;
	const rootScope = {
		async runQuery(_query?: unknown) {
			rootRunQueryCalls++;
			return [[], { moreResults: 'NO_MORE_RESULTS' }];
		}
	};
	const rawQuery = {
		scope: rootScope,
		filter() {
			return this;
		},
		run() {
			return this.scope.runQuery(this);
		}
	};
	const transaction = {
		run: async () => {
			calls.push('run');
		},
		commit: async () => {
			calls.push('commit');
		},
		rollback: async () => {
			calls.push('rollback');
		},
		get: async () => [null],
		runQuery: async (query: unknown) => {
			assert.equal(query, rawQuery);
			calls.push('tx.runQuery');
			return [[], { moreResults: 'NO_MORE_RESULTS' }];
		},
		insert: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => transaction,
			createQuery: () => rawQuery
		})
	});
	let retainedQuery: any;

	await datastore.transaction!(async (tx) => {
		await tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: async ({ client }: { client: any }) => {
					const query = client.createQuery('record').filter('handle', '=', 'one');
					retainedQuery = query;
					assert.equal(query.scope, client);
					assert.equal(Object.getPrototypeOf(query), null);
					assert.equal(Object.getOwnPropertyDescriptor(query, 'scope'), undefined);
					await query.run();
					return { list: [] };
				}
			}
		});
	});

	assert.equal(rootRunQueryCalls, 0);
	assert.deepEqual(calls, ['run', 'tx.runQuery', 'commit']);
	await assert.rejects(
		() => retainedQuery.run(),
		/closed Datastore store transaction after callback finished/
	);
	assert.equal(rootRunQueryCalls, 0);
});

test('Datastore transactions roll back ignored native client read failures', async () => {
	const calls: string[] = [];
	const nativeReadError = new Error('native transaction read failed');
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => {
					calls.push('run');
				},
				commit: async () => {
					calls.push('commit');
				},
				rollback: async () => {
					calls.push('rollback');
				},
				get: async () => [null],
				runQuery: async () => {
					calls.push('runQuery');
					throw nativeReadError;
				},
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
					await tx.query(meta, {
						where: [],
						or: [],
						sort: [],
						include: [],
						native: {
							payload: ({ client }: { client: any }) => {
								void client.runQuery({});
								return { list: [] };
							}
						}
					});
				}),
		(error: unknown) => error === nativeReadError
	);
	assert.deepEqual(calls, ['run', 'runQuery', 'rollback']);
});

test('Datastore transactions roll back ignored native client write rejections', async () => {
	const calls: string[] = [];
	let sdkInsertCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => {
					calls.push('run');
				},
				commit: async () => {
					calls.push('commit');
				},
				rollback: async () => {
					calls.push('rollback');
				},
				get: async () => [null],
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => {
					sdkInsertCalls++;
				},
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
					await tx.query(meta, {
						where: [],
						or: [],
						sort: [],
						include: [],
						native: {
							payload: ({ client }: { client: any }) => {
								void client.insert({});
								return { list: [] };
							}
						}
					});
				}),
		/Datastore transaction native store reads cannot perform SDK writes/
	);
	assert.equal(sdkInsertCalls, 0);
	assert.deepEqual(calls, ['run', 'rollback']);
});

test('Datastore transactions roll back when an in-flight callback operation fails', async () => {
	const calls: string[] = [];
	let releaseRead!: () => void;
	const holdRead = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let callbackReturned!: () => void;
	const callbackDidReturn = new Promise<void>((resolve) => {
		callbackReturned = resolve;
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => {
					calls[calls.length] = 'run';
				},
				commit: async () => {
					calls[calls.length] = 'commit';
				},
				rollback: async () => {
					calls[calls.length] = 'rollback';
				},
				get: async () => {
					calls[calls.length] = 'get';
					await holdRead;
					throw new Error('pending read failed');
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => {
					calls[calls.length] = 'insert';
				},
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	let pendingCreate!: Promise<void>;
	let leaked!: StoreAdapter;

	const pendingTransaction = datastore.transaction!(async (tx) => {
		leaked = tx;
		pendingCreate = tx.create(meta, 1, { id: 1, handle: 'pending' });
		void pendingCreate.catch(() => undefined);
		callbackReturned();
	});
	await callbackDidReturn;
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseRead();
	const [transactionResult, createResult] = await Promise.allSettled([
		pendingTransaction,
		pendingCreate
	]);

	assert.equal(transactionResult.status, 'rejected');
	if (transactionResult.status === 'rejected') {
		assert.match(String(transactionResult.reason), /pending read failed/);
	}
	assert.equal(createResult.status, 'rejected');
	assert.deepEqual(calls, ['run', 'get', 'rollback']);
	await assert.rejects(
		() => leaked.get(meta, 1),
		/closed Datastore store transaction adapter after rollback/
	);
});

test('Datastore transactions serialize concurrent creates for the same entity', async () => {
	const inserted: Array<{ data: GoogleRegressionData }> = [];
	let existenceReads = 0;
	let markReadStarted!: () => void;
	let releaseRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markReadStarted = resolve;
	});
	const holdRead = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => {
					existenceReads++;
					markReadStarted();
					await holdRead;
					return [null];
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async (entity: { data: GoogleRegressionData }) => {
					inserted[inserted.length] = entity;
				},
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	const outcomes = await datastore.transaction!(async (tx) => {
		const first = tx.create(meta, 1, { id: 1, handle: 'first' });
		await readStarted;
		const second = tx.create(meta, 1, { id: 1, handle: 'second' });
		releaseRead();
		return Promise.allSettled([first, second]);
	});

	assert.equal(existenceReads, 1);
	assert.equal(outcomes[0].status, 'fulfilled');
	assert.equal(outcomes[1].status, 'rejected');
	if (outcomes[1].status === 'rejected') {
		assert.ok(outcomes[1].reason instanceof ActiveTsConflictError);
	}
	assert.deepEqual(inserted.map((entity) => entity.data), [{ id: 1, handle: 'first' }]);
});

test('Datastore transaction direct reads wait for earlier same-entity mutations', async () => {
	let getCalls = 0;
	let markExistenceReadStarted!: () => void;
	const existenceReadStarted = new Promise<void>((resolve) => {
		markExistenceReadStarted = resolve;
	});
	let releaseExistenceRead!: () => void;
	const holdExistenceRead = new Promise<void>((resolve) => {
		releaseExistenceRead = resolve;
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async (input: unknown) => {
					getCalls++;
					if (getCalls === 1) {
						markExistenceReadStarted();
						await holdExistenceRead;
					}
					return Array.isArray(input) ? [[]] : [null];
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	await datastore.transaction!(async (tx) => {
		const create = tx.create(meta, 1, { id: 1, handle: 'created' });
		await existenceReadStarted;
		let directReadSettled = false;
		let batchReadSettled = false;
		const directRead = tx.get(meta, 1).then((row) => {
			directReadSettled = true;
			return row;
		});
		const batchRead = tx.getMany(meta, [1, 2]).then((rows) => {
			batchReadSettled = true;
			return rows;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.equal(directReadSettled, false);
			assert.equal(batchReadSettled, false);
		} finally {
			releaseExistenceRead();
		}
		await create;
		assert.deepEqual(await directRead, { id: 1, handle: 'created' });
		assert.deepEqual(await batchRead, [{ id: 1, handle: 'created' }, null]);
	});

	assert.equal(getCalls, 2);
});

test('Datastore transaction queries wait for earlier buffered mutations', async () => {
	let queryCalls = 0;
	let nativeQueryCalls = 0;
	let markExistenceReadStarted!: () => void;
	const existenceReadStarted = new Promise<void>((resolve) => {
		markExistenceReadStarted = resolve;
	});
	let releaseExistenceRead!: () => void;
	const holdExistenceRead = new Promise<void>((resolve) => {
		releaseExistenceRead = resolve;
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => {
					markExistenceReadStarted();
					await holdExistenceRead;
					return [null];
				},
				runQuery: async () => {
					queryCalls++;
					return [[], { moreResults: 'NO_MORE_RESULTS' }];
				},
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	await datastore.transaction!(async (tx) => {
		const create = tx.create(meta, 1, { id: 1, handle: 'created' });
		await existenceReadStarted;
		let querySettled = false;
		let nativeQuerySettled = false;
		const query = tx.query(meta, { where: [], or: [], sort: [], include: [] }).then((result) => {
			querySettled = true;
			return result;
		});
		const nativeQuery = tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: () => {
					nativeQueryCalls++;
					return { list: [] };
				}
			}
		}).finally(() => {
			nativeQuerySettled = true;
		});
		void nativeQuery.catch(() => undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.equal(querySettled, false);
			assert.equal(nativeQuerySettled, false);
			assert.equal(queryCalls, 0);
			assert.equal(nativeQueryCalls, 0);
		} finally {
			releaseExistenceRead();
		}
		await create;
		assert.deepEqual(await query, {
			list: [{ id: 1, handle: 'created' }],
			more: false
		});
		await assert.rejects(
			() => nativeQuery,
			/Datastore transaction native store reads cannot run after buffered writes/
		);
	});

	assert.equal(queryCalls, 1);
	assert.equal(nativeQueryCalls, 0);
});

test('Datastore transaction reads recover after an earlier mutation rejects', async () => {
	let getCalls = 0;
	let nativeQueryCalls = 0;
	let markExistenceReadStarted!: () => void;
	const existenceReadStarted = new Promise<void>((resolve) => {
		markExistenceReadStarted = resolve;
	});
	let releaseExistenceRead!: () => void;
	const holdExistenceRead = new Promise<void>((resolve) => {
		releaseExistenceRead = resolve;
	});
	const existing = { id: 1, handle: 'existing' };
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => {
					getCalls++;
					if (getCalls === 1) {
						markExistenceReadStarted();
						await holdExistenceRead;
					}
					return [existing];
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	await datastore.transaction!(async (tx) => {
		const create = tx.create(meta, 1, { id: 1, handle: 'duplicate' });
		void create.catch(() => undefined);
		await existenceReadStarted;
		let directReadSettled = false;
		let nativeQuerySettled = false;
		const directRead = tx.get(meta, 1).finally(() => {
			directReadSettled = true;
		});
		const nativeQuery = tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: () => {
					nativeQueryCalls++;
					return { list: [existing] };
				}
			}
		}).finally(() => {
			nativeQuerySettled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.equal(directReadSettled, false);
			assert.equal(nativeQuerySettled, false);
		} finally {
			releaseExistenceRead();
		}
		const [createOutcome, readOutcome, nativeOutcome] = await Promise.allSettled([
			create,
			directRead,
			nativeQuery
		]);
		assert.equal(createOutcome.status, 'rejected');
		if (createOutcome.status === 'rejected') {
			assert.ok(createOutcome.reason instanceof ActiveTsConflictError);
		}
		assert.deepEqual(readOutcome, { status: 'fulfilled', value: existing });
		assert.equal(nativeOutcome.status, 'fulfilled');
		if (nativeOutcome.status === 'fulfilled') {
			assert.deepEqual(nativeOutcome.value.list, [existing]);
		}
	});

	assert.equal(getCalls, 2);
	assert.equal(nativeQueryCalls, 1);
});

test('Datastore transaction direct reads keep different ancestor identities concurrent', async () => {
	let getCalls = 0;
	let markExistenceReadStarted!: () => void;
	const existenceReadStarted = new Promise<void>((resolve) => {
		markExistenceReadStarted = resolve;
	});
	let releaseExistenceRead!: () => void;
	const holdExistenceRead = new Promise<void>((resolve) => {
		releaseExistenceRead = resolve;
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => {
					getCalls++;
					if (getCalls === 1) {
						markExistenceReadStarted();
						await holdExistenceRead;
					}
					return [null];
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});

	await datastore.transaction!(async (tx) => {
		const create = tx.create(ancestorMeta, 1, { id: 1, parentId: 1, handle: 'created' });
		await existenceReadStarted;
		let otherAncestorReadSettled = false;
		const otherAncestorRead = tx.get(ancestorMeta, 1, {
			meta: { datastoreAncestor: datastoreKey('parent_record', 2) }
		}).then((row) => {
			otherAncestorReadSettled = true;
			return row;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.equal(otherAncestorReadSettled, true);
			assert.equal(await otherAncestorRead, null);
		} finally {
			releaseExistenceRead();
		}
		await create;
	});

	assert.equal(getCalls, 2);
});

test('Datastore transaction queries and aggregates include buffered writes', async () => {
	const inserted: unknown[] = [];
	const updated: unknown[] = [];
	const deleted: unknown[] = [];
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const client = datastoreClient({
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async (key: any) => {
				const id = key?.path?.[key.path.length - 1];
				if (id === 'number:1') return [{ id: 1, handle: 'old', score: 10 }];
				if (id === 'number:2') return [{ id: 2, handle: 'delete', score: 20 }];
				return [null];
			},
			runQuery: async () => [[
				{ id: 1, handle: 'old', score: 10 },
				{ id: 2, handle: 'delete', score: 20 }
			], { moreResults: 'NO_MORE_RESULTS' }],
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async (entity: unknown) => {
				inserted[inserted.length] = entity;
			},
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			},
			delete: async (key: unknown) => {
				deleted[deleted.length] = key;
			}
		}),
		createAggregationQuery: () => assert.fail('root aggregate query should not run inside transaction'),
		runAggregationQuery: async () => assert.fail('root aggregate query should not run inside transaction')
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await datastore.transaction!(async (tx) => {
		await tx.update(typedMeta, 1, { id: 1, handle: 'updated', score: 30 });
		await tx.delete(typedMeta, 2);
		await tx.create(typedMeta, 3, { id: 3, handle: 'created', score: 40 });

		assert.deepEqual(
			await tx.query(typedMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				select: ['handle', 'score']
			}, { select: ['id', 'handle', 'score'] }),
			{
				list: [
					{ id: 1, handle: 'updated', score: 30 },
					{ id: 3, handle: 'created', score: 40 }
				],
				more: false
			}
		);
		assert.deepEqual(
			await tx.aggregate!(typedMeta, {
				where: [],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'totalScore' },
					{ op: 'max', field: 'score', as: 'maxScore' }
				]
			}),
			{ count: 2, totalScore: 70, maxScore: 40 }
		);
	});

	assert.equal(updated.length, 1);
	assert.equal(deleted.length, 1);
	assert.equal(inserted.length, 1);
});

test('Datastore transaction query overlay preserves encoded field-codec predicates', async () => {
	const filters: unknown[][] = [];
	const query = {
		filter(field: unknown, op: unknown, value: unknown) {
			filters[filters.length] = [field, op, value];
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const codecMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldCodecs: new Map([[
			'handle',
			{
				name: 'stored-handle',
				encode: (value: unknown) => `stored:${String(value)}`,
				decode: (value: unknown) => String(value).slice('stored:'.length),
				encodeQuery: (value: unknown) => `stored:${String(value)}`
			}
		]])
	};
	const client = datastoreClient({
		createQuery: () => query,
		createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
		runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[
				{ id: 1, handle: 'stored:alpha' }
			], { moreResults: 'NO_MORE_RESULTS' }],
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const queryPlan = encodeQueryPlanFieldCodecs(codecMeta, {
		where: [{ field: 'handle', op: '=', value: 'alpha' }],
		or: [],
		sort: [],
		include: []
	});
	const aggregatePlan = encodeAggregatePlanFieldCodecs(codecMeta, {
		where: [{ field: 'handle', op: '=', value: 'alpha' }],
		or: [],
		aggregates: [{ op: 'count', as: 'count' }]
	});

	await datastore.transaction!(async (tx) => {
		assert.deepEqual(await tx.query(codecMeta, queryPlan), {
			list: [{ id: 1, handle: 'stored:alpha' }],
			more: false
		});
		assert.deepEqual(await tx.aggregate!(codecMeta, aggregatePlan), { count: 1 });
	});

	assert.deepEqual(filters, [
		['handle', '=', 'stored:alpha'],
		['handle', '=', 'stored:alpha']
	]);
});

test('Datastore transaction scoped ancestor overlay matches adapter namespaces', async () => {
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const client = datastoreClient({
		createQuery: () => query,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, namespace: 'tenant' });
	const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });

	await datastore.transaction!(async (tx) => {
		await tx.create(ancestorMeta, 1, { id: 1, parentId: 10, handle: 'created' });
		assert.deepEqual(
			await tx.query(ancestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: parent }
			}),
			{
				list: [{ id: 1, parentId: 10, handle: 'created' }],
				more: false
			}
		);
	});
});

test('Datastore transaction scoped ancestor overlay applies adapter namespace before matching', async () => {
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const namespacedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number }> = {
		...ancestorMeta,
		datastore: {
			ancestor: ({ data }) => data
				? datastoreKey('parent_record', data.parentId, { namespace: 'tenant' })
				: undefined
		}
	};
	const client = datastoreClient({
		createQuery: () => query,
		createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
		runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, namespace: 'tenant' });
	const parent = datastoreKey('parent_record', 10);

	await datastore.transaction!(async (tx) => {
		await tx.create(namespacedAncestorMeta, 1, { id: 1, parentId: 10, handle: 'created' });
		assert.deepEqual(
			await tx.query(namespacedAncestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: parent }
			}),
			{
				list: [{ id: 1, parentId: 10, handle: 'created' }],
				more: false
			}
		);
		assert.deepEqual(
			await tx.aggregate!(namespacedAncestorMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				meta: { datastoreAncestor: parent }
			}),
			{ count: 1 }
		);
	});
});

test('Datastore transaction scoped ancestor overlay keeps explicit namespaces isolated', async () => {
	const tenantParent = datastoreKey('parent_record', 10, { namespace: 'tenant' });
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const client = datastoreClient({
		createQuery: () => query,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await datastore.transaction!(async (tx) => {
		await tx.create(ancestorMeta, 1, { id: 1, parentId: 10, handle: 'default-namespace' });
		assert.deepEqual(
			await tx.query(ancestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: tenantParent }
			}),
			{ list: [], more: false }
		);
	});
});

test('Datastore transaction scoped ancestor overlay rejects backend rows outside scoped ancestors', async () => {
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']])
	};
	const scopedAncestor = datastoreKey('parent_record', 10);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	let runQueryCalls = 0;
	const client = datastoreClient({
		createQuery: () => query,
		createAggregationQuery: () => assert.fail('root aggregate query should not run inside transaction'),
		runAggregationQuery: async () => assert.fail('root aggregate query should not run inside transaction'),
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => {
				runQueryCalls++;
				return [[
					{ id: 1, parentId: 11, handle: 'wrong-parent', score: 10 }
				], { moreResults: 'NO_MORE_RESULTS' }];
			},
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await datastore.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.query(typedAncestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: scopedAncestor }
			}),
			/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
		);
		await assert.rejects(
			() => tx.aggregate!(typedAncestorMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				meta: { datastoreAncestor: scopedAncestor }
			}),
			/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
		);
	});

	assert.equal(runQueryCalls, 2);
});

test('Datastore transaction root ancestor overlay preserves descendant identities', async () => {
	const keySymbol = Symbol('datastore-key');
	const descendantMeta = {
		...meta,
		fieldTypes: new Map([['score', 'number']]),
		datastore: {
			ancestor: ({ data }: { data?: GoogleRegressionData & { rootId: number; childId: number } }) => data
				? datastoreKey('child_parent', data.childId, {
						parent: datastoreKey('root_parent', data.rootId)
					})
				: undefined
		}
	} as unknown as ResolvedModelMeta<GoogleRegressionData & { rootId: number; childId: number }>;
	const entity = (data: GoogleRegressionData & { rootId: number; childId: number }) => {
		const row = { ...data };
		Object.defineProperty(row, keySymbol, {
			enumerable: true,
			value: {
				path: [
					'root_parent',
					`number:${data.rootId}`,
					'child_parent',
					`number:${data.childId}`,
					'google_regression_record',
					`number:${data.id}`
				],
				namespace: undefined
			}
		});
		return row;
	};
	const root = datastoreKey('root_parent', 1);
	const left = datastoreKey('child_parent', 10, { parent: root });
	const right = datastoreKey('child_parent', 11, { parent: root });
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: unknown) => input,
		createQuery: () => query,
		createAggregationQuery: () => assert.fail('root aggregate query should not run inside transaction'),
		runAggregationQuery: async () => assert.fail('root aggregate query should not run inside transaction'),
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async (key: any) => {
				const path = Array.isArray(key?.path) ? key.path.join('/') : '';
				if (path === 'root_parent/number:1/child_parent/number:10/google_regression_record/number:5') {
					return [entity({ id: 5, rootId: 1, childId: 10, handle: 'left-old', score: 10 })];
				}
				if (path === 'root_parent/number:1/child_parent/number:11/google_regression_record/number:5') {
					return [entity({ id: 5, rootId: 1, childId: 11, handle: 'right-delete', score: 20 })];
				}
				return [null];
			},
			runQuery: async () => [[
				entity({ id: 5, rootId: 1, childId: 10, handle: 'left-old', score: 10 }),
				entity({ id: 5, rootId: 1, childId: 11, handle: 'right-delete', score: 20 })
			], { moreResults: 'NO_MORE_RESULTS' }],
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, keySymbol });

	await datastore.transaction!(async (tx) => {
		await tx.update(
			descendantMeta,
			5,
			{ id: 5, rootId: 1, childId: 10, handle: 'left-updated', score: 30 },
			{ meta: { datastoreAncestor: left } }
		);
		await tx.delete(descendantMeta, 5, { meta: { datastoreAncestor: right } });
		await tx.create(descendantMeta, 6, { id: 6, rootId: 1, childId: 12, handle: 'created', score: 40 });

		assert.deepEqual(
			await tx.query(descendantMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: root }
			}),
			{
				list: [
					{ id: 5, rootId: 1, childId: 10, handle: 'left-updated', score: 30 },
					{ id: 6, rootId: 1, childId: 12, handle: 'created', score: 40 }
				],
				more: false
			}
		);
		assert.deepEqual(
			await tx.aggregate!(descendantMeta, {
				where: [],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'totalScore' }
				],
				meta: { datastoreAncestor: root }
			}),
			{ count: 2, totalScore: 70 }
		);
	});
});

test('Datastore transaction ancestor delete missing then create replays insert', async () => {
	const calls: string[] = [];
	const inserted: unknown[] = [];
	const parent = datastoreKey('parent_record', 10);
	const client = datastoreClient({
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'run';
			},
			commit: async () => {
				calls[calls.length] = 'commit';
			},
			rollback: async () => {
				calls[calls.length] = 'rollback';
			},
			get: async () => {
				calls[calls.length] = 'get';
				return [null];
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async (entity: unknown) => {
				calls[calls.length] = 'insert';
				inserted[inserted.length] = entity;
			},
			update: async () => assert.fail('missing ancestor delete followed by create must replay insert, not update'),
			delete: async () => {
				calls[calls.length] = 'delete';
			}
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await datastore.transaction!(async (tx) => {
		await tx.delete(ancestorMeta, 99, { meta: { datastoreAncestor: parent } });
		await tx.create(
			ancestorMeta,
			99,
			{ id: 99, parentId: 10, handle: 'created' },
			{ meta: { datastoreAncestor: parent } }
		);
	});

	assert.deepEqual(calls, ['run', 'get', 'get', 'insert', 'commit']);
	assert.equal(inserted.length, 1);
});

test('Datastore transaction ancestor writes reject explicit undefined ancestor metadata', async () => {
	const calls: string[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: () => assert.fail('Datastore key factory should not run for undefined transaction write ancestor metadata'),
			transaction: () => ({
				run: async () => {
					calls[calls.length] = 'run';
				},
				commit: async () => {
					calls[calls.length] = 'commit';
				},
				rollback: async () => {
					calls[calls.length] = 'rollback';
				},
				get: async () => assert.fail('Datastore transaction get should not run for undefined write ancestor metadata'),
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => assert.fail('Datastore transaction insert should not run for undefined write ancestor metadata'),
				update: async () => assert.fail('Datastore transaction update should not run for undefined write ancestor metadata'),
				delete: async () => assert.fail('Datastore transaction delete should not run for undefined write ancestor metadata')
			})
		})
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.create(
					ancestorMeta,
					1,
					{ id: 1, handle: 'one', parentId: 10 },
					{ meta: { datastoreAncestor: undefined } }
				);
			}),
		/write metadata cannot set datastoreAncestor to undefined/
	);
	assert.deepEqual(calls, ['run', 'rollback']);

	calls.length = 0;
	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.update(
					ancestorMeta,
					1,
					{ id: 1, handle: 'two', parentId: 10 },
					{ meta: { datastoreAncestor: undefined } }
				);
			}),
		/write metadata cannot set datastoreAncestor to undefined/
	);
	assert.deepEqual(calls, ['run', 'rollback']);
});

test('Datastore transaction unscoped ancestor queries preserve ancestor identities', async () => {
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']])
	};
	const client = datastoreClient({
		createAggregationQuery: () => assert.fail('root aggregate query should not run inside transaction'),
		runAggregationQuery: async () => assert.fail('root aggregate query should not run inside transaction'),
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async (key: any) => {
				const path = Array.isArray(key?.path) ? key.path.join('/') : '';
				if (path === 'parent_record/number:10/datastore_ancestor_record/number:5') {
					return [{ id: 5, parentId: 10, handle: 'left-old', score: 10 }];
				}
				if (path === 'parent_record/number:11/datastore_ancestor_record/number:5') {
					return [{ id: 5, parentId: 11, handle: 'right-delete', score: 20 }];
				}
				return [null];
			},
			runQuery: async () => [[
				{ id: 5, parentId: 10, handle: 'left-old', score: 10 },
				{ id: 5, parentId: 11, handle: 'right-delete', score: 20 }
			], { moreResults: 'NO_MORE_RESULTS' }],
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const left = datastoreKey('parent_record', 10);
	const right = datastoreKey('parent_record', 11);
	const created = datastoreKey('parent_record', 12);

	await datastore.transaction!(async (tx) => {
		await tx.update(
			typedAncestorMeta,
			5,
			{ id: 5, parentId: 10, handle: 'left-updated', score: 30 },
			{ meta: { datastoreAncestor: left } }
		);
		await tx.delete(typedAncestorMeta, 5, { meta: { datastoreAncestor: right } });
		await tx.create(
			typedAncestorMeta,
			6,
			{ id: 6, parentId: 12, handle: 'created', score: 40 },
			{ meta: { datastoreAncestor: created } }
		);

		assert.deepEqual(
			await tx.query(typedAncestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
			{
				list: [
					{ id: 5, parentId: 10, handle: 'left-updated', score: 30 },
					{ id: 6, parentId: 12, handle: 'created', score: 40 }
				],
				more: false
			}
		);
		assert.deepEqual(
			await tx.aggregate!(typedAncestorMeta, {
				where: [],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'totalScore' }
				]
			}),
			{ count: 2, totalScore: 70 }
		);
	});
});

test('Datastore transaction root overlays hide plain model manual ancestor writes', async () => {
	const manualParent = datastoreKey('manual_parent', 10);
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	let existenceReads = 0;
	const client = datastoreClient({
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => {
				existenceReads++;
				if (existenceReads === 2) return [{ id: 8, handle: 'old-update', score: 11 }];
				if (existenceReads === 3) return [{ id: 9, handle: 'old-delete', score: 22 }];
				return [null];
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		}),
		createAggregationQuery: () => assert.fail('root aggregate query should not run inside transaction'),
		runAggregationQuery: async () => assert.fail('root aggregate query should not run inside transaction')
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await datastore.transaction!(async (tx) => {
		await tx.create(
			typedMeta,
			7,
			{ id: 7, handle: 'manual-ancestor', score: 33 },
			{ meta: { datastoreAncestor: manualParent } }
		);
		await tx.update(
			typedMeta,
			8,
			{ id: 8, handle: 'manual-update', score: 44 },
			{ meta: { datastoreAncestor: manualParent } }
		);
		await tx.delete(typedMeta, 9, { meta: { datastoreAncestor: manualParent } });

		assert.deepEqual(
			await tx.query(typedMeta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
			{ list: [], more: false }
		);
		assert.deepEqual(
			await tx.aggregate!(typedMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
			{ count: 0 }
		);
		assert.deepEqual(
			await tx.query(typedMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: manualParent }
			}),
			{
				list: [
					{ id: 7, handle: 'manual-ancestor', score: 33 },
					{ id: 8, handle: 'manual-update', score: 44 }
				],
				more: false
			}
		);
		assert.deepEqual(
			await tx.aggregate!(typedMeta, {
				where: [],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'totalScore' }
				],
				meta: { datastoreAncestor: manualParent }
			}),
			{ count: 2, totalScore: 77 }
		);
	});
});

test('Datastore transaction unscoped overlays reject key payload ancestor mismatches', async () => {
	const keySymbol = Symbol('datastore-key');
	const mismatchedBackendRow = Object.defineProperty(
		{ id: 1, parentId: 10, handle: 'backend', score: 5 },
		keySymbol,
		{ value: { path: ['parent_record', 11, 'datastore_ancestor_record', 1] } }
	);
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']]),
		datastore: {
			...ancestorMeta.datastore,
			ancestorFields: ['parentId']
		}
	};
	const createStore = async () => createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => [null],
				runQuery: async () => [[mismatchedBackendRow], { moreResults: 'NO_MORE_RESULTS' }],
				createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
				runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const rejection = /payload Datastore ancestor does not match active-ts entity key/;

	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.create(typedAncestorMeta, 1, { id: 1, parentId: 10, handle: 'buffered', score: 8 });
				await tx.query(typedAncestorMeta, {
					where: [],
					or: [],
					sort: [],
					include: []
				});
			});
		},
		rejection
	);
	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.create(typedAncestorMeta, 1, { id: 1, parentId: 10, handle: 'buffered', score: 8 });
				await tx.aggregate!(typedAncestorMeta, {
					where: [],
					or: [],
					aggregates: [
						{ op: 'count', as: 'count' },
						{ op: 'sum', field: 'score', as: 'totalScore' }
					]
				});
			});
		},
		rejection
	);
});

test('Datastore transaction explicit ancestor deletes hide persisted rows without key metadata', async () => {
	const manualParent = datastoreKey('manual_parent', 99);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const client = datastoreClient({
		createQuery: () => query,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [{ id: 1, parentId: 10, handle: 'old' }],
			runQuery: async () => [[
				{ id: 1, parentId: 10, handle: 'old' }
			], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await datastore.transaction!(async (tx) => {
		await tx.delete(ancestorMeta, 1, { meta: { datastoreAncestor: manualParent } });

		assert.deepEqual(
			await tx.query(ancestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: manualParent }
			}),
			{ list: [], more: false }
		);
	});
});

test('Datastore transaction explicit ancestor deletes hide keyed persisted rows before payload validation', async () => {
	const keySymbol = Symbol('datastore-key');
	const manualParent = datastoreKey('parent_record', 10);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const hiddenRow = () => Object.defineProperty(
		{ id: 1, parentId: 11, handle: 'hidden-mismatched-payload' },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1] } }
	);
	const client = datastoreClient({
		KEY: keySymbol,
		createQuery: () => query,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [hiddenRow()],
			runQuery: async () => [[hiddenRow()], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await datastore.transaction!(async (tx) => {
		await tx.delete(ancestorMeta, 1, { meta: { datastoreAncestor: manualParent } });

		assert.deepEqual(
			await tx.query(ancestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: manualParent }
			}),
			{ list: [], more: false }
		);
	});
});

test('Datastore transaction unscoped ancestor overlay rejects duplicate physical identities', async () => {
	const client = datastoreClient({
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[
				{ id: 5, parentId: 10, handle: 'left' },
				{ id: 5, parentId: 10, handle: 'duplicate' }
			], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.query(ancestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: []
			});
		}),
		/duplicate Datastore identity "5"/
	);
});

test('Datastore transaction unscoped ancestor field-codec rows require key metadata', async () => {
	const client = datastoreClient({
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[
				{ id: 1, parentId: 'parent:10', handle: 'stored' }
			], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreEncodedAncestorRecord);

	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			});
		}),
		/requires Datastore entity key metadata/
	);
});

test('Datastore transaction scoped ancestor field-codec rows decode ancestor fields without key metadata', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const calls: string[] = [];
	const row = { id: 1, parentId: 'parent:10', score: 7, handle: 'stored' };
	const client = datastoreClient({
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'run';
			},
			commit: async () => {
				calls[calls.length] = 'commit';
			},
			rollback: async () => {
				calls[calls.length] = 'rollback';
			},
			get: async () => [null],
			runQuery: async () => {
				calls[calls.length] = 'runQuery';
				return [[row], { moreResults: 'NO_MORE_RESULTS' }];
			},
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreEncodedAncestorFieldRecord);

	await datastore.transaction!(async (tx) => {
		assert.deepEqual(
			await tx.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: scopedAncestor }
			}),
			{
				list: [row],
				more: false
			}
		);
	});
	assert.deepEqual(calls, ['run', 'runQuery', 'commit']);
});

test('Datastore transaction scoped keyless rows require declared ancestor fields', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const orphanRow = { id: 1, handle: 'orphan-without-parent', score: 5 };
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		datastore: {
			...ancestorMeta.datastore!,
			ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('parent_record', data.parentId),
			ancestorFields: ['parentId']
		}
	};
	const createStore = async () => createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => [null],
				runQuery: async () => [[orphanRow], { moreResults: 'NO_MORE_RESULTS' }],
				createAggregationQuery: () => assert.fail('transaction aggregate query should not run for overlay aggregates'),
				runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for overlay aggregates'),
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const rejection = /missing Datastore ancestor metadata field "parentId"/;

	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.query(typedAncestorMeta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					meta: { datastoreAncestor: scopedAncestor }
				});
			});
		},
		rejection
	);
	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.aggregate!(typedAncestorMeta, {
					where: [],
					or: [],
					aggregates: [{ op: 'count', as: 'count' }],
					meta: { datastoreAncestor: scopedAncestor }
				});
			});
		},
		rejection
	);
});

test('Datastore transaction unscoped keyless rows require declared ancestor fields', async () => {
	const orphanRow = { id: 1, handle: 'orphan-without-parent', score: 5 };
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		datastore: {
			...ancestorMeta.datastore!,
			ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('parent_record', data.parentId),
			ancestorFields: ['parentId']
		}
	};
	const createStore = async () => createDatastoreStoreAdapter({
		allowAggregateScanFallback: true,
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => [null],
				runQuery: async () => [[orphanRow], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const rejection = /missing Datastore ancestor metadata field "parentId"/;

	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.query(typedAncestorMeta, {
					where: [],
					or: [],
					sort: [],
					include: []
				});
			});
		},
		rejection
	);
	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.aggregate!(typedAncestorMeta, {
					where: [],
					or: [],
					aggregates: [{ op: 'count', as: 'count' }]
				});
			});
		},
		rejection
	);
});

test('Datastore transaction unscoped keyless rows require implicit ancestor metadata', async () => {
	const orphanRow = { id: 1, handle: 'orphan-without-parent', score: 5 };
	const createStore = async () => createDatastoreStoreAdapter({
		allowAggregateScanFallback: true,
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: async () => [null],
				runQuery: async () => [[orphanRow], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const rejection = /missing Datastore ancestor metadata/;

	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.query(ancestorMeta, {
					where: [],
					or: [],
					sort: [],
					include: []
				});
			});
		},
		rejection
	);
	await assert.rejects(
		async () => {
			const datastore = await createStore();
			await datastore.transaction!(async (tx) => {
				await tx.aggregate!(ancestorMeta, {
					where: [],
					or: [],
					aggregates: [{ op: 'count', as: 'count' }]
				});
			});
		},
		rejection
	);
});

test('Datastore transaction unscoped ancestor field-codec rows use key metadata when present', async () => {
	const keySymbol = Symbol('datastore-key');
	const entity = { id: 1, parentId: 'parent:10', handle: 'stored' };
	Object.defineProperty(entity, keySymbol, {
		enumerable: true,
		value: {
			path: ['parent_record', 'number:10', 'datastore_encoded_ancestor_record', 'number:1'],
			namespace: undefined
		}
	});
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: unknown) => input,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[entity], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, keySymbol });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreEncodedAncestorRecord);

	await datastore.transaction!(async (tx) => {
		assert.deepEqual(
			await tx.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
			{
				list: [{ id: 1, parentId: 'parent:10', handle: 'stored' }],
				more: false
			}
		);
	});
});

test('Datastore transaction unscoped ancestor field-codec rows reject key payload mismatches without ancestorFields', async () => {
	const keySymbol = Symbol('datastore-key');
	const entity = { id: 1, parentId: 'parent:11', handle: 'stored-mismatch' };
	Object.defineProperty(entity, keySymbol, {
		enumerable: true,
		value: {
			path: ['parent_record', 'number:10', 'datastore_encoded_ancestor_record', 'number:1'],
			namespace: undefined
		}
	});
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: unknown) => input,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[entity], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, keySymbol });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreEncodedAncestorRecord);

	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			});
		}),
		/payload Datastore ancestor does not match active-ts entity key/
	);
});

test('Datastore transaction selected projections preserve entity key identity', async () => {
	const keySymbol = Symbol('datastore-key');
	const selectCalls: unknown[] = [];
	const entityKey = {
		path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'],
		namespace: undefined
	};
	const entity = { id: 1, parentId: 10, handle: 'stored', body: 'hidden' };
	Object.defineProperty(entity, keySymbol, {
		enumerable: true,
		value: entityKey
	});
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select(fields: unknown) {
			selectCalls[selectCalls.length] = fields;
			return this;
		}
	};
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: unknown) => input,
		createQuery: () => query,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[entity], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, keySymbol });
	const parent = datastoreKey('parent_record', 10);

	await datastore.transaction!(async (tx) => {
		const result = await tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['handle'],
			meta: { datastoreAncestor: parent }
		});
		assert.deepEqual(result, {
			list: [{ id: 1, handle: 'stored' }],
			more: false
		});

		const descriptor = Object.getOwnPropertyDescriptor(result.list[0], ACTIVE_TS_ENTITY_KEY);
		assert.notEqual(descriptor, undefined);
		assert.equal(descriptor?.enumerable, false);
		assert.notEqual(descriptor?.value, entityKey);
		assert.deepEqual(descriptor?.value, entityKey);

		const idOnlyResult = await tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['id'],
			meta: { datastoreAncestor: parent }
		});
		assert.deepEqual(idOnlyResult.list, [{ id: 1 }]);
	});
	assert.deepEqual(selectCalls, []);
});

test('Datastore transaction selected projections preserve buffered mutation identity', async () => {
	const keySymbol = Symbol('datastore-key');
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: unknown) => input,
		createQuery: () => query,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, keySymbol });

	await datastore.transaction!(async (tx) => {
		await tx.create(ancestorMeta, 1, { id: 1, parentId: 10, handle: 'buffered', body: 'hidden' });
		const result = await tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['handle']
		});
		assert.deepEqual(result, {
			list: [{ id: 1, handle: 'buffered' }],
			more: false
		});

		const descriptor = Object.getOwnPropertyDescriptor(result.list[0], ACTIVE_TS_ENTITY_KEY);
		assert.notEqual(descriptor, undefined);
		assert.equal(descriptor?.enumerable, false);
		assert.deepEqual(
			descriptor?.value,
			{
				path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'],
				namespace: undefined
			}
		);
	});
});

test('Datastore transaction aggregate rejects paginated overlay queries', async () => {
	const client = datastoreClient({
		createAggregationQuery: () => assert.fail('root aggregate query should not run inside transaction'),
		runAggregationQuery: async () => assert.fail('root aggregate query should not run inside transaction'),
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[
				{ id: 1, handle: 'one' }
			], { moreResults: 'MORE_RESULTS_AFTER_LIMIT' }],
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			});
		}),
		/cannot aggregate a paginated query result/
	);
});

test('Datastore transaction aggregate rejects incomplete repeated-cursor scans', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const client = datastoreClient({
		createQuery: () => {
			calls[calls.length] = 'createQuery';
			return query;
		},
		createAggregationQuery: () => assert.fail('root aggregate query should not run inside transaction'),
		runAggregationQuery: async () => assert.fail('root aggregate query should not run inside transaction'),
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'tx.run';
			},
			commit: async () => {
				calls[calls.length] = 'tx.commit';
			},
			rollback: async () => {
				calls[calls.length] = 'tx.rollback';
			},
			get: async () => [null],
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls++}`;
				if (runQueryCalls > 2) throw new Error('repeated cursor should fail before a third scan page');
				return [[{ id: runQueryCalls, handle: 'page', optionalMarker: 'set', score: 10 }], {
					moreResults: 'MORE_RESULTS_AFTER_CURSOR',
					endCursor: 'same-cursor'
				}];
			},
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for buffered aggregates'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({
		client,
		allowAggregateScanFallback: true,
		allowQueryScanFallback: true
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.aggregate!(typedMeta, {
					where: [{ field: 'optionalMarker', op: '!=', value: null }],
					or: [],
					aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }]
				});
			}),
		/cannot aggregate a paginated query result/
	);
	assert.deepEqual(calls, [
		'tx.run',
		'createQuery',
		'limit:500',
		'runQuery:0',
		'start:same-cursor',
		'runQuery:1',
		'tx.rollback'
	]);
});

test('Datastore transaction aggregate preserves min max fieldType constraints', async () => {
	let createQueryCalls = 0;
	let txRunQueryCalls = 0;
	const client = datastoreClient({
		createAggregationQuery: () => assert.fail('aggregate query should not run for invalid min/max metadata'),
		runAggregationQuery: async () => assert.fail('aggregate query should not run for invalid min/max metadata'),
		createQuery: () => {
			createQueryCalls++;
			throw new Error('Datastore query should not run for invalid transaction aggregate metadata');
		},
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => {
				txRunQueryCalls++;
				return [[{ id: 1, handle: 'one', score: 10 }], { moreResults: 'NO_MORE_RESULTS' }];
			},
			createAggregationQuery: () => assert.fail('transaction aggregate query should not run for invalid min/max metadata'),
			runAggregationQuery: async () => assert.fail('transaction aggregate query should not run for invalid min/max metadata'),
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const plan: AggregatePlan = {
		where: [],
		or: [],
		aggregates: [{ op: 'max', field: 'score', as: 'maxScore' }]
	};

	await assert.rejects(
		() => datastore.aggregate!(meta, plan),
		/Datastore aggregate "maxScore" requires fieldType metadata for max\("score"\)/
	);
	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.aggregate!(meta, plan);
		}),
		/Datastore aggregate "maxScore" requires fieldType metadata for max\("score"\)/
	);
	assert.equal(createQueryCalls, 0);
	assert.equal(txRunQueryCalls, 0);
});

test('Datastore transaction query overlay preserves inequality limit constraints', async () => {
	let createQueryCalls = 0;
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const client = datastoreClient({
		createQuery: () => {
			createQueryCalls++;
			throw new Error('Datastore query should not run for invalid transaction inequality plan');
		},
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => {
				throw new Error('Datastore runQuery should not run for invalid transaction inequality plan');
			},
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });

	await assert.rejects(
		() => datastore.transaction!(async (tx) => {
			await tx.query(typedMeta, {
				where: [{ field: 'score', op: '>=', value: 10 }],
				or: [],
				sort: [],
				include: [],
				limit: 1
			});
		}),
		/Datastore adapter requires an explicit order on an inequality filter field \(score\) before limit\(\)/
	);
	assert.equal(createQueryCalls, 0);
});

test('Datastore transaction query applies offset after buffered mutation overlay', async () => {
	const queryCalls: string[] = [];
	const query = {
		order(field: string, options: { descending?: boolean }) {
			queryCalls.push(`order:${field}:${options.descending ? 'desc' : 'asc'}`);
			return this;
		},
		offset() {
			assert.fail('Datastore transaction backend query must not apply offset before overlay');
		},
		limit() {
			assert.fail('Datastore transaction backend query must not apply limit before overlay');
		}
	};
	const client = datastoreClient({
		createQuery: () => query,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [
				[
					{ id: 1, handle: 'one', score: 10 },
					{ id: 2, handle: 'two', score: 20 },
					{ id: 3, handle: 'three', score: 30 }
				],
				{ moreResults: 'NO_MORE_RESULTS' }
			],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	let result: Awaited<ReturnType<StoreAdapter['query']>> | undefined;

	await datastore.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.offset, true);
		await tx.create(typedMeta, 0, { id: 0, handle: 'zero', score: 5 });
		result = await tx.query(typedMeta, {
			where: [],
			or: [],
			sort: [{ field: 'score', direction: 'asc' }],
			include: [],
			offset: 1,
			limit: 2
		});
	});

	assert.deepEqual(result?.list.map((row) => row.id), [1, 2]);
	assert.equal(result?.more, true);
	assert.deepEqual(queryCalls, ['order:score:asc', 'order:id:asc']);
});

test('Datastore context transactions route model writes through SDK transactions', async () => {
	const calls: string[] = [];
	const client = datastoreClient({
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'run';
			},
			commit: async () => {
				calls[calls.length] = 'commit';
			},
			rollback: async () => {
				calls[calls.length] = 'rollback';
			},
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => {
				calls[calls.length] = 'insert';
			},
			update: async () => {
				calls[calls.length] = 'update';
			},
			delete: async () => {
				calls[calls.length] = 'delete';
			}
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreTransactionRecord.use(context) as unknown as typeof DatastoreTransactionRecord;

	await context.transaction(async () => {
		await Record.create({ id: 11, handle: 'created' });
	});
	assert.deepEqual(calls, ['run', 'insert', 'commit']);

	calls.length = 0;
	const afterCommit: string[] = [];
	await context.transaction(async (tx) => {
		await Record.create({ id: 14, handle: 'after' });
		await tx.afterCommit(async () => {
			afterCommit[afterCommit.length] = 'afterCommit';
		});
	});
	assert.deepEqual(calls, ['run', 'insert', 'commit']);
	assert.deepEqual(afterCommit, ['afterCommit']);

	calls.length = 0;
	await assert.rejects(
		() => context.transaction(async () => {
			await Record.create({ id: 12, handle: 'rolled-back' });
			throw new Error('abort datastore tx');
		}),
		/abort datastore tx/
		);
		assert.deepEqual(calls, ['run', 'rollback']);

	calls.length = 0;
	await assert.rejects(
		() => context.transaction(async () => {
			await Record.create({ id: 13, handle: 'blocked' });
		}, { readOnly: true }),
		/read-only/
	);
	assert.deepEqual(calls, ['run', 'rollback']);
});

test('Datastore context transactions skip afterRollback callbacks after commit-phase failures', async () => {
	const calls: string[] = [];
	const lifecycle: string[] = [];
	const client = datastoreClient({
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'run';
			},
			commit: async () => {
				calls[calls.length] = 'commit';
				throw new Error('datastore commit failed after apply');
			},
			rollback: async () => {
				calls[calls.length] = 'rollback';
			},
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => {
				calls[calls.length] = 'insert';
			},
			update: async () => {
				calls[calls.length] = 'update';
			},
			delete: async () => {
				calls[calls.length] = 'delete';
			}
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreTransactionRecord.use(context) as unknown as typeof DatastoreTransactionRecord;

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await Record.create({ id: 15, handle: 'commit-failure' });
			await tx.afterRollback(async () => {
				lifecycle[lifecycle.length] = 'afterRollback';
			});
		}),
		/datastore commit failed after apply/
	);
	assert.deepEqual(calls, ['run', 'insert', 'commit']);
	assert.deepEqual(lifecycle, []);
});

test('Datastore transaction outcome classification fails closed for frozen commit and rollback failures', async () => {
	const frozenCommitError = Object.freeze(new Error('frozen datastore commit outcome'));
	const frozenLifecycle: string[] = [];
	const frozenAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => { throw frozenCommitError; },
				rollback: async () => assert.fail('commit-phase failures must not be rolled back'),
				get: async () => [null],
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const frozenContext = createActiveTs({ stores: { default: frozenAdapter } });
	await assert.rejects(
		() => frozenContext.transaction(async (tx) => {
			await tx.afterRollback(() => { frozenLifecycle.push('afterRollback'); });
		}),
		(error: unknown) => error === frozenCommitError
	);
	assert.deepEqual(frozenLifecycle, []);

	const rollbackLifecycle: string[] = [];
	const rollbackAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => assert.fail('failed callbacks must not commit'),
				rollback: async () => { throw new Error('datastore rollback transport failed'); },
				get: async () => [null],
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const rollbackContext = createActiveTs({ stores: { default: rollbackAdapter } });
	await assert.rejects(
		() => rollbackContext.transaction(async (tx) => {
			await tx.afterRollback(() => { rollbackLifecycle.push('afterRollback'); });
			throw new Error('datastore callback failed');
		}),
		/Datastore transaction failed and rollback failed/
	);
	assert.deepEqual(rollbackLifecycle, []);
});

test('Datastore definitive gRPC commit failures retain rollback semantics', async () => {
	for (const code of [3, 'ALREADY_EXISTS', 'NOT_FOUND', 'FAILED_PRECONDITION', 'UNAUTHENTICATED']) {
		const calls: string[] = [];
		const lifecycle: string[] = [];
		const commitError = Object.assign(new Error(`definitive commit failure ${String(code)}`), { code });
		const adapter = await createDatastoreStoreAdapter({
			client: datastoreClient({
				transaction: () => ({
					run: async () => { calls.push('run'); },
					commit: async () => {
						calls.push('commit');
						throw commitError;
					},
					rollback: async () => { calls.push('rollback'); },
					get: async () => [null],
					runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
					insert: async () => undefined,
					update: async () => undefined,
					delete: async () => undefined
				})
			})
		});
		const context = createActiveTs({ stores: { default: adapter } });

		await assert.rejects(
			() => context.transaction(async (tx) => {
				await tx.afterRollback(() => { lifecycle.push('afterRollback'); });
			}),
			(error: unknown) => error === commitError
		);
		assert.deepEqual(calls, ['run', 'commit'], String(code));
		assert.deepEqual(lifecycle, ['afterRollback'], String(code));
	}
});

test('Datastore transactions map ABORTED commits and retry only with explicit maxAttempts', async () => {
	const terminalLifecycle: string[] = [];
	const terminalAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => ({
				run: async () => undefined,
				commit: async () => { throw Object.assign(new Error('transaction aborted'), { code: 10 }); },
				rollback: async () => assert.fail('ABORTED commits are already rolled back'),
				get: async () => [null],
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			})
		})
	});
	const terminalContext = createActiveTs({ stores: { default: terminalAdapter } });
	await assert.rejects(
		() => terminalContext.transaction(async (tx) => {
			await tx.afterRollback(() => { terminalLifecycle.push('afterRollback'); });
		}),
		ActiveTsConflictError
	);
	assert.deepEqual(terminalLifecycle, ['afterRollback']);

	let transactionAttempts = 0;
	let callbackAttempts = 0;
	const retryLifecycle: string[] = [];
	const retryAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => {
				const attempt = ++transactionAttempts;
				return {
					run: async () => undefined,
					commit: async () => {
						if (attempt === 1) throw Object.assign(new Error('retryable abort'), { code: 'ABORTED' });
					},
					rollback: async () => assert.fail('ABORTED commits are already rolled back'),
					get: async () => [null],
					runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
					insert: async () => undefined,
					update: async () => undefined,
					delete: async () => undefined
				};
			}
		})
	});
	const retryContext = createActiveTs({ stores: { default: retryAdapter } });
	const result = await retryContext.transaction(async (tx) => {
		const attempt = ++callbackAttempts;
		await tx.afterRollback(() => { retryLifecycle.push(`rollback:${attempt}`); });
		await tx.afterCommit(() => { retryLifecycle.push(`commit:${attempt}`); });
		return `attempt:${attempt}`;
	}, {
		native: {
			maxAttempts: 2,
			retryInitialDelayMs: 0,
			retryMaxDelayMs: 0,
			retryJitter: false
		}
	});

	assert.equal(result, 'attempt:2');
	assert.equal(transactionAttempts, 2);
	assert.equal(callbackAttempts, 2);
	assert.deepEqual(retryLifecycle, ['rollback:1', 'commit:2']);
	await assert.rejects(
		() => retryAdapter.transaction!(async () => undefined, { native: { maxAttempts: 0 } }),
		/Datastore transaction options\.native\.maxAttempts must be a positive safe integer/
	);
});

test('Datastore transaction direct reads use explicit ancestor metadata for buffered rows', async () => {
	const calls: string[] = [];
	const client = datastoreClient({
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'run';
			},
			commit: async () => {
				calls[calls.length] = 'commit';
			},
			rollback: async () => {
				calls[calls.length] = 'rollback';
			},
			get: async (input: unknown) => {
				if (Array.isArray(input)) {
					calls[calls.length] = 'tx.getMany';
					throw new Error('buffered getMany should not hit backend');
				}
				calls[calls.length] = 'tx.get';
				return [null];
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => {
				calls[calls.length] = 'insert';
			},
			update: async () => {
				calls[calls.length] = 'update';
			},
			delete: async () => {
				calls[calls.length] = 'delete';
			}
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const context = createActiveTs({ stores: { default: datastore } });
	const parent = datastoreKey('parent_record', 7);

	const result = await context.transaction(async (tx) => {
		const store = tx.store('default');
		await store.create(
			ancestorMeta,
			15,
			{ id: 15, parentId: 7, handle: 'buffered' },
			{ meta: { datastoreAncestor: parent } }
		);
		const one = await store.get(ancestorMeta, 15, { meta: { datastoreAncestor: parent } });
		const many = await store.getMany(ancestorMeta, [15], { meta: { datastoreAncestor: parent } });
		return { one, many };
	});

	assert.deepEqual(result, {
		one: { id: 15, parentId: 7, handle: 'buffered' },
		many: [{ id: 15, parentId: 7, handle: 'buffered' }]
	});
	assert.deepEqual(calls, ['run', 'tx.get', 'insert', 'commit']);
});

test('Datastore transaction buffered writes ignore stale entity key markers when metadata is explicit', async () => {
	const staleEntityKey = {
		path: ['parent_record', 'number:99', 'datastore_ancestor_record', 'number:15'],
		namespace: undefined
	};
	const data = { id: 15, parentId: 10, handle: 'buffered-stale-key' };
	Object.defineProperty(data, ACTIVE_TS_ENTITY_KEY, {
		enumerable: false,
		value: staleEntityKey
	});
	const client = datastoreClient({
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const parent = datastoreKey('parent_record', 10);
	const staleParent = datastoreKey('parent_record', 99);

	await datastore.transaction!(async (tx) => {
		await tx.create(ancestorMeta, 15, data, { meta: { datastoreAncestor: parent } });
		const direct = await tx.get(ancestorMeta, 15, { meta: { datastoreAncestor: parent } });
		assert.deepEqual(direct, { id: 15, parentId: 10, handle: 'buffered-stale-key' });
		const directDescriptor = Object.getOwnPropertyDescriptor(direct ?? {}, ACTIVE_TS_ENTITY_KEY);
		assert.notEqual(directDescriptor, undefined);
		assert.equal(directDescriptor?.enumerable, false);
		assert.notDeepEqual(directDescriptor?.value, staleEntityKey);
		assert.deepEqual(directDescriptor?.value, {
			path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:15'],
			namespace: undefined
		});

		const scopedResult = await tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: parent }
		});
		assert.deepEqual(
			scopedResult,
			{
				list: [{ id: 15, parentId: 10, handle: 'buffered-stale-key' }],
				more: false
			}
		);
		const scopedDescriptor = Object.getOwnPropertyDescriptor(scopedResult.list[0], ACTIVE_TS_ENTITY_KEY);
		assert.notEqual(scopedDescriptor, undefined);
		assert.equal(scopedDescriptor?.enumerable, false);
		assert.notDeepEqual(scopedDescriptor?.value, staleEntityKey);
		assert.deepEqual(scopedDescriptor?.value, {
			path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:15'],
			namespace: undefined
		});
		assert.deepEqual(
			await tx.query(ancestorMeta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: staleParent }
			}),
			{ list: [], more: false }
		);
	});
});

test('Datastore transaction buffered writes ignore stale entity key markers when metadata is inferred', async () => {
	const keySymbol = Symbol('datastore-key');
	const backendEntityKey = {
		path: ['parent_record', 'number:11', 'datastore_ancestor_record', 'number:1'],
		namespace: undefined
	};
	const backendRow = { id: 1, parentId: 11, handle: 'backend' };
	Object.defineProperty(backendRow, keySymbol, {
		enumerable: true,
		value: backendEntityKey
	});
	const staleEntityKey = {
		path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'],
		namespace: undefined
	};
	const data = { id: 1, parentId: 11, handle: 'updated' };
	Object.defineProperty(data, ACTIVE_TS_ENTITY_KEY, {
		enumerable: false,
		value: staleEntityKey
	});
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: unknown) => input,
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [backendRow],
			runQuery: async () => [[backendRow], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client, keySymbol, allowAggregateScanFallback: true });
	const parent = datastoreKey('parent_record', 11);

	await datastore.transaction!(async (tx) => {
		await tx.update(ancestorMeta, 1, data);
		const result = await tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: parent }
		});
		assert.deepEqual(result, {
			list: [{ id: 1, parentId: 11, handle: 'updated' }],
			more: false
		});
		const descriptor = Object.getOwnPropertyDescriptor(result.list[0], ACTIVE_TS_ENTITY_KEY);
		assert.notEqual(descriptor, undefined);
		assert.equal(descriptor?.enumerable, false);
		assert.notDeepEqual(descriptor?.value, staleEntityKey);
		assert.deepEqual(descriptor?.value, backendEntityKey);
		assert.deepEqual(
			await tx.aggregate!(ancestorMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				meta: { datastoreAncestor: parent }
			}),
			{ count: 1 }
		);
	});
});

test('Datastore ancestor model outbox includeData uses fallback payload inside transactions', async () => {
	const calls: string[] = [];
	const client = datastoreClient({
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'run';
			},
			commit: async () => {
				calls[calls.length] = 'commit';
			},
			rollback: async () => {
				calls[calls.length] = 'rollback';
			},
			get: async () => {
				calls[calls.length] = 'tx.get';
				return [null];
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async () => {
				calls[calls.length] = 'insert';
			},
			update: async () => {
				calls[calls.length] = 'update';
			},
			delete: async () => {
				calls[calls.length] = 'delete';
			}
		})
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: datastore },
		plugins: [createOutboxPlugin({
			outbox,
			includeData: true,
			id: () => 'ancestor-outbox-event',
			allowUnsafeTransactionDeferredAppend: true
		})]
	});

	await context.transaction(async (tx) => {
		const Record = DatastoreAncestorRecord.use(tx) as unknown as typeof DatastoreAncestorRecord;
		await Record.create({ id: 15, parentId: 7, handle: 'ancestor-outbox' });
	});

	assert.deepEqual(calls, ['run', 'tx.get', 'insert', 'commit']);
	assert.deepEqual(
		(await outbox.list()).map((event) => [event.id, event.model, event.modelId, event.data?.handle, event.data?.parentId]),
		[['ancestor-outbox-event', 'datastore_ancestor_record', 15, 'ancestor-outbox', 7]]
	);
});

test('Datastore transactions reject unsupported options before starting SDK transactions', async () => {
	let transactionCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => {
				transactionCalls++;
				return {};
			}
		})
	});

	await assert.rejects(
		() => datastore.transaction!(async () => undefined, { isolation: 'serializable' }),
		/Datastore transaction options\.isolation is not supported/
	);
	await assert.rejects(
		() => datastore.transaction!(async () => undefined, { timeoutMs: 100 }),
		/Datastore transaction options\.timeoutMs is not supported/
	);
	await assert.rejects(
		() => datastore.transaction!(async () => undefined, { native: { vendor: true } }),
		/Datastore transaction options\.native contains unknown option "vendor"/
	);
	await assert.rejects(
		() => datastore.transaction!(async () => undefined, { native: { gaxOptions: [] } }),
		/Datastore transaction options\.native\.gaxOptions must be a plain object/
	);
	assert.equal(transactionCalls, 0);
});

test('Google manual schema plans ignore patched Array transforms', async () => {
	const indexedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		indexes: [{ name: 'idx_handle_score', fields: ['handle', 'score'] }]
	};
	const firestore = await createFirestoreStoreAdapter({ client: firestoreClient() });
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const arrayMap = Array.prototype.map;
	const arrayFilter = Array.prototype.filter;
	const arrayFlatMap = Array.prototype.flatMap;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'filter', {
		configurable: true,
		value() {
			throw new Error('patched Array.filter');
		}
	});
	Object.defineProperty(Array.prototype, 'flatMap', {
		configurable: true,
		value() {
			throw new Error('patched Array.flatMap');
		}
	});
	let firestorePlan;
	let datastorePlan;
	try {
		firestorePlan = await firestore.schema!.plan([indexedMeta]);
		datastorePlan = await datastore.schema!.plan([indexedMeta]);
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: arrayFilter });
		Object.defineProperty(Array.prototype, 'flatMap', { configurable: true, value: arrayFlatMap });
	}
	assert.deepEqual(firestorePlan?.changes, [
		{ type: 'create-index', target: 'google_regression_record', name: 'idx_handle_score', fields: ['handle', 'score'], unique: undefined }
	]);
	assert.deepEqual(datastorePlan?.changes, [
		{
			type: 'create-index',
			target: 'google_regression_record',
			name: 'idx_handle_score',
			fields: ['handle', 'score', 'id'],
			directions: ['asc', 'asc', 'asc'],
			unique: undefined,
			ancestor: false
		}
	]);
	const directionalMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		indexes: [{ name: 'idx_handle_score_desc', fields: ['handle', 'score'], directions: ['asc', 'desc'] }]
	};
	assert.deepEqual((await firestore.schema!.plan([directionalMeta])).changes, [
		{
			type: 'create-index',
			target: 'google_regression_record',
			name: 'idx_handle_score_desc',
			fields: ['handle', 'score'],
			directions: ['asc', 'desc'],
			unique: undefined
		}
	]);
	assert.deepEqual((await datastore.schema!.plan([directionalMeta])).changes, [
		{
			type: 'create-index',
			target: 'google_regression_record',
			name: 'idx_handle_score_desc',
			fields: ['handle', 'score', 'id'],
			directions: ['asc', 'desc', 'asc'],
			unique: undefined,
			ancestor: false
		}
	]);
	assert.deepEqual((await datastore.schema!.plan([{ ...meta, indexes: [{ name: 'idx_handle_id', fields: ['handle', 'id'] }] }])).changes, [
		{
			type: 'create-index',
			target: 'google_regression_record',
			name: 'idx_handle_id',
			fields: ['handle', 'id'],
			directions: ['asc', 'asc'],
			unique: undefined,
			ancestor: false
		}
	]);
	assert.deepEqual(
		(await datastore.schema!.plan([
			{ ...ancestorMeta, indexes: [{ name: 'idx_parent_handle', fields: ['parentId', 'handle'] }] }
		])).changes,
		[
			{
				type: 'create-index',
				target: 'datastore_ancestor_record',
				name: 'idx_parent_handle',
				fields: ['parentId', 'handle', 'id'],
				directions: ['asc', 'asc', 'asc'],
				unique: undefined,
				ancestor: true
			},
			{
				type: 'create-index',
				target: 'datastore_ancestor_record',
				name: 'idx_parent_handle',
				fields: ['parentId', 'handle', 'id'],
				directions: ['asc', 'asc', 'asc'],
				unique: undefined,
				ancestor: false
			}
		]
	);
	assert.deepEqual(
		(await datastore.schema!.plan([
			{
				...meta,
				indexes: [
					{ name: 'idx_handle', fields: ['handle'] },
					{ name: 'idx_handle_id_duplicate', fields: ['handle', 'id'] }
				]
			}
		])).changes,
		[
			{
				type: 'create-index',
				target: 'google_regression_record',
				name: 'idx_handle',
				fields: ['handle', 'id'],
				directions: ['asc', 'asc'],
				unique: undefined,
				ancestor: false
			}
		]
	);
	assert.deepEqual(
		(await datastore.schema!.plan([
			{
				...meta,
				indexes: [
					{ name: 'idx_comma_left', fields: ['a,b', 'c'] },
					{ name: 'idx_comma_right', fields: ['a', 'b,c'] }
				]
			}
		])).changes,
		[
			{
				type: 'create-index',
				target: 'google_regression_record',
				name: 'idx_comma_left',
				fields: ['a,b', 'c', 'id'],
				directions: ['asc', 'asc', 'asc'],
				unique: undefined,
				ancestor: false
			},
			{
				type: 'create-index',
				target: 'google_regression_record',
				name: 'idx_comma_right',
				fields: ['a', 'b,c', 'id'],
				directions: ['asc', 'asc', 'asc'],
				unique: undefined,
				ancestor: false
			}
		]
	);
	assert.deepEqual(
		(await datastore.schema!.plan([
			{ ...meta, indexes: [{ name: 'idx_handle_root', fields: ['handle'] }] },
			{ ...ancestorMeta, name: meta.name, indexes: [{ name: 'idx_handle_ancestor', fields: ['handle'] }] }
		])).changes,
		[
			{
				type: 'create-index',
				target: 'google_regression_record',
				name: 'idx_handle_root',
				fields: ['handle', 'id'],
				directions: ['asc', 'asc'],
				unique: undefined,
				ancestor: false
			},
			{
				type: 'create-index',
				target: 'google_regression_record',
				name: 'idx_handle_ancestor',
				fields: ['handle', 'id'],
				directions: ['asc', 'asc'],
				unique: undefined,
				ancestor: true
			}
		]
	);
});

test('Datastore index.yaml helper renders model indexes with ancestor metadata', () => {
	const indexedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		indexes: [
			{ name: 'idx_handle_score', fields: ['handle', 'score'] },
			{ name: 'idx_handle_score_duplicate', fields: ['handle', 'score'] },
			{ name: 'idx_handle_score_desc', fields: ['handle', 'score'], directions: ['asc', 'desc'] }
		]
	};
	const indexedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		indexes: [{ name: 'idx_parent_handle', fields: ['parentId', 'handle'] }]
	};

	assert.equal(
		createDatastoreIndexYaml([indexedMeta, indexedAncestorMeta]),
		`indexes:
- kind: "google_regression_record"
  ancestor: no
  properties:
  - name: "handle"
    direction: asc
  - name: "score"
    direction: asc
  - name: "id"
    direction: asc
- kind: "google_regression_record"
  ancestor: no
  properties:
  - name: "handle"
    direction: asc
  - name: "score"
    direction: desc
  - name: "id"
    direction: asc
- kind: "datastore_ancestor_record"
  ancestor: yes
  properties:
  - name: "parentId"
    direction: asc
  - name: "handle"
    direction: asc
  - name: "id"
    direction: asc
- kind: "datastore_ancestor_record"
  ancestor: no
  properties:
  - name: "parentId"
    direction: asc
  - name: "handle"
    direction: asc
  - name: "id"
    direction: asc
`
	);
	assert.equal(
		createDatastoreIndexYaml({ ...meta, indexes: [{ name: 'idx_handle_id', fields: ['handle', 'id'] }] }),
		`indexes:
- kind: "google_regression_record"
  ancestor: no
  properties:
  - name: "handle"
    direction: asc
  - name: "id"
    direction: asc
`
	);
	assert.equal(
		createDatastoreIndexYaml({
			...meta,
			indexes: [
				{ name: 'idx_comma_left', fields: ['a,b', 'c'] },
				{ name: 'idx_comma_right', fields: ['a', 'b,c'] }
			]
		}),
		`indexes:
- kind: "google_regression_record"
  ancestor: no
  properties:
  - name: "a,b"
    direction: asc
  - name: "c"
    direction: asc
  - name: "id"
    direction: asc
- kind: "google_regression_record"
  ancestor: no
  properties:
  - name: "a"
    direction: asc
  - name: "b,c"
    direction: asc
  - name: "id"
    direction: asc
`
	);
	assert.equal(
		createDatastoreIndexYaml({
			...meta,
			name: 'null',
			indexes: [{ name: 'yaml_literals', fields: ['true', 'yes', 'no'] }]
		}),
		`indexes:
- kind: "null"
  ancestor: no
  properties:
  - name: "true"
    direction: asc
  - name: "yes"
    direction: asc
  - name: "no"
    direction: asc
  - name: "id"
    direction: asc
`
	);
	assert.equal(createDatastoreIndexYaml({ ...meta, indexes: [] }), 'indexes: []\n');
	assert.throws(
		() => createDatastoreIndexYaml({ ...meta, indexes: [{ name: 'unique_handle', fields: ['handle'], unique: true }] }),
		/Datastore adapter does not support unique indexes/
	);
});

test('Datastore nested paths preserve codecs, ancestor scope, ordering, selection, aggregates, and indexes', async () => {
	type NestedQueryData = {
		id: number;
		parentId: number;
		metadata: {
			category: string;
			createdAt: number;
		};
	};
	const keySymbol = Symbol('datastore-nested-query-key');
	const filters: Array<{ field: string; operator: string; value: unknown }> = [];
	const orders: Array<{ field: string; descending: boolean }> = [];
	const ancestors: unknown[] = [];
	const aggregateFields: Array<{ field: string; alias: string }> = [];
	const query = {
		hasAncestor(key: unknown) {
			ancestors[ancestors.length] = key;
			return this;
		},
		filter(field: string, operator: string, value: unknown) {
			filters[filters.length] = { field, operator, value };
			return this;
		},
		order(field: string, options: { descending: boolean }) {
			orders[orders.length] = { field, descending: options.descending };
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const aggregationQuery = {
		sum(field: string, alias: string) {
			aggregateFields[aggregateFields.length] = { field, alias };
			return this;
		}
	};
	const entity = Object.defineProperty({
		id: 1,
		parentId: 7,
		metadata: {
			category: 'stored:group-a',
			createdAt: 20,
			ignored: true
		}
	}, keySymbol, {
		value: {
			path: ['nested_query_parent', 'number:7', 'datastore_nested_query_record', 'number:1'],
			namespace: undefined
		}
	});
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: unknown) => input,
		createQuery: () => query,
		runQuery: async () => [[entity], { moreResults: 'NO_MORE_RESULTS' }],
		createAggregationQuery: () => aggregationQuery,
		runAggregationQuery: async () => [[{ totalCreatedAt: 20 }]]
	});
	const datastore = await createDatastoreStoreAdapter({ client, keySymbol });
	const nestedMeta: ResolvedModelMeta<NestedQueryData> = {
		model: class {},
		name: 'datastore_nested_query_record',
		store: 'default',
		idField: 'id',
		validator: (input) => input as NestedQueryData,
		readValidation: 'off',
		indexes: [{
			name: 'idx_nested_category_created',
			fields: ['metadata.category', 'metadata.createdAt'],
			directions: ['asc', 'desc']
		}],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map([[
			'metadata.category',
			{
				name: 'stored-category',
				encode: (value) => `stored:${String(value)}`,
				decode: (value) => String(value).slice('stored:'.length),
				encodeQuery: (value) => `stored:${String(value)}`
			}
		]]),
		fieldTypes: new Map([
			['metadata.category', 'string'],
			['metadata.createdAt', 'number']
		]),
		datastore: {
			ancestor: ({ data }) => data ? datastoreKey('nested_query_parent', data.parentId) : undefined,
			ancestorFields: ['parentId']
		}
	};
	const ancestor = datastoreKey('nested_query_parent', 7);

	assert.equal(datastore.capabilities?.nestedFields, true);
	const result = await datastore.query(nestedMeta, {
		where: [
			{ field: 'metadata.category', op: '=', value: 'group-a' },
			{ field: 'metadata.createdAt', op: '>=', value: 2 }
		],
		or: [],
		sort: [{ field: 'metadata.createdAt', direction: 'desc' }],
		include: [],
		select: ['metadata.category', 'metadata.createdAt'],
		meta: { datastoreAncestor: ancestor }
	});
	assert.deepEqual(filters, [
		{ field: 'metadata.category', operator: '=', value: 'stored:group-a' },
		{ field: 'metadata.createdAt', operator: '>=', value: 2 }
	]);
	assert.deepEqual(orders, [{ field: 'metadata.createdAt', descending: true }]);
	assert.deepEqual(ancestors, [{ path: ['nested_query_parent', 'number:7'], namespace: undefined }]);
	assert.deepEqual(result.list, [{
		id: 1,
		metadata: {
			category: 'stored:group-a',
			createdAt: 20
		}
	}]);
	assert.deepEqual(
		await datastore.aggregate!(nestedMeta, {
			where: [{ field: 'metadata.category', op: '=', value: 'group-a' }],
			or: [],
			aggregates: [{ op: 'sum', field: 'metadata.createdAt', as: 'totalCreatedAt' }],
			meta: { datastoreAncestor: ancestor }
		}),
		{ totalCreatedAt: 20 }
	);
	assert.deepEqual(filters[2], {
		field: 'metadata.category',
		operator: '=',
		value: 'stored:group-a'
	});
	assert.deepEqual(aggregateFields, [{ field: 'metadata.createdAt', alias: 'totalCreatedAt' }]);
	assert.equal(
		createDatastoreIndexYaml(nestedMeta),
		`indexes:
- kind: "datastore_nested_query_record"
  ancestor: yes
  properties:
  - name: "metadata.category"
    direction: asc
  - name: "metadata.createdAt"
    direction: desc
  - name: "id"
    direction: asc
- kind: "datastore_nested_query_record"
  ancestor: no
  properties:
  - name: "metadata.category"
    direction: asc
  - name: "metadata.createdAt"
    direction: desc
  - name: "id"
    direction: asc
`
	);
});

test('Google adapter getMany deduping uses captured Set intrinsics', async () => {
	const firestoreRefs: unknown[] = [];
	const datastoreKeys: unknown[] = [];
	let datastoreGetInput: unknown;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async (...refs: unknown[]) => {
				firestoreRefs.push(...refs);
				return refs.map((ref: any) => ({ exists: false, id: ref.id }));
			}
		})
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				datastoreKeys.push(input);
				return { input };
			},
			get: async (input: unknown) => {
				datastoreGetInput = input;
				return [[]];
			}
		})
	});
	const setHas = Set.prototype.has;
	const setAdd = Set.prototype.add;
	let firestoreResult: unknown;
	let datastoreResult: unknown;
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	Set.prototype.add = function () {
		throw new Error('patched Set.add');
	};
	try {
		firestoreResult = await firestore.getMany(meta, [1, 1]);
		datastoreResult = await datastore.getMany(meta, [1, 1]);
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
	assert.deepEqual(firestoreResult, [null, null]);
	assert.deepEqual(datastoreResult, [null, null]);
	assert.equal(firestoreRefs.length, 1);
	assert.equal(datastoreKeys.length, 1);
	assert.ok(Array.isArray(datastoreGetInput));
	assert.equal((datastoreGetInput as unknown[]).length, 1);
});

test('Firestore getMany ignores patched Array transform helpers', async () => {
	const firestoreRefs: unknown[] = [];
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async (...refs: unknown[]) => {
				for (let index = 0; index < refs.length; index++) firestoreRefs[index] = refs[index];
				return [
					{ exists: true, id: 'number:1', data: () => ({ id: 1, handle: 'one' }) },
					{ exists: false, id: 'number:2' }
				];
			}
		})
	});
	const arrayMap = Array.prototype.map;
	const arrayForEach = Array.prototype.forEach;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'forEach', {
		configurable: true,
		value() {
			throw new Error('patched Array.forEach');
		}
	});
	try {
		const rows = await firestore.getMany(meta, [1, 2, 1]);
		assert.deepEqual(rows, [
			{ id: 1, handle: 'one' },
			null,
			{ id: 1, handle: 'one' }
		]);
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
		Object.defineProperty(Array.prototype, 'forEach', { configurable: true, value: arrayForEach });
	}
	assert.equal(firestoreRefs.length, 2);
});

test('Datastore getMany ignores patched Array map', async () => {
	const datastoreKeys: unknown[] = [];
	let datastoreGetInput: unknown;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				datastoreKeys[datastoreKeys.length] = input;
				return { input };
			},
			get: async (input: unknown) => {
				datastoreGetInput = input;
				return [[{ id: 1, handle: 'one' }]];
			}
		})
	});
	const arrayMap = Array.prototype.map;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	try {
		assert.deepEqual(await datastore.getMany(meta, [1, 2, 1]), [
			{ id: 1, handle: 'one' },
			null,
			{ id: 1, handle: 'one' }
		]);
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
	}
	assert.equal(datastoreKeys.length, 2);
	assert.ok(Array.isArray(datastoreGetInput));
	assert.equal((datastoreGetInput as unknown[]).length, 2);
});

test('Datastore getMany requires one snapshot before chunking more than 1000 keys', async () => {
	const lookupSizes: number[] = [];
	const lookupOptions: unknown[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			get: async (input: unknown, options: unknown) => {
				assert.ok(Array.isArray(input));
				lookupSizes.push(input.length);
				lookupOptions.push(options);
				const rows: Array<{ id: number; handle: string }> = [];
				for (let index = input.length - 1; index >= 0; index--) {
					const key = input[index] as { path: Array<string | number> };
					const encodedId = String(key.path[key.path.length - 1]);
					const id = Number(encodedId.slice('number:'.length));
					rows.push({ id, handle: `row:${id}` });
				}
				return [rows];
			}
		})
	});
	const ids: number[] = [];
	for (let id = 1; id <= 1001; id++) ids.push(id);

	await assert.rejects(
		() => datastore.getMany(meta, ids),
		/requires readAt\(\) or a Datastore transaction to preserve one snapshot/
	);
	assert.deepEqual(lookupSizes, []);
	const rows = await datastore.getMany(meta, ids, datastoreReadOptions({ readTime: 1_753_000_000_000 }));

	assert.deepEqual(lookupSizes, [1000, 1]);
	assert.deepEqual(lookupOptions, [
		{ readTime: 1_753_000_000_000 },
		{ readTime: 1_753_000_000_000 }
	]);
	assert.equal(rows.length, ids.length);
	for (let index = 0; index < rows.length; index++) {
		assert.deepEqual(rows[index], { id: index + 1, handle: `row:${index + 1}` });
	}
});

test('Datastore key factory, ancestor query, and unindexed writes map to SDK calls', async () => {
	const sdkKeys: unknown[] = [];
	const queries: unknown[] = [];
	const ancestorCalls: unknown[] = [];
	const inserted: unknown[] = [];
	const updated: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			createQuery: (...args: unknown[]) => {
				queries[queries.length] = args;
				return datastoreQuery;
			},
			insert: async (entity: unknown) => {
				inserted[inserted.length] = entity;
			},
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			},
			runQuery: async () => [[{ id: 1, handle: 'one', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		namespace: 'tenant'
	});

	const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });
	const child: DatastoreKey = datastoreKey('datastore_ancestor_record', 1, { parent });
	const result = await datastore.query(ancestorMeta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: parent }
	});
	await datastore.create(ancestorMeta, 1, { id: 1, handle: 'one', parentId: 10, body: 'long text' });
	await datastore.update(ancestorMeta, 1, { id: 1, handle: 'two', parentId: 10, body: 'longer text' });

	assert.deepEqual(child, {
		path: [
			{ kind: 'parent_record', id: 10 },
			{ kind: 'datastore_ancestor_record', id: 1 }
		],
		namespace: 'tenant'
	});
	assert.deepEqual(result.list, [{ id: 1, handle: 'one', parentId: 10 }]);
	assert.deepEqual(queries, [['tenant', 'datastore_ancestor_record']]);
	assert.deepEqual(ancestorCalls, [{ input: { path: ['parent_record', 'number:10'], namespace: 'tenant' } }]);
	assert.deepEqual(inserted, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } },
			data: { id: 1, handle: 'one', parentId: 10, body: 'long text' },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(updated, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } },
			data: { id: 1, handle: 'two', parentId: 10, body: 'longer text' },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('Datastore continuation cursors round-trip SDK cursors and fail closed on stalled pages', async () => {
	const starts: string[] = [];
	const query = {
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		offset() {
			return this;
		},
		start(cursor: string) {
			starts[starts.length] = cursor;
			return this;
		}
	};
	let response: unknown = [
		[{ id: 1, handle: 'one' }],
		{ moreResults: 'NOT_FINISHED', endCursor: 'sdk-cursor-1' }
	];
	let runQueryCalls = 0;
	const client = datastoreClient({
		createQuery: () => query,
		runQuery: async () => {
			runQueryCalls++;
			return response;
		}
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const plan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		offset: 3,
		limit: 1
	} satisfies QueryPlan;
	let inheritedToJsonCalls = 0;
	let first: Awaited<ReturnType<StoreAdapter['query']>> | undefined;
	Object.defineProperty(Object.prototype, 'toJSON', {
		configurable: true,
		value() {
			inheritedToJsonCalls++;
			return { v: 1, kind: 'datastore', cursor: 'polluted' };
		}
	});
	try {
		first = await datastore.query(meta, plan);
	} finally {
		delete (Object.prototype as Record<string, unknown>).toJSON;
	}
	assert.ok(first);
	assert.equal(inheritedToJsonCalls, 0);
	assert.equal(first.more, true);
	assert.equal(typeof first.cursor, 'string');
	const cursorEnvelope = JSON.parse(Buffer.from(first.cursor!, 'base64url').toString('utf8'));
	assert.deepEqual(Object.keys(cursorEnvelope).sort(), ['cursor', 'kind', 'query', 'v']);
	assert.equal(cursorEnvelope.v, 2);
	assert.equal(cursorEnvelope.kind, 'datastore');
	assert.equal(cursorEnvelope.cursor, 'sdk-cursor-1');
	assert.match(cursorEnvelope.query, /^[A-Za-z0-9_-]{43}$/);
	const continuationPlan = { ...plan, offset: undefined };

	const cursorCalls = runQueryCalls;
	for (const incompatiblePlan of [
		{ ...continuationPlan, where: [{ field: 'handle', op: '=' as const, value: 'other' }] },
		{ ...continuationPlan, sort: [{ field: 'id', direction: 'asc' as const }] },
		{ ...continuationPlan, select: ['handle'] }
	]) {
		await assert.rejects(
			() => datastore.query(meta, { ...incompatiblePlan, cursor: first.cursor }),
			/Invalid Datastore continuation cursor/
		);
	}
	await assert.rejects(
		() => datastore.query({ ...meta, name: 'different_datastore_model' }, { ...continuationPlan, cursor: first.cursor }),
		/Invalid Datastore continuation cursor/
	);
	const projectAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({ options: { projectId: 'different-project' } })
	});
	await assert.rejects(
		() => projectAdapter.query(meta, { ...continuationPlan, cursor: first.cursor }),
		/Invalid Datastore continuation cursor/
	);
	const namespaceAdapter = await createDatastoreStoreAdapter({
		namespace: 'different-namespace',
		client: datastoreClient()
	});
	await assert.rejects(
		() => namespaceAdapter.query(meta, { ...continuationPlan, cursor: first.cursor }),
		/Invalid Datastore continuation cursor/
	);
	assert.equal(runQueryCalls, cursorCalls);

	response = [[], { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'sdk-cursor-1' }];
	const terminal = await datastore.query(meta, { ...continuationPlan, limit: 2, cursor: first.cursor });
	assert.deepEqual(terminal.list, []);
	assert.equal(terminal.more, false);
	assert.equal(terminal.cursor, undefined);
	assert.deepEqual(starts, ['sdk-cursor-1']);

	response = [[{ id: 1, handle: 'duplicate' }], {
		moreResults: 'MORE_RESULTS_AFTER_CURSOR',
		endCursor: 'sdk-cursor-1'
	}];
	await assert.rejects(
		() => datastore.query(meta, { ...continuationPlan, cursor: first.cursor }),
		/repeated non-empty page cursor/
	);

	response = [[{ id: 1, handle: 'one' }], { moreResults: 'MORE_RESULTS_AFTER_LIMIT' }];
	await assert.rejects(
		() => datastore.query(meta, plan),
		/endCursor must be a non-empty string/
	);

	const invalidVersion = Buffer.from(JSON.stringify({
		v: 3,
		kind: 'datastore',
		query: cursorEnvelope.query,
		cursor: 'sdk-cursor-1'
	}), 'utf8').toString('base64url');
	const callsBeforeInvalidCursor = runQueryCalls;
	await assert.rejects(
		() => datastore.query(meta, { ...continuationPlan, cursor: invalidVersion }),
		/Invalid Datastore continuation cursor/
	);
	assert.equal(runQueryCalls, callsBeforeInvalidCursor);

	const fallback = await createDatastoreStoreAdapter({
		client,
		allowQueryScanFallback: true
	});
	await assert.rejects(
		() => fallback.query(meta, {
			...continuationPlan,
			where: [{ field: 'handle', op: '!=', value: 'other' }],
			cursor: first.cursor
		}),
		/continuation cursors are not supported with query scan fallback/
	);
});

test('Datastore resolves SDK project ids and binds injected-client cursors to configured projects', async () => {
	const queryBuilder = () => ({
		limit() { return this; },
		start() { return this; }
	});
	const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
	process.env.GOOGLE_CLOUD_PROJECT = 'adc-project';
	try {
		const sdkClient = await createDatastoreStoreAdapter();
		assert.equal(sdkClient.datastoreProjectId, 'adc-project');
	} finally {
		if (previousProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
		else process.env.GOOGLE_CLOUD_PROJECT = previousProject;
	}

	let firstProjectLookupCalled = false;
	const first = await createDatastoreStoreAdapter({
		client: datastoreClient({
			options: { projectId: 'injected-project-a' },
			async getProjectId() {
				firstProjectLookupCalled = true;
				return 'ignored-project-a';
			},
			createQuery: queryBuilder,
			runQuery: async () => [[{ id: 1, handle: 'one' }], {
				moreResults: 'MORE_RESULTS_AFTER_LIMIT',
				endCursor: 'adc-project-cursor'
			}]
		})
	});
	assert.equal(firstProjectLookupCalled, false);
	assert.equal(first.datastoreProjectId, 'injected-project-a');
	const page = await first.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		limit: 1
	});
	assert.equal(typeof page.cursor, 'string');

	let secondBackendCalls = 0;
	const second = await createDatastoreStoreAdapter({
		client: datastoreClient({
			options: { projectId: 'injected-project-b' },
			createQuery: queryBuilder,
			runQuery: async () => {
				secondBackendCalls++;
				return [[], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	await assert.rejects(
		() => second.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			limit: 1,
			cursor: page.cursor
		}),
		/Invalid Datastore continuation cursor/
	);
	assert.equal(secondBackendCalls, 0);
});

test('Datastore offset queries map to SDK offset before limit', async () => {
	const calls: string[] = [];
	const query = {
		offset(value: number) {
			calls.push(`offset:${value}`);
			return this;
		},
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			runQuery: async () => [[{ id: 3, handle: 'three' }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	const result = await datastore.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		offset: 2,
		limit: 1
	});
	assert.equal(datastore.capabilities?.offset, true);
	assert.deepEqual(result.list, [{ id: 3, handle: 'three' }]);
	assert.deepEqual(calls, ['offset:2', 'limit:1']);
});

test('Datastore ID inventory classifies native key and payload drift across pages', async () => {
	const keySymbol = Symbol('datastore-inventory-key');
	const keyed = (data: Record<string, unknown>, key: Record<string, unknown>) =>
		Object.defineProperty(data, keySymbol, { value: key });
	const numericKey = (
		kind: string,
		id: string | number,
		parent?: Record<string, unknown>
	): Record<string, unknown> => ({
		namespace: 'tenant',
		id,
		name: undefined,
		kind,
		parent
	});
	const namedKey = (
		kind: string,
		name: string,
		parent?: Record<string, unknown>
	): Record<string, unknown> => ({
		namespace: 'tenant',
		id: undefined,
		name,
		kind,
		parent
	});
	const parent = numericKey('inventory_parent', 9);
	const pages = [
		[
			keyed({ id: 17, handle: 'match' }, numericKey('inventory_record', '17', parent)),
			keyed({ id: '18', handle: 'type' }, numericKey('inventory_record', '18', parent)),
			keyed({ id: 19, handle: 'reverse-type' }, namedKey('inventory_record', '19')),
			keyed({ id: 'other', handle: 'value' }, namedKey('inventory_record', 'named'))
		],
		[
			keyed({ handle: 'missing' }, namedKey('inventory_record', 'missing')),
			keyed({ id: true, handle: 'invalid' }, namedKey('inventory_record', 'invalid')),
			keyed({ id: '9007199254740992', handle: 'unsupported' }, numericKey('inventory_record', '9007199254740992'))
		]
	];
	const starts: string[] = [];
	const limits: number[] = [];
	let page = 0;
	const query = {
		limit(value: number) {
			limits[limits.length] = value;
			return this;
		},
		start(value: string) {
			starts[starts.length] = value;
			return this;
		},
		select() {
			assert.fail('Datastore ID inventory must not use a projection');
		}
	};
	const createQueryCalls: unknown[][] = [];
	const issues: DatastoreIdInventoryIssue[] = [];
	const report = await inventoryDatastoreIds({
		client: {
			KEY: keySymbol,
			namespace: 'tenant',
			createQuery: (...args: unknown[]) => {
				createQueryCalls[createQueryCalls.length] = args;
				return query;
			},
			runQuery: async () => {
				const rows = pages[page++];
				return page === 1
					? [rows, { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'cursor-1' }]
					: [rows, { moreResults: 'NO_MORE_RESULTS', endCursor: 'cursor-2' }];
			}
		},
		kind: 'inventory_record',
		pageSize: 4,
		onIssue: async (issue) => {
			issues[issues.length] = issue;
		}
	});

	assert.deepEqual(report, {
		inventoryId: report.inventoryId,
		issueDigest: report.issueDigest,
		kind: 'inventory_record',
		idField: 'id',
		namespace: 'tenant',
		scanned: 7,
		pages: 2,
		counts: {
			match: 1,
			'type-mismatch': 2,
			'value-mismatch': 1,
			'missing-payload-id': 1,
			'invalid-payload-id': 1,
			'unsupported-key': 1
		}
	});
	assert.match(report.inventoryId, /^[0-9a-f-]{36}$/);
	const issueHash = createHash('sha256');
	for (let index = 0; index < issues.length; index++) {
		issueHash.update(JSON.stringify(issues[index]));
		issueHash.update('\n');
	}
	assert.equal(report.issueDigest, `sha256:${issueHash.digest('hex')}`);
	assert.deepEqual(createQueryCalls, [['tenant', 'inventory_record']]);
	assert.deepEqual(limits, [4]);
	assert.deepEqual(starts, ['cursor-1']);
	assert.deepEqual(issues.map((issue) => issue.classification), [
		'type-mismatch',
		'type-mismatch',
		'value-mismatch',
		'missing-payload-id',
		'invalid-payload-id',
		'unsupported-key'
	]);
	assert.equal(issues.every((issue) => issue.inventoryId === report.inventoryId), true);
	assert.deepEqual(issues.map((issue) => issue.issueIndex), [0, 1, 2, 3, 4, 5]);
	assert.deepEqual(issues[0].key, {
		path: [
			{ kind: 'inventory_parent', storage: 'id', value: '9' },
			{ kind: 'inventory_record', storage: 'id', value: '18' }
		],
		namespace: 'tenant'
	});
	assert.deepEqual(issues[0].payload, { type: 'string', value: '18' });
	assert.deepEqual(issues[4].payload, { type: 'invalid', actualType: 'boolean' });
	assert.equal(Object.isFrozen(report), true);
	assert.equal(Object.isFrozen(report.counts), true);
	assert.equal(Object.isFrozen(issues[0]), true);
	assert.equal(Object.isFrozen(issues[0].key), true);
	assert.equal(Object.isFrozen(issues[0].key.path), true);
	assert.equal(Object.isFrozen(issues[0].key.path[0]), true);
	assert.equal(Object.isFrozen(issues[0].payload), true);
});

test('Datastore ID inventory fails closed on malformed keys and pagination cursors', async () => {
	const keySymbol = Symbol('datastore-inventory-invalid-key');
	const row = (key: Record<string, unknown>) =>
		Object.defineProperty({ id: 1 }, keySymbol, { value: key });
	const query = {
		limit() {
			return this;
		},
		start() {
			return this;
		}
	};
	const clientFor = (runQuery: () => Promise<unknown>) => ({
		KEY: keySymbol,
		createQuery: () => query,
		runQuery
	});
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: clientFor(async () => [[], { moreResults: 'NO_MORE_RESULTS' }]),
			kind: 'inventory_record',
			namespace: ''
		}),
		/Datastore ID inventory namespace must be a non-empty string/
	);
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: {
				...clientFor(async () => [[], { moreResults: 'NO_MORE_RESULTS' }]),
				namespace: ''
			},
			kind: 'inventory_record'
		}),
		/Datastore ID inventory namespace must be a non-empty string/
	);
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: {
				...clientFor(async () => [[], { moreResults: 'NO_MORE_RESULTS' }]),
				namespace: ''
			},
			kind: 'inventory_record',
			namespace: 'tenant'
		}),
		/Datastore ID inventory namespace must be a non-empty string/
	);
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: clientFor(async () => [[row({
				namespace: '',
				kind: 'inventory_record',
				id: 1,
				name: undefined,
				parent: undefined
			})], { moreResults: 'NO_MORE_RESULTS' }]),
			kind: 'inventory_record'
		}),
		/SDK key namespace must be a non-empty string/
	);
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: clientFor(async () => [[row({
				namespace: 'unexpected_tenant',
				kind: 'inventory_record',
				id: 1,
				name: undefined,
				parent: undefined
			})], { moreResults: 'NO_MORE_RESULTS' }]),
			kind: 'inventory_record'
		}),
		/SDK key namespace must match the inventory namespace/
	);
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: clientFor(async () => [[row({
				namespace: undefined,
				kind: 'inventory_record',
				id: 1,
				name: 'one',
				parent: undefined
			})], { moreResults: 'NO_MORE_RESULTS' }]),
			kind: 'inventory_record'
		}),
		/cannot contain both name and id/
	);
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: clientFor(async () => [[], { moreResults: 'MORE_RESULTS_AFTER_LIMIT' }]),
			kind: 'inventory_record'
		}),
		/endCursor must be a non-empty string/
	);
	let calls = 0;
	await assert.rejects(
		() => inventoryDatastoreIds({
			client: clientFor(async () => {
				calls++;
				return [[row({
					namespace: undefined,
					kind: 'inventory_record',
					id: 1,
					name: undefined,
					parent: undefined
				})], { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'same-cursor' }];
			}),
			kind: 'inventory_record'
		}),
		/repeated non-empty page cursor/
	);
	assert.equal(calls, 2);
	let emptyCalls = 0;
	const terminalEmpty = await inventoryDatastoreIds({
		client: clientFor(async () => {
			emptyCalls++;
			return [[], { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'terminal-cursor' }];
		}),
		kind: 'inventory_record'
	});
	assert.equal(emptyCalls, 2);
	assert.equal(terminalEmpty.scanned, 0);
	assert.equal(terminalEmpty.pages, 2);
});

test('Datastore native key encoding passes typed ids to SDK key paths', async () => {
	const sdkKeys: Array<{ path: Array<string | number>; namespace?: string }> = [];
	const ancestorCalls: unknown[] = [];
	const inserted: unknown[] = [];
	const query = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: { path: Array<string | number>; namespace?: string }) => {
				sdkKeys[sdkKeys.length] = input;
				return nativeSdkDatastoreEntityKey(input);
			},
			createQuery: () => query,
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async (entity: unknown) => {
				inserted[inserted.length] = entity;
			}
		}),
		keyEncoding: 'native',
		namespace: 'tenant'
	});
	const numericParent = datastoreKey('parent_record', 17, { namespace: 'tenant' });
	const stringParent = datastoreKey('parent_record', '17', { namespace: 'tenant' });

	for (const parent of [numericParent, stringParent]) {
		await datastore.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: parent }
		});
	}
	await datastore.create(ancestorMeta, 1, { id: 1, handle: 'ancestor', parentId: 17 });
	await datastore.create(meta, 17, { id: 17, handle: 'numeric' });
	await datastore.create(meta, '17', { id: '17', handle: 'string' } as any);
	await datastore.delete(meta, 17);
	await assert.rejects(
		() => datastore.get(meta, 0),
		/cannot be zero for native Datastore key encoding/
	);
	await assert.rejects(
		() => datastore.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreKey('parent_record', 0, { namespace: 'tenant' }) }
		}),
		/cannot be zero for native Datastore key encoding/
	);
	await datastore.delete(meta, '0');

	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 17], namespace: 'tenant' },
		{ path: ['parent_record', '17'], namespace: 'tenant' },
		{ path: ['parent_record', 17, 'datastore_ancestor_record', 1], namespace: 'tenant' },
		{ path: ['google_regression_record', 17], namespace: 'tenant' },
		{ path: ['google_regression_record', '17'], namespace: 'tenant' },
		{ path: ['google_regression_record', 17], namespace: 'tenant' },
		{ path: ['google_regression_record', '0'], namespace: 'tenant' }
	]);
	assert.equal(inserted.length, 3);
	assert.deepEqual(
		ancestorCalls.map((key: any) => key.path),
		[
			['parent_record', 17],
			['parent_record', '17']
		]
	);
});

test('Datastore native key encoding preserves numeric ids, string names, and logical key metadata', async () => {
	const keySymbol = Symbol('native-datastore-key');
	const keyedEntity = (
		id: number | string,
		handle: string,
		path: Array<string | number> = ['google_regression_record', id]
	) => Object.defineProperty(
		{ id, handle, ...(path.length > 2 ? { parentId: path[1] } : {}) },
		keySymbol,
		{ value: nativeSdkDatastoreEntityKey({ path, namespace: 'tenant' }) }
	);
	const numeric = keyedEntity(17, 'numeric');
	const string = keyedEntity('17', 'string');
	const ancestor = keyedEntity(1, 'ancestor', ['parent_record', 17, 'datastore_ancestor_record', 1]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			key: nativeSdkDatastoreEntityKey,
			get: async (input: any) => {
				if (Array.isArray(input)) return [[numeric, string]];
				if (input.kind === 'datastore_ancestor_record') return [ancestor];
				return [input.id === 17 ? numeric : string];
			},
			runQuery: async () => [[numeric, string], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		keyEncoding: 'native',
		keySymbol,
		namespace: 'tenant'
	});

	const numericRow = await datastore.get(meta, 17);
	const stringRow = await datastore.get(meta, '17');
	assert.deepEqual(numericRow, { id: 17, handle: 'numeric' });
	assert.deepEqual(stringRow, { id: '17', handle: 'string' });
	assert.deepEqual(await datastore.getMany(meta, [17, '17']), [
		{ id: 17, handle: 'numeric' },
		{ id: '17', handle: 'string' }
	]);
	assert.deepEqual(
		await datastore.query(meta, { where: [], or: [], sort: [], include: [] }),
		{
			list: [
				{ id: 17, handle: 'numeric' },
				{ id: '17', handle: 'string' }
			],
			more: false
		}
	);
	assert.deepEqual((numericRow as any)[ACTIVE_TS_ENTITY_KEY], {
		path: [{ kind: 'google_regression_record', id: 17 }],
		namespace: 'tenant'
	});
	assert.deepEqual((stringRow as any)[ACTIVE_TS_ENTITY_KEY], {
		path: [{ kind: 'google_regression_record', id: '17' }],
		namespace: 'tenant'
	});

	const parent = datastoreKey('parent_record', 17, { namespace: 'tenant' });
	const ancestorRow = await datastore.get(ancestorMeta, 1, { meta: { datastoreAncestor: parent } });
	assert.deepEqual(ancestorRow, { id: 1, handle: 'ancestor', parentId: 17 });
	assert.deepEqual((ancestorRow as any)[ACTIVE_TS_ENTITY_KEY], {
		path: [
			{ kind: 'parent_record', id: 17 },
			{ kind: 'datastore_ancestor_record', id: 1 }
		],
		namespace: 'tenant'
	});

	const ambiguousPathEntity = Object.defineProperty(
		{ id: '17', handle: 'ambiguous' },
		keySymbol,
		{ value: { path: ['google_regression_record', '17'], namespace: 'tenant' } }
	);
	const ambiguousPathAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			key: nativeSdkDatastoreEntityKey,
			get: async () => [ambiguousPathEntity]
		}),
		keyEncoding: 'native',
		keySymbol,
		namespace: 'tenant'
	});
	await assert.rejects(
		() => ambiguousPathAdapter.get(meta, '17'),
		/cannot decode a numeric-looking native Datastore path segment without id\/name metadata/
	);

	const zeroIdEntity = Object.defineProperty(
		{ id: 0, handle: 'incomplete' },
		keySymbol,
		{ value: nativeSdkDatastoreEntityKey({ path: ['google_regression_record', 0], namespace: 'tenant' }) }
	);
	const zeroIdAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			key: nativeSdkDatastoreEntityKey,
			get: async () => [zeroIdEntity]
		}),
		keyEncoding: 'native',
		keySymbol,
		namespace: 'tenant'
	});
	await assert.rejects(
		() => zeroIdAdapter.get(meta, 1),
		/cannot be zero for native Datastore key encoding/
	);
});

test('Datastore native key encoding preserves ancestor identities in transaction overlays', async () => {
	const keySymbol = Symbol('native-datastore-transaction-key');
	const inserted: any[] = [];
	const sdkKeys: Array<{ path: Array<string | number>; namespace?: string }> = [];
	const client = datastoreClient({
		KEY: keySymbol,
		key: (input: { path: Array<string | number>; namespace?: string }) => {
			sdkKeys[sdkKeys.length] = input;
			return nativeSdkDatastoreEntityKey(input);
		},
		transaction: () => ({
			run: async () => undefined,
			commit: async () => undefined,
			rollback: async () => undefined,
			get: async () => [null],
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
			insert: async (entity: any) => {
				inserted[inserted.length] = entity;
			},
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({
		client,
		keyEncoding: 'native',
		keySymbol,
		namespace: 'tenant'
	});
	const parent = datastoreKey('parent_record', 17, { namespace: 'tenant' });

	await datastore.transaction!(async (tx) => {
		await tx.create(
			ancestorMeta,
			1,
			{ id: 1, handle: 'buffered', parentId: 17 },
			{ meta: { datastoreAncestor: parent } }
		);
		const result = await tx.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: parent }
		});
		assert.deepEqual(result.list, [{ id: 1, handle: 'buffered', parentId: 17 }]);
		assert.deepEqual((result.list[0] as any)[ACTIVE_TS_ENTITY_KEY], {
			path: [
				{ kind: 'parent_record', id: 17 },
				{ kind: 'datastore_ancestor_record', id: 1 }
			],
			namespace: 'tenant'
		});
	});

	assert.equal(inserted.length, 1);
	assert.deepEqual(inserted[0].key.path, ['parent_record', 17, 'datastore_ancestor_record', 1]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 17, 'datastore_ancestor_record', 1], namespace: 'tenant' },
		{ path: ['parent_record', 17], namespace: 'tenant' },
		{ path: ['parent_record', 17, 'datastore_ancestor_record', 1], namespace: 'tenant' }
	]);
});

test('Datastore ancestor find uses parent-scoped query API', async () => {
	const sdkKeys: unknown[] = [];
	const queries: unknown[] = [];
	const ancestorCalls: unknown[] = [];
	const filters: unknown[][] = [];
	const updated: unknown[] = [];
	const deleted: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter(...args: unknown[]) {
			filters[filters.length] = args;
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			createQuery: (...args: unknown[]) => {
				queries[queries.length] = args;
				return datastoreQuery;
			},
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			},
			delete: async (key: unknown) => {
				deleted[deleted.length] = key;
			},
			runQuery: async () => [[{ id: 1, handle: 'one', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		namespace: 'tenant'
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;
	const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });
	const loaded = await Record.ancestor(parent).find(1).load();
	const updatedModel = await Record.ancestor(parent).find(1).update({ handle: 'two' });
	const deletedModel = await Record.ancestor(parent).find(1).delete();

	assert.deepEqual(loaded?.data, { id: 1, handle: 'one', parentId: 10 });
	assert.deepEqual(updatedModel?.data, { id: 1, handle: 'two', parentId: 10 });
	assert.equal(deletedModel, true);
	assert.deepEqual(queries, [
		['tenant', 'datastore_ancestor_record'],
		['tenant', 'datastore_ancestor_record'],
		['tenant', 'datastore_ancestor_record']
	]);
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['parent_record', 'number:10'], namespace: 'tenant' } },
		{ input: { path: ['parent_record', 'number:10'], namespace: 'tenant' } },
		{ input: { path: ['parent_record', 'number:10'], namespace: 'tenant' } }
	]);
	assert.deepEqual(filters, [['id', '=', 1], ['id', '=', 1], ['id', '=', 1]]);
	assert.deepEqual(updated, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } },
			data: { id: 1, handle: 'two', parentId: 10 },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(deleted, [
		{ input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } }
	]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('QueryBuilder find rejects single wrong-id rows', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 2, handle: 'wrong', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;

	await assert.rejects(
		() => Record.ancestor(datastoreKey('parent_record', 10)).find(1).load(),
		/result id field "id" must match the requested id/
	);
});

test('Relation preload can scope Datastore targets by owner-derived ancestor keys', async () => {
	const ancestorCalls: unknown[] = [];
	const filters: unknown[][] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter(...args: unknown[]) {
			filters[filters.length] = args;
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 5, handle: 'child', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreRelationOwnerRecord.use(context) as unknown as typeof DatastoreRelationOwnerRecord;
	const owners = await Owner.query().include('child').load();
	const child = owners.list[0]?.ref<DatastoreAncestorRecord>('child');
	const childValue = await child?.load();

	assert.ok(!Array.isArray(childValue));
	assert.equal(childValue?.data.handle, 'child');
	assert.deepEqual(ancestorCalls, [{ input: { path: ['parent_record', 'number:10'], namespace: undefined } }]);
	assert.deepEqual(filters, [['id', '=', 5]]);
});

test('Lazy Datastore one relations without ancestorFields keep direct find behavior', async () => {
	const ancestorCalls: unknown[] = [];
	const limits: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit(value: unknown) {
			limits[limits.length] = value;
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 5, handle: 'child', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreRelationOwnerRecord.use(context) as unknown as typeof DatastoreRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	const child = await owner?.ref<DatastoreAncestorRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.handle, 'child');
	assert.deepEqual(ancestorCalls, [{ input: { path: ['parent_record', 'number:10'], namespace: undefined } }]);
	assert.deepEqual(limits, [2]);
});

test('Datastore relation preloads preserve target ancestor fields in partial selects', async () => {
	let selectedFields: string[] | undefined;
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select(fields: string[]) {
			selectedFields = fields;
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_preload_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const row = { id: 5, parentId: 10, title: 'child title', body: 'full body' };
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => {
				const fields = new Set(selectedFields ?? Object.keys(row));
				fields.add('id');
				const projected: Record<string, unknown> = {};
				for (const field of fields) projected[field] = row[field as keyof typeof row];
				return [[projected], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastorePreloadRelationOwnerRecord.use(context) as unknown as typeof DatastorePreloadRelationOwnerRecord;
	const owner = (await Owner.query().include('child').load()).list[0];
	const child = await owner.ref<DatastorePreloadRelationChildRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.title, 'child title');
	assert.equal(child?.data.parentId, 10);
	assert.equal(child?.data.body, undefined);
});

test('Datastore descendant relation includes match duplicate ids by target ancestor fields', async () => {
	const ancestorCalls: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_relation_owner_record', [
		{ id: 1, rootId: 1, parentId: 10, childId: 7 },
		{ id: 2, rootId: 1, parentId: 20, childId: 7 }
	]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'left descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'right descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantRelationOwnerRecord;
	const owners = (await Owner.query().include('child').load()).list;
	const children = await Promise.all(owners.map((owner) => owner.ref<DatastoreDescendantProjectionRecord>('child').load()));

	assert.deepEqual(children.map((child) => Array.isArray(child) ? undefined : child?.data.title), [
		'left descendant',
		'right descendant'
	]);
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['descendant_projection_root', 'number:1'], namespace: undefined } }
	]);
});

test('Datastore descendant direct one relation includes match duplicate ids by target ancestor fields', async () => {
	const ancestorCalls: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_direct_relation_owner_record', [
		{ id: 1, rootId: 1, parentId: 10, childId: 7 },
		{ id: 2, rootId: 1, parentId: 20, childId: 7 }
	]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'left descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'right descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantDirectRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantDirectRelationOwnerRecord;
	const owners = (await Owner.query().include('child').load()).list;
	const children = await Promise.all(owners.map((owner) => owner.ref<DatastoreDescendantProjectionRecord>('child').load()));

	assert.deepEqual(children.map((child) => Array.isArray(child) ? undefined : child?.data.title), [
		'left descendant',
		'right descendant'
	]);
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['descendant_projection_root', 'number:1'], namespace: undefined } }
	]);
});

test('Datastore descendant relation includes keep unscoped fallback when owner lacks target ancestor fields', async () => {
	const ancestorCalls: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantFallbackRelationOwnerRecord;
	const owner = (await Owner.query().include('child').load()).list[0];
	const child = await owner.ref<DatastoreDescendantProjectionRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.title, 'first descendant');
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['descendant_projection_root', 'number:1'], namespace: undefined } }
	]);
});

test('Datastore descendant relation includes reject ambiguous unscoped fallback when owner lacks target ancestor fields', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'second descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantFallbackRelationOwnerRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/Relation datastore_descendant_fallback_relation_owner_record\.child cannot choose one datastore_descendant_projection_record result because owner data lacks target Datastore ancestor fields and 2 candidates matched the relation key/
	);
});

test('Datastore descendant hasMany relations keep duplicate unscoped fallback candidates', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'second descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantFallbackRelationOwnerRecord;
	const owner = (await Owner.query().include('children').load()).list[0];
	const children = await owner.ref<DatastoreDescendantProjectionRecord>('children').load();

	assert.ok(Array.isArray(children));
	assert.deepEqual(children.map((child) => child.data.title), ['first descendant', 'second descendant']);
});

test('Datastore descendant direct one relation includes keep unscoped fallback when owner lacks target ancestor fields', async () => {
	const ancestorCalls: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_direct_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantDirectFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantDirectFallbackRelationOwnerRecord;
	const owner = (await Owner.query().include('child').load()).list[0];
	const child = await owner.ref<DatastoreDescendantProjectionRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.title, 'first descendant');
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['descendant_projection_root', 'number:1'], namespace: undefined } }
	]);
});

test('Datastore descendant direct one relation includes reject ambiguous unscoped fallback when owner lacks target ancestor fields', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_direct_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'second descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantDirectFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantDirectFallbackRelationOwnerRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/Relation datastore_descendant_direct_fallback_relation_owner_record\.child cannot choose one datastore_descendant_projection_record result because owner data lacks target Datastore ancestor fields and 2 candidates matched the relation key/
	);
});

test('Datastore descendant find include rejects ambiguous unscoped fallback when owner lacks target ancestor fields', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_direct_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'second descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantDirectFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantDirectFallbackRelationOwnerRecord;

	await assert.rejects(
		() => Owner.find(1).include('child').load(),
		/Relation datastore_descendant_direct_fallback_relation_owner_record\.child cannot choose one datastore_descendant_projection_record result because owner data lacks target Datastore ancestor fields and 2 candidates matched the relation key/
	);
});

test('Lazy Datastore descendant relations match duplicate ids by target ancestor fields', async () => {
	const ancestorCalls: unknown[] = [];
	const limits: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit(value: unknown) {
			limits[limits.length] = value;
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_relation_owner_record', [{ id: 1, rootId: 1, parentId: 20, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'left descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'right descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	const child = await owner?.ref<DatastoreDescendantProjectionRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.title, 'right descendant');
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['descendant_projection_root', 'number:1'], namespace: undefined } }
	]);
	assert.deepEqual(limits, []);
});

test('Lazy Datastore descendant direct one relations match duplicate ids by target ancestor fields', async () => {
	const ancestorCalls: unknown[] = [];
	const limits: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit(value: unknown) {
			limits[limits.length] = value;
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_direct_relation_owner_record', [{ id: 1, rootId: 1, parentId: 20, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'left descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'right descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantDirectRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantDirectRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	const child = await owner?.ref<DatastoreDescendantProjectionRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.title, 'right descendant');
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['descendant_projection_root', 'number:1'], namespace: undefined } }
	]);
	assert.deepEqual(limits, []);
});

test('Lazy Datastore descendant direct one relations keep unscoped fallback when owner lacks target ancestor fields', async () => {
	const ancestorCalls: unknown[] = [];
	const limits: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit(value: unknown) {
			limits[limits.length] = value;
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_direct_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantDirectFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantDirectFallbackRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	const child = await owner?.ref<DatastoreDescendantProjectionRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.title, 'first descendant');
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['descendant_projection_root', 'number:1'], namespace: undefined } }
	]);
	assert.deepEqual(limits, [2]);
});

test('Lazy Datastore descendant direct one relations reject ambiguous unscoped fallback when owner lacks target ancestor fields', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_direct_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'second descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreDescendantDirectFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantDirectFallbackRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	assert.ok(owner);

	await assert.rejects(
		() => owner.ref<DatastoreDescendantProjectionRecord>('child').load(),
		/Relation datastore_descendant_direct_fallback_relation_owner_record\.child cannot choose one datastore_descendant_projection_record result because owner data lacks target Datastore ancestor fields and 2 candidates matched the relation key/
	);
});

test('Lazy Datastore implicit descendant one relations reject ambiguous payload ancestor fallback', async () => {
	const limits: unknown[] = [];
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit(value: unknown) {
			limits[limits.length] = value;
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_implicit_descendant_fallback_relation_owner_record', [{ id: 1, rootId: 1, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'first implicit descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'second implicit descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreImplicitDescendantFallbackRelationOwnerRecord.use(context) as unknown as typeof DatastoreImplicitDescendantFallbackRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	assert.ok(owner);

	await assert.rejects(
		() => owner.ref<DatastoreImplicitDescendantProjectionRecord>('child').load(),
		/Relation datastore_implicit_descendant_fallback_relation_owner_record\.child cannot choose one datastore_implicit_descendant_projection_record result because owner data lacks target Datastore ancestor metadata and 2 candidates matched the relation key/
	);
	assert.deepEqual(limits, [2]);
});

test('Datastore partial relation result validation preserves scoped ancestors without ancestorFields', async () => {
	let selectedFields: string[] | undefined;
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select(fields: string[]) {
			selectedFields = fields;
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_preload_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const row = { id: 5, parentId: 10, handle: 'legacy child' };
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => {
				const fields = new Set(selectedFields ?? Object.keys(row));
				fields.add('id');
				const projected: Record<string, unknown> = {};
				for (const field of fields) projected[field] = row[field as keyof typeof row];
				return [[projected], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastorePreloadRelationOwnerRecord.use(context) as unknown as typeof DatastorePreloadRelationOwnerRecord;
	const owner = (await Owner.query().include('legacyChild').load()).list[0];
	const child = await owner.ref<DatastoreAncestorRecord>('legacyChild').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.handle, 'legacy child');
	assert.equal(child?.data.parentId, undefined);
});

test('Datastore partial relation hooks cannot move implicit payload ancestors', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_preload_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 5, parentId: 10, handle: 'legacy child' }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory },
		plugins: [
			{
				name: 'datastore-partial-relation-move-implicit-ancestor',
				hooks: {
					afterRelationLoad(payload) {
						if (
							payload.model?.name !== 'datastore_preload_relation_owner_record' ||
							payload.meta?.relation !== 'legacyChildWithParent'
						) return;
						(payload.result as DatastoreAncestorRecord).data.parentId = 11;
					}
				}
			}
		]
	});
	const Owner = DatastorePreloadRelationOwnerRecord.use(context) as unknown as typeof DatastorePreloadRelationOwnerRecord;

	await assert.rejects(
		() => Owner.query().include('legacyChildWithParent').load(),
		/afterRelationLoad datastore_preload_relation_owner_record\.legacyChildWithParent result item cannot move datastore_ancestor_record:5 outside the scoped Datastore ancestor/
	);
});

test('Datastore relation result hooks cannot move related models across ancestors', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 5, handle: 'child', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory },
		plugins: [
			{
				name: 'datastore-relation-move-ancestor',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'datastore_relation_owner_record' || payload.meta?.relation !== 'child') return;
						(payload.result as DatastoreAncestorRecord).data.parentId = 11;
					}
				}
			}
		]
	});
	const Owner = DatastoreRelationOwnerRecord.use(context) as unknown as typeof DatastoreRelationOwnerRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/afterRelationLoad datastore_relation_owner_record\.child result item cannot move datastore_ancestor_record:5 outside the scoped Datastore ancestor/
	);
});

test('Datastore relation owner hooks cannot move owner-derived target ancestors', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 5, handle: 'child', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory },
		plugins: [
			{
				name: 'datastore-relation-owner-move-ancestor',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'datastore_relation_owner_record' || payload.meta?.relation !== 'child') return;
						(payload.target as DatastoreRelationOwnerRecord).data.parentId = 11;
					}
				}
			}
		]
	});
	const Owner = DatastoreRelationOwnerRecord.use(context) as unknown as typeof DatastoreRelationOwnerRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/afterRelationLoad datastore_relation_owner_record\.child target item cannot change relation Datastore ancestor/
	);
});

async function createNamespacedRelationOwnerWithHook(afterRelationLoad: (payload: any) => void) {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_namespaced_relation_owner_record', [
		{ id: 1, parentId: 10, parentNamespace: 'tenant', childId: 5 }
	]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 5, handle: 'child', parentId: 10, parentNamespace: 'tenant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory },
		plugins: [
			{
				name: 'datastore-relation-result-drop-namespace',
				hooks: { afterRelationLoad }
			}
		]
	});
	return DatastoreNamespacedRelationOwnerRecord.use(context) as unknown as typeof DatastoreNamespacedRelationOwnerRecord;
}

test('Datastore relation owner hooks cannot drop owner-derived target ancestor namespaces', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_namespaced_relation_owner_record', [
		{ id: 1, parentId: 10, parentNamespace: 'tenant', childId: 5 }
	]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 5, handle: 'child', parentId: 10, parentNamespace: 'tenant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory },
		plugins: [
			{
				name: 'datastore-relation-owner-drop-namespace',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'datastore_namespaced_relation_owner_record' || payload.meta?.relation !== 'child') return;
						delete (payload.target as DatastoreNamespacedRelationOwnerRecord).data.parentNamespace;
					}
				}
			}
		]
	});
	const Owner = DatastoreNamespacedRelationOwnerRecord.use(context) as unknown as typeof DatastoreNamespacedRelationOwnerRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/afterRelationLoad datastore_namespaced_relation_owner_record\.child target item cannot change relation Datastore ancestor/
	);
});

test('Datastore relation hooks cannot drop owner Datastore ancestor namespaces', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	let runQueryCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => {
				runQueryCalls++;
				return [
					runQueryCalls === 1
						? [{ id: 1, parentId: 10, parentNamespace: 'tenant', childId: 5 }]
						: [{ id: 5, handle: 'child', parentId: 10 }],
					{ moreResults: 'NO_MORE_RESULTS' }
				];
			}
		})
	});
	const context = createActiveTs({
		stores: { default: datastore },
		plugins: [
			{
				name: 'datastore-owner-namespace-drop',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'datastore_namespaced_owner_relation_record' || payload.meta?.relation !== 'child') return;
						delete (payload.target as DatastoreNamespacedOwnerRelationRecord).data.parentNamespace;
					}
				}
			}
		]
	});
	const Owner = DatastoreNamespacedOwnerRelationRecord.use(context) as unknown as typeof DatastoreNamespacedOwnerRelationRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/afterRelationLoad datastore_namespaced_owner_relation_record\.child target item cannot move datastore_namespaced_owner_relation_record:1 outside the scoped Datastore ancestor/
	);
});

test('Datastore query relation result hooks cannot drop related model ancestor namespaces', async () => {
	const Owner = await createNamespacedRelationOwnerWithHook((payload) => {
		if (payload.model?.name !== 'datastore_namespaced_relation_owner_record' || payload.meta?.relation !== 'child') return;
		delete (payload.result as DatastoreNamespacedAncestorRecord).data.parentNamespace;
	});

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/afterRelationLoad datastore_namespaced_relation_owner_record\.child result item cannot move datastore_namespaced_ancestor_record:5 outside the scoped Datastore ancestor/
	);
});

test('Datastore instance relation result hooks cannot drop related model ancestor namespaces', async () => {
	const Owner = await createNamespacedRelationOwnerWithHook((payload) => {
		if (payload.model?.name !== 'datastore_namespaced_relation_owner_record' || payload.meta?.relation !== 'child') return;
		delete (payload.result as DatastoreNamespacedAncestorRecord).data.parentNamespace;
	});
	const owner = (await Owner.query().load()).list[0];
	assert.ok(owner);

	await assert.rejects(
		() => owner.include('child'),
		/afterRelationLoad datastore_namespaced_relation_owner_record\.child result item cannot move datastore_namespaced_ancestor_record:5 outside the scoped Datastore ancestor/
	);
});

test('Lazy Datastore relation result hooks cannot drop related model ancestor namespaces', async () => {
	const Owner = await createNamespacedRelationOwnerWithHook((payload) => {
		if (payload.model?.name !== 'datastore_namespaced_relation_owner_record' || payload.meta?.relation !== 'child') return;
		delete (payload.result as DatastoreNamespacedAncestorRecord).data.parentNamespace;
	});
	const owner = (await Owner.query().load()).list[0];
	assert.ok(owner);

	await assert.rejects(
		() => owner.ref<DatastoreNamespacedAncestorRecord>('child').load(),
		/afterRelationLoad datastore_namespaced_relation_owner_record\.child result item cannot move datastore_namespaced_ancestor_record:5 outside the scoped Datastore ancestor/
	);
});

test('Datastore descendant relation owner hooks cannot change target ancestor join keys', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_descendant_relation_owner_record', [{ id: 1, rootId: 1, parentId: 10, childId: 7 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[
				{ id: 7, rootId: 1, parentId: 10, title: 'left descendant' },
				{ id: 7, rootId: 1, parentId: 20, title: 'right descendant' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory },
		plugins: [
			{
				name: 'datastore-descendant-relation-owner-change-join-key',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'datastore_descendant_relation_owner_record' || payload.meta?.relation !== 'child') return;
						(payload.target as DatastoreDescendantRelationOwnerRecord).data.parentId = 20;
					}
				}
			}
		]
	});
	const Owner = DatastoreDescendantRelationOwnerRecord.use(context) as unknown as typeof DatastoreDescendantRelationOwnerRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/afterRelationLoad datastore_descendant_relation_owner_record\.child target item cannot change relation Datastore target join key/
	);
});

test('Datastore ancestor models fail fast for direct id reads without an ancestor key', async () => {
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			get: async () => {
				throw new Error('Datastore get should not run');
			}
		})
	});

	await assert.rejects(
		() => datastore.get(ancestorMeta, 1),
		/direct id reads require an ancestor-aware query/
	);
	await assert.rejects(
		() => datastore.getMany(ancestorMeta, [1]),
		/direct id reads require an ancestor-aware query/
	);
	await assert.rejects(
		() => datastore.delete(ancestorMeta, 1),
		/direct id reads require an ancestor-aware query/
	);
	await assert.rejects(
		() => datastore.get(ancestorMeta, 1, { meta: { datastoreAncestor: undefined } }),
		/direct id reads require an ancestor-aware query/
	);
	await assert.rejects(
		() => datastore.getMany(ancestorMeta, [1], { meta: { datastoreAncestor: undefined } }),
		/direct id reads require an ancestor-aware query/
	);
	await assert.rejects(
		() => datastore.delete(ancestorMeta, 1, { meta: { datastoreAncestor: undefined } }),
		/direct id reads require an ancestor-aware query/
	);
});

test('Datastore ancestor writes reject explicit undefined ancestor metadata', async () => {
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: () => assert.fail('Datastore key factory should not run for undefined write ancestor metadata'),
			insert: async () => assert.fail('Datastore insert should not run for undefined write ancestor metadata'),
			update: async () => assert.fail('Datastore update should not run for undefined write ancestor metadata')
		})
	});

	await assert.rejects(
		() =>
			datastore.create(
				ancestorMeta,
				1,
				{ id: 1, handle: 'one', parentId: 10 },
				{ meta: { datastoreAncestor: undefined } }
			),
		/write metadata cannot set datastoreAncestor to undefined/
	);
	await assert.rejects(
		() =>
			datastore.update(
				ancestorMeta,
				1,
				{ id: 1, handle: 'two', parentId: 10 },
				{ meta: { datastoreAncestor: undefined } }
			),
		/write metadata cannot set datastoreAncestor to undefined/
	);
});

test('Datastore ancestor models reject static find before entity cache lookup', async () => {
	const cache = new MemoryCacheAdapter();
	await cache.setMany([
		['datastore_ancestor_record:number:1', { id: 1, handle: 'cached', parentId: 10 }]
	]);
	cache.resetStats();
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			get: async () => {
				throw new Error('Datastore get should not run');
			}
		})
	});
	const context = createActiveTs({
		stores: { default: datastore },
		caches: { default: cache }
	});
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;

	await assert.rejects(
		() => Record.find(1).load(),
		/direct id reads require an ancestor-aware query/
	);
	assert.equal(cache.stats.getMany, 0);
});

test('Datastore write metadata can explicitly override create update and delete ancestors', async () => {
	const sdkKeys: unknown[] = [];
	const inserted: unknown[] = [];
	const updated: unknown[] = [];
	const deleted: unknown[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			insert: async (entity: unknown) => {
				inserted[inserted.length] = entity;
			},
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			},
			delete: async (key: unknown) => {
				deleted[deleted.length] = key;
			}
		})
	});
	const manualParent = datastoreKey('parent_record', 10);

	await datastore.create(
		ancestorMeta,
		1,
		{ id: 1, handle: 'one', parentId: 10 },
		{ meta: { datastoreAncestor: manualParent } }
	);
	await datastore.update(
		ancestorMeta,
		1,
		{ id: 1, handle: 'two', parentId: 10 },
		{ meta: { datastoreAncestor: manualParent } }
	);
	await datastore.delete(ancestorMeta, 1, { meta: { datastoreAncestor: manualParent } });

	assert.deepEqual(inserted, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: undefined } },
			data: { id: 1, handle: 'one', parentId: 10 },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(updated, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: undefined } },
			data: { id: 1, handle: 'two', parentId: 10 },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(deleted, [
		{ input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: undefined } }
	]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: undefined },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: undefined },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: undefined }
	]);
});

test('Datastore low-level writes reject metadata ancestors that conflict with payload data', async () => {
	const rootCalls: string[] = [];
	const transactionCalls: string[] = [];
	const mismatchedParent = datastoreKey('parent_record', 20);
	const transaction = () => ({
		run: async () => {
			transactionCalls[transactionCalls.length] = 'run';
		},
		commit: async () => {
			transactionCalls[transactionCalls.length] = 'commit';
		},
		rollback: async () => {
			transactionCalls[transactionCalls.length] = 'rollback';
		},
		get: async () => {
			transactionCalls[transactionCalls.length] = 'get';
			return [null];
		},
		insert: async () => {
			transactionCalls[transactionCalls.length] = 'insert';
		},
		update: async () => {
			transactionCalls[transactionCalls.length] = 'update';
		},
		delete: async () => {
			transactionCalls[transactionCalls.length] = 'delete';
		},
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			insert: async () => {
				rootCalls[rootCalls.length] = 'insert';
			},
			update: async () => {
				rootCalls[rootCalls.length] = 'update';
			},
			transaction
		})
	});
	const namespacedMeta = createActiveTs({ stores: { default: datastore } }).meta(DatastoreNamespacedAncestorRecord);
	const encodedAncestorMeta = createActiveTs({ stores: { default: datastore } })
		.meta(DatastoreEncodedAncestorRecord) as ResolvedModelMeta<any>;
	const encodedAncestorFieldMeta = createActiveTs({ stores: { default: datastore } })
		.meta(DatastoreEncodedAncestorFieldRecord) as ResolvedModelMeta<any>;
	const encodedAncestorPayload = { id: 1, handle: 'encoded', parentId: 'parent:10' };
	const encodedPayload = { id: 1, handle: 'encoded', parentId: 'parent:10', score: 7 };

	await assert.rejects(
		() =>
			datastore.create(
				ancestorMeta,
				1,
				{ id: 1, handle: 'one', parentId: 10 },
				{ meta: { datastoreAncestor: mismatchedParent } }
			),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.update(
				ancestorMeta,
				1,
				{ id: 1, handle: 'two', parentId: 10 },
				{ meta: { datastoreAncestor: mismatchedParent } }
			),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.create(
				namespacedMeta,
				1,
				{ id: 1, handle: 'one', parentId: 10, parentNamespace: 'tenant' },
				{ meta: { datastoreAncestor: datastoreKey('parent_record', 10) } }
			),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.create(
				encodedAncestorMeta,
				1,
				encodedAncestorPayload,
				{ meta: { datastoreAncestor: mismatchedParent } }
			),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.update(
				encodedAncestorMeta,
				1,
				encodedAncestorPayload,
				{ meta: { datastoreAncestor: mismatchedParent } }
			),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.create(
				encodedAncestorFieldMeta,
				1,
				encodedPayload,
				{ meta: { datastoreAncestor: mismatchedParent } }
			),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.update(
				encodedAncestorFieldMeta,
				1,
				encodedPayload,
				{ meta: { datastoreAncestor: mismatchedParent } }
			),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	assert.deepEqual(rootCalls, []);

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.create(
					ancestorMeta,
					1,
					{ id: 1, handle: 'one', parentId: 10 },
					{ meta: { datastoreAncestor: mismatchedParent } }
				);
			}),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.update(
					ancestorMeta,
					1,
					{ id: 1, handle: 'two', parentId: 10 },
					{ meta: { datastoreAncestor: mismatchedParent } }
				);
			}),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.create(
					encodedAncestorMeta,
					1,
					encodedAncestorPayload,
					{ meta: { datastoreAncestor: mismatchedParent } }
				);
			}),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.update(
					encodedAncestorMeta,
					1,
					encodedAncestorPayload,
					{ meta: { datastoreAncestor: mismatchedParent } }
				);
			}),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.create(
					encodedAncestorFieldMeta,
					1,
					encodedPayload,
					{ meta: { datastoreAncestor: mismatchedParent } }
				);
			}),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.update(
					encodedAncestorFieldMeta,
					1,
					encodedPayload,
					{ meta: { datastoreAncestor: mismatchedParent } }
				);
			}),
		/write metadata datastoreAncestor must match payload Datastore ancestor/
	);
	assert.deepEqual(transactionCalls, [
		'run', 'rollback',
		'run', 'rollback',
		'run', 'rollback',
		'run', 'rollback',
		'run', 'rollback',
		'run', 'rollback'
	]);
});

test('Datastore ancestor query find requires an explicit ancestor scope', async () => {
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_ancestor_record', [{ id: 1, handle: 'one', parentId: 10 }]);
	const context = createActiveTs({ stores: { default: memory } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;

	await assert.rejects(
		() => Record.query().find(1).load(),
		/direct id reads require an ancestor-aware query/
	);
});

test('Datastore scoped find writes cannot escape into an explicit namespace', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 1, handle: 'one', parentId: 10, parentNamespace: 'escaped' }], { moreResults: 'NO_MORE_RESULTS' }],
			update: async () => assert.fail('Datastore update should not run after namespace escape')
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreNamespacedAncestorRecord.use(context) as unknown as typeof DatastoreNamespacedAncestorRecord;

	await assert.rejects(
		() => Record.ancestor(datastoreKey('parent_record', 10)).find(1).update({ handle: 'two' }),
		/(payload Datastore ancestor resolved outside the scoped Datastore ancestor|cannot move datastore_namespaced_ancestor_record:1 outside the scoped Datastore ancestor)/
	);
});

test('Datastore scoped find writes preserve explicit query namespaces', async () => {
	const sdkKeys: unknown[] = [];
	const updated: unknown[] = [];
	const deleted: unknown[] = [];
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 1, handle: 'one', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }],
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			},
			delete: async (key: unknown) => {
				deleted[deleted.length] = key;
			}
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;
	const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });

	await Record.ancestor(parent).find(1).update({ handle: 'two' });
	await Record.ancestor(parent).find(1).delete();

	assert.deepEqual(updated, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } },
			data: { id: 1, handle: 'two', parentId: 10 },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(deleted, [
		{ input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } }
	]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('Datastore direct store reads use explicit ancestor metadata', async () => {
	const sdkKeys: unknown[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			get: async (input: unknown) => {
				if (Array.isArray(input)) {
					return [[{ id: 1, handle: 'many', parentId: 10 }]];
				}
				return [{ id: 1, handle: 'one', parentId: 10 }];
			}
		})
	});
	const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });

	assert.deepEqual(
		await datastore.get(ancestorMeta, 1, { meta: { datastoreAncestor: parent } }),
		{ id: 1, handle: 'one', parentId: 10 }
	);
	assert.deepEqual(
		await datastore.getMany(ancestorMeta, [1], { meta: { datastoreAncestor: parent } }),
		[{ id: 1, handle: 'many', parentId: 10 }]
	);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('Datastore direct store reads compare returned entity keys with adapter namespaces', async () => {
	const keySymbol = Symbol('datastore-key');
	const sdkKeys: unknown[] = [];
	const entity = Object.defineProperty(
		{ id: 1, handle: 'one', parentId: 10 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1], namespace: 'tenant' } }
	);
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'tenant',
		client: datastoreClient({
			KEY: keySymbol,
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			get: async (input: unknown) => Array.isArray(input) ? [[entity]] : [entity]
		})
	});
	const parent = datastoreKey('parent_record', 10);

	assert.deepEqual(
		await datastore.get(ancestorMeta, 1, { meta: { datastoreAncestor: parent } }),
		{ id: 1, handle: 'one', parentId: 10 }
	);
	assert.deepEqual(
		await datastore.getMany(ancestorMeta, [1], { meta: { datastoreAncestor: parent } }),
		[{ id: 1, handle: 'one', parentId: 10 }]
	);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('Datastore scoped full rows reject keyless payload ancestors outside scoped ancestors', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const wrongRow = { id: 1, handle: 'wrong-parent', parentId: 11, score: 5 };
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastoreForRow = async (row: Record<string, unknown>) => createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			get: async (input: unknown) => Array.isArray(input) ? [[row]] : [row],
			runQuery: async () => [[row], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		allowQueryScanFallback: true,
		allowAggregateScanFallback: true
	});
	const datastore = await datastoreForRow(wrongRow);
	const rejection = /payload Datastore ancestor resolved outside the scoped Datastore ancestor/;

	await assert.rejects(
		() => datastore.get(typedAncestorMeta, 1, { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.getMany(typedAncestorMeta, [1], { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.query(typedAncestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
	await assert.rejects(
		() => datastore.query(typedAncestorMeta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
	await assert.rejects(
		() => datastore.aggregate!(typedAncestorMeta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);

	const partialDatastore = await datastoreForRow({ id: 1, handle: 'partial' });
	assert.deepEqual(
		await partialDatastore.query(typedAncestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['handle'],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		{ list: [{ id: 1, handle: 'partial' }], more: false }
	);
});

test('Datastore scoped full rows reject keyed payload ancestors outside scoped ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const scopedAncestor = datastoreKey('parent_record', 10);
	const keyedWrongRow = () => Object.defineProperty(
		{ id: 1, handle: 'wrong-keyed-parent', parentId: 11, score: 5 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1] } }
	);
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => query,
			get: async (input: unknown) => Array.isArray(input) ? [[keyedWrongRow()]] : [keyedWrongRow()],
			runQuery: async () => [[keyedWrongRow()], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const rejection = /payload Datastore ancestor resolved outside the scoped Datastore ancestor/;

	await assert.rejects(
		() => datastore.get(typedAncestorMeta, 1, { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.getMany(typedAncestorMeta, [1], { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.query(typedAncestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);

	const calls: string[] = [];
	const transaction = {
		run: async () => {
			calls[calls.length] = 'run';
		},
		commit: async () => {
			calls[calls.length] = 'commit';
		},
		rollback: async () => {
			calls[calls.length] = 'rollback';
		},
		get: async () => [null],
		runQuery: async () => {
			calls[calls.length] = 'runQuery';
			return [[keyedWrongRow()], { moreResults: 'NO_MORE_RESULTS' }];
		},
		save: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const txDatastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			transaction: () => transaction,
			createQuery: () => query
		})
	});

	await assert.rejects(
		() =>
			txDatastore.transaction!(async (tx) => {
				await tx.query(typedAncestorMeta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					meta: { datastoreAncestor: scopedAncestor }
				});
			}),
		rejection
	);
	assert.deepEqual(calls, ['run', 'runQuery', 'rollback']);
});

test('Datastore scoped SDK id keys still validate payload ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const scopedAncestor = datastoreKey('parent_record', 10);
	const sdkIdKeyedWrongRow = () => Object.defineProperty(
		{ id: 1, handle: 'wrong-sdk-id-keyed-parent', parentId: 11, score: 5 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1], id: 1 }, enumerable: false }
	);
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => query,
			get: async (input: unknown) => Array.isArray(input) ? [[sdkIdKeyedWrongRow()]] : [sdkIdKeyedWrongRow()],
			runQuery: async () => [[sdkIdKeyedWrongRow()], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const rejection = /payload Datastore ancestor resolved outside the scoped Datastore ancestor/;

	await assert.rejects(
		() => datastore.getMany(typedAncestorMeta, [1], { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.query(typedAncestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
});

test('Datastore scoped projection rows reject selected payload ancestors outside scoped ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const scopedAncestor = datastoreKey('parent_record', 10);
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		datastore: { ...ancestorMeta.datastore!, ancestorFields: ['parentId'] }
	};
	const keyedWrongProjectionRow = () => Object.defineProperty(
		{ id: 1, parentId: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1] } }
	);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => query,
			runQuery: async () => [[keyedWrongProjectionRow()], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	await assert.rejects(
		() => datastore.query(typedAncestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['parentId'],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);

	const partialDatastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => query,
			runQuery: async () => [[Object.defineProperty(
				{ id: 1, handle: 'partial-selected-row' },
				keySymbol,
				{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1] } }
			)], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	assert.deepEqual(
		await partialDatastore.query(typedAncestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['handle'],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		{ list: [{ id: 1, handle: 'partial-selected-row' }], more: false }
	);
});

test('Datastore scoped projection rows validate selected payload ancestors without ancestorFields', async () => {
	const keySymbol = Symbol('datastore-key');
	const scopedAncestor = datastoreKey('parent_record', 10);
	const keyedWrongProjectionRow = () => Object.defineProperty(
		{ id: 1, parentId: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1] } }
	);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => query,
			runQuery: async () => [[keyedWrongProjectionRow()], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	await assert.rejects(
		() => datastore.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['parentId'],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore scoped full rows reject keyless payload ancestors with different kind shapes', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const wrongRow = {
		id: 1,
		handle: 'wrong-kind',
		parentKind: 'other_parent_record',
		parentId: 11,
		score: 5
	};
	const dynamicMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(
		DatastoreDynamicAncestorRecord
	);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			get: async (input: unknown) => Array.isArray(input) ? [[wrongRow]] : [wrongRow],
			runQuery: async () => [[wrongRow], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		allowQueryScanFallback: true,
		allowAggregateScanFallback: true
	});
	const rejection = /payload Datastore ancestor resolved outside the scoped Datastore ancestor/;

	await assert.rejects(
		() => datastore.get(dynamicMeta, 1, { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.getMany(dynamicMeta, [1], { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.query(dynamicMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
	await assert.rejects(
		() => datastore.query(dynamicMeta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
	await assert.rejects(
		() => datastore.aggregate!(dynamicMeta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
});

test('Datastore scoped rows reject implicit payload ancestors with different kind shapes', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const wrongRow = {
		id: 1,
		handle: 'implicit-wrong-kind',
		parentKind: 'other_parent_record',
		parentId: 11,
		score: 5
	};
	const dynamicMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(
		DatastoreImplicitDynamicAncestorRecord
	);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			runQuery: async () => [[wrongRow], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	await assert.rejects(
		() => datastore.query(dynamicMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore transaction scoped queries reject keyless payload ancestors with different kind shapes', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const wrongRow = {
		id: 1,
		handle: 'wrong-transaction-kind',
		parentKind: 'other_parent_record',
		parentId: 11,
		score: 5
	};
	const dynamicMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(
		DatastoreDynamicAncestorRecord
	);
	const calls: string[] = [];
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const transaction = {
		run: async () => {
			calls[calls.length] = 'run';
		},
		commit: async () => {
			calls[calls.length] = 'commit';
		},
		rollback: async () => {
			calls[calls.length] = 'rollback';
		},
		get: async () => {
			calls[calls.length] = 'get';
			return [null];
		},
		runQuery: async () => {
			calls[calls.length] = 'runQuery';
			return [[wrongRow], { moreResults: 'NO_MORE_RESULTS' }];
		},
		save: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => transaction,
			createQuery: () => query,
			key: (input: unknown) => input
		})
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.query(dynamicMeta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					meta: { datastoreAncestor: scopedAncestor }
				});
			}),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
	assert.deepEqual(calls, ['run', 'runQuery', 'rollback']);
});

test('Datastore transaction scoped queries reject implicit payload ancestors with different kind shapes', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const wrongRow = {
		id: 1,
		handle: 'implicit-transaction-wrong-kind',
		parentKind: 'other_parent_record',
		parentId: 11,
		score: 5
	};
	const dynamicMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(
		DatastoreImplicitDynamicAncestorRecord
	);
	const calls: string[] = [];
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const transaction = {
		run: async () => {
			calls[calls.length] = 'run';
		},
		commit: async () => {
			calls[calls.length] = 'commit';
		},
		rollback: async () => {
			calls[calls.length] = 'rollback';
		},
		get: async () => [null],
		runQuery: async () => {
			calls[calls.length] = 'runQuery';
			return [[wrongRow], { moreResults: 'NO_MORE_RESULTS' }];
		},
		save: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => transaction,
			createQuery: () => query,
			key: (input: unknown) => input
		})
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.query(dynamicMeta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					meta: { datastoreAncestor: scopedAncestor }
				});
			}),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
	assert.deepEqual(calls, ['run', 'runQuery', 'rollback']);
});

test('Datastore scoped keyless payload validation decodes ancestor field codecs', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const row = { id: 1, parentId: 'parent:10', score: 7, handle: 'encoded scoped' };
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DatastoreEncodedAncestorFieldRecord);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			get: async (input: unknown) => Array.isArray(input) ? [[row]] : [row],
			runQuery: async () => [[row], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		allowQueryScanFallback: true,
		allowAggregateScanFallback: true
	});

	assert.deepEqual(
		await datastore.get(meta, 1, { meta: { datastoreAncestor: scopedAncestor } }),
		row
	);
	assert.deepEqual(
		await datastore.getMany(meta, [1], { meta: { datastoreAncestor: scopedAncestor } }),
		[row]
	);
	assert.deepEqual(
		await datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		{ list: [row], more: false }
	);
	assert.deepEqual(
		await datastore.query(meta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		{ list: [row], more: false }
	);
	assert.deepEqual(
		await datastore.aggregate!(meta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		{ totalScore: 7 }
	);
});

test('Datastore scoped keyless payload validation decodes nested ancestor field codecs', async () => {
	const scopedAncestor = datastoreKey('nested_parent_record', 10);
	const wrongRow = {
		id: 1,
		profile: JSON.stringify({ parentId: 11, label: 'wrong' }),
		score: 7,
		handle: 'nested encoded scoped'
	};
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DatastoreNestedEncodedAncestorRecord);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			get: async (input: unknown) => Array.isArray(input) ? [[wrongRow]] : [wrongRow],
			runQuery: async () => [[wrongRow], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		allowQueryScanFallback: true,
		allowAggregateScanFallback: true
	});
	const rejection = /payload Datastore ancestor resolved outside the scoped Datastore ancestor/;

	await assert.rejects(
		() => datastore.get(meta, 1, { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.getMany(meta, [1], { meta: { datastoreAncestor: scopedAncestor } }),
		rejection
	);
	await assert.rejects(
		() => datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
	await assert.rejects(
		() => datastore.query(meta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
	await assert.rejects(
		() => datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			select: ['profile', 'score'],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
	await assert.rejects(
		() => datastore.aggregate!(meta, {
			where: [{ field: 'score', op: '!=', value: null }],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		rejection
	);
});

test('Datastore scoped reads decode field-codec ancestor payloads without ancestorFields', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const row = {
		id: 1,
		parentId: 'parent:10',
		handle: 'encoded scoped'
	};
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DatastoreEncodedAncestorRecord);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		start() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			get: async (input: unknown) => Array.isArray(input) ? [[row]] : [row],
			runQuery: async () => [[row], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		allowQueryScanFallback: true
	});
	const plan: QueryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	};

	assert.deepEqual(await datastore.get(meta, 1, { meta: { datastoreAncestor: scopedAncestor } }), row);
	assert.deepEqual(await datastore.getMany(meta, [1], { meta: { datastoreAncestor: scopedAncestor } }), [row]);
	assert.deepEqual(await datastore.query(meta, plan), { list: [row], more: false });
});

test('Datastore context store results decode nested ancestor field codecs', async () => {
	const scopedAncestor = datastoreKey('nested_parent_record', 10);
	const wrongRow = {
		id: 1,
		profile: JSON.stringify({ parentId: 11, label: 'wrong' }),
		score: 7,
		handle: 'nested wrong'
	};
	const store: StoreAdapter = {
		kind: 'nested-encoded-ancestor-result-store',
		capabilities: { datastoreAncestor: true },
		get: async () => wrongRow,
		getMany: async (_model, ids) => ids.map(() => wrongRow),
		query: async () => ({ list: [wrongRow], count: 1 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(DatastoreNestedEncodedAncestorRecord);
	const queryPlan: QueryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	};

	await assert.rejects(
		() => context.store('default').query(meta, queryPlan),
		/context store query result\.list\[0\] for Datastore model "datastore_nested_encoded_ancestor_record" resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore search identities decode nested ancestor field codecs', () => {
	const scopedAncestor = datastoreKey('nested_parent_record', 10);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DatastoreNestedEncodedAncestorRecord);
	const payload = {
		id: 7,
		profile: JSON.stringify({ parentId: 10, label: 'search' }),
		score: 7,
		handle: 'nested search'
	};
	const wrongPayload = {
		id: 7,
		profile: JSON.stringify({ parentId: 11, label: 'wrong search' }),
		score: 7,
		handle: 'nested wrong search'
	};
	const identity = datastoreSearchDocumentIdentity(meta, 7, scopedAncestor);

	assert.equal(searchDocumentIdentity(meta, 7, 'nested Datastore search identity', payload), identity);
	assert.throws(
		() => searchDocumentIdentity(
			{ ...meta, searchDocumentIdentity: identity },
			7,
			'nested forced Datastore search identity',
			wrongPayload
		),
		/does not match its Datastore payload data/
	);
});

test('context search result validation decodes nested ancestor field codecs', async () => {
	const parent = datastoreKey('nested_parent_record', 10);
	const contextForMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = contextForMeta.meta(DatastoreNestedEncodedAncestorRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(meta, 7, parent);
	const search: SearchAdapter = {
		kind: 'nested-encoded-context-search',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markSearchDocumentIdentity(
						{
							id: 7,
							profile: JSON.stringify({ parentId: 11, label: 'wrong' }),
							score: 7,
							handle: 'needle'
						},
						forcedIdentity
					)
				],
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { custom: search }
	});

	await assert.rejects(
		() => context.searchAdapter('custom').search(
			{ ...context.meta(DatastoreNestedEncodedAncestorRecord), searchDocumentIdentity: forcedIdentity },
			'needle',
			{}
		),
		/context search result\.list\[0\] search document identity does not match its Datastore payload data/
	);
});

test('context search result validation checks implicit Datastore ancestor payloads', async () => {
	const parent = datastoreKey('parent_record', 10);
	const contextForMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = contextForMeta.meta(DatastoreAncestorRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(meta, 1, parent);
	const search: SearchAdapter = {
		kind: 'implicit-ancestor-context-search',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markSearchDocumentIdentity(
						{ id: 1, parentId: 11, handle: 'wrong parent' },
						forcedIdentity
					)
				],
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { custom: search }
	});

	await assert.rejects(
		() => context.searchAdapter('custom').search(
			{ ...context.meta(DatastoreAncestorRecord), searchDocumentIdentity: forcedIdentity },
			'needle',
			{}
		),
		/context search result\.list\[0\] search document identity does not match its Datastore payload data/
	);
});

test('forced Datastore search identities validate implicit payload ancestors', async () => {
	const parent = datastoreKey('parent_record', 10);
	const contextForMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = contextForMeta.meta(DatastoreAncestorRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(meta, 1, parent);
	const forcedMeta = { ...meta, searchDocumentIdentity: forcedIdentity };
	const wrongPayload = { id: 1, parentId: 11, handle: 'wrong parent' };

	assert.throws(
		() => searchDocumentIdentity(
			forcedMeta,
			1,
			'forced implicit Datastore search identity',
			wrongPayload
		),
		/does not match its Datastore payload data/
	);

	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'forced-implicit-ancestor-search',
			capabilities: {
				where: false,
				nestedFields: true,
				numericComparisons: false,
				nullOperators: false,
				cursor: false,
				native: false,
				index: false
			},
			async search() {
				return { list: [wrongPayload], count: 1 };
			},
			async index() {},
			async delete() {}
		},
		[]
	);

	await assert.rejects(
		() => wrapped.search(forcedMeta, 'needle', {}),
		/search document identity does not match its Datastore payload data/
	);
});

test('forced Datastore search identities decode field-codec payload ancestors without ancestorFields', () => {
	const parent = datastoreKey('parent_record', 10);
	const contextForMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = contextForMeta.meta(DatastoreEncodedAncestorRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(meta, 1, parent);
	const rawEncodedIdentity = datastoreSearchDocumentIdentity(meta, 1, datastoreKey('parent_record', 'parent:10'));
	const forcedMeta = { ...meta, searchDocumentIdentity: forcedIdentity };

	assert.notEqual(rawEncodedIdentity, forcedIdentity);
	assert.equal(
		searchDocumentIdentity(
			meta,
			1,
			'implicit decoded Datastore search identity',
			{ id: 1, parentId: 10, handle: 'decoded parent' }
		),
		forcedIdentity
	);
	assert.equal(
		searchDocumentIdentity(
			forcedMeta,
			1,
			'forced encoded implicit Datastore search identity',
			{ id: 1, parentId: 'parent:10', handle: 'encoded parent' }
		),
		forcedIdentity
	);
	assert.equal(
		searchDocumentIdentity(
			forcedMeta,
			1,
			'forced decoded implicit Datastore search identity',
			{ id: 1, parentId: 10, handle: 'decoded parent' }
		),
		forcedIdentity
	);
	assert.throws(
		() => searchDocumentIdentity(
			{ ...meta, searchDocumentIdentity: rawEncodedIdentity },
			1,
			'forced raw encoded Datastore search identity',
			{ id: 1, parentId: 'parent:10', handle: 'encoded parent' }
		),
		/does not match its Datastore payload data/
	);
	assert.throws(
		() => searchDocumentIdentity(
			forcedMeta,
			1,
			'forced encoded implicit Datastore search identity mismatch',
			{ id: 1, parentId: 'parent:11', handle: 'wrong encoded parent' }
		),
		/does not match its Datastore payload data/
	);
});

test('forced Datastore search identities decode object field-codec payload ancestors', () => {
	const parent = datastoreKey('object_parent_record', 10);
	const contextForMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = contextForMeta.meta(DatastoreObjectEncodedAncestorRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(meta, 1, parent);
	const forcedMeta = { ...meta, searchDocumentIdentity: forcedIdentity };

	assert.equal(
		searchDocumentIdentity(
			forcedMeta,
			1,
			'forced object-encoded Datastore search identity',
			{ id: 1, parentId: { value: 10 }, handle: 'stored parent' } as any
		),
		forcedIdentity
	);
	assert.equal(
		searchDocumentIdentity(
			forcedMeta,
			1,
			'forced object-decoded Datastore search identity',
			{ id: 1, parentId: 10, handle: 'decoded parent' }
		),
		forcedIdentity
	);
	assert.throws(
		() => searchDocumentIdentity(
			forcedMeta,
			1,
			'forced object-encoded Datastore search identity mismatch',
			{ id: 1, parentId: { value: 11 }, handle: 'wrong parent' } as any
		),
		/does not match its Datastore payload data/
	);
});

test('Datastore partial search hooks decode object field-codec payload ancestors', async () => {
	const parent = datastoreKey('object_search_parent_record', 10);
	const contextForMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = contextForMeta.meta(DatastoreObjectEncodedSearchRecord);
	const searchHit = markSearchDocumentIdentity(
		{ id: 1, parentId: { value: 10 }, title: 'needle parent', handle: 'hidden' } as any,
		datastoreSearchDocumentIdentity(meta, 1, parent)
	);
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [searchHit],
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});
	const Record = DatastoreObjectEncodedSearchRecord.use(context) as unknown as typeof DatastoreObjectEncodedSearchRecord;

	const result = await Record.search('needle').using('memory').load();

	assert.deepEqual(result.list.map((item) => item.data), [
		{ id: 1, parentId: { value: 10 }, title: 'needle parent' }
	]);
});

test('Datastore scoped query normalization decodes object field-codec payload ancestors', async () => {
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			runQuery: async () => [[{
				id: 1,
				parentId: { value: 10 },
				handle: 'stored parent'
			}], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreObjectEncodedAncestorRecord.use(context) as unknown as typeof DatastoreObjectEncodedAncestorRecord;
	const parent = datastoreKey('object_parent_record', 10);

	const loaded = await Record.ancestor(parent).find(1).load();

	assert.deepEqual(loaded?.data, { id: 1, parentId: 10, handle: 'stored parent' });
});

test('Datastore direct root reads reject returned entity keys with unexpected scopes', async () => {
	const keySymbol = Symbol('datastore-key');
	let entity = Object.defineProperty(
		{ id: 1, handle: 'wrong-parent' },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'google_regression_record', 1] } }
	);
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'tenant',
		client: datastoreClient({
			KEY: keySymbol,
			get: async (input: unknown) => Array.isArray(input) ? [[entity]] : [entity]
		})
	});

	await assert.rejects(
		() => datastore.get(meta, 1),
		/entity key must not contain a Datastore ancestor/
	);
	await assert.rejects(
		() => datastore.getMany(meta, [1]),
		/entity key must not contain a Datastore ancestor/
	);

	entity = Object.defineProperty(
		{ id: 1, handle: 'wrong-namespace' },
		keySymbol,
		{ value: { path: ['google_regression_record', 1], namespace: 'other' } }
	);
	await assert.rejects(
		() => datastore.get(meta, 1),
		/entity key namespace must match the requested Datastore namespace/
	);
	await assert.rejects(
		() => datastore.getMany(meta, [1]),
		/entity key namespace must match the requested Datastore namespace/
	);
});

test('Datastore root queries reject returned entity keys with unexpected scopes', async () => {
	const keySymbol = Symbol('datastore-key');
	let entity = Object.defineProperty(
		{ id: 1, handle: 'wrong-parent' },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'google_regression_record', 1] } }
	);
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'tenant',
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => ({
				filter() {
					return this;
				},
				order() {
					return this;
				},
				limit() {
					return this;
				},
				select() {
					return this;
				}
			}),
			runQuery: async () => [[entity], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const plan: QueryPlan = { where: [], or: [], sort: [], include: [] };

	await assert.rejects(
		() => datastore.query(meta, plan),
		/entity key must not contain a Datastore ancestor/
	);

	entity = Object.defineProperty(
		{ id: 1, handle: 'wrong-namespace' },
		keySymbol,
		{ value: { path: ['google_regression_record', 1], namespace: 'other' } }
	);
	await assert.rejects(
		() => datastore.query(meta, plan),
		/entity key namespace must match the requested Datastore namespace/
	);
});

test('Datastore transaction existence reads compare entity keys with adapter namespaces', async () => {
	const keySymbol = Symbol('datastore-key');
	const sdkKeys: unknown[] = [];
	const updated: unknown[] = [];
	const entity = Object.defineProperty(
		{ id: 1, handle: 'one', parentId: 10 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1], namespace: 'tenant' } }
	);
	const transaction = {
		run: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined,
		get: async () => [entity],
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		update: async (payload: unknown) => {
			updated[updated.length] = payload;
		},
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'tenant',
		client: datastoreClient({
			KEY: keySymbol,
			transaction: () => transaction,
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			}
		})
	});
	const parent = datastoreKey('parent_record', 10);

	await datastore.transaction!(async (tx) => {
		await tx.update(
			ancestorMeta,
			1,
			{ id: 1, handle: 'updated', parentId: 10 },
			{ meta: { datastoreAncestor: parent } }
		);
	});

	assert.deepEqual(updated, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } },
			data: { id: 1, handle: 'updated', parentId: 10 },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('Datastore transaction existence reads validate inferred write ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const wrongAncestorEntity = Object.defineProperty(
		{ id: 1, handle: 'wrong-parent', parentId: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 11, 'datastore_ancestor_record', 1], namespace: undefined } }
	);
	const transaction = {
		run: async () => undefined,
		commit: async () => assert.fail('Datastore transaction should not commit after mismatched existence read'),
		rollback: async () => undefined,
		get: async () => [wrongAncestorEntity],
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		update: async () => assert.fail('Datastore update should not run after mismatched existence read'),
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			transaction: () => transaction,
			key: (input: unknown) => input
		})
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.update(ancestorMeta, 1, { id: 1, handle: 'updated', parentId: 10 });
			}),
		/Datastore transaction update datastore_ancestor_record:1 entity key must match the requested Datastore ancestor/
	);
});

test('Datastore transaction existence reads reject keyless rows outside scoped ancestors', async () => {
	const calls: string[] = [];
	const transaction = {
		run: async () => {
			calls[calls.length] = 'run';
		},
		commit: async () => {
			calls[calls.length] = 'commit';
		},
		rollback: async () => {
			calls[calls.length] = 'rollback';
		},
		get: async () => {
			calls[calls.length] = 'get';
			return [{ id: 1, handle: 'wrong-parent', parentId: 11 }];
		},
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		update: async () => {
			calls[calls.length] = 'update';
		},
		delete: async () => undefined
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			transaction: () => transaction,
			key: (input: unknown) => input
		})
	});

	await assert.rejects(
		() =>
			datastore.transaction!(async (tx) => {
				await tx.update(ancestorMeta, 1, { id: 1, handle: 'updated', parentId: 10 });
			}),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
	assert.deepEqual(calls, ['run', 'get', 'rollback']);
});

test('Datastore direct store reads accept SDK key path accessors', async () => {
	class FakeDatastoreSdkKey {
		namespace = 'tenant';
		id = undefined;
		name = 'number:1';
		kind = 'datastore_ancestor_record';
		parent = undefined;
	}
	const keySymbol = Symbol('datastore-key');
	const sdkKey = new FakeDatastoreSdkKey();
	Object.defineProperty(sdkKey, 'path', {
		get: () => ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'],
		enumerable: true
	});
	const entity = Object.defineProperty(
		{ id: 1, handle: 'one', parentId: 10 },
		keySymbol,
		{ value: sdkKey }
	);
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'tenant',
		client: datastoreClient({
			KEY: keySymbol,
			get: async (input: unknown) => Array.isArray(input) ? [[entity]] : [entity]
		})
	});
	const parent = datastoreKey('parent_record', 10);

	assert.deepEqual(
		await datastore.get(ancestorMeta, 1, { meta: { datastoreAncestor: parent } }),
		{ id: 1, handle: 'one', parentId: 10 }
	);
	assert.deepEqual(
		await datastore.getMany(ancestorMeta, [1], { meta: { datastoreAncestor: parent } }),
		[{ id: 1, handle: 'one', parentId: 10 }]
	);
});

test('Datastore direct store reads reject entity keys outside explicit ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const wrongEntity = Object.defineProperty(
		{ id: 1, handle: 'wrong', parentId: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 11, 'datastore_ancestor_record', 1] } }
	);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			get: async (input: unknown) => Array.isArray(input) ? [[wrongEntity]] : [wrongEntity]
		})
	});
	const parent = datastoreKey('parent_record', 10);

	await assert.rejects(
		() => datastore.get(ancestorMeta, 1, { meta: { datastoreAncestor: parent } }),
		/entity key must match the requested Datastore ancestor/
	);
	await assert.rejects(
		() => datastore.getMany(ancestorMeta, [1], { meta: { datastoreAncestor: parent } }),
		/entity key must match the requested Datastore ancestor/
	);
});

test('Datastore scoped queries reject entity keys outside explicit ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const wrongEntity = Object.defineProperty(
		{ id: 1, handle: 'wrong', parentId: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 11, 'datastore_ancestor_record', 1] } }
	);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => ({
				hasAncestor() {
					return this;
				},
				filter() {
					return this;
				},
				order() {
					return this;
				},
				limit() {
					return this;
				},
				select() {
					return this;
				}
			}),
			runQuery: async () => [[wrongEntity], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const parent = datastoreKey('parent_record', 10);
	const plan: QueryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: parent }
	};

	await assert.rejects(
		() => datastore.query(ancestorMeta, plan),
		/entity key must match the requested Datastore ancestor/
	);
});

test('Datastore scan fallback rejects entity keys outside explicit ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const wrongEntity = Object.defineProperty(
		{ id: 1, handle: 'wrong', parentId: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 11, 'datastore_ancestor_record', 1] } }
	);
	const datastore = await createDatastoreStoreAdapter({
		allowQueryScanFallback: true,
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => ({
				hasAncestor() {
					return this;
				},
				filter() {
					return this;
				},
				order() {
					return this;
				},
				limit() {
					return this;
				},
				select() {
					return this;
				},
				start() {
					return this;
				}
			}),
			runQuery: async () => [[wrongEntity], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const parent = datastoreKey('parent_record', 10);
	const plan: QueryPlan = {
		where: [{ field: 'handle', op: '!=', value: 'other' }],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: parent }
	};

	await assert.rejects(
		() => datastore.query(ancestorMeta, plan),
		/entity key must match the requested Datastore ancestor/
	);
});

test('Datastore ancestor-scoped loaded instances preserve explicit query namespaces', async () => {
	const sdkKeys: unknown[] = [];
	const updated: unknown[] = [];
	const deleted: unknown[] = [];
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 1, handle: 'one', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }],
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			},
			delete: async (key: unknown) => {
				deleted[deleted.length] = key;
			}
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;
	const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });

	const loaded = await Record.ancestor(parent).find(1).load();
	loaded!.data.handle = 'two';
	await loaded!.save();
	await loaded!.delete();

	assert.deepEqual(updated, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } },
			data: { id: 1, handle: 'two', parentId: 10 },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(deleted, [
		{ input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } }
	]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('Datastore ancestor-scoped query hooks preserve explicit query namespaces on writes', async () => {
	const sdkKeys: unknown[] = [];
	const updated: unknown[] = [];
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => {
				sdkKeys[sdkKeys.length] = input;
				return { input };
			},
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 1, handle: 'one', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }],
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			}
		})
	});
	const context = createActiveTs({
		stores: { default: datastore },
		plugins: [
			{
				name: 'datastore-after-query-save',
				hooks: {
					async afterQuery(payload) {
						if (payload.model?.name !== 'datastore_ancestor_record') return;
						const [record] = (payload.result as { list: DatastoreAncestorRecord[] }).list;
						record.data.handle = 'two';
						await record.save();
					}
				}
			}
		]
	});
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;
	const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });

	const loaded = await Record.ancestor(parent).find(1).load();

	assert.equal(loaded!.data.handle, 'two');
	assert.deepEqual(updated, [
		{
			key: { input: { path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' } },
			data: { id: 1, handle: 'two', parentId: 10 },
			excludeFromIndexes: ['body']
		}
	]);
	assert.deepEqual(sdkKeys, [
		{ path: ['parent_record', 'number:10'], namespace: 'tenant' },
		{ path: ['parent_record', 'number:10', 'datastore_ancestor_record', 'number:1'], namespace: 'tenant' }
	]);
});

test('Datastore ancestor-scoped loaded instances cannot save outside their query ancestor', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 1, handle: 'one', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }],
			update: async () => assert.fail('Datastore update should not run after scoped instance moves ancestor')
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;
	const parent = datastoreKey('parent_record', 10);

	const loaded = await Record.ancestor(parent).find(1).load();
	loaded!.data.parentId = 11;
	await assert.rejects(
		() => loaded!.save(),
		/datastore_ancestor_record\.save\(\) cannot move datastore_ancestor_record:1 outside the scoped Datastore ancestor/
	);
});

test('Datastore broad ancestor query rows without ancestorFields save under payload ancestor', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const updated: unknown[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{
				id: 1,
				rootId: 1,
				parentId: 10,
				title: 'one'
			}], { moreResults: 'NO_MORE_RESULTS' }],
			update: async (entity: unknown) => {
				updated[updated.length] = entity;
			}
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreImplicitDescendantProjectionRecord.use(context) as unknown as typeof DatastoreImplicitDescendantProjectionRecord;
	const root = datastoreKey('implicit_descendant_projection_root', 1);

	const loaded = await Record.ancestor(root).find(1).load();
	loaded!.data.title = 'two';
	await loaded!.save();

	assert.deepEqual(updated, [
		{
			key: {
				input: {
					path: [
						'implicit_descendant_projection_root',
						'number:1',
						'implicit_descendant_projection_parent',
						'number:10',
						'datastore_implicit_descendant_projection_record',
						'number:1'
					],
					namespace: undefined
				}
			},
			data: { id: 1, rootId: 1, parentId: 10, title: 'two' }
		}
	]);
});

test('Datastore partial query hooks cannot move implicit payload ancestors', async () => {
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{
				id: 1,
				rootId: 1,
				parentId: 10
			}], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		stores: { default: datastore },
		plugins: [
			{
				name: 'datastore-partial-query-move-implicit-ancestor',
				hooks: {
					afterInstantiate(payload) {
						if (
							payload.model?.name !== 'datastore_implicit_descendant_projection_record' ||
							payload.operation !== 'query'
						) return;
						(payload.target as DatastoreImplicitDescendantProjectionRecord).data.parentId = 20;
					}
				}
			}
		]
	});
	const Record = DatastoreImplicitDescendantProjectionRecord.use(context) as unknown as typeof DatastoreImplicitDescendantProjectionRecord;
	const root = datastoreKey('implicit_descendant_projection_root', 1);

	await assert.rejects(
		() => Record.ancestor(root).select('rootId', 'parentId').load(),
		/afterInstantiate hook cannot move datastore_implicit_descendant_projection_record:1 outside the scoped Datastore ancestor/
	);
});

test('Datastore ancestor metadata is rejected by stores without ancestor support', async () => {
	const memory = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: memory } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;

	await assert.rejects(
		() => Record.ancestor(datastoreKey('parent_record', 10)).load(),
		/does not support Datastore ancestor query metadata/
	);
	await assert.rejects(
		() => Record.create({ id: 1, handle: 'one', parentId: 10 }),
		/does not support metadata write options/
	);
	await memory.seed('datastore_ancestor_record', [{ id: 1, handle: 'one', parentId: 10 }]);
	const parent = datastoreKey('parent_record', 10);
	await assert.rejects(
		() => memory.update(
			ancestorMeta,
			1,
			{ id: 1, handle: 'two', parentId: 10 },
			{ meta: { datastoreAncestor: parent } }
		),
		/does not support metadata write options/
	);
	await assert.rejects(
		() => memory.delete(ancestorMeta, 1, { meta: { datastoreAncestor: parent } }),
		/does not support metadata write options/
	);
});

test('Datastore ancestor models reject static delete direct id probes', async () => {
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_ancestor_record', [{ id: 1, handle: 'one', parentId: 10 }]);
	const context = createActiveTs({ stores: { default: memory } });
	const Record = DatastoreAncestorRecord.use(context) as unknown as typeof DatastoreAncestorRecord;

	await assert.rejects(
		() => Record.delete(1),
		/direct id reads require an ancestor-aware query/
	);
	assert.equal((await memory.get(ancestorMeta, 1))?.handle, 'one');
});

test('Query find update and delete reload full models when chained after select', async () => {
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_entity_key_record', [{ id: 1, handle: 'one', score: 10 }]);
	const context = createActiveTs({ stores: { default: memory } });
	const Record = DatastoreEntityKeyRecord.use(context) as unknown as typeof DatastoreEntityKeyRecord;
	const recordMeta = context.meta(DatastoreEntityKeyRecord);

	const updated = await Record.query().select('handle').find(1).update({ handle: 'two' });
	assert.equal(updated?.data.handle, 'two');
	assert.equal(updated?.data.score, 10);
	assert.equal((await memory.get(recordMeta, 1))?.score, 10);

	assert.equal(await Record.query().select('handle').find(1).delete(), true);
	assert.equal(await memory.get(recordMeta, 1), null);
});

test('Lazy relation loads use owner-derived Datastore ancestors', async () => {
	const ancestorCalls: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_relation_owner_record', [{ id: 1, parentId: 10, childId: 5 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 5, handle: 'child', parentId: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreRelationOwnerRecord.use(context) as unknown as typeof DatastoreRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	const child = await owner?.ref<DatastoreAncestorRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.handle, 'child');
	assert.deepEqual(ancestorCalls, [{ input: { path: ['parent_record', 'number:10'], namespace: undefined } }]);
});

test('Datastore relation loads infer ancestors from target ancestorFields', async () => {
	const keySymbol = Symbol('datastore-key');
	const ancestorCalls: unknown[] = [];
	const datastoreQuery = {
		hasAncestor(key: unknown) {
			ancestorCalls[ancestorCalls.length] = key;
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const childEntity = Object.defineProperty(
		{ id: 7, parentId: 10, title: 'child' },
		keySymbol,
		{
			value: { path: ['inferred_parent_record', 10, 'datastore_inferred_relation_child_record', 7] },
			enumerable: false
		}
	);
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_inferred_relation_owner_record', [
		{ id: 1, parentId: 10, childId: 7, handle: 'owner' }
	]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => [[childEntity], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory }
	});
	const Owner = DatastoreInferredRelationOwnerRecord.use(context) as unknown as typeof DatastoreInferredRelationOwnerRecord;
	const owner = await Owner.find(1).load();
	const child = await owner?.ref<DatastoreInferredRelationChildRecord>('child').load();

	assert.ok(!Array.isArray(child));
	assert.equal(child?.data.title, 'child');
	await owner!.include('children');
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['inferred_parent_record', 'number:10'], namespace: undefined } },
		{ input: { path: ['inferred_parent_record', 'number:10'], namespace: undefined } }
	]);
});

test('Datastore owner include hooks cannot move owner models across ancestors', async () => {
	let queryCount = 0;
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => {
				queryCount++;
				return queryCount === 1
					? [[{ id: 7, parentId: 10, childId: 5, title: 'needle owner', handle: 'owner' }], { moreResults: 'NO_MORE_RESULTS' }]
					: [[{ id: 5, parentId: 10, handle: 'child' }], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	const context = createActiveTs({
		stores: { default: datastore },
		plugins: [
			{
				name: 'datastore-owner-include-move-ancestor',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'datastore_search_record' || payload.meta?.relation !== 'child') return;
						(payload.target as DatastoreSearchRecord).data.parentId = 11;
					}
				}
			}
		]
	});
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;
	const parent = datastoreKey('parent_record', 10);
	const owner = await Record.ancestor(parent).find(7).load();

	await assert.rejects(
		() => owner!.include('child'),
		/afterRelationLoad datastore_search_record\.child target cannot move datastore_search_record:7 outside the scoped Datastore ancestor/
	);
});

test('Datastore direct lazy relation hooks cannot move owner models across ancestors', async () => {
	let queryCount = 0;
	const datastoreQuery = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery: () => datastoreQuery,
			runQuery: async () => {
				queryCount++;
				return queryCount === 1
					? [[{ id: 7, parentId: 10, childId: 5, title: 'needle owner', handle: 'owner' }], { moreResults: 'NO_MORE_RESULTS' }]
					: [[{ id: 5, parentId: 10, handle: 'child' }], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	const context = createActiveTs({
		stores: { default: datastore },
		lazyWarnings: false,
		plugins: [
			{
				name: 'datastore-lazy-owner-move-ancestor',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'datastore_search_record' || payload.meta?.relation !== 'child') return;
						(payload.target as DatastoreSearchRecord).data.parentId = 11;
					}
				}
			}
		]
	});
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;
	const parent = datastoreKey('parent_record', 10);
	const owner = await Record.ancestor(parent).find(7).load();

	await assert.rejects(
		() => owner!.ref<DatastoreAncestorRecord>('child').load(),
		/afterRelationLoad datastore_search_record\.child target cannot move datastore_search_record:7 outside the scoped Datastore ancestor/
	);
});

test('Relation ancestor resolvers must return keys for Datastore ancestor targets', async () => {
	const memory = new MemoryStoreAdapter();
	await memory.seed('datastore_missing_relation_ancestor_record', [{ id: 1, childId: 5 }]);
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				throw new Error('Datastore query should not run');
			}
		})
	});
	const context = createActiveTs({
		defaultStore: 'default',
		stores: { default: datastore, memory },
		lazyWarnings: false
	});
	const Owner = DatastoreMissingRelationAncestorRecord.use(context) as unknown as typeof DatastoreMissingRelationAncestorRecord;

	await assert.rejects(
		() => Owner.query().include('child').load(),
		/ancestor resolver must return a Datastore key/
	);
	const owner = await Owner.find(1).load();
	await assert.rejects(
		() => owner!.ref<DatastoreAncestorRecord>('child').load(),
		/ancestor resolver must return a Datastore key/
	);
});

test('Search include reloads Datastore ancestor models with hit-derived ancestors', async () => {
	const ancestorCalls: unknown[] = [];
	const filters: unknown[][] = [];
	const createQuery = () => {
		const query = {
			hasAncestor(key: unknown) {
				ancestorCalls[ancestorCalls.length] = key;
				return this;
			},
			filter(...args: unknown[]) {
				filters[filters.length] = args;
				return this;
			},
			order() {
				return this;
			},
			limit() {
				return this;
			},
			select() {
				return this;
			}
		};
		return query;
	};
	let queryCount = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => ({ input }),
			createQuery,
			runQuery: async () => {
				queryCount++;
				return queryCount === 1
					? [[{ id: 7, parentId: 10, childId: 5, title: 'needle owner', handle: 'owner' }], { moreResults: 'NO_MORE_RESULTS' }]
					: [[{ id: 5, parentId: 10, handle: 'child' }], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: datastore },
		search: { memory: search }
	});
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;
	await search.index(context.meta(DatastoreSearchRecord), 7, {
		id: 7,
		parentId: 10,
		childId: 5,
		title: 'needle owner',
		handle: 'owner'
	});

	const result = await Record.search('needle').using('memory').include('child').load();
	const child = result.list[0]?.ref<DatastoreAncestorRecord>('child');
	const childValue = await child?.load();

	assert.equal(result.list[0]?.data.handle, 'owner');
	assert.ok(!Array.isArray(childValue));
	assert.equal(childValue?.data.handle, 'child');
	assert.deepEqual(ancestorCalls, [
		{ input: { path: ['parent_record', 'number:10'], namespace: undefined } },
		{ input: { path: ['parent_record', 'number:10'], namespace: undefined } }
	]);
	assert.deepEqual(filters, [
		['id', '=', 7],
		['id', '=', 5]
	]);
});

test('Datastore ancestor search partial hits allow duplicate ids under different ancestors', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markedDatastoreSearchHit(meta, { id: 7, parentId: 10, childId: 5, title: 'needle owner a', handle: 'hidden a' }),
					markedDatastoreSearchHit(meta, { id: 7, parentId: 11, childId: 6, title: 'needle owner b', handle: 'hidden b' })
				],
				count: 2
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	const result = await Record.search('needle').using('memory').load();

	assert.equal(result.count, 2);
	assert.deepEqual(result.list.map((item) => item.data), [
		{ id: 7, parentId: 10, childId: 5, title: 'needle owner a' },
		{ id: 7, parentId: 11, childId: 6, title: 'needle owner b' }
	]);
});

test('context search handles allow duplicate datastore ids under different ancestors', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markedDatastoreSearchHit(meta, { id: 7, parentId: 10, childId: 5, title: 'needle owner a', handle: 'hidden a' }),
					markedDatastoreSearchHit(meta, { id: 7, parentId: 11, childId: 6, title: 'needle owner b', handle: 'hidden b' })
				],
				count: 2
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});

	const result = await context.searchAdapter('memory').search(
		context.meta(DatastoreSearchRecord),
		'needle',
		{}
	);

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 5, title: 'needle owner a', handle: 'hidden a' },
		{ id: 7, parentId: 11, childId: 6, title: 'needle owner b', handle: 'hidden b' }
	]);
	assert.equal(result.count, 2);
});

test('context search handles reject duplicate forced datastore document identities', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(meta, 7, datastoreKey('parent_record', 10));
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markSearchDocumentIdentity(
						{ id: 7, parentId: 10, childId: 5, title: 'needle owner a', handle: 'hidden a' },
						forcedIdentity
					),
					markSearchDocumentIdentity(
						{ id: 7, parentId: 11, childId: 6, title: 'needle owner b', handle: 'hidden b' },
						forcedIdentity
					)
				],
				count: 2
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});

	await assert.rejects(
		() => context.searchAdapter('memory').search(
			{ ...context.meta(DatastoreSearchRecord), searchDocumentIdentity: forcedIdentity },
			'needle',
			{}
		),
		/context search result contains duplicate search document identity/
	);
});

test('context search handles prune non-target forced datastore document identities', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(meta, 7, datastoreKey('parent_record', 10));
	const staleIdentity = datastoreSearchDocumentIdentity(meta, 7, datastoreKey('parent_record', 11));
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markSearchDocumentIdentity(
						{ id: 7, parentId: 11, childId: 6, title: 'stale owner', handle: 'hidden stale' },
						staleIdentity
					),
					markSearchDocumentIdentity(
						{ id: 7, parentId: 10, childId: 5, title: 'fresh owner', handle: 'hidden fresh' },
						forcedIdentity
					)
				],
				count: 2,
				total: 2
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});

	const result = await context.searchAdapter('memory').search(
		{ ...context.meta(DatastoreSearchRecord), searchDocumentIdentity: forcedIdentity },
		'needle',
		{}
	);

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 5, title: 'fresh owner', handle: 'hidden fresh' }
	]);
	assert.equal(result.count, 1);
	assert.equal(result.total, undefined);
});

test('Datastore native store query results allow duplicate ids under different ancestors', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreSearchRecord);

	const result = await datastore.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		native: {
			payload: () => ({
				list: [
					{ id: 7, parentId: 10, childId: 5, title: 'left', handle: 'left' },
					{ id: 7, parentId: 11, childId: 6, title: 'right', handle: 'right' }
				],
				count: 2
			})
		}
	});

	assert.deepEqual(result.list.map((item) => item.parentId), [10, 11]);
	assert.equal(result.count, 2);
});

test('Datastore native store query results use scoped ancestors for partial rows', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreSearchRecord);
	const result = await datastore.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: datastoreKey('parent_record', 10) },
		native: {
			payload: () => ({
				list: [
					{ id: 7, title: 'partial child' }
				],
				count: 1
			})
		}
	});

	assert.deepEqual(result.list, [{ id: 7, title: 'partial child' }]);
});

test('Datastore native scoped query results validate implicit payload ancestors', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });

	await assert.rejects(
		() => datastore.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreKey('parent_record', 10) },
			native: {
				payload: () => ({
					list: [{ id: 1, parentId: 11, handle: 'wrong parent' }],
					count: 1
				})
			}
		}),
		/Datastore native function query result\.list\[0\] for Datastore model "datastore_ancestor_record" resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore native scoped partial rows reject callback entity key markers', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreSearchRecord);
	const row = Object.defineProperty(
		{ id: 7, title: 'wrong partial key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: datastoreKey('parent_record', 11) }), enumerable: false }
	);

	await assert.rejects(
		() => datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreKey('parent_record', 10) },
			native: {
				payload: () => ({
					list: [row],
					count: 1
				})
			}
		}),
		/partial Datastore row cannot use untrusted active-ts entity key metadata/
	);
});

test('Datastore native store query rejects unscoped partial rows with only callback entity keys', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreSearchRecord);
	const row = Object.defineProperty(
		{ id: 7, title: 'unscoped partial key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: datastoreKey('parent_record', 10) }), enumerable: false }
	);

	await assert.rejects(
		() => datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: () => ({
					list: [row],
					count: 1
				})
			}
		}),
		/partial Datastore row cannot use untrusted active-ts entity key metadata/
	);
});

test('Datastore native store query accepts constant ancestors with callback entity key metadata', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreConstantAncestorRecord);
	const row = Object.defineProperty(
		{ id: 7, title: 'constant ancestor row' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: datastoreKey('constant_parent_record', 99) }), enumerable: false }
	);

	const result = await datastore.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		native: {
			payload: () => ({
				list: [row],
				count: 1
			})
		}
	});

	assert.deepEqual(result.list, [{ id: 7, title: 'constant ancestor row' }]);
});

test('Datastore native store query uses payload ancestors for unscoped duplicate ids', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreSearchRecord);
	const left = Object.defineProperty(
		{ id: 7, parentId: 10, childId: 5, title: 'left partial', handle: 'left partial' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: datastoreKey('parent_record', 99) }), enumerable: false }
	);
	const right = Object.defineProperty(
		{ id: 7, parentId: 11, childId: 6, title: 'right partial', handle: 'right partial' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: datastoreKey('parent_record', 98) }), enumerable: false }
	);

	const result = await datastore.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		native: {
			payload: () => ({
				list: [left, right],
				count: 2
			})
		}
	});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 5, title: 'left partial', handle: 'left partial' },
		{ id: 7, parentId: 11, childId: 6, title: 'right partial', handle: 'right partial' }
	]);
	assert.equal(result.count, 2);
});

test('Datastore native store query rejects rows outside scoped ancestors', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreSearchRecord);

	await assert.rejects(
		() => datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreKey('parent_record', 10) },
			native: {
				payload: () => ({
					list: [
						{ id: 7, parentId: 11, childId: 6, title: 'right', handle: 'right' }
					],
					count: 1
				})
			}
		}),
		/Datastore model "datastore_search_record" resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore native store query rejects invalid untrusted keys that hide scoped ancestor mismatches', async () => {
	const datastore = await createDatastoreStoreAdapter({ client: datastoreClient() });
	const context = createActiveTs({ stores: { default: datastore } });
	const meta = context.meta(DatastoreSearchRecord);
	const row = Object.defineProperty(
		{ id: 7, parentId: 11, childId: 6, title: 'right', handle: 'right' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: Object.create({ path: ['parent_record', 10, 'datastore_search_record', 7] }), enumerable: false }
	);

	await assert.rejects(
		() => datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreKey('parent_record', 10) },
			native: {
				payload: () => ({
					list: [row],
					count: 1
				})
			}
		}),
		/resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore middleware query results trust scoped entity key markers', async () => {
	const metaContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = metaContext.meta(DatastoreSearchRecord);
	const scopedAncestor = datastoreKey('parent_record', 10);
	const entityKey = datastoreKey(meta.name, 7, { parent: scopedAncestor });
	const row = Object.defineProperty(
		{ id: 7, parentId: 10, childId: 6, title: 'key-owned', handle: 'key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: entityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const wrapped = createStoreMiddlewareAdapter(store, []);
	const context = createActiveTs({ stores: { default: wrapped } });

	const result = await context.store('default').query(context.meta(DatastoreSearchRecord), {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 6, title: 'key-owned', handle: 'key-owned' }
	]);
	assert.equal(result.count, 1);
});

test('Datastore trusted entity key validation decodes ancestor field codecs', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const metaContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = metaContext.meta(DatastoreEncodedAncestorFieldRecord);
	const trustedRow = () => Object.defineProperty(
		{ id: 7, parentId: 'parent:10', score: 7, handle: 'encoded' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: scopedAncestor }), enumerable: false }
	);
	const mismatchedRow = () => Object.defineProperty(
		{ id: 7, parentId: 'parent:11', score: 7, handle: 'mismatched' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: scopedAncestor }), enumerable: false }
	);
	const createTrustedStore = (row: () => Record<string, unknown>): StoreAdapter => {
		const store: StoreAdapter = {
			kind: 'encoded-ancestor-field-trusted-key-store',
			capabilities: { datastoreAncestor: true, select: true },
			get: async () => row(),
			getMany: async (_model, ids) => ids.map(() => row()),
			query: async () => ({
				list: [row()],
				count: 1
			}),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		};
		return markStoreTrustsDatastoreEntityKeyRows(store);
	};
	const queryPlan: QueryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	};
	const context = createActiveTs({
		stores: { default: createTrustedStore(trustedRow) },
		aggregate: { allowQueryFallback: true }
	});

	const raw = await context.store('default').query(context.meta(DatastoreEncodedAncestorFieldRecord), queryPlan);
	assert.deepEqual(raw.list, [
		{ id: 7, parentId: 'parent:10', score: 7, handle: 'encoded' }
	]);

	const Record = DatastoreEncodedAncestorFieldRecord.use(context) as unknown as typeof DatastoreEncodedAncestorFieldRecord;
	const loaded = await Record.ancestor(scopedAncestor).load();
	assert.deepEqual(loaded.list.map((item) => item.data.parentId), [10]);
	assert.equal((await Record.ancestor(scopedAncestor).find(7).load())?.data.parentId, 10);
	assert.equal(await Record.ancestor(scopedAncestor).sum('score'), 7);

	const mismatchContext = createActiveTs({ stores: { default: createTrustedStore(mismatchedRow) } });
	await assert.rejects(
		() => mismatchContext.store('default').query(
			mismatchContext.meta(DatastoreEncodedAncestorFieldRecord),
			queryPlan
		),
		/active-ts entity key does not match its payload data/
	);
});

test('Datastore trusted entity key validation decodes nested ancestor field codecs', async () => {
	const scopedAncestor = datastoreKey('nested_parent_record', 10);
	const metaContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = metaContext.meta(DatastoreNestedEncodedAncestorRecord);
	const trustedRow = () => Object.defineProperty(
		{
			id: 7,
			profile: JSON.stringify({ parentId: 10, label: 'trusted' }),
			score: 7,
			handle: 'nested trusted'
		},
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: scopedAncestor }), enumerable: false }
	);
	const mismatchedRow = () => Object.defineProperty(
		{
			id: 7,
			profile: JSON.stringify({ parentId: 11, label: 'mismatched' }),
			score: 7,
			handle: 'nested mismatched'
		},
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: scopedAncestor }), enumerable: false }
	);
	const createTrustedStore = (row: () => Record<string, unknown>): StoreAdapter => {
		const store: StoreAdapter = {
			kind: 'nested-encoded-ancestor-trusted-key-store',
			capabilities: { datastoreAncestor: true },
			get: async () => row(),
			getMany: async (_model, ids) => ids.map(() => row()),
			query: async () => ({
				list: [row()],
				count: 1
			}),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		};
		return markStoreTrustsDatastoreEntityKeyRows(store);
	};
	const queryPlan: QueryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	};
	const context = createActiveTs({ stores: { default: createTrustedStore(trustedRow) } });

	const raw = await context.store('default').query(meta, queryPlan);
	assert.deepEqual(raw.list, [
		{
			id: 7,
			profile: JSON.stringify({ parentId: 10, label: 'trusted' }),
			score: 7,
			handle: 'nested trusted'
		}
	]);

	const mismatchContext = createActiveTs({ stores: { default: createTrustedStore(mismatchedRow) } });
	await assert.rejects(
		() => mismatchContext.store('default').query(mismatchContext.meta(DatastoreNestedEncodedAncestorRecord), queryPlan),
		/active-ts entity key does not match its payload data/
	);
});

test('Datastore middleware query results trust descendant entity key markers inside scoped ancestors', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const descendantEntityKey = datastoreKey('datastore_search_record', 7, {
		parent: datastoreKey('child_parent', 6, { parent: scopedAncestor })
	});
	const row = Object.defineProperty(
		{ id: 7, childId: 6, title: 'descendant-key-owned', handle: 'descendant-key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: descendantEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: createStoreMiddlewareAdapter(store, []) } });

	const result = await context.store('default').query(context.meta(DatastoreSearchRecord), {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	});

	assert.deepEqual(result.list, [
		{ id: 7, childId: 6, title: 'descendant-key-owned', handle: 'descendant-key-owned' }
	]);
});

test('Datastore middleware query results apply adapter namespaces to scoped entity key markers', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const namespacedAncestor = datastoreKey('parent_record', 10, { namespace: 'tenant' });
	const entityKey = datastoreKey('datastore_search_record', 7, { parent: namespacedAncestor });
	const row = Object.defineProperty(
		{ id: 7, parentId: 10, childId: 6, title: 'namespaced-key-owned', handle: 'namespaced-key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: entityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore',
		datastoreNamespace: 'tenant',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: createStoreMiddlewareAdapter(store, []) } });

	const result = await context.store('default').query(context.meta(DatastoreSearchRecord), {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 6, title: 'namespaced-key-owned', handle: 'namespaced-key-owned' }
	]);
});

test('Datastore scoped select queries validate trusted entity keys against adapter namespaces', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const wrongAncestor = datastoreKey('parent_record', 11, { namespace: 'tenant' });
	const row = Object.defineProperty(
		{ id: 7, title: 'wrong selected tenant key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey('datastore_search_record', 7, { parent: wrongAncestor }), enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore-select-trusted-key-store',
		datastoreNamespace: 'tenant',
		capabilities: { datastoreAncestor: true, select: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: store } });
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	await assert.rejects(
		() => Record.ancestor(scopedAncestor).select('title').load(),
		/active-ts entity key resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore scoped select queries reject namespace-less trusted keys inside adapter namespaces', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const tenantAncestor = datastoreKey('parent_record', 10, { namespace: 'tenant' });
	const namespaceLessRow = Object.defineProperty(
		{ id: 7, title: 'namespace-less selected key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey('datastore_search_record', 7, { parent: scopedAncestor }), enumerable: false }
	);
	const tenantRow = Object.defineProperty(
		{ id: 7, title: 'tenant selected key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey('datastore_search_record', 7, { parent: tenantAncestor }), enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore-select-trusted-key-store',
		datastoreNamespace: 'tenant',
		capabilities: { datastoreAncestor: true, select: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [namespaceLessRow, tenantRow],
			count: 2
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: store } });
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	await assert.rejects(
		() => Record.ancestor(scopedAncestor).select('title').load(),
		/Store adapter "datastore-select-trusted-key-store" query result contains duplicate id "7"/
	);
});

test('Datastore unscoped select queries canonicalize namespace-less trusted keys inside adapter namespaces', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const tenantAncestor = datastoreKey('parent_record', 10, { namespace: 'tenant' });
	const namespaceLessRow = Object.defineProperty(
		{ id: 7, title: 'namespace-less unscoped key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey('datastore_search_record', 7, { parent: scopedAncestor }), enumerable: false }
	);
	const tenantRow = Object.defineProperty(
		{ id: 7, title: 'tenant unscoped key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey('datastore_search_record', 7, { parent: tenantAncestor }), enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore-unscoped-trusted-key-store',
		datastoreNamespace: 'tenant',
		capabilities: { datastoreAncestor: true, select: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [namespaceLessRow, tenantRow],
			count: 2
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: store } });
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	await assert.rejects(
		() => Record.query().select('title').load(),
		/Store adapter "datastore-unscoped-trusted-key-store" query result contains duplicate id "7"/
	);
});

test('Datastore middleware query results tolerate SDK entity key markers', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const sdkEntityKey = sdkDatastoreEntityKey(['parent_record', 10, 'datastore_search_record', 7]);
	const row = Object.defineProperty(
		{ id: 7, parentId: 10, childId: 6, title: 'sdk-key-owned', handle: 'sdk-key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: createStoreMiddlewareAdapter(store, []) } });

	const result = await context.store('default').query(context.meta(DatastoreSearchRecord), {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 6, title: 'sdk-key-owned', handle: 'sdk-key-owned' }
	]);
});

test('trusted Datastore query results reject malformed entity keys before scoped fallback', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const malformedRow = () => Object.defineProperty(
		{ id: 7, parentId: 11, childId: 6, title: 'malformed-key', handle: 'malformed-key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: Object.create({ path: ['parent_record', 10, 'datastore_search_record', 7] }), enumerable: false }
	);
	const trustedStore = (row: DatastoreSearchData): StoreAdapter => {
		const store: StoreAdapter = {
			kind: 'trusted-malformed-datastore-key-store',
			capabilities: { datastoreAncestor: true },
			get: async () => null,
			getMany: async (model, ids) => ids.map(() => null),
			query: async () => ({
				list: [row],
				count: 1
			}),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		};
		return markStoreTrustsDatastoreEntityKeyRows(store);
	};
	const queryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	};
	const context = createActiveTs({ stores: { default: trustedStore(malformedRow()) } });

	await assert.rejects(
		() => context.store('default').query(context.meta(DatastoreSearchRecord), queryPlan),
		/active-ts entity key resolved outside the scoped Datastore ancestor/
	);

	const middlewareContext = createActiveTs({
		stores: { default: createStoreMiddlewareAdapter(trustedStore(malformedRow()), []) }
	});
	await assert.rejects(
		() => middlewareContext.store('default').query(middlewareContext.meta(DatastoreSearchRecord), queryPlan),
		/active-ts entity key resolved outside the scoped Datastore ancestor/
	);
});

test('untrusted Datastore entity key markers cannot override payload scoped ancestors', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const forgedSearchRow = Object.defineProperty(
		{ id: 7, parentId: 11, childId: 6, title: 'forged-key', handle: 'forged-key' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey('datastore_search_record', 7, { parent: scopedAncestor }), enumerable: false }
	);
	const forgedAggregateRow = Object.defineProperty(
		{ id: 7, parentId: 11, score: 990, handle: 'forged-aggregate' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey('datastore_encoded_aggregate_record', 7, { parent: scopedAncestor }), enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'untrusted-forged-datastore-key-store',
		capabilities: { datastoreAncestor: true, aggregate: true, select: true },
		get: async () => forgedSearchRow,
		getMany: async (_model, ids) => ids.map(() => forgedSearchRow),
		query: async (model) => ({
			list: [model.name === 'datastore_encoded_aggregate_record' ? forgedAggregateRow : forgedSearchRow],
			count: 1
		}),
		aggregate: async () => {
			throw new Error('untrusted forged aggregate should use query fallback');
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const meta = context.meta(DatastoreSearchRecord);

	await assert.rejects(
		() => context.store('default').get(meta, 7, { meta: { datastoreAncestor: scopedAncestor } }),
		/resolved outside the scoped Datastore ancestor/
	);
	await assert.rejects(
		() => context.store('default').getMany(meta, [7], { meta: { datastoreAncestor: scopedAncestor } }),
		/resolved outside the scoped Datastore ancestor/
	);

	const middlewareContext = createActiveTs({ stores: { default: createStoreMiddlewareAdapter(store, []) } });
	await assert.rejects(
		() => middlewareContext.store('default').query(middlewareContext.meta(DatastoreSearchRecord), {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		/resolved outside the scoped Datastore ancestor/
	);

	const AggregateRecord = DatastoreEncodedAggregateRecord.use(context) as unknown as typeof DatastoreEncodedAggregateRecord;
	await assert.rejects(
		() => AggregateRecord.ancestor(scopedAncestor).sum('score'),
		/resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore middleware direct reads reject rows outside scoped ancestors', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const row = { id: 7, parentId: 11, childId: 6, title: 'wrong', handle: 'wrong' };
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true },
		get: async () => row,
		getMany: async (model, ids) => ids.map(() => row),
		query: async () => ({ list: [], count: 0 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const wrapped = createStoreMiddlewareAdapter(store, []);
	const context = createActiveTs({ stores: { default: wrapped } });
	const meta = context.meta(DatastoreSearchRecord);

	await assert.rejects(
		() => context.store('default').get(meta, 7, { meta: { datastoreAncestor: scopedAncestor } }),
		/resolved outside the scoped Datastore ancestor/
	);
	await assert.rejects(
		() => context.store('default').getMany(meta, [7], { meta: { datastoreAncestor: scopedAncestor } }),
		/resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore middleware direct id operations require concrete ancestor metadata', async () => {
	const row = { id: 7, parentId: 10, childId: 6, title: 'scoped', handle: 'scoped' };
	let getCalls = 0;
	let getManyCalls = 0;
	let deleteCalls = 0;
	const store: StoreAdapter = {
		kind: 'permissive-datastore-middleware-direct-store',
		capabilities: { datastoreAncestor: true },
		get: async () => {
			getCalls++;
			return row;
		},
		getMany: async (_model, ids) => {
			getManyCalls++;
			return ids.map(() => row);
		},
		query: async () => ({ list: [], count: 0 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => {
			deleteCalls++;
		}
	};
	const wrapped = createStoreMiddlewareAdapter(store, []);
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);

	await assert.rejects(
		() => wrapped.get(meta, 7, { meta: { datastoreAncestor: undefined } }),
		/requires ancestor-aware query metadata/
	);
	await assert.rejects(
		() => wrapped.getMany(meta, [7], { meta: { datastoreAncestor: undefined } }),
		/requires ancestor-aware query metadata/
	);
	await assert.rejects(
		() => wrapped.delete(meta, 7, { meta: { datastoreAncestor: undefined } }),
		/requires ancestor-aware query metadata/
	);
	assert.equal(getCalls, 0);
	assert.equal(getManyCalls, 0);
	assert.equal(deleteCalls, 0);
});

test('context store direct id operations require concrete datastore ancestor metadata', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const row = { id: 7, parentId: 10, childId: 6, title: 'scoped', handle: 'scoped' };
	let getCalls = 0;
	let getManyCalls = 0;
	let deleteCalls = 0;
	const store: StoreAdapter = {
		kind: 'permissive-datastore-direct-read-store',
		capabilities: { datastoreAncestor: true, transaction: true },
		get: async () => {
			getCalls++;
			return row;
		},
		getMany: async (_model, ids) => {
			getManyCalls++;
			return ids.map(() => row);
		},
		query: async () => ({ list: [], count: 0 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => {
			deleteCalls++;
		},
		transaction: async (fn) => await fn(store)
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(DatastoreSearchRecord);
	const handle = context.store('default');

	await assert.rejects(
		() => handle.get(meta, 7),
		/requires ancestor-aware query metadata/
	);
	await assert.rejects(
		() => handle.getMany(meta, [7]),
		/requires ancestor-aware query metadata/
	);
	await assert.rejects(
		() => handle.delete(meta, 7),
		/requires ancestor-aware query metadata/
	);
	await assert.rejects(
		() => handle.get(meta, 7, { meta: { datastoreAncestor: undefined } }),
		/requires ancestor-aware query metadata/
	);
	await assert.rejects(
		() => handle.getMany(meta, [7], { meta: { datastoreAncestor: undefined } }),
		/requires ancestor-aware query metadata/
	);
	await assert.rejects(
		() => handle.delete(meta, 7, { meta: { datastoreAncestor: undefined } }),
		/requires ancestor-aware query metadata/
	);
	await handle.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.get(meta, 7),
			/requires ancestor-aware query metadata/
		);
		await assert.rejects(
			() => tx.getMany(meta, [7]),
			/requires ancestor-aware query metadata/
		);
		await assert.rejects(
			() => tx.delete(meta, 7),
			/requires ancestor-aware query metadata/
		);
		await assert.rejects(
			() => tx.get(meta, 7, { meta: { datastoreAncestor: undefined } }),
			/requires ancestor-aware query metadata/
		);
		await assert.rejects(
			() => tx.getMany(meta, [7], { meta: { datastoreAncestor: undefined } }),
			/requires ancestor-aware query metadata/
		);
		await assert.rejects(
			() => tx.delete(meta, 7, { meta: { datastoreAncestor: undefined } }),
			/requires ancestor-aware query metadata/
		);
	});
	assert.equal(getCalls, 0);
	assert.equal(getManyCalls, 0);
	assert.equal(deleteCalls, 0);

	assert.deepEqual(await handle.get(meta, 7, { meta: { datastoreAncestor: scopedAncestor } }), row);
	assert.deepEqual(await handle.getMany(meta, [7], { meta: { datastoreAncestor: scopedAncestor } }), [row]);
	await handle.delete(meta, 7, { meta: { datastoreAncestor: scopedAncestor } });
	assert.equal(getCalls, 1);
	assert.equal(getManyCalls, 1);
	assert.equal(deleteCalls, 1);
});

test('Datastore middleware query results reject rows outside scoped ancestors', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [{ id: 7, parentId: 11, childId: 6, title: 'wrong', handle: 'wrong' }],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const wrapped = createStoreMiddlewareAdapter(store, []);
	const context = createActiveTs({ stores: { default: wrapped } });

	await assert.rejects(
		() => context.store('default').query(context.meta(DatastoreSearchRecord), {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		}),
		/resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore middleware query results preserve SDK entity key trust for custom kinds', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const sdkEntityKey = sdkDatastoreEntityKey(['parent_record', 10, 'datastore_search_record', 7]);
	const row = Object.defineProperty(
		{ id: 7, parentId: 10, childId: 6, title: 'custom-kind-key-owned', handle: 'custom-kind-key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const wrapped = createStoreMiddlewareAdapter(store, [], 'instrumented-store');
	const context = createActiveTs({ stores: { default: wrapped } });

	const result = await context.store('default').query(context.meta(DatastoreSearchRecord), {
		where: [],
		or: [],
		sort: [],
		include: [],
		meta: { datastoreAncestor: scopedAncestor }
	});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 6, title: 'custom-kind-key-owned', handle: 'custom-kind-key-owned' }
	]);
});

test('context store handles preserve Datastore entity key trust through composition', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const sdkEntityKey = sdkDatastoreEntityKey(['parent_record', 10, 'datastore_search_record', 7]);
	const row = Object.defineProperty(
		{ id: 7, parentId: 10, childId: 6, title: 'context-key-owned', handle: 'context-key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true, transaction: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		transaction: async (fn) => await fn(store)
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const firstContext = createActiveTs({ stores: { default: store } });
	const retainedHandle = firstContext.store('default');
	assert.equal(storeTrustsDatastoreEntityKeyRows(retainedHandle), true);

	const result = await retainedHandle.transaction!(async (tx) => {
		assert.equal(storeTrustsDatastoreEntityKeyRows(tx), true);
		const secondContext = createActiveTs({
			stores: { default: createStoreMiddlewareAdapter(tx, [], 'retained-context-transaction-store') }
		});
		return await secondContext.store('default').query(secondContext.meta(DatastoreSearchRecord), {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		});
	});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 6, title: 'context-key-owned', handle: 'context-key-owned' }
	]);
});

test('retained context store transactions preserve source Datastore namespace and entity key trust', async () => {
	const scopedAncestor = datastoreKey('parent_record', 10);
	const sdkEntityKey = sdkDatastoreEntityKey(['parent_record', 10, 'datastore_search_record', 7]);
	const row = Object.defineProperty(
		{ id: 7, parentId: 10, childId: 6, title: 'retained-tx-key-owned', handle: 'retained-tx-key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const txStore: StoreAdapter = {
		kind: 'datastore-retained-tx-child',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const store: StoreAdapter = {
		kind: 'datastore-retained-tx-root',
		datastoreNamespace: 'tenant',
		capabilities: { datastoreAncestor: true, transaction: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({ list: [], count: 0 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		transaction: async (fn) => await fn(txStore)
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: store } });

	const result = await context.store('default').transaction!(async (tx) => {
		assert.equal(tx.datastoreNamespace, 'tenant');
		assert.equal(storeTrustsDatastoreEntityKeyRows(tx), true);
		return await tx.query(context.meta(DatastoreSearchRecord), {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		});
	});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, childId: 6, title: 'retained-tx-key-owned', handle: 'retained-tx-key-owned' }
	]);
});

test('Datastore context transactions preserve entity key trust on scoped store handles', async () => {
	const primary: StoreAdapter = {
		kind: 'datastore-primary',
		capabilities: { datastoreAncestor: true, transaction: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({ list: [], count: 0 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		transaction: async (fn) => await fn(primary)
	};
	const audit: StoreAdapter = {
		kind: 'datastore-audit',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({ list: [], count: 0 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(primary);
	markStoreTrustsDatastoreEntityKeyRows(audit);
	const context = createActiveTs({
		stores: { default: primary, audit },
		defaultStore: 'default'
	});

	await context.transaction(async (tx) => {
		assert.equal(storeTrustsDatastoreEntityKeyRows(tx.store('default')), true);
		assert.equal(storeTrustsDatastoreEntityKeyRows(tx.store('audit')), true);
	});
	await context.transaction(
		async (tx) => {
			assert.equal(storeTrustsDatastoreEntityKeyRows(tx.store('default')), true);
		},
		{ readOnly: true }
	);
});

test('context store handles allow duplicate datastore ids under different ancestors', async () => {
	const store: StoreAdapter = {
		kind: 'ancestor-duplicate-store',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [
				{ id: 7, parentId: 10, childId: 5, title: 'left', handle: 'left' },
				{ id: 7, parentId: 11, childId: 6, title: 'right', handle: 'right' }
			],
			more: false,
			count: 2
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const result = await context.store('default').query(
		context.meta(DatastoreSearchRecord),
		{ where: [], or: [], sort: [], include: [] }
	);

	assert.deepEqual(result.list.map((item) => item.parentId), [10, 11]);
	assert.equal(result.count, 2);
});

test('context store handles use scoped datastore ancestors for partial rows', async () => {
	const parent = datastoreKey('parent_record', 10);
	const store: StoreAdapter = {
		kind: 'scoped-ancestor-partial-store',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({
			list: [
				{ id: 7, title: 'partial child' }
			],
			more: false,
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const result = await context.store('default').query(
		context.meta(DatastoreSearchRecord),
		{ where: [], or: [], sort: [], include: [], meta: { datastoreAncestor: parent } }
	);

	assert.deepEqual(result.list, [{ id: 7, title: 'partial child' }]);
});

test('direct search deletes require datastore ancestor identity', async () => {
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});
	const meta = context.meta(DatastoreSearchRecord);
	await context.searchAdapter('memory').index(meta, 7, {
		id: 7,
		parentId: 10,
		childId: 5,
		title: 'needle owner',
		handle: 'owner'
	});

	await assert.rejects(
		() => context.searchAdapter('memory').delete(meta, 7),
		/requires ancestor metadata/
	);
	assert.deepEqual(
		(await context.searchAdapter('memory').search(meta, 'needle', {})).list.map((item) => item.parentId),
		[10]
	);

	let customDeletes = 0;
	const customSearch: SearchAdapter = {
		kind: 'custom-delete',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async () => undefined,
		delete: async () => {
			customDeletes++;
		}
	};
	const customContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { custom: customSearch }
	});
	await assert.rejects(
		() => customContext.searchAdapter('custom').delete(customContext.meta(DatastoreSearchRecord), 7),
		/requires ancestor metadata/
	);
	assert.equal(customDeletes, 0);
});

test('Datastore ancestor query results allow duplicate ids under different ancestors', async () => {
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			runQuery: async () => [[
				{ id: 5, parentId: 10, childId: 1, title: 'left', handle: 'left' },
				{ id: 5, parentId: 11, childId: 2, title: 'right', handle: 'right' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	const result = await Record.query().load();

	assert.deepEqual(result.list.map((item) => item.data.parentId), [10, 11]);

	const duplicateDatastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			runQuery: async () => [[
				{ id: 5, parentId: 10, childId: 1, title: 'left', handle: 'left' },
				{ id: 5, parentId: 10, childId: 2, title: 'duplicate', handle: 'duplicate' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const duplicateContext = createActiveTs({ stores: { default: duplicateDatastore } });
	const DuplicateRecord = DatastoreSearchRecord.use(duplicateContext) as unknown as typeof DatastoreSearchRecord;

	await assert.rejects(
		() => DuplicateRecord.query().load(),
		/Store adapter "datastore" query result contains duplicate id "5"/
	);
});

test('Datastore ancestor identity does not depend on JSON.stringify', async () => {
	assert.throws(
		() => datastoreKey('parent_record', 10, { namespace: '' }),
		/Datastore key options\.namespace must be a non-empty string/
	);
	const originalStringify = JSON.stringify;
	Object.defineProperty(JSON, 'stringify', {
		configurable: true,
		value() {
			throw new Error('patched JSON.stringify');
		}
	});
	try {
		const parent = datastoreKey('parent_record', 10, { namespace: 'tenant' });
		const samePathUnscoped = datastoreKey('parent_record', 10);
		const other = datastoreKey('parent_record', 11, { namespace: 'tenant' });

		assert.equal(datastoreKeyIdentity(parent), 'namespace:6:tenant:kind:13:parent_record:id:9:number:10:');
		assert.equal(datastoreScopedAncestorMatches(samePathUnscoped, parent), true);
		assert.equal(datastoreScopedAncestorMatches(parent, samePathUnscoped), false);
		assert.equal(datastoreScopedAncestorMatches(parent, other), false);
	} finally {
		Object.defineProperty(JSON, 'stringify', { configurable: true, value: originalStringify });
	}
});

test('Datastore ancestor search hit identity ignores patched JSON.stringify', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markedDatastoreSearchHit(meta, { id: 7, parentId: 10, childId: 5, title: 'needle owner a', handle: 'hidden a' }),
					markedDatastoreSearchHit(meta, { id: 7, parentId: 11, childId: 6, title: 'needle owner b', handle: 'hidden b' })
				],
				count: 2
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;
	const originalStringify = JSON.stringify;
	Object.defineProperty(JSON, 'stringify', {
		configurable: true,
		value() {
			throw new Error('patched JSON.stringify');
		}
	});
	try {
		const result = await Record.search('needle').using('memory').load();

		assert.equal(result.count, 2);
		assert.deepEqual(result.list.map((item) => item.data), [
			{ id: 7, parentId: 10, childId: 5, title: 'needle owner a' },
			{ id: 7, parentId: 11, childId: 6, title: 'needle owner b' }
		]);
	} finally {
		Object.defineProperty(JSON, 'stringify', { configurable: true, value: originalStringify });
	}
});

test('Datastore ancestor search result hooks cannot move partial hits across ancestors', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [markedDatastoreSearchHit(meta, { id: 7, parentId: 10, childId: 5, title: 'needle owner', handle: 'hidden' })],
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		plugins: [
			{
				name: 'datastore-search-move-ancestor',
				hooks: {
					afterSearch(payload) {
						if (payload.model?.name !== 'datastore_search_record') return;
						const [record] = (payload.result as { list: DatastoreSearchRecord[] }).list;
						record.data.parentId = 11;
					}
				}
			}
		]
	});
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	await assert.rejects(
		() => Record.search('needle').using('memory').load(),
		/afterSearch result\.list item cannot move datastore_search_record:7 outside the scoped Datastore ancestor/
	);
});

test('Datastore ancestor afterInstantiate hooks cannot move search partial hits across ancestors', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DatastoreSearchRecord);
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [markedDatastoreSearchHit(meta, { id: 7, parentId: 10, childId: 5, title: 'needle owner', handle: 'hidden' })],
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		plugins: [
			{
				name: 'datastore-after-instantiate-move-ancestor',
				hooks: {
					afterInstantiate(payload) {
						if (payload.model?.name !== 'datastore_search_record' || payload.operation !== 'search') return;
						(payload.target as DatastoreSearchRecord).data.parentId = 11;
					}
				}
			}
		]
	});
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	await assert.rejects(
		() => Record.search('needle').using('memory').load(),
		/afterInstantiate hook cannot move datastore_search_record:7 outside the scoped Datastore ancestor/
	);
});

test('Datastore model writes compute ancestors before field codecs encode stored data', async () => {
	const inserted: any[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			insert: async (entity: unknown) => {
				inserted[inserted.length] = entity;
			}
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreEncodedAncestorRecord.use(context) as unknown as typeof DatastoreEncodedAncestorRecord;

	await Record.create({ id: 1, handle: 'one', parentId: 10 });

	assert.deepEqual(inserted, [
		{
			key: { path: ['parent_record', 'number:10', 'datastore_encoded_ancestor_record', 'number:1'], namespace: undefined },
			data: { id: 1, handle: 'one', parentId: 'parent:10' }
		}
	]);
});

test('Datastore transaction model writes compute ancestors before field codecs encode stored data', async () => {
	const inserted: any[] = [];
	const calls: string[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			transaction: () => ({
				run: async () => {
					calls[calls.length] = 'run';
				},
				commit: async () => {
					calls[calls.length] = 'commit';
				},
				rollback: async () => {
					calls[calls.length] = 'rollback';
				},
				get: async () => {
					calls[calls.length] = 'get';
					return [null];
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: async (entity: unknown) => {
					calls[calls.length] = 'insert';
					inserted[inserted.length] = entity;
				},
				update: async () => assert.fail('Datastore transaction update should not run'),
				delete: async () => assert.fail('Datastore transaction delete should not run')
			})
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreEncodedAncestorRecord.use(context) as unknown as typeof DatastoreEncodedAncestorRecord;

	await context.transaction(async () => {
		await Record.create({ id: 1, handle: 'one', parentId: 10 });
	});

	assert.deepEqual(inserted, [
		{
			key: { path: ['parent_record', 'number:10', 'datastore_encoded_ancestor_record', 'number:1'], namespace: undefined },
			data: { id: 1, handle: 'one', parentId: 'parent:10' }
		}
	]);
	assert.deepEqual(calls, ['run', 'get', 'insert', 'commit']);
});

test('Datastore context write guards accept decoded field-codec ancestor payloads', async () => {
	const calls: string[] = [];
	const scopedAncestor = datastoreKey('parent_record', 10);
	const decodedPayload = { id: 1, handle: 'decoded', parentId: 10, score: 7 };
	const wrongPayload = { id: 2, handle: 'wrong', parentId: 20, score: 7 };
	const store: StoreAdapter = {
		kind: 'decoded-ancestor-field-write-store',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async (_model, id) => {
			calls[calls.length] = `create:${String(id)}`;
		},
		update: async (_model, id) => {
			calls[calls.length] = `update:${String(id)}`;
		},
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(DatastoreEncodedAncestorFieldRecord);
	const handle = context.store('default');

	await handle.create(meta, 1, decodedPayload, { meta: { datastoreAncestor: scopedAncestor } });
	await handle.update(meta, 1, decodedPayload, { meta: { datastoreAncestor: scopedAncestor } });
	await assert.rejects(
		() => handle.create(meta, 2, wrongPayload, { meta: { datastoreAncestor: scopedAncestor } }),
		/context store create options Datastore ancestor does not match its payload data/
	);

	const middleware = createStoreMiddlewareAdapter(store, []);
	await middleware.create(meta, 3, { ...decodedPayload, id: 3 }, { meta: { datastoreAncestor: scopedAncestor } });
	await middleware.update(meta, 3, { ...decodedPayload, id: 3 }, { meta: { datastoreAncestor: scopedAncestor } });
	await assert.rejects(
		() => middleware.update(meta, 4, { ...wrongPayload, id: 4 }, { meta: { datastoreAncestor: scopedAncestor } }),
		/store middleware update options Datastore ancestor does not match its payload data/
	);

	assert.deepEqual(calls, ['create:1', 'update:1', 'create:3', 'update:3']);
});

test('Datastore write guards validate field-codec ancestors without ancestorFields', async () => {
	const calls: string[] = [];
	const scopedAncestor = datastoreKey('parent_record', 10);
	const encodedPayload = { id: 1, handle: 'encoded', parentId: 'parent:10' };
	const wrongEncodedPayload = { id: 2, handle: 'wrong-encoded', parentId: 'parent:20' };
	const wrongDecodedPayload = { id: 3, handle: 'wrong-decoded', parentId: 20 };
	const store: StoreAdapter = {
		kind: 'encoded-ancestor-write-store',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async (_model, id) => {
			calls[calls.length] = `create:${String(id)}`;
		},
		update: async (_model, id) => {
			calls[calls.length] = `update:${String(id)}`;
		},
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(DatastoreEncodedAncestorRecord);
	const handle = context.store('default');

	await handle.create(meta, 1, encodedPayload, { meta: { datastoreAncestor: scopedAncestor } });
	await handle.update(meta, 1, encodedPayload, { meta: { datastoreAncestor: scopedAncestor } });
	await assert.rejects(
		() => handle.create(meta, 2, wrongEncodedPayload, { meta: { datastoreAncestor: scopedAncestor } }),
		/context store create options Datastore ancestor does not match its payload data/
	);
	await assert.rejects(
		() => handle.update(meta, 3, wrongDecodedPayload, { meta: { datastoreAncestor: scopedAncestor } }),
		/context store update options Datastore ancestor does not match its payload data/
	);

	const middleware = createStoreMiddlewareAdapter(store, []);
	await middleware.create(meta, 4, { ...encodedPayload, id: 4 }, { meta: { datastoreAncestor: scopedAncestor } });
	await middleware.update(meta, 4, { ...encodedPayload, id: 4 }, { meta: { datastoreAncestor: scopedAncestor } });
	await assert.rejects(
		() => middleware.create(meta, 5, { ...wrongEncodedPayload, id: 5 }, { meta: { datastoreAncestor: scopedAncestor } }),
		/store middleware create options Datastore ancestor does not match its payload data/
	);
	await assert.rejects(
		() => middleware.update(meta, 6, { ...wrongDecodedPayload, id: 6 }, { meta: { datastoreAncestor: scopedAncestor } }),
		/store middleware update options Datastore ancestor does not match its payload data/
	);

	assert.deepEqual(calls, ['create:1', 'update:1', 'create:4', 'update:4']);
});

test('Google direct query paths ignore patched Array transforms', async () => {
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const firestoreSelects: unknown[][] = [];
	const firestoreQuery = {
		select(...fields: unknown[]) {
			firestoreSelects[firestoreSelects.length] = fields;
			return this;
		},
		get: async () => ({
			docs: [
				{ id: 'number:1', data: () => ({ id: 1, handle: 'one', score: 10 }) }
			],
			size: 1
		})
	};
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => firestoreQuery
		}),
		allowAggregateScanFallback: true
	});
	const datastoreSelects: unknown[][] = [];
	const datastoreQuery = {
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select(fields: unknown[]) {
			datastoreSelects[datastoreSelects.length] = fields;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => datastoreQuery,
			runQuery: async () => [[{ id: 1, handle: 'one', score: 10 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const arrayMap = Array.prototype.map;
	const arrayFilter = Array.prototype.filter;
	const arraySome = Array.prototype.some;
	const arrayEvery = Array.prototype.every;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'filter', {
		configurable: true,
		value() {
			throw new Error('patched Array.filter');
		}
	});
	Object.defineProperty(Array.prototype, 'some', {
		configurable: true,
		value() {
			throw new Error('patched Array.some');
		}
	});
	Object.defineProperty(Array.prototype, 'every', {
		configurable: true,
		value() {
			throw new Error('patched Array.every');
		}
	});
	let firestoreRows;
	let firestoreAggregate;
	let datastoreRows;
	try {
		firestoreRows = await firestore.query(typedMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['handle']
		});
		firestoreAggregate = await firestore.aggregate!(typedMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		});
		datastoreRows = await datastore.query(typedMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['handle']
		});
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: arrayFilter });
		Object.defineProperty(Array.prototype, 'some', { configurable: true, value: arraySome });
		Object.defineProperty(Array.prototype, 'every', { configurable: true, value: arrayEvery });
	}
	assert.deepEqual(firestoreRows?.list, [{ id: 1, handle: 'one', score: 10 }]);
	assert.deepEqual(firestoreAggregate, { total: 10 });
	assert.deepEqual(datastoreRows?.list, [{ id: 1, handle: 'one' }]);
	assert.deepEqual(firestoreSelects, [['id', 'handle'], ['id', 'score']]);
	assert.deepEqual(datastoreSelects, []);
});

test('Datastore portable scalar filters run before offset and limit across candidate pages', async () => {
	const scalarMeta: ResolvedModelMeta<any> = {
		...meta,
		name: 'datastore_scalar_record'
	};
	const rows = [
		{ id: 1, handle: 'array', value: [5] },
		{ id: 2, handle: 'five-a', value: 5 },
		{ id: 3, handle: 'six', value: 6 },
		{ id: 4, handle: 'seven', value: 7 },
		{ id: 5, handle: 'missing' },
		{ id: 6, handle: 'null', value: null },
		{ id: 8, handle: 'five-b', value: 5 },
		{ id: 9, handle: 'five-c', value: 5 }
	];
	const conditions: QueryPlan['where'] = [
		{ field: 'value', op: '=', value: 5 },
		{ field: 'value', op: 'in', value: [5, 6, 7] },
		{ field: 'value', op: '>', value: 5 },
		{ field: 'value', op: '>=', value: 5 },
		{ field: 'value', op: '<', value: 7 },
		{ field: 'value', op: '<=', value: 6 },
		{ field: 'value', op: 'between', value: 5, value2: 7 },
		{ field: 'value', op: '!=', value: 5 },
		{ field: 'value', op: 'isNull', value: undefined },
		{ field: 'value', op: 'isNotNull', value: undefined }
	];
	for (const condition of conditions) {
		const filters: unknown[][] = [];
		const limits: number[] = [];
		const offsets: number[] = [];
		const starts: string[] = [];
		let page = 0;
		const datastore = await createDatastoreStoreAdapter({
			allowQueryScanFallback: true,
			client: datastoreClient({
				createQuery: () => ({
					filter(field: unknown, op: unknown, value: unknown) {
						filters.push([field, op, value]);
						return this;
					},
					limit(value: number) {
						limits.push(value);
						return this;
					},
					offset(value: number) {
						offsets.push(value);
						return this;
					},
					start(cursor: string) {
						starts.push(cursor);
						return this;
					}
				}),
				runQuery: async () => page++ === 0
					? [rows.slice(0, 4), { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'scalar-page-2' }]
					: [rows.slice(4), { moreResults: 'NO_MORE_RESULTS' }]
			})
		});
		const memory = new MemoryStoreAdapter();
		await memory.seed(scalarMeta, rows);
		const plan: QueryPlan = {
			where: [condition],
			or: [],
			sort: [],
			include: [],
			offset: 1,
			limit: 2
		};

		const [datastoreResult, memoryResult] = await Promise.all([
			datastore.query(scalarMeta, plan),
			memory.query(scalarMeta, plan)
		]);

		assert.deepEqual(datastoreResult.list, memoryResult.list, condition.op);
		assert.deepEqual(offsets, [], condition.op);
		assert.deepEqual(starts, ['scalar-page-2'], condition.op);
		if (condition.op === '!=' || condition.op === 'isNull' || condition.op === 'isNotNull') {
			assert.deepEqual(filters, [], condition.op);
			assert.deepEqual(limits, [500], condition.op);
		} else {
			assert.equal(filters.length > 0, true, condition.op);
			assert.deepEqual(limits, [], condition.op);
		}
	}
});

test('Datastore portable select avoids native projection semantics', async () => {
	const calls: string[] = [];
	const seenAt = new Date('2026-07-17T00:00:00.000Z');
	const query = {
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		select(fields: string[]) {
			calls[calls.length] = `select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			runQuery: async () => [[
				{ id: 1, handle: 'one', tags: ['a', 'b'], seenAt },
				{ id: 2, handle: 'two', subtitle: 'present', tags: ['c'], seenAt }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const projectionMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['seenAt', 'date']])
	};

	const result = await datastore.query(projectionMeta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		select: ['handle', 'subtitle', 'tags', 'seenAt']
	});

	assert.deepEqual(result.list, [
		{ id: 1, handle: 'one', tags: ['a', 'b'], seenAt },
		{ id: 2, handle: 'two', subtitle: 'present', tags: ['c'], seenAt }
	]);
	assert.deepEqual(calls, []);
});

test('Datastore id-only selects use key projection and restore typed ids', async () => {
	const fixtures = [
		{
			keyEncoding: 'active-ts' as const,
			storageKeys: [{ name: 'number:17' }, { name: 'string:17' }] as const
		},
		{
			keyEncoding: 'native' as const,
			storageKeys: [{ id: '17' }, { name: '17' }] as const
		}
	];

	for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
		const fixture = fixtures[fixtureIndex];
		const keySymbol = Symbol(`datastore-key-only-${fixture.keyEncoding}`);
		const calls: string[] = [];
		const query = {
			select(fields: unknown) {
				calls[calls.length] = `select:${JSON.stringify(fields)}`;
				return this;
			}
		};
		const entities = fixture.storageKeys.map((storageKey) =>
			Object.defineProperty({}, keySymbol, {
				value: storageKey,
				enumerable: false
			})
		);
		const datastore = await createDatastoreStoreAdapter({
			keyEncoding: fixture.keyEncoding,
			client: datastoreClient({
				KEY: keySymbol,
				createQuery: () => query,
				runQuery: async () => [entities, { moreResults: 'NO_MORE_RESULTS' }]
			})
		});

		const result = await datastore.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			select: ['id']
		});

		assert.deepEqual(result.list, [{ id: 17 }, { id: '17' }]);
		assert.deepEqual(calls, ['select:"__key__"']);
	}

	const fallbackCalls: string[] = [];
	const fallbackQuery = {
		select() {
			fallbackCalls[fallbackCalls.length] = 'select';
			return this;
		}
	};
	const fallbackDatastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: undefined,
			createQuery: () => fallbackQuery,
			runQuery: async () => [[{ id: 21, handle: 'full-row-fallback' }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const fallbackResult = await fallbackDatastore.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		select: ['id']
	});
	assert.deepEqual(fallbackResult.list, [{ id: 21 }]);
	assert.deepEqual(fallbackCalls, []);
});

test('Datastore select queries preserve entity keys for unscoped ancestor partial rows', async () => {
	const keySymbol = Symbol('datastore-key');
	const calls: string[] = [];
	const left = Object.defineProperty(
		{ id: 7, title: 'left selected' },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_search_record', 7] }, enumerable: false }
	);
	const right = Object.defineProperty(
		{ id: 7, title: 'right selected' },
		keySymbol,
		{ value: { path: ['parent_record', 11, 'datastore_search_record', 7] }, enumerable: false }
	);
	const query = {
		select(fields: string[]) {
			calls[calls.length] = `select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => query,
			runQuery: async () => [[left, right], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreSearchRecord.use(context) as unknown as typeof DatastoreSearchRecord;

	const result = await Record.query().select('title').load();

	assert.deepEqual(result.list.map((item) => item.data), [
		{ id: 7, title: 'left selected' },
		{ id: 7, title: 'right selected' }
	]);
	assert.equal(result.count, 2);
	assert.deepEqual(calls, []);
});

test('Datastore scoped select queries keep descendant entity-key identities', async () => {
	const keySymbol = Symbol('datastore-key');
	const calls: string[] = [];
	const root = datastoreKey('descendant_projection_root', 1);
	const leftKey = datastoreKey('datastore_descendant_projection_record', 7, {
		parent: datastoreKey('descendant_projection_parent', 10, { parent: root })
	});
	const rightKey = datastoreKey('datastore_descendant_projection_record', 7, {
		parent: datastoreKey('descendant_projection_parent', 20, { parent: root })
	});
	const left = Object.defineProperty(
		{ id: 7, title: 'left descendant selected' },
		keySymbol,
		{ value: leftKey, enumerable: false }
	);
	const right = Object.defineProperty(
		{ id: 7, title: 'right descendant selected' },
		keySymbol,
		{ value: rightKey, enumerable: false }
	);
	const query = {
		hasAncestor() {
			calls[calls.length] = 'hasAncestor';
			return this;
		},
		select(fields: string[]) {
			calls[calls.length] = `select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createQuery: () => query,
			runQuery: async () => [[left, right], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({ stores: { default: datastore } });
	const Record = DatastoreDescendantProjectionRecord.use(context) as unknown as typeof DatastoreDescendantProjectionRecord;

	const result = await Record.ancestor(root).select('title').load();

	assert.deepEqual(result.list.map((item) => item.data), [
		{ id: 7, title: 'left descendant selected' },
		{ id: 7, title: 'right descendant selected' }
	]);
	assert.equal(result.count, 2);
	assert.deepEqual(calls, ['hasAncestor']);
});

test('Datastore query scan fallback handles emulator unsupported not-equal filters', async () => {
	const calls: string[] = [];
	const query = {
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		order(field: string, options: { descending?: boolean }) {
			calls[calls.length] = `order:${field}:${options.descending ? 'desc' : 'asc'}`;
			return this;
		},
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		select(fields: string[]) {
			calls[calls.length] = `select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = 'runQuery';
				return [[
					{ id: 1, handle: 'one', optionalMarker: 'set', score: 10 },
					{ id: 2, handle: 'missing', score: 20 },
					{ id: 3, handle: 'null', optionalMarker: null, score: 30 },
					{ id: 4, handle: 'four', optionalMarker: 'set', score: 40 }
				], { moreResults: 'NO_MORE_RESULTS' }];
			}
		}),
		allowQueryScanFallback: true
	});

	const result = await datastore.query(meta, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		sort: [],
		include: [],
		select: ['handle']
	});

	assert.deepEqual(result, {
		list: [
			{ id: 1, handle: 'one' },
			{ id: 4, handle: 'four' }
		],
		more: false
	});
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery']);
});

test('Datastore query scan fallback permits in-memory sort plans rejected by Google indexes', async () => {
	const calls: string[] = [];
	const query = {
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		order(field: string, options: { descending?: boolean }) {
			calls[calls.length] = `order:${field}:${options.descending ? 'desc' : 'asc'}`;
			return this;
		},
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = 'runQuery';
				return [[
					{ id: 1, handle: 'zeta', optionalMarker: 'set', score: 10 },
					{ id: 2, handle: 'alpha', optionalMarker: 'set', score: 20 },
					{ id: 3, handle: 'missing', score: 30 }
				], { moreResults: 'NO_MORE_RESULTS' }];
			}
		}),
		allowQueryScanFallback: true
	});

	const result = await datastore.query(meta, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		sort: [{ field: 'handle', direction: 'asc' }],
		include: [],
		limit: 1
	});

	assert.deepEqual(result, {
		list: [{ id: 2, handle: 'alpha', optionalMarker: 'set', score: 20 }],
		more: true
	});
	const offsetResult = await datastore.query(meta, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		sort: [{ field: 'handle', direction: 'asc' }],
		include: [],
		offset: 1,
		limit: 1
	});
	assert.deepEqual(offsetResult, {
		list: [{ id: 1, handle: 'zeta', optionalMarker: 'set', score: 10 }],
		more: false
	});
	assert.deepEqual(calls, [
		'createQuery',
		'limit:500',
		'runQuery',
		'createQuery',
		'limit:500',
		'runQuery'
	]);
});

test('Datastore transaction query scan fallback permits in-memory sort plans rejected by Google indexes', async () => {
	const calls: string[] = [];
	const query = {
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		order(field: string, options: { descending?: boolean }) {
			calls[calls.length] = `order:${field}:${options.descending ? 'desc' : 'asc'}`;
			return this;
		},
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		}
	};
	const transaction = {
		run: async () => {
			calls[calls.length] = 'tx.run';
		},
		commit: async () => {
			calls[calls.length] = 'tx.commit';
		},
		rollback: async () => {
			calls[calls.length] = 'tx.rollback';
		},
		get: async () => [null],
		delete: async () => undefined,
		update: async () => undefined,
		createQuery: () => {
			calls[calls.length] = 'tx.createQuery';
			return query;
		},
		runQuery: async () => {
			calls[calls.length] = 'tx.runQuery';
			return [[
				{ id: 1, handle: 'zeta', optionalMarker: 'set', score: 10 },
				{ id: 2, handle: 'alpha', optionalMarker: 'set', score: 20 },
				{ id: 3, handle: 'missing', score: 30 }
			], { moreResults: 'NO_MORE_RESULTS' }];
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'root.createQuery';
				return query;
			},
			transaction: () => transaction
		}),
		allowQueryScanFallback: true
	});

	const result = await datastore.transaction!(async (tx) =>
		tx.query(meta, {
			where: [{ field: 'optionalMarker', op: '!=', value: null }],
			or: [],
			sort: [{ field: 'handle', direction: 'asc' }],
			include: [],
			limit: 1
		})
	);

	assert.deepEqual(result, {
		list: [{ id: 2, handle: 'alpha', optionalMarker: 'set', score: 20 }],
		more: true
	});
	assert.deepEqual(calls, ['tx.run', 'root.createQuery', 'limit:500', 'tx.runQuery', 'tx.commit']);
});

test('Datastore query scan fallback reads all pages before filtering and aggregating', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls}`;
				const page = runQueryCalls++;
				if (page === 0) {
					return [[
						{ id: 1, handle: 'null', optionalMarker: null, score: 10 },
						{ id: 2, handle: 'missing', score: 20 }
					], { moreResults: 'MORE_RESULTS_AFTER_CURSOR', endCursor: 'cursor-1' }];
				}
				return [[
					{ id: 3, handle: 'three', optionalMarker: 'set', score: 30 },
					{ id: 4, handle: 'four', optionalMarker: 'set', score: 40 }
				], { moreResults: 'NO_MORE_RESULTS' }];
			}
		}),
		allowAggregateScanFallback: true,
		allowQueryScanFallback: true
	});

	const result = await datastore.query(typedMeta, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		sort: [],
		include: [],
		select: ['handle']
	});

	assert.deepEqual(result, {
		list: [
			{ id: 3, handle: 'three' },
			{ id: 4, handle: 'four' }
		],
		more: false
	});
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery:0', 'start:cursor-1', 'runQuery:1']);

	calls.length = 0;
	runQueryCalls = 0;
	const aggregate = await datastore.aggregate!(typedMeta, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		meta: datastoreReadOptions({ readTime: 1_753_000_000_000 }).meta,
		aggregates: [
			{ op: 'count', as: 'count' },
			{ op: 'sum', field: 'score', as: 'totalScore' }
		]
	});

	assert.deepEqual(aggregate, { count: 2, totalScore: 70 });
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery:0', 'start:cursor-1', 'runQuery:1']);
});

test('Datastore query scan fallback stops before duplicating repeated cursors', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls++}`;
				if (runQueryCalls > 2) throw new Error('repeated cursor should fail before a third scan page');
				return [[{ id: runQueryCalls, handle: 'page', optionalMarker: 'set' }], {
					moreResults: 'MORE_RESULTS_AFTER_CURSOR',
					endCursor: 'same-cursor'
				}];
			}
		}),
		allowQueryScanFallback: true
	});

	const result = await datastore.query(meta, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		sort: [],
		include: []
	});

	assert.deepEqual(Object.getOwnPropertySymbols(result), []);
	assert.deepEqual(result, { list: [{ id: 1, handle: 'page', optionalMarker: 'set' }], more: true });
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery:0', 'start:same-cursor', 'runQuery:1']);
});

test('Datastore query scan fallback limit does not pad incomplete scans', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls}`;
				const page = runQueryCalls++;
				return [
					page === 0
						? [{ id: 1, handle: 'one', optionalMarker: 'set', score: 10 }]
						: [{ id: 2, handle: 'missing', score: 20 }],
					{ moreResults: 'MORE_RESULTS_AFTER_CURSOR', endCursor: 'same-cursor' }
				];
			}
		}),
		allowQueryScanFallback: true
	});

	const result = await datastore.query(meta, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		sort: [],
		include: [],
		limit: 5
	});

	assert.deepEqual(result, {
		list: [{ id: 1, handle: 'one', optionalMarker: 'set', score: 10 }],
		more: true
	});
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery:0', 'start:same-cursor', 'runQuery:1']);
});

test('Datastore transaction query scan fallback surfaces incomplete repeated-cursor scans', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const client = datastoreClient({
		createQuery: () => {
			calls[calls.length] = 'createQuery';
			return query;
		},
		transaction: () => ({
			run: async () => {
				calls[calls.length] = 'tx.run';
			},
			commit: async () => {
				calls[calls.length] = 'tx.commit';
			},
			rollback: async () => {
				calls[calls.length] = 'tx.rollback';
			},
			get: async () => [null],
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls++}`;
				if (runQueryCalls > 2) throw new Error('repeated cursor should fail before a third scan page');
				return [[{ id: runQueryCalls, handle: 'page', optionalMarker: 'set' }], {
					moreResults: 'MORE_RESULTS_AFTER_CURSOR',
					endCursor: 'same-cursor'
				}];
			},
			insert: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		})
	});
	const datastore = await createDatastoreStoreAdapter({
		client,
		allowQueryScanFallback: true
	});

	const result = await datastore.transaction!(async (tx) =>
		tx.query(meta, {
			where: [{ field: 'optionalMarker', op: '!=', value: null }],
			or: [],
			sort: [],
			include: []
		})
	);

	assert.deepEqual(Object.getOwnPropertySymbols(result), []);
	assert.deepEqual(result, { list: [{ id: 1, handle: 'page', optionalMarker: 'set' }], more: true });
	assert.deepEqual(calls, [
		'tx.run',
		'createQuery',
		'limit:500',
		'runQuery:0',
		'start:same-cursor',
		'runQuery:1',
		'tx.commit'
	]);
});

test('Datastore aggregate scan fallback rejects incomplete repeated-cursor scans', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls++}`;
				if (runQueryCalls > 2) throw new Error('repeated cursor should fail before a third scan page');
				return [[{ id: runQueryCalls, handle: 'page', optionalMarker: 'set', score: 10 }], {
					moreResults: 'MORE_RESULTS_AFTER_CURSOR',
					endCursor: 'same-cursor'
				}];
			}
		}),
		allowAggregateScanFallback: true,
		allowQueryScanFallback: true
	});

	await assert.rejects(
		() =>
			datastore.aggregate!(typedMeta, {
				where: [{ field: 'optionalMarker', op: '!=', value: null }],
				or: [],
				aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }]
			}),
		/cannot aggregate a paginated query result/
	);
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery:0', 'start:same-cursor', 'runQuery:1']);
});

test('Datastore aggregate scan fallback accepts empty repeated-cursor terminators', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls++}`;
				if (runQueryCalls === 1) {
					return [[{ id: 1, handle: 'page', optionalMarker: 'set', score: 10 }], {
						moreResults: 'MORE_RESULTS_AFTER_CURSOR',
						endCursor: 'same-cursor'
					}];
				}
				return [[], {
					moreResults: 'MORE_RESULTS_AFTER_CURSOR',
					endCursor: 'same-cursor'
				}];
			}
		}),
		allowAggregateScanFallback: true,
		allowQueryScanFallback: true
	});

	assert.deepEqual(
		await datastore.aggregate!(typedMeta, {
			where: [{ field: 'optionalMarker', op: '!=', value: null }],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }]
		}),
		{ totalScore: 10 }
	);
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery:0', 'start:same-cursor', 'runQuery:1']);
});

test('Datastore min max aggregates skip projections on equality filter fields', async () => {
	const calls: string[] = [];
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		order(field: string, options: { descending?: boolean }) {
			calls[calls.length] = `order:${field}:${options.descending ? 'desc' : 'asc'}`;
			return this;
		},
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		select(fields: string[]) {
			calls[calls.length] = `select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createAggregationQuery: (base: unknown) => base,
			runAggregationQuery: async () => [[{}]],
			createQuery: () => query,
			runQuery: async () => [[{ id: 1, handle: 'one', score: 7 }], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	const result = await datastore.aggregate!(typedMeta, {
		where: [{ field: 'score', op: '=', value: 7 }],
		or: [],
		aggregates: [{ op: 'min', field: 'score', as: 'minScore' }]
	});

	assert.deepEqual(result, { minScore: 7 });
	assert.deepEqual(calls, ['filter:score:=:7', 'order:score:asc', 'limit:1']);
});

test('Datastore min max aggregates validate implicit payload ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const parent = datastoreKey('parent_record', 10);
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['parentId', 'number']])
	};
	const row = Object.defineProperty(
		{ id: 1, parentId: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1] } }
	);
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: keySymbol,
			createAggregationQuery: (base: unknown) => base,
			runAggregationQuery: async () => [[{}]],
			createQuery: () => query,
			runQuery: async () => [[row], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	await assert.rejects(
		() => datastore.aggregate!(typedAncestorMeta, {
			where: [],
			or: [],
			meta: { datastoreAncestor: parent },
			aggregates: [{ op: 'min', field: 'parentId', as: 'minParentId' }]
		}),
		/Datastore aggregate min\/max entity payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
});

test('Datastore min max aggregates validate entity keys against scoped ancestors', async () => {
	const keySymbol = Symbol('datastore-key');
	const parent = datastoreKey('parent_record', 10);
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']]),
		datastore: {
			...ancestorMeta.datastore,
			ancestorFields: ['parentId']
		}
	};
	const query = {
		hasAncestor() {
			return this;
		},
		filter() {
			return this;
		},
		order() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		}
	};
	const aggregateResult = async (entity: unknown) => {
		const datastore = await createDatastoreStoreAdapter({
			client: datastoreClient({
				KEY: keySymbol,
				createQuery: () => query,
				createAggregationQuery: (base: unknown) => base,
				runAggregationQuery: async () => [[{}]],
				runQuery: async () => [[entity], { moreResults: 'NO_MORE_RESULTS' }]
			})
		});
		return datastore.aggregate!(typedAncestorMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'max', field: 'score', as: 'maxScore' }],
			meta: { datastoreAncestor: parent }
		});
	};
	const wrongEntity = Object.defineProperty(
		{ id: 1, handle: 'wrong', parentId: 11, score: 11 },
		keySymbol,
		{ value: { path: ['parent_record', 11, 'datastore_ancestor_record', 1] } }
	);
	const wrongPayloadEntity = Object.defineProperty(
		{ id: 1, handle: 'wrong-payload', parentId: 11, score: 13 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'datastore_ancestor_record', 1] } }
	);
	const wrongPlainEntity = { id: 1, handle: 'wrong-plain', parentId: 11, score: 99 };
	const descendantEntity = Object.defineProperty(
		{ id: 1, handle: 'descendant', parentId: 10, score: 12 },
		keySymbol,
		{ value: { path: ['parent_record', 10, 'child_parent', 2, 'datastore_ancestor_record', 1] } }
	);

	await assert.rejects(
		() => aggregateResult(wrongEntity),
		/entity key must match the requested Datastore ancestor/
	);
	await assert.rejects(
		() => aggregateResult(wrongPayloadEntity),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
	await assert.rejects(
		() => aggregateResult(wrongPlainEntity),
		/payload Datastore ancestor resolved outside the scoped Datastore ancestor/
	);
	assert.deepEqual(await aggregateResult(descendantEntity), { maxScore: 12 });
});

test('Datastore min max aggregate payload validation applies adapter namespaces', async () => {
	const parent = datastoreKey('parent_record', 10);
	const typedAncestorMeta: ResolvedModelMeta<GoogleRegressionData & { parentId: number; body?: string }> = {
		...ancestorMeta,
		fieldTypes: new Map([['score', 'number']])
	};
	const calls: string[] = [];
	const query = {
		hasAncestor() {
			calls[calls.length] = 'hasAncestor';
			return this;
		},
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		order(field: string, options: { descending?: boolean }) {
			calls[calls.length] = `order:${field}:${options.descending ? 'desc' : 'asc'}`;
			return this;
		},
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		select(fields: string[]) {
			calls[calls.length] = `select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'tenant',
		client: datastoreClient({
			createAggregationQuery: () => assert.fail('SDK aggregate query should not run for min-only aggregate'),
			runAggregationQuery: async () => assert.fail('SDK aggregate query should not run for min-only aggregate'),
			createQuery: (namespace: string, kind: string) => {
				calls[calls.length] = `createQuery:${namespace}:${kind}`;
				return query;
			},
			runQuery: async () => [[
				{ id: 1, handle: 'namespaced', parentId: 10, score: 12 }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	assert.deepEqual(
		await datastore.aggregate!(typedAncestorMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'max', field: 'score', as: 'maxScore' }],
			meta: { datastoreAncestor: parent }
		}),
		{ maxScore: 12 }
	);
	assert.deepEqual(calls, [
		'createQuery:tenant:datastore_ancestor_record',
		'hasAncestor',
		'filter:score:!=:null',
		'order:score:desc',
		'limit:1',
		'select:["id","score"]'
	]);
});

test('Datastore query ancestor namespace mismatches fail before SDK query construction', async () => {
	const wrongAncestor = datastoreKey('parent_record', 10, { namespace: 'other' });
	const rejection = /Datastore key namespace must match adapter namespace/;
	const createStore = async (options: { aggregate?: boolean; scan?: boolean } = {}) => {
		let createQueryCalls = 0;
		const datastore = await createDatastoreStoreAdapter({
			namespace: 'tenant',
			allowAggregateScanFallback: options.scan,
			client: datastoreClient({
				createQuery: () => {
					createQueryCalls++;
					throw new Error('createQuery should not run for mismatched Datastore ancestor namespace');
				},
				createAggregationQuery: options.aggregate
					? () => assert.fail('createAggregationQuery should not run for mismatched Datastore ancestor namespace')
					: undefined,
				runAggregationQuery: options.aggregate
					? async () => assert.fail('runAggregationQuery should not run for mismatched Datastore ancestor namespace')
					: undefined,
				runQuery: async () => assert.fail('runQuery should not run for mismatched Datastore ancestor namespace')
			})
		});
		return { datastore, createQueryCalls: () => createQueryCalls };
	};

	const query = await createStore();
	await assert.rejects(
		() => query.datastore.query(ancestorMeta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: wrongAncestor }
		}),
		rejection
	);
	assert.equal(query.createQueryCalls(), 0);

	const aggregate = await createStore({ aggregate: true });
	await assert.rejects(
		() => aggregate.datastore.aggregate!(ancestorMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'count' }],
			meta: { datastoreAncestor: wrongAncestor }
		}),
		rejection
	);
	assert.equal(aggregate.createQueryCalls(), 0);

	const scan = await createStore({ scan: true });
	await assert.rejects(
		() => scan.datastore.aggregate!(ancestorMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'count' }],
			meta: { datastoreAncestor: wrongAncestor }
		}),
		rejection
	);
	assert.equal(scan.createQueryCalls(), 0);
});

test('Datastore native operations reject ancestor namespace mismatches before callbacks', async () => {
	const wrongAncestor = datastoreKey('parent_record', 10, { namespace: 'other' });
	const rejection = /Datastore .*namespace must match adapter namespace/;
	let queryCallbacks = 0;
	let aggregateCallbacks = 0;
	const transaction = {
		run: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined,
		get: async () => [null],
		delete: async () => undefined,
		update: async () => undefined,
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	};
	const datastore = await createDatastoreStoreAdapter({
		namespace: 'tenant',
		allowAggregateScanFallback: true,
		client: datastoreClient({ transaction: () => transaction })
	});
	const queryPlan: QueryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		native: {
			payload: async () => {
				queryCallbacks++;
				return { list: [], more: false };
			}
		},
		meta: { datastoreAncestor: wrongAncestor }
	};
	const aggregatePlan: AggregatePlan = {
		where: [],
		or: [],
		aggregates: [{ op: 'count', as: 'count' }],
		native: {
			payload: async () => {
				aggregateCallbacks++;
				return { count: 0 };
			}
		},
		meta: { datastoreAncestor: wrongAncestor }
	};

	await assert.rejects(() => datastore.query(ancestorMeta, queryPlan), rejection);
	await assert.rejects(() => datastore.aggregate!(ancestorMeta, aggregatePlan), rejection);
	assert.equal(queryCallbacks, 0);
	assert.equal(aggregateCallbacks, 0);

	await datastore.transaction!(async (tx) => {
		await assert.rejects(() => tx.query(ancestorMeta, queryPlan), rejection);
		await assert.rejects(() => tx.aggregate!(ancestorMeta, aggregatePlan), rejection);
	});
	assert.equal(queryCallbacks, 0);
	assert.equal(aggregateCallbacks, 0);
});

test('Datastore aggregate scan fallback is explicit and avoids projection queries', async () => {
	const calls: string[] = [];
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		filter(field: string, op: string, value: unknown) {
			calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
			return this;
		},
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		select(fields: string[]) {
			calls[calls.length] = `select:${JSON.stringify(fields)}`;
			return this;
		}
	};
	const client = datastoreClient({
		createQuery: () => {
			calls[calls.length] = 'createQuery';
			return query;
		},
		runQuery: async () => {
			calls[calls.length] = 'runQuery';
			return [[
				{ id: 1, handle: 'one', score: 10 },
				{ id: 2, handle: 'two', score: 30 },
				{ id: 3, handle: 'three', score: 100 }
			], { moreResults: 'NO_MORE_RESULTS' }];
		}
	});
	const withoutFallback = await createDatastoreStoreAdapter({ client });
	assert.equal(withoutFallback.aggregate, undefined);

	const datastore = await createDatastoreStoreAdapter({
		client,
		allowAggregateScanFallback: true,
		allowQueryScanFallback: true
	});

	const result = await datastore.aggregate!(typedMeta, {
		where: [{ field: 'handle', op: 'in', value: ['one', 'two'] }],
		or: [],
		meta: datastoreReadOptions({ readTime: 1_753_000_000_000 }).meta,
		aggregates: [
			{ op: 'count', as: 'count' },
			{ op: 'sum', field: 'score', as: 'totalScore' },
			{ op: 'max', field: 'score', as: 'maxScore' }
		]
	});

	assert.deepEqual(result, { count: 2, totalScore: 40, maxScore: 30 });
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery']);
});

test('Datastore aggregate scan fallback reads all paginated query results', async () => {
	const calls: string[] = [];
	let runQueryCalls = 0;
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const query = {
		limit(value: number) {
			calls[calls.length] = `limit:${value}`;
			return this;
		},
		start(cursor: string) {
			calls[calls.length] = `start:${cursor}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				calls[calls.length] = 'createQuery';
				return query;
			},
			runQuery: async () => {
				calls[calls.length] = `runQuery:${runQueryCalls++}`;
				if (runQueryCalls === 1) {
					return [[{ id: 1, handle: 'one', score: 10 }], {
						moreResults: 'MORE_RESULTS_AFTER_LIMIT',
						endCursor: 'cursor-1'
					}];
				}
				return [[{ id: 2, handle: 'two', score: 20 }], { moreResults: 'NO_MORE_RESULTS' }];
			}
		}),
		allowAggregateScanFallback: true
	});

	assert.deepEqual(
		await datastore.aggregate!(typedMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'totalScore' }]
		}),
		{ totalScore: 30 }
	);
	assert.deepEqual(calls, ['createQuery', 'limit:500', 'runQuery:0', 'start:cursor-1', 'runQuery:1']);
});

test('Datastore aggregate fallback preserves ancestor fields without native projections', async () => {
	const calls: string[] = [];
	const query = {
		select(fields: string[]) {
			calls[calls.length] = `select:${fields.join(',')}`;
			return this;
		}
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => query,
			runQuery: async () => [[
				{ id: 7, parentId: 10, score: 70, handle: 'left' },
				{ id: 7, parentId: 11, score: 90, handle: 'right' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	const context = createActiveTs({
		stores: { default: datastore },
		aggregate: { allowQueryFallback: true }
	});
	const Record = DatastoreEncodedAggregateRecord.use(context) as unknown as typeof DatastoreEncodedAggregateRecord;

	assert.deepEqual(
		await Record.query().aggregate({ totalScore: { op: 'sum', field: 'score' } }),
		{ totalScore: 16 }
	);
	assert.deepEqual(calls, []);
});

test('Datastore aggregate rejects SDK and min max combinations that would mix snapshots', async () => {
	const calls: string[] = [];
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([
			['handle', 'string'],
			['score', 'number']
		])
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: (kind: string) => {
				calls[calls.length] = `createQuery:${kind}`;
				return {
					filter(field: string, op: string, value: unknown) {
						calls[calls.length] = `filter:${field}:${op}:${JSON.stringify(value)}`;
						return this;
					},
					order(field: string, options: { descending?: boolean }) {
						calls[calls.length] = `order:${field}:${options.descending ? 'desc' : 'asc'}`;
						return this;
					},
					limit(value: number) {
						calls[calls.length] = `limit:${value}`;
						return this;
					},
					select(fields: string[]) {
						calls[calls.length] = `select:${JSON.stringify(fields)}`;
						return this;
					}
				};
			},
			createAggregationQuery: () => {
				calls[calls.length] = 'createAggregationQuery';
				const specs: Array<{ op: 'count' | 'sum' | 'avg'; alias: string }> = [];
				return {
					specs,
					count(alias: string) {
						calls[calls.length] = `count:${alias}`;
						specs[specs.length] = { op: 'count', alias };
						return this;
					},
					sum(field: string, alias: string) {
						calls[calls.length] = `sum:${field}:${alias}`;
						specs[specs.length] = { op: 'sum', alias };
						return this;
					},
					average(field: string, alias: string) {
						calls[calls.length] = `average:${field}:${alias}`;
						specs[specs.length] = { op: 'avg', alias };
						return this;
					}
				};
			},
			runAggregationQuery: async (query: { specs: Array<{ op: 'count' | 'sum' | 'avg'; alias: string }> }) => {
				calls[calls.length] = 'runAggregationQuery';
				const row: Record<string, number> = {};
				for (const spec of query.specs) {
					row[spec.alias] = spec.op === 'count' ? 2 : spec.op === 'sum' ? 50 : 25;
				}
				return [[row], {}];
			},
			runQuery: async () => {
				calls[calls.length] = 'runQuery';
				return [[{ id: 2, handle: 'beta', score: 30 }], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});

	assert.equal(datastore.capabilities?.aggregate, true);
	await assert.rejects(
		() => datastore.aggregate!(typedMeta, {
			where: [{ field: 'handle', op: 'in', value: ['alpha', 'beta'] }],
			or: [],
			aggregates: [
				{ op: 'count', as: 'count' },
				{ op: 'sum', field: 'score', as: 'total' },
				{ op: 'avg', field: 'score', as: 'average' },
				{ op: 'max', field: 'score', as: 'maxScore' }
			]
		}),
		/multiple backend queries with different snapshots/
	);
	assert.deepEqual(calls, []);
});

test('Datastore native aggregates combine different fields in one backend request', async () => {
	const aggregateGroups: string[][] = [];
	const aggregateMeta: ResolvedModelMeta<any> = {
		...meta,
		name: 'datastore_multi_aggregate_record',
		fieldTypes: new Map([
			['left', 'number'],
			['right', 'number']
		])
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createAggregationQuery: () => {
				const specs: Array<{ op: string; field?: string; alias: string }> = [];
				return {
					specs,
					count(alias: string) {
						specs.push({ op: 'count', alias });
						return this;
					},
					sum(field: string, alias: string) {
						specs.push({ op: 'sum', field, alias });
						return this;
					},
					average(field: string, alias: string) {
						specs.push({ op: 'avg', field, alias });
						return this;
					}
				};
			},
			runAggregationQuery: async (query: { specs: Array<{ op: string; field?: string; alias: string }> }) => {
				aggregateGroups.push(query.specs.map((spec) => `${spec.op}:${spec.field ?? '-'}:${spec.alias}`));
				const row: Record<string, number> = {};
				for (const spec of query.specs) {
					if (spec.op === 'count') row[spec.alias] = 2;
					else if (spec.field === 'left' && spec.op === 'sum') row[spec.alias] = 10;
					else if (spec.field === 'left') row[spec.alias] = 10;
					else row[spec.alias] = 20;
				}
				return [[row], {}];
			}
		})
	});

	assert.deepEqual(
		await datastore.aggregate!(aggregateMeta, {
			where: [],
			or: [],
			aggregates: [
				{ op: 'count', as: 'count' },
				{ op: 'sum', field: 'left', as: 'leftTotal' },
				{ op: 'avg', field: 'left', as: 'leftAverage' },
				{ op: 'sum', field: 'right', as: 'rightTotal' }
			]
		}),
		{ count: 2, leftTotal: 10, leftAverage: 10, rightTotal: 20 }
	);
	assert.deepEqual(aggregateGroups, [[
		'count:-:count',
		'sum:left:leftTotal',
		'avg:left:leftAverage',
		'sum:right:rightTotal'
	]]);
});

test('Datastore native aggregates keep compatible specs in one backend request', async () => {
	const groups: string[][] = [];
	const aggregateMeta: ResolvedModelMeta<any> = {
		...meta,
		name: 'datastore_single_aggregate_request_record',
		fieldTypes: new Map([['score', 'number']])
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createAggregationQuery: () => {
				const specs: string[] = [];
				return {
					specs,
					sum(field: string, alias: string) {
						specs.push(`sum:${field}:${alias}`);
						return this;
					},
					average(field: string, alias: string) {
						specs.push(`avg:${field}:${alias}`);
						return this;
					}
				};
			},
			runAggregationQuery: async (query: { specs: string[] }) => {
				groups.push([...query.specs]);
				return [[{ total: 30, average: 15 }], {}];
			}
		})
	});

	assert.deepEqual(await datastore.aggregate!(aggregateMeta, {
		where: [],
		or: [],
		aggregates: [
			{ op: 'sum', field: 'score', as: 'total' },
			{ op: 'avg', field: 'score', as: 'average' }
		]
	}), { total: 30, average: 15 });
	assert.deepEqual(groups, [['sum:score:total', 'avg:score:average']]);
});

test('Datastore multi-aggregate scan fallback requires a fixed snapshot and enforces five specs', async () => {
	let backendCalls = 0;
	const readOptions: unknown[] = [];
	const datastore = await createDatastoreStoreAdapter({
		allowAggregateScanFallback: true,
		client: datastoreClient({
			runQuery: async (_query: unknown, options: unknown) => {
				backendCalls++;
				readOptions.push(options);
				return [[
					{ id: 1, handle: 'one', score: 10 },
					{ id: 2, handle: 'two', score: 20 }
				], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	const aggregates: AggregatePlan['aggregates'] = [
		{ op: 'count', as: 'count' },
		{ op: 'sum', field: 'score', as: 'total' }
	];

	await assert.rejects(
		() => datastore.aggregate!(meta, { where: [], or: [], aggregates }),
		/requires readAt\(\) or a Datastore transaction to preserve one snapshot/
	);
	assert.equal(backendCalls, 0);
	const readTime = 1_753_000_000_000;
	assert.deepEqual(await datastore.aggregate!(meta, {
		where: [],
		or: [],
		aggregates,
		meta: datastoreReadOptions({ readTime }).meta
	}), { count: 2, total: 30 });
	assert.deepEqual(readOptions, [{ readTime }]);

	await assert.rejects(
		() => datastore.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [
				{ op: 'count', as: 'a' },
				{ op: 'count', as: 'b' },
				{ op: 'count', as: 'c' },
				{ op: 'count', as: 'd' },
				{ op: 'count', as: 'e' },
				{ op: 'count', as: 'f' }
			]
		}),
		/supports at most 5 aggregate fields/
	);
	assert.equal(backendCalls, 1);
});

test('Datastore numeric native aggregates require a declared number field or explicit scan validation', async () => {
	let nativeCalls = 0;
	const untypedMeta: ResolvedModelMeta<any> = {
		...meta,
		name: 'datastore_untyped_aggregate_record'
	};
	const native = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createAggregationQuery: () => {
				nativeCalls++;
				return {};
			},
			runAggregationQuery: async () => {
				nativeCalls++;
				return [[{ total: 1 }], {}];
			}
		})
	});
	await assert.rejects(
		() => native.aggregate!(untypedMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		}),
		/requires number fieldType metadata or allowAggregateScanFallback: true/
	);
	assert.equal(nativeCalls, 0);

	const scan = await createDatastoreStoreAdapter({
		allowAggregateScanFallback: true,
		client: datastoreClient({
			runQuery: async () => [[
				{ id: 1, handle: 'valid', score: 10 },
				{ id: 2, handle: 'invalid', score: 'not-a-number' }
			], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() => scan.aggregate!(untypedMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		}),
		/Aggregate "total" expected numeric values in field "score"/
	);
});

test('Datastore aggregate validates SDK aggregation result containers', async () => {
	let rows: unknown = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createAggregationQuery: () => ({
				count() {
					return this;
				}
			}),
			runAggregationQuery: async () => [rows, {}]
		})
	});
	const plan = {
		where: [],
		or: [],
		aggregates: [{ op: 'count' as const, as: 'count' }]
	};

	assert.deepEqual(await datastore.aggregate!(meta, plan), { count: 0 });
	rows = {};
	await assert.rejects(
		() => datastore.aggregate!(meta, plan),
		/Datastore aggregate result list must be an array/
	);
	rows = [{ count: 1 }, { count: 2 }];
	await assert.rejects(
		() => datastore.aggregate!(meta, plan),
		/Datastore aggregate result list must contain at most one row/
	);
	rows = [{ count: 1, extra: 2 }];
	await assert.rejects(
		() => datastore.aggregate!(meta, plan),
		/Datastore aggregate result contains unknown option "extra"/
	);
});

test('Datastore min max aggregates require field type metadata before backend access', async () => {
	let backendCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => {
				backendCalls++;
				return {};
			},
			createAggregationQuery: () => {
				backendCalls++;
				return {};
			},
			runAggregationQuery: async () => {
				backendCalls++;
				return [[{}], {}];
			}
		})
	});

	await assert.rejects(
		() => datastore.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [
				{ op: 'count', as: 'count' },
				{ op: 'max', field: 'score', as: 'maxScore' }
			]
		}),
		/Datastore aggregate "maxScore" requires fieldType metadata/
	);
	assert.equal(backendCalls, 0);
});

test('Google adapter factory option allowlists use captured Set intrinsics', async () => {
	const setHas = Set.prototype.has;
	let datastoreOptionError: unknown;
	let datastoreAncestorTransactionOptionError: unknown;
	let firestoreOptionError: unknown;
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	try {
		try {
			await createDatastoreStoreAdapter({ client: datastoreClient(), nameSpace: 'wrong' } as any);
		} catch (error) {
			datastoreOptionError = error;
		}
		try {
			await createDatastoreStoreAdapter({
				client: datastoreClient(),
				requireAncestorTransactionQueries: 'yes'
			} as any);
		} catch (error) {
			datastoreAncestorTransactionOptionError = error;
		}
		try {
			await createFirestoreStoreAdapter({ client: firestoreClient(), aggregateFields: true } as any);
		} catch (error) {
			firestoreOptionError = error;
		}
	} finally {
		Set.prototype.has = setHas;
	}
	assert.match(String((datastoreOptionError as Error | undefined)?.message), /Datastore adapter options contains unknown option "nameSpace"/);
	assert.match(
		String((datastoreAncestorTransactionOptionError as Error | undefined)?.message),
		/Datastore adapter requireAncestorTransactionQueries must be a boolean/
	);
	assert.match(String((firestoreOptionError as Error | undefined)?.message), /Firestore adapter options contains unknown option "aggregateFields"/);
});

test('Google direct queries reject typed field operand mismatches before backend access', async () => {
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	let firestoreCollectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCollectionCalls++;
				return {};
			}
		})
	});
	await assert.rejects(
		() => firestore.query(typedMeta, { where: [{ field: 'score', op: '=', value: '1' }], or: [], sort: [], include: [] }),
		/score.*number field type/
	);
	await assert.rejects(
		() => firestore.aggregate!(typedMeta, { where: [{ field: 'score', op: '=', value: '1' }], or: [], aggregates: [{ op: 'count', as: 'count' }] }),
		/score.*number field type/
	);
	assert.equal(firestoreCollectionCalls, 0);

	let datastoreQueryCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: Symbol('datastore-key'),
			key: () => ({}),
			createQuery: () => {
				datastoreQueryCalls++;
				return {};
			},
			runQuery: async () => [[], {}]
		})
	});
	await assert.rejects(
		() => datastore.query(typedMeta, { where: [{ field: 'score', op: '=', value: '1' }], or: [], sort: [], include: [] }),
		/score.*number field type/
	);
	assert.equal(datastoreQueryCalls, 0);
});

test('Google store adapters reject inequality queries when the first sort targets another field', async () => {
	let firestoreCollectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCollectionCalls++;
				return {
					where() {
						throw new Error('Firestore where should not run for invalid inequality ordering');
					},
					orderBy() {
						throw new Error('Firestore orderBy should not run for invalid inequality ordering');
					},
					get: async () => ({ docs: [], size: 0 })
				};
			}
		})
	});
	await assert.rejects(
		() =>
			firestore.query(meta, {
				where: [{ field: 'score', op: '>=', value: 10 }],
				or: [],
				sort: [{ field: 'handle', direction: 'asc' }],
				include: []
			}),
		/Firestore adapter requires the first orderBy field "handle" to match an inequality filter field \(score\)/
	);
	assert.equal(firestoreCollectionCalls, 0);

	let datastoreQueryCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: Symbol('datastore-key'),
			key: (input: unknown) => input,
			createQuery: () => {
				datastoreQueryCalls++;
				return {
					filter() {
						throw new Error('Datastore filter should not run for invalid inequality ordering');
					},
					order() {
						throw new Error('Datastore order should not run for invalid inequality ordering');
					},
					limit() {
						return this;
					},
					select() {
						return this;
					}
				};
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() =>
			datastore.query(meta, {
				where: [{ field: 'deletedAt', op: 'isNotNull', value: undefined }],
				or: [],
				sort: [{ field: 'handle', direction: 'asc' }],
				include: []
			}),
		/Datastore adapter requires the first order field "handle" to match an inequality filter field \(deletedAt\)/
	);
	assert.equal(datastoreQueryCalls, 0);
});

test('Google store adapters reject limited inequality queries without explicit sort', async () => {
	let firestoreCollectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCollectionCalls++;
				return {
					where() {
						throw new Error('Firestore where should not run for limited inequality without sort');
					},
					limit() {
						throw new Error('Firestore limit should not run for limited inequality without sort');
					},
					get: async () => ({ docs: [], size: 0 })
				};
			}
		})
	});
	await assert.rejects(
		() =>
			firestore.query(meta, {
				where: [{ field: 'score', op: '>=', value: 10 }],
				or: [],
				sort: [],
				include: [],
				limit: 1
			}),
		/Firestore adapter requires an explicit orderBy on an inequality filter field \(score\) before limit\(\)/
	);
	assert.equal(firestoreCollectionCalls, 0);

	let datastoreQueryCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: Symbol('datastore-key'),
			key: (input: unknown) => input,
			createQuery: () => {
				datastoreQueryCalls++;
				return {
					filter() {
						throw new Error('Datastore filter should not run for limited inequality without sort');
					},
					limit() {
						throw new Error('Datastore limit should not run for limited inequality without sort');
					}
				};
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() =>
			datastore.query(meta, {
				where: [{ field: 'score', op: '>=', value: 10 }],
				or: [],
				sort: [],
				include: [],
				limit: 1
			}),
		/Datastore adapter requires an explicit order on an inequality filter field \(score\) before limit\(\)/
	);
	assert.equal(datastoreQueryCalls, 0);
});

test('Google store adapters allow limited inequality queries sorted by the inequality field', async () => {
	const typedMeta: ResolvedModelMeta<GoogleRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const firestoreCalls: string[] = [];
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCalls.push('collection');
				return {
					where(field: string, op: string, value: unknown) {
						firestoreCalls.push(`where:${field}:${op}:${String(value)}`);
						return this;
					},
					orderBy(field: string, direction: string) {
						firestoreCalls.push(`orderBy:${field}:${direction}`);
						return this;
					},
					limit(value: number) {
						firestoreCalls.push(`limit:${value}`);
						return this;
					},
					get: async () => {
						firestoreCalls.push('get');
						return { docs: [], size: 0 };
					}
				};
			}
		})
	});
	await firestore.query(typedMeta, {
		where: [{ field: 'score', op: '>=', value: 10 }],
		or: [],
		sort: [{ field: 'score', direction: 'asc' }],
		include: [],
		limit: 1
	});
	assert.deepEqual(firestoreCalls, ['collection', 'where:score:>=:10', 'orderBy:score:asc', 'orderBy:id:asc', 'limit:2', 'get']);

	const datastoreCalls: string[] = [];
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: Symbol('datastore-key'),
			key: (input: unknown) => input,
			createQuery: () => {
				datastoreCalls.push('createQuery');
				return {
					filter(field: string, op: string, value: unknown) {
						datastoreCalls.push(`filter:${field}:${op}:${String(value)}`);
						return this;
					},
					order(field: string, options: { descending?: boolean }) {
						datastoreCalls.push(`order:${field}:${String(options.descending === true)}`);
						return this;
					},
					limit(value: number) {
						datastoreCalls.push(`limit:${value}`);
						return this;
					},
					select() {
						return this;
					}
				};
			},
			runQuery: async () => {
				datastoreCalls.push('runQuery');
				return [[], { moreResults: 'NO_MORE_RESULTS' }];
			}
		})
	});
	await datastore.query(typedMeta, {
		where: [{ field: 'score', op: '>=', value: 10 }],
		or: [],
		sort: [{ field: 'score', direction: 'asc' }],
		include: [],
		limit: 1
	});
	assert.deepEqual(datastoreCalls, ['createQuery', 'filter:score:>=:10', 'order:score:false', 'order:id:false', 'limit:1', 'runQuery']);
});

test('Google store adapters reject backend inequality limits before backend access', async () => {
	let firestoreCollectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCollectionCalls++;
				return {
					where() {
						throw new Error('Firestore where should not run for invalid inequality limits');
					},
					get: async () => ({ docs: [], size: 0 })
				};
			}
		})
	});
	await assert.rejects(
		() =>
			firestore.query(meta, {
				where: [
					{ field: 'score', op: '!=', value: 10 },
					{ field: 'rank', op: '!=', value: 2 }
				],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore adapter supports at most one != or isNotNull filter per query/
	);
	await assert.rejects(
		() =>
			firestore.aggregate!(meta, {
				where: [
					{ field: 'score', op: 'isNotNull', value: undefined },
					{ field: 'rank', op: '!=', value: 2 }
				],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/Firestore adapter supports at most one != or isNotNull filter per query/
	);
	assert.equal(firestoreCollectionCalls, 0);

	let datastoreQueryCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: Symbol('datastore-key'),
			key: (input: unknown) => input,
			createQuery: () => {
				datastoreQueryCalls++;
				return {
					filter() {
						throw new Error('Datastore filter should not run for invalid inequality limits');
					}
				};
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() =>
			datastore.query(meta, {
				where: [
					{ field: 'score', op: '!=', value: 10 },
					{ field: 'rank', op: 'isNotNull', value: undefined }
				],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore adapter supports at most one != or isNotNull filter per query/
	);
	assert.equal(datastoreQueryCalls, 0);
});

test('Google store adapters reject too many inequality fields before backend access', async () => {
	const where: QueryPlan['where'] = [];
	for (let index = 0; index < 11; index++) {
		where[index] = { field: `score${index}`, op: '>=', value: index };
	}

	let firestoreCollectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCollectionCalls++;
				return {
					where() {
						throw new Error('Firestore where should not run for excessive inequality fields');
					},
					get: async () => ({ docs: [], size: 0 })
				};
			}
		})
	});
	await assert.rejects(
		() => firestore.query(meta, { where, or: [], sort: [], include: [] }),
		/Firestore adapter supports at most 10 inequality filter fields per query/
	);
	assert.equal(firestoreCollectionCalls, 0);

	let datastoreQueryCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: Symbol('datastore-key'),
			key: (input: unknown) => input,
			createQuery: () => {
				datastoreQueryCalls++;
				return {
					filter() {
						throw new Error('Datastore filter should not run for excessive inequality fields');
					}
				};
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() => datastore.query(meta, { where, or: [], sort: [], include: [] }),
		/Datastore adapter supports at most 10 inequality filter fields per query/
	);
	assert.equal(datastoreQueryCalls, 0);
});

test('Firestore adapter rejects expanded disjunction limits before backend access', async () => {
	const firstValues = [];
	for (let index = 0; index < 30; index++) firstValues[index] = index;
	const where = [
		{ field: 'score', op: 'in' as const, value: firstValues },
		{ field: 'rank', op: 'in' as const, value: [1, 2] }
	];
	let collectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				collectionCalls++;
				return {
					where() {
						throw new Error('Firestore where should not run for excessive disjunctions');
					},
					get: async () => ({ docs: [], size: 0 })
				};
			}
		})
	});

	await assert.rejects(
		() => firestore.query(meta, { where, or: [], sort: [], include: [] }),
		/Firestore adapter supports at most 30 disjunctions per query after in-filter expansion/
	);
	await assert.rejects(
		() =>
			firestore.aggregate!(meta, {
				where,
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/Firestore adapter supports at most 30 disjunctions per query after in-filter expansion/
	);
	assert.equal(collectionCalls, 0);
});

test('Google inequality constraints ignore patched Array includes', () => {
	const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!;
	Object.defineProperty(Array.prototype, 'includes', {
		configurable: true,
		value() {
			throw new Error('patched Array.includes');
		}
	});
	try {
		assert.throws(
			() =>
				assertGoogleInequalitySortOrder(
					'Google',
					{
						where: [{ field: 'score', op: '>=', value: 10 }],
						sort: [{ field: 'handle', direction: 'asc' }]
					},
					'orderBy'
				),
			/Google adapter requires the first orderBy field "handle" to match an inequality filter field \(score\)/
		);
		assert.throws(
			() =>
				assertGoogleMinMaxInequalityOrder(
					'Google',
					{ where: [{ field: 'score', op: '>=', value: 10 }] },
					{ op: 'min', field: 'handle', as: 'minHandle' } as any
				),
			/Google adapter cannot optimize min\(handle\) with inequality filters on score/
		);
	} finally {
		Object.defineProperty(Array.prototype, 'includes', includes);
	}
});

test('Google store adapters reject untyped portable sorts before backend access', async () => {
	let firestoreCollectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCollectionCalls++;
				return {
					orderBy() {
						throw new Error('Firestore orderBy should not run for untyped portable sorts');
					},
					get: async () => ({ docs: [], size: 0 })
				};
			}
		})
	});
	await assert.rejects(
		() =>
			firestore.query(meta, {
				where: [],
				or: [],
				sort: [{ field: 'handle', direction: 'asc' }],
				include: []
			}),
		/Firestore adapter requires fieldType metadata for portable orderBy\("handle"\)/
	);
	assert.equal(firestoreCollectionCalls, 0);

	let datastoreQueryCalls = 0;
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			KEY: Symbol('datastore-key'),
			key: (input: unknown) => input,
			createQuery: () => {
				datastoreQueryCalls++;
				return {
					order() {
						throw new Error('Datastore order should not run for untyped portable sorts');
					}
				};
			},
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() =>
			datastore.query(meta, {
				where: [],
				or: [],
				sort: [{ field: 'handle', direction: 'asc' }],
				include: []
			}),
		/Datastore adapter requires fieldType metadata for portable order\("handle"\)/
	);
	assert.equal(datastoreQueryCalls, 0);
});

test('Firestore adapter rejects multiple arrayContains filters before backend query', async () => {
	let firestoreCollectionCalls = 0;
	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			getAll: async () => [],
			collection: () => {
				firestoreCollectionCalls++;
				return {
					where() {
						throw new Error('Firestore where should not run for invalid arrayContains combination');
					},
					get: async () => ({ docs: [], size: 0 })
				};
			}
		})
	});
	const where = [
		{ field: 'tags', op: 'arrayContains' as const, value: 'red' },
		{ field: 'labels', op: 'arrayContains' as const, value: 'urgent' }
	];

	await assert.rejects(
		() => firestore.query(meta, { where, or: [], sort: [], include: [] }),
		/Firestore adapter supports at most one arrayContains filter per query/
	);
	await assert.rejects(
		() =>
			firestore.aggregate!(meta, {
				where,
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/Firestore adapter supports at most one arrayContains filter per query/
	);
	assert.equal(firestoreCollectionCalls, 0);
});

test('Firestore min and max aggregate fast path rejects incompatible inequality order before backend access', async () => {
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['handle', 'string'], ['score', 'number']])
	};
	let collectionCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => {
				collectionCalls++;
				return {
					where() {
						throw new Error('Firestore where should not run for invalid min/max inequality ordering');
					},
					orderBy() {
						throw new Error('Firestore orderBy should not run for invalid min/max inequality ordering');
					},
					limit() {
						return this;
					},
					get: async () => ({ docs: [], size: 0 })
				};
			},
			getAll: async () => []
		})
	});

	await assert.rejects(
		() =>
			adapter.aggregate!(typedMeta, {
				where: [{ field: 'score', op: '>=', value: 10 }],
				or: [],
				aggregates: [{ op: 'min', field: 'handle', as: 'firstHandle' }]
			}),
		/Firestore adapter cannot optimize min\(handle\) with inequality filters on score/
	);
	assert.equal(collectionCalls, 0);
});

test('Firestore adapter rejects inherited client, aggregate, collection, and query methods', async () => {
	const hiddenFirestoreClient = Object.defineProperty({ getAll: async () => [] }, 'collection', {
		enumerable: false,
		value: () => ({})
	});
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client: hiddenFirestoreClient } as any),
		/Firestore adapter client\.collection must be enumerable/
	);

	Object.defineProperties(Object.prototype, {
		collection: { value: () => ({}), configurable: true },
		getAll: { value: async () => [], configurable: true },
		count: { value: () => ({}), configurable: true },
		sum: { value: () => ({}), configurable: true },
		average: { value: () => ({}), configurable: true },
		doc: { value: () => ({ get: async () => ({ exists: false }) }), configurable: true },
		where: { value: () => ({}), configurable: true }
	});
	try {
		await assert.rejects(
			() => createFirestoreStoreAdapter({ client: {} } as any),
			/Firestore adapter client\.collection must be a function/
		);
		await assert.rejects(
			() =>
				createFirestoreStoreAdapter({
					client: firestoreClient({ collection: () => ({}), getAll: async () => [] }),
					aggregateField: {} as any
				}),
			/Firestore adapter aggregateField\.count must be a function/
		);
		const adapter = await createFirestoreStoreAdapter({
			client: firestoreClient({ collection: () => ({}), getAll: async () => [] })
		});
		await assert.rejects(() => adapter.get(meta, 1), /Firestore collection\.doc must be a function/);
		await assert.rejects(
			() =>
				adapter.query(meta, {
					where: [{ field: 'handle', op: '=', value: 'one' }],
					or: [],
					sort: [],
					include: []
				}),
			/Firestore query\.where must be a function/
		);
		await assert.rejects(
			() =>
				adapter.query(meta, {
					where: [{ field: 'handle', op: 'arrayContains', value: 'one' }],
					or: [],
					sort: [],
					include: []
				}),
			/Firestore query\.where must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).collection;
		delete (Object.prototype as Record<string, unknown>).getAll;
		delete (Object.prototype as Record<string, unknown>).count;
		delete (Object.prototype as Record<string, unknown>).sum;
		delete (Object.prototype as Record<string, unknown>).average;
		delete (Object.prototype as Record<string, unknown>).doc;
		delete (Object.prototype as Record<string, unknown>).where;
	}
});

test('Firestore adapter rejects accessor methods without invoking them', async () => {
	let getterCalls = 0;
	const client = Object.defineProperty({ getAll: async () => [] }, 'collection', {
		enumerable: true,
		get() {
			getterCalls++;
			return () => ({});
		}
	});
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client } as any),
		/Firestore adapter client\.collection must be a data property/
	);
	assert.equal(getterCalls, 0);

	const aggregateField = Object.defineProperty({ sum: () => ({}), average: () => ({}) }, 'count', {
		enumerable: true,
		get() {
			getterCalls++;
			return () => ({});
		}
	});
	await assert.rejects(
		() =>
			createFirestoreStoreAdapter({
				client: firestoreClient({ collection: () => ({}), getAll: async () => [] }),
				aggregateField
			} as any),
		/Firestore adapter aggregateField\.count must be a data property/
	);
	assert.equal(getterCalls, 0);

	const query = Object.defineProperty({}, 'where', {
		enumerable: true,
		get() {
			getterCalls++;
			return () => query;
		}
	});
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => query,
			getAll: async () => []
		}),
		allowAggregateScanFallback: true
	});
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'handle', op: '=', value: 'one' }],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query\.where must be a data property/
	);
	assert.equal(getterCalls, 0);
});

test('Firestore adapter snapshots client and aggregate helper methods at creation', async () => {
	const calls: string[] = [];
	const docRef = {
		get: async () => {
			calls.push('doc.get');
			return { exists: false };
		}
	};
	const collection = {
		doc: (id: string) => {
			calls.push(`doc:${id}`);
			return docRef;
		},
		aggregate: (spec: Record<string, unknown>) => {
			calls.push(`aggregate:${Object.keys(spec).join(',')}`);
			return {
				get: async () => ({
					data: () => ({ count: 1 })
				})
			};
		}
	};
	const client = {
		collection: (name: string) => {
			calls.push(`collection:${name}`);
			return collection;
		},
		getAll: async (...refs: unknown[]) => {
			calls.push(`getAll:${refs.length}`);
			return refs.map(() => ({ exists: false }));
		},
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({
				get: async () => ({ exists: false }),
				set: async () => undefined
			})
	};
	const aggregateField = {
		count: () => {
			calls.push('count');
			return { type: 'count' };
		},
		sum: (field: string) => {
			calls.push(`sum:${field}`);
			return { type: 'sum', field };
		},
		average: (field: string) => {
			calls.push(`average:${field}`);
			return { type: 'average', field };
		}
	};
	const adapter = await createFirestoreStoreAdapter({ client, aggregateField });
	client.collection = () => {
		throw new Error('mutated firestore collection should not run');
	};
	client.getAll = async () => {
		throw new Error('mutated firestore getAll should not run');
	};
	aggregateField.count = () => {
		throw new Error('mutated firestore count should not run');
	};
	aggregateField.sum = () => {
		throw new Error('mutated firestore sum should not run');
	};
	aggregateField.average = () => {
		throw new Error('mutated firestore average should not run');
	};

	assert.equal(await adapter.get(meta, 1), null);
	assert.deepEqual(await adapter.getMany(meta, [1]), [null]);
	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'count' }]
		}),
		{ count: 1 }
	);
	assert.deepEqual(calls, [
		'collection:google_regression_record',
		'doc:number:1',
		'doc.get',
		'collection:google_regression_record',
		'doc:number:1',
		'getAll:1',
		'collection:google_regression_record',
		'count',
		'aggregate:count'
	]);
});

test('Firestore adapter accepts SDK-style aggregate helper static methods', async () => {
	const calls: string[] = [];
	class AggregateField {
		static count() {
			calls.push('count');
			return { type: 'count' };
		}

		static sum(field: string) {
			calls.push(`sum:${field}`);
			return { type: 'sum', field };
		}

		static average(field: string) {
			calls.push(`average:${field}`);
			return { type: 'average', field };
		}
	}
	assert.equal(Object.prototype.propertyIsEnumerable.call(AggregateField, 'count'), false);
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				aggregate: (spec: Record<string, unknown>) => {
					calls.push(`aggregate:${Object.keys(spec).join(',')}`);
					return {
						get: async () => ({
							data: () => ({ count: 3 })
						})
					};
				}
			})
		}),
		aggregateField: AggregateField
	});

	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'count' }]
		}),
		{ count: 3 }
	);
	assert.deepEqual(calls, ['count', 'aggregate:count']);
});

test('Firestore untyped min and max aggregates use fallback to scan invalid rows', async () => {
	const calls: string[] = [];
	const query = {
		where() {
			calls.push('where');
			return this;
		},
		orderBy() {
			calls.push('orderBy');
			throw new Error('Firestore orderBy should not run for untyped min/max fallback');
		},
		limit() {
			calls.push('limit');
			return this;
		},
		select(...fields: string[]) {
			calls.push(`select:${fields.join(',')}`);
			return this;
		},
		get: async () => {
			calls.push('get');
			return {
				docs: [
					{
						data: () => ({ id: 1, handle: 'one', score: 5 })
					},
					{
						data: () => ({ id: 2, handle: 'two', score: { nested: true } })
					}
				]
			};
		}
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => query,
			getAll: async () => []
		}),
		allowAggregateScanFallback: true
	});

	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'max', field: 'score', as: 'highest' }]
			}),
		/Aggregate "highest" expected scalar comparable values in field "score"/
	);
	assert.deepEqual(calls, ['select:id,score', 'get']);
});

test('Firestore min and max aggregate fast path filters null aggregate fields before ordering', async () => {
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const calls: string[] = [];
	const query = {
		where(field: string, op: string, value: unknown) {
			calls.push(`where:${field}:${op}:${String(value)}`);
			return this;
		},
		orderBy(field: string, direction: string) {
			calls.push(`orderBy:${field}:${direction}`);
			return this;
		},
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		},
		get: async () => {
			calls.push('get');
			return {
				docs: [
					{
						data: () => ({ id: 1, score: 5 })
					}
				],
				size: 1
			};
		}
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => query,
			getAll: async () => []
		})
	});

	assert.deepEqual(
		await adapter.aggregate!(typedMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'min', field: 'score', as: 'lowest' }]
		}),
		{ lowest: 5 }
	);
	assert.deepEqual(calls, ['where:score:!=:null', 'orderBy:score:asc', 'limit:1', 'get']);
});

test('Firestore min and max aggregate fallback avoids incompatible null in filters', async () => {
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const calls: string[] = [];
	const query = {
		where(field: string, op: string, value: unknown) {
			calls.push(`where:${field}:${op}:${JSON.stringify(value)}`);
			return this;
		},
		orderBy() {
			calls.push('orderBy');
			throw new Error('Firestore orderBy should not run for mixed-null in-filter min/max fallback');
		},
		limit() {
			calls.push('limit');
			return this;
		},
		select(...fields: string[]) {
			calls.push(`select:${fields.join(',')}`);
			return this;
		},
		get: async () => {
			calls.push('get');
			return {
				docs: [
					{ data: () => ({ id: 1, score: null }) },
					{ data: () => ({ id: 2, score: 7 }) }
				],
				size: 2
			};
		}
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => query,
			getAll: async () => []
		}),
		allowAggregateScanFallback: true
	});

	assert.deepEqual(
		await adapter.aggregate!(typedMeta, {
			where: [{ field: 'score', op: 'in', value: [null, 7] }],
			or: [],
			aggregates: [{ op: 'min', field: 'score', as: 'lowest' }]
		}),
		{ lowest: 7 }
	);
	assert.deepEqual(calls, ['where:score:in:[null,7]', 'select:id,score', 'get']);
});

test('Firestore adapter maps already-exists create errors to conflicts', async () => {
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({
					create: async () => {
						throw Object.assign(new Error('already exists'), { code: 6 });
					}
				})
			}),
			getAll: async () => []
		})
	});

	await assert.rejects(
		() => adapter.create(meta, 1, { id: 1, handle: 'duplicate' }),
		ActiveTsConflictError
	);

	let codeGetterCalls = 0;
	const accessorAdapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({
					create: async () => {
						throw Object.defineProperty(new Error('accessor firestore code'), 'code', {
							enumerable: true,
							get() {
								codeGetterCalls++;
								return 6;
							}
						});
					}
				})
			}),
			getAll: async () => []
		})
	});
	await assert.rejects(
		() => accessorAdapter.create(meta, 1, { id: 1, handle: 'accessor' }),
		/accessor firestore code/
	);
	assert.equal(codeGetterCalls, 0);
});

test('Firestore adapter updates through transactions without recreating deleted documents', async () => {
	const calls: string[] = [];
	let stored: Record<string, unknown> = { id: 1, handle: 'old', stale: true };
	const docRef = {
		set: async () => {
			throw new Error('document set should not run directly');
		},
		update: async () => {
			throw new Error('document update fallback should not run when transactions are available');
		}
	};
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => {
					calls.push(`doc:${id}`);
					return docRef;
				}
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				calls.push('runTransaction');
				return callback({
					get: async (ref: unknown) => {
						assert.equal(ref, docRef);
						calls.push('tx.get');
						return { exists: true };
					},
					set: async (ref: unknown, data: Record<string, unknown>) => {
						assert.equal(ref, docRef);
						calls.push('tx.set');
						stored = data;
					}
				});
			}
		}
	});

	await adapter.update(meta, 1, { id: 1, handle: 'new' });

	assert.deepEqual(calls, ['doc:number:1', 'runTransaction', 'tx.get', 'tx.set']);
	assert.deepEqual(stored, { id: 1, handle: 'new' });

	let racingSetCalls = 0;
	const racingAdapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: () => ({})
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => ({ exists: true }),
					set: async () => {
						racingSetCalls++;
						throw Object.assign(new Error('deleted during transaction'), { code: 5 });
					}
				})
		}
	});

	await assert.rejects(
		() => racingAdapter.update(meta, 1, { id: 1, handle: 'lost' }),
		ActiveTsNotFoundError
	);
	assert.equal(racingSetCalls, 1);
});

test('Firestore adapter transactions use SDK transactions and buffered row reads', async () => {
	const calls: string[] = [];
	const stored = new Map<string, Record<string, unknown>>();
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: (name: string) => ({
				doc: (id: string) => {
					calls.push(`doc:${name}:${id}`);
					return { name, id };
				}
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				calls.push('runTransaction');
				return await callback({
					get: async (ref: { id: string }) => {
						calls.push(`tx.get:${ref.id}`);
						const data = stored.get(ref.id);
						return {
							exists: data !== undefined,
							id: ref.id,
							data: () => data
						};
					},
					create: async (ref: { id: string }, data: Record<string, unknown>) => {
						calls.push(`tx.create:${ref.id}`);
						if (stored.has(ref.id)) throw Object.assign(new Error('already exists'), { code: 6 });
						stored.set(ref.id, data);
					},
					set: async (ref: { id: string }, data: Record<string, unknown>) => {
						calls.push(`tx.set:${ref.id}`);
						stored.set(ref.id, data);
					},
					delete: async (ref: { id: string }) => {
						calls.push(`tx.delete:${ref.id}`);
						stored.delete(ref.id);
					}
				});
			}
		}
	});

	assert.equal(adapter.capabilities?.transaction, true);
	await adapter.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.transaction, false);
		assert.equal(tx.capabilities?.native, false);
		await tx.create(meta, 1, { id: 1, handle: 'created' });
		assert.deepEqual(await tx.get(meta, 1), { id: 1, handle: 'created' });
		await tx.update(meta, 1, { id: 1, handle: 'updated' });
		assert.deepEqual(await tx.get(meta, 1), { id: 1, handle: 'updated' });
		await tx.delete(meta, 1);
		assert.equal(await tx.get(meta, 1), null);
		return 'ok';
	});

	assert.deepEqual(
		calls.filter((call) => call.startsWith('tx.')),
		['tx.create:number:1', 'tx.set:number:1', 'tx.delete:number:1']
	);
	assert.deepEqual([...stored.entries()], []);
});

test('Firestore low-level transaction adapters close after callbacks settle', async () => {
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => ({ exists: false }),
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				})
		})
	});
	let leaked!: StoreAdapter;

	await adapter.transaction!(async (tx) => {
		leaked = tx;
	});

	await assert.rejects(
		() => leaked.get(meta, 1),
		/closed Firestore store transaction adapter after callback finished/
	);
});

test('Firestore transactions finish operations started before callbacks settle', async () => {
	const calls: string[] = [];
	let releaseCreate!: () => void;
	const holdCreate = new Promise<void>((resolve) => {
		releaseCreate = resolve;
	});
	let callbackReturned!: () => void;
	const callbackDidReturn = new Promise<void>((resolve) => {
		callbackReturned = resolve;
	});
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				calls[calls.length] = 'runTransaction';
				const result = await callback({
					get: async () => ({ exists: false }),
					create: async () => {
						calls[calls.length] = 'create:start';
						await holdCreate;
						calls[calls.length] = 'create:finish';
					},
					set: async () => undefined,
					delete: async () => undefined
				});
				calls[calls.length] = 'commit';
				return result;
			}
		}
	});
	let pendingCreate!: Promise<void>;

	const pendingTransaction = adapter.transaction!(async (tx) => {
		pendingCreate = tx.create(meta, 1, { id: 1, handle: 'pending' });
		callbackReturned();
	});
	await callbackDidReturn;
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseCreate();
	await pendingTransaction;
	await pendingCreate;

	assert.deepEqual(calls, [
		'runTransaction',
		'create:start',
		'create:finish',
		'commit'
	]);
});

test('Firestore transactions serialize concurrent creates for the same document', async () => {
	let createCalls = 0;
	let markCreateStarted!: () => void;
	const createStarted = new Promise<void>((resolve) => {
		markCreateStarted = resolve;
	});
	let releaseCreate!: () => void;
	const holdCreate = new Promise<void>((resolve) => {
		releaseCreate = resolve;
	});
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => ({ exists: false }),
					create: async () => {
						createCalls++;
						markCreateStarted();
						await holdCreate;
					},
					set: async () => undefined,
					delete: async () => undefined
				})
		}
	});

	const outcomes = await adapter.transaction!(async (tx) => {
		const first = tx.create(meta, 1, { id: 1, handle: 'first' });
		await createStarted;
		const second = tx.create(meta, 1, { id: 1, handle: 'second' });
		releaseCreate();
		return Promise.allSettled([first, second]);
	});

	assert.equal(createCalls, 1);
	assert.equal(outcomes[0].status, 'fulfilled');
	assert.equal(outcomes[1].status, 'rejected');
	if (outcomes[1].status === 'rejected') {
		assert.ok(outcomes[1].reason instanceof ActiveTsConflictError);
	}
});

test('Firestore transactions preserve concurrent mutation order for the same document', async () => {
	const calls: string[] = [];
	let markCreateStarted!: () => void;
	const createStarted = new Promise<void>((resolve) => {
		markCreateStarted = resolve;
	});
	let releaseCreate!: () => void;
	const holdCreate = new Promise<void>((resolve) => {
		releaseCreate = resolve;
	});
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => {
						calls.push('get');
						return { exists: false };
					},
					create: async (_ref: unknown, data: GoogleRegressionData) => {
						calls.push(`create:${data.handle}`);
						markCreateStarted();
						await holdCreate;
					},
					set: async (_ref: unknown, data: GoogleRegressionData) => {
						calls.push(`set:${data.handle}`);
					},
					delete: async () => undefined
				})
		}
	});

	const row = await adapter.transaction!(async (tx) => {
		const create = tx.create(meta, 1, { id: 1, handle: 'first' });
		await createStarted;
		const update = tx.update(meta, 1, { id: 1, handle: 'updated' });
		releaseCreate();
		await Promise.all([create, update]);
		return tx.get(meta, 1);
	});

	assert.deepEqual(calls, ['create:first', 'set:updated']);
	assert.deepEqual(row, { id: 1, handle: 'updated' });
});

test('Firestore transactions keep mutations for different documents concurrent', async () => {
	const started: string[] = [];
	let markFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	let releaseFirst!: () => void;
	const holdFirst = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => ({ exists: false }),
					create: async (ref: { id: string }) => {
						started.push(ref.id);
						if (ref.id === 'number:1') {
							markFirstStarted();
							await holdFirst;
						}
					},
					set: async () => undefined,
					delete: async () => undefined
				})
		}
	});

	await adapter.transaction!(async (tx) => {
		const first = tx.create(meta, 1, { id: 1, handle: 'first' });
		await firstStarted;
		const second = tx.create(meta, 2, { id: 2, handle: 'second' });
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.deepEqual(started, ['number:1', 'number:2']);
		} finally {
			releaseFirst();
		}
		await Promise.all([first, second]);
	});
});

test('Firestore transaction offset queries map through the transaction query builder', async () => {
	const calls: string[] = [];
	const query = {
		offset(value: number) {
			calls.push(`offset:${value}`);
			return this;
		},
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		}
	};
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => query,
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => ({
						docs: [{ data: () => ({ id: 3, handle: 'three' }) }],
						size: 1
					}),
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				})
		}
	});

	await adapter.transaction!(async (tx) => {
		const result = await tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			offset: 2,
			limit: 1
		});
		assert.equal(tx.capabilities?.offset, true);
		assert.deepEqual(result.list, [{ id: 3, handle: 'three' }]);
	});
	assert.deepEqual(calls, ['offset:2', 'limit:2']);
});

test('Firestore transaction queries wait behind earlier pending updates', async () => {
	let markExistenceReadStarted!: () => void;
	const existenceReadStarted = new Promise<void>((resolve) => {
		markExistenceReadStarted = resolve;
	});
	let releaseExistenceRead!: () => void;
	const holdExistenceRead = new Promise<void>((resolve) => {
		releaseExistenceRead = resolve;
	});
	let querySdkCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => {
				const query = {
					kind: 'query',
					doc: (id: string) => ({ kind: 'document', id })
				};
				return query;
			},
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async (target: { kind: string; id?: string }) => {
						if (target.kind === 'document') {
							markExistenceReadStarted();
							await holdExistenceRead;
							return {
								exists: true,
								id: target.id,
								data: () => ({ id: 1, handle: 'old' })
							};
						}
						querySdkCalls++;
						return {
							docs: [{ id: 'number:1', data: () => ({ id: 1, handle: 'old' }) }],
							size: 1
						};
					},
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				})
		}
	});

	await adapter.transaction!(async (tx) => {
		const update = tx.update(meta, 1, { id: 1, handle: 'new' });
		await existenceReadStarted;
		let invalidQuerySettled = false;
		const invalidQueryOutcome = tx.query(meta, {
			where: [],
			or: [],
			sort: [{ field: 'undeclared', direction: 'asc' }],
			include: []
		}).then(
			() => undefined,
			(error: unknown) => error
		).finally(() => {
			invalidQuerySettled = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(invalidQuerySettled, true);
			const invalidQueryError = await invalidQueryOutcome;
			assert.ok(invalidQueryError instanceof ActiveTsConfigurationError);
			assert.match(invalidQueryError.message, /requires fieldType metadata/);
		} catch (error) {
			releaseExistenceRead();
			throw error;
		}
		const query = tx.query(meta, { where: [], or: [], sort: [], include: [] });
		const queryOutcome = query.then(
			() => undefined,
			(error: unknown) => error
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.equal(querySdkCalls, 0);
		} finally {
			releaseExistenceRead();
		}
		await update;
		const queryError = await queryOutcome;
		assert.ok(queryError instanceof ActiveTsConfigurationError);
		assert.match(queryError.message, /cannot read unbuffered documents after writes/);
	});
	assert.equal(querySdkCalls, 0);
});

test('Firestore transactions close the SDK read phase when synchronous writes register', async () => {
	let sdkReads = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => {
						sdkReads++;
						return { exists: false };
					},
					create: () => undefined,
					set: () => undefined,
					delete: () => undefined
				})
		}
	});

	const outcomes = await adapter.transaction!(async (tx) => {
		const create = tx.create(meta, 1, { id: 1, handle: 'created' });
		const sameDocumentRead = tx.get(meta, 1);
		const otherDocumentRead = tx.get(meta, 2);
		return Promise.allSettled([create, sameDocumentRead, otherDocumentRead]);
	});

	assert.equal(sdkReads, 0);
	assert.equal(outcomes[0].status, 'fulfilled');
	assert.deepEqual(outcomes[1], {
		status: 'fulfilled',
		value: { id: 1, handle: 'created' }
	});
	assert.equal(outcomes[2].status, 'rejected');
	if (outcomes[2].status === 'rejected') {
		assert.ok(outcomes[2].reason instanceof ActiveTsConfigurationError);
		assert.match(String(outcomes[2].reason), /cannot read unbuffered documents after writes/);
	}
});

test('Firestore transactions release same-document mutation tails after rejected writes', async () => {
	const writes: string[] = [];
	let markFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	let releaseFirst!: () => void;
	const holdFirst = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
				callback({
					get: async () => ({ exists: false }),
					create: async (_ref: unknown, data: GoogleRegressionData) => {
						writes.push(data.handle);
						if (data.handle === 'first') {
							markFirstStarted();
							await holdFirst;
							throw new Error('first write failed');
						}
					},
					set: async () => undefined,
					delete: async () => undefined
				})
		}
	});

	const outcomes = await adapter.transaction!(async (tx) => {
		const first = tx.create(meta, 1, { id: 1, handle: 'first' });
		await firstStarted;
		const second = tx.create(meta, 1, { id: 1, handle: 'second' });
		releaseFirst();
		return Promise.allSettled([first, second]);
	});

	assert.deepEqual(writes, ['first', 'second']);
	assert.equal(outcomes[0].status, 'rejected');
	assert.equal(outcomes[1].status, 'fulfilled');
});

test('Firestore context transactions route model writes through SDK transactions', async () => {
	const calls: string[] = [];
	const stored = new Map<string, Record<string, unknown>>();
	const firestore = await createFirestoreStoreAdapter({
		client: {
			collection: (name: string) => ({
				doc: (id: string) => ({ name, id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				calls.push('runTransaction');
				return await callback({
					get: async (ref: { id: string }) => {
						calls.push(`tx.get:${ref.id}`);
						const data = stored.get(ref.id);
						return { exists: data !== undefined, id: ref.id, data: () => data };
					},
					create: async (ref: { id: string }, data: Record<string, unknown>) => {
						calls.push(`tx.create:${ref.id}`);
						stored.set(ref.id, data);
					},
					set: async (ref: { id: string }, data: Record<string, unknown>) => {
						calls.push(`tx.set:${ref.id}`);
						stored.set(ref.id, data);
					},
					delete: async (ref: { id: string }) => {
						calls.push(`tx.delete:${ref.id}`);
						stored.delete(ref.id);
					}
				});
			}
		}
	});
	const context = createActiveTs({ stores: { default: firestore } });

	await context.transaction(async (tx) => {
		const TxRecord = DatastoreTransactionRecord.use(tx) as unknown as typeof DatastoreTransactionRecord;
		await TxRecord.create({ id: 2, handle: 'firestore-tx' });
		assert.equal((await TxRecord.find(2).load())?.data.handle, 'firestore-tx');
	});

	assert.deepEqual(calls, ['runTransaction', 'tx.create:number:2']);
	assert.deepEqual(stored.get('number:2'), { id: 2, handle: 'firestore-tx' });
});

test('Firestore model upsertMany reuses preflight point reads before multiple writes', async () => {
	const calls: string[] = [];
	const stored = new Map<string, Record<string, unknown>>([
		['number:21', { id: 21, handle: 'old-one' }],
		['number:22', { id: 22, handle: 'old-two' }]
	]);
	const firestore = await createFirestoreStoreAdapter({
		client: {
			collection: (name: string) => ({
				doc: (id: string) => ({ name, id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				calls.push('runTransaction');
				return await callback({
					get: async (ref: { id: string }) => {
						calls.push(`tx.get:${ref.id}`);
						const data = stored.get(ref.id);
						return { exists: data !== undefined, id: ref.id, data: () => data };
					},
					create: async (ref: { id: string }, data: Record<string, unknown>) => {
						calls.push(`tx.create:${ref.id}`);
						stored.set(ref.id, data);
					},
					set: async (ref: { id: string }, data: Record<string, unknown>) => {
						calls.push(`tx.set:${ref.id}`);
						stored.set(ref.id, data);
					},
					delete: async (ref: { id: string }) => {
						calls.push(`tx.delete:${ref.id}`);
						stored.delete(ref.id);
					}
				});
			}
		}
	});
	const context = createActiveTs({ stores: { default: firestore } });
	const Record = DatastoreTransactionRecord.use(context) as unknown as typeof DatastoreTransactionRecord;

	const results = await Record.upsertMany([
		{ id: 21, handle: 'new-one' },
		{ id: 22, handle: 'new-two' },
		{ id: 23, handle: 'created' }
	]);

	assert.deepEqual(results.map((result) => result.operation), ['update', 'update', 'create']);
	assert.deepEqual(calls, [
		'runTransaction',
		'tx.get:number:21',
		'tx.get:number:22',
		'tx.get:number:23',
		'tx.set:number:21',
		'tx.set:number:22',
		'tx.create:number:23'
	]);
	assert.deepEqual(stored.get('number:21'), { id: 21, handle: 'new-one' });
	assert.deepEqual(stored.get('number:22'), { id: 22, handle: 'new-two' });
	assert.deepEqual(stored.get('number:23'), { id: 23, handle: 'created' });
});

test('Firestore transactions reject unsupported portable options and unsafe reads after writes', async () => {
	let transactionCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id }),
				where() {
					return this;
				},
				orderBy() {
					return this;
				},
				limit() {
					return this;
				}
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				transactionCalls++;
				return await callback({
					get: async () => {
						throw new Error('Firestore transaction SDK read should not run after writes');
					},
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				});
			}
		}
	});

	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { isolation: 'serializable' }),
		/Firestore transaction options\.isolation is not supported/
	);
	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { timeoutMs: 100 }),
		/Firestore transaction options\.timeoutMs is not supported/
	);
	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { native: { vendor: true } }),
		/Firestore transaction options\.native contains unknown option "vendor"/
	);
	assert.equal(transactionCalls, 0);

	await assert.rejects(
		() =>
			adapter.transaction!(async (tx) => {
				await tx.create(meta, 3, { id: 3, handle: 'dirty' });
				await tx.query(meta, { where: [], or: [], sort: [], include: [] });
			}),
		/cannot read unbuffered documents after writes/
	);
	assert.equal(transactionCalls, 1);

	await assert.rejects(
		() =>
			adapter.transaction!(
				async (tx) => {
					await tx.create(meta, 4, { id: 4, handle: 'read-only' });
				},
				{ readOnly: true }
			),
		/Firestore transaction is read-only/
	);
	assert.equal(transactionCalls, 2);
});

test('Firestore transactions pass safe native SDK options and map commit create conflicts', async () => {
	const receivedOptions: unknown[] = [];
	const nativeOptions = { maxAttempts: 3 };
	let sdkWriteCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>, options?: unknown) => {
				receivedOptions[receivedOptions.length] = options;
				nativeOptions.maxAttempts = 9;
				return await callback({
					get: async (ref: { id: string }) => ({ exists: false, id: ref.id }),
					create: async () => {
						sdkWriteCalls++;
					},
					set: async () => {
						sdkWriteCalls++;
					},
					delete: async () => {
						sdkWriteCalls++;
					}
				});
			}
		}
	});

	await adapter.transaction!(
		async () => 'native-options',
		{ native: nativeOptions }
	);
	assert.deepEqual(receivedOptions.map((options) => JSON.parse(JSON.stringify(options))), [
		{ maxAttempts: 3 }
	]);

	await adapter.transaction!(
		async (tx) => {
			assert.equal(await tx.get(meta, 5), null);
		},
		{ readOnly: true, native: { readTime: 'snapshot-token' } }
	);
	assert.deepEqual(receivedOptions.map((options) => JSON.parse(JSON.stringify(options))), [
		{ maxAttempts: 3 },
		{ readTime: 'snapshot-token', readOnly: true }
	]);
	await assert.rejects(
		() => adapter.transaction!(async (tx) => {
			await tx.create(meta, 55, { id: 55, handle: 'native-read-only' });
		}, { native: { readOnly: true } }),
		/Firestore transaction is read-only/
	);
	assert.equal(sdkWriteCalls, 0);
	assert.deepEqual(receivedOptions.map((options) => JSON.parse(JSON.stringify(options))), [
		{ maxAttempts: 3 },
		{ readTime: 'snapshot-token', readOnly: true },
		{ readOnly: true }
	]);

	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { native: { maxAttempts: 0 } }),
		/Firestore transaction options\.native\.maxAttempts must be a positive integer/
	);
	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { native: { readTime: 'snapshot-token' } }),
		/Firestore transaction options\.native\.readTime requires readOnly: true/
	);
	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { readOnly: true, native: { readOnly: false } }),
		/Firestore transaction options\.readOnly conflicts with options\.native\.readOnly/
	);

	const conflictAdapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				await callback({
					get: async (ref: { id: string }) => ({ exists: false, id: ref.id }),
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				});
				throw Object.assign(new Error('commit already exists'), { code: 6 });
			}
		}
	});
	await assert.rejects(
		() => conflictAdapter.transaction!(async (tx) => {
			await tx.create(meta, 6, { id: 6, handle: 'conflict' });
		}),
		ActiveTsConflictError
	);

	const userError = Object.assign(new Error('user already-exists shaped error'), { code: 6 });
	await assert.rejects(
		() => conflictAdapter.transaction!(async () => {
			throw userError;
		}),
		(error: unknown) => error === userError
	);
});

test('Firestore commit transport failures report unknown outcomes without rollback callbacks', async () => {
	const deferred: string[] = [];
	const commitError = Object.assign(new Error('connection lost while committing Firestore transaction'), { code: 14 });
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				await callback({
					get: async () => ({ exists: false }),
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				});
				throw commitError;
			}
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await tx.afterCommit(() => {
					deferred.push('commit');
				});
				await tx.afterRollback(() => {
					deferred.push('rollback');
				});
				const TxRecord = DatastoreTransactionRecord.use(tx) as unknown as typeof DatastoreTransactionRecord;
				await TxRecord.create({ id: 61, handle: 'unknown-outcome' });
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsConfigurationError);
			assert.match(error.message, /Firestore transaction commit outcome is unknown.*connection lost/);
			assert.equal(error.cause, commitError);
			return true;
		}
	);
	assert.deepEqual(deferred, []);
});

test('Firestore code-less post-callback failures retain rollback semantics', async () => {
	const deferred: string[] = [];
	const localError = new Error('local Firestore transaction finalization failed');
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				await callback({
					get: async () => ({ exists: false }),
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				});
				throw localError;
			}
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await tx.afterRollback(() => {
					deferred.push('rollback');
				});
			}),
		(error: unknown) => error === localError
	);
	assert.deepEqual(deferred, ['rollback']);
});

test('Firestore completed write attempts stop opaque SDK callback retries as unknown', async () => {
	const deferred: string[] = [];
	let callbackCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				const transaction = {
					get: async () => ({ exists: false }),
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				};
				await callback(transaction);
				return await callback(transaction);
			}
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				callbackCalls++;
				await tx.afterRollback(() => {
					deferred.push('rollback');
				});
				const TxRecord = DatastoreTransactionRecord.use(tx) as unknown as typeof DatastoreTransactionRecord;
				await TxRecord.create({ id: 63, handle: 'opaque-retry' });
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsConfigurationError);
			assert.match(error.message, /write outcome is unknown because the Firestore SDK retried/);
			return true;
		}
	);
	assert.equal(callbackCalls, 1);
	assert.deepEqual(deferred, []);
});

test('Firestore aborted commits retain definitive rollback callbacks', async () => {
	const deferred: string[] = [];
	const abortError = Object.assign(new Error('Firestore transaction aborted'), { code: 10 });
	const adapter = await createFirestoreStoreAdapter({
		client: {
			collection: () => ({
				doc: (id: string) => ({ id })
			}),
			getAll: async () => [],
			runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
				await callback({
					get: async () => ({ exists: false }),
					create: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined
				});
				throw abortError;
			}
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await tx.afterCommit(() => {
					deferred.push('commit');
				});
				await tx.afterRollback(() => {
					deferred.push('rollback');
				});
				const TxRecord = DatastoreTransactionRecord.use(tx) as unknown as typeof DatastoreTransactionRecord;
				await TxRecord.create({ id: 62, handle: 'aborted' });
			}),
		(error: unknown) => error === abortError
	);
	assert.deepEqual(deferred, ['rollback']);
});

test('Firestore adapter injected clients require transaction support at construction', async () => {
	let updateCalls = 0;

	await assert.rejects(
		() =>
			createFirestoreStoreAdapter({
				client: {
					collection: () => ({
						doc: () => ({
							update: async () => {
								updateCalls++;
							}
						})
					}),
					getAll: async () => []
				}
			}),
		/Firestore adapter client\.runTransaction must be a function/
	);
	assert.equal(updateCalls, 0);
});

test('Datastore adapter maps SDK insert and update errors to active-ts errors', async () => {
	const duplicateAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			insert: async () => {
				throw Object.assign(new Error('already exists'), { code: 6 });
			}
		})
	});
	await assert.rejects(
		() => duplicateAdapter.create(meta, 1, { id: 1, handle: 'duplicate' }),
		ActiveTsConflictError
	);

	const missingAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			update: async () => {
				throw Object.assign(new Error('not found'), { code: 5 });
			}
		})
	});
	await assert.rejects(
		() => missingAdapter.update(meta, 1, { id: 1, handle: 'missing' }),
		ActiveTsNotFoundError
	);

	let codeGetterCalls = 0;
	const accessorError = Object.defineProperty(new Error('accessor datastore code'), 'code', {
		enumerable: true,
		get() {
			codeGetterCalls++;
			return 6;
		}
	});
	const accessorAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			insert: async () => {
				throw accessorError;
			}
		})
	});
	await assert.rejects(
		() => accessorAdapter.create(meta, 1, { id: 1, handle: 'accessor' }),
		/accessor datastore code/
	);
	assert.equal(codeGetterCalls, 0);
});

test('Datastore adapter injected clients require update support at construction', async () => {
	let saveCalls = 0;

	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: {
					key: (input: unknown) => input,
					get: async () => [{ id: 1, handle: 'stale' }],
					save: async () => {
						saveCalls++;
					},
					delete: async () => undefined,
					createQuery: () => ({}),
					runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
				}
			}),
		/Datastore adapter client\.update must be a function/
	);
	assert.equal(saveCalls, 0);
});

test('Datastore adapter injected clients do not require unused save support', async () => {
	const adapter = await createDatastoreStoreAdapter({
		client: {
			key: (input: unknown) => input,
			get: async () => [null],
			delete: async () => undefined,
			update: async () => undefined,
			createQuery: () => ({
				filter() {
					return this;
				}
			}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		}
	});

	assert.equal(await adapter.get(meta, 1), null);
});


test('Google store adapters reject sparse getMany ids and backend arrays', async () => {
	const firestoreAdapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({})
			}),
			getAll: async () => new Array(1)
		})
	});
	await assert.rejects(() => firestoreAdapter.getMany(meta, new Array(1) as any), /Firestore store ids\[0\] is missing/);
	await assert.rejects(() => firestoreAdapter.getMany(meta, [1]), /Firestore getAll result\[0\] is missing/);
	const shortFirestoreAdapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({})
			}),
			getAll: async () => []
		})
	});
	await assert.rejects(() => shortFirestoreAdapter.getMany(meta, [1]), /Firestore getAll result must contain 1 entries/);

	const datastoreAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => [new Array(1)],
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(() => datastoreAdapter.getMany(meta, new Array(1) as any), /Datastore store ids\[0\] is missing/);
	await assert.rejects(() => datastoreAdapter.getMany(meta, [1]), /Datastore getMany result\[0\] is missing/);
});

test('Firestore adapter rejects inherited snapshot result fields', async () => {
	let docSnapshot: unknown = {};
	const client = {
		collection: () => ({
			doc: () => ({
				get: async () => docSnapshot
			}),
			get: async () => ({})
		}),
		getAll: async () => [{}],
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({
				get: async () => ({ exists: false }),
				set: async () => undefined
			})
	};
	const adapter = await createFirestoreStoreAdapter({ client });
	Object.defineProperties(Object.prototype, {
		exists: { value: true, configurable: true },
		data: { value: () => ({ id: 99, handle: 'polluted' }), configurable: true },
		docs: { value: [], configurable: true },
		size: { value: 0, configurable: true }
	});
	try {
		await assert.rejects(() => adapter.get(meta, 1), /Firestore document snapshot\.exists/);
		await assert.rejects(() => adapter.getMany(meta, [1]), /Firestore document snapshot\.exists/);
		docSnapshot = { exists: true };
		await assert.rejects(() => adapter.get(meta, 1), /Firestore document snapshot\.data/);
		await assert.rejects(
			() =>
				adapter.query(meta, {
					where: [],
					or: [],
					sort: [],
					include: []
				}),
			/Firestore query snapshot\.docs/
		);
		const sparseAdapter = await createFirestoreStoreAdapter({
			client: firestoreClient({
				collection: () => ({
					doc: () => ({
						get: async () => ({ exists: false })
					}),
					get: async () => ({ docs: new Array(1), size: 1 })
				}),
				getAll: async () => []
			})
		});
		await assert.rejects(
			() =>
				sparseAdapter.query(meta, {
					where: [],
					or: [],
					sort: [],
					include: []
				}),
			/Firestore query snapshot\.docs\[0\] is missing/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).exists;
		delete (Object.prototype as Record<string, unknown>).data;
		delete (Object.prototype as Record<string, unknown>).docs;
		delete (Object.prototype as Record<string, unknown>).size;
	}
	});

	test('Firestore adapter accepts SDK snapshot prototype accessors', async () => {
		class DocumentSnapshot {
			constructor(private readonly row: any, private readonly storageId = 'number:1') {}
			get exists() {
				return true;
			}
			get id() {
				return this.storageId;
			}
			data() {
				return this.row;
			}
		}
		class QuerySnapshot {
			get docs() {
				return [new DocumentSnapshot({ id: 1, handle: 'sdk-query' })];
			}
		}
		const adapter = await createFirestoreStoreAdapter({
			client: firestoreClient({
				collection: () => ({
					doc: () => ({
						get: async () => new DocumentSnapshot({ id: 1, handle: 'sdk-get' })
					}),
					get: async () => new QuerySnapshot()
				}),
				getAll: async () => [new DocumentSnapshot({ id: 1, handle: 'sdk-many' })]
			})
		});

		assert.deepEqual(await adapter.get(meta, 1), { id: 1, handle: 'sdk-get' });
		assert.deepEqual(await adapter.getMany(meta, [1]), [{ id: 1, handle: 'sdk-many' }]);
		assert.deepEqual(
			await adapter.query(meta, { where: [], or: [], sort: [], include: [] }),
			{ list: [{ id: 1, handle: 'sdk-query' }], count: 1, more: false }
		);
	});

	test('Firestore adapter rejects own accessor snapshot fields without invoking them', async () => {
		let getterCalls = 0;
		let docSnapshot: any = Object.defineProperty({}, 'exists', {
		enumerable: true,
		get() {
			getterCalls++;
			return true;
		}
	});
	let querySnapshot: any = { docs: [], size: 0 };
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({
					get: async () => docSnapshot
				}),
				get: async () => querySnapshot
			}),
			getAll: async () => [docSnapshot]
		})
	});

	await assert.rejects(
		() => adapter.get(meta, 1),
		/Firestore document snapshot\.exists must be a data property/
	);
	await assert.rejects(
		() => adapter.getMany(meta, [1]),
		/Firestore document snapshot\.exists must be a data property/
	);
	assert.equal(getterCalls, 0);

	querySnapshot = Object.defineProperty({}, 'docs', {
		enumerable: true,
		get() {
			getterCalls++;
			return [];
		}
	});
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query snapshot\.docs must be a data property/
	);
	assert.equal(getterCalls, 0);

	docSnapshot = {
		exists: true,
		data: () => ({ id: 1, handle: 'safe' })
	};
	Object.defineProperty(docSnapshot, 'id', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'number:1';
		}
	});
	await assert.rejects(
		() => adapter.get(meta, 1),
		/Firestore document snapshot\.id must be a data property/
	);
	querySnapshot = { docs: [docSnapshot], size: 1 };
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query document\.id must be a data property/
	);
	assert.equal(getterCalls, 0);
});

test('Firestore adapter rejects inherited accessor snapshot fields without invoking them', async () => {
	let getterCalls = 0;
	const existsPrototype = Object.defineProperty({}, 'exists', {
		enumerable: true,
		get() {
			getterCalls++;
			return true;
		}
	});
	let docSnapshot: any = Object.create(existsPrototype);
	let querySnapshot: any = { docs: [], size: 0 };
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({
					get: async () => docSnapshot
				}),
				get: async () => querySnapshot
			}),
			getAll: async () => [docSnapshot]
		})
	});

	await assert.rejects(
		() => adapter.get(meta, 1),
		/Firestore document snapshot\.exists must be a data property/
	);
	await assert.rejects(
		() => adapter.getMany(meta, [1]),
		/Firestore document snapshot\.exists must be a data property/
	);
	assert.equal(getterCalls, 0);

	const docsPrototype = Object.defineProperty({}, 'docs', {
		enumerable: true,
		get() {
			getterCalls++;
			return [];
		}
	});
	querySnapshot = Object.create(docsPrototype);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query snapshot\.docs must be a data property/
	);
	assert.equal(getterCalls, 0);

	const idPrototype = Object.defineProperty({}, 'id', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'number:1';
		}
	});
	docSnapshot = Object.assign(Object.create(idPrototype), {
		exists: true,
		data: () => ({ id: 1, handle: 'safe' })
	});
	await assert.rejects(
		() => adapter.get(meta, 1),
		/Firestore document snapshot\.id must be a data property/
	);
	querySnapshot = { docs: [docSnapshot], size: 1 };
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query document\.id must be a data property/
	);
	assert.equal(getterCalls, 0);
});

test('Firestore adapter validates direct document data before returning it', async () => {
	let row: any = { id: 1, handle: 'safe' };
	const document = {
		exists: true,
		id: 'number:1',
		data: () => row
	};
	const docRef = {
		get: async () => document
	};
	let getAllSnaps: any[] = [document];
	let queryDocs: any[] = [document];
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => docRef,
				get: async () => ({ docs: queryDocs, size: queryDocs.length })
			}),
			getAll: async () => getAllSnaps
		})
	});

	assert.deepEqual(await adapter.get(meta, 1), { id: 1, handle: 'safe' });
	row = { id: 2, handle: 'wrong-id' };
	await assert.rejects(() => adapter.get(meta, 1), /Firestore get document data id field "id" must match/);
	await assert.rejects(() => adapter.getMany(meta, [1]), /Firestore getAll result\[0\] data id field "id" must match/);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query document data id field "id" must match/
	);
	row = { id: 1, handle: 'unsafe', __unsafe: true };
	await assert.rejects(() => adapter.get(meta, 1), /Reserved data key/);
	await assert.rejects(() => adapter.getMany(meta, [1]), /Reserved data key/);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Reserved data key/
	);

	row = { id: 1, handle: 'safe' };
	getAllSnaps = [document];
	let getAllMapCalls = 0;
	Object.defineProperty(getAllSnaps, 'map', {
		value() {
			getAllMapCalls++;
			throw new Error('custom Firestore getAll result.map should not run');
		}
	});
	assert.deepEqual(await adapter.getMany(meta, [1]), [{ id: 1, handle: 'safe' }]);
	assert.equal(getAllMapCalls, 0);

	const duplicateDocument = {
		exists: true,
		id: 'number:1',
		data: () => ({ id: 1, handle: 'deduped' })
	};
	const firestoreDocIds: string[] = [];
	let getAllRefs: unknown[] = [];
	const duplicateInputAdapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: (id: string) => {
					firestoreDocIds.push(id);
					return { id };
				}
			}),
			getAll: async (...refs: unknown[]) => {
				getAllRefs = refs;
				return [duplicateDocument];
			}
		})
	});
	const duplicateFirestoreRows = await duplicateInputAdapter.getMany(meta, [1, 1]);
	assert.deepEqual(duplicateFirestoreRows, [
		{ id: 1, handle: 'deduped' },
		{ id: 1, handle: 'deduped' }
	]);
	assert.notEqual(duplicateFirestoreRows[0], duplicateFirestoreRows[1]);
	assert.deepEqual(firestoreDocIds, ['number:1']);
	assert.equal(getAllRefs.length, 1);

	queryDocs = [document];
	let docsMapCalls = 0;
	Object.defineProperty(queryDocs, 'map', {
		value() {
			docsMapCalls++;
			throw new Error('custom Firestore query docs.map should not run');
		}
	});
	assert.deepEqual(
		await adapter.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: []
		}),
		{ list: [{ id: 1, handle: 'safe' }], more: false, count: 1 }
	);
	assert.equal(docsMapCalls, 0);
});

test('Firestore adapter validates storage ids on returned documents when present', async () => {
	let document: any = {
		exists: true,
		id: 'number:2',
		data: () => ({ id: 1, handle: 'wrong-storage-id' })
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({
					get: async () => document
				}),
				get: async () => ({ docs: [document], size: 1 })
			}),
			getAll: async () => [document]
		})
	});

	await assert.rejects(() => adapter.get(meta, 1), /Firestore document snapshot\.id must match the requested id/);
	await assert.rejects(() => adapter.getMany(meta, [1]), /Firestore getAll result\[0\]\.id must match the requested id/);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query document data id field "id" must match/
	);

	document = {
		exists: true,
		id: 'boolean:true',
		data: () => ({ id: 'boolean:true', handle: 'noncanonical-storage-id' })
	};
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query document\.id must be a canonical active-ts entity id key/
	);

	document = {
		exists: true,
		id: 'number:1',
		data: () => ({ id: 1, handle: 'matched-storage-id' })
	};
	assert.deepEqual(await adapter.get(meta, 1), { id: 1, handle: 'matched-storage-id' });
	assert.deepEqual(await adapter.getMany(meta, [1]), [{ id: 1, handle: 'matched-storage-id' }]);
	assert.deepEqual(
		await adapter.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: []
		}),
		{ list: [{ id: 1, handle: 'matched-storage-id' }], more: false, count: 1 }
	);

	document = {
		exists: true,
		id: `active-ts-id:${Buffer.from('string:tenant/1', 'utf8').toString('base64url')}`,
		data: () => ({ id: 'tenant/1', handle: 'slash-storage-id' })
	};
	assert.deepEqual(await adapter.get(meta, 'tenant/1'), { id: 'tenant/1', handle: 'slash-storage-id' });
});

test('Firestore adapter rejects query documents without storage or data ids', async () => {
	const document = {
		data: () => ({ handle: 'missing-id' })
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				select() {
					return this;
				},
				get: async () => ({ docs: [document], size: 1 })
			}),
			getAll: async () => []
		}),
		allowAggregateScanFallback: true
	});

	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query document data is missing id field "id"/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
			}),
		/Firestore query document data is missing id field "id"/
	);
});

test('Firestore aggregate fallbacks validate storage ids on returned documents', async () => {
	let document: any = {
		id: 'number:2',
		data: () => ({ id: 1, handle: 'wrong-storage-id', score: 10 })
	};
	const fallbackQuery = {
		select() {
			return this;
		},
		get: async () => ({ docs: [document], size: 1 })
	};
	const fallbackAdapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				...fallbackQuery
			}),
			getAll: async () => []
		}),
		allowAggregateScanFallback: true
	});
	await assert.rejects(
		() =>
			fallbackAdapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
			}),
		/Firestore query document data id field "id" must match/
	);

	const minMaxQuery = {
		where() {
			return this;
		},
		orderBy() {
			return this;
		},
		limit() {
			return this;
		},
		select() {
			return this;
		},
		get: async () => ({ docs: [document], size: 1 })
	};
	const minMaxAdapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				...minMaxQuery
			}),
			getAll: async () => []
		}),
		allowAggregateScanFallback: true
	});
	await assert.rejects(
		() =>
			minMaxAdapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'max', field: 'score', as: 'highest' }]
			}),
		/Firestore query document data id field "id" must match/
	);

	document = {
		id: 'number:1',
		data: () => ({ id: 1, handle: 'matched-storage-id', score: 10 })
	};
	assert.deepEqual(
		await fallbackAdapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		}),
		{ total: 10 }
	);
	assert.deepEqual(
		await minMaxAdapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'max', field: 'score', as: 'highest' }]
		}),
		{ highest: 10 }
	);
});

test('Firestore fallback aggregates include id field in selected documents', async () => {
	let selectedFields: string[] | undefined;
	const fullDocument = { id: 1, handle: 'matched-storage-id', score: 10 };
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				select(...fields: string[]) {
					selectedFields = fields;
					return this;
				},
				get: async () => ({
					docs: [
						{
							id: 'number:1',
							data: () => {
								const fields = selectedFields ?? Object.keys(fullDocument);
								return Object.fromEntries(fields.map((field) => [field, fullDocument[field as keyof typeof fullDocument]]));
							}
						}
					],
					size: 1
				})
			}),
			getAll: async () => []
		}),
		allowAggregateScanFallback: true
	});

	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		}),
		{ total: 10 }
	);
	assert.deepEqual(selectedFields, ['id', 'score']);
});

test('Firestore numeric aggregates use SDK aggregate helpers when available', async () => {
	let aggregateSpec: Record<string, unknown> | undefined;
	let sumCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				aggregate: (spec: Record<string, unknown>) => {
					aggregateSpec = spec;
					return {
						get: async () => ({
							data: () => ({ total: 10 })
						})
					};
				}
			}),
			getAll: async () => []
		}),
		aggregateField: {
			count: () => ({ type: 'count' }),
			sum: (field: string) => {
				sumCalls++;
				return { type: 'sum', field };
			},
			average: () => ({ type: 'average' })
		}
	});

	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
		aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		}),
		{ total: 10 }
	);
	assert.equal(sumCalls, 1);
	assert.deepEqual(aggregateSpec, { total: { type: 'sum', field: 'score' } });
});

test('Firestore aggregate scan fallback is disabled unless explicitly opted in', async () => {
	let selectCalls = 0;
	let getCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				select() {
					selectCalls++;
					return this;
				},
				get: async () => {
					getCalls++;
					return { docs: [], size: 0 };
				}
			}),
			getAll: async () => []
		})
	});

	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
			}),
		/Firestore aggregate scan fallback requires allowAggregateScanFallback: true/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'max', field: 'score', as: 'highest' }]
			}),
		/Firestore aggregate scan fallback requires allowAggregateScanFallback: true/
	);
	assert.equal(selectCalls, 0);
	assert.equal(getCalls, 0);
});

test('Firestore adapter normalizes direct query count to returned documents', async () => {
	const document = {
		data: () => ({ id: 1, handle: 'one' })
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				get: async () => ({ docs: [document], size: 99 })
			}),
			getAll: async () => []
		})
	});

	const result = await adapter.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(result, {
		list: [{ id: 1, handle: 'one' }],
		more: false,
		count: 1
	});
});

test('Firestore limited direct queries report more with lookahead rows without cursor support', async () => {
	const calls: string[] = [];
	const firstDocument = { data: () => ({ id: 1, handle: 'one' }) };
	const secondDocument = { data: () => ({ id: 2, handle: 'two' }) };
	const query = {
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		},
		get: async () => ({ docs: [firstDocument, secondDocument], size: 2 })
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => query,
			getAll: async () => []
		})
	});

	const result = await adapter.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		limit: 1
	});
	assert.deepEqual(result.list, [{ id: 1, handle: 'one' }]);
	assert.equal(result.count, 1);
	assert.equal(result.more, true);
	assert.equal(result.cursor, undefined);
	assert.deepEqual(calls, ['limit:2']);
});

test('Firestore offset queries map to SDK offset before limit lookahead', async () => {
	const calls: string[] = [];
	const document = { data: () => ({ id: 3, handle: 'three' }) };
	const query = {
		offset(value: number) {
			calls.push(`offset:${value}`);
			return this;
		},
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		},
		get: async () => ({ docs: [document], size: 1 })
	};
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => query,
			getAll: async () => []
		})
	});

	const result = await adapter.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		offset: 2,
		limit: 1
	});
	assert.equal(adapter.capabilities?.offset, true);
	assert.deepEqual(result.list, [{ id: 3, handle: 'three' }]);
	assert.deepEqual(calls, ['offset:2', 'limit:2']);
});

test('Firestore adapter validates optimized aggregate result containers', async () => {
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({ get: async () => ({ exists: false }) }),
				aggregate: () => ({
					get: async () => ({
						data: () => null
					})
				})
			}),
			getAll: async () => []
		}),
		aggregateField: {
			count: () => ({ type: 'count' }),
			sum: () => ({ type: 'sum' }),
			average: () => ({ type: 'average' })
		}
	});

	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/Firestore aggregate result must be a plain object/
	);
});

test('Firestore adapter rejects unsafe collection names before client access', async () => {
	let collectionCalls = 0;
	const adapter = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => {
				collectionCalls++;
				return { doc: () => ({ get: async () => ({ exists: false }) }) };
			},
			getAll: async () => []
		})
	});
	await assert.rejects(
		() => adapter.get({ ...meta, name: 'bad\0collection' }, 1),
		/Firestore model metadata\.name/
	);
	await assert.rejects(
		() => adapter.get({ ...meta, name: '__reserved' }, 1),
		/Firestore model metadata\.name/
	);
	assert.equal(collectionCalls, 0);
});

test('Datastore adapter rejects inherited client and query methods', async () => {
	const hiddenDatastoreClient = Object.defineProperty(
		{
			get: async () => [null],
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		},
		'key',
		{
			enumerable: false,
			value: (input: unknown) => input
		}
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: hiddenDatastoreClient } as any),
		/Datastore adapter client\.key must be enumerable/
	);

	Object.defineProperties(Object.prototype, {
		key: { value: (input: unknown) => input, configurable: true },
		get: { value: async () => [null], configurable: true },
		createQuery: { value: () => ({}), configurable: true },
		runQuery: { value: async () => [[], { moreResults: 'NO_MORE_RESULTS' }], configurable: true },
		filter: { value: () => ({}), configurable: true }
	});
	try {
		await assert.rejects(
			() => createDatastoreStoreAdapter({ client: {} } as any),
			/Datastore adapter client\.key must be a function/
		);
		const adapter = await createDatastoreStoreAdapter({
			client: datastoreClient({
				key: (input: unknown) => input,
				createQuery: () => ({}),
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
			})
		});
		await assert.rejects(
			() =>
				adapter.query(meta, {
					where: [{ field: 'handle', op: '=', value: 'one' }],
					or: [],
					sort: [],
					include: []
				}),
			/Datastore query\.filter must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).key;
		delete (Object.prototype as Record<string, unknown>).get;
		delete (Object.prototype as Record<string, unknown>).createQuery;
		delete (Object.prototype as Record<string, unknown>).runQuery;
		delete (Object.prototype as Record<string, unknown>).filter;
	}
});

test('Datastore adapter snapshots client methods at creation', async () => {
	const calls: string[] = [];
	const query = {
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		}
	};
	const client = {
		key: (input: any) => {
			calls.push(`key:${input.path.join('/')}`);
			return input;
		},
		get: async () => {
			calls.push('get');
			return [null];
		},
		save: async () => {
			calls.push('save');
		},
		delete: async () => {
			calls.push('delete');
		},
		update: async () => {
			calls.push('update');
		},
		createQuery: (name: string) => {
			calls.push(`createQuery:${name}`);
			return query;
		},
		runQuery: async () => {
			calls.push('runQuery');
			return [[], { moreResults: 'NO_MORE_RESULTS' }];
		}
	};
	const adapter = await createDatastoreStoreAdapter({ client });
	client.key = () => {
		throw new Error('mutated datastore key should not run');
	};
	client.get = async () => {
		throw new Error('mutated datastore get should not run');
	};
	client.save = async () => {
		throw new Error('mutated datastore save should not run');
	};
	client.delete = async () => {
		throw new Error('mutated datastore delete should not run');
	};
	client.update = async () => {
		throw new Error('mutated datastore update should not run');
	};
	client.createQuery = () => {
		throw new Error('mutated datastore createQuery should not run');
	};
	client.runQuery = async () => {
		throw new Error('mutated datastore runQuery should not run');
	};

	assert.equal(await adapter.get(meta, 1), null);
	assert.deepEqual(
		await adapter.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			limit: 1
		}),
		{ list: [], more: false }
	);
	assert.deepEqual(calls, [
		'key:google_regression_record/number:1',
		'get',
		'createQuery:google_regression_record',
		'limit:1',
		'runQuery'
	]);
});

test('Datastore adapter ignores inherited query result metadata', async () => {
	Object.defineProperty(Object.prototype, 'moreResults', {
		value: 'MORE_RESULTS_AFTER_LIMIT',
		configurable: true
	});
	try {
		const adapter = await createDatastoreStoreAdapter({
			client: datastoreClient({
				key: (input: unknown) => input,
				createQuery: () => ({}),
				runQuery: async () => [[], {}]
			})
		});
		assert.deepEqual(
			await adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
			{ list: [], more: false }
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).moreResults;
	}
});

test('Datastore adapter rejects unknown moreResults values', async () => {
	const adapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'SOMETHING_ELSE' }]
		})
	});

	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore query info\.moreResults "SOMETHING_ELSE" is not supported/
	);
});

test('Datastore adapter rejects malformed query result lists', async () => {
	const nonArrayGetAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => ({}),
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(() => nonArrayGetAdapter.get(meta, 1), /Datastore get result must be an array/);

	const missingGetSlotAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => [],
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(() => missingGetSlotAdapter.get(meta, 1), /Datastore get result\[0\] is required/);

	const missingGetManySlotAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => [],
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(() => missingGetManySlotAdapter.getMany(meta, [1]), /Datastore getMany result\[0\] is required/);

	const nonArrayRunQueryAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			createQuery: () => ({}),
			runQuery: async () => ({})
		})
	});
	await assert.rejects(
		() =>
			nonArrayRunQueryAdapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore runQuery result must be an array/
	);

	const missingRunQueryListAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			createQuery: () => ({}),
			runQuery: async () => []
		})
	});
	await assert.rejects(
		() =>
			missingRunQueryListAdapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore runQuery result\[0\] is required/
	);

	const nonArrayAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			createQuery: () => ({}),
			runQuery: async () => [{ id: 1 }, { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() =>
			nonArrayAdapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore query result list must be an array/
	);

	const sparseAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			createQuery: () => ({}),
			runQuery: async () => [new Array(1), { moreResults: 'NO_MORE_RESULTS' }]
		})
	});
	await assert.rejects(
		() =>
			sparseAdapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore query result list\[0\] is missing/
	);
});

test('Datastore adapter validates returned entity ids', async () => {
	const keySymbol = Symbol('datastore-key');
	const mismatched = { id: 2, handle: 'wrong-id' };
	Object.defineProperty(mismatched, keySymbol, {
		value: { name: 'number:1' },
		enumerable: true
	});
	const missingId = { handle: 'missing-id' };
	const adapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async (input: unknown) => Array.isArray(input) ? [[mismatched]] : [mismatched],
			createQuery: () => ({}),
			runQuery: async () => [[missingId], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		keySymbol
	});

	await assert.rejects(() => adapter.get(meta, 1), /Datastore get entity id field "id" must match/);
	await assert.rejects(() => adapter.getMany(meta, [1]), /Datastore getMany entity id field "id" must match/);

	const unexpected = { id: 2, handle: 'unexpected' };
	Object.defineProperty(unexpected, keySymbol, {
		value: { name: 'number:2' },
		enumerable: true
	});
	const unexpectedAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async (input: unknown) => Array.isArray(input) ? [[unexpected]] : [null],
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		keySymbol
	});
	await assert.rejects(() => unexpectedAdapter.getMany(meta, [1]), /Datastore getMany entity id was not requested/);

	let batchKeys: unknown[] | undefined;
	const duplicateInputAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async (input: unknown) => {
				batchKeys = Array.isArray(input) ? input : undefined;
				return Array.isArray(input) ? [[{ id: 1, handle: 'one' }]] : [null];
			},
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		keySymbol
	});
	const duplicateDatastoreRows = await duplicateInputAdapter.getMany(meta, [1, 1]);
	assert.deepEqual(duplicateDatastoreRows, [
		{ id: 1, handle: 'one' },
		{ id: 1, handle: 'one' }
	]);
	assert.notEqual(duplicateDatastoreRows[0], duplicateDatastoreRows[1]);
	assert.equal(batchKeys?.length, 1);

	const duplicateAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async (input: unknown) => Array.isArray(input)
				? [[{ id: 1, handle: 'one' }, { id: 1, handle: 'again' }]]
				: [null],
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		keySymbol
	});
	await assert.rejects(() => duplicateAdapter.getMany(meta, [1]), /Datastore getMany returned duplicate entity ids/);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore query entity\[0\] is missing id field "id"/
	);

	const nullEntityAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			createQuery: () => ({}),
			runQuery: async () => [[null], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		keySymbol
	});
	await assert.rejects(
		() =>
			nullEntityAdapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Datastore query entity\[0\] must be an entity object/
	);
});

test('Datastore adapter snapshots backend result arrays before iteration', async () => {
	let getManyEntities: any[] = [{ id: 1, handle: 'one' }];
	let queryEntities: any[] = [{ id: 2, handle: 'two' }];
	const adapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async (input: unknown) => Array.isArray(input) ? [getManyEntities] : [null],
			createQuery: () => ({}),
			runQuery: async () => [queryEntities, { moreResults: 'NO_MORE_RESULTS' }]
		})
	});

	let iteratorCalls = 0;
	Object.defineProperty(getManyEntities, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom Datastore getMany iterator should not run');
		}
	});
	await assert.rejects(
		() => adapter.getMany(meta, [1]),
		/Datastore getMany result cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);

	queryEntities = [{ id: 2, handle: 'two' }];
	let mapCalls = 0;
	Object.defineProperty(queryEntities, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom Datastore query result list.map should not run');
		}
	});
	assert.deepEqual(
		await adapter.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: []
		}),
		{ list: [{ id: 2, handle: 'two' }], more: false }
	);
	assert.equal(mapCalls, 0);
});

test('Datastore adapter rejects accessor entity fields without invoking them', async () => {
	const keySymbol = Symbol('datastore-key');
	let getterCalls = 0;
	const accessorKeyEntity = { id: 1, handle: 'one' };
	Object.defineProperty(accessorKeyEntity, keySymbol, {
		enumerable: true,
		get() {
			getterCalls++;
			return { name: 'number:1' };
		}
	});
	const accessorDataEntity = { id: 1 };
	Object.defineProperty(accessorDataEntity, 'handle', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'one';
		}
	});
	const adapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => [accessorKeyEntity]
		}),
		keySymbol
	});
	await assert.rejects(() => adapter.get(meta, 1), /Datastore entity key must be a data property/);
	assert.equal(getterCalls, 0);

	const dataAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => [accessorDataEntity]
		}),
		keySymbol
	});
	await assert.rejects(() => dataAdapter.get(meta, 1), /Datastore entity data "handle" must be a data property/);
	assert.equal(getterCalls, 0);
});

test('Datastore adapter rejects hidden entity fields', async () => {
	const hiddenEntity = Object.defineProperty({ id: 1 }, 'handle', {
		enumerable: false,
		value: 'one'
	});
	const adapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => [hiddenEntity]
		})
	});

	await assert.rejects(() => adapter.get(meta, 1), /Datastore entity data "handle" must be enumerable/);
});

test('Datastore adapter ignores inherited entity key symbols', async () => {
	const keySymbol = Symbol('datastore-key');
	Object.defineProperty(Object.prototype, keySymbol, {
		value: { name: 'number:999' },
		configurable: true
	});
	try {
		const row = { id: 1, handle: 'one' };
		const adapter = await createDatastoreStoreAdapter({
			client: datastoreClient({
				key: (input: unknown) => input,
				get: async (input: unknown) => Array.isArray(input) ? [[row]] : [row]
			}),
			keySymbol
		});
		const loaded = await adapter.get(meta, 1);
		assert.deepEqual(loaded, row);
		assert.equal(Object.prototype.hasOwnProperty.call(loaded ?? {}, ACTIVE_TS_ENTITY_KEY), false);
		assert.deepEqual(await adapter.getMany(meta, [1]), [row]);
	} finally {
		delete (Object.prototype as any)[keySymbol];
	}
});

test('Datastore adapter validates entity key metadata shape and ids', async () => {
	const keySymbol = Symbol('datastore-key');
	const adapterForKey = async (key: unknown) =>
		createDatastoreStoreAdapter({
			client: datastoreClient({
				key: (input: unknown) => input,
				get: async () => [Object.defineProperty({ id: 1, handle: 'one' }, keySymbol, { value: key })]
			}),
			keySymbol
		});

	await assert.rejects(() => adapterForKey(null).then((adapter) => adapter.get(meta, 1)), /Datastore entity key must be an object/);
	await assert.rejects(
		() => adapterForKey({ name: '' }).then((adapter) => adapter.get(meta, 1)),
		/Encoded entity id "" cannot be an empty string/
	);
	await assert.rejects(
		() => adapterForKey({ name: 1 }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key name must be a string/
	);
	await assert.rejects(
		() => adapterForKey({ name: 'boolean:true' }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key name must be a canonical active-ts entity id key/
	);
	await assert.rejects(
		() => adapterForKey({ name: 'number:1', id: '2' }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key cannot contain both name and id/
	);
	await assert.rejects(
		() => adapterForKey({ id: '001' }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key id must be a canonical integer string/
	);
	await assert.rejects(
		() => adapterForKey({ id: '1.5' }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key id must be a canonical integer string/
	);
	await assert.rejects(
		() => adapterForKey({ name: 'number:1', namespace: '' }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key\.namespace must be a non-empty string/
	);
	assert.throws(
		() => datastoreAncestorFromEntityKey(
			{ path: [meta.name, 1], namespace: '' },
			meta.name,
			1,
			'Datastore raw-path entity key'
		),
		/Datastore raw-path entity key\.namespace must be a non-empty string/
	);
	let getterCalls = 0;
	const accessorKey = Object.defineProperty({}, 'name', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'number:1';
		}
	});
	await assert.rejects(
		() => adapterForKey(accessorKey).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key name must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenKey = Object.defineProperty({}, 'name', {
		enumerable: false,
		value: 'number:1'
	});
	await assert.rejects(
		() => adapterForKey(hiddenKey).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key name must be enumerable/
	);
	let pathGetterCalls = 0;
	const accessorPathKey = Object.defineProperty({}, 'path', {
		enumerable: true,
		get() {
			pathGetterCalls++;
			return ['google_regression_record', 1];
		}
	});
	await assert.rejects(
		() => adapterForKey(accessorPathKey).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key\.path must be a data property/
	);
	assert.equal(pathGetterCalls, 0);
	await assert.rejects(
		() => adapterForKey({ path: ['wrong_kind', 1] }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key\.path final kind must match Datastore model kind "google_regression_record"/
	);
	await assert.rejects(
		() => adapterForKey({ path: ['google_regression_record', 2] }).then((adapter) => adapter.get(meta, 1)),
		/Datastore entity key\.path final id must match the row id/
	);
	const rowWithWrongKindPath = Object.defineProperty({ id: 1, handle: 'one' }, keySymbol, {
		value: { path: ['wrong_kind', 1] }
	});
	const getManyAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			get: async () => [[rowWithWrongKindPath]]
		}),
		keySymbol
	});
	await assert.rejects(
		() => getManyAdapter.getMany(meta, [1]),
		/Datastore entity key\.path final kind must match Datastore model kind "google_regression_record"/
	);
	const rowWithWrongIdPath = Object.defineProperty({ id: 1, handle: 'one' }, keySymbol, {
		value: { path: ['google_regression_record', 2] }
	});
	const queryAdapter = await createDatastoreStoreAdapter({
		client: datastoreClient({
			key: (input: unknown) => input,
			runQuery: async () => [[rowWithWrongIdPath], { moreResults: 'NO_MORE_RESULTS' }]
		}),
		keySymbol
	});
	await assert.rejects(
		() => queryAdapter.query(meta, { where: [], or: [], sort: [], include: [] }),
		/Datastore entity key\.path final id must match the row id/
	);
});

test('Datastore model reads preserve symbol entity key metadata', async () => {
	const keySymbol = Symbol('datastore-key');
	const datastoreKey = { name: 'number:1' };
	const adapter = await createDatastoreStoreAdapter({
		keySymbol,
		client: datastoreClient({
			KEY: keySymbol,
			key: ({ path }: { path: unknown[] }) => ({ path }),
			get: async (input: unknown) => {
				const entity = Object.defineProperty({ id: 1, handle: 'model-key' }, keySymbol, {
					enumerable: false,
					value: datastoreKey
				});
				return Array.isArray(input) ? [[entity]] : [entity];
			}
		})
	});
	const context = createActiveTs({ stores: { default: adapter } });
	const Record = DatastoreEntityKeyRecord.use(context) as unknown as typeof DatastoreEntityKeyRecord;

	const loaded = await Record.find(1).load();
	assert.notEqual((loaded?.data as any)?.[ACTIVE_TS_ENTITY_KEY], datastoreKey);
	assert.deepEqual((loaded?.data as any)?.[ACTIVE_TS_ENTITY_KEY], datastoreKey);
	assert.equal(Object.prototype.propertyIsEnumerable.call(loaded?.data ?? {}, ACTIVE_TS_ENTITY_KEY), false);
});
