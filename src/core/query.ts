import { isDeepStrictEqual } from 'node:util';
import type { ActiveContext } from './context.js';
import type {
	AggregateOperator,
	AggregatePlan,
	AggregateResult,
	AggregateSpec,
	EntityId,
	IncludeSpec,
	ModelConstructor,
	Operator,
	QueryNative,
	QueryPlan,
	QueryResult,
	RelationMeta,
	ResolvedModelMeta,
	SearchOptions,
	SortDirection,
	SortSpec,
	DatastoreKey,
	WhereRangeScalar,
	WhereScalar,
	WhereShape
} from './types.js';
import {
	assertCompatibleQueryPagination,
	assertPlainDataObject,
	assertDenseArrayItems,
	assertSafeCursor,
	assertSafeEntityId,
	assertSafeFieldPath,
	assertSafeLimit,
	assertSafeOffset,
	assertSafeResultCount,
	assertSafeSchemaIdentifier,
	cloneSafeDataObject
} from './safe-keys.js';
import { OBJECT_ENTRIES } from './object-intrinsics.js';
import {
	aggregateRows,
	assertAggregateSpecsCompatibleWithModel,
	normalizeAggregateRow,
	validateAggregateSpecs
} from './aggregate.js';
import {
	assertPlainWhereShape,
	assertNoOverlappingFieldPaths,
	assertPortableScalar,
	assertValidWhereOperand,
	assertWhereArrayArity,
	cloneQueryOperand,
	entityIdKey,
	isOperator,
	portableScalarKey,
	valueFor,
	filterRows,
	withIdField,
	whereShapeEntries
} from './query-utils.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { isPartialModel, markPartialModel, type PartialModel } from './partial-model.js';
import {
	snapshotRelationOwnerLocalKey,
	snapshotRelationResult,
	type RelationOwnerLocalKeySnapshot,
	validateRelationOwnerLocalKeySnapshot,
	validateRelationResultSnapshot
} from './relation-result.js';
import {
	normalizeAggregateFieldTypes,
	normalizeWhereFieldTypes,
	normalizeWhereShapeFieldTypes
} from './field-types.js';
import { snapshotArrayInput } from './array-input.js';
import {
	assertSafeSearchQuery,
	datastoreSearchDocumentIdentity,
	datastoreSearchHitDocumentIdentity,
	markSearchDocumentIdentity,
	projectSearchDocument,
	searchDocumentIdentity,
	searchHitDocumentIdentity,
	withDatastoreSearchNamespace,
	withSearchIndexesForAdapter
} from './search-utils.js';
import { searchCapability, storeCapability } from './capabilities.js';
import {
	iterableToArray,
	MAP_ENTRIES,
	MAP_GET,
	MAP_HAS,
	MAP_SET,
	MAP_VALUES,
	SET_ADD,
	SET_HAS,
	WEAKMAP_DELETE,
	WEAKMAP_GET,
	WEAKMAP_SET
} from './collection-intrinsics.js';
import { cloneNativePayload } from './native-payload.js';
import { clonePlanMeta } from './plan-meta.js';
import {
	copyFieldCodecQueryOperandMarker,
	encodeAggregatePlanFieldCodecs,
	encodeQueryPlanFieldCodecs,
	hasFieldCodecPathOverlap
} from './field-codecs.js';
import {
	datastoreAncestorPayloadData,
	datastorePayloadCanResolveAncestor,
	datastorePayloadHasAncestorFields,
	datastorePayloadResolvedAncestor,
	normalizeStoreQueryResultForModel,
	storeTrustsDatastoreEntityKeyRows,
	stripStoreNativeAdapterTag
} from './store-options.js';
import {
	datastoreReadOptions,
	datastoreKeyIdentity,
	datastoreKeyWithNamespace,
	datastoreScopedAncestorMatches,
	normalizeDatastoreKey,
	normalizeDatastoreReadPolicy,
	normalizeDatastoreReadTime,
	type DatastoreReadConsistency,
	type DatastoreReadPolicy
} from './datastore-key.js';
import {
	assertUnambiguousDatastoreRelationFallback,
	relationAncestorForOwner,
	relationTargetJoinKeys
} from './relation-ancestor.js';
import { contextInternalStore, runTrackedContextOperation } from './context-internal.js';
import {
	markDatastoreHistoricalModel,
	MODEL_DATASTORE_WRITE_ANCESTOR,
	MODEL_PERSISTED_TOKEN
} from './model-internal.js';

const RELATION_INSTANTIATION_DATA = new WeakMap<object, Record<string, any>>();

type AggregateSelection<TData extends Record<string, any>> = Record<
	string,
	| 'count'
	| { op: 'count'; field?: never }
	| { op: Exclude<AggregateOperator, 'count'>; field: keyof TData | string }
>;
export type AggregateComparableValue = string | number | Date;
export type AggregateFieldConstraint<TData extends Record<string, any>, TField, TValue> =
	TField extends keyof TData
		? NonNullable<TData[TField]> extends TValue
			? unknown
			: never
		: unknown;
type AggregateSelectionFieldConstraint<TData extends Record<string, any>, TSelection> = {
	[Alias in keyof TSelection]:
		TSelection[Alias] extends { op: infer TOperator; field: infer TField }
			? TOperator extends 'sum' | 'avg'
				? TField extends (TField & AggregateFieldConstraint<TData, TField, number>)
					? TSelection[Alias]
					: never
				: TOperator extends 'min' | 'max'
					? TField extends (TField & AggregateFieldConstraint<TData, TField, AggregateComparableValue>)
						? TSelection[Alias]
						: never
					: TSelection[Alias]
			: TSelection[Alias];
};
type SelectedIdData<TData extends Record<string, any>> = 'id' extends keyof TData ? Pick<TData, 'id'> : {};
type SelectedData<TData extends Record<string, any>, K extends keyof TData> =
	Partial<TData> & SelectedIdData<TData> & Pick<TData, K>;
type ModelResultSnapshot = {
	id: EntityId;
	partial: boolean;
	datastoreAncestor?: DatastoreKey;
	searchDocumentIdentity?: string;
	searchIdentityMeta?: ResolvedModelMeta;
};
export type QueryFindLoader<TModel extends { data: any }> = {
	include(...relations: IncludeSpec[]): QueryFindLoader<TModel>;
	load(): Promise<TModel | null>;
	update(patch: Partial<TModel['data']>): Promise<TModel | null>;
	delete(): Promise<boolean>;
};
const MAX_PORTABLE_IN_VALUES = 30;
const QUERY_PLAN_KEYS = ['where', 'or', 'sort', 'limit', 'offset', 'cursor', 'select', 'include', 'native', 'meta'] as const;
const AGGREGATE_PLAN_KEYS = ['where', 'or', 'aggregates', 'native', 'meta'] as const;
const WHERE_ENTRY_KEYS = ['field', 'op', 'value', 'value2'] as const;
const SORT_SPEC_KEYS = ['field', 'direction'] as const;
const NATIVE_QUERY_KEYS = ['adapter', 'payload'] as const;
const SEARCH_OPTION_KEYS = ['where', 'limit', 'cursor', 'native'] as const;
const AGGREGATE_SELECTION_SPEC_KEYS = ['op', 'field'] as const;
const QUERY_RESULT_KEYS = ['list', 'cursor', 'more', 'count', 'total'] as const;

type RawResultOptions = {
	cursor?: boolean;
	adapterKind: string;
	adapterType: 'Search' | 'Store';
};

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function mapGet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey) {
	return MAP_GET.call(map, key) as TValue | undefined;
}

function mapSet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue) {
	MAP_SET.call(map, key, value);
}

function uniqueStrings(values: Iterable<string>) {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (SET_HAS.call(seen, value)) continue;
		SET_ADD.call(seen, value);
		result.push(value);
	}
	return result;
}

function normalizeWhere(input: WhereShape, context = 'query where') {
	const entries: QueryPlan['where'] = [];
	for (const [field, raw] of whereShapeEntries(input, context)) {
		const safeField = assertSafeFieldPath(field, 'query field');
		if (raw === undefined) {
			throw new ActiveTsValidationError(`query field "${safeField}" cannot be undefined. Use null, isNull, or omit the field.`);
		}
		if (Array.isArray(raw)) {
			assertDenseArray(raw, `Query array operand on "${safeField}"`);
			const operator = ownArrayValue(raw, 0);
			if (operator === 'between') {
				const lower = ownArrayValue(raw, 1);
				const upper = ownArrayValue(raw, 2);
				assertValidWhereOperand('between', lower, upper, safeField);
				assertWhereArrayArity(raw, 'between', safeField);
				entries.push({
					field: safeField,
					op: 'between',
					value: cloneQueryOperand(lower),
					value2: cloneQueryOperand(upper)
				});
			} else if (typeof operator === 'string' && isOperator(operator)) {
				const operand = ownArrayValue(raw, 1);
				assertValidWhereOperand(operator, operand, undefined, safeField);
				assertWhereArrayArity(raw, operator, safeField);
				entries.push({ field: safeField, op: operator, value: cloneQueryOperand(operand) });
			} else {
				assertValidWhereOperand('in', raw, undefined, safeField);
				entries.push({ field: safeField, op: 'in', value: cloneQueryOperand(raw) });
			}
		} else {
			assertValidWhereOperand('=', raw, undefined, safeField);
			entries.push({ field: safeField, op: '=', value: cloneQueryOperand(raw) });
		}
	}
	return entries;
}

function ownArrayValue(array: readonly unknown[], index: number) {
	if (!Object.prototype.hasOwnProperty.call(array, index)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`Query array operand must not contain accessors at index ${index}.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`Query array operand[${index}] must be enumerable.`);
	}
	return descriptor.value;
}

function assertDenseArray(array: readonly unknown[], context: string) {
	if (Object.getOwnPropertySymbols(array).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(array)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, array.length)) {
			throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(array, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context} must not contain accessors at index ${property}.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}[${property}] must be enumerable.`);
		}
	}
	for (let index = 0; index < array.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(array, index)) {
			throw new ActiveTsValidationError(`${context} must not be sparse or inherit array items.`);
		}
	}
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function normalizeSort(sort: any) {
	if (typeof sort === 'string') {
		if (sort.startsWith('-')) return { field: assertSafeFieldPath(sort.slice(1), 'sort field'), direction: 'desc' as const };
		return { field: assertSafeFieldPath(sort, 'sort field'), direction: 'asc' as const };
	}
	assertPlainObject(sort, 'sort spec');
	assertKnownObjectKeys(sort, SORT_SPEC_KEYS, 'sort spec');
	const rawDirection = ownObjectValue(sort, 'direction');
	if (rawDirection !== undefined && rawDirection !== 'asc' && rawDirection !== 'desc') {
		throw new ActiveTsValidationError(invalidValueMessage('Sort direction', rawDirection));
	}
	const direction: SortDirection = rawDirection === 'desc' ? 'desc' : 'asc';
	return { field: assertSafeFieldPath(ownObjectValue(sort, 'field'), 'sort field'), direction };
}

function sanitizeWhereEntries(entries: QueryPlan['where'] | undefined, context = 'query where') {
	const safeEntries = arrayOrEmpty<QueryPlan['where'][number]>(entries, context);
	const normalized: QueryPlan['where'] = [];
	for (let index = 0; index < safeEntries.length; index++) {
		const where = safeEntries[index];
		assertPlainObject(where, `${context}[${index}]`);
		assertKnownObjectKeys(where, WHERE_ENTRY_KEYS, `${context}[${index}]`);
		const field = assertSafeFieldPath(ownObjectValue(where, 'field'), 'query field');
		const op = ownObjectValue(where, 'op');
		if (typeof op !== 'string' || !isOperator(op)) {
			throw new ActiveTsValidationError(invalidValueMessage('Query operator', op));
		}
		const value = ownObjectValue(where, 'value');
		const hasValue2 = Object.prototype.hasOwnProperty.call(where, 'value2');
		const value2 = ownObjectValue(where, 'value2');
		assertValidWhereOperand(op, value, value2, field);
		if (op !== 'between' && hasValue2) {
			throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" does not accept value2.`);
		}
		normalized[index] = value2 === undefined
			? { field, op, value: cloneQueryOperand(value) }
			: { field, op, value: cloneQueryOperand(value), value2: cloneQueryOperand(value2) };
	}
	return normalized;
}

function sanitizeQueryBranch<TData extends Record<string, any>>(plan: Partial<QueryPlan<TData>>): QueryPlan<TData> {
	assertPlainObject(plan, 'query branch');
	assertKnownObjectKeys(plan, QUERY_PLAN_KEYS, 'query branch');
	const branchSort = arrayOrEmpty<SortSpec<TData>>(ownObjectValue(plan, 'sort'), 'query branch sort');
	if (branchSort.length) {
		throw new ActiveTsValidationError('query branch sort must be empty; OR branches cannot define sort order.');
	}
	const branchInclude = arrayOrEmpty<IncludeSpec>(ownObjectValue(plan, 'include'), 'query branch include');
	if (branchInclude.length) {
		throw new ActiveTsValidationError('query branch include must be empty; OR branches cannot define includes.');
	}
	for (const property of ['limit', 'offset', 'cursor', 'select', 'native', 'meta'] as const) {
		if (ownObjectValue(plan, property) !== undefined) {
			throw new ActiveTsValidationError(`query branch ${property} must be undefined; OR branches cannot define ${property}.`);
		}
	}
	const branch = {
		where: sanitizeWhereEntries(ownObjectValue(plan, 'where'), 'query branch where'),
		or: sanitizeQueryBranches<TData>(ownObjectValue(plan, 'or'), 'query branch or'),
		sort: [],
		include: []
	};
	assertNonEmptyOrLeaf(branch, 'query or branch');
	return branch;
}

