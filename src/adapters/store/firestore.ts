import { optionalImport } from '../../core/optional-import.js';
import {
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsValidationError,
	safeErrorMessage
} from '../../core/errors.js';
import { markTransactionRollbackSkipped, ownErrorValue } from '../../core/error-classification.js';
import {
	assertSafeEntityId,
	assertSafeEntityIdArray,
	assertSafeFieldPath,
	assertSafePhysicalIdentifierLength,
	assertSafeSchemaIdentifier,
	cloneSafeDataObject,
	clonePortableDataObject,
	defineDataProperty
} from '../../core/safe-keys.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { aggregateRows, assertAggregateSpecsCompatibleWithModel, normalizeAggregateRow } from '../../core/aggregate.js';
import { entityIdFromCanonicalKey, entityIdKey, limitWithLookahead, trimLookaheadRows } from '../../core/query-utils.js';
import {
	assertStoreDataHasModelId,
	assertStoreDataMatchesId,
	assertStorePlanSupported,
	createCloseGuardedStoreAdapter,
	normalizeStoreAggregatePlan,
	normalizeStoreAggregateResult,
	normalizeStoreQueryResultForModel,
	normalizeStoreQueryPlan,
	normalizeStoreTransactionOptions,
	rejectUnsupportedStoreReadOptions,
	rejectUnsupportedStoreWriteOptions,
	validateStoreQueryReadOptions
} from '../../core/store-options.js';
import { normalizeSchemaModels } from '../../core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../../core/schema-options.js';
import { snapshotAdapterModel } from '../../core/adapter-model.js';
import { normalizeAggregatePlanFieldTypes, normalizeQueryPlanFieldTypes } from '../../core/field-types.js';
import {
	assertNoAggregateFieldCodecSpecs,
	encodeAggregatePlanFieldCodecs,
	encodeQueryPlanFieldCodecs
} from '../../core/field-codecs.js';
import {
	assertFirestoreQueryLimits,
	assertGoogleInequalitySortOrder,
	assertGoogleMinMaxInequalityOrder,
	assertGoogleSortableFieldsDeclared
} from './google-query-constraints.js';
import {
	MAP_DELETE,
	MAP_GET,
	MAP_SET,
	MAP_VALUES,
	SET_ADD,
	SET_HAS,
	WEAKSET_ADD,
	WEAKSET_HAS
} from '../../core/collection-intrinsics.js';
import type {
	AggregatePlan,
	AggregateSpec,
	EntityId,
	FieldType,
	QueryPlan,
	QueryResult,
	ResolvedModelMeta,
	SchemaPlan,
	StoreAdapter,
	StoreTransactionOptions
} from '../../core/types.js';

export type FirestoreStoreOptions = {
	client?: any;
	firestoreOptions?: Record<string, any>;
	aggregateField?: any;
	allowAggregateScanFallback?: boolean;
};
export type FirestoreTransactionNativeOptions = {
	readOnly?: boolean;
	readTime?: unknown;
	maxAttempts?: number;
};
const FIRESTORE_OPTION_KEYS = ['client', 'firestoreOptions', 'aggregateField', 'allowAggregateScanFallback'] as const;
const FIRESTORE_TRANSACTION_NATIVE_OPTION_KEYS = ['readOnly', 'readTime', 'maxAttempts'] as const;
type FirestoreTransactionMutation =
	| { operation: 'create' | 'update'; data: Record<string, unknown> }
	| { operation: 'delete' };

function uniqueStrings(values: readonly string[]) {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (SET_HAS.call(seen, value)) continue;
		SET_ADD.call(seen, value);
		result.push(value);
	}
	return result;
}
const FIRESTORE_TYPED_ID_PREFIX = 'active-ts-id:';

function assertSafeFirestoreCollectionName(name: string) {
	return assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(name, 'Firestore collection name'),
		'Firestore collection name'
	);
}

function assertSafeFirestoreField(field: unknown, context = 'Firestore field') {
	const safeField = assertSafeFieldPath(field, context);
	if (safeField.includes('/')) throw new ActiveTsValidationError(`${context} "${safeField}" cannot contain "/".`);
	return safeField;
}

function doc(client: ReturnType<typeof normalizeFirestoreClient>, model: ResolvedModelMeta, id: EntityId) {
	assertSafeEntityId(id, `${model.name} store id`);
	const documentId = firestoreDocumentId(id);
	if (!documentId || documentId.includes('/')) throw new ActiveTsValidationError('Firestore document id cannot contain "/".');
	const collection = normalizeFirestoreObject(
		client.collection(assertSafeFirestoreCollectionName(model.name)),
		`Firestore collection "${model.name}"`
	);
	return normalizeFirestoreObject(
		firestoreMethod(collection, 'doc', 'Firestore collection.doc')(documentId),
		'Firestore document reference'
	);
}

function firestoreDocumentId(id: EntityId) {
	const key = entityIdKey(id);
	if (!key.includes('/') && !key.startsWith(FIRESTORE_TYPED_ID_PREFIX)) return key;
	return `${FIRESTORE_TYPED_ID_PREFIX}${Buffer.from(key, 'utf8').toString('base64url')}`;
}

function applyFirestoreWhere(query: any, where: QueryPlan['where'][number]) {
	const field = assertSafeFirestoreField(where.field, 'Firestore query field');
	if (where.op === 'between')
		return firestoreMethod(
			normalizeFirestoreObject(
				firestoreMethod(query, 'where', 'Firestore query.where')(field, '>=', where.value),
				'Firestore query'
			),
			'where',
			'Firestore query.where'
		)(field, '<=', where.value2);
	if (where.op === 'isNull') return firestoreMethod(query, 'where', 'Firestore query.where')(field, '==', null);
	if (where.op === 'isNotNull') return firestoreMethod(query, 'where', 'Firestore query.where')(field, '!=', null);
	if (where.op === 'contains')
		throw new ActiveTsConfigurationError(
			'Firestore adapter does not support the legacy contains operator. Use arrayContains.'
		);
	if (where.op === 'arrayContains')
		return firestoreMethod(query, 'where', 'Firestore query.where')(field, 'array-contains', where.value);
	if (where.op === 'textContains' || where.op === 'jsonContains')
		throw new ActiveTsConfigurationError(`Firestore adapter does not support ${where.op} queries.`);
	if (where.op === 'startsWith')
		throw new ActiveTsConfigurationError('Firestore adapter does not support safe startsWith queries.');
	return firestoreMethod(query, 'where', 'Firestore query.where')(field, where.op === '=' ? '==' : where.op, where.value);
}

function valueFor(data: any, field: string) {
	let current = data;
	for (const key of field.split('.')) {
		if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
			return undefined;
		}
		current = current[key];
	}
	return current;
}

function firestoreAggregateField(AggregateField: any, spec: AggregateSpec) {
	if (spec.op === 'count') return AggregateField.count();
	const field = assertSafeFirestoreField(spec.field, `Firestore ${spec.op} aggregate field`);
	if (spec.op === 'sum') return AggregateField.sum(field);
	if (spec.op === 'avg') return AggregateField.average(field);
	return undefined;
}

