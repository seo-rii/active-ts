import { optionalImport } from '../../core/optional-import.js';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsUnknownTransactionOutcomeError,
	ActiveTsValidationError,
	safeErrorMessage
} from '../../core/errors.js';
import { markTransactionRollbackSkipped, ownErrorValue } from '../../core/error-classification.js';
import {
	assertSafeEntityId,
	assertSafeEntityIdArray,
	assertSafeFieldPath,
	assertSafeLimit,
	assertSafePhysicalIdentifierLength,
	assertSafeSchemaIdentifier,
	cloneSafeDataObject,
	clonePortableDataObject,
	defineDataProperty
} from '../../core/safe-keys.js';
import { entityIdFromCanonicalKey, entityIdKey, limitWithLookahead, trimLookaheadRows } from '../../core/query-utils.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { aggregateRows, assertAggregateSpecsCompatibleWithModel, defaultAggregateResult, normalizeAggregateRow } from '../../core/aggregate.js';
import {
	assertStoreDataMatchesId,
	assertStorePlanSupported,
	normalizeStoreAggregatePlan,
	normalizeStoreAggregateResult,
	normalizeStoreQueryResultForModel,
	normalizeStoreQueryPlan,
	normalizeStoreTransactionOptions,
	normalizeStoreWriteOptions,
	createCloseGuardedStoreAdapter,
	rejectUnsupportedStoreReadOptions,
	rejectUnsupportedStoreWriteMetadata,
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
	MAP_GET,
	MAP_HAS,
	MAP_SET,
	MAP_SIZE,
	SET_ADD,
	SET_HAS,
	WEAKSET_ADD,
	WEAKSET_DELETE,
	WEAKSET_HAS
} from '../../core/collection-intrinsics.js';
import type {
	AggregatePlan,
	AggregateSpec,
	EntityId,
	QueryPlan,
	QueryResult,
	ResolvedModelMeta,
	SchemaPlan,
	SortDirection,
	StoreAdapter,
	StoreTransactionOptions
} from '../../core/types.js';
import type { TransactionOptions as MongoDriverTransactionOptions } from 'mongodb';
import escapeStringRegexp from 'escape-string-regexp';

export type MongoStoreOptions = {
	client?: any;
	url?: string;
	dbName: string;
	cacheScope?: string;
	allowAggregateScanFallback?: boolean;
};
const MONGO_OPTION_KEYS = ['client', 'url', 'dbName', 'cacheScope', 'allowAggregateScanFallback'] as const;
const MONGO_TRANSACTION_NATIVE_OPTION_KEYS = [
	'readConcern',
	'writeConcern',
	'readPreference',
	'maxCommitTimeMS'
] as const;
const MONGO_READ_CONCERN_KEYS = ['level'] as const;
const MONGO_WRITE_CONCERN_KEYS = ['w', 'journal', 'wtimeoutMS', 'wtimeout', 'j', 'fsync'] as const;
const MONGO_READ_PREFERENCE_KEYS = ['mode', 'tags', 'hedge', 'maxStalenessSeconds'] as const;

export type MongoTransactionNativeOptions = Pick<
	MongoDriverTransactionOptions,
	'readConcern' | 'writeConcern' | 'readPreference' | 'maxCommitTimeMS'
>;

export type MongoStoreTransactionOptions = Omit<StoreTransactionOptions, 'isolation' | 'native'> & {
	isolation?: never;
	native?: MongoTransactionNativeOptions;
};

export type MongoStoreAdapter = Omit<StoreAdapter, 'transaction'> & {
	transaction?<T>(
		fn: (tx: StoreAdapter) => Promise<T>,
		options?: MongoStoreTransactionOptions
	): Promise<T>;
};

type NormalizedMongoClientSession = {
	raw: object;
	startTransaction: (options?: MongoTransactionNativeOptions) => unknown;
	commitTransaction: (options?: { timeoutMS?: number }) => unknown;
	abortTransaction: (options?: { timeoutMS?: number }) => unknown;
	endSession: () => unknown;
};

type MongoTransactionState = {
	session: NormalizedMongoClientSession;
	readOnly: boolean;
	run: <T>(operation: () => Promise<T>) => Promise<T>;
};

function assertSafeMongoCollectionName(name: string) {
	name = assertSafeSchemaIdentifier(name, 'MongoDB collection name');
	assertSafePhysicalIdentifierLength(name, 'MongoDB collection name');
	if (name.includes('$') || name.startsWith('system.')) {
		throw new ActiveTsValidationError(`MongoDB collection name "${name}" is not allowed.`);
	}
	return name;
}

function assertSafeMongoIndexName(name: string) {
	if (!name || name.includes('\0') || name.startsWith('$')) {
		throw new ActiveTsValidationError(`MongoDB index name "${name}" is not allowed.`);
	}
	return name;
}

function assertSafeMongoField(field: string) {
	assertSafeFieldPath(field, 'MongoDB field');
	const parts = field.split('.');
	if (parts[0] === '_id') {
		throw new ActiveTsValidationError('MongoDB field "_id" is reserved for the internal storage key.');
	}
	for (const part of parts) {
		if (part.startsWith('$') || part.includes('\0')) {
			throw new ActiveTsValidationError(`MongoDB field "${field}" is not allowed.`);
		}
	}
	return field;
}

function assertSafeMongoModel(model: ResolvedModelMeta) {
	assertSafeMongoCollectionName(model.name);
	if (model.idField === '_id') {
		throw new ActiveTsValidationError('MongoDB model id field "_id" is reserved for the internal storage key.');
	}
	assertSafeMongoField(model.idField);
}

function mongoFilter(plan: Pick<QueryPlan, 'where' | 'or'>): Record<string, any> {
	const base = mongoWhereFilter(plan.where);
	const or: Array<Record<string, any>> = [];
	for (let index = 0; index < plan.or.length; index++) {
		or[or.length] = mongoFilter(plan.or[index]);
	}
	if (!or.length) return base;
	const branches: Array<Record<string, any>> = [];
	if (Object.keys(base).length) branches[branches.length] = base;
	for (let index = 0; index < or.length; index++) branches[branches.length] = or[index];
	return {
		$or: branches
	};
}

function mongoWhereFilter(whereList: QueryPlan['where']) {
	const conditions: Array<Record<string, any>> = [];
	for (let index = 0; index < whereList.length; index++) {
		conditions[conditions.length] = mongoWhereCondition(whereList[index]);
	}
	if (conditions.length === 0) return {};
	if (conditions.length === 1) return conditions[0];
	return { $and: conditions };
}

function mongoWhereCondition(where: QueryPlan['where'][number]) {
	const field = assertSafeMongoField(where.field);
	if (where.op === '=') return mongoScalarFieldCondition(field, { $eq: where.value });
	if (where.op === '!=') return mongoNotEqualFieldCondition(field, where.value);
	if (where.op === '>') return mongoScalarFieldCondition(field, { $gt: where.value });
	if (where.op === '>=') return mongoScalarFieldCondition(field, { $gte: where.value });
	if (where.op === '<') return mongoScalarFieldCondition(field, { $lt: where.value });
	if (where.op === '<=') return mongoScalarFieldCondition(field, { $lte: where.value });
	if (where.op === 'in') return mongoScalarFieldCondition(field, { $in: where.value });
	if (where.op === 'between') return mongoScalarFieldCondition(field, { $gte: where.value, $lte: where.value2 });
	if (where.op === 'isNull') return mongoNullFieldCondition(field);
	if (where.op === 'isNotNull') return mongoNotNullFieldCondition(field);
	if (where.op === 'contains')
		throw new ActiveTsValidationError(
			'MongoDB adapter does not support the legacy contains operator. Use arrayContains.'
		);
	if (where.op === 'arrayContains') return mongoFieldCondition(field, { $elemMatch: { $eq: where.value } });
	if (where.op === 'textContains' || where.op === 'jsonContains')
		throw new ActiveTsValidationError(`MongoDB operator "${where.op}" is not enabled by the portable adapter.`);
	if (where.op === 'startsWith')
		return mongoScalarFieldCondition(field, { $type: 'string', $regex: new RegExp(`^${escapeStringRegexp(String(where.value))}`) });
	throw new ActiveTsValidationError(`MongoDB operator "${where.op}" is not allowed.`);
}