function sanitizeQueryPlan<TData extends Record<string, any>>(
	plan: QueryPlan<TData>,
	idField: string
): QueryPlan<TData> {
	assertPlainObject(plan, 'query plan');
	assertKnownObjectKeys(plan, QUERY_PLAN_KEYS, 'query plan');
	const rawSelect = optionalArray<string>(ownObjectValue(plan, 'select'), 'query select');
	const select = rawSelect
		? assertNoOverlappingFieldPaths(
				withIdField(sanitizeFieldList(rawSelect, 'select field'), idField) ?? [],
				'select fields'
			)
		: undefined;
	const rawLimit = ownObjectValue(plan, 'limit');
	const rawOffset = ownObjectValue(plan, 'offset');
	const offset = rawOffset === undefined ? undefined : assertSafeOffset(rawOffset, 'query offset');
	const cursor = assertSafeCursor(ownObjectValue(plan, 'cursor'), 'query cursor');
	assertCompatibleQueryPagination(offset, cursor);
	return normalizeMixedOrPlan({
		where: sanitizeWhereEntries(ownObjectValue(plan, 'where'), 'query where'),
		or: sanitizeQueryBranches<TData>(ownObjectValue(plan, 'or'), 'query or'),
		sort: sanitizeSortList<TData>(ownObjectValue(plan, 'sort'), 'query sort'),
		limit: rawLimit === undefined ? undefined : assertSafeLimit(rawLimit, 'query limit'),
		offset,
		cursor,
		select,
		include: normalizeIncludeSpecs(arrayOrEmpty<IncludeSpec>(ownObjectValue(plan, 'include'), 'query include')),
		native: sanitizeNative(ownObjectValue(plan, 'native'), 'query native'),
		meta: sanitizePlanMeta(ownObjectValue(plan, 'meta'), 'query meta')
	});
}

function sanitizeQueryBranches<TData extends Record<string, any>>(value: unknown, context: string): QueryPlan<TData>['or'] {
	const branches = arrayOrEmpty<Partial<QueryPlan<TData>>>(value, context);
	const normalized: QueryPlan<TData>['or'] = [];
	for (let index = 0; index < branches.length; index++) {
		normalized[index] = sanitizeQueryBranch(branches[index]);
	}
	return normalized;
}

function sanitizeSortList<TData extends Record<string, any>>(value: unknown, context: string): QueryPlan<TData>['sort'] {
	const sorts = arrayOrEmpty<SortSpec<TData>>(value, context);
	const normalized: QueryPlan<TData>['sort'] = [];
	for (let index = 0; index < sorts.length; index++) {
		normalized[index] = normalizeSort(sorts[index]);
	}
	return normalized;
}

function sanitizeFieldList(fields: readonly string[], context: string) {
	const normalized: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		normalized[index] = assertSafeFieldPath(fields[index], context);
	}
	return normalized;
}

function normalizeQueryPlanFieldTypes<TData extends Record<string, any>>(
	meta: ResolvedModelMeta,
	plan: QueryPlan<TData>
): QueryPlan<TData> {
	const or: QueryPlan<TData>['or'] = [];
	for (let index = 0; index < plan.or.length; index++) {
		or[index] = normalizeQueryPlanFieldTypes(meta, plan.or[index]);
	}
	return {
		...plan,
		where: normalizeWhereFieldTypes(meta, plan.where),
		or
	};
}

function sanitizeAggregatePlan<TData extends Record<string, any>>(plan: AggregatePlan<TData>): AggregatePlan<TData> {
	assertPlainObject(plan, 'aggregate plan');
	assertKnownObjectKeys(plan, AGGREGATE_PLAN_KEYS, 'aggregate plan');
	return normalizeMixedOrPlan({
		where: sanitizeWhereEntries(ownObjectValue(plan, 'where'), 'aggregate where'),
		or: sanitizeQueryBranches<TData>(ownObjectValue(plan, 'or'), 'aggregate or'),
		aggregates: validateAggregateSpecs((ownObjectValue(plan, 'aggregates') ?? []) as AggregatePlan<TData>['aggregates']),
		native: sanitizeNative(ownObjectValue(plan, 'native'), 'aggregate native'),
		meta: sanitizePlanMeta(ownObjectValue(plan, 'meta'), 'aggregate meta')
	});
}

function normalizeAggregatePlanFieldTypes<TData extends Record<string, any>>(
	meta: ResolvedModelMeta,
	plan: AggregatePlan<TData>
): AggregatePlan<TData> {
	const or: AggregatePlan<TData>['or'] = [];
	for (let index = 0; index < plan.or.length; index++) {
		or[index] = normalizeQueryPlanFieldTypes(meta, plan.or[index]);
	}
	return {
		...plan,
		where: normalizeWhereFieldTypes(meta, plan.where),
		or
	};
}

function sanitizeSearchOptions(options: SearchOptions | undefined): SearchOptions {
	if (options === undefined) return { where: undefined, limit: undefined, cursor: undefined, native: undefined };
	assertPlainObject(options, 'search options');
	assertKnownObjectKeys(options, SEARCH_OPTION_KEYS, 'search options');
	const rawWhere = assertPlainWhereShape(ownObjectValue(options, 'where') as SearchOptions['where'], 'search where');
	let where: SearchOptions['where'] | undefined;
	if (rawWhere) {
		where = {};
		for (const [field, value] of whereShapeEntries(rawWhere, 'search where')) {
			const safeField = assertSafeFieldPath(field, 'search where field');
			if (value === undefined) {
				throw new ActiveTsValidationError(
					`search where field "${safeField}" cannot be undefined. Use null, isNull, or omit the field.`
				);
			}
			where[safeField] = value as WhereShape[string];
		}
	}
	if (where) normalizeWhere(where);
	const limit = ownObjectValue(options, 'limit');
	const cursor = ownObjectValue(options, 'cursor');
	const native = ownObjectValue(options, 'native');
	const safeWhereEntries: QueryPlan['where'] = [];
	if (where) {
		for (const [field, value] of whereShapeEntries(where, 'search where')) {
			safeWhereEntries.push(...normalizeWhere({ [field]: value } as WhereShape, 'search where'));
		}
	}
	return {
		where: safeWhereEntries.length ? whereEntriesToShape(safeWhereEntries) : undefined,
		limit: limit === undefined ? undefined : assertSafeLimit(limit as number, 'search limit'),
		cursor: assertSafeCursor(cursor, 'search cursor'),
		native: cloneNativePayload(native)
	};
}

function cloneSearchOptions(options: SearchOptions): SearchOptions {
	const where = ownObjectValue(options as Record<string, unknown>, 'where') as SearchOptions['where'];
	let clonedWhere: WhereShape | undefined;
	if (where) {
		clonedWhere = {};
		for (const [field, value] of whereShapeEntries(where, 'search where')) {
			clonedWhere[field] = cloneQueryOperand(value) as WhereShape[string];
		}
	}
	return {
		where: clonedWhere,
		limit: ownObjectValue(options as Record<string, unknown>, 'limit') as SearchOptions['limit'],
		cursor: ownObjectValue(options as Record<string, unknown>, 'cursor') as SearchOptions['cursor'],
		native: cloneNativePayload(ownObjectValue(options as Record<string, unknown>, 'native'))
	};
}

function assertPlainObject(value: unknown, context: string): asserts value is Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
	}
}

function invalidValueMessage(label: string, value: unknown) {
	return typeof value === 'string' ? `${label} "${value}" is not allowed.` : `${label} is not allowed.`;
}

function assertKnownObjectKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = stringSet(allowed);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function arrayOrEmpty<T>(value: unknown, context: string): T[] {
	if (value === undefined) return [];
	return queryArrayValues<T>(value, context);
}

function optionalArray<T>(value: unknown, context: string): T[] | undefined {
	if (value === undefined) return undefined;
	return queryArrayValues<T>(value, context);
}

function queryArrayValues<T>(value: unknown, context: string): T[] {
	if (!Array.isArray(value)) throw new ActiveTsValidationError(`${context} must be an array.`);
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const items: T[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		items.push(descriptor.value as T);
	}
	return items;
}

function sanitizeNative(native: unknown, context: string): QueryNative | undefined {
	if (native === undefined) return undefined;
	assertPlainObject(native, context);
	assertKnownObjectKeys(native, NATIVE_QUERY_KEYS, context);
	if (!Object.prototype.hasOwnProperty.call(native, 'payload')) {
		throw new ActiveTsValidationError(`${context}.payload is required.`);
	}
	const payload = ownObjectValue(native, 'payload');
	if (payload === undefined) {
		throw new ActiveTsValidationError(`${context}.payload is required.`);
	}
	const adapter = ownObjectValue(native, 'adapter');
	return {
		adapter: adapter === undefined ? undefined : assertSafeSchemaIdentifier(adapter, `${context}.adapter`),
		payload: cloneNativePayload(payload)
	};
}

function cloneRequiredNativePayload(payload: unknown) {
	if (payload === undefined) {
		throw new ActiveTsValidationError('native payload is required.');
	}
	return cloneNativePayload(payload);
}

function sanitizePlanMeta(meta: unknown, context: string): QueryPlan['meta'] | undefined {
	return clonePlanMeta(meta, context);
}

function ownObjectValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${key} property must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${key} property must be enumerable.`);
	}
	return descriptor.value;
}

function assertNonEmptyOrLeaf<TData extends Record<string, any>>(branch: QueryPlan<TData>, context: string) {
	if (branch.where.length || branch.or.length) return;
	throw new ActiveTsValidationError(`${context} requires at least one where condition.`);
}

function normalizeMixedOrPlan<TPlan extends { where: QueryPlan['where']; or: QueryPlan['or'] }>(plan: TPlan): TPlan {
	if (!plan.or.length || !plan.where.length) return plan;
	const constraints = cloneWhereEntries(plan.where);
	const or: QueryPlan['or'] = [];
	for (let index = 0; index < plan.or.length; index++) {
		or[index] = constrainOrBranch(plan.or[index], constraints);
	}
	return {
		...plan,
		where: [],
		or
	};
}

function constrainOrBranch<TData extends Record<string, any>>(
	branch: QueryPlan<TData>,
	constraints: QueryPlan['where']
): QueryPlan<TData> {
	const hasOwnAlternative = branch.where.length > 0 || branch.or.length === 0;
	const or: QueryPlan<TData>['or'] = [];
	for (let index = 0; index < branch.or.length; index++) {
		or[index] = constrainOrBranch(branch.or[index], constraints);
	}
	return {
		...branch,
		where: hasOwnAlternative ? mergeWhereConstraints(constraints, branch.where) : [],
		or
	};
}

function mergeWhereConstraints(
	constraints: QueryPlan['where'],
	where: QueryPlan['where']
): QueryPlan['where'] {
	const merged = cloneWhereEntries(where);
	const additions: QueryPlan['where'] = [];
	for (let index = 0; index < constraints.length; index++) {
		const constraint = constraints[index];
		if (!hasMatchingWhereEntry(additions, constraint) && !hasMatchingWhereEntry(merged, constraint)) {
			additions[additions.length] = cloneWhereEntry(constraint);
		}
	}
	const result: QueryPlan['where'] = [];
	for (let index = 0; index < additions.length; index++) result[result.length] = additions[index];
	for (let index = 0; index < merged.length; index++) result[result.length] = merged[index];
	return result;
}

function copyArrayRange<T>(items: readonly T[], start: number, end: number) {
	const result: T[] = [];
	for (let index = start; index < end && index < items.length; index++) {
		result[result.length] = items[index];
	}
	return result;
}

function hasMatchingWhereEntry(entries: QueryPlan['where'], constraint: QueryPlan['where'][number]) {
	for (let index = 0; index < entries.length; index++) {
		if (sameWhereEntry(entries[index], constraint)) return true;
	}
	return false;
}

function cloneWhereEntry(entry: QueryPlan['where'][number]): QueryPlan['where'][number] {
	return entry.value2 === undefined
		? { field: entry.field, op: entry.op, value: cloneQueryOperand(entry.value) }
		: { field: entry.field, op: entry.op, value: cloneQueryOperand(entry.value), value2: cloneQueryOperand(entry.value2) };
}

function sameWhereEntry(left: QueryPlan['where'][number], right: QueryPlan['where'][number]) {
	return left.field === right.field &&
		left.op === right.op &&
		isDeepStrictEqual(left.value, right.value) &&
		isDeepStrictEqual(left.value2, right.value2);
}

function sanitizeSearchQuery(query: unknown) {
	return assertSafeSearchQuery(query, 'Search query');
}

function whereShapeToEntries(where: WhereShape) {
	const entries: QueryPlan['where'] = [];
	for (const [field, value] of whereShapeEntries(where, 'search where')) {
		const normalized = normalizeWhere({ [field]: value } as WhereShape, 'search where');
		entries.push(...normalized);
	}
	return entries;
}

function whereEntriesToShape(entries: QueryPlan['where']): WhereShape {
	const shape: WhereShape = {};
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.op === '=') {
			shape[entry.field] = cloneQueryOperand(entry.value) as WhereShape[string];
		} else if (entry.op === 'isNull' || entry.op === 'isNotNull') {
			shape[entry.field] = [entry.op] as WhereShape[string];
		} else if (entry.value2 !== undefined) {
			shape[entry.field] = [entry.op, cloneQueryOperand(entry.value), cloneQueryOperand(entry.value2)] as unknown as WhereShape[string];
		} else {
			shape[entry.field] = [entry.op, cloneQueryOperand(entry.value)] as WhereShape[string];
		}
	}
	return shape;
}

function cloneWhereEntries(entries: QueryPlan['where']): QueryPlan['where'] {
	const cloned: QueryPlan['where'] = [];
	for (let index = 0; index < entries.length; index++) cloned[index] = cloneWhereEntry(entries[index]);
	return cloned;
}

function modelResultSnapshots<TModel extends { data: any }>(
	meta: ResolvedModelMeta,
	list: TModel[],
	context: string,
	options: { searchIdentityMeta?: ResolvedModelMeta } = {}
) {
	const snapshots = new Map<object, ModelResultSnapshot>();
	const identities = new Set<string>();
	const searchIdentityMeta = options.searchIdentityMeta ?? meta;
	for (const item of list) {
		const id = valueFor(item.data, meta.idField);
		if (id === undefined || id === null) {
			throw new ActiveTsValidationError(`${context} is missing id field "${meta.idField}".`);
		}
		assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
		const searchDocumentIdentity = meta.datastore?.ancestor && isPartialModel(item as object)
			? searchHitDocumentIdentity(item.data)
			: undefined;
		const datastoreAncestor = datastoreExpectedResultAncestor(meta, item, id, context);
		assertDatastoreSearchDocumentIdentityMatchesPayload(
			searchIdentityMeta,
			id,
			searchDocumentIdentity,
			item.data,
			context
		);
		let identity = entityIdKey(id);
		if (searchDocumentIdentity !== undefined) {
			identity = `search:${searchDocumentIdentity}`;
		} else if (datastoreAncestor !== undefined) {
			identity = `${datastoreAncestorIdentity(datastoreAncestor)}:${identity}`;
		}
		if (SET_HAS.call(identities, identity)) {
			if (searchDocumentIdentity !== undefined || datastoreAncestor !== undefined) {
				throw new ActiveTsValidationError(`${context} contains duplicate Datastore identity "${String(id)}".`);
			}
			throw new ActiveTsValidationError(`${context} contains duplicate id "${String(id)}".`);
		}
		SET_ADD.call(identities, identity);
		mapSet(snapshots, item as object, {
			id,
			partial: isPartialModel(item as object),
			datastoreAncestor,
			searchDocumentIdentity,
			searchIdentityMeta: searchDocumentIdentity === undefined ? undefined : searchIdentityMeta
		});
	}
	return snapshots;
}

function assertDatastoreSearchDocumentIdentityMatchesPayload(
	meta: ResolvedModelMeta,
	id: EntityId,
	searchDocumentIdentity: string | undefined,
	data: Record<string, any>,
	context: string
) {
	if (searchDocumentIdentity === undefined) return;
	const datastoreAncestor = datastorePayloadResolvedAncestor(meta, id, data, context);
	if (datastoreAncestor === undefined) return;
	if (searchDocumentIdentity !== datastoreSearchDocumentIdentity(meta, id, datastoreAncestor)) {
		throw new ActiveTsValidationError(`${context} Datastore search document identity does not match its payload data.`);
	}
}

function cloneQueryBranch<TData extends Record<string, any>>(branch: QueryPlan<TData>): QueryPlan<TData> {
	const or: QueryPlan<TData>['or'] = [];
	for (let index = 0; index < branch.or.length; index++) or[index] = cloneQueryBranch(branch.or[index]);
	const sort: QueryPlan<TData>['sort'] = [];
	for (let index = 0; index < branch.sort.length; index++) sort[index] = { ...branch.sort[index] };
	return copyFieldCodecQueryOperandMarker(branch, {
		where: cloneWhereEntries(branch.where),
		or,
		sort,
		limit: branch.limit,
		offset: branch.offset,
		cursor: branch.cursor,
		select: branch.select ? [...branch.select] : undefined,
		include: [...branch.include],
		native: branch.native ? { adapter: branch.native.adapter, payload: cloneNativePayload(branch.native.payload) } : undefined,
		meta: clonePlanMeta(branch.meta)
	});
}

function cloneAggregatePlan<TData extends Record<string, any>>(plan: AggregatePlan<TData>): AggregatePlan<TData> {
	const or: AggregatePlan<TData>['or'] = [];
	for (let index = 0; index < plan.or.length; index++) or[index] = cloneQueryBranch(plan.or[index]);
	const aggregates: AggregateSpec[] = [];
	for (let index = 0; index < plan.aggregates.length; index++) aggregates[index] = { ...plan.aggregates[index] };
	return copyFieldCodecQueryOperandMarker(plan, {
		where: cloneWhereEntries(plan.where),
		or,
		aggregates,
		native: plan.native ? { adapter: plan.native.adapter, payload: cloneNativePayload(plan.native.payload) } : undefined,
		meta: clonePlanMeta(plan.meta)
	});
}

export function relationPreloadSelectFields(
	context: ActiveContext,
	targetMeta: ResolvedModelMeta,
	where: QueryPlan['where'],
	fields: Iterable<string>
) {
	const select = uniqueStrings([targetMeta.idField, ...fields, ...(targetMeta.datastore?.ancestorFields ?? [])]);
	if (!select.length) return undefined;
	const plan: QueryPlan = {
		where: cloneWhereEntries(where),
		or: [],
		sort: [],
		include: [],
		limit: undefined,
		offset: undefined,
		cursor: undefined,
		select,
		native: undefined,
		meta: undefined
	};
	try {
		context.storeForQuery(targetMeta, plan);
		return select;
	} catch (error) {
		if (
			error instanceof ActiveTsConfigurationError &&
			/does not support (select\(\)|nested field selection)/.test(error.message)
		) {
			return undefined;
		}
		throw error;
	}
}

function sanitizeModelResult<TModel>(
	result: unknown,
	model: ModelConstructor<TModel>,
	context: string,
	options?: {
		activeContext: ActiveContext;
		meta: ResolvedModelMeta;
		expectedIds: Map<object, ModelResultSnapshot>;
	}
): QueryResult<TModel> {
	assertPlainObject(result, `${context} result`);
	const value = result as Record<string, unknown>;
	assertKnownObjectKeys(value, QUERY_RESULT_KEYS, `${context} result`);
	const list = ownObjectValue(value, 'list');
	if (!Array.isArray(list)) throw new ActiveTsValidationError(`${context} result.list must be an array.`);
	const safeList = snapshotArrayInput<TModel>(list, `${context} result.list`);
	for (const item of safeList) {
		if (!(item instanceof model)) {
			throw new ActiveTsValidationError(`${context} result.list must contain model instances.`);
		}
	}
	if (options) {
		validateModelResultIdentities(
			options.activeContext,
			options.meta,
			safeList as Array<{ data: Record<string, any> }>,
			options.expectedIds,
			`${context} result.list`
		);
	}
	const cursor = assertSafeCursor(ownObjectValue(value, 'cursor'), `${context} result cursor`);
	const more = ownObjectValue(value, 'more');
	assertSafeResultCount(ownObjectValue(value, 'count'), `${context} result.count`);
	const total = assertSafeResultCount(ownObjectValue(value, 'total'), `${context} result.total`);
	if (more !== undefined && typeof more !== 'boolean') {
		throw new ActiveTsValidationError(`${context} result.more must be a boolean.`);
	}
	if (total !== undefined && total < safeList.length) {
		throw new ActiveTsValidationError(`${context} result.total cannot be smaller than result.list length.`);
	}
	return { list: safeList, cursor, more, count: safeList.length, total } as QueryResult<TModel>;
}

function validateModelResultIdentities(
	context: ActiveContext,
	meta: ResolvedModelMeta,
	list: Array<{ data: Record<string, any> }>,
	expectedIds: Map<object, ModelResultSnapshot>,
	operation: string,
	options: { exactDatastoreAncestor?: boolean } = {}
) {
	const seen = new Set<object>();
	for (const item of list) {
		if (SET_HAS.call(seen, item as object)) {
			throw new ActiveTsValidationError(`${operation} cannot contain duplicate model instances.`);
		}
		SET_ADD.call(seen, item as object);
		const expected = mapGet(expectedIds, item as object);
		if (expected === undefined) {
			throw new ActiveTsValidationError(`${operation} cannot contain model instances outside the original result.`);
		}
		if (isPartialModel(item as object) !== expected.partial) {
			throw new ActiveTsValidationError(`${operation} cannot change model partial marker state.`);
		}
		context.validateModelInstance(meta, item, `${operation} item`, {
			expectedId: expected.id,
			partial: expected.partial
		});
		if (
			expected.searchDocumentIdentity !== undefined &&
			searchHitDocumentIdentity(item.data) !== expected.searchDocumentIdentity
		) {
			throw new ActiveTsValidationError(`${operation} item cannot change Datastore search document identity.`);
		}
		if (expected.datastoreAncestor !== undefined && meta.datastore?.ancestor) {
			const retainedDatastoreAncestor = (item as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
			let canResolveDatastoreAncestor = true;
			if (expected.partial && retainedDatastoreAncestor !== undefined) {
				canResolveDatastoreAncestor = datastorePayloadCanResolveAncestor(
					meta,
					expected.id,
					item.data,
					`${operation} item`
				);
			}
			const actual = canResolveDatastoreAncestor
				? datastorePayloadResolvedAncestor(meta, expected.id, item.data, `${operation} item`) ??
					meta.datastore.ancestor({ model: meta, id: expected.id, data: item.data })
				: retainedDatastoreAncestor;
			const matches = options.exactDatastoreAncestor
				? datastoreAncestorIdentitiesEqual(actual, expected.datastoreAncestor)
				: datastoreAncestorMatches(actual, expected.datastoreAncestor);
			if (!matches) {
				throw new ActiveTsValidationError(
					`${operation} item cannot move ${meta.name}:${String(expected.id)} outside the scoped Datastore ancestor.`
				);
			}
		}
		if (expected.searchDocumentIdentity !== undefined && meta.datastore?.ancestor) {
			assertDatastoreSearchDocumentIdentityMatchesPayload(
				expected.searchIdentityMeta ?? meta,
				expected.id,
				expected.searchDocumentIdentity,
				item.data,
				`${operation} item`
			);
		}
	}
}

function sanitizeRawResult(result: unknown, context: string, options: RawResultOptions): QueryResult {
	assertPlainObject(result, `${context} result`);
	const value = result as Record<string, unknown>;
	assertKnownObjectKeys(value, QUERY_RESULT_KEYS, `${context} result`);
	const list = ownObjectValue(value, 'list');
	if (!Array.isArray(list)) throw new ActiveTsValidationError(`${context} result.list must be an array.`);
	const safeList = snapshotArrayInput<Record<string, unknown>>(list, `${context} result.list`);
	for (const item of safeList) assertPlainDataObject(item, `${context} result.list item`);
	const cursor = assertSafeCursor(ownObjectValue(value, 'cursor'), `${context} result cursor`);
	const more = ownObjectValue(value, 'more');
	const count = assertSafeResultCount(ownObjectValue(value, 'count'), `${context} result.count`);
	const total = assertSafeResultCount(ownObjectValue(value, 'total'), `${context} result.total`);
	if (more !== undefined && typeof more !== 'boolean') {
		throw new ActiveTsValidationError(`${context} result.more must be a boolean.`);
	}
	if (cursor !== undefined && options.cursor === false) {
		throw new ActiveTsConfigurationError(
			`${options.adapterType} adapter "${options.adapterKind}" does not support returning portable cursors.`
		);
	}
	if (total !== undefined && total < safeList.length) {
		throw new ActiveTsValidationError(`${context} result.total cannot be smaller than result.list length.`);
	}
	return { list: safeList, cursor, more, count, total } as QueryResult;
}

function validateRawResultUniqueModelIds(
	meta: Pick<ResolvedModelMeta, 'name' | 'idField' | 'datastore'>,
	list: Array<Record<string, unknown>>,
	context: string
) {
	const ids = new Set<string>();
	for (let index = 0; index < list.length; index++) {
		const id = valueFor(list[index], meta.idField);
		if (id === undefined || id === null) {
			throw new ActiveTsValidationError(`${context} result.list[${index}] is missing id field "${meta.idField}".`);
		}
		assertSafeEntityId(id, `${context} result.list[${index}].${meta.idField}`);
		if (meta.datastore?.ancestor) continue;
		const key = entityIdKey(id);
		if (SET_HAS.call(ids, key)) {
			throw new ActiveTsValidationError(`${context} result contains duplicate id "${String(id)}".`);
		}
		SET_ADD.call(ids, key);
	}
}

function sanitizeAggregateResult(result: unknown, specs: AggregateSpec[], context: string): AggregateResult {
	const normalized = normalizeAggregateRow(result, specs, context);
	for (const [key, value] of OBJECT_ENTRIES(normalized)) {
		if (
			value !== null &&
			(typeof value !== 'number' || !Number.isFinite(value)) &&
			typeof value !== 'string' &&
			!(value instanceof Date)
		) {
			throw new ActiveTsValidationError(`${context} result "${key}" must be a scalar aggregate value.`);
		}
	}
	return normalized;
}

export function normalizeIncludeSpecs(specs: IncludeSpec[]) {
	const roots = queryArrayValues<IncludeSpec>(specs, 'include specs');
	const paths: string[] = [];
	const visit = (prefix: string, spec: IncludeSpec | IncludeSpec[] | true) => {
		if (spec === true) {
			if (!prefix) throw new ActiveTsValidationError('Include true must be nested under a relation name.');
			if (prefix) paths.push(prefix);
			return;
			}
			if (typeof spec === 'string') {
				const path = joinIncludePath(prefix, spec);
				paths.push(assertSafeIncludePath(path));
				return;
			}
		if (Array.isArray(spec)) {
			const items = queryArrayValues<IncludeSpec>(spec, 'include spec array');
			for (let index = 0; index < items.length; index++) visit(prefix, items[index]);
			return;
		}
		if (!spec || typeof spec !== 'object') {
			throw new ActiveTsValidationError('Include spec is not allowed.');
		}
		const prototype = Object.getPrototypeOf(spec);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError('Include spec must be a plain object, string, array, or nested true.');
		}
		if (Object.getOwnPropertySymbols(spec).length) {
			throw new ActiveTsValidationError('Include spec cannot contain symbol relation names.');
		}
			for (const name of Object.getOwnPropertyNames(spec)) {
			const descriptor = Object.getOwnPropertyDescriptor(spec, name);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`Include spec "${name}" must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`Include spec "${name}" must be enumerable.`);
				}
				const nested = descriptor.value;
				const path = joinIncludePath(prefix, assertSafeFieldPath(name, 'include relation'));
				visit(path, nested);
			}
		};
	for (let index = 0; index < roots.length; index++) visit('', roots[index]);
	const safePaths: string[] = [];
	for (let index = 0; index < paths.length; index++) safePaths[index] = assertSafeIncludePath(paths[index]);
	return uniqueStrings(safePaths);
}