function canUseFirestoreMinMaxFastPath(model: ResolvedModelMeta, spec: AggregateSpec, plan: AggregatePlan) {
	if ((spec.op !== 'min' && spec.op !== 'max') || !spec.field) return false;
	const type = MAP_GET.call(model.fieldTypes, spec.field) as FieldType | undefined;
	if (type !== 'number' && type !== 'string' && type !== 'date') return false;
	if (aggregateFieldHasMixedNullInFilter(plan, spec.field)) return false;
	return true;
}

function aggregateFieldCanOnlyMatchNull(plan: AggregatePlan, field: string) {
	for (let index = 0; index < plan.where.length; index++) {
		const where = plan.where[index];
		if (where.field !== field) continue;
		if (where.op === 'isNull' || (where.op === '=' && where.value === null)) return true;
		if (where.op === 'in' && Array.isArray(where.value) && everyValueIsNull(where.value)) return true;
	}
	return false;
}

function aggregateFieldAlreadyExcludesNull(plan: AggregatePlan, field: string) {
	for (let index = 0; index < plan.where.length; index++) {
		const where = plan.where[index];
		if (where.field !== field) continue;
		if (
			where.op === 'isNotNull' ||
			(where.op === '=' && where.value !== null) ||
			(where.op === 'in' && Array.isArray(where.value) && where.value.length > 0 && !arrayHasNull(where.value)) ||
			where.op === '>' ||
			where.op === '>=' ||
			where.op === '<' ||
			where.op === '<=' ||
			where.op === 'between' ||
			where.op === 'startsWith'
		) return true;
	}
	return false;
}

function aggregateFieldHasMixedNullInFilter(plan: AggregatePlan, field: string) {
	for (let index = 0; index < plan.where.length; index++) {
		const where = plan.where[index];
		if (where.field !== field || where.op !== 'in' || !Array.isArray(where.value)) continue;
		if (arrayHasNull(where.value) && arrayHasNonNull(where.value)) return true;
	}
	return false;
}

function everyValueIsNull(values: readonly unknown[]) {
	for (let index = 0; index < values.length; index++) {
		if (values[index] !== null) return false;
	}
	return true;
}

function arrayHasNull(values: readonly unknown[]) {
	for (let index = 0; index < values.length; index++) {
		if (values[index] === null) return true;
	}
	return false;
}

function arrayHasNonNull(values: readonly unknown[]) {
	for (let index = 0; index < values.length; index++) {
		if (values[index] !== null) return true;
	}
	return false;
}

function assertFirestoreNativeFunction(plan: QueryPlan | AggregatePlan) {
	if (plan.native === undefined) return undefined;
	if (typeof plan.native.payload === 'function') return plan.native.payload;
	throw new ActiveTsValidationError('Firestore native payload must be a function.');
}

function assertFirestoreArrayContainsPlan(plan: QueryPlan | AggregatePlan) {
	let filters = 0;
	for (let index = 0; index < plan.where.length; index++) {
		if (plan.where[index].op === 'arrayContains') filters++;
	}
	if (filters <= 1) return;
	throw new ActiveTsConfigurationError(
		'Firestore adapter supports at most one arrayContains filter per query. Use a native query for backend-specific combinations.'
	);
}

function firestoreFieldList(fields: readonly string[], context: string) {
	const safeFields: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		safeFields[index] = assertSafeFirestoreField(fields[index], context);
	}
	return safeFields;
}