function mongoScalarFieldCondition(field: string, condition: any): Record<string, any> {
	return mongoAnd(
		mongoFieldCondition(field, { $exists: true }),
		mongoFieldCondition(field, { $not: { $type: 'array' } }),
		mongoFieldCondition(field, condition)
	);
}

function mongoNullFieldCondition(field: string): Record<string, any> {
	return mongoOr(mongoFieldCondition(field, { $exists: false }), mongoScalarFieldCondition(field, { $eq: null }));
}

function mongoNotNullFieldCondition(field: string): Record<string, any> {
	return mongoOr(mongoFieldCondition(field, { $type: 'array' }), mongoScalarFieldCondition(field, { $ne: null }));
}

function mongoNotEqualFieldCondition(field: string, value: unknown): Record<string, any> {
	return mongoOr(
		mongoFieldCondition(field, { $type: 'array' }),
		mongoScalarFieldCondition(field, { $ne: value })
	);
}

function mongoAnd(...conditions: Array<Record<string, any>>): Record<string, any> {
	if (conditions.length === 1) return conditions[0];
	return { $and: conditions };
}

function mongoOr(...conditions: Array<Record<string, any>>): Record<string, any> {
	if (conditions.length === 1) return conditions[0];
	return { $or: conditions };
}

function mongoFieldCondition(field: string, condition: any): Record<string, any> {
	const filter: Record<string, any> = {};
	defineDataProperty(filter, field, condition, { enumerable: true, configurable: true, writable: true });
	return filter;
}

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

function entityIdKeyArray(ids: readonly EntityId[]) {
	const keys: string[] = [];
	for (let index = 0; index < ids.length; index++) keys[index] = entityIdKey(ids[index]);
	return keys;
}