function joinIncludePath(prefix: string, path: string) {
	return prefix ? `${prefix}.${path}` : path;
}

function assertSafeIncludePath(path: string) {
	if (!path) throw new ActiveTsConfigurationError('Empty include path.');
	const parts = path.split('.');
	const safeParts: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		safeParts[index] = assertSafeFieldPath(parts[index], 'include path');
	}
	return safeParts.join('.');
}

function splitIncludePath(path: string): [string | undefined, string | undefined] {
	const parts = path.split('.');
	let relation: string | undefined;
	const nested: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (!part) continue;
		if (relation === undefined) relation = part;
		else nested[nested.length] = part;
	}
	return [relation, nested.length ? nested.join('.') : undefined];
}

function datastoreReadPolicyFromMeta(
	meta: QueryPlan['meta'] | AggregatePlan['meta'],
	context: string
): DatastoreReadPolicy | undefined {
	if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'datastoreRead')) return undefined;
	return normalizeDatastoreReadPolicy(meta.datastoreRead, context);
}

function withDatastoreReadTime(
	meta: QueryPlan['meta'],
	value: number | Date,
	context: string
): QueryPlan['meta'] {
	const current = datastoreReadPolicyFromMeta(meta, `${context} policy`);
	if (current?.consistency !== undefined) {
		throw new ActiveTsConfigurationError(`${context} cannot be combined with readConsistency().`);
	}
	return {
		...clonePlanMeta(meta),
		datastoreRead: { readTime: normalizeDatastoreReadTime(value, context) }
	};
}

function withDatastoreReadConsistency(
	meta: QueryPlan['meta'],
	consistency: DatastoreReadConsistency,
	context: string
): QueryPlan['meta'] {
	const current = datastoreReadPolicyFromMeta(meta, `${context} policy`);
	if (current?.readTime !== undefined) {
		throw new ActiveTsConfigurationError(`${context} cannot be combined with readAt().`);
	}
	return {
		...clonePlanMeta(meta),
		datastoreRead: normalizeDatastoreReadPolicy({ consistency }, context)
	};
}

export class QueryBuilder<TModel extends { data: any }, TData extends Record<string, any> = TModel['data']> {
	private readonly plan: QueryPlan<TData> = {
		where: [],
		or: [],
		sort: [],
		include: [],
		limit: undefined,
		offset: undefined,
		cursor: undefined,
		select: undefined,
		native: undefined,
		meta: undefined
	};
	private readonly constraints: QueryPlan<TData>['where'] = [];

	constructor(
		private readonly context: ActiveContext,
		private readonly model: ModelConstructor<TModel>,
		private readonly retainRelationInstantiationData = false
	) {}

	private activeContext(operation: string) {
		return this.context.transactionScopedContext(operation);
	}

	where(shape: WhereShape<TData>): this;
	where(field: keyof TData | string, value: WhereScalar): this;
	where(field: keyof TData | string, op: '=' | '!=' | 'arrayContains', value: WhereScalar): this;
	where(field: keyof TData | string, op: 'in', value: readonly WhereScalar[]): this;
	where(field: keyof TData | string, op: '>' | '>=' | '<' | '<=', value: WhereRangeScalar): this;
	where(field: keyof TData | string, op: 'between', value: WhereRangeScalar, value2: WhereRangeScalar): this;
	where(field: keyof TData | string, op: 'textContains' | 'startsWith', value: string): this;
	where(field: keyof TData | string, op: 'jsonContains', value: unknown): this;
	where(fieldOrShape: keyof TData | string | WhereShape<TData>, op?: Operator | unknown, value?: unknown, value2?: unknown) {
		if (typeof fieldOrShape === 'object') this.plan.where.push(...normalizeWhere(fieldOrShape));
		else if (arguments.length >= 3 && typeof op === 'string' && isOperator(op)) {
			const field = assertSafeFieldPath(fieldOrShape, 'query field');
			const operator = op as Operator;
			const hasValue2 = arguments.length >= 4;
			assertValidWhereOperand(operator, value, value2, field);
			if (operator !== 'between' && hasValue2) {
				throw new ActiveTsValidationError(`Query operator "${operator}" on "${field}" does not accept value2.`);
			}
			const entry: QueryPlan<TData>['where'][number] = {
				field,
				op: operator,
				value: cloneQueryOperand(value)
			};
			if (hasValue2) entry.value2 = cloneQueryOperand(value2);
			this.plan.where.push(entry);
		} else {
			const field = assertSafeFieldPath(fieldOrShape, 'query field');
			if (value !== undefined) {
				throw new ActiveTsValidationError(invalidValueMessage('Query operator', op));
			}
			assertValidWhereOperand('=', op, undefined, field);
			this.plan.where.push({
				field,
				op: '=',
				value: cloneQueryOperand(op)
			});
		}
		return this;
	}

	orWhere(shape: WhereShape<TData>) {
		if (this.plan.where.length) {
			throw new ActiveTsConfigurationError(
				'orWhere() cannot be chained after where(); use whereAny([...]) for explicit OR groups.'
			);
		}
		const where = normalizeWhere(shape);
		if (!where.length) throw new ActiveTsValidationError('orWhere() requires at least one where condition.');
		this.plan.or.push({ where, or: [], sort: [], include: [] });
		return this;
	}

	whereAny(branches: WhereShape<TData>[]): this;
	whereAny(...branches: WhereShape<TData>[]): this;
	whereAny(...branches: Array<WhereShape<TData> | WhereShape<TData>[]>) {
		const flattened = queryArrayValues<WhereShape<TData>>(
			branches.length === 1 && Array.isArray(branches[0]) ? branches[0] : branches,
			'whereAny branches'
		);
		if (!flattened.length) throw new ActiveTsValidationError('whereAny() requires at least one branch.');
		for (let index = 0; index < flattened.length; index++) {
			const where = normalizeWhere(flattened[index]);
			if (!where.length) {
				throw new ActiveTsValidationError(`whereAny branches[${index}] requires at least one where condition.`);
			}
			this.plan.or.push({ where, or: [], sort: [], include: [] });
		}
		return this;
	}

	orderBy(sort: SortSpec<TData>) {
		this.plan.sort.push(normalizeSort(sort));
		return this;
	}

	limit(limit: number) {
		this.plan.limit = assertSafeLimit(limit, 'query limit');
		return this;
	}

	offset(offset: number) {
		const safeOffset = assertSafeOffset(offset, 'query offset');
		assertCompatibleQueryPagination(safeOffset, this.plan.cursor);
		this.plan.offset = safeOffset;
		return this;
	}

	cursor(cursor: string | undefined) {
		const safeCursor = assertSafeCursor(cursor, 'query cursor');
		assertCompatibleQueryPagination(this.plan.offset, safeCursor);
		this.plan.cursor = safeCursor;
		return this;
	}

	select<K extends Extract<keyof TData, string>>(
		...fields: K[]
	): QueryBuilder<PartialModel<TModel, SelectedData<TData, K>>, TData>;
	select(...fields: string[]): QueryBuilder<PartialModel<TModel, Partial<TData> & SelectedIdData<TData>>, TData>;
	select(...fields: string[]) {
		const select: string[] = [];
		for (let index = 0; index < fields.length; index++) {
			select[index] = assertSafeFieldPath(fields[index], 'select field');
		}
		this.plan.select = select;
		return this as unknown as QueryBuilder<PartialModel<TModel, Partial<TData> & SelectedIdData<TData>>, TData>;
	}

	include(...relations: IncludeSpec[]) {
		this.plan.include.push(...normalizeIncludeSpecs(relations));
		return this;
	}

	scope(name: string, viewer?: unknown, args?: unknown) {
		const context = this.activeContext('resolve query scopes');
		const meta = context.meta(this.model);
		const resolver = mapGet(meta.scopes, assertSafeFieldPath(name, 'scope name'));
		if (!resolver) throw new ActiveTsConfigurationError(`Scope "${name}" is not registered on ${meta.name}.`);
		const where = resolver({ context, model: meta, viewer, args, scope: name });
		if (where !== undefined) this.constraints.push(...normalizeWhere(where as WhereShape<TData>));
		return this;
	}

	withDeleted() {
		this.plan.meta = { ...this.plan.meta, softDelete: 'with' };
		return this;
	}

	onlyDeleted() {
		this.plan.meta = { ...this.plan.meta, softDelete: 'only' };
		return this;
	}

	ancestor(key: DatastoreKey) {
		this.plan.meta = {
			...this.plan.meta,
			datastoreAncestor: normalizeDatastoreKey(key, 'query datastore ancestor')
		};
		return this;
	}

	under(key: DatastoreKey) {
		return this.ancestor(key);
	}

	readAt(readTime: number | Date) {
		this.plan.meta = withDatastoreReadTime(this.plan.meta, readTime, 'query readAt()');
		return this;
	}

	readConsistency(consistency: DatastoreReadConsistency) {
		this.plan.meta = withDatastoreReadConsistency(this.plan.meta, consistency, 'query readConsistency()');
		return this;
	}

	native(payload: unknown, adapter?: string) {
		this.plan.native = {
			adapter: adapter === undefined ? undefined : assertSafeSchemaIdentifier(adapter, 'native store adapter name'),
			payload: cloneRequiredNativePayload(payload)
		} satisfies QueryNative;
		return this;
	}

	first(): Promise<TModel | null> {
		return runTrackedContextOperation(
			() => this.activeContext('run queries'),
			async (context) => {
				const meta = context.meta(this.model);
				const res = await this.loadPlan({ ...this.compilePlan(meta.idField), limit: 1 }, meta, context);
				return res.list[0] ?? null;
			}
		);
	}