export async function createFirestoreStoreAdapter(options: FirestoreStoreOptions = {}): Promise<StoreAdapter> {
	options = validateFirestoreOptions(options);
	let client = options.client;
	let AggregateField = options.aggregateField;
	const allowAggregateScanFallback = options.allowAggregateScanFallback === true;
	if (!client) {
		const mod = await optionalImport('@google-cloud/firestore', 'FirestoreStoreAdapter');
		const Firestore = mod.Firestore;
		client = new Firestore(options.firestoreOptions ?? {});
		AggregateField ??= mod.AggregateField;
	}
	client = normalizeFirestoreClient(client);
	AggregateField = AggregateField === undefined ? undefined : normalizeFirestoreAggregateField(AggregateField);

	const adapter: StoreAdapter = {
		kind: 'firestore',
		capabilities: {
			or: false,
			contains: false,
			arrayContains: true,
			textContains: false,
			jsonContains: false,
			startsWith: false,
			cursor: false,
			offset: true,
			select: true,
			nestedFields: true,
			numericComparisons: true,
			aggregate: true,
			transaction: true,
			transactionConflictDetection: true,
			savepoint: false,
			uniqueIndex: false,
			optimisticLock: false,
			nullOperators: true,
			missingFieldNulls: false,
			native: true
		},
		async get(model, id, options) {
			model = snapshotAdapterModel(model, 'Firestore model metadata');
			rejectUnsupportedStoreReadOptions(options, 'Firestore store read options');
			assertSafeEntityId(id, `${model.name} store id`);
			const ref = doc(client, model, id);
			const snap = normalizeFirestoreObject(await firestoreMethod(ref, 'get', 'Firestore document.get')(), 'Firestore document snapshot');
			if (!firestoreSnapshotExists(snap, 'Firestore document snapshot')) return null;
			assertFirestoreDocumentMatchesExpectedId(snap, id, 'Firestore document snapshot');
			const data = firestoreDocumentData(snap, 'Firestore document snapshot');
			assertStoreDataMatchesId(model, id, data, 'Firestore get document data');
			return data;
		},
		async getMany(model, ids, options) {
			model = snapshotAdapterModel(model, 'Firestore model metadata');
			rejectUnsupportedStoreReadOptions(options, 'Firestore store read options');
			ids = assertSafeEntityIdArray(ids, 'Firestore store ids');
			if (!ids.length) return [];
			const uniqueIds: EntityId[] = [];
			const requested = new Set<string>();
			for (const id of ids) {
				const encoded = entityIdKey(id);
				if (SET_HAS.call(requested, encoded)) continue;
				SET_ADD.call(requested, encoded);
				uniqueIds.push(id);
			}
			const refs: any[] = [];
			for (let index = 0; index < uniqueIds.length; index++) {
				refs[index] = doc(client, model, uniqueIds[index]);
			}
			const snaps = await client.getAll(...refs);
			if (!Array.isArray(snaps)) throw new ActiveTsValidationError('Firestore getAll result must be an array.');
			if (snaps.length !== uniqueIds.length) {
				throw new ActiveTsValidationError(`Firestore getAll result must contain ${uniqueIds.length} entries.`);
			}
			const safeSnaps = snapshotArrayInput<any>(snaps, 'Firestore getAll result');
			const byId = new Map<string, any | null>();
			for (let index = 0; index < safeSnaps.length; index++) {
				const snap = safeSnaps[index];
				const document = normalizeFirestoreObject(snap, 'Firestore document snapshot');
				const requestedId = uniqueIds[index];
				const key = entityIdKey(requestedId);
				if (!firestoreSnapshotExists(document, 'Firestore document snapshot')) {
					MAP_SET.call(byId, key, null);
					continue;
				}
				assertFirestoreDocumentMatchesExpectedId(document, requestedId, `Firestore getAll result[${index}]`);
				const data = firestoreDocumentData(document, 'Firestore document snapshot');
				assertStoreDataMatchesId(model, requestedId, data, `Firestore getAll result[${index}] data`);
				MAP_SET.call(byId, key, data);
			}
			const result: Array<any | null> = [];
			for (let index = 0; index < ids.length; index++) {
				const id = ids[index];
				const row = MAP_GET.call(byId, entityIdKey(id));
				result[index] = row === undefined || row === null ? null : cloneSafeDataObject(row, 'Firestore getAll result data');
			}
			return result;
		},
		async query(model, plan, options): Promise<QueryResult> {
			model = snapshotAdapterModel(model, 'Firestore model metadata');
			plan = normalizeStoreQueryPlan(plan, model.idField, 'Firestore query plan', {
				limit: 'Firestore limit',
				offset: 'Firestore offset',
				whereField: 'Firestore query field',
				selectField: 'Firestore select field',
				sortField: 'Firestore sort field'
			});
			plan = normalizeQueryPlanFieldTypes(model, plan);
			plan = encodeQueryPlanFieldCodecs(model, plan);
			assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
			validateStoreQueryReadOptions(options, plan, 'Firestore store read options');
			const native = assertFirestoreNativeFunction(plan);
			if (native) return normalizeStoreQueryResultForModel(
				model,
				await native({ client, model, plan }),
				'Firestore native function query',
				{ cursor: adapter.capabilities?.cursor, adapterKind: adapter.kind }
			);
			if (plan.or.length) throw new ActiveTsConfigurationError('Firestore adapter does not support orWhere().');
			assertFirestoreArrayContainsPlan(plan);
			assertFirestoreQueryLimits(plan);
			assertGoogleInequalitySortOrder('Firestore', plan, 'orderBy');
			assertGoogleSortableFieldsDeclared('Firestore', model, plan, 'orderBy');
			let query: any = normalizeFirestoreObject(
				client.collection(assertSafeFirestoreCollectionName(model.name)),
				`Firestore collection "${model.name}"`
			);
			for (const where of plan.where)
				query = normalizeFirestoreObject(applyFirestoreWhere(query, where), 'Firestore query');
			for (const sort of plan.sort)
				query = normalizeFirestoreObject(
					firestoreMethod(query, 'orderBy', 'Firestore query.orderBy')(
						assertSafeFirestoreField(sort.field, 'Firestore sort field'),
						sort.direction
					),
					'Firestore query'
				);
			if (plan.offset !== undefined) {
				query = normalizeFirestoreObject(
					firestoreMethod(query, 'offset', 'Firestore query.offset')(plan.offset),
					'Firestore query'
				);
			}
			if (plan.limit !== undefined) {
				query = normalizeFirestoreObject(
					firestoreMethod(query, 'limit', 'Firestore query.limit')(limitWithLookahead(plan.limit, 'Firestore limit')),
					'Firestore query'
				);
			}
			if (plan.select?.length) {
				query = normalizeFirestoreObject(
					firestoreMethod(query, 'select', 'Firestore query.select')(
						...firestoreFieldList(uniqueStrings([model.idField, ...plan.select]), 'Firestore select field')
					),
					'Firestore query'
				);
			}
			const snap = normalizeFirestoreObject(await firestoreMethod(query, 'get', 'Firestore query.get')(), 'Firestore query snapshot');
			const docs = trimLookaheadRows(
				firestoreSnapshotDocs(snap, 'Firestore query snapshot'),
				plan.limit,
				'Firestore limit'
			);
			const list: any[] = [];
			for (let index = 0; index < docs.rows.length; index++) {
				const item = docs.rows[index];
				list[index] = firestoreQueryDocumentData(
					normalizeFirestoreObject(item, 'Firestore query document'),
					model,
					'Firestore query document'
				);
			}
			const result: QueryResult = { list, count: list.length, more: docs.more };
			return result;
		},
		async aggregate(model, plan: AggregatePlan) {
			model = snapshotAdapterModel(model, 'Firestore model metadata');
			plan = normalizeStoreAggregatePlan(plan, 'Firestore aggregate plan');
			plan = normalizeAggregatePlanFieldTypes(model, plan);
			plan = encodeAggregatePlanFieldCodecs(model, plan);
			assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
			const specs = assertAggregateSpecsCompatibleWithModel(model, plan.aggregates, 'Firestore aggregate');
			assertNoAggregateFieldCodecSpecs(model, specs, 'Firestore aggregate');
			const native = assertFirestoreNativeFunction(plan);
			if (native) return normalizeStoreAggregateResult(
				await native({ client, model, plan }),
				specs,
				'Firestore native function aggregate'
			);
			if (plan.or.length) throw new ActiveTsConfigurationError('Firestore adapter does not support orWhere().');
			assertFirestoreArrayContainsPlan(plan);
			assertFirestoreQueryLimits(plan);
			if (
				specs.length === 1 &&
				(specs[0].op === 'min' || specs[0].op === 'max') &&
				canUseFirestoreMinMaxFastPath(model, specs[0], plan)
			) {
				assertGoogleMinMaxInequalityOrder('Firestore', plan, specs[0]);
			}
			let query: any = normalizeFirestoreObject(
				client.collection(assertSafeFirestoreCollectionName(model.name)),
				`Firestore collection "${model.name}"`
			);
			for (const where of plan.where) {
				query = normalizeFirestoreObject(applyFirestoreWhere(query, where), 'Firestore query');
			}
			if (!plan.or.length && AggregateField && firestoreOptionalMethod(query, 'aggregate', 'Firestore query.aggregate')) {
				const aggregateSpec: Record<string, unknown> = {};
				let aggregateSpecValid = true;
				for (let index = 0; index < specs.length; index++) {
					const spec = specs[index];
					const field = firestoreAggregateField(AggregateField, spec);
					aggregateSpec[spec.as] = field;
					if (!field) aggregateSpecValid = false;
				}
				if (aggregateSpecValid) {
					const aggregateQuery = normalizeFirestoreObject(
						firestoreMethod(query, 'aggregate', 'Firestore query.aggregate')(aggregateSpec),
						'Firestore aggregate query'
					);
					const snap = normalizeFirestoreObject(await firestoreMethod(aggregateQuery, 'get', 'Firestore aggregate query.get')(), 'Firestore aggregate snapshot');
					return normalizeAggregateRow(
						firestoreMethod(snap, 'data', 'Firestore aggregate snapshot.data')(),
						specs,
						'Firestore aggregate'
					);
				}
			}
			if (
				!plan.or.length &&
				specs.length === 1 &&
				(specs[0].op === 'min' || specs[0].op === 'max') &&
				canUseFirestoreMinMaxFastPath(model, specs[0], plan) &&
				firestoreOptionalMethod(query, 'orderBy', 'Firestore query.orderBy')
			) {
				const spec = specs[0];
				const field = assertSafeFirestoreField(spec.field!, `Firestore ${spec.op} aggregate field`);
				if (aggregateFieldCanOnlyMatchNull(plan, field)) {
					return normalizeAggregateRow({ [spec.as]: null }, specs, 'Firestore aggregate');
				}
				if (!aggregateFieldAlreadyExcludesNull(plan, field)) {
					query = normalizeFirestoreObject(
						firestoreMethod(query, 'where', 'Firestore query.where')(field, '!=', null),
						'Firestore query'
					);
				}
				query = normalizeFirestoreObject(
					firestoreMethod(
						normalizeFirestoreObject(
							firestoreMethod(query, 'orderBy', 'Firestore query.orderBy')(
								field,
								spec.op === 'max' ? 'desc' : 'asc'
							),
							'Firestore query'
						),
						'limit',
						'Firestore query.limit'
					)(1),
					'Firestore query'
				);
				const snap = normalizeFirestoreObject(await firestoreMethod(query, 'get', 'Firestore query.get')(), 'Firestore query snapshot');
				const [first] = firestoreSnapshotDocs(snap, 'Firestore query snapshot');
				const data = first
					? firestoreQueryDocumentData(
							normalizeFirestoreObject(first, 'Firestore query document'),
							model,
							'Firestore query document'
						)
					: undefined;
				return normalizeAggregateRow(
					{ [spec.as]: data ? valueFor(data, spec.field!) ?? null : null },
					specs,
					'Firestore aggregate'
				);
			}
			if (!allowAggregateScanFallback) {
				throw new ActiveTsConfigurationError(
					'Firestore aggregate scan fallback requires allowAggregateScanFallback: true.'
				);
			}
			const aggregateFields: string[] = [];
			for (let index = 0; index < specs.length; index++) {
				const field = specs[index].field;
				if (field) aggregateFields[aggregateFields.length] = field;
			}
			const fields = uniqueStrings(aggregateFields);
			if (fields.length)
				query = normalizeFirestoreObject(
					firestoreMethod(query, 'select', 'Firestore query.select')(
						...firestoreFieldList(uniqueStrings([model.idField, ...fields]), 'Firestore aggregate field')
					),
					'Firestore query'
				);
			const snap = normalizeFirestoreObject(await firestoreMethod(query, 'get', 'Firestore query.get')(), 'Firestore query snapshot');
			const rows: any[] = [];
			const docs = firestoreSnapshotDocs(snap, 'Firestore query snapshot');
			for (let index = 0; index < docs.length; index++) {
				const item = docs[index];
				rows[index] = firestoreQueryDocumentData(
					normalizeFirestoreObject(item, 'Firestore query document'),
					model,
					'Firestore query document'
				);
			}
			return aggregateRows(
				rows,
				specs
			);
		},
		async create(model, id, data, options = {}) {
			model = snapshotAdapterModel(model, 'Firestore model metadata');
			rejectUnsupportedStoreWriteOptions(options, 'Firestore store create options');
			assertSafeEntityId(id, `${model.name} store id`);
			const ref = doc(client, model, id);
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			try {
				await firestoreMethod(ref, 'create', 'Firestore document.create')(clean);
			} catch (error) {
				if (isFirestoreAlreadyExistsError(error)) {
					throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
				}
				throw error;
			}
		},
		async update(model, id, data, options = {}) {
			model = snapshotAdapterModel(model, 'Firestore model metadata');
			rejectUnsupportedStoreWriteOptions(options, 'Firestore store write options');
			assertSafeEntityId(id, `${model.name} store id`);
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			const ref = doc(client, model, id);
			await replaceFirestoreDocument(client, model, id, ref, clean);
		},
		async delete(model, id, options = {}) {
			model = snapshotAdapterModel(model, 'Firestore model metadata');
			rejectUnsupportedStoreWriteOptions(options, 'Firestore store delete options');
			assertSafeEntityId(id, `${model.name} store id`);
			const ref = doc(client, model, id);
			await firestoreMethod(ref, 'delete', 'Firestore document.delete')();
		},
		async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>, transactionOptions?: StoreTransactionOptions) {
			if (typeof fn !== 'function') {
				throw new ActiveTsConfigurationError('Firestore transaction callback must be a function.');
			}
			const txOptions = normalizeStoreTransactionOptions(transactionOptions, 'Firestore transaction options');
			if (txOptions.isolation !== undefined) {
				throw new ActiveTsConfigurationError('Firestore transaction options.isolation is not supported.');
			}
			if (txOptions.timeoutMs !== undefined) {
				throw new ActiveTsConfigurationError('Firestore transaction options.timeoutMs is not supported.');
			}
			let firestoreTransactionOptions: Record<string, unknown> | undefined;
			let passFirestoreTransactionOptions = false;
			let effectiveReadOnly = txOptions.readOnly;
			if (txOptions.native !== undefined) {
				if (!txOptions.native || typeof txOptions.native !== 'object' || Array.isArray(txOptions.native)) {
					throw new ActiveTsConfigurationError('Firestore transaction options.native must be a plain object.');
				}
				assertPlainFactoryOptions(txOptions.native, 'Firestore transaction options.native');
				const nativeRecord = txOptions.native as Record<string, unknown>;
				assertNoSymbolOptions(nativeRecord, 'Firestore transaction options.native');
				assertKnownOptions(
					nativeRecord,
					FIRESTORE_TRANSACTION_NATIVE_OPTION_KEYS,
					'Firestore transaction options.native'
				);
				firestoreTransactionOptions = snapshotSdkOptions(txOptions.native, 'Firestore transaction options.native');
				passFirestoreTransactionOptions = true;
				const nativeReadOnly = ownFactoryOptionValue(
					firestoreTransactionOptions,
					'readOnly',
					'Firestore transaction native option'
				);
				if (nativeReadOnly !== undefined && typeof nativeReadOnly !== 'boolean') {
					throw new ActiveTsConfigurationError('Firestore transaction options.native.readOnly must be a boolean.');
				}
				if (
					txOptions.readOnly !== undefined &&
					nativeReadOnly !== undefined &&
					nativeReadOnly !== txOptions.readOnly
				) {
					throw new ActiveTsConfigurationError('Firestore transaction options.readOnly conflicts with options.native.readOnly.');
				}
				if (nativeReadOnly !== undefined) effectiveReadOnly = nativeReadOnly;
				const nativeMaxAttempts = ownFactoryOptionValue(
					firestoreTransactionOptions,
					'maxAttempts',
					'Firestore transaction native option'
				);
				if (
					nativeMaxAttempts !== undefined &&
					(!Number.isInteger(nativeMaxAttempts) || nativeMaxAttempts < 1)
				) {
					throw new ActiveTsConfigurationError('Firestore transaction options.native.maxAttempts must be a positive integer.');
				}
				const nativeReadTime = ownFactoryOptionValue(
					firestoreTransactionOptions,
					'readTime',
					'Firestore transaction native option'
				);
				if (nativeReadTime !== undefined && effectiveReadOnly !== true) {
					throw new ActiveTsConfigurationError('Firestore transaction options.native.readTime requires readOnly: true.');
				}
				if (nativeMaxAttempts !== undefined && effectiveReadOnly === true) {
					throw new ActiveTsConfigurationError('Firestore transaction options.native.maxAttempts requires a read-write transaction.');
				}
			}
			if (txOptions.readOnly !== undefined) {
				if (!firestoreTransactionOptions) firestoreTransactionOptions = Object.create(null) as Record<string, unknown>;
				defineDataProperty(firestoreTransactionOptions, 'readOnly', txOptions.readOnly, {
					enumerable: true,
					configurable: true,
					writable: true
				});
				passFirestoreTransactionOptions = true;
			}
			const callbackErrors = new WeakSet<object>();
			let transactionRegisteredCreate = false;
			let transactionRegisteredWrite = false;
			let transactionCallbackCompleted = false;
			const run = async (rawTransaction: unknown) => {
				if (transactionCallbackCompleted && transactionRegisteredWrite) {
					throw markTransactionRollbackSkipped(
						new ActiveTsConfigurationError(
							'Firestore transaction write outcome is unknown because the Firestore SDK retried after a completed write attempt.'
						)
					);
				}
				transactionRegisteredCreate = false;
				transactionRegisteredWrite = false;
				transactionCallbackCompleted = false;
				const transaction = normalizeFirestoreTransaction(rawTransaction);
				const buffered = new Map<string, FirestoreTransactionMutation>();
				const bufferedMutationTails = new Map<string, Promise<void>>();
				const pointReads = new Map<string, { data: Record<string, any> | null }>();
				let dirty = false;
				const mutationKey = (model: ResolvedModelMeta, id: EntityId) => `${model.name}:${entityIdKey(id)}`;
				const serializeBufferedMutation = async (
					key: string,
					operation: () => Promise<void>
				): Promise<void> => {
					const previous = MAP_GET.call(bufferedMutationTails, key) as Promise<void> | undefined;
					let release!: () => void;
					const tail = new Promise<void>((resolve) => {
						release = resolve;
					});
					MAP_SET.call(bufferedMutationTails, key, tail);
					if (previous !== undefined) await previous;
					try {
						await operation();
					} finally {
						release();
						if (MAP_GET.call(bufferedMutationTails, key) === tail) {
							MAP_DELETE.call(bufferedMutationTails, key);
						}
					}
				};
				const waitForBufferedMutations = async (keys?: readonly string[]): Promise<void> => {
					const pending: Promise<void>[] = [];
					if (keys === undefined) {
						for (const tail of MAP_VALUES.call(bufferedMutationTails) as Iterable<Promise<void>>) {
							pending[pending.length] = tail;
						}
					} else {
						for (let index = 0; index < keys.length; index++) {
							const tail = MAP_GET.call(bufferedMutationTails, keys[index]) as Promise<void> | undefined;
							if (tail !== undefined) pending[pending.length] = tail;
						}
					}
					for (let index = 0; index < pending.length; index++) await pending[index];
				};
				const bufferedRow = (model: ResolvedModelMeta, id: EntityId) => {
					const mutation = MAP_GET.call(buffered, mutationKey(model, id)) as FirestoreTransactionMutation | undefined;
					if (!mutation) return undefined;
					if (mutation.operation === 'delete') return null;
					return cloneSafeDataObject(mutation.data, `${model.name} Firestore transaction row`);
				};
				const assertSdkReadAllowed = (context: string) => {
					if (!dirty) return;
					throw new ActiveTsConfigurationError(
						`Firestore transaction ${context} cannot read unbuffered documents after writes. Run reads before writes or read rows already written in this transaction.`
					);
				};
				const cachedPointRead = (model: ResolvedModelMeta, id: EntityId) => {
					const snapshot = MAP_GET.call(pointReads, mutationKey(model, id)) as
						| { data: Record<string, any> | null }
						| undefined;
					if (snapshot === undefined) return undefined;
					return snapshot.data === null
						? null
						: cloneSafeDataObject(snapshot.data, `${model.name} Firestore transaction cached row`);
				};
				const readDocument = async (model: ResolvedModelMeta, id: EntityId, context: string) => {
					const ref = doc(client, model, id);
					const snap = normalizeFirestoreObject(
						await transaction.get(ref),
						`${context} document snapshot`
					);
					if (!firestoreSnapshotExists(snap, `${context} document snapshot`)) {
						MAP_SET.call(pointReads, mutationKey(model, id), { data: null });
						return null;
					}
					assertFirestoreDocumentMatchesExpectedId(snap, id, `${context} document snapshot`);
					const data = firestoreDocumentData(snap, `${context} document snapshot`);
					assertStoreDataMatchesId(model, id, data, `${context} document data`);
					MAP_SET.call(pointReads, mutationKey(model, id), {
						data: cloneSafeDataObject(data, `${context} cached document data`)
					});
					return data;
				};
				const tx: StoreAdapter = {
					kind: 'firestore',
					capabilities: { ...adapter.capabilities, transaction: false, aggregate: false, native: false },
					get: async (model, id, options) => {
						model = snapshotAdapterModel(model, 'Firestore transaction model metadata');
						rejectUnsupportedStoreReadOptions(options, 'Firestore transaction read options');
						assertSafeEntityId(id, `${model.name} store id`);
						await waitForBufferedMutations([mutationKey(model, id)]);
						const buffered = bufferedRow(model, id);
						if (buffered !== undefined) return buffered;
						const cached = cachedPointRead(model, id);
						if (cached !== undefined) return cached;
						assertSdkReadAllowed('get');
						return await readDocument(model, id, 'Firestore transaction get');
					},
					getMany: async (model, ids, options) => {
						model = snapshotAdapterModel(model, 'Firestore transaction model metadata');
						rejectUnsupportedStoreReadOptions(options, 'Firestore transaction read options');
						ids = assertSafeEntityIdArray(ids, 'Firestore transaction store ids');
						const rows: Array<any | null> = [];
						for (let index = 0; index < ids.length; index++) {
							await waitForBufferedMutations([mutationKey(model, ids[index])]);
							const buffered = bufferedRow(model, ids[index]);
							if (buffered !== undefined) {
								rows[index] = buffered;
								continue;
							}
							const cached = cachedPointRead(model, ids[index]);
							if (cached !== undefined) {
								rows[index] = cached;
								continue;
							}
							assertSdkReadAllowed('getMany');
							rows[index] = await readDocument(model, ids[index], `Firestore transaction getMany[${index}]`);
						}
						return rows;
					},
					query: async (model, plan, options): Promise<QueryResult> => {
						model = snapshotAdapterModel(model, 'Firestore transaction model metadata');
						plan = normalizeStoreQueryPlan(plan, model.idField, 'Firestore transaction query plan', {
							limit: 'Firestore limit',
							offset: 'Firestore offset',
							whereField: 'Firestore query field',
							selectField: 'Firestore select field',
							sortField: 'Firestore sort field'
						});
						plan = normalizeQueryPlanFieldTypes(model, plan);
						plan = encodeQueryPlanFieldCodecs(model, plan);
						assertStorePlanSupported('firestore', tx.capabilities, plan);
						validateStoreQueryReadOptions(options, plan, 'Firestore transaction query read options');
						if (plan.native !== undefined) {
							throw new ActiveTsConfigurationError('Firestore transaction native queries are not supported.');
						}
						if (plan.or.length) throw new ActiveTsConfigurationError('Firestore adapter does not support orWhere().');
						assertFirestoreArrayContainsPlan(plan);
						assertFirestoreQueryLimits(plan);
						assertGoogleInequalitySortOrder('Firestore', plan, 'orderBy');
						assertGoogleSortableFieldsDeclared('Firestore', model, plan, 'orderBy');
						const query = firestoreQueryForPlan(client, model, plan);
						await waitForBufferedMutations();
						assertSdkReadAllowed('query');
						const snap = normalizeFirestoreObject(
							await transaction.get(query),
							'Firestore transaction query snapshot'
						);
						return firestoreQueryResult(model, plan, snap, 'Firestore transaction query snapshot');
					},
					create: async (model, id, data, options = {}) => {
						model = snapshotAdapterModel(model, 'Firestore transaction model metadata');
						rejectUnsupportedStoreWriteOptions(options, 'Firestore transaction create options');
						assertSafeEntityId(id, `${model.name} store id`);
						const clean = clonePortableDataObject(data, `${model.name} stored data`);
						assertStoreDataMatchesId(model, id, clean);
						const key = mutationKey(model, id);
						return serializeBufferedMutation(key, async () => {
							const existing = MAP_GET.call(buffered, key) as FirestoreTransactionMutation | undefined;
							if (existing && existing.operation !== 'delete') {
								throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
							}
							const ref = doc(client, model, id);
							try {
								let write: unknown;
								if (existing?.operation === 'delete') write = transaction.set(ref, clean);
								else {
									transactionRegisteredCreate = true;
									write = transaction.create(ref, clean);
								}
								dirty = true;
								transactionRegisteredWrite = true;
								await write;
							} catch (error) {
								if (isFirestoreAlreadyExistsError(error)) {
									throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
								}
								throw error;
							}
							MAP_SET.call(buffered, key, { operation: 'create', data: clean });
						});
					},
					update: async (model, id, data, options = {}) => {
						model = snapshotAdapterModel(model, 'Firestore transaction model metadata');
						rejectUnsupportedStoreWriteOptions(options, 'Firestore transaction write options');
						assertSafeEntityId(id, `${model.name} store id`);
						const clean = clonePortableDataObject(data, `${model.name} stored data`);
						assertStoreDataMatchesId(model, id, clean);
						const key = mutationKey(model, id);
						return serializeBufferedMutation(key, async () => {
							const existing = MAP_GET.call(buffered, key) as FirestoreTransactionMutation | undefined;
							if (existing?.operation === 'delete') throw firestoreUpdateNotFound(model, id);
							if (!existing) {
								let current = cachedPointRead(model, id);
								if (current === undefined) {
									assertSdkReadAllowed('update');
									current = await readDocument(model, id, 'Firestore transaction update');
								}
								if (!current) throw firestoreUpdateNotFound(model, id);
							}
							const ref = doc(client, model, id);
							const write = transaction.set(ref, clean);
							dirty = true;
							transactionRegisteredWrite = true;
							await write;
							MAP_SET.call(buffered, key, { operation: 'update', data: clean });
						});
					},
					delete: async (model, id, options = {}) => {
						model = snapshotAdapterModel(model, 'Firestore transaction model metadata');
						rejectUnsupportedStoreWriteOptions(options, 'Firestore transaction delete options');
						assertSafeEntityId(id, `${model.name} store id`);
						const key = mutationKey(model, id);
						return serializeBufferedMutation(key, async () => {
							const ref = doc(client, model, id);
							const write = transaction.delete(ref);
							dirty = true;
							transactionRegisteredWrite = true;
							await write;
							MAP_SET.call(buffered, key, { operation: 'delete' });
						});
					}
				};
				let closed: string | undefined;
				const scopedTx = effectiveReadOnly === true
					? (() => {
							const rejectReadOnlyWrite = async () => {
								throw new ActiveTsConfigurationError('Firestore transaction is read-only.');
							};
							return {
								kind: tx.kind,
								capabilities: { ...tx.capabilities, transaction: false, native: false },
								get: (model, id, options) => tx.get(model, id, options),
								getMany: (model, ids, options) => tx.getMany(model, ids, options),
								query: (model, plan, options) => tx.query(model, plan, options),
								create: rejectReadOnlyWrite,
								update: rejectReadOnlyWrite,
								delete: rejectReadOnlyWrite
							} satisfies StoreAdapter;
						})()
					: tx;
				const guardedTx = createCloseGuardedStoreAdapter(scopedTx, () => closed, 'Firestore store');
				let result: Awaited<ReturnType<typeof fn>>;
				try {
					result = await fn(guardedTx.adapter);
				} catch (error) {
					closed = 'rollback';
					try {
						await guardedTx.waitForPendingOperations();
					} catch {
						// Preserve the callback error that triggered rollback.
					}
					if (error && (typeof error === 'object' || typeof error === 'function')) {
						WEAKSET_ADD.call(callbackErrors, error);
					}
					throw error;
				}
				closed = 'callback finished';
				try {
					await guardedTx.waitForPendingOperations();
				} catch (error) {
					closed = 'rollback';
					throw error;
				}
				transactionCallbackCompleted = true;
				return result;
			};
			try {
				return await (passFirestoreTransactionOptions
					? client.runTransaction(run, firestoreTransactionOptions)
					: client.runTransaction(run));
			} catch (error) {
				if (error && (typeof error === 'object' || typeof error === 'function') && WEAKSET_HAS.call(callbackErrors, error)) {
					throw error;
				}
				if (transactionRegisteredCreate && isFirestoreAlreadyExistsError(error)) {
					throw new ActiveTsConflictError('Cannot create Firestore transaction document because it already exists.');
				}
				if (
					effectiveReadOnly !== true &&
					transactionCallbackCompleted &&
					isFirestoreCommitOutcomeUnknownError(error)
				) {
					const uncertain = new ActiveTsConfigurationError(
						`Firestore transaction commit outcome is unknown: ${safeErrorMessage(error)}`
					);
					defineDataProperty(uncertain, 'cause', error, {
						enumerable: false,
						configurable: true
					});
					throw markTransactionRollbackSkipped(uncertain);
				}
				throw error;
			}
		},
		schema: {
			async plan(models): Promise<SchemaPlan> {
				models = normalizeSchemaModels(models, 'Firestore schema models');
				assertFirestoreSchemaModelsSupported(models);
					return {
						adapter: 'firestore',
						status: 'manual',
						note: 'Firestore index plans are declarative intent; compare and deploy the generated Firebase or Google Cloud index configuration outside the adapter.',
						changes: firestoreSchemaChanges(models)
					};
				},
			async apply(models, applyOptions): Promise<SchemaPlan> {
				normalizeStoreSchemaApplyOptions(applyOptions, 'Firestore schema apply options');
				const safeModels = normalizeSchemaModels(models, 'Firestore schema models');
				const plan = await adapter.schema!.plan(safeModels);
				return {
					...plan,
					status: 'manual',
					note: 'Firestore composite indexes are reported as deployment intent and must be applied with the Firebase or Google Cloud index configuration workflow.'
				};
			}
		}
	};
	return adapter;
}