function mongoProjection(fields: readonly string[], includeStorageKey = true) {
	const projection: Record<string, 1> = {};
	for (let index = 0; index < fields.length; index++) {
		defineDataProperty(projection, assertSafeMongoField(fields[index]), 1, {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	if (includeStorageKey) {
		defineDataProperty(projection, '_id', 1, {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return projection;
}

function mongoQueryDocumentsData(list: readonly unknown[], model: ResolvedModelMeta) {
	const rows: any[] = [];
	for (let index = 0; index < list.length; index++) rows[index] = mongoQueryDocumentData(list[index], model);
	return rows;
}

function mongoSortSpec(sort: QueryPlan['sort']) {
	const spec: Record<string, 1 | -1> = {};
	for (let index = 0; index < sort.length; index++) {
		const item = sort[index];
		defineDataProperty(spec, assertSafeMongoField(item.field), item.direction === 'asc' ? 1 : -1, {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return spec;
}

function aggregateNeedsPortableFallback(specs: readonly AggregateSpec[]) {
	for (let index = 0; index < specs.length; index++) {
		const op = specs[index].op;
		if (op === 'min' || op === 'max') return true;
	}
	return false;
}

function aggregateFields(specs: readonly AggregateSpec[]) {
	const fields: string[] = [];
	for (let index = 0; index < specs.length; index++) {
		const field = specs[index].field;
		if (field) fields[fields.length] = field;
	}
	return uniqueStrings(fields);
}

function mongoAggregateGroup(specs: readonly AggregateSpec[], invalidAliases: Map<string, AggregateSpec>) {
	const group: Record<string, unknown> = { _id: null };
	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index];
		defineDataProperty(group, spec.as, aggregateExpression(spec), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	for (const [alias, spec] of invalidAliases) {
		defineDataProperty(group, alias, numericAggregateInvalidExpression(spec), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return group;
}

function mongoIndexFields(fields: readonly string[]) {
	const result: string[] = [];
	for (let index = 0; index < fields.length; index++) result[index] = assertSafeMongoField(fields[index]);
	return result;
}

function mongoIndexKeySpec(fields: readonly string[], directions?: readonly SortDirection[]) {
	const spec: Record<string, 1 | -1> = {};
	for (let index = 0; index < fields.length; index++) {
		defineDataProperty(spec, assertSafeMongoField(fields[index]), directions?.[index] === 'desc' ? -1 : 1, {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return spec;
}

function mongoExistingIndexes(indexes: readonly unknown[]) {
	const result = new Map<string, unknown>();
	for (let index = 0; index < indexes.length; index++) {
		const item = indexes[index];
		const name = mongoDocumentValue(item, 'name', 'MongoDB index');
		if (name === undefined) continue;
		MAP_SET.call(result, mongoOptionalString(name, 'MongoDB index.name'), item);
	}
	return result;
}

function mongoIndexFieldsMatch(existing: readonly string[], declared: readonly string[]) {
	if (existing.length !== declared.length) return false;
	for (let index = 0; index < existing.length; index++) {
		if (existing[index] !== declared[index]) return false;
	}
	return true;
}

function mongoIndexDirectionsMatch(existing: readonly SortDirection[] | undefined, declared: readonly SortDirection[] | undefined, fieldCount: number) {
	for (let index = 0; index < fieldCount; index++) {
		if ((existing?.[index] ?? 'asc') !== (declared?.[index] ?? 'asc')) return false;
	}
	return true;
}

function aggregateExpression(spec: AggregateSpec) {
	if (spec.op === 'count') return { $sum: 1 };
	const field = `$${assertSafeMongoField(spec.field!)}`;
	if (spec.op === 'sum') return { $sum: field };
	if (spec.op === 'avg') return { $avg: field };
	if (spec.op === 'min') return { $min: field };
	return { $max: field };
}

function numericAggregateInvalidAliases(specs: AggregateSpec[]) {
	const reserved = new Set<string>();
	for (const spec of specs) SET_ADD.call(reserved, spec.as);
	const aliases = new Map<string, AggregateSpec>();
	for (const spec of specs) {
		if (spec.op !== 'sum' && spec.op !== 'avg') continue;
		let alias = `__activeTsInvalid_${spec.as}`;
		while (SET_HAS.call(reserved, alias)) alias = `_${alias}`;
		SET_ADD.call(reserved, alias);
		MAP_SET.call(aliases, alias, spec);
	}
	return aliases;
}

function numericAggregateInvalidExpression(spec: AggregateSpec) {
	const field = `$${assertSafeMongoField(spec.field!)}`;
	return {
		$sum: {
			$cond: [
				{
					$and: [
						{ $ne: [field, null] },
						{ $not: [{ $isNumber: field }] }
					]
				},
				1,
				0
			]
		}
	};
}

function assertNoInvalidNumericAggregateRows(row: unknown, aliases: Map<string, AggregateSpec>) {
	if (row === undefined || MAP_SIZE.call(aliases) === 0) return;
	for (const [alias, spec] of aliases) {
		const value = mongoDocumentValue(row, alias, 'MongoDB aggregate');
		if (value === undefined || value === 0) continue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ActiveTsValidationError(`MongoDB aggregate invalid numeric row counter "${alias}" must be a finite number.`);
		}
		throw new ActiveTsValidationError(`Aggregate "${spec.as}" expected numeric values in field "${spec.field}".`);
	}
}

function assertMongoNativeFunction(plan: QueryPlan | AggregatePlan) {
	if (plan.native === undefined) return undefined;
	if (typeof plan.native.payload === 'function') return plan.native.payload;
	throw new ActiveTsValidationError('MongoDB native payload must be a function.');
}

function assertMongoSortableFieldsDeclared(model: ResolvedModelMeta, plan: Pick<QueryPlan, 'sort'>) {
	for (const sort of plan.sort) {
		if (sort.field === model.idField || MAP_HAS.call(model.fieldTypes, sort.field)) continue;
		throw new ActiveTsConfigurationError(
			`MongoDB adapter requires fieldType metadata for portable sort("${sort.field}") because MongoDB native ordering can diverge for missing, null, or mixed-type values.`
		);
	}
}

export async function createMongoStoreAdapter(options: MongoStoreOptions): Promise<MongoStoreAdapter> {
	options = validateMongoOptions(options);
	const mod = options.client ? undefined : await optionalImport('mongodb', 'MongoStoreAdapter');
	const MongoClient = mod?.MongoClient;
	const client = normalizeMongoClient(options.client ?? new MongoClient(options.url ?? 'mongodb://127.0.0.1:27017'));
	const allowAggregateScanFallback = options.allowAggregateScanFallback === true;
	if (!options.client && client.connect) await client.connect();
	const db = normalizeMongoDb(client.db(options.dbName));
	const supportsTransaction = client.startSession !== undefined;

	const createAdapter = (transactionState?: MongoTransactionState): MongoStoreAdapter => {
		const collection = (model: ResolvedModelMeta) => {
			assertSafeMongoModel(model);
			return normalizeMongoCollection(db.collection(assertSafeMongoCollectionName(model.name)), `MongoDB collection "${model.name}"`);
		};
		const idFilter = (model: ResolvedModelMeta, id: EntityId) => {
			assertSafeMongoField(model.idField);
			assertSafeEntityId(id, `${model.name} store id`);
			return { _id: entityIdKey(id) };
		};
		const documentExists = async (model: ResolvedModelMeta, id: EntityId) => {
			const coll = collection(model);
			const row = await mongoMethod(coll, 'findOne', 'MongoDB collection.findOne')(
				idFilter(model, id),
				mongoSessionOptions(transactionState)
			);
			return row !== null && row !== undefined;
		};
		const prepareDocumentData = (model: ResolvedModelMeta, id: EntityId, data: any) => {
			assertSafeMongoField(model.idField);
			assertSafeEntityId(id, `${model.name} store id`);
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertNoMongoStorageKeyField(clean, `${model.name} stored data`);
			assertNoMongoDataKeys(clean, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			return clean;
		};
		const documentFor = (model: ResolvedModelMeta, id: EntityId, data: any) => ({
			...prepareDocumentData(model, id, data),
			_id: entityIdKey(id)
		});

		const adapter: MongoStoreAdapter = {
			kind: 'mongodb',
			cacheScope: options.cacheScope,
			capabilities: Object.freeze({
				or: true,
				contains: false,
				arrayContains: true,
				textContains: false,
				jsonContains: false,
				startsWith: true,
				cursor: false,
				offset: true,
				select: true,
				nestedFields: true,
				numericComparisons: true,
				aggregate: true,
				transaction: transactionState === undefined && supportsTransaction,
				transactionConflictDetection: transactionState === undefined && supportsTransaction,
				savepoint: false,
				uniqueIndex: true,
				optimisticLock: true,
				nullOperators: true,
				missingFieldNulls: true,
				native: transactionState === undefined
			}),
			async get(model, id, options) {
				model = snapshotAdapterModel(model, 'MongoDB model metadata');
				rejectUnsupportedStoreReadOptions(options, 'MongoDB store read options');
				assertSafeEntityId(id, `${model.name} store id`);
				return runMongoOperation(transactionState, async () => {
					const coll = collection(model);
					const row = await mongoMethod(coll, 'findOne', 'MongoDB collection.findOne')(
						idFilter(model, id),
						mongoSessionOptions(transactionState)
					);
					if (row === null || row === undefined) return null;
					return mongoDocumentDataForExpectedId(row, model, id, 'MongoDB document');
				});
			},
			async getMany(model, ids, options) {
				model = snapshotAdapterModel(model, 'MongoDB model metadata');
				rejectUnsupportedStoreReadOptions(options, 'MongoDB store read options');
				ids = assertSafeEntityIdArray(ids, 'MongoDB store ids');
				assertSafeMongoField(model.idField);
				return runMongoOperation(transactionState, async () => {
					const coll = collection(model);
					const cursor = mongoMethod(coll, 'find', 'MongoDB collection.find')(
						{ _id: { $in: entityIdKeyArray(ids) } },
						mongoSessionOptions(transactionState)
					);
					const list = mongoArrayResult(
						await mongoMethod(normalizeMongoCursor(cursor, 'MongoDB find cursor'), 'toArray', 'MongoDB find cursor.toArray')(),
						'MongoDB find cursor.toArray'
					);
					const requested = new Set<string>();
					for (const id of ids) SET_ADD.call(requested, entityIdKey(id));
					const byId = new Map<string, any>();
					for (const item of list) {
						const storageKey = mongoRequiredDocumentStorageKey(item, 'MongoDB getMany document');
						const id = entityIdFromCanonicalKey(storageKey, 'MongoDB getMany document._id');
						const key = entityIdKey(id);
						if (!SET_HAS.call(requested, key)) {
							throw new ActiveTsValidationError('MongoDB getMany document id was not requested.');
						}
						if (MAP_HAS.call(byId, key)) {
							throw new ActiveTsValidationError('MongoDB getMany returned duplicate document ids.');
						}
						const clean = mongoDocumentDataFromStorageId(item, model, id, 'MongoDB getMany document');
						MAP_SET.call(byId, key, clean);
					}
					const result: Array<Record<string, unknown> | null> = [];
					for (let index = 0; index < ids.length; index++) {
						const row = MAP_GET.call(byId, entityIdKey(ids[index]));
						result[index] = row === undefined ? null : cloneSafeDataObject(row, 'MongoDB getMany document');
					}
					return result;
				});
			},
			async query(model, plan, options): Promise<QueryResult> {
				model = snapshotAdapterModel(model, 'MongoDB model metadata');
				plan = normalizeStoreQueryPlan(plan, model.idField, 'MongoDB query plan', {
					limit: 'MongoDB limit',
					offset: 'MongoDB offset',
					whereField: 'MongoDB query field',
					selectField: 'MongoDB select field',
					sortField: 'MongoDB sort field'
				});
				plan = normalizeQueryPlanFieldTypes(model, plan);
				plan = encodeQueryPlanFieldCodecs(model, plan);
				assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
				validateStoreQueryReadOptions(options, plan, 'MongoDB store read options');
				const native = assertMongoNativeFunction(plan);
				if (!native) assertMongoSortableFieldsDeclared(model, plan);
				const projection = plan.select ? mongoProjection(uniqueStrings([model.idField, ...plan.select])) : undefined;
				return runMongoOperation(transactionState, async () => {
					if (native) return normalizeStoreQueryResultForModel(
						model,
						await native({ db, collection: collection(model), model, plan }),
						'MongoDB native function query',
						{ cursor: adapter.capabilities?.cursor, adapterKind: adapter.kind }
					);
					const coll = collection(model);
					let cursor = normalizeMongoCursor(
						mongoMethod(coll, 'find', 'MongoDB collection.find')(
							mongoFilter(plan),
							mongoSessionOptions(
								transactionState,
								projection === undefined ? undefined : { projection }
							)
						),
						'MongoDB find cursor'
					);
					if (plan.sort.length)
						cursor = normalizeMongoCursor(
							mongoMethod(cursor, 'sort', 'MongoDB find cursor.sort')(
								mongoSortSpec(plan.sort)
							),
							'MongoDB sorted cursor'
						);
					if (plan.offset !== undefined)
						cursor = normalizeMongoCursor(
							mongoMethod(cursor, 'skip', 'MongoDB find cursor.skip')(plan.offset),
							'MongoDB skipped cursor'
						);
					if (plan.limit !== undefined)
						cursor = normalizeMongoCursor(
							mongoMethod(cursor, 'limit', 'MongoDB find cursor.limit')(limitWithLookahead(plan.limit, 'MongoDB limit')),
							'MongoDB limited cursor'
						);
					const list = mongoArrayResult(await mongoMethod(cursor, 'toArray', 'MongoDB find cursor.toArray')(), 'MongoDB find cursor.toArray');
					const trimmed = trimLookaheadRows(list, plan.limit, 'MongoDB limit');
					const result: QueryResult = {
						list: mongoQueryDocumentsData(trimmed.rows, model),
						count: trimmed.rows.length,
						more: trimmed.more
					};
					return result;
				});
			},
			async aggregate(model, plan: AggregatePlan) {
				model = snapshotAdapterModel(model, 'MongoDB model metadata');
				plan = normalizeStoreAggregatePlan(plan, 'MongoDB aggregate plan');
				plan = normalizeAggregatePlanFieldTypes(model, plan);
				plan = encodeAggregatePlanFieldCodecs(model, plan);
				assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
				const specs = assertAggregateSpecsCompatibleWithModel(model, plan.aggregates, 'MongoDB aggregate');
				assertNoAggregateFieldCodecSpecs(model, specs, 'MongoDB aggregate');
				const native = assertMongoNativeFunction(plan);
				return runMongoOperation(transactionState, async () => {
					if (native) return normalizeStoreAggregateResult(
						await native({ db, collection: collection(model), model, plan }),
						specs,
						'MongoDB native function aggregate'
					);
					const coll = collection(model);
					if (aggregateNeedsPortableFallback(specs)) {
						if (!allowAggregateScanFallback) {
							throw new ActiveTsConfigurationError(
								'MongoDB aggregate scan fallback requires allowAggregateScanFallback: true.'
							);
						}
						const fields = aggregateFields(specs);
						const projection = mongoProjection(uniqueStrings([model.idField, ...fields]));
						const cursor = normalizeMongoCursor(
							mongoMethod(coll, 'find', 'MongoDB collection.find')(
								mongoFilter({ where: plan.where, or: plan.or }),
								mongoSessionOptions(transactionState, { projection })
							),
							'MongoDB aggregate fallback cursor'
						);
						const list = mongoArrayResult(
							await mongoMethod(cursor, 'toArray', 'MongoDB aggregate fallback cursor.toArray')(),
							'MongoDB aggregate fallback cursor.toArray'
						);
						return aggregateRows(mongoQueryDocumentsData(list, model), specs);
					}
					const invalidAliases = numericAggregateInvalidAliases(specs);
					const cursor = normalizeMongoCursor(
						mongoMethod(coll, 'aggregate', 'MongoDB collection.aggregate')(
							[
								{ $match: mongoFilter({ where: plan.where, or: plan.or }) },
								{
									$group: mongoAggregateGroup(specs, invalidAliases)
								}
							],
							mongoSessionOptions(transactionState)
						),
						'MongoDB aggregate cursor'
					);
					const [row] = mongoArrayResult(
						await mongoMethod(cursor, 'toArray', 'MongoDB aggregate cursor.toArray')(),
						'MongoDB aggregate cursor.toArray'
					);
					assertNoInvalidNumericAggregateRows(row, invalidAliases);
					return normalizeAggregateRow(
						row === undefined ? defaultAggregateResult(specs) : mongoAggregateResultRow(row, invalidAliases),
						specs,
						'MongoDB aggregate'
					);
				});
			},
			async create(model, id, data, options = {}) {
				model = snapshotAdapterModel(model, 'MongoDB model metadata');
				rejectUnsupportedStoreWriteOptions(options, 'MongoDB store create options');
				assertSafeEntityId(id, `${model.name} store id`);
				assertSafeMongoModel(model);
				assertMongoTransactionWritable(transactionState, 'create');
				const document = documentFor(model, id, data);
				return runMongoOperation(transactionState, async () => {
					try {
						const coll = collection(model);
						await mongoMethod(coll, 'insertOne', 'MongoDB collection.insertOne')(
							document,
							mongoSessionOptions(transactionState)
						);
					} catch (error) {
						if (mongoErrorCode(error) === 11000) {
							throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
						}
						throw error;
					}
				});
			},
			async update(model, id, data, options = {}) {
				model = snapshotAdapterModel(model, 'MongoDB model metadata');
				assertSafeEntityId(id, `${model.name} store id`);
				assertMongoTransactionWritable(transactionState, 'update');
				options = rejectUnsupportedStoreWriteMetadata(
					normalizeStoreWriteOptions(options, 'MongoDB store write options'),
					'MongoDB store write options'
				);
				const filter =
					options.expectedVersion === undefined
						? idFilter(model, id)
						: mongoAnd(idFilter(model, id), mongoScalarFieldCondition('version', { $eq: options.expectedVersion }));
				const document = documentFor(model, id, data);
				return runMongoOperation(transactionState, async () => {
					const coll = collection(model);
					const res = await mongoMethod(coll, 'replaceOne', 'MongoDB collection.replaceOne')(
						filter,
						document,
						mongoSessionOptions(transactionState, { upsert: false })
					);
					const matchedCount = mongoMatchedCount(res, 'MongoDB replaceOne');
					if (matchedCount === 0 && options.expectedVersion !== undefined) {
						if (!await documentExists(model, id)) {
							throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
						}
						throw new ActiveTsConflictError(
							`Optimistic lock failed for ${model.name}:${String(id)}. Expected version ${options.expectedVersion}.`
						);
					}
					if (matchedCount === 0) {
						throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
					}
				});
			},
			async delete(model, id, options = {}) {
				model = snapshotAdapterModel(model, 'MongoDB model metadata');
				assertSafeEntityId(id, `${model.name} store id`);
				assertMongoTransactionWritable(transactionState, 'delete');
				options = rejectUnsupportedStoreWriteMetadata(
					normalizeStoreWriteOptions(options, 'MongoDB store delete options'),
					'MongoDB store delete options'
				);
				const coll = collection(model);
				const filter =
					options.expectedVersion === undefined
						? idFilter(model, id)
						: mongoAnd(idFilter(model, id), mongoScalarFieldCondition('version', { $eq: options.expectedVersion }));
				return runMongoOperation(transactionState, async () => {
					const res = await mongoMethod(coll, 'deleteOne', 'MongoDB collection.deleteOne')(
						filter,
						mongoSessionOptions(transactionState)
					);
					const deletedCount = mongoDeletedCount(res, 'MongoDB deleteOne');
					if (options.expectedVersion !== undefined && deletedCount === 0) {
						if (!await documentExists(model, id)) {
							throw new ActiveTsNotFoundError(`Cannot delete ${model.name}:${String(id)} because it does not exist.`);
						}
						throw new ActiveTsConflictError(
							`Optimistic lock failed for ${model.name}:${String(id)}. Expected version ${options.expectedVersion}.`
						);
					}
				});
			},
			transaction: transactionState === undefined && client.startSession ? async (fn, transactionOptions) => {
				if (typeof fn !== 'function') {
					throw new ActiveTsConfigurationError('MongoDB transaction callback must be a function.');
				}
				const txOptions = normalizeMongoTransactionOptions(transactionOptions);
				const rawSession = await client.startSession(
					txOptions.timeoutMs === undefined ? undefined : { defaultTimeoutMS: txOptions.timeoutMs }
				);
				let session: NormalizedMongoClientSession;
				try {
					session = normalizeMongoClientSession(rawSession);
				} catch (error) {
					try {
						if (rawSession && typeof rawSession === 'object' && !Array.isArray(rawSession)) {
							const endSession = optionalMongoMethod(
								rawSession,
								'endSession',
								'MongoDB session.endSession'
							);
							if (endSession) await endSession();
						}
					} catch (endError) {
						if (error && (typeof error === 'object' || typeof error === 'function')) {
							try {
								defineDataProperty(error, 'sessionEndError', endError, {
									enumerable: false,
									configurable: true
								});
							} catch {
								// Preserve the session contract error when it cannot be extended.
							}
						}
					}
					throw error;
				}
				const finalizationOptions = txOptions.timeoutMs === undefined
					? undefined
					: { timeoutMS: txOptions.timeoutMs };
				let result!: Awaited<ReturnType<typeof fn>>;
				let primaryFailure: { error: unknown } | undefined;
				let transactionStarted = false;
				let commitDispatched = false;
				let committed = false;
				let closed: string | undefined;
				try {
					await session.startTransaction(txOptions.native);
					transactionStarted = true;
					let operationTail = Promise.resolve();
					const state: MongoTransactionState = {
						session,
						readOnly: txOptions.readOnly === true,
						run: <T>(operation: () => Promise<T>) => {
							const queued = operationTail.then(operation, operation);
							operationTail = queued.then(() => undefined, () => undefined);
							return queued;
						}
					};
					const guarded = createCloseGuardedStoreAdapter(
						createAdapter(state),
						() => closed,
						'MongoDB store'
					);
					try {
						result = await fn(guarded.adapter);
						closed = 'callback finished';
						await guarded.waitForPendingOperations();
					} catch (error) {
						closed = 'rollback';
						try {
							await guarded.waitForPendingOperations();
						} catch {
							// Preserve the callback or tracked operation error that triggered rollback.
						}
						throw error;
					}
					commitDispatched = true;
					await session.commitTransaction(finalizationOptions);
					committed = true;
					closed = 'commit';
				} catch (error) {
					if (commitDispatched) {
						if (isMongoUnknownTransactionCommitResult(error)) {
							primaryFailure = {
								error: markTransactionRollbackSkipped(
									new ActiveTsUnknownTransactionOutcomeError(
										`MongoDB transaction commit outcome is unknown: ${safeErrorMessage(error)}`,
										'commit',
										error
									)
								)
							};
							closed = 'failed';
						} else {
							primaryFailure = { error: normalizeMongoTransactionConflict(error) };
							closed = 'rollback';
						}
					} else if (transactionStarted) {
						try {
							await session.abortTransaction(finalizationOptions);
							closed = 'rollback';
						} catch (abortError) {
							primaryFailure = {
								error: markTransactionRollbackSkipped(
									new ActiveTsUnknownTransactionOutcomeError(
										`MongoDB transaction failed and abort outcome is unknown: ${safeErrorMessage(error)}`,
										'abort',
										new AggregateError([error, abortError], 'MongoDB transaction callback and abort both failed.')
									)
								)
							};
							closed = 'failed';
						}
					}
					primaryFailure ??= { error };
				}
				try {
					await session.endSession();
				} catch (endError) {
					if (primaryFailure !== undefined) {
						const primaryError = primaryFailure.error;
						if (primaryError && (typeof primaryError === 'object' || typeof primaryError === 'function')) {
							try {
								defineDataProperty(primaryError, 'sessionEndError', endError, {
									enumerable: false,
									configurable: true
								});
							} catch {
								// Preserve the transaction outcome when the primary error is not extensible.
							}
						}
					} else if (committed) {
						throw new ActiveTsCommittedTransactionError(
							`MongoDB transaction committed but ending its session failed: ${safeErrorMessage(endError)}`,
							endError,
							result
						);
					} else {
						primaryFailure = { error: endError };
					}
				}
				if (primaryFailure !== undefined) throw primaryFailure.error;
				return result;
			} : undefined,
			schema: transactionState === undefined && db.listCollections && db.createCollection ? {
				async plan(models): Promise<SchemaPlan> {
					models = normalizeSchemaModels(models, 'MongoDB schema models');
					const existing = new Map<string, MongoCollectionDefinition>();
					for (const collectionInfo of mongoArrayResult(await mongoMethod(
							normalizeMongoCursor(
								mongoMethod(db, 'listCollections', 'MongoDB db.listCollections')(),
								'MongoDB listCollections cursor'
							),
							'toArray',
							'MongoDB listCollections cursor.toArray'
						)(), 'MongoDB listCollections cursor.toArray')) {
						const collection = mongoCollectionDefinition(collectionInfo);
						MAP_SET.call(existing, collection.name, collection);
					}
					const changes: SchemaPlan['changes'] = [];
					for (const model of models) {
						const existingCollection = MAP_GET.call(existing, model.name) as MongoCollectionDefinition | undefined;
						if (existingCollection && !mongoCollectionKindWritable(existingCollection)) {
							throw new ActiveTsConfigurationError(
								`MongoDB collection "${model.name}" exists as ${existingCollection.type}; expected collection.`
							);
						}
						const collectionExists = existingCollection !== undefined;
						if (!collectionExists) changes.push({ type: 'create-collection', target: model.name });
						const existingIndexes = collectionExists
							? mongoExistingIndexes(
								mongoArrayResult(
									await mongoMethod(collection(model), 'indexes', 'MongoDB collection.indexes')(),
									'MongoDB collection.indexes'
								)
							)
							: new Map<string, unknown>();
						for (const index of model.indexes) {
							const fields = mongoIndexFields(index.fields);
							const directions = index.directions;
							const existingIndex = MAP_GET.call(existingIndexes, index.name);
							if (MAP_HAS.call(existingIndexes, index.name)) {
								assertMongoIndexDefinitionMatches(
									model,
									index.name,
									fields,
									directions,
									Boolean(index.unique),
									mongoIndexDefinition(existingIndex)
								);
								continue;
							}
							changes.push({
								type: 'create-index',
								target: model.name,
								name: index.name,
								fields,
								...(directions === undefined ? {} : { directions }),
								unique: index.unique
							});
						}
					}
					return {
						adapter: 'mongodb',
						changes
					};
				},
				async apply(models, applyOptions): Promise<SchemaPlan> {
					normalizeStoreSchemaApplyOptions(applyOptions, 'MongoDB schema apply options');
					const safeModels = normalizeSchemaModels(models, 'MongoDB schema models');
					const plan = await adapter.schema!.plan(safeModels);
					for (const model of safeModels) {
						await mongoMethod(db, 'createCollection', 'MongoDB db.createCollection')(
							assertSafeMongoCollectionName(model.name)
						).catch((error: unknown) => {
							if (isMongoNamespaceExistsError(error)) return undefined;
							throw error;
						});
						for (const index of model.indexes) {
							const options: { name: string; unique?: true } = { name: assertSafeMongoIndexName(index.name) };
							if (index.unique === true) options.unique = true;
							await mongoMethod(collection(model), 'createIndex', 'MongoDB collection.createIndex')(
								mongoIndexKeySpec(index.fields, index.directions),
								options
							);
						}
					}
					return plan;
				}
			} : undefined
		};
		return adapter;
	};
	return createAdapter();
}

type MongoIndexDefinition = {
	fields?: string[];
	directions?: SortDirection[];
	unique?: boolean;
	unsupportedOptions: string[];
};
type MongoCollectionDefinition = {
	name: string;
	type?: string;
};
const MONGO_SUPPORTED_INDEX_METADATA = ['v', 'key', 'name', 'unique'] as const;

function mongoCollectionDefinition(collection: unknown): MongoCollectionDefinition {
	const name = mongoDocumentValue(collection, 'name', 'MongoDB collection');
	const type = mongoDocumentValue(collection, 'type', 'MongoDB collection');
	if (type !== undefined && typeof type !== 'string') {
		throw new ActiveTsValidationError('MongoDB collection.type must be a string.');
	}
	return {
		name: mongoOptionalString(name, 'MongoDB collection.name'),
		type
	};
}

function mongoCollectionKindWritable(collection: MongoCollectionDefinition) {
	return collection.type === undefined || collection.type === 'collection';
}

function mongoIndexDefinition(index: unknown): MongoIndexDefinition {
	const key = mongoDocumentValue(index, 'key', 'MongoDB index');
	const unique = mongoDocumentValue(index, 'unique', 'MongoDB index');
	if (unique !== undefined && typeof unique !== 'boolean') {
		throw new ActiveTsValidationError('MongoDB index.unique must be a boolean.');
	}
	return {
		...(key === undefined ? {} : mongoIndexKeyFields(key)),
		unique: unique === undefined ? undefined : unique,
		unsupportedOptions: mongoUnsupportedIndexOptions(index)
	};
}

function mongoUnsupportedIndexOptions(index: unknown) {
	if (!index || typeof index !== 'object' || Array.isArray(index)) {
		throw new ActiveTsValidationError('MongoDB index must be a plain object.');
	}
	const unsupported: string[] = [];
	for (const property of Object.getOwnPropertyNames(index)) {
		const descriptor = Object.getOwnPropertyDescriptor(index, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`MongoDB index.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`MongoDB index.${property} must be enumerable.`);
		}
		if (mongoIndexMetadataSupported(property)) continue;
		unsupported[unsupported.length] = property;
	}
	return unsupported;
}

function mongoIndexMetadataSupported(property: string) {
	for (let index = 0; index < MONGO_SUPPORTED_INDEX_METADATA.length; index++) {
		if (MONGO_SUPPORTED_INDEX_METADATA[index] === property) return true;
	}
	return false;
}

function mongoIndexKeyFields(key: unknown) {
	if (!key || typeof key !== 'object' || Array.isArray(key)) {
		throw new ActiveTsValidationError('MongoDB index.key must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(key);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('MongoDB index.key must be a plain object.');
	}
	if (Object.getOwnPropertySymbols(key).length) {
		throw new ActiveTsValidationError('MongoDB index.key cannot contain symbol fields.');
	}
	const fields: string[] = [];
	const directions: SortDirection[] = [];
	for (const property of Object.getOwnPropertyNames(key)) {
		const descriptor = Object.getOwnPropertyDescriptor(key, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`MongoDB index.key.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`MongoDB index.key.${property} must be enumerable.`);
		}
		if (descriptor.value !== 1 && descriptor.value !== -1) {
			throw new ActiveTsValidationError(`MongoDB index.key.${property} must be 1 or -1.`);
		}
		fields.push(assertSafeMongoField(property));
		directions[directions.length] = descriptor.value === -1 ? 'desc' : 'asc';
	}
	return { fields, directions };
}

function assertMongoIndexDefinitionMatches(
	model: ResolvedModelMeta,
	name: string,
	fields: string[],
	directions: readonly SortDirection[] | undefined,
	unique: boolean,
	existing: MongoIndexDefinition | undefined
) {
	if (!existing?.fields) {
		throw new ActiveTsConfigurationError(
			`MongoDB index "${name}" on "${model.name}" is missing key metadata.`
		);
	}
	const existingUnique = existing.unique === true;
	if (
		existingUnique !== unique ||
		existing.unsupportedOptions.length ||
		!mongoIndexFieldsMatch(existing.fields, fields) ||
		!mongoIndexDirectionsMatch(existing.directions, directions, fields.length)
	) {
		throw new ActiveTsConfigurationError(
			`MongoDB index "${name}" on "${model.name}" does not match declared fields or uniqueness.`
		);
	}
}

function mongoDocumentValue(document: unknown, key: string, context: string) {
	if (!document || typeof document !== 'object' || Array.isArray(document)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	return ownOptionValue(document as Record<string, unknown>, key);
}

function mongoOptionalString(value: unknown, context: string) {
	if (typeof value !== 'string') {
		throw new ActiveTsValidationError(`${context} must be a string.`);
	}
	return value;
}

function assertNoMongoStorageKeyField(data: Record<string, unknown>, context: string) {
	if (Object.prototype.hasOwnProperty.call(data, '_id')) {
		throw new ActiveTsValidationError(`${context} cannot contain MongoDB storage field "_id".`);
	}
}

function assertNoMongoDataKeys(value: unknown, context: string, seen = new WeakSet<object>()) {
	if (value === null || typeof value !== 'object') return;
	if (WEAKSET_HAS.call(seen, value)) return;
	WEAKSET_ADD.call(seen, value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				assertNoMongoDataKeys(value[index], `${context}[${index}]`, seen);
			}
			return;
		}
		for (const key of Object.keys(value)) {
			if (key.startsWith('$') || key.includes('.')) {
				throw new ActiveTsValidationError(`${context} cannot contain MongoDB field "${key}".`);
			}
			assertNoMongoDataKeys((value as Record<string, unknown>)[key], `${context}.${key}`, seen);
		}
	} finally {
		WEAKSET_DELETE.call(seen, value);
	}
}

function mongoRequiredDocumentValue(document: unknown, key: string, context: string) {
	const value = mongoDocumentValue(document, key, context);
	if (value === undefined) {
		throw new ActiveTsValidationError(`${context}.${key} is required.`);
	}
	return value;
}

function mongoRequiredDocumentStorageKey(document: unknown, context: string) {
	const storageKey = mongoRequiredDocumentValue(document, '_id', context);
	if (typeof storageKey !== 'string') {
		throw new ActiveTsValidationError(`${context}._id must be a string.`);
	}
	entityIdFromCanonicalKey(storageKey, `${context}._id`);
	return storageKey;
}

function mongoDocumentDataForExpectedId(
	document: unknown,
	model: ResolvedModelMeta,
	expectedId: EntityId,
	context: string
) {
	const storageKey = mongoRequiredDocumentStorageKey(document, context);
	if (storageKey !== entityIdKey(expectedId)) {
		throw new ActiveTsValidationError(`${context}._id must match the requested id.`);
	}
	return mongoDocumentDataFromStorageId(document, model, expectedId, context);
}

function mongoDocumentDataFromStorageId(
	document: unknown,
	model: ResolvedModelMeta,
	id: EntityId,
	context: string
) {
	const clean = cloneSafeDataObject(document, context);
	delete clean._id;
	assertNoMongoDataKeys(clean, context);
	assertStoreDataMatchesId(model, id, clean, context);
	return clean;
}

function mongoQueryDocumentData(document: unknown, model: ResolvedModelMeta) {
	const storageKey = mongoRequiredDocumentStorageKey(document, 'MongoDB query document');
	const rowId = entityIdFromCanonicalKey(storageKey, 'MongoDB query document._id');
	return mongoDocumentDataFromStorageId(document, model, rowId, 'MongoDB query document');
}

function mongoArrayResult(value: unknown, context: string) {
	if (!Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} result must be an array.`);
	}
	return snapshotArrayInput(value, `${context} result`);
}

function mongoAggregateResultRow(row: unknown, invalidAliases: Map<string, AggregateSpec>) {
	if (!row || typeof row !== 'object' || Array.isArray(row)) {
		throw new ActiveTsValidationError('MongoDB aggregate result must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(row);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('MongoDB aggregate result must be a plain object.');
	}
	if (Object.getOwnPropertySymbols(row).length) {
		throw new ActiveTsValidationError('MongoDB aggregate result cannot contain symbol fields.');
	}
	const clean: Record<string, unknown> = {};
	for (const property of Object.getOwnPropertyNames(row)) {
		const descriptor = Object.getOwnPropertyDescriptor(row, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`MongoDB aggregate result.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`MongoDB aggregate result.${property} must be enumerable.`);
		}
		if (property === '_id') {
			if (descriptor.value !== null) {
				throw new ActiveTsValidationError('MongoDB aggregate result._id must be null.');
			}
			continue;
		}
		if (MAP_HAS.call(invalidAliases, property)) continue;
		defineDataProperty(clean, property, descriptor.value, {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return clean;
}

function mongoMatchedCount(result: unknown, context: string) {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		throw new ActiveTsValidationError(`${context} result must be an object.`);
	}
	const matchedCount = ownOptionValue(result as Record<string, unknown>, 'matchedCount');
	if (matchedCount === undefined) {
		throw new ActiveTsValidationError(`${context}.matchedCount is required.`);
	}
	if (typeof matchedCount !== 'number' || !Number.isSafeInteger(matchedCount) || matchedCount < 0) {
		throw new ActiveTsValidationError(`${context}.matchedCount must be a non-negative safe integer.`);
	}
	return matchedCount;
}

function mongoDeletedCount(result: unknown, context: string) {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		throw new ActiveTsValidationError(`${context} result must be an object.`);
	}
	const deletedCount = ownOptionValue(result as Record<string, unknown>, 'deletedCount');
	if (deletedCount === undefined) {
		throw new ActiveTsValidationError(`${context}.deletedCount is required.`);
	}
	if (typeof deletedCount !== 'number' || !Number.isSafeInteger(deletedCount) || deletedCount < 0) {
		throw new ActiveTsValidationError(`${context}.deletedCount must be a non-negative safe integer.`);
	}
	return deletedCount;
}

function mongoErrorCode(error: unknown) {
	const code = ownErrorValue(error, 'code');
	return typeof code === 'number' ? code : undefined;
}

function mongoErrorHasLabel(error: unknown, label: string) {
	if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
	let prototype: object | null = error;
	try {
		for (let depth = 0; prototype !== null && depth < 16; depth++) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, 'hasErrorLabel');
			if (descriptor !== undefined) {
				if ('value' in descriptor && typeof descriptor.value === 'function') {
					try {
						if (descriptor.value.call(error, label) === true) return true;
					} catch {
						// Fall back to inert label data when a malformed method throws.
					}
				}
				break;
			}
			prototype = Object.getPrototypeOf(prototype);
		}
	} catch {
		// Error classification must not propagate hostile prototype traps.
	}
	const labelSet = ownErrorValue(error, 'errorLabelSet');
	try {
		if (SET_HAS.call(labelSet as Set<unknown>, label)) return true;
	} catch {
		// Non-Set values, including proxies, are not trusted as driver label sets.
	}
	const labels = ownErrorValue(error, 'errorLabels');
	if (!Array.isArray(labels)) return false;
	try {
		for (const property of Object.getOwnPropertyNames(labels)) {
			if (property === 'length') continue;
			const descriptor = Object.getOwnPropertyDescriptor(labels, property);
			if (descriptor && 'value' in descriptor && descriptor.value === label) return true;
		}
	} catch {
		// Error classification must not execute or propagate hostile collection traps.
	}
	return false;
}

function isMongoUnknownTransactionCommitResult(error: unknown) {
	return mongoErrorHasLabel(error, 'UnknownTransactionCommitResult');
}

function isMongoTransactionConflict(error: unknown) {
	if (mongoErrorHasLabel(error, 'TransientTransactionError')) return true;
	const code = mongoErrorCode(error);
	return code === 112 || code === 251;
}

function normalizeMongoTransactionConflict(error: unknown) {
	if (!isMongoTransactionConflict(error)) return error;
	const conflict = new ActiveTsConflictError(`MongoDB transaction conflicted: ${safeErrorMessage(error)}`);
	defineDataProperty(conflict, 'cause', error, {
		enumerable: false,
		configurable: true
	});
	return conflict;
}

function isMongoNamespaceExistsError(error: unknown) {
	const code = mongoErrorCode(error);
	if (code === 48) return true;
	if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
	const codeName = ownErrorValue(error, 'codeName');
	return codeName === 'NamespaceExists';
}

function normalizeMongoTransactionOptions(options: unknown) {
	const normalized = normalizeStoreTransactionOptions(
		snapshotMongoTransactionNativeInstances(options),
		'MongoDB transaction options'
	);
	if (normalized.isolation !== undefined) {
		throw new ActiveTsConfigurationError('MongoDB transaction options.isolation is not supported.');
	}
	let native: MongoTransactionNativeOptions | undefined;
	if (normalized.native !== undefined) {
		if (!normalized.native || typeof normalized.native !== 'object' || Array.isArray(normalized.native)) {
			throw new ActiveTsConfigurationError('MongoDB transaction options.native must be a plain object.');
		}
		assertPlainFactoryOptions(normalized.native, 'MongoDB transaction options.native');
		native = normalized.native as MongoTransactionNativeOptions;
		assertNoSymbolOptions(native as Record<string, unknown>, 'MongoDB transaction options.native');
		assertKnownOptions(
			native as Record<string, unknown>,
			MONGO_TRANSACTION_NATIVE_OPTION_KEYS,
			'MongoDB transaction options.native'
		);
		const maxCommitTimeMS = ownFactoryOptionValue(
			native as Record<string, unknown>,
			'maxCommitTimeMS',
			'MongoDB transaction native option'
		);
		if (maxCommitTimeMS !== undefined) {
			assertSafeLimit(maxCommitTimeMS as number, 'MongoDB transaction options.native.maxCommitTimeMS');
		}
	}
	return {
		readOnly: normalized.readOnly,
		timeoutMs: normalized.timeoutMs,
		native
	};
}

function snapshotMongoTransactionNativeInstances(options: unknown): unknown {
	if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
	const optionsPrototype = Object.getPrototypeOf(options);
	if (optionsPrototype !== Object.prototype && optionsPrototype !== null) return options;
	const nativeDescriptor = Object.getOwnPropertyDescriptor(options, 'native');
	if (!nativeDescriptor || !('value' in nativeDescriptor) || nativeDescriptor.value === undefined) return options;
	const native = nativeDescriptor.value;
	if (!native || typeof native !== 'object' || Array.isArray(native)) return options;
	const nativePrototype = Object.getPrototypeOf(native);
	if (nativePrototype !== Object.prototype && nativePrototype !== null) return options;

	const descriptors = Object.getOwnPropertyDescriptors(native);
	let changed = false;
	for (const key of ['readConcern', 'writeConcern', 'readPreference'] as const) {
		const descriptor = descriptors[key];
		if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) continue;
		const value = descriptor.value;
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		const prototype = Object.getPrototypeOf(value);
		if (prototype === Object.prototype || prototype === null) continue;
		const allowedKeys = key === 'readConcern'
			? MONGO_READ_CONCERN_KEYS
			: key === 'writeConcern'
				? MONGO_WRITE_CONCERN_KEYS
				: MONGO_READ_PREFERENCE_KEYS;
		descriptors[key] = {
			...descriptor,
			value: snapshotMongoDriverOption(value, allowedKeys, `MongoDB transaction options.native.${key}`)
		};
		changed = true;
	}
	if (!changed) return options;

	const nativeSnapshot = Object.create(nativePrototype);
	Object.defineProperties(nativeSnapshot, descriptors);
	const optionDescriptors = Object.getOwnPropertyDescriptors(options);
	optionDescriptors.native = { ...nativeDescriptor, value: nativeSnapshot };
	const optionsSnapshot = Object.create(optionsPrototype);
	Object.defineProperties(optionsSnapshot, optionDescriptors);
	return optionsSnapshot;
}

function snapshotMongoDriverOption(
	value: object,
	allowedKeys: readonly string[],
	context: string
): Record<string, unknown> {
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const allowed = new Set<string>(allowedKeys);
	const snapshot: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(value)) {
		if (!allowed.has(key)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${key}".`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
		if (descriptor.value !== undefined) snapshot[key] = descriptor.value;
	}
	return snapshot;
}

function runMongoOperation<T>(
	transactionState: MongoTransactionState | undefined,
	operation: () => Promise<T>
): Promise<T> {
	if (!transactionState) return operation();
	return (async () => {
		try {
			return await transactionState.run(operation);
		} catch (error) {
			throw normalizeMongoTransactionConflict(error);
		}
	})();
}

function mongoSessionOptions(
	transactionState: MongoTransactionState | undefined,
	options?: Record<string, unknown>
) {
	if (!transactionState) return options;
	return {
		...(options ?? {}),
		session: transactionState.session.raw
	};
}

function assertMongoTransactionWritable(
	transactionState: MongoTransactionState | undefined,
	operation: string
) {
	if (transactionState?.readOnly !== true) return;
	throw new ActiveTsConfigurationError(`Cannot ${operation} in a read-only MongoDB transaction.`);
}

function validateMongoOptions(options: MongoStoreOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('MongoDB adapter options must be an object.');
	}
	assertPlainFactoryOptions(options, 'MongoDB adapter options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'MongoDB adapter options');
	assertKnownOptions(record, MONGO_OPTION_KEYS, 'MongoDB adapter options');
	const dbName = ownFactoryOptionValue(record, 'dbName', 'MongoDB adapter option');
	const url = ownFactoryOptionValue(record, 'url', 'MongoDB adapter option');
	const client = ownFactoryOptionValue(record, 'client', 'MongoDB adapter option');
	const cacheScope = ownFactoryOptionValue(record, 'cacheScope', 'MongoDB adapter option');
	const allowAggregateScanFallback = ownFactoryOptionValue(record, 'allowAggregateScanFallback', 'MongoDB adapter option');
	if (typeof dbName !== 'string' || !dbName || dbName.includes('\0')) {
		throw new ActiveTsConfigurationError('MongoDB adapter dbName must be a non-empty string without null bytes.');
	}
	if (url !== undefined && typeof url !== 'string') {
		throw new ActiveTsConfigurationError('MongoDB adapter url must be a string.');
	}
	if (client !== undefined && url !== undefined) {
		throw new ActiveTsConfigurationError('MongoDB adapter options cannot combine client and url.');
	}
	if (cacheScope !== undefined && (typeof cacheScope !== 'string' || !cacheScope || cacheScope.includes('\0'))) {
		throw new ActiveTsConfigurationError(
			'MongoDB adapter cacheScope must be a non-empty string without null bytes.'
		);
	}
	if (client !== undefined) {
		normalizeMongoClient(client);
	}
	if (allowAggregateScanFallback !== undefined && typeof allowAggregateScanFallback !== 'boolean') {
		throw new ActiveTsConfigurationError('MongoDB adapter allowAggregateScanFallback must be a boolean.');
	}
	return { dbName, url, client, cacheScope, allowAggregateScanFallback } as MongoStoreOptions;
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

function normalizeMongoClient(client: unknown) {
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsConfigurationError('MongoDB adapter client must be an object.');
	}
	const db = mongoMethod(client, 'db', 'MongoDB adapter client.db');
	const connectValue = mongoMember(client, 'connect', 'MongoDB adapter client.connect', { requireEnumerableOwn: true });
	if (connectValue !== undefined && typeof connectValue !== 'function') {
		throw new ActiveTsConfigurationError('MongoDB adapter client.connect must be a function.');
	}
	const startSessionValue = mongoMember(client, 'startSession', 'MongoDB adapter client.startSession', { requireEnumerableOwn: true });
	if (startSessionValue !== undefined && typeof startSessionValue !== 'function') {
		throw new ActiveTsConfigurationError('MongoDB adapter client.startSession must be a function.');
	}
	const connect = typeof connectValue === 'function' ? connectValue.bind(client) : undefined;
	const startSession = typeof startSessionValue === 'function' ? startSessionValue.bind(client) : undefined;
	return Object.freeze({ db, connect, startSession });
}

function normalizeMongoClientSession(session: unknown): NormalizedMongoClientSession {
	if (!session || typeof session !== 'object' || Array.isArray(session)) {
		throw new ActiveTsConfigurationError('MongoDB client.startSession result must be an object.');
	}
	return Object.freeze({
		raw: session,
		startTransaction: mongoMethod(session, 'startTransaction', 'MongoDB session.startTransaction'),
		commitTransaction: mongoMethod(session, 'commitTransaction', 'MongoDB session.commitTransaction'),
		abortTransaction: mongoMethod(session, 'abortTransaction', 'MongoDB session.abortTransaction'),
		endSession: mongoMethod(session, 'endSession', 'MongoDB session.endSession')
	});
}

function normalizeMongoDb(db: unknown) {
	if (!db || typeof db !== 'object' || Array.isArray(db)) {
		throw new ActiveTsConfigurationError('MongoDB adapter db must be an object.');
	}
	const collection = mongoMethod(db, 'collection', 'MongoDB adapter db.collection');
	const listCollections = optionalMongoMethod(db, 'listCollections', 'MongoDB adapter db.listCollections');
	const createCollection = optionalMongoMethod(db, 'createCollection', 'MongoDB adapter db.createCollection');
	return Object.freeze({ collection, listCollections, createCollection });
}

function normalizeMongoCollection(collection: unknown, context: string) {
	if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	return collection;
}

function normalizeMongoCursor(cursor: unknown, context: string) {
	if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
		throw new ActiveTsValidationError(`${context} must be an object.`);
	}
	return cursor;
}

function optionalMongoMethod(target: object, method: string, context: string) {
	const value = mongoMember(target, method, context, { requireEnumerableOwn: true });
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(target);
}

function mongoMethod(target: object, method: string, context: string) {
	const value = mongoMember(target, method, context, { requireEnumerableOwn: true });
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(target);
}

function mongoMember(
	target: object,
	property: string,
	context: string,
	options: { requireEnumerableOwn?: boolean } = {}
) {
	let current: object | null = target;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context} must be a data property.`);
			}
			if (options.requireEnumerableOwn && current === target && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${context} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
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