	find(id: EntityId): QueryFindLoader<TModel> {
		assertSafeEntityId(id, 'query find id');
		const includes: string[] = [];
		const load = (options: { select?: boolean; include?: boolean } = {}) =>
			runTrackedContextOperation(
				() => this.activeContext('run query find'),
				async (context) => {
					const meta = context.meta(this.model);
					const query = new QueryBuilder<TModel, TData>(this.context, this.model);
					query.plan.where = cloneWhereEntries(this.plan.where);
					query.plan.or = [];
					for (let index = 0; index < this.plan.or.length; index++) {
						query.plan.or[index] = cloneQueryBranch(this.plan.or[index]);
					}
					query.plan.sort = [];
					for (let index = 0; index < this.plan.sort.length; index++) {
						query.plan.sort[index] = { ...this.plan.sort[index] };
					}
					query.plan.limit = 2;
					query.plan.offset = undefined;
					query.plan.cursor = undefined;
					query.plan.select = options.select === false
						? undefined
						: this.plan.select ? [...this.plan.select] : undefined;
					query.plan.include = options.include === false
						? []
						: uniqueStrings([...this.plan.include, ...includes]);
					query.plan.native = this.plan.native
						? { adapter: this.plan.native.adapter, payload: cloneNativePayload(this.plan.native.payload) }
						: undefined;
					query.plan.meta = clonePlanMeta(this.plan.meta);
					if (meta.datastore?.ancestor && query.plan.meta?.datastoreAncestor === undefined) {
						throw new ActiveTsConfigurationError(
							`Datastore model "${meta.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
						);
					}
					query.constraints.push(...cloneWhereEntries(this.constraints), {
						field: meta.idField,
						op: '=',
						value: cloneQueryOperand(id)
					});
					const result = await query.load();
					if (result.list.length > 1) {
						throw new ActiveTsValidationError(`${meta.name}.find() matched multiple rows for id "${String(id)}".`);
					}
					const item = result.list[0] ?? null;
					if (!item) return null;
					const foundId = valueFor(item.data, meta.idField);
					if (foundId === undefined || foundId === null) {
						throw new ActiveTsValidationError(`${meta.name}.find() result is missing id field "${meta.idField}".`);
					}
					assertSafeEntityId(foundId, `${meta.name}.find() result ${meta.idField}`);
					if (entityIdKey(foundId) !== entityIdKey(id)) {
						throw new ActiveTsValidationError(`${meta.name}.find() result id field "${meta.idField}" must match the requested id.`);
					}
					return item;
				}
			);
		const loader: QueryFindLoader<TModel> = {
			include: (...relations: IncludeSpec[]) => {
				includes.push(...normalizeIncludeSpecs(relations));
				return loader;
			},
			load,
			update: (patch: Partial<TModel['data']>) => runTrackedContextOperation(
				() => this.activeContext('run query find'),
				async (context) => {
					if (datastoreReadPolicyFromMeta(this.plan.meta, 'query Datastore read policy')) {
						throw new ActiveTsConfigurationError(
							'Historical or explicitly consistent query find results cannot be updated through find().update().'
						);
					}
					const meta = context.meta(this.model);
					const scopedAncestor = this.plan.meta?.datastoreAncestor === undefined
						? undefined
						: normalizeDatastoreKey(this.plan.meta.datastoreAncestor, 'query datastore ancestor');
					const item = await load({ select: false, include: false });
					if (!item) return null;
					const safePatch = cloneSafeDataObject(patch, `${meta.name} query find update patch`);
					const patchId = safePatch[meta.idField];
					if (patchId !== undefined) {
						assertSafeEntityId(patchId, `${meta.name}.${meta.idField}`);
						if (entityIdKey(patchId) !== entityIdKey(id)) {
							throw new ActiveTsValidationError(`${meta.name} update patch cannot change id field "${meta.idField}".`);
						}
					}
					for (const key of Object.keys(safePatch)) {
						item.data[key] = safePatch[key];
					}
					assertDatastoreWriteMatchesScopedAncestor(
						meta,
						id,
						item.data,
						scopedAncestor,
						`${meta.name}.find().update()`
					);
					return await (item as any).save();
				}
			),
			delete: () => runTrackedContextOperation(
				() => this.activeContext('run query find'),
				async (context) => {
					if (datastoreReadPolicyFromMeta(this.plan.meta, 'query Datastore read policy')) {
						throw new ActiveTsConfigurationError(
							'Historical or explicitly consistent query find results cannot be deleted through find().delete().'
						);
					}
					const meta = context.meta(this.model);
					const scopedAncestor = this.plan.meta?.datastoreAncestor === undefined
						? undefined
						: normalizeDatastoreKey(this.plan.meta.datastoreAncestor, 'query datastore ancestor');
					const item = await load({ select: false, include: false });
					if (!item) return false;
					assertDatastoreWriteMatchesScopedAncestor(
						meta,
						id,
						item.data,
						scopedAncestor,
						`${meta.name}.find().delete()`
					);
					await (item as any).delete();
					return true;
				}
			)
		};
		return loader;
	}

	count() {
		return runTrackedContextOperation(
			() => this.activeContext('run aggregate queries'),
			async () => {
				const result = await this.aggregate({ count: 'count' });
				return Number(result.count ?? 0);
			}
		);
	}

	sum<TField extends string>(field: TField & AggregateFieldConstraint<TData, TField, number>) {
		return runTrackedContextOperation(
			() => this.activeContext('run aggregate queries'),
			async () => {
				const result = await this.aggregate({ sum: { op: 'sum', field } } as any);
				return Number(result.sum ?? 0);
			}
		);
	}

	avg<TField extends string>(field: TField & AggregateFieldConstraint<TData, TField, number>) {
		return runTrackedContextOperation(
			() => this.activeContext('run aggregate queries'),
			async () => {
				const result = await this.aggregate({ avg: { op: 'avg', field } } as any);
				return result.avg as number | null;
			}
		);
	}

	min<TField extends string>(
		field: TField & AggregateFieldConstraint<TData, TField, AggregateComparableValue>
	) {
		return runTrackedContextOperation(
			() => this.activeContext('run aggregate queries'),
			async () => {
				const result = await this.aggregate({ min: { op: 'min', field } } as any);
				return result.min as TField extends keyof TData ? TData[TField] | null : unknown;
			}
		);
	}

	max<TField extends string>(
		field: TField & AggregateFieldConstraint<TData, TField, AggregateComparableValue>
	) {
		return runTrackedContextOperation(
			() => this.activeContext('run aggregate queries'),
			async () => {
				const result = await this.aggregate({ max: { op: 'max', field } } as any);
				return result.max as TField extends keyof TData ? TData[TField] | null : unknown;
			}
		);
	}

	aggregate<const TSelection extends AggregateSelection<TData>>(
		selection: TSelection & AggregateSelectionFieldConstraint<TData, TSelection>
	): Promise<AggregateResult> {
		return runTrackedContextOperation(
			() => this.activeContext('run aggregate queries'),
			async () => {
				assertPlainObject(selection, 'aggregate selection');
				if (Object.getOwnPropertySymbols(selection).length) {
					throw new ActiveTsValidationError('aggregate selection cannot contain symbol aliases.');
				}
				const aggregateSpecs: AggregateSpec[] = [];
				const aliases = Object.getOwnPropertyNames(selection);
				for (let index = 0; index < aliases.length; index++) {
					const as = aliases[index];
					const spec = ownObjectValue(selection as Record<string, unknown>, as);
					if (typeof spec === 'string') {
						aggregateSpecs[index] = { op: spec as AggregateOperator, as } as AggregateSpec;
						continue;
					}
					if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
						aggregateSpecs[index] = spec as unknown as AggregateSpec;
						continue;
					}
					assertPlainObject(spec, `aggregate selection.${as}`);
					assertKnownObjectKeys(
						spec as Record<string, unknown>,
						AGGREGATE_SELECTION_SPEC_KEYS,
						`aggregate selection.${as}`
					);
					const op = ownObjectValue(spec as Record<string, unknown>, 'op');
					const field = ownObjectValue(spec as Record<string, unknown>, 'field');
					aggregateSpecs[index] = {
						op,
						field: field === undefined ? undefined : assertSafeFieldPath(field, 'aggregate field'),
						as
					} as AggregateSpec;
				}
				const specs = validateAggregateSpecs(aggregateSpecs);
				return await this.runAggregate(specs);
			}
		);
	}

	load(): Promise<QueryResult<TModel>> {
		return runTrackedContextOperation(
			() => this.activeContext('run queries'),
			async (context) => {
				const meta = context.meta(this.model);
				const initialPlan = this.compilePlan(meta.idField);
				return await this.loadPlan(initialPlan, meta, context);
			}
		);
	}

	private async loadPlan(
		initialPlan: QueryPlan<TData>,
		meta: ResolvedModelMeta,
		context: ActiveContext
	): Promise<QueryResult<TModel>> {
		const before = await context.runHooks('beforeQuery', {
			model: meta,
			plan: initialPlan,
			operation: 'query'
		});
		const sanitizedPlan = this.reapplyProtectedMeta(this.reapplyBaseConstraints(
			sanitizeQueryPlan(before.plan as QueryPlan<TData>, meta.idField)
		));
		const plan = encodeQueryPlanFieldCodecs(
			meta,
			normalizeQueryPlanFieldTypes(meta, sanitizedPlan)
		);
		if (plan.select?.length && plan.include.length) {
			throw new ActiveTsConfigurationError(
				'select() cannot be combined with include(); load the full model before relation preloading.'
			);
		}
		const readPolicy = datastoreReadPolicyFromMeta(plan.meta, 'query Datastore read policy');
		if (readPolicy && plan.include.length) {
			throw new ActiveTsConfigurationError(
				'Datastore readAt()/readConsistency() cannot be combined with include(); load related snapshots explicitly with the same policy.'
			);
		}
		const store = context.storeForQuery(meta, plan);
		const adapterPlan = stripStoreNativeAdapterTag(cloneQueryBranch(plan));
		const rawQueryResult = await store.query(meta, adapterPlan, {
			select: adapterPlan.select,
			native: adapterPlan.native?.payload,
			...(adapterPlan.meta === undefined ? {} : { meta: adapterPlan.meta })
		});
		const raw = normalizeStoreQueryResultForModel(meta, rawQueryResult, `Store adapter "${store.kind}" query`, {
			cursor: storeCapability(store.capabilities, 'cursor'),
			adapterKind: store.kind,
			datastoreAncestor: adapterPlan.meta?.datastoreAncestor,
			datastoreNamespace: store.datastoreNamespace,
			trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(store)
		});
		if (plan.select?.length) validateRawResultUniqueModelIds(meta, raw.list, `Store adapter "${store.kind}" query`);
		const scopedDatastoreAncestor = plan.meta?.datastoreAncestor === undefined
			? undefined
			: normalizeDatastoreKey(plan.meta.datastoreAncestor, 'query datastore ancestor');
		const list: TModel[] = [];
		for (let index = 0; index < raw.list.length; index++) {
			let relationInstantiationData: Record<string, any> | undefined;
			const item = context.instantiate(
				this.model,
				raw.list[index],
				{ partial: !!plan.select?.length },
				this.retainRelationInstantiationData
					? (data) => {
							relationInstantiationData = data;
						}
					: undefined
			);
			if (item) {
				if (readPolicy?.readTime !== undefined) markDatastoreHistoricalModel(item as object, readPolicy.readTime);
				list[list.length] = item;
				if (this.retainRelationInstantiationData) {
					WEAKMAP_SET.call(
						RELATION_INSTANTIATION_DATA,
						item as object,
						relationInstantiationData!
					);
				}
			}
		}
		attachDatastoreWriteAncestorScope(meta, list, scopedDatastoreAncestor);
		const afterInstantiateTasks: Array<Promise<void> | void> = [];
		for (let index = 0; index < list.length; index++) {
			afterInstantiateTasks[index] = context.runAfterInstantiateHooks(meta, list[index] as any, 'query');
		}
		await Promise.all(afterInstantiateTasks);
		const expectedIds = modelResultSnapshots(meta, list, 'afterQuery original result');
		await preloadIncludes(context, this.model, list, plan.include);
		if (plan.include.length) {
			validateModelResultIdentities(context, meta, list, expectedIds, 'afterRelationLoad query result');
		}
		const result = { ...raw, list, count: list.length };
		const after = await context.runHooks('afterQuery', {
			model: meta,
			plan,
			result,
			operation: 'query'
		});
		const sanitized = sanitizeModelResult(after.result, this.model, 'afterQuery', {
			activeContext: context,
			meta,
			expectedIds
		});
		attachDatastoreWriteAncestorScope(meta, sanitized.list, scopedDatastoreAncestor);
		return sanitized;
	}

	private async runAggregate(specs: AggregateSpec[]) {
		const context = this.activeContext('run aggregate queries');
		const meta = context.meta(this.model);
		const queryPlan = this.compilePlan(meta.idField);
		const plan: AggregatePlan<TData> = {
			where: queryPlan.where,
			or: queryPlan.or,
			aggregates: specs,
			native: queryPlan.native,
			meta: queryPlan.meta
		};
		const before = await context.runHooks('beforeAggregate', {
			model: meta,
			plan,
			operation: 'aggregate'
		});
		const sanitizedPlan = this.reapplyProtectedMeta(this.reapplyBaseConstraints(
			sanitizeAggregatePlan(before.plan as AggregatePlan<TData>)
		));
		const activePlan = encodeAggregatePlanFieldCodecs(
			meta,
			normalizeAggregatePlanFieldTypes(meta, sanitizedPlan)
		);
		assertAggregateSpecsCompatibleWithModel(meta, activePlan.aggregates, 'Aggregate');
		const activeSpecs = activePlan.aggregates;
		const store = context.storeForAggregate(meta, activePlan);
		let needsReadDecodedRows = false;
		for (let index = 0; index < activeSpecs.length; index++) {
			const field = activeSpecs[index].field;
			if (field && hasFieldCodecPathOverlap(meta, field)) {
				needsReadDecodedRows = true;
				break;
			}
		}
		if (needsReadDecodedRows && !context.allowsAggregateFallback()) {
			throw new ActiveTsConfigurationError(
				'Aggregates on field-codec fields require aggregate.allowQueryFallback so active-ts can decode stored values before aggregating.'
			);
		}
		if (!needsReadDecodedRows && store.aggregate && storeCapability(store.capabilities, 'aggregate')) {
			const adapterPlan = stripStoreNativeAdapterTag(cloneAggregatePlan(activePlan));
			const rawAggregate = sanitizeAggregateResult(
				await store.aggregate(meta, adapterPlan),
				activeSpecs,
				`Store adapter "${store.kind}" aggregate`
			);
			const result = normalizeAggregateFieldTypes(meta, activeSpecs, rawAggregate);
			const after = await context.runHooks('afterAggregate', {
				model: meta,
				plan: activePlan,
				result,
				operation: 'aggregate'
			});
			return normalizeAggregateFieldTypes(meta, activeSpecs, sanitizeAggregateResult(after.result, activeSpecs, 'afterAggregate'));
		}
		if (!context.allowsAggregateFallback()) {
			throw new ActiveTsConfigurationError(
				`Store adapter "${store.kind}" does not support native aggregate(). Enable aggregate.allowQueryFallback to compute aggregates through query().`
			);
		}
		const aggregateFields: string[] = [];
		for (let index = 0; index < activePlan.aggregates.length; index++) {
			const field = activePlan.aggregates[index].field;
			if (field) aggregateFields[aggregateFields.length] = field;
		}
		if (meta.datastore?.ancestorFields) {
			for (let index = 0; index < meta.datastore.ancestorFields.length; index++) {
				aggregateFields[aggregateFields.length] = meta.datastore.ancestorFields[index];
			}
		}
		const fields = uniqueStrings(aggregateFields);
		const select = fields.length && storeCapability(store.capabilities, 'select') ? fields : undefined;
		const fallbackPlan: QueryPlan<TData> = {
			where: activePlan.where,
			or: activePlan.or,
			sort: [],
			include: [],
			limit: undefined,
			offset: undefined,
			cursor: undefined,
			select: withIdField(select, meta.idField),
			native: activePlan.native,
			meta: activePlan.meta
		};
		const adapterPlan = stripStoreNativeAdapterTag(cloneQueryBranch(fallbackPlan));
		const raw = normalizeStoreQueryResultForModel(
			meta,
			await store.query(meta, adapterPlan, {
				select: adapterPlan.select,
				native: adapterPlan.native?.payload,
				...(adapterPlan.meta === undefined ? {} : { meta: adapterPlan.meta })
			}),
			`Store adapter "${store.kind}" aggregate fallback query`,
			{
				cursor: storeCapability(store.capabilities, 'cursor'),
				adapterKind: store.kind,
				datastoreAncestor: adapterPlan.meta?.datastoreAncestor,
				datastoreNamespace: store.datastoreNamespace,
				trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(store)
			}
		);
		const rows: Array<Record<string, any>> = [];
		for (let index = 0; index < raw.list.length; index++) {
			rows[index] = context.validateRead(meta, raw.list[index], { partial: true });
		}
		const result = normalizeAggregateFieldTypes(meta, activeSpecs, aggregateRows(rows, activeSpecs));
		const after = await context.runHooks('afterAggregate', {
			model: meta,
			plan: activePlan,
			result,
			operation: 'aggregate'
		});
		return normalizeAggregateFieldTypes(meta, activeSpecs, sanitizeAggregateResult(after.result, activeSpecs, 'afterAggregate'));
	}

	private compilePlan(idField: string): QueryPlan<TData> {
		const baseWhere = this.compileBaseConstraints();
		const or: QueryPlan<TData>['or'] = [];
		for (let index = 0; index < this.plan.or.length; index++) {
			or[index] = constrainOrBranch(cloneQueryBranch(this.plan.or[index]), baseWhere);
		}
		const sort: QueryPlan<TData>['sort'] = [];
		for (let index = 0; index < this.plan.sort.length; index++) sort[index] = { ...this.plan.sort[index] };
		return {
			where: this.plan.or.length ? [] : cloneWhereEntries(baseWhere),
			or,
			sort,
			limit: this.plan.limit,
			offset: this.plan.offset,
			cursor: this.plan.cursor,
			select: withIdField(this.plan.select, idField),
			include: [...this.plan.include],
			native: this.plan.native
				? { adapter: this.plan.native.adapter, payload: cloneNativePayload(this.plan.native.payload) }
				: undefined,
			meta: clonePlanMeta(this.plan.meta)
		};
	}

	private compileBaseConstraints(): QueryPlan<TData>['where'] {
		return [...cloneWhereEntries(this.constraints), ...cloneWhereEntries(this.plan.where)];
	}

	private reapplyBaseConstraints<TPlan extends QueryPlan<TData> | AggregatePlan<TData>>(plan: TPlan): TPlan {
		if (!this.plan.or.length || !plan.or.length) return plan;
		const baseWhere = this.compileBaseConstraints();
		if (!baseWhere.length) return plan;
		const or: TPlan['or'] = [] as TPlan['or'];
		for (let index = 0; index < plan.or.length; index++) {
			or[index] = constrainOrBranch(plan.or[index], baseWhere);
		}
		return {
			...plan,
			where: [],
			or
		};
	}

	private reapplyProtectedMeta<TPlan extends QueryPlan<TData> | AggregatePlan<TData>>(plan: TPlan): TPlan {
		const ancestor = this.plan.meta?.datastoreAncestor;
		const readPolicy = datastoreReadPolicyFromMeta(this.plan.meta, 'query Datastore read policy');
		if (ancestor === undefined && readPolicy === undefined) return plan;
		const meta = clonePlanMeta(plan.meta) ?? {};
		if (ancestor !== undefined) {
			meta.datastoreAncestor = normalizeDatastoreKey(ancestor, 'query datastore ancestor');
		}
		if (readPolicy !== undefined) meta.datastoreRead = readPolicy;
		return {
			...plan,
			meta
		};
	}
}

async function preloadIncludes(
	context: ActiveContext,
	ownerModel: ModelConstructor,
	list: any[],
	includes: string[]
) {
	if (!list.length || !includes.length) return;
	const ownerMeta = context.meta(ownerModel);
	const expectedOwnerIds = modelResultSnapshots(ownerMeta, list, 'include original result');
	const grouped = new Map<string, string[]>();
	for (const include of includes) {
		const [relation, nested] = splitIncludePath(include);
		if (!relation) continue;
		const paths = mapGet(grouped, relation) ?? [];
		if (nested) paths.push(nested);
		mapSet(grouped, relation, paths);
	}

	for (const [relationName, nested] of MAP_ENTRIES.call(grouped)) {
		const relation = mapGet(ownerMeta.relations, relationName);
		if (!relation) throw new ActiveTsConfigurationError(`Relation "${relationName}" is not registered on ${ownerMeta.name}.`);
		const target = relation.target();
		const targetMeta = context.meta(target);
		try {
			for (const item of list) {
				item.ref(relationName).markPlanned();
				await context.runHooks('beforeRelationLoad', {
					model: ownerMeta,
					target: item,
					operation: 'relation',
					meta: { relation: relationName }
				});
				validateModelResultIdentities(
					context,
					ownerMeta,
					[item],
					expectedOwnerIds,
					`beforeRelationLoad ${ownerMeta.name}.${relationName} target`,
					{ exactDatastoreAncestor: true }
				);
			}

			const owners: Array<{ item: any; localValue: unknown; localKeySnapshot: RelationOwnerLocalKeySnapshot }> = [];
			const activeOwners: Array<{
				item: any;
				localValue: unknown;
				joinKey: string;
				targetJoinKey: string;
				ancestor?: DatastoreKey;
				ancestorIdentity: string;
			}> = [];
			for (let index = 0; index < list.length; index++) {
				const item = list[index];
				const localValue = valueFor(item.data, relation.localKey);
				owners[index] = {
					item,
					localValue,
					localKeySnapshot: snapshotRelationOwnerLocalKey(
						context,
						ownerMeta,
						item,
						relation,
						`beforeRelationLoad ${ownerMeta.name}.${relationName} target item`
					)
				};
				if (localValue !== undefined && localValue !== null) {
					const ancestor = relationAncestorForOwner(context, ownerMeta, targetMeta, relation, item);
					const { joinKey, targetJoinKey } = relationTargetJoinKeys(
						targetMeta,
						relation,
						localValue,
						item.data,
						`${ownerMeta.name}.${relation.name}`
					);
					activeOwners[activeOwners.length] = {
						item,
						localValue,
						joinKey,
						targetJoinKey,
						ancestor,
						ancestorIdentity: datastoreAncestorIdentity(ancestor)
					};
				}
			}

			let resultByOwner = new Map<any, any | any[] | null>();
			if (activeOwners.length) {
				const valuesByJoinKey = new Map<string, unknown>();
				for (const { joinKey, localValue } of activeOwners) mapSet(valuesByJoinKey, joinKey, localValue);
				const values = iterableToArray(MAP_VALUES.call(valuesByJoinKey) as Iterable<unknown>) as any[];
				let relationUsesAncestor = relation.ancestor !== undefined;
				for (let index = 0; index < activeOwners.length; index++) {
					if (activeOwners[index].ancestor === undefined) continue;
					relationUsesAncestor = true;
					break;
				}
				let needsTargetAncestorFieldMatch = false;
				for (let index = 0; index < activeOwners.length; index++) {
					if (activeOwners[index].targetJoinKey === activeOwners[index].joinKey) continue;
					needsTargetAncestorFieldMatch = true;
					break;
				}
				const targetHasDatastoreAncestorFields = (targetMeta.datastore?.ancestorFields?.length ?? 0) > 0;
				if (
					relation.kind === 'one' &&
					relation.foreignKey === targetMeta.idField &&
					!relation.preload?.length &&
					!needsTargetAncestorFieldMatch &&
					!targetHasDatastoreAncestorFields
				) {
					for (let index = 0; index < values.length; index++) {
						assertSafeEntityId(values[index], `${ownerMeta.name}.${relation.name} relation key`);
					}
					if (relationUsesAncestor) {
						const loadTasks: Array<Promise<void>> = [];
						resultByOwner = new Map<any, any | any[] | null>();
						for (let index = 0; index < activeOwners.length; index++) {
							const owner = activeOwners[index];
							loadTasks[index] = (async () => {
								let query = new QueryBuilder<any>(context, target);
								if (owner.ancestor) query = query.ancestor(owner.ancestor);
								mapSet(resultByOwner, owner.item, await query.find(owner.localValue as EntityId).load());
							})();
						}
						await Promise.all(loadTasks);
					} else {
						const loadTasks: Array<Promise<any>> = [];
						for (let index = 0; index < activeOwners.length; index++) {
							loadTasks[index] = context.loadById(target, activeOwners[index].localValue as EntityId);
						}
						const loaded = await Promise.all(loadTasks);
						resultByOwner = new Map<any, any | any[] | null>();
						for (let index = 0; index < activeOwners.length; index++) {
							mapSet(resultByOwner, activeOwners[index].item, loaded[index] ?? null);
						}
					}
				} else {
					for (let index = 0; index < values.length; index++) {
						const value = values[index];
						if (relation.foreignKey === targetMeta.idField)
							assertSafeEntityId(value, `${ownerMeta.name}.${relation.name} relation key`);
						else assertPortableScalar(value, `${ownerMeta.name}.${relation.name} relation key`);
					}
					if (relationUsesAncestor) {
						resultByOwner = new Map<any, any | any[] | null>();
						const groups = groupActiveOwnersByAncestor(activeOwners);
						for (const group of groups) {
							const groupValuesByJoinKey = new Map<string, unknown>();
							for (const owner of group.owners) mapSet(groupValuesByJoinKey, owner.joinKey, owner.localValue);
							const groupValues = iterableToArray(MAP_VALUES.call(groupValuesByJoinKey) as Iterable<unknown>) as any[];
							const byForeign = new Map<any, any[]>();
							for (const chunk of chunkArray(groupValues, MAX_PORTABLE_IN_VALUES)) {
								let query = new QueryBuilder<any>(context, target, true).where(relation.foreignKey, 'in', chunk);
								if (group.ancestor) query = query.ancestor(group.ancestor);
								if (!nested.length && relation.preload?.length) {
									const select = relationPreloadSelectFields(
										context,
										targetMeta,
										[{ field: relation.foreignKey, op: 'in', value: chunk }],
										[relation.foreignKey, ...relation.preload]
									);
									if (select) query.select(...select);
								}
								for (const targetItem of (await query.load()).list) {
									const foreignValue = valueFor(targetItem.data, relation.foreignKey);
									if (foreignValue === undefined || foreignValue === null) continue;
									const { joinKey, targetJoinKey } = relationTargetJoinKeys(
										targetMeta,
										relation,
										foreignValue,
										targetItem.data,
										`${targetMeta.name}.${relation.foreignKey}`
									);
									const unscopedBucket = mapGet(byForeign, joinKey) ?? [];
									unscopedBucket.push(targetItem);
									mapSet(byForeign, joinKey, unscopedBucket);
									if (targetJoinKey === joinKey) continue;
									const bucket = mapGet(byForeign, targetJoinKey) ?? [];
									bucket.push(targetItem);
									mapSet(byForeign, targetJoinKey, bucket);
								}
							}
							for (const owner of group.owners) {
								const matches = mapGet(byForeign, owner.targetJoinKey) ?? [];
								assertUnambiguousDatastoreRelationFallback(ownerMeta, targetMeta, relation, owner, matches);
								mapSet(resultByOwner, owner.item, relation.kind === 'many' ? matches : matches[0] ?? null);
							}
						}
					} else {
						const loaded: any[] = [];
						for (const chunk of chunkArray(values, MAX_PORTABLE_IN_VALUES)) {
							const query = new QueryBuilder<any>(context, target, true).where(relation.foreignKey, 'in', chunk);
							if (!nested.length && relation.preload?.length) {
								const select = relationPreloadSelectFields(
									context,
									targetMeta,
									[{ field: relation.foreignKey, op: 'in', value: chunk }],
									[relation.foreignKey, ...relation.preload]
								);
								if (select) query.select(...select);
							}
							loaded.push(...(await query.load()).list);
						}
						const byForeign = new Map<any, any[]>();
						for (const targetItem of loaded) {
							const foreignValue = valueFor(targetItem.data, relation.foreignKey);
							if (foreignValue === undefined || foreignValue === null) continue;
							const key = portableScalarKey(foreignValue, `${targetMeta.name}.${relation.foreignKey} relation key`);
							const bucket = mapGet(byForeign, key) ?? [];
							bucket.push(targetItem);
							mapSet(byForeign, key, bucket);
						}
						resultByOwner = new Map<any, any | any[] | null>();
						for (const { item, joinKey } of activeOwners) {
							const matches = mapGet(byForeign, joinKey) ?? [];
							assertUnambiguousDatastoreRelationFallback(ownerMeta, targetMeta, relation, { joinKey, targetJoinKey: joinKey }, matches);
							mapSet(resultByOwner, item, relation.kind === 'many' ? matches : matches[0] ?? null);
						}
					}
				}
			}

			const relationResultUseCounts = new Map<any, number>();
			for (const { item } of owners) {
				const sharedResult = mapGet(resultByOwner, item);
				const sharedItems = Array.isArray(sharedResult) ? sharedResult : sharedResult ? [sharedResult] : [];
				for (let index = 0; index < sharedItems.length; index++) {
					const source = sharedItems[index];
					mapSet(relationResultUseCounts, source, (mapGet(relationResultUseCounts, source) ?? 0) + 1);
				}
			}
			const sharedRelationResultSnapshots = new Map<any, {
				data: Record<string, any>;
				partial: boolean;
				datastoreAncestor?: DatastoreKey;
			}>();
			for (const { item } of owners) {
				const sharedResult = mapGet(resultByOwner, item);
				const sharedItems = Array.isArray(sharedResult) ? sharedResult : sharedResult ? [sharedResult] : [];
				for (let index = 0; index < sharedItems.length; index++) {
					const source = sharedItems[index];
					const instantiationData = WEAKMAP_GET.call(
						RELATION_INSTANTIATION_DATA,
						source as object
					) as Record<string, any> | undefined;
					WEAKMAP_DELETE.call(RELATION_INSTANTIATION_DATA, source as object);
					if ((mapGet(relationResultUseCounts, source) ?? 0) < 2) continue;
					if (mapGet(sharedRelationResultSnapshots, source) !== undefined) continue;
					const scopedAncestor = (source as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
					mapSet(sharedRelationResultSnapshots, source, {
						data: instantiationData ?? cloneSafeDataObject(
							source.data,
							`${targetMeta.name} shared relation result data`
						),
						partial: isPartialModel(source),
						datastoreAncestor: scopedAncestor === undefined
							? undefined
							: normalizeDatastoreKey(
									scopedAncestor,
									`${targetMeta.name} shared relation result Datastore ancestor`
								)
					});
				}
			}
			const relationResultUses = new Map<any, number>();
			const relatedForNested: any[] = [];
			const nestedParentSnapshots: Array<{
				item: any;
				localKeySnapshot: RelationOwnerLocalKeySnapshot;
				result: any;
				resultSnapshot: ReturnType<typeof snapshotRelationResult>;
			}> = [];
			for (const { item, localKeySnapshot } of owners) {
				const empty = relation.kind === 'many' ? [] : null;
				const sharedResult = mapGet(resultByOwner, item) ?? empty;
				const sharedItems = Array.isArray(sharedResult) ? sharedResult : sharedResult ? [sharedResult] : [];
				const isolatedItems: any[] = [];
				for (let index = 0; index < sharedItems.length; index++) {
					const source = sharedItems[index];
					const useCount = mapGet(relationResultUses, source) ?? 0;
					mapSet(relationResultUses, source, useCount + 1);
					if (useCount === 0) {
						isolatedItems[index] = source;
						continue;
					}
					const snapshot = mapGet(sharedRelationResultSnapshots, source)!;
					const isolated = new target(
						cloneSafeDataObject(snapshot.data, `${targetMeta.name} relation result data`),
						context,
						{ persisted: true, [MODEL_PERSISTED_TOKEN]: true }
					);
					if (snapshot.partial) markPartialModel(isolated as object);
					if (snapshot.datastoreAncestor !== undefined) {
						Object.defineProperty(isolated, MODEL_DATASTORE_WRITE_ANCESTOR, {
							value: snapshot.datastoreAncestor,
							enumerable: false,
							configurable: true,
							writable: true
						});
					}
					await context.runAfterInstantiateHooks(targetMeta, isolated, 'query');
					isolatedItems[index] = isolated;
				}
				let result = Array.isArray(sharedResult) ? isolatedItems : isolatedItems[0] ?? null;
				item.ref(relationName).prime(result, { full: nested.length > 0 });
				const resultSnapshot = snapshotRelationResult(
					context,
					relation,
					result,
					`afterRelationLoad ${ownerMeta.name}.${relationName}`
				);
				const after = await context.runHooks('afterRelationLoad', {
					model: ownerMeta,
					target: item,
					result,
					operation: 'relation',
					meta: { relation: relationName }
				});
				result = after.result;
				validateModelResultIdentities(
					context,
					ownerMeta,
					[item],
					expectedOwnerIds,
					`afterRelationLoad ${ownerMeta.name}.${relationName} target`,
					{ exactDatastoreAncestor: true }
				);
				validateRelationOwnerLocalKeySnapshot(
					context,
					localKeySnapshot,
					item,
					`afterRelationLoad ${ownerMeta.name}.${relationName} target item`
				);
				validateRelationResultSnapshot(
					context,
					resultSnapshot,
					result,
					`afterRelationLoad ${ownerMeta.name}.${relationName}`
				);
				item.ref(relationName).prime(result, { full: nested.length > 0 });
				if (Array.isArray(result)) relatedForNested.push(...result);
				else if (result) relatedForNested.push(result);
				if (nested.length) {
					nestedParentSnapshots[nestedParentSnapshots.length] = {
						item,
						localKeySnapshot,
						result,
						resultSnapshot
					};
				}
			}
			if (nested.length && relatedForNested.length) {
				await preloadIncludes(context, target, relatedForNested, nested);
				for (const { item, localKeySnapshot, result, resultSnapshot } of nestedParentSnapshots) {
					validateModelResultIdentities(
						context,
						ownerMeta,
						[item],
						expectedOwnerIds,
						`afterRelationLoad ${ownerMeta.name}.${relationName} target`,
						{ exactDatastoreAncestor: true }
					);
					validateRelationOwnerLocalKeySnapshot(
						context,
						localKeySnapshot,
						item,
						`afterRelationLoad ${ownerMeta.name}.${relationName} target item`
					);
					validateRelationResultSnapshot(
						context,
						resultSnapshot,
						result,
						`afterRelationLoad ${ownerMeta.name}.${relationName}`
					);
				}
			}
		} catch (error) {
			for (const item of list) {
				try {
					item.ref(relationName).clear();
				} catch {
					// Preserve the relation load failure; this cleanup is best-effort.
				}
			}
			throw error;
		}
	}
}

function chunkArray<T>(items: T[], size: number) {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks[chunks.length] = copyArrayRange(items, index, index + size);
	}
	return chunks;
}

function datastoreAncestorIdentity(ancestor: DatastoreKey | undefined) {
	if (!ancestor) return '';
	return datastoreKeyIdentity(ancestor);
}

function datastoreAncestorMatches(left: DatastoreKey | undefined, right: DatastoreKey | undefined) {
	return datastoreScopedAncestorMatches(left, right);
}

function datastoreAncestorIdentitiesEqual(actual: DatastoreKey | undefined, expected: DatastoreKey) {
	return actual !== undefined && datastoreKeyIdentity(normalizeDatastoreKey(actual)) === datastoreKeyIdentity(expected);
}

function datastoreExpectedResultAncestor(
	meta: ResolvedModelMeta,
	item: { data: Record<string, any> },
	id: EntityId,
	context: string
) {
	if (!meta.datastore?.ancestor) return undefined;
	const scoped = (item as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
	if (scoped !== undefined) return normalizeDatastoreKey(scoped, `${context} Datastore ancestor`);
	const ancestor = datastorePayloadResolvedAncestor(meta, id, item.data, context) ??
		(isPartialModel(item as object) ? undefined : meta.datastore.ancestor({ model: meta, id, data: item.data }));
	if (ancestor === undefined) {
		if (isPartialModel(item as object)) return undefined;
		throw new ActiveTsValidationError(`${context} is missing Datastore ancestor metadata.`);
	}
	return normalizeDatastoreKey(ancestor, `${context} Datastore ancestor`);
}

function attachDatastoreWriteAncestorScope<T extends object>(
	meta: ResolvedModelMeta,
	list: readonly T[],
	ancestor: DatastoreKey | undefined
) {
	if (ancestor === undefined || !meta.datastore?.ancestor) return;
	for (let index = 0; index < list.length; index++) {
		if ((list[index] as any)[MODEL_DATASTORE_WRITE_ANCESTOR] !== undefined) continue;
		const resolvedAncestor = datastoreResultAncestorFromData(meta, list[index]);
		const retainedAncestor = resolvedAncestor === undefined
			? ancestor
			: datastoreKeyWithNamespace(
					resolvedAncestor,
					ancestor.namespace,
					`${meta.name} query result retained Datastore ancestor`
				);
		Object.defineProperty(list[index], MODEL_DATASTORE_WRITE_ANCESTOR, {
			value: retainedAncestor,
			enumerable: false,
			configurable: true,
			writable: true
		});
	}
}

function datastoreResultAncestorFromData(meta: ResolvedModelMeta, item: object) {
	const data = (item as { data?: Record<string, any> }).data;
	if (!data) return undefined;
	const id = valueFor(data, meta.idField);
	if (id === undefined || id === null) return undefined;
	assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
	return datastorePayloadResolvedAncestor(meta, id, data, `${meta.name} query result`);
}

function assertDatastoreWriteMatchesScopedAncestor(
	meta: ResolvedModelMeta,
	id: EntityId,
	data: Record<string, any>,
	expected: DatastoreKey | undefined,
	context: string
) {
	if (expected === undefined || !meta.datastore?.ancestor) return;
	const actual = datastorePayloadResolvedAncestor(meta, id, data, context) ??
		meta.datastore.ancestor({ model: meta, id, data });
	if (datastoreAncestorMatches(actual, expected)) return;
	throw new ActiveTsValidationError(`${context} cannot move ${meta.name}:${String(id)} outside the scoped Datastore ancestor.`);
}

function groupActiveOwnersByAncestor<T extends { ancestor?: DatastoreKey; ancestorIdentity: string }>(owners: T[]) {
	const groups = new Map<string, { ancestor?: DatastoreKey; owners: T[] }>();
	for (let index = 0; index < owners.length; index++) {
		const owner = owners[index];
		const group = mapGet(groups, owner.ancestorIdentity) ?? { ancestor: owner.ancestor, owners: [] };
		group.owners[group.owners.length] = owner;
		mapSet(groups, owner.ancestorIdentity, group);
	}
	return iterableToArray(MAP_VALUES.call(groups) as Iterable<{ ancestor?: DatastoreKey; owners: T[] }>);
}

export class FindBuilder<TModel extends { data: any }> {
	private includes: string[] = [];
	private readPolicy?: DatastoreReadPolicy;

	constructor(
		private readonly context: ActiveContext,
		private readonly model: ModelConstructor<TModel>,
		private readonly id: EntityId
	) {}

	private activeContext(operation: string) {
		return this.context.transactionScopedContext(operation);
	}

	include(...relations: IncludeSpec[]) {
		this.includes.push(...normalizeIncludeSpecs(relations));
		return this;
	}

	readAt(readTime: number | Date) {
		const meta = withDatastoreReadTime(
			this.readPolicy === undefined ? undefined : { datastoreRead: this.readPolicy },
			readTime,
			'find readAt()'
		);
		this.readPolicy = datastoreReadPolicyFromMeta(meta, 'find Datastore read policy');
		return this;
	}

	readConsistency(consistency: DatastoreReadConsistency) {
		const meta = withDatastoreReadConsistency(
			this.readPolicy === undefined ? undefined : { datastoreRead: this.readPolicy },
			consistency,
			'find readConsistency()'
		);
		this.readPolicy = datastoreReadPolicyFromMeta(meta, 'find Datastore read policy');
		return this;
	}

	load() {
		return runTrackedContextOperation(
			() => this.activeContext('load by id'),
			async (context) => {
				const meta = context.meta(this.model);
				const includes = [...this.includes];
				if (this.readPolicy !== undefined && includes.length) {
					throw new ActiveTsConfigurationError(
						'Datastore readAt()/readConsistency() cannot be combined with include(); load related snapshots explicitly with the same policy.'
					);
				}
				const item = (this.readPolicy === undefined
					? await context.loadById(this.model, this.id)
					: await context.loadByIdFresh(
							this.model,
							this.id,
							'read',
							datastoreReadOptions(this.readPolicy)
						)) as TModel | null;
				if (item) {
					const expectedIds = modelResultSnapshots(meta, [item], 'find original result');
					await (item as any).include(...includes);
					validateModelResultIdentities(context, meta, [item as any], expectedIds, 'find include result');
				}
				return item;
			}
		);
	}
}

type SearchResultModel<TModel extends { data: any }, TIncludes extends boolean> =
	TIncludes extends true ? TModel : PartialModel<TModel>;

export class SearchBuilder<TModel extends { data: any }, TIncludes extends boolean = false> {
	private adapterName?: string;
	private options: SearchOptions = {};
	private includes: string[] = [];
	private readonly text: string;

	constructor(
		private readonly context: ActiveContext,
		private readonly model: ModelConstructor<TModel>,
		text: string
	) {
		this.text = sanitizeSearchQuery(text);
	}

	private activeContext(operation: string) {
		return this.context.transactionScopedContext(operation);
	}

	using(adapterName: string) {
		this.adapterName = assertSafeSchemaIdentifier(adapterName, 'search adapter name');
		return this;
	}

	where(where: WhereShape) {
		const safeWhere = assertPlainWhereShape(where, 'search where') as WhereShape;
		const existing = this.options.where ? whereShapeToEntries(this.options.where) : [];
		const next = normalizeWhere(safeWhere, 'search where');
		const seen = new Set<string>();
		for (const entry of existing) SET_ADD.call(seen, entry.field);
		for (const entry of next) {
			if (SET_HAS.call(seen, entry.field)) {
				throw new ActiveTsValidationError(
					`Search where cannot merge multiple filters for field "${entry.field}". Use a single operator expression for that field.`
				);
			}
			SET_ADD.call(seen, entry.field);
		}
		this.options.where = whereEntriesToShape([...existing, ...next]);
		return this;
	}

	limit(limit: number) {
		this.options.limit = assertSafeLimit(limit, 'search limit');
		return this;
	}

	cursor(cursor: string | undefined) {
		this.options.cursor = assertSafeCursor(cursor, 'search cursor');
		return this;
	}

	include(...relations: IncludeSpec[]) {
		this.includes.push(...normalizeIncludeSpecs(relations));
		return this as unknown as SearchBuilder<TModel, true>;
	}

	native(payload: unknown) {
		this.options.native = cloneRequiredNativePayload(payload);
		return this;
	}

	load(): Promise<QueryResult<SearchResultModel<TModel, TIncludes>>> {
		return runTrackedContextOperation(
			() => this.activeContext('run searches'),
			async (context) => {
				const meta = context.meta(this.model);
				const adapterName = this.adapterName;
				const includes = [...this.includes];
				const searchOptions = cloneSearchOptions(this.options);
				const before = await context.runHooks('beforeSearch', {
					model: meta,
					query: this.text,
					options: searchOptions,
					operation: 'search'
				});
				const query = sanitizeSearchQuery(before.query ?? this.text);
				const sanitizedOptions = sanitizeSearchOptions(before.options as SearchOptions);
				const options = {
					...sanitizedOptions,
					where: normalizeWhereShapeFieldTypes(meta, sanitizedOptions.where)
				};
				const route = context.searchAdapterRouteFor(
					meta,
					query,
					options,
					adapterName
				);
				const adapterMeta = withDatastoreSearchNamespace(
					withSearchIndexesForAdapter(meta, route.name, route.indexKind),
					contextInternalStore(context, meta.store).datastoreNamespace
				);
				const raw = sanitizeRawResult(
					await route.adapter.search(adapterMeta, query, cloneSearchOptions(options)),
					`Search adapter "${route.adapter.kind}" search`,
					{
						cursor: searchCapability(route.adapter.capabilities, 'cursor'),
						adapterKind: route.adapter.kind,
						adapterType: 'Search'
					}
				);
				let list: TModel[];
				let staleHits = 0;
				if (includes.length) {
					const fullHits = await this.loadFullSearchHits(adapterMeta, raw.list, context, options.where);
					list = fullHits.list;
					staleHits = fullHits.staleHits;
				} else {
					list = [];
					const idsByKey = new Map<string, EntityId>();
					for (let index = 0; index < raw.list.length; index++) {
						const rawItem = raw.list[index];
						const id = this.searchHitId(adapterMeta, rawItem);
						if (!this.searchHitMatchesDocumentIdentity(adapterMeta, id, rawItem)) {
							staleHits++;
							continue;
						}
						this.rememberSearchHitId(adapterMeta, idsByKey, id, rawItem);
						const projected = projectSearchDocument(adapterMeta, route.indexKind, id, rawItem, {
							preserveSearchDocumentIdentity: true
						});
						const item = context.instantiate(this.model, projected, { partial: true, fieldCodecs: false });
						const projectedIdentity = searchHitDocumentIdentity(projected);
						if (item && projectedIdentity !== undefined) {
							markSearchDocumentIdentity(item.data, projectedIdentity);
						}
						if (item) list[list.length] = item;
					}
				}
				if (!includes.length) {
					const afterInstantiateTasks: Array<Promise<void> | void> = [];
					for (let index = 0; index < list.length; index++) {
						afterInstantiateTasks[index] = context.runAfterInstantiateHooks(meta, list[index] as any, 'search');
					}
					await Promise.all(afterInstantiateTasks);
				}
				const expectedIds = modelResultSnapshots(meta, list, 'afterSearch original result', { searchIdentityMeta: adapterMeta });
				if (includes.length) {
					const includeTasks: Array<Promise<void> | void> = [];
					for (let index = 0; index < list.length; index++) {
						includeTasks[index] = (list[index] as any).include(...includes);
					}
					await Promise.all(includeTasks);
					validateModelResultIdentities(context, meta, list, expectedIds, 'afterRelationLoad search result');
				}
				const result = { ...raw, list, count: list.length, total: staleHits ? undefined : raw.total };
				const after = await context.runHooks('afterSearch', {
					model: meta,
					query,
					options,
					result,
					operation: 'search'
				});
				return sanitizeModelResult(after.result, this.model, 'afterSearch', {
					activeContext: context,
					meta,
					expectedIds
				}) as QueryResult<SearchResultModel<TModel, TIncludes>>;
			}
		);
	}

	private async loadFullSearchHits(
		meta: ResolvedModelMeta,
		hits: any[],
		context: ActiveContext,
		where: SearchOptions['where']
	) {
		const revalidatePlan = where ? { where: whereShapeToEntries(where), or: [] } : undefined;
		if (meta.datastore?.ancestor) {
			const seen = new Set<string>();
			const loadTasks: Array<Promise<TModel | null>> = [];
			for (let index = 0; index < hits.length; index++) {
				const hit = hits[index];
				const id = this.searchHitId(meta, hit);
				if (!this.searchHitMatchesDocumentIdentity(meta, id, hit)) {
					loadTasks[index] = Promise.resolve(null);
					continue;
				}
				const ancestor = datastoreSearchHitAncestor(meta, id, hit, `Search hit for ${meta.name}`);
				if (ancestor === undefined) {
					throw new ActiveTsConfigurationError(
						`Search hit for ${meta.name} cannot be reloaded without Datastore ancestor metadata.`
					);
				}
				const safeAncestor = normalizeDatastoreKey(ancestor, `Search hit for ${meta.name} datastore ancestor`);
				const key = `${datastoreAncestorIdentity(safeAncestor)}:${entityIdKey(id)}`;
				if (SET_HAS.call(seen, key)) {
					throw new ActiveTsValidationError(`Search result for ${meta.name} contains duplicate id "${String(id)}".`);
				}
				SET_ADD.call(seen, key);
				loadTasks[index] = new QueryBuilder<TModel>(context, this.model)
					.ancestor(safeAncestor)
					.find(id)
					.load();
			}
			const loaded = await Promise.all(loadTasks);
			const list: TModel[] = [];
			let staleHits = 0;
			for (const item of loaded) {
				if (item && (!revalidatePlan || filterRows([item.data], revalidatePlan, meta.idField).length)) {
					list.push(item);
				} else {
					staleHits++;
				}
			}
			return { list, staleHits };
		}
		const idsByKey = new Map<string, EntityId>();
		let staleHits = 0;
		for (const hit of hits) {
			const id = this.searchHitId(meta, hit);
			if (!this.searchHitMatchesDocumentIdentity(meta, id, hit)) {
				staleHits++;
				continue;
			}
			this.rememberSearchHitId(meta, idsByKey, id, hit);
		}
		const ids = iterableToArray(MAP_VALUES.call(idsByKey) as Iterable<EntityId>);
		const loadTasks: Array<Promise<any>> = [];
		for (let index = 0; index < ids.length; index++) {
			loadTasks[index] = context.loadByIdFresh(this.model, ids[index], 'search');
		}
		const loaded = await Promise.all(loadTasks);
		const list: TModel[] = [];
		for (const item of loaded) {
			if (item && (!revalidatePlan || filterRows([item.data], revalidatePlan, meta.idField).length)) {
				list.push(item as TModel);
			} else {
				staleHits++;
			}
		}
		return { list, staleHits };
	}

	private rememberSearchHitId(meta: ResolvedModelMeta, idsByKey: Map<string, EntityId>, id: EntityId, hit: any) {
		let key = entityIdKey(id);
		if (meta.datastore?.ancestor) {
			const identity = datastoreSearchHitDocumentIdentity(meta, hit, `${meta.name} search hit`);
			if (identity !== undefined) {
				key = `search:${identity}`;
			} else {
				const ancestor = datastoreSearchHitAncestor(meta, id, hit, `Search hit for ${meta.name}`);
				if (ancestor === undefined) {
					throw new ActiveTsConfigurationError(
						`Search hit for ${meta.name} cannot be identified without Datastore ancestor metadata.`
					);
				}
				key = `${datastoreAncestorIdentity(
					normalizeDatastoreKey(ancestor, `Search hit for ${meta.name} datastore ancestor`)
				)}:${key}`;
			}
		}
		if (MAP_HAS.call(idsByKey, key)) {
			throw new ActiveTsValidationError(`Search result for ${meta.name} contains duplicate id "${String(id)}".`);
		}
		MAP_SET.call(idsByKey, key, id);
	}

	private searchHitMatchesDocumentIdentity(meta: ResolvedModelMeta, id: EntityId, hit: any) {
		const identity = datastoreSearchHitDocumentIdentity(meta, hit, `${meta.name} search hit`);
		if (identity === undefined) return true;
		if (meta.datastore?.ancestor) {
			const ancestor = datastoreSearchHitAncestor(meta, id, hit, `${meta.name} search hit`);
			if (ancestor === undefined) return true;
			return identity === datastoreSearchDocumentIdentity(meta, id, ancestor);
		}
		return identity === searchDocumentIdentity(meta, id, `${meta.name} search hit document identity`, hit);
	}

	private searchHitId(meta: ResolvedModelMeta, hit: any) {
		const id = valueFor(hit, meta.idField);
		if (id === undefined || id === null) {
			throw new ActiveTsValidationError(`Search hit for ${meta.name} is missing id field "${meta.idField}".`);
		}
		assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
		return id as EntityId;
	}
}

function datastoreSearchHitAncestor(
	meta: ResolvedModelMeta,
	id: EntityId,
	hit: Record<string, unknown>,
	context: string
) {
	const payloadAncestor = datastorePayloadResolvedAncestor(meta, id, hit, context);
	if (payloadAncestor !== undefined) return payloadAncestor;
	const decoded = datastoreSearchHitAncestorPayloadData(meta, hit);
	if (decoded !== undefined) {
		const ancestor = meta.datastore?.ancestor?.({ model: meta, id, data: decoded });
		if (ancestor !== undefined) return ancestor;
	}
	if (datastorePayloadHasAncestorFields(meta, hit)) return meta.datastore?.ancestor?.({ model: meta, id, data: hit });
	try {
		return meta.datastore?.ancestor?.({ model: meta, id, data: hit });
	} catch {
		return undefined;
	}
}

function datastoreSearchHitAncestorPayloadData(meta: ResolvedModelMeta, hit: Record<string, unknown>) {
	if (!meta.datastore?.ancestor || meta.fieldCodecs.size === 0) return undefined;
	if (!datastorePayloadHasAncestorFields(meta, hit)) return undefined;
	try {
		const decoded = datastoreAncestorPayloadData(meta, hit);
		return decoded === hit ? undefined : decoded;
	} catch {
		return undefined;
	}
}