function firestoreSchemaChanges(models: ResolvedModelMeta[]) {
	const changes: SchemaPlan['changes'] = [];
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
			const index = model.indexes[indexIndex];
			const fields: string[] = [];
			for (let fieldIndex = 0; fieldIndex < index.fields.length; fieldIndex++) {
				fields[fieldIndex] = assertSafeFirestoreField(index.fields[fieldIndex], 'Firestore schema index field');
			}
			changes[changes.length] = {
				type: 'create-index' as const,
				target: model.name,
				name: index.name,
				fields,
				...(index.directions === undefined ? {} : { directions: index.directions }),
				unique: index.unique
			};
		}
	}
	return changes;
}

function assertFirestoreSchemaModelsSupported(models: ResolvedModelMeta[]) {
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
			const index = model.indexes[indexIndex];
			if (index.unique !== true) continue;
			throw new ActiveTsConfigurationError(
				`Firestore adapter does not support unique indexes. Unsupported index "${index.name}" on "${model.name}".`
			);
		}
	}
}

function firestoreQueryForPlan(
	client: ReturnType<typeof normalizeFirestoreClient>,
	model: ResolvedModelMeta,
	plan: QueryPlan
) {
	let query: any = normalizeFirestoreObject(
		client.collection(assertSafeFirestoreCollectionName(model.name)),
		`Firestore collection "${model.name}"`
	);
	for (const where of plan.where)
		query = normalizeFirestoreObject(applyFirestoreWhere(query, where), 'Firestore query');
	for (const sort of plan.sort)
		query = normalizeFirestoreObject(
			firestoreMethod(query, 'orderBy', 'Firestore query.orderBy')(
				assertSafeFirestoreField(sort.field, 'Firestore sort field'),
				sort.direction
			),
			'Firestore query'
		);
	if (plan.offset !== undefined) {
		query = normalizeFirestoreObject(
			firestoreMethod(query, 'offset', 'Firestore query.offset')(plan.offset),
			'Firestore query'
		);
	}
	if (plan.limit !== undefined) {
		query = normalizeFirestoreObject(
			firestoreMethod(query, 'limit', 'Firestore query.limit')(limitWithLookahead(plan.limit, 'Firestore limit')),
			'Firestore query'
		);
	}
	if (plan.select?.length) {
		query = normalizeFirestoreObject(
			firestoreMethod(query, 'select', 'Firestore query.select')(
				...firestoreFieldList(uniqueStrings([model.idField, ...plan.select]), 'Firestore select field')
			),
			'Firestore query'
		);
	}
	return query;
}

function firestoreQueryResult(
	model: ResolvedModelMeta,
	plan: QueryPlan,
	snap: object,
	context: string
): QueryResult {
	const docs = trimLookaheadRows(
		firestoreSnapshotDocs(snap, context),
		plan.limit,
		'Firestore limit'
	);
	const list: any[] = [];
	for (let index = 0; index < docs.rows.length; index++) {
		const item = docs.rows[index];
		list[index] = firestoreQueryDocumentData(
			normalizeFirestoreObject(item, 'Firestore query document'),
			model,
			'Firestore query document'
		);
	}
	return { list, count: list.length, more: docs.more };
}

function validateFirestoreOptions(options: FirestoreStoreOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Firestore adapter options must be an object.');
	}
	assertPlainFactoryOptions(options, 'Firestore adapter options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Firestore adapter options');
	assertKnownOptions(record, FIRESTORE_OPTION_KEYS, 'Firestore adapter options');
	const firestoreOptions = ownFactoryOptionValue(record, 'firestoreOptions', 'Firestore adapter option');
	const client = ownFactoryOptionValue(record, 'client', 'Firestore adapter option');
	const aggregateField = ownFactoryOptionValue(record, 'aggregateField', 'Firestore adapter option');
	const allowAggregateScanFallback = ownFactoryOptionValue(record, 'allowAggregateScanFallback', 'Firestore adapter option');
	const safeFirestoreOptions =
		firestoreOptions === undefined
			? undefined
			: snapshotSdkOptions(firestoreOptions, 'Firestore adapter firestoreOptions');
	if (client !== undefined) {
		normalizeFirestoreClient(client);
	}
	if (aggregateField !== undefined) {
		normalizeFirestoreAggregateField(aggregateField);
	}
	if (allowAggregateScanFallback !== undefined && typeof allowAggregateScanFallback !== 'boolean') {
		throw new ActiveTsConfigurationError('Firestore adapter allowAggregateScanFallback must be a boolean.');
	}
	return {
		firestoreOptions: safeFirestoreOptions,
		client,
		aggregateField,
		allowAggregateScanFallback
	} as FirestoreStoreOptions;
}

function assertPlainFactoryOptions(options: object, context: string) {
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
}

function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownOptions(record: Record<string, unknown>, allowedKeys: readonly string[], context: string) {
	const allowed = new Set<string>();
	for (const key of allowedKeys) SET_ADD.call(allowed, key);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function snapshotSdkOptions(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const record = value as Record<string, unknown>;
	assertNoSymbolOptions(record, context);
	const snapshot = Object.create(null) as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
		defineDataProperty(snapshot, key, descriptor.value, { enumerable: true, configurable: true, writable: true });
	}
	return snapshot;
}

function ownFactoryOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function normalizeFirestoreClient(client: unknown) {
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsConfigurationError('Firestore adapter client must be an object.');
	}
	const collection = firestoreMethod(client, 'collection', 'Firestore adapter client.collection');
	const getAll = firestoreMethod(client, 'getAll', 'Firestore adapter client.getAll');
	const runTransaction = firestoreMethod(client, 'runTransaction', 'Firestore adapter client.runTransaction');
	return Object.freeze({ collection, getAll, runTransaction });
}

function normalizeFirestoreTransaction(transaction: unknown) {
	const safeTransaction = normalizeFirestoreObject(transaction, 'Firestore transaction');
	return Object.freeze({
		get: firestoreMethod(safeTransaction, 'get', 'Firestore transaction.get'),
		create: firestoreMethod(safeTransaction, 'create', 'Firestore transaction.create'),
		set: firestoreMethod(safeTransaction, 'set', 'Firestore transaction.set'),
		delete: firestoreMethod(safeTransaction, 'delete', 'Firestore transaction.delete')
	});
}

function normalizeFirestoreAggregateField(aggregateField: unknown) {
	if (
		!aggregateField ||
		(typeof aggregateField !== 'object' && typeof aggregateField !== 'function') ||
		Array.isArray(aggregateField)
	) {
		throw new ActiveTsConfigurationError('Firestore adapter aggregateField must be an object or function.');
	}
	const count = firestoreAggregateFieldMethod(aggregateField, 'count', 'Firestore adapter aggregateField.count');
	const sum = firestoreAggregateFieldMethod(aggregateField, 'sum', 'Firestore adapter aggregateField.sum');
	const average = firestoreAggregateFieldMethod(aggregateField, 'average', 'Firestore adapter aggregateField.average');
	return Object.freeze({ count, sum, average });
}

function normalizeFirestoreObject(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	return value;
}

function firestoreSnapshotExists(snapshot: object, context: string) {
	const exists = firestoreMember(snapshot, 'exists', context);
	if (typeof exists !== 'boolean') {
		throw new ActiveTsValidationError(`${context}.exists must be a boolean.`);
	}
	return exists;
}

function firestoreSnapshotDocs(snapshot: object, context: string) {
	const docs = firestoreMember(snapshot, 'docs', context);
	if (!Array.isArray(docs)) {
		throw new ActiveTsValidationError(`${context}.docs must be an array.`);
	}
	return snapshotArrayInput(docs, `${context}.docs`);
}

function firestoreDocumentData(document: object, context: string) {
	return cloneSafeDataObject(firestoreMethod(document, 'data', `${context}.data`)(), `${context}.data result`);
}

function firestoreQueryDocumentData(document: object, model: ResolvedModelMeta, context: string) {
	const data = firestoreDocumentData(document, context);
	const storageId = firestoreDocumentStorageId(document, context);
	if (storageId !== undefined) {
		assertStoreDataMatchesId(model, storageId, data, `${context} data`);
	} else {
		assertStoreDataHasModelId(model, data, `${context} data`);
	}
	return data;
}

function assertFirestoreDocumentMatchesExpectedId(document: object, expectedId: EntityId, context: string) {
	const storageId = firestoreDocumentStorageId(document, context);
	if (storageId !== undefined && entityIdKey(storageId) !== entityIdKey(expectedId)) {
		throw new ActiveTsValidationError(`${context}.id must match the requested id.`);
	}
}

function firestoreDocumentStorageId(document: object, context: string) {
	const id = firestoreMember(document, 'id', context);
	if (id === undefined) return undefined;
	if (typeof id !== 'string') {
		throw new ActiveTsValidationError(`${context}.id must be a string.`);
	}
	const key = id.startsWith(FIRESTORE_TYPED_ID_PREFIX)
		? Buffer.from(id.slice(FIRESTORE_TYPED_ID_PREFIX.length), 'base64url').toString('utf8')
		: id;
	return entityIdFromCanonicalKey(key, `${context}.id`);
}

function isFirestoreAlreadyExistsError(error: unknown) {
	const code = ownErrorValue(error, 'code');
	return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

function isFirestoreCommitOutcomeUnknownError(error: unknown) {
	const code = ownErrorValue(error, 'code');
	if (code === undefined) return false;
	switch (code) {
		case 1:
		case 2:
		case 4:
		case 13:
		case 14:
		case 408:
		case 500:
		case 502:
		case 503:
		case 504:
		case 'cancelled':
		case 'CANCELLED':
		case 'unknown':
		case 'UNKNOWN':
		case 'deadline-exceeded':
		case 'DEADLINE_EXCEEDED':
		case 'internal':
		case 'INTERNAL':
		case 'unavailable':
		case 'UNAVAILABLE':
			return true;
		default:
			return false;
	}
}

function isFirestoreNotFoundError(error: unknown) {
	const code = ownErrorValue(error, 'code');
	return code === 5 || code === 'not-found' || code === 'NOT_FOUND';
}

function firestoreUpdateNotFound(model: ResolvedModelMeta, id: EntityId) {
	return new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
}

async function replaceFirestoreDocument(
	client: ReturnType<typeof normalizeFirestoreClient>,
	model: ResolvedModelMeta,
	id: EntityId,
	ref: object,
	data: Record<string, unknown>
) {
	if (!client.runTransaction) {
		throw new ActiveTsConfigurationError('Firestore adapter client.runTransaction is required for update().');
	}
	try {
		await client.runTransaction(async (transaction: unknown) => {
			const safeTransaction = normalizeFirestoreObject(transaction, 'Firestore transaction');
			const snap = normalizeFirestoreObject(
				await firestoreMethod(safeTransaction, 'get', 'Firestore transaction.get')(ref),
				'Firestore transaction document snapshot'
			);
			if (!firestoreSnapshotExists(snap, 'Firestore transaction document snapshot')) {
				throw firestoreUpdateNotFound(model, id);
			}
			await firestoreMethod(safeTransaction, 'set', 'Firestore transaction.set')(ref, data);
		});
	} catch (error) {
		if (error instanceof ActiveTsNotFoundError) throw error;
		if (isFirestoreNotFoundError(error)) throw firestoreUpdateNotFound(model, id);
		throw error;
	}
}

function firestoreOptionalMethod(target: object, method: string, context: string) {
	const value = firestoreMethodMember(target, method, context);
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(target);
}

function firestoreMethod(target: object, method: string, context: string) {
	const value = firestoreMethodMember(target, method, context);
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(target);
}

function firestoreAggregateFieldMethod(target: object | Function, method: string, context: string) {
	const value = firestoreAggregateFieldMember(target, method, context);
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(target);
}

function firestoreAggregateFieldMember(target: object | Function, property: string, context: string) {
	let current: object | null = target;
	const stopPrototype = typeof target === 'function' ? Function.prototype : Object.prototype;
	while (current && current !== stopPrototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context} must be a data property.`);
			}
			if (current === target && typeof target !== 'function' && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${context} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function firestoreMethodMember(target: object, property: string, context: string) {
	let current: object | null = target;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context} must be a data property.`);
			}
			if (current === target && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${context} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function firestoreMember(target: object, property: string, context: string) {
	let current: object | null = target;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor) {
				throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
			}
			if (!('value' in descriptor)) {
				if (current !== target && descriptor.get && firestoreSdkSnapshotAccessorAllowed(current, property)) {
					return descriptor.get.call(target);
				}
				throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
			}
			if (current === target && !descriptor.enumerable) {
				throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function firestoreSdkSnapshotAccessorAllowed(owner: object, property: string) {
	const constructor = Object.getOwnPropertyDescriptor(owner, 'constructor');
	if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function') return false;
	const name = constructor.value.name;
	return (
		((name === 'DocumentSnapshot' || name === 'QueryDocumentSnapshot') && (property === 'exists' || property === 'id')) ||
		(name === 'QuerySnapshot' && property === 'docs')
	);
}

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${key} must be enumerable.`);
	}
	return descriptor.value;
}
