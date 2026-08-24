import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { markSavepointRollbackUnconfirmed } from './error-classification.js';
import {
	assertCompatibleQueryPagination,
	assertDenseArrayItems,
	assertPlainDataObject,
	ACTIVE_TS_ENTITY_KEY,
	assertSafeEntityId,
	assertSafeCursor,
	assertSafeFieldPath,
	assertSafeLimit,
	assertSafeOffset,
	assertSafeResultCount,
	assertSafeSchemaIdentifier,
	cloneSafeData,
	cloneSafeDataObjectWithoutActiveEntityKey
} from './safe-keys.js';
import { normalizeAggregateRow, validateAggregateSpecs } from './aggregate.js';
import { storeCapability } from './capabilities.js';
import { snapshotArrayInput } from './array-input.js';
import {
	assertNoOverlappingFieldPaths,
	assertValidWhereOperand,
	cloneQueryOperand,
	entityIdKey,
	isOperator,
	valueFor,
	withIdField
} from './query-utils.js';
import { cloneNativePayload } from './native-payload.js';
import { clonePlanMeta } from './plan-meta.js';
import {
	applyFieldCodecs,
	applyFieldCodecsForFields,
	copyFieldCodecQueryOperandMarker,
	FIELD_CODEC_QUERY_OPERANDS_ENCODED,
	hasFieldCodecQueryOperandsEncoded
} from './field-codecs.js';
import {
	iterableToArray,
	MAP_HAS,
	SET_ADD,
	SET_DELETE,
	SET_HAS,
	SET_SIZE,
	SET_VALUES,
	WEAKMAP_GET,
	WEAKMAP_SET,
	WEAKSET_ADD,
	WEAKSET_HAS
} from './collection-intrinsics.js';
import {
	datastoreAncestorFromEntityKey,
	datastoreKeyIdentity,
	datastoreKeyWithNamespace,
	datastoreScopedAncestorMatches,
	normalizeDatastoreKey
} from './datastore-key.js';
import type {
	AggregatePlan,
	AggregateResult,
	DatastoreKey,
	EntityId,
	QueryNative,
	QueryPlan,
	QueryResult,
	ResolvedModelMeta,
	SortDirection,
	StoreAdapter,
	StoreCapabilities,
	StoreReadOptions,
	StoreTransactionOptions,
	StoreWriteOptions
} from './types.js';

type StorePlanDiagnostics = {
	limit?: string;
	offset?: string;
	whereField?: string;
	selectField?: string;
	sortField?: string;
	include?: string;
};
type StoreQueryResultOptions = {
	cursor?: boolean;
	adapterKind?: string;
	datastoreAncestor?: unknown;
	datastoreNamespace?: string;
	trustedDatastoreEntityKeys?: boolean | WeakSet<object>;
};
const storesTrustingDatastoreEntityKeyRows = new WeakSet<StoreAdapter>();
const STORE_READ_OPTION_KEYS = ['select', 'native', 'meta'] as const;
const STORE_WRITE_OPTION_KEYS = ['expectedVersion', 'meta'] as const;
const STORE_TRANSACTION_OPTION_KEYS = ['isolation', 'readOnly', 'timeoutMs', 'native'] as const;
const QUERY_PLAN_KEYS = ['where', 'or', 'sort', 'limit', 'offset', 'cursor', 'select', 'include', 'native', 'meta'] as const;
const AGGREGATE_PLAN_KEYS = ['where', 'or', 'aggregates', 'native', 'meta'] as const;
const SAFE_PROMISE = Promise;
const PROMISE_THEN = SAFE_PROMISE.prototype.then;
const PROMISE_FINALLY = SAFE_PROMISE.prototype.finally;
const PROMISE_RESOLVE = SAFE_PROMISE.resolve.bind(SAFE_PROMISE);
const PROMISE_REJECT = SAFE_PROMISE.reject.bind(SAFE_PROMISE);
const NOOP_REJECTION_OBSERVER = () => undefined;
const NOOP_REJECTION_OBSERVER_FACTORY = () => NOOP_REJECTION_OBSERVER;

type TransactionOperationContinuationTracker = <T>(
	run: () => Promise<T>,
	createUpstreamRejectionObserver: () => () => void
) => Promise<T> | undefined;

// Await assimilates Promise subclasses through then(), so rejection observation stays visible to the guard.
class TransactionOperationPromise<T> extends SAFE_PROMISE<T> {
	#createRejectionObserver: () => () => void;
	#trackContinuation?: TransactionOperationContinuationTracker;

	static get [Symbol.species](): PromiseConstructor {
		return SAFE_PROMISE;
	}

	constructor(
		executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void,
		createRejectionObserver: () => () => void = NOOP_REJECTION_OBSERVER_FACTORY,
		trackContinuation?: TransactionOperationContinuationTracker
	) {
		super(executor);
		this.#createRejectionObserver = createRejectionObserver;
		this.#trackContinuation = trackContinuation;
	}

	override then<TResult1 = T, TResult2 = never>(
		onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		this.assertUsableSpecies();
		const observeRejection = typeof onRejected === 'function'
			? this.#createRejectionObserver()
			: NOOP_REJECTION_OBSERVER;
		const rejectionHandler = typeof onRejected === 'function'
			? (reason: any) => this.handleRejection(onRejected, reason, observeRejection)
			: onRejected;
		return this.wrap(() =>
			PROMISE_THEN.call(this, onFulfilled, rejectionHandler) as Promise<TResult1 | TResult2>
		);
	}

	override catch<TResult = never>(
		onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
	): Promise<T | TResult> {
		this.assertUsableSpecies();
		const observeRejection = typeof onRejected === 'function'
			? this.#createRejectionObserver()
			: NOOP_REJECTION_OBSERVER;
		const rejectionHandler = typeof onRejected === 'function'
			? (reason: any) => this.handleRejection(onRejected, reason, observeRejection)
			: onRejected;
		return this.wrap(() =>
			PROMISE_THEN.call(this, undefined, rejectionHandler) as Promise<T | TResult>
		);
	}

	override finally(onFinally?: (() => void) | null): Promise<T> {
		this.assertUsableSpecies();
		return this.wrap(() => {
			const base = PROMISE_THEN.call(this) as Promise<T>;
			return PROMISE_FINALLY.call(base, onFinally);
		});
	}

	private handleRejection<TResult>(
		onRejected: (reason: any) => TResult | PromiseLike<TResult>,
		reason: any,
		observeRejection: () => void
	): Promise<TResult> {
		const result = onRejected(reason);
		return PROMISE_THEN.call(PROMISE_RESOLVE(result), (value: TResult) => {
			observeRejection();
			return value;
		}) as Promise<TResult>;
	}

	private wrap<TResult>(run: () => Promise<TResult>): Promise<TResult> {
		const tracked = this.#trackContinuation?.(run, this.#createRejectionObserver);
		if (tracked) return tracked;
		const promise = run();
		return new TransactionOperationPromise<TResult>((resolve, reject) => {
			void PROMISE_THEN.call(promise, resolve, reject);
		}, this.#createRejectionObserver, this.#trackContinuation);
	}

	private assertUsableSpecies() {
		if ((this as { constructor: unknown }).constructor === TransactionOperationPromise) return;
		const probe = PROMISE_THEN.call(this) as Promise<T>;
		void PROMISE_THEN.call(probe, undefined, NOOP_REJECTION_OBSERVER);
	}
}

export function observeAdapterTransactionPromiseSettlement<T>(
	promise: Promise<T>,
	onSettled: () => void
): Promise<T> {
	const onFulfilled = (value: T) => {
		onSettled();
		return value;
	};
	const onRejected = (error: unknown): never => {
		onSettled();
		throw error;
	};
	return promise instanceof TransactionOperationPromise
		? promise.then(onFulfilled, onRejected)
		: (PROMISE_THEN.call(promise, onFulfilled, onRejected) as Promise<T>);
}
const STORE_QUERY_RESULT_KEYS = ['list', 'cursor', 'more', 'count', 'total'] as const;
const WHERE_ENTRY_KEYS = ['field', 'op', 'value', 'value2'] as const;
const SORT_SPEC_KEYS = ['field', 'direction'] as const;
const NATIVE_QUERY_KEYS = ['adapter', 'payload'] as const;

function assertPlainOptions(options: unknown, context: string, allowedKeys: readonly string[]) {
	if (options === undefined) return undefined;
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(options).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertKnownOptionKeys(options, allowedKeys, context);
	return options as Record<string, unknown>;
}

export function normalizeStoreReadOptions(options: unknown, context: string): StoreReadOptions {
	const plain = assertPlainOptions(options, context, STORE_READ_OPTION_KEYS);
	if (!plain) return { select: undefined, native: undefined };
	const normalized: StoreReadOptions = { select: undefined, native: undefined };
	const select = ownOptionValue(plain, 'select');
	if (select !== undefined) {
		if (!Array.isArray(select)) {
			throw new ActiveTsValidationError(`${context}.select must be an array of field paths.`);
		}
		normalized.select = normalizeFieldPathList(
			snapshotArrayInput(select, `${context}.select`),
			`${context}.select`
		);
	}
	const native = ownOptionValue(plain, 'native');
	if (native !== undefined) normalized.native = cloneNativePayload(native, `${context}.native`);
	const meta = ownOptionValue(plain, 'meta');
	if (meta !== undefined) normalized.meta = clonePlanMeta(meta, `${context}.meta`);
	return normalized;
}

export function rejectUnsupportedStoreReadOptions(options: unknown, context: string): StoreReadOptions {
	const normalized = normalizeStoreReadOptions(options, context);
	if (normalized.select !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support select read options.`);
	}
	if (normalized.native !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support native read options.`);
	}
	if (normalized.meta !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support read metadata.`);
	}
	return normalized;
}

export function validateStoreQueryReadOptions(
	options: unknown,
	plan: Pick<QueryPlan, 'select' | 'native' | 'meta'>,
	context: string
): StoreReadOptions {
	const normalized = normalizeStoreReadOptions(options, context);
	if (normalized.select !== undefined && !sameFieldList(normalized.select, plan.select ?? [])) {
		throw new ActiveTsConfigurationError(`${context}.select must match the query plan select fields.`);
	}
	if (
		normalized.native !== undefined &&
		(plan.native === undefined || !isDeepStrictEqual(normalized.native, plan.native.payload))
	) {
		throw new ActiveTsConfigurationError(`${context}.native must match the query plan native payload.`);
	}
	if (normalized.meta !== undefined && !sameQueryMeta(normalized.meta, plan.meta)) {
		throw new ActiveTsConfigurationError(`${context}.meta must match the query plan meta.`);
	}
	return normalized;
}

export function normalizeStoreQueryPlan(
	plan: unknown,
	idField: string,
	context = 'store query plan',
	diagnostics: StorePlanDiagnostics = {}
): QueryPlan {
	const record = assertPlainRecord(plan, context);
	assertKnownOptionKeys(record, QUERY_PLAN_KEYS, context);
	const rawSelect = optionalArray<string>(ownOptionValue(record, 'select'), `${context}.select`);
	const select = rawSelect
		? assertNoOverlappingFieldPaths(
				withIdField(
					normalizeFieldPathList(rawSelect, `${context}.select`, diagnostics.selectField),
					idField
				) ?? [],
				`${context}.select`
			)
		: undefined;
	const offset = ownOptionValue(record, 'offset') === undefined
		? undefined
		: assertSafeOffset(
				ownOptionValue(record, 'offset') as number | undefined,
				diagnostics.offset ?? `${context}.offset`
			);
	const cursor = assertSafeCursor(ownOptionValue(record, 'cursor'), `${context}.cursor`);
	assertCompatibleQueryPagination(offset, cursor, `${context} pagination`);
	const normalized = normalizeMixedOrPlan({
		where: normalizeWhereEntries(ownOptionValue(record, 'where'), `${context}.where`, diagnostics.whereField),
		or: normalizeStoreQueryBranches(ownOptionValue(record, 'or'), `${context}.or`, diagnostics),
		sort: normalizeStoreSortList(ownOptionValue(record, 'sort'), `${context}.sort`, diagnostics.sortField),
		limit:
			ownOptionValue(record, 'limit') === undefined
				? undefined
				: assertSafeLimit(ownOptionValue(record, 'limit') as number | undefined, diagnostics.limit ?? `${context}.limit`),
		offset,
		cursor,
		select,
		include: normalizeIncludeSpecs(ownOptionValue(record, 'include'), `${context}.include`, diagnostics.include),
		native: normalizeStoreNative(ownOptionValue(record, 'native'), `${context}.native`),
		meta: normalizePlanMeta(ownOptionValue(record, 'meta'), `${context}.meta`)
	});
	appendStableLimitSort(normalized, idField);
	return copyFieldCodecQueryOperandMarker(plan, normalized);
}

function appendStableLimitSort(plan: QueryPlan, idField: string) {
	if (plan.limit === undefined || !plan.sort.length) return;
	for (let index = 0; index < plan.sort.length; index++) {
		if (plan.sort[index].field === idField) return;
	}
	plan.sort.push({ field: assertSafeFieldPath(idField, 'store query plan id field'), direction: 'asc' });
}

export function normalizeStoreAggregatePlan(
	plan: unknown,
	context = 'store aggregate plan'
): AggregatePlan {
	const record = assertPlainRecord(plan, context);
	assertKnownOptionKeys(record, AGGREGATE_PLAN_KEYS, context);
	const normalized = normalizeMixedOrPlan({
		where: normalizeWhereEntries(ownOptionValue(record, 'where'), `${context}.where`),
		or: normalizeStoreQueryBranches(ownOptionValue(record, 'or'), `${context}.or`),
		aggregates: validateAggregateSpecs((ownOptionValue(record, 'aggregates') ?? []) as AggregatePlan['aggregates']),
		native: normalizeStoreNative(ownOptionValue(record, 'native'), `${context}.native`),
		meta: normalizePlanMeta(ownOptionValue(record, 'meta'), `${context}.meta`)
	});
	return copyFieldCodecQueryOperandMarker(plan, normalized);
}

export function assertStorePlanSupported(
	adapterKind: string,
	capabilities: StoreCapabilities | undefined,
	plan: Pick<QueryPlan, 'where' | 'or' | 'native'> &
		Partial<Pick<QueryPlan, 'select' | 'offset' | 'cursor' | 'sort' | 'meta'>> &
		Partial<Pick<AggregatePlan, 'aggregates'>>
) {
	const wheres = collectWhereEntries(plan);
	assertStoreNativeAdapterTag(adapterKind, plan);
	if (plan.or.length && !storeCapability(capabilities, 'or'))
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support orWhere().`);
	if (plan.cursor !== undefined && !storeCapability(capabilities, 'cursor'))
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support active-ts keyset cursor pagination.`);
	if (plan.offset !== undefined && !storeCapability(capabilities, 'offset'))
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support offset pagination.`);
	if (plan.select?.length && !storeCapability(capabilities, 'select'))
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support select().`);
	if (plan.native !== undefined && !storeCapability(capabilities, 'native'))
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support native queries.`);
	if (plan.aggregates?.length && !storeCapability(capabilities, 'aggregate'))
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support aggregate queries.`);
	if (plan.meta?.requiresMissingFieldNulls && !storeCapability(capabilities, 'missingFieldNulls')) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${adapterKind}" does not support matching missing fields as null. Materialize soft-delete null fields before enabling this query.`
		);
	}
	if (plan.meta?.datastoreAncestor !== undefined && !storeCapability(capabilities, 'datastoreAncestor')) {
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support Datastore ancestor query metadata.`);
	}
	if (
		plan.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(plan.meta, 'datastoreRead') &&
		!storeCapability(capabilities, 'datastoreReadPolicy')
	) {
		throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support Datastore read policies.`);
	}
	for (const where of wheres) {
		if (where.op === 'contains') {
			throw new ActiveTsConfigurationError(
				'The legacy contains operator is ambiguous. Use arrayContains, textContains, or jsonContains.'
			);
		}
		if ((where.op === 'isNull' || where.op === 'isNotNull') && !storeCapability(capabilities, 'nullOperators'))
			throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support null operators.`);
		if (where.op === 'isNull' && !storeCapability(capabilities, 'missingFieldNulls')) {
			throw new ActiveTsConfigurationError(
				`Store adapter "${adapterKind}" does not support matching missing fields as null. Use equality with null for explicit-null queries.`
			);
		}
		if (where.op === 'arrayContains' && !storeCapability(capabilities, 'arrayContains'))
			throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support arrayContains queries.`);
		if (where.op === 'textContains' && !storeCapability(capabilities, 'textContains'))
			throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support textContains queries.`);
		if (where.op === 'jsonContains' && !storeCapability(capabilities, 'jsonContains'))
			throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support jsonContains queries.`);
		if (where.op === 'startsWith' && !storeCapability(capabilities, 'startsWith'))
			throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support safe startsWith queries.`);
		if (isRangeOperator(where.op) && !storeCapability(capabilities, 'numericComparisons'))
			throw new ActiveTsConfigurationError(
				`Store adapter "${adapterKind}" does not support safe range comparisons without typed fields.`
			);
		if (where.field.includes('.') && !storeCapability(capabilities, 'nestedFields'))
			throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support nested field queries.`);
	}
	const fieldSpecs: Array<{ field: string; context: string }> = [];
	const sort = plan.sort ?? [];
	for (let index = 0; index < sort.length; index++) {
		fieldSpecs[fieldSpecs.length] = { field: sort[index].field, context: 'nested field sorting' };
	}
	const select = plan.select ?? [];
	for (let index = 0; index < select.length; index++) {
		fieldSpecs[fieldSpecs.length] = { field: select[index], context: 'nested field selection' };
	}
	const aggregates = plan.aggregates ?? [];
	for (let index = 0; index < aggregates.length; index++) {
		const field = aggregates[index].field;
		if (field) fieldSpecs[fieldSpecs.length] = { field, context: 'nested field aggregation' };
	}
	for (const spec of fieldSpecs) {
		if (spec.field.includes('.') && !storeCapability(capabilities, 'nestedFields')) {
			throw new ActiveTsConfigurationError(`Store adapter "${adapterKind}" does not support ${spec.context}.`);
		}
	}
}

export function assertStoreNativeAdapterTag(
	adapterKind: string,
	plan: { native?: Pick<QueryNative, 'adapter'> },
	context = 'native store plan'
) {
	const target = plan.native?.adapter;
	if (target !== undefined && target !== adapterKind) {
		throw new ActiveTsConfigurationError(
			`${context} targets store adapter "${target}" but reached store adapter "${adapterKind}".`
		);
	}
}

export function stripStoreNativeAdapterTag<TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan {
	if (plan.native?.adapter === undefined) return plan;
	const stripped = {
		...plan,
		native: { payload: plan.native.payload }
	} as TPlan;
	return copyFieldCodecQueryOperandMarker(plan, stripped) as TPlan;
}

function sameFieldList(left: readonly string[], right: readonly string[]) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sameQueryMeta(left: QueryPlan['meta'], right: QueryPlan['meta']) {
	if (isEmptyQueryMeta(left) && isEmptyQueryMeta(right)) return true;
	return isDeepStrictEqual(left, right);
}

function isEmptyQueryMeta(meta: QueryPlan['meta']) {
	return meta === undefined || Object.keys(meta).length === 0;
}

export function normalizeStoreWriteOptions(options: unknown, context: string): StoreWriteOptions {
	const plain = assertPlainOptions(options, context, STORE_WRITE_OPTION_KEYS);
	if (!plain) return { expectedVersion: undefined };
	const expectedVersion = ownOptionValue(plain, 'expectedVersion');
	if (
		expectedVersion !== undefined &&
		(typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
	) {
		throw new ActiveTsValidationError(`${context}.expectedVersion must be a non-negative safe integer.`);
	}
	const normalized: StoreWriteOptions = { expectedVersion };
	const meta = ownOptionValue(plain, 'meta');
	if (meta !== undefined) normalized.meta = clonePlanMeta(meta, `${context}.meta`);
	return normalized;
}

export function rejectUnsupportedStoreWriteOptions(options: unknown, context: string): StoreWriteOptions {
	const normalized = normalizeStoreWriteOptions(options, context);
	if (normalized.expectedVersion !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support expectedVersion.`);
	}
	return rejectUnsupportedStoreWriteMetadata(normalized, context);
}

export function rejectUnsupportedStoreWriteMetadata(options: StoreWriteOptions, context: string): StoreWriteOptions {
	if (options.meta !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support metadata write options.`);
	}
	return options;
}

export function normalizeStoreTransactionOptions(options: unknown, context: string): StoreTransactionOptions {
	const plain = assertPlainOptions(options, context, STORE_TRANSACTION_OPTION_KEYS);
	if (!plain) return {};
	const isolation = ownOptionValue(plain, 'isolation') as StoreTransactionOptions['isolation'];
	if (
		isolation !== undefined &&
		isolation !== 'readCommitted' &&
		isolation !== 'repeatableRead' &&
		isolation !== 'serializable'
	) {
		throw new ActiveTsValidationError(
			`${context}.isolation must be "readCommitted", "repeatableRead", or "serializable".`
		);
	}
	const readOnly = ownOptionValue(plain, 'readOnly') as StoreTransactionOptions['readOnly'];
	if (readOnly !== undefined && typeof readOnly !== 'boolean') {
		throw new ActiveTsValidationError(`${context}.readOnly must be a boolean.`);
	}
	const timeoutMs = assertSafeLimit(
		ownOptionValue(plain, 'timeoutMs') as number | undefined,
		`${context}.timeoutMs`
	);
	const native = ownOptionValue(plain, 'native');
	return {
		isolation,
		readOnly,
		timeoutMs,
		native: native === undefined ? undefined : cloneNativePayload(native, `${context}.native`)
	};
}

export function assertStoreDataMatchesId(
	model: Pick<ResolvedModelMeta, 'name' | 'idField'>,
	id: EntityId,
	data: Record<string, unknown>,
	context = `${model.name} stored data`
) {
	const rowId = assertStoreDataHasModelId(model, data, context);
	if (entityIdKey(rowId) !== entityIdKey(id)) {
		throw new ActiveTsValidationError(`${context} id field "${model.idField}" must match the operation id.`);
	}
}

export function assertStoreDataHasModelId(
	model: Pick<ResolvedModelMeta, 'name' | 'idField'>,
	data: Record<string, unknown>,
	context = `${model.name} stored data`
) {
	const rowId = valueFor(data, model.idField);
	if (rowId === undefined || rowId === null) {
		throw new ActiveTsValidationError(`${context} is missing id field "${model.idField}".`);
	}
	assertSafeEntityId(rowId, `${context}.${model.idField}`);
	return rowId;
}

export function normalizeStoreQueryResult(
	value: unknown,
	context: string,
	options: StoreQueryResultOptions = {}
): QueryResult {
	const record = assertPlainRecord(value, `${context} result`);
	assertKnownOptionKeys(record, STORE_QUERY_RESULT_KEYS, `${context} result`);
	const list = ownOptionValue(record, 'list');
	if (!Array.isArray(list)) throw new ActiveTsValidationError(`${context} result.list must be an array.`);
	const safeInput = snapshotArrayInput(list, `${context} result.list`);
	const safeList: QueryResult['list'] = [];
	for (let index = 0; index < safeInput.length; index++) {
		const item = safeInput[index];
		assertPlainDataObject(item, `${context} result.list[${index}]`);
		safeList[index] = cloneSafeData(item);
	}
	const cursor = assertSafeCursor(ownOptionValue(record, 'cursor'), `${context} result cursor`);
	const more = ownOptionValue(record, 'more');
	assertSafeResultCount(ownOptionValue(record, 'count'), `${context} result.count`);
	const total = assertSafeResultCount(ownOptionValue(record, 'total'), `${context} result.total`);
	if (more !== undefined && typeof more !== 'boolean') {
		throw new ActiveTsValidationError(`${context} result.more must be a boolean.`);
	}
	if (cursor !== undefined && options.cursor === false) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${options.adapterKind ?? 'unknown'}" does not support returning portable cursors.`
		);
	}
	if (total !== undefined && total < safeList.length) {
		throw new ActiveTsValidationError(`${context} result.total cannot be smaller than result.list length.`);
	}
	return { list: safeList, cursor, more, count: safeList.length, total };
}

export function normalizeStoreQueryResultForModel(
	model: ResolvedModelMeta,
	value: unknown,
	context: string,
	options: StoreQueryResultOptions = {}
): QueryResult {
	const result = normalizeStoreQueryResult(value, context, options);
	const ids = new Set<string>();
	const scopedDatastoreAncestor = options.datastoreAncestor === undefined
		? undefined
		: datastoreKeyWithNamespace(
				normalizeDatastoreKey(options.datastoreAncestor, `${context} Datastore ancestor`),
				options.datastoreNamespace,
				`${context} Datastore ancestor`
			);
	for (let index = 0; index < result.list.length; index++) {
		const id = assertStoreDataHasModelId(model, result.list[index], `${context} result.list[${index}]`);
		let key = entityIdKey(id);
		if (model.datastore?.ancestor) {
			const resolvedPayloadAncestor = datastorePayloadResolvedAncestor(
				model,
				id,
				result.list[index],
				`${context} result.list[${index}]`
			);
			const canResolvePayloadAncestor = resolvedPayloadAncestor !== undefined;
			const trustedEntityKey = datastoreRowTrustedEntityKey(
				model,
				id,
				scopedDatastoreAncestor,
				options.datastoreNamespace,
				result.list[index],
				datastoreRowTrustsEntityKey(result.list[index], options.trustedDatastoreEntityKeys),
				`${context} result.list[${index}]`
			);
			if (trustedEntityKey.hasEntityKey && !trustedEntityKey.trusted && !canResolvePayloadAncestor) {
				throw new ActiveTsValidationError(
					`${context} result.list[${index}] partial Datastore row cannot use untrusted active-ts entity key metadata.`
				);
			}
			const shouldResolveAncestor = trustedEntityKey.trusted
				? canResolvePayloadAncestor
				: scopedDatastoreAncestor === undefined || canResolvePayloadAncestor;
			const resolvedAncestor = shouldResolveAncestor
				? resolvedPayloadAncestor
				: undefined;
			if (
				trustedEntityKey.ancestor !== undefined &&
				resolvedAncestor !== undefined &&
				!datastoreScopedAncestorMatches(
					normalizeDatastoreKey(resolvedAncestor, `${context} result.list[${index}] datastore ancestor`),
					normalizeDatastoreKey(trustedEntityKey.ancestor, `${context} result.list[${index}] active-ts entity key ancestor`)
				)
			) {
				throw new ActiveTsValidationError(
					`${context} result.list[${index}] active-ts entity key does not match its payload data.`
				);
			}
			if (
				scopedDatastoreAncestor !== undefined &&
				resolvedAncestor !== undefined &&
				!datastoreAncestorWithinScope(
					normalizeDatastoreKey(resolvedAncestor, `${context} result.list[${index}] datastore ancestor`),
					scopedDatastoreAncestor
				)
			) {
				throw new ActiveTsValidationError(
					`${context} result.list[${index}] for Datastore model "${model.name}" resolved outside the scoped Datastore ancestor.`
				);
			}
			const ancestor = trustedEntityKey.ancestor ?? resolvedAncestor ?? scopedDatastoreAncestor;
			if (ancestor === undefined) {
				throw new ActiveTsConfigurationError(
					`${context} result.list[${index}] for Datastore model "${model.name}" cannot be identified without ancestor metadata.`
				);
			}
			key = `${datastoreKeyIdentity(
				normalizeDatastoreKey(ancestor, `${context} result.list[${index}] datastore ancestor`)
			)}:${key}`;
			if (trustedEntityKey.hasEntityKey && !trustedEntityKey.trusted) {
				result.list[index] = cloneSafeDataObjectWithoutActiveEntityKey(
					result.list[index],
					`${context} result.list[${index}]`
				);
			}
		}
		if (SET_HAS.call(ids, key)) {
			throw new ActiveTsValidationError(`${context} result contains duplicate id "${String(id)}".`);
		}
		SET_ADD.call(ids, key);
	}
	return result;
}

function datastoreRowTrustsEntityKey(
	row: Record<string, unknown>,
	trustedDatastoreEntityKeys: boolean | WeakSet<object> | undefined
) {
	if (trustedDatastoreEntityKeys === true) return true;
	return trustedDatastoreEntityKeys !== undefined &&
		trustedDatastoreEntityKeys !== false &&
		WEAKSET_HAS.call(trustedDatastoreEntityKeys, row);
}

export function datastorePayloadHasAncestorFields(model: ResolvedModelMeta, value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	const ancestorFields = model.datastore?.ancestorFields;
	if (ancestorFields === undefined) return false;
	if (!ancestorFields.length) return true;
	if (datastorePayloadContainsAncestorFields(row, ancestorFields)) return true;
	if (model.fieldCodecs.size === 0) return false;
	try {
		const ancestorData = datastoreAncestorPayloadData(model, row);
		return ancestorData !== row && datastorePayloadContainsAncestorFields(ancestorData, ancestorFields);
	} catch {
		return false;
	}
}

export function datastorePayloadCanResolveAncestor(
	model: ResolvedModelMeta,
	id: EntityId,
	value: unknown,
	context: string
) {
	return datastorePayloadResolvedAncestor(model, id, value, context) !== undefined;
}

export function datastorePayloadResolvedAncestor(
	model: ResolvedModelMeta,
	id: EntityId,
	value: unknown,
	context: string
) {
	if (!model.datastore?.ancestor || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	if (!datastorePayloadHasAncestorFields(model, row) && model.datastore.ancestorFields !== undefined) {
		return undefined;
	}
	let candidates: Array<DatastoreKey | undefined>;
	try {
		candidates = datastoreWritePayloadAncestorCandidates(model, id, row);
	} catch {
		return undefined;
	}
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (candidate === undefined) continue;
		try {
			return normalizeDatastoreKey(candidate, `${context} payload Datastore ancestor`);
		} catch {
			// Partial projections may omit fields needed by an undeclared ancestor resolver.
		}
	}
	return undefined;
}

function datastorePayloadContainsAncestorFields(
	row: Record<string, unknown>,
	ancestorFields: readonly string[]
) {
	for (const field of ancestorFields) {
		if (valueFor(row, field) === undefined) return false;
	}
	return true;
}

export function datastoreAncestorPayloadData(model: ResolvedModelMeta, row: Record<string, unknown>) {
	const ancestorFields = model.datastore?.ancestorFields;
	if (!ancestorFields?.length) return row;
	if (model.fieldCodecs.size === 0) return row;
	return applyFieldCodecsForFields(model, row, ancestorFields, 'read');
}

export function datastoreWritePayloadMatchesScopedAncestor(
	model: ResolvedModelMeta,
	id: EntityId,
	data: Record<string, unknown>,
	expectedAncestor: DatastoreKey | undefined,
	context: string
) {
	if (!model.datastore?.ancestor) return true;
	const candidates = datastoreWritePayloadAncestorCandidates(model, id, data);
	for (let index = 0; index < candidates.length; index++) {
		if (datastoreResolvedAncestorMatchesScope(
			candidates[index],
			expectedAncestor,
			`${context} payload Datastore ancestor`
		)) return true;
	}
	return false;
}

export function datastoreWritePayloadAncestorCandidates(
	model: ResolvedModelMeta,
	id: EntityId,
	data: Record<string, unknown>
) {
	if (!model.datastore?.ancestor) return [undefined];
	const candidates: Array<DatastoreKey | undefined> = [];
	let rawResolved = false;
	let rawAncestor: DatastoreKey | undefined;
	let rawAncestorError: unknown;
	try {
		rawAncestor = model.datastore.ancestor({ model, id, data });
		rawResolved = true;
	} catch (error) {
		rawAncestorError = error;
	}
	const decodedData = datastoreWritePayloadDecodedAncestorData(model, data);
	let decodedResolved = false;
	let decodedAncestor: DatastoreKey | undefined;
	let decodedAncestorError: unknown;
	if (decodedData !== undefined && decodedData !== data) {
		try {
			decodedAncestor = model.datastore.ancestor({ model, id, data: decodedData });
			decodedResolved = true;
		} catch (error) {
			decodedAncestorError = error;
		}
	}
	const decodedPayloadIsStored = decodedData !== undefined &&
		decodedData !== data &&
		datastoreDecodedPayloadRoundTrips(model, data, decodedData);
	if (decodedResolved && (!rawResolved || decodedPayloadIsStored)) {
		candidates[candidates.length] = decodedAncestor;
	} else if (rawResolved) {
		candidates[candidates.length] = rawAncestor;
	} else if (decodedResolved) {
		candidates[candidates.length] = decodedAncestor;
	}
	if (!candidates.length && rawAncestorError !== undefined) throw rawAncestorError;
	if (!candidates.length && decodedAncestorError !== undefined) throw decodedAncestorError;
	return candidates;
}

function datastoreWritePayloadDecodedAncestorData(model: ResolvedModelMeta, data: Record<string, unknown>) {
	if (model.fieldCodecs.size === 0) return undefined;
	try {
		return model.datastore?.ancestorFields === undefined
			? applyFieldCodecs(model, data, 'read')
			: datastoreAncestorPayloadData(model, data);
	} catch {
		return undefined;
	}
}

function datastoreDecodedPayloadRoundTrips(
	model: ResolvedModelMeta,
	encodedData: Record<string, unknown>,
	decodedData: Record<string, unknown>
) {
	try {
		const reencodedData = applyFieldCodecs(model, decodedData, 'write');
		return isDeepStrictEqual(reencodedData, encodedData);
	} catch {
		return false;
	}
}

function datastoreResolvedAncestorMatchesScope(
	actual: DatastoreKey | undefined,
	expected: DatastoreKey | undefined,
	context: string
) {
	const actualAncestor = actual === undefined ? undefined : normalizeDatastoreKey(actual, context);
	return expected === undefined
		? actualAncestor === undefined
		: datastoreScopedAncestorMatches(actualAncestor, expected);
}

function datastoreRowTrustedEntityKey(
	model: Pick<ResolvedModelMeta, 'name'>,
	id: EntityId,
	scopedDatastoreAncestor: unknown,
	datastoreNamespace: string | undefined,
	row: Record<string, unknown>,
	trustedDatastoreEntityKeys: boolean,
	context: string
) {
	const descriptor = Object.getOwnPropertyDescriptor(row, ACTIVE_TS_ENTITY_KEY);
	if (descriptor === undefined) return { trusted: false, hasEntityKey: false };
	if (!('value' in descriptor) || descriptor.enumerable) return { trusted: false, hasEntityKey: false };
	if (!trustedDatastoreEntityKeys) return { trusted: false, hasEntityKey: true };
	let ancestor: DatastoreKey | undefined;
	try {
		ancestor = datastoreAncestorFromEntityKey(
			descriptor.value,
			model.name,
			id,
			`${context} active-ts entity key`
		);
	} catch (error) {
		throw error;
	}
	if (scopedDatastoreAncestor !== undefined && !datastoreAncestorWithinScope(ancestor, scopedDatastoreAncestor)) {
		throw new ActiveTsValidationError(`${context} active-ts entity key resolved outside the scoped Datastore ancestor.`);
	}
	if (scopedDatastoreAncestor !== undefined) {
		ancestor = datastoreAncestorWithScopedNamespace(ancestor, scopedDatastoreAncestor, `${context} active-ts entity key`);
	}
	if (datastoreNamespace !== undefined) {
		ancestor = datastoreAncestorWithAdapterNamespace(ancestor, datastoreNamespace, `${context} active-ts entity key`);
	}
	return { trusted: true, hasEntityKey: true, ancestor };
}

function datastoreAncestorWithScopedNamespace(actual: DatastoreKey | undefined, expected: unknown, context: string) {
	if (actual === undefined) return undefined;
	const safeActual = normalizeDatastoreKey(actual, context);
	const safeExpected = normalizeDatastoreKey(expected, `${context} scoped ancestor`);
	if (safeActual.namespace !== undefined || safeExpected.namespace === undefined) return safeActual;
	return datastoreKeyWithNamespace(safeActual, safeExpected.namespace, context);
}

function datastoreAncestorWithAdapterNamespace(actual: DatastoreKey | undefined, namespace: string, context: string) {
	if (actual === undefined) return undefined;
	return datastoreKeyWithNamespace(actual, namespace, context);
}

function datastoreAncestorWithinScope(actual: DatastoreKey | undefined, expected: unknown) {
	if (expected === undefined) return actual === undefined;
	if (actual === undefined) return false;
	const safeActual = normalizeDatastoreKey(actual);
	const safeExpected = normalizeDatastoreKey(expected);
	if (safeActual.path.length < safeExpected.path.length) return false;
	for (let index = 0; index < safeExpected.path.length; index++) {
		const actualPart = safeActual.path[index];
		const expectedPart = safeExpected.path[index];
		if (actualPart.kind !== expectedPart.kind) return false;
		if (entityIdKey(actualPart.id) !== entityIdKey(expectedPart.id)) return false;
	}
	if (safeActual.namespace !== undefined && safeExpected.namespace === undefined) return false;
	if (safeActual.namespace === undefined || safeExpected.namespace === undefined) return true;
	return safeActual.namespace === safeExpected.namespace;
}

export function markStoreTrustsDatastoreEntityKeyRows<T extends StoreAdapter>(adapter: T): T {
	WEAKSET_ADD.call(storesTrustingDatastoreEntityKeyRows, adapter);
	return adapter;
}

export function storeTrustsDatastoreEntityKeyRows(adapter: StoreAdapter): boolean {
	return WEAKSET_HAS.call(storesTrustingDatastoreEntityKeyRows, adapter);
}

type TrackedTransactionOperation = {
	promise: Promise<unknown>;
	state: 'pending' | 'rejected';
	rejectionHandled: boolean;
	active: boolean;
	parent?: TrackedTransactionOperation;
	error?: unknown;
};

type TransactionOperationTracker = {
	track: <T>(
		run: () => Promise<T>,
		closedError?: (closed: string) => unknown,
		admitAfterClose?: boolean
	) => Promise<T>;
	hasPendingOperations: () => boolean;
	waitForPendingOperations: () => Promise<void>;
};

type TransactionOperationScope = {
	tracker: TransactionOperationTracker;
	operation: TrackedTransactionOperation;
};

type AdapterTransactionOperationCarrier = <T>(run: () => Promise<T>) => Promise<T>;

type TransactionSavepointToken = {
	parent?: TransactionSavepointToken;
	operations?: TransactionOperationTracker;
};

type TransactionSavepointGate = {
	run: <T>(run: () => Promise<T>, token?: TransactionSavepointToken) => Promise<T>;
	savepoint: <T>(run: (token: TransactionSavepointToken) => Promise<T>, parent?: TransactionSavepointToken) => Promise<T>;
	markRollbackOnly: (error: unknown) => void;
	rollbackOnlyError: () => unknown;
};

type TransactionSavepointOperation = {
	sequence: number;
	token?: TransactionSavepointToken;
	parent?: TransactionSavepointOperation;
	promise: Promise<unknown>;
};

type TransactionSavepointBarrier = {
	sequence: number;
	parent?: TransactionSavepointToken;
	operation?: TransactionSavepointOperation;
	token?: TransactionSavepointToken;
	done: Promise<void>;
	release: () => void;
};

const transactionOperationStorage = new AsyncLocalStorage<TransactionOperationScope>();
type TransactionSavepointScope = {
	gate: TransactionSavepointGate;
	token: TransactionSavepointToken;
	parent?: TransactionSavepointScope;
};

const transactionSavepointStorage = new AsyncLocalStorage<TransactionSavepointScope>();
type TransactionSavepointOperationScope = {
	gate: TransactionSavepointGate;
	operation: TransactionSavepointOperation;
	parent?: TransactionSavepointOperationScope;
};
const transactionSavepointOperationStorage = new AsyncLocalStorage<TransactionSavepointOperationScope>();
const adapterTransactionOperationCarriers = new WeakMap<object, AdapterTransactionOperationCarrier>();
const adapterSavepointOperationGates = new WeakMap<object, AdapterTransactionOperationCarrier>();
const transactionWorkAdapters = new WeakSet<object>();

function transactionSavepointTokenIsSelfOrDescendant(
	token: TransactionSavepointToken,
	ancestor: TransactionSavepointToken
) {
	let current: TransactionSavepointToken | undefined = token;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

function transactionSavepointScopeForGate(gate: TransactionSavepointGate) {
	let scope = transactionSavepointStorage.getStore();
	while (scope) {
		if (scope.gate === gate) return scope;
		scope = scope.parent;
	}
	return undefined;
}

function transactionSavepointOperationScopeForGate(gate: TransactionSavepointGate) {
	let scope = transactionSavepointOperationStorage.getStore();
	while (scope) {
		if (scope.gate === gate) return scope;
		scope = scope.parent;
	}
	return undefined;
}

function createTransactionSavepointGate(): TransactionSavepointGate {
	const activeOperations = new Set<TransactionSavepointOperation>();
	const barriers = new Set<TransactionSavepointBarrier>();
	const nestedQueueTails = new WeakMap<TransactionSavepointToken, Promise<void>>();
	const ready = PROMISE_RESOLVE(undefined);
	let rootQueueTail: Promise<void> = ready;
	let sequence = 0;
	let rollbackOnly = false;
	let rollbackError: unknown;
	let gate!: TransactionSavepointGate;

	const tokenInParent = (
		token: TransactionSavepointToken | undefined,
		parent: TransactionSavepointToken | undefined
	) => parent
		? !!token && transactionSavepointTokenIsSelfOrDescendant(token, parent)
		: token === undefined;
	const applicableBarrierPromises = (operation: TransactionSavepointOperation) => {
		const pending: Promise<void>[] = [];
		const activeBarriers = iterableToArray(
			SET_VALUES.call(barriers) as Iterable<TransactionSavepointBarrier>
		);
		for (let index = 0; index < activeBarriers.length; index++) {
			const barrier = activeBarriers[index];
			if (barrier.sequence >= operation.sequence) continue;
			if (operation.token !== barrier.parent) continue;
			pending[pending.length] = barrier.done;
		}
		return pending;
	};
	const waitForPriorOperations = async (barrier: TransactionSavepointBarrier) => {
		while (true) {
			const operations = iterableToArray(
				SET_VALUES.call(activeOperations) as Iterable<TransactionSavepointOperation>
			);
			let waiting = false;
			for (let index = 0; index < operations.length; index++) {
				const operation = operations[index];
				if (operation.sequence >= barrier.sequence) continue;
				if (!tokenInParent(operation.token, barrier.parent)) continue;
				let reentrant = barrier.operation;
				while (reentrant) {
					if (reentrant === operation) break;
					reentrant = reentrant.parent;
				}
				if (reentrant) continue;
					waiting = true;
					try {
						await (PROMISE_THEN.call(operation.promise) as Promise<unknown>);
					} catch {
						// The transaction operation tracker remains responsible for rejection policy.
					}
			}
			if (!waiting) return;
		}
	};
	const executeSavepoint = async <T>(
		barrier: TransactionSavepointBarrier,
		run: (token: TransactionSavepointToken) => Promise<T>
	): Promise<T> => {
		try {
			await waitForPriorOperations(barrier);
			const token: TransactionSavepointToken = { parent: barrier.parent };
			barrier.token = token;
			return await transactionSavepointStorage.run(
				{ gate, token, parent: transactionSavepointStorage.getStore() },
				() => run(token)
			);
		} finally {
			SET_DELETE.call(barriers, barrier);
			barrier.release();
		}
	};
	gate = {
		run: <T>(run: () => Promise<T>, boundToken?: TransactionSavepointToken): Promise<T> => {
			const scope = transactionSavepointScopeForGate(gate);
			const operationScope = transactionSavepointOperationStorage.getStore();
			const token = boundToken ?? scope?.token;
			const operation: TransactionSavepointOperation = {
				sequence: ++sequence,
				token,
				parent: transactionSavepointOperationScopeForGate(gate)?.operation,
				promise: undefined as unknown as Promise<T>
			};
			const pendingBarriers = applicableBarrierPromises(operation);
			const invoke = () => {
				const currentScope = transactionSavepointScopeForGate(gate);
				const execute = () => {
					try {
						return transactionSavepointOperationStorage.run(
							{ gate, operation, parent: operationScope },
							run
						);
					} catch (error) {
						return PROMISE_REJECT(error);
					}
				};
				if (!token || currentScope?.token === token) return execute();
				return transactionSavepointStorage.run(
					{ gate, token, parent: transactionSavepointStorage.getStore() },
					execute
				);
			};
			let promise: Promise<T>;
			if (pendingBarriers.length) {
				promise = (async () => {
					for (let index = 0; index < pendingBarriers.length; index++) {
						await pendingBarriers[index];
					}
					return await invoke();
				})();
			} else {
				promise = invoke();
			}
			operation.promise = promise;
			SET_ADD.call(activeOperations, operation);
			void PROMISE_THEN.call(
				promise,
				() => SET_DELETE.call(activeOperations, operation),
				() => SET_DELETE.call(activeOperations, operation)
			);
			return promise;
		},
		savepoint: <T>(
			run: (token: TransactionSavepointToken) => Promise<T>,
			boundParent?: TransactionSavepointToken
		): Promise<T> => {
			const scope = transactionSavepointScopeForGate(gate);
			const parent = boundParent ?? scope?.token;
			let release!: () => void;
			const done = new SAFE_PROMISE<void>((resolve) => {
				release = resolve;
			});
			const barrier: TransactionSavepointBarrier = {
				sequence: ++sequence,
				parent,
				operation: transactionSavepointOperationScopeForGate(gate)?.operation,
				done,
				release
			};
			SET_ADD.call(barriers, barrier);
			const previous = parent
				? (WEAKMAP_GET.call(nestedQueueTails, parent) as Promise<void> | undefined) ?? ready
				: rootQueueTail;
			const execution = PROMISE_THEN.call(
				previous,
				() => executeSavepoint(barrier, run),
				() => executeSavepoint(barrier, run)
			) as Promise<T>;
			const tail = PROMISE_THEN.call(
				execution,
				NOOP_REJECTION_OBSERVER,
				NOOP_REJECTION_OBSERVER
			) as Promise<void>;
			if (parent) WEAKMAP_SET.call(nestedQueueTails, parent, tail);
			else rootQueueTail = tail;
			return execution;
		},
		markRollbackOnly: (error) => {
			if (rollbackOnly) return;
			rollbackOnly = true;
			rollbackError = error;
		},
		rollbackOnlyError: () => rollbackOnly ? rollbackError : undefined
	};
	return gate;
}

function transactionOperationIsSelfOrDescendant(
	operation: TrackedTransactionOperation,
	ancestor: TrackedTransactionOperation
) {
	let current: TrackedTransactionOperation | undefined = operation;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

export function createTransactionOperationTracker(
	closedState: () => string | undefined,
	context: string
): TransactionOperationTracker {
	const pendingOperations = new Set<TrackedTransactionOperation>();
	let tracker!: TransactionOperationTracker;
	let trackContinuation!: TransactionOperationContinuationTracker;
	const observeRejection = (operation: TrackedTransactionOperation) => {
		operation.rejectionHandled = true;
		if (operation.state === 'rejected') SET_DELETE.call(pendingOperations, operation);
	};
	const createRejectionObserver = (operation: TrackedTransactionOperation) => {
		const scope = transactionOperationStorage.getStore();
		return () => {
			const closed = closedState();
			const canObserve =
				closed === undefined ||
				(scope?.tracker === tracker &&
					scope.operation.active &&
					transactionOperationIsSelfOrDescendant(operation, scope.operation));
			if (canObserve) observeRejection(operation);
		};
	};
	const track = <T>(
		run: () => Promise<T>,
		closedError?: (closed: string) => unknown,
		admitAfterClose = false,
		createUpstreamRejectionObserver?: () => () => void
	): Promise<T> => {
		const scope = transactionOperationStorage.getStore();
		const parent = scope?.tracker === tracker && scope.operation.active
			? scope.operation
			: undefined;
		const closed = closedState();
		if (closed !== undefined && !parent && !admitAfterClose) {
			return PROMISE_REJECT(
				closedError?.(closed) ??
					new ActiveTsConfigurationError(
						`Cannot start operations on a closed ${context} transaction after ${closed}.`
					)
			);
		}
		const tracked: TrackedTransactionOperation = {
			promise: undefined as unknown as Promise<unknown>,
			state: 'pending',
			rejectionHandled: false,
			active: true,
			parent
		};
		const createOwnRejectionObserver = () => createRejectionObserver(tracked);
		const createCombinedRejectionObserver = createUpstreamRejectionObserver
			? () => {
				const observeUpstream = createUpstreamRejectionObserver();
				const observeOwn = createOwnRejectionObserver();
				return () => {
					observeUpstream();
					observeOwn();
				};
			}
			: createOwnRejectionObserver;
		const pending = new TransactionOperationPromise<T>((resolve, reject) => {
			void (async () => {
				try {
					resolve(await transactionOperationStorage.run({ tracker, operation: tracked }, run));
				} catch (error) {
					reject(error);
				} finally {
					tracked.active = false;
				}
			})();
		}, createCombinedRejectionObserver, trackContinuation);
		tracked.promise = pending;
		SET_ADD.call(pendingOperations, tracked);
		void PROMISE_THEN.call(
			pending,
			() => {
				SET_DELETE.call(pendingOperations, tracked);
			},
			(error) => {
				tracked.state = 'rejected';
				tracked.error = error;
				if (tracked.rejectionHandled) SET_DELETE.call(pendingOperations, tracked);
			}
		);
		return pending;
	};
	trackContinuation = <T>(
		run: () => Promise<T>,
		createUpstreamRejectionObserver: () => () => void
	): Promise<T> | undefined => {
		const scope = transactionOperationStorage.getStore();
		const parent = scope?.tracker === tracker && scope.operation.active
			? scope.operation
			: undefined;
		if (closedState() !== undefined && !parent) return undefined;
		return track(run, undefined, false, createUpstreamRejectionObserver);
	};
	tracker = {
		track,
		hasPendingOperations: () => SET_SIZE.call(pendingOperations) > 0,
		waitForPendingOperations: async () => {
			const failures: unknown[] = [];
			while (true) {
				const operations = iterableToArray(
					SET_VALUES.call(pendingOperations) as Iterable<TrackedTransactionOperation>
				);
				let waiting = false;
				for (const operation of operations) {
					if (operation.state !== 'pending') continue;
					waiting = true;
					try {
						await (PROMISE_THEN.call(operation.promise) as Promise<unknown>);
					} catch {
						// Rejections are collected after every admitted operation has settled.
					}
				}
				if (!waiting) break;
			}
			const operations = iterableToArray(
				SET_VALUES.call(pendingOperations) as Iterable<TrackedTransactionOperation>
			);
			const failureSet = new Set<unknown>();
			for (const operation of operations) {
				if (operation.state === 'rejected' && !operation.rejectionHandled) {
					if (!SET_HAS.call(failureSet, operation.error)) {
						SET_ADD.call(failureSet, operation.error);
						failures[failures.length] = operation.error;
					}
				}
				SET_DELETE.call(pendingOperations, operation);
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, `${context} transaction operations failed.`);
			}
		}
	};
	return tracker;
}

export function trackStoreTransactionOperation<T>(
	adapter: StoreAdapter,
	run: () => Promise<T>
): Promise<T> {
	return trackAdapterTransactionOperation(adapter, run);
}

export function trackStoreTransactionWork<T>(
	adapter: StoreAdapter,
	run: () => Promise<T>
): Promise<T> {
	if (typeof run !== 'function') {
		return PROMISE_REJECT(new ActiveTsConfigurationError('Transaction work must be a function.'));
	}
	const carrier = WEAKMAP_GET.call(
		adapterTransactionOperationCarriers,
		adapter
	) as AdapterTransactionOperationCarrier | undefined;
	if (!carrier || !WEAKSET_HAS.call(transactionWorkAdapters, adapter)) {
		return PROMISE_REJECT(new ActiveTsConfigurationError(
			'Transaction work requires a transaction-scoped store adapter.'
		));
	}
	return carrier(run);
}

export function inheritStoreTransactionOperationTracker<T extends StoreAdapter>(
	adapter: T,
	source: StoreAdapter
): T {
	return inheritAdapterTransactionOperationCarrier(adapter, source);
}

export function trackAdapterTransactionOperation<T>(
	adapter: object,
	run: () => Promise<T>
): Promise<T> {
	const carrier = WEAKMAP_GET.call(adapterTransactionOperationCarriers, adapter) as AdapterTransactionOperationCarrier | undefined;
	return carrier ? carrier(run) : run();
}

export function trackAdapterSavepointOperation<T>(adapter: object, run: () => Promise<T>): Promise<T> {
	const gate = WEAKMAP_GET.call(adapterSavepointOperationGates, adapter) as AdapterTransactionOperationCarrier | undefined;
	return gate ? gate(run) : run();
}

export function markAdapterTransactionOperationCarrier<T extends object>(
	adapter: T,
	carrier: AdapterTransactionOperationCarrier
): T {
	WEAKMAP_SET.call(adapterTransactionOperationCarriers, adapter, carrier);
	return adapter;
}

export function inheritAdapterTransactionOperationCarrier<T extends object>(
	adapter: T,
	source: object
): T {
	const carrier = WEAKMAP_GET.call(adapterTransactionOperationCarriers, source) as AdapterTransactionOperationCarrier | undefined;
	if (carrier) WEAKMAP_SET.call(adapterTransactionOperationCarriers, adapter, carrier);
	if (WEAKSET_HAS.call(transactionWorkAdapters, source)) {
		WEAKSET_ADD.call(transactionWorkAdapters, adapter);
	}
	return adapter;
}

export function createCloseGuardedStoreAdapter(
	adapter: StoreAdapter,
	closedState: () => string | undefined,
	context: string
): {
	adapter: StoreAdapter;
	waitForPendingOperations: () => Promise<void>;
} {
	return createCloseGuardedStoreAdapterWithSavepointGate(
		adapter,
		closedState,
		context,
		typeof adapter.savepoint === 'function' ? createTransactionSavepointGate() : undefined
	);
}

function createCloseGuardedStoreAdapterWithSavepointGate(
	adapter: StoreAdapter,
	closedState: () => string | undefined,
	context: string,
	savepointGate: TransactionSavepointGate | undefined,
	savepointToken?: TransactionSavepointToken
): {
	adapter: StoreAdapter;
	waitForPendingOperations: () => Promise<void>;
} {
	const operations = createTransactionOperationTracker(closedState, context);
	if (savepointToken) savepointToken.operations = operations;
	const currentSavepointToken = () => {
		const ambientToken = savepointGate
			? transactionSavepointScopeForGate(savepointGate)?.token
			: undefined;
		if (!savepointToken) return ambientToken;
		return ambientToken && transactionSavepointTokenIsSelfOrDescendant(ambientToken, savepointToken)
			? ambientToken
			: savepointToken;
	};
	const operationsFor = (token: TransactionSavepointToken | undefined) => token?.operations ?? operations;
	const track = <T>(operation: string, run: () => Promise<T>): Promise<T> => {
		const token = currentSavepointToken();
		return operationsFor(token).track(
			() => savepointGate ? savepointGate.run(run, token) : run(),
			(closed) => new ActiveTsConfigurationError(
				`Cannot ${operation} on a closed ${context} transaction adapter after ${closed}.`
			)
		);
	};
	const savepoint: StoreAdapter['savepoint'] =
		adapter.savepoint && savepointGate
			? <T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> => {
					const parentToken = currentSavepointToken();
					return operationsFor(parentToken).track(
						() =>
							savepointGate.savepoint(async (token) => {
								if (typeof fn !== 'function') {
									throw new ActiveTsConfigurationError(
										`${context} savepoint callback must be a function.`
									);
								}
								let callbackAdmissionOpen = true;
								let callbackStarted = false;
								let callbackCompletion: Promise<T> | undefined;
								let callbackSettled = false;
								let callbackRejected = false;
								let callbackProtocolError: ActiveTsConfigurationError | undefined;
								let adapterRejected = false;
								let adapterError: unknown;
								let callbackStartAllowed = false;
								let callbackStart: (() => void) | undefined;
								const queueCallbackStart = () => {
									if (!callbackStartAllowed || !callbackStart) return;
									const start = callbackStart;
									callbackStart = undefined;
									const scheduled = PROMISE_THEN.call(
										PROMISE_RESOLVE(undefined),
										start
									) as Promise<void>;
									void PROMISE_THEN.call(scheduled, undefined, NOOP_REJECTION_OBSERVER);
								};
								let result!: T;
								let adapterCompletion: Promise<T> | undefined;
								try {
									const pendingAdapterCompletion = adapter.savepoint!((nestedAdapter) => {
										if (!callbackAdmissionOpen || callbackStarted) {
											const protocolError = markSavepointRollbackUnconfirmed(
												new ActiveTsConfigurationError(
													!callbackAdmissionOpen
														? `${context} savepoint adapter ran its callback after the savepoint settled.`
														: `${context} savepoint adapter ran its callback more than once.`
												)
											);
											callbackProtocolError ??= protocolError;
											savepointGate.markRollbackOnly(protocolError);
											const rejection = PROMISE_REJECT(protocolError);
											void PROMISE_THEN.call(rejection, undefined, NOOP_REJECTION_OBSERVER);
											return rejection;
										}
										callbackStarted = true;
										let releaseCallbackStart!: () => void;
										let rejectCallbackStart!: (error: unknown) => void;
										const callbackStartBarrier = new SAFE_PROMISE<void>((resolve, reject) => {
											releaseCallbackStart = resolve;
											rejectCallbackStart = reject;
										});
										callbackStart = () => {
											if (callbackAdmissionOpen) {
												releaseCallbackStart();
												return;
											}
											const protocolError = markSavepointRollbackUnconfirmed(
												new ActiveTsConfigurationError(
													`${context} savepoint adapter ran its callback after the savepoint settled.`
												)
											);
											callbackProtocolError ??= protocolError;
											savepointGate.markRollbackOnly(protocolError);
											rejectCallbackStart(protocolError);
										};
										const execution = (async () => {
											await callbackStartBarrier;
											let nestedClosed: string | undefined;
											const nested = createCloseGuardedStoreAdapterWithSavepointGate(
												nestedAdapter,
												() => nestedClosed,
												`${context} savepoint`,
												savepointGate,
												token
											);
											try {
												const callbackResult = await fn(nested.adapter);
												nestedClosed = 'callback finished';
												await nested.waitForPendingOperations();
												return callbackResult;
											} catch (error) {
												nestedClosed = 'rollback';
												try {
													await nested.waitForPendingOperations();
												} catch {
													// Preserve the callback or operation error that triggered rollback.
												}
												throw error;
											}
										})();
										const completion = PROMISE_THEN.call(
											execution,
											(value: T) => {
												callbackSettled = true;
												return value;
											},
											(error: unknown) => {
												callbackSettled = true;
												callbackRejected = true;
												throw error;
											}
										) as Promise<T>;
										callbackCompletion = completion;
										void PROMISE_THEN.call(completion, undefined, NOOP_REJECTION_OBSERVER);
										queueCallbackStart();
										return completion;
									});
									adapterCompletion = observeAdapterTransactionPromiseSettlement(
										pendingAdapterCompletion,
										() => {
											callbackAdmissionOpen = false;
										}
									);
								} catch (error) {
									callbackAdmissionOpen = false;
									adapterRejected = true;
									adapterError = error;
								}
								callbackStartAllowed = true;
								queueCallbackStart();
								if (adapterCompletion) {
									try {
										result = await adapterCompletion;
									} catch (error) {
										adapterRejected = true;
										adapterError = error;
									}
								}
								if (adapterRejected) {
									if (callbackCompletion && !callbackSettled) {
										try {
											await callbackCompletion;
										} catch {
											// The adapter protocol error takes precedence over callback failure.
										}
										if (callbackProtocolError) throw callbackProtocolError;
										const malformed = markSavepointRollbackUnconfirmed(
											new ActiveTsConfigurationError(
												`${context} savepoint adapter rejected before its callback settled.`
											)
										);
										savepointGate.markRollbackOnly(malformed);
										throw malformed;
									}
									if (callbackProtocolError) throw callbackProtocolError;
									throw adapterError;
								}
								if (callbackProtocolError) throw callbackProtocolError;
								if (!callbackStarted || !callbackCompletion) {
									throw new ActiveTsConfigurationError(
										`${context} savepoint adapter completed without running its callback.`
									);
								}
								if (!callbackSettled) {
									try {
										await callbackCompletion;
									} catch {
										// The adapter protocol error takes precedence over callback failure.
									}
									if (callbackProtocolError) throw callbackProtocolError;
									const malformed = markSavepointRollbackUnconfirmed(
										new ActiveTsConfigurationError(
											`${context} savepoint adapter completed before its callback settled.`
										)
									);
									savepointGate.markRollbackOnly(malformed);
									throw malformed;
								}
								if (callbackRejected) {
									const malformed = markSavepointRollbackUnconfirmed(
										new ActiveTsConfigurationError(
											`${context} savepoint adapter completed after its callback failed.`
										)
									);
									savepointGate.markRollbackOnly(malformed);
									throw malformed;
								}
								return result;
							}, parentToken),
						(closed) =>
							new ActiveTsConfigurationError(
								`Cannot start savepoints on a closed ${context} transaction adapter after ${closed}.`
							)
					);
				}
			: undefined;
	const guarded: StoreAdapter = {
		kind: adapter.kind,
		cacheScope: adapter.cacheScope,
		datastoreNamespace: adapter.datastoreNamespace,
		datastoreProjectId: adapter.datastoreProjectId,
		datastoreDatabaseId: adapter.datastoreDatabaseId,
		datastoreKeyEncoding: adapter.datastoreKeyEncoding,
		capabilities: adapter.capabilities,
		get: (model, id, options) => track('get rows', () => adapter.get(model, id, options)),
		getMany: (model, ids, options) => track('get rows', () => adapter.getMany(model, ids, options)),
		query: (model, plan, options) => track('query rows', () => adapter.query(model, plan, options)),
		aggregate: adapter.aggregate
			? (model, plan) => track('aggregate rows', () => adapter.aggregate!(model, plan))
			: undefined,
		create: (model, id, data, options) => track('create rows', () => adapter.create(model, id, data, options)),
		update: (model, id, data, options) => track('update rows', () => adapter.update(model, id, data, options)),
		delete: (model, id, options) => track('delete rows', () => adapter.delete(model, id, options)),
		transaction: adapter.transaction
			? (fn, options) => track('start nested transactions', () => adapter.transaction!(fn, options))
			: undefined,
		savepoint,
		schema: adapter.schema
			? {
					plan: (models) => track('plan schema changes', () => adapter.schema!.plan(models)),
					apply: (models, options) => track('apply schema changes', () => adapter.schema!.apply(models, options))
				}
			: undefined
	};
	const guardedAdapter = storeTrustsDatastoreEntityKeyRows(adapter)
		? markStoreTrustsDatastoreEntityKeyRows(guarded)
		: guarded;
	if (savepointGate) {
		const gate: AdapterTransactionOperationCarrier = (run) => {
			const token = currentSavepointToken();
			const invoke = () => savepointGate.run(run, token);
			return token?.operations ? token.operations.track(invoke) : invoke();
		};
		WEAKMAP_SET.call(adapterSavepointOperationGates, adapter, gate);
		WEAKMAP_SET.call(adapterSavepointOperationGates, guardedAdapter, gate);
	}
	markAdapterTransactionOperationCarrier(guardedAdapter, (run) => {
		const token = currentSavepointToken();
		return operationsFor(token).track(run);
	});
	WEAKSET_ADD.call(transactionWorkAdapters, guardedAdapter);
	return {
		adapter: guardedAdapter,
		waitForPendingOperations: async () => {
			await operations.waitForPendingOperations();
			const rollbackOnlyError = savepointGate?.rollbackOnlyError();
			if (rollbackOnlyError !== undefined) throw rollbackOnlyError;
		}
	};
}

export function normalizeStoreAggregateResult(
	value: unknown,
	specs: AggregatePlan['aggregates'],
	context: string
): AggregateResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} result must be a plain object.`);
	}
	return normalizeAggregateRow(value, validateAggregateSpecs(specs), `${context} result`);
}

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`store option "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`store option "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function assertKnownOptionKeys(value: object, allowedKeys: readonly string[], context: string) {
	const allowed = new Set<string>();
	for (const key of allowedKeys) SET_ADD.call(allowed, key);
	for (const property of Object.getOwnPropertyNames(value)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function assertPlainRecord(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	assertAllowedStorePlanSymbols(value, context);
	for (const property of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
	}
	return value as Record<string, unknown>;
}

function assertAllowedStorePlanSymbols(value: object, context: string) {
	for (const symbol of Object.getOwnPropertySymbols(value)) {
		if (symbol !== FIELD_CODEC_QUERY_OPERANDS_ENCODED) {
			throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
		}
		hasFieldCodecQueryOperandsEncoded(value);
	}
}

function arrayOrEmpty<T>(value: unknown, context: string): T[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ActiveTsValidationError(`${context} must be an array.`);
	return arrayDataValues(value, context) as T[];
}

function optionalArray<T>(value: unknown, context: string): T[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new ActiveTsValidationError(`${context} must be an array.`);
	return arrayDataValues(value, context) as T[];
}

function arrayDataValues(value: unknown[], context: string) {
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const values: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		values.push(descriptor.value);
	}
	return values;
}

function normalizeStoreQueryBranch(
	plan: unknown,
	context: string,
	diagnostics: StorePlanDiagnostics = {}
): QueryPlan {
	const record = assertPlainRecord(plan, context);
	assertKnownOptionKeys(record, QUERY_PLAN_KEYS, context);
	const branchSort = arrayOrEmpty(ownOptionValue(record, 'sort'), `${context}.sort`);
	if (branchSort.length) {
		throw new ActiveTsValidationError(`${context}.sort must be empty; OR branches cannot define sort order.`);
	}
	const branchInclude = arrayOrEmpty(ownOptionValue(record, 'include'), `${context}.include`);
	if (branchInclude.length) {
		throw new ActiveTsValidationError(`${context}.include must be empty; OR branches cannot define includes.`);
	}
	for (const property of ['limit', 'offset', 'cursor', 'select', 'native', 'meta'] as const) {
		if (ownOptionValue(record, property) !== undefined) {
			throw new ActiveTsValidationError(`${context}.${property} must be undefined; OR branches cannot define ${property}.`);
		}
	}
	const branch = {
		where: normalizeWhereEntries(ownOptionValue(record, 'where'), `${context}.where`, diagnostics.whereField),
		or: normalizeStoreQueryBranches(ownOptionValue(record, 'or'), `${context}.or`, diagnostics),
		sort: [],
		include: []
	};
	if (!branch.where.length && !branch.or.length) {
		throw new ActiveTsValidationError(`${context} requires at least one where condition.`);
	}
	return branch;
}

function normalizeWhereEntries(value: unknown, context: string, fieldContext?: string): QueryPlan['where'] {
	const entries = arrayOrEmpty<Record<string, unknown>>(value, context);
	const normalized: QueryPlan['where'] = [];
	for (let index = 0; index < entries.length; index++) {
		const where = entries[index];
		const record = assertPlainRecord(where, `${context}[${index}]`);
		assertKnownOptionKeys(record, WHERE_ENTRY_KEYS, `${context}[${index}]`);
		const field = assertSafeFieldPath(ownOptionValue(record, 'field'), fieldContext ?? `${context}[${index}].field`);
		const op = ownOptionValue(record, 'op');
		if (typeof op !== 'string' || !isOperator(op)) {
			throw new ActiveTsValidationError(invalidValueMessage('Query operator', op));
		}
		const operand = ownOptionValue(record, 'value');
		const hasValue2 = Object.prototype.hasOwnProperty.call(record, 'value2');
		const upper = ownOptionValue(record, 'value2');
		assertValidWhereOperand(op, operand, upper, field);
		if (op !== 'between' && hasValue2) {
			throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" does not accept value2.`);
		}
		normalized[index] = !hasValue2
			? { field, op, value: cloneQueryOperand(operand) }
			: { field, op, value: cloneQueryOperand(operand), value2: cloneQueryOperand(upper) };
	}
	return normalized;
}

function normalizeStoreQueryBranches(value: unknown, context: string, diagnostics: StorePlanDiagnostics = {}) {
	const branches = arrayOrEmpty<Partial<QueryPlan>>(value, context);
	const normalized: QueryPlan['or'] = [];
	for (let index = 0; index < branches.length; index++) {
		normalized[index] = normalizeStoreQueryBranch(branches[index], `${context}[${index}]`, diagnostics);
	}
	return normalized;
}

function normalizeStoreSortList(value: unknown, context: string, fieldContext?: string) {
	const sorts = arrayOrEmpty(value, context);
	const normalized: QueryPlan['sort'] = [];
	for (let index = 0; index < sorts.length; index++) {
		normalized[index] = normalizeStoreSort(sorts[index], `${context}[${index}]`, fieldContext);
	}
	return normalized;
}

function normalizeStoreSort(sort: unknown, context: string, fieldContext?: string) {
	if (typeof sort === 'string') {
		if (sort.startsWith('-')) return { field: assertSafeFieldPath(sort.slice(1), fieldContext ?? `${context}.field`), direction: 'desc' as const };
		return { field: assertSafeFieldPath(sort, fieldContext ?? `${context}.field`), direction: 'asc' as const };
	}
	const record = assertPlainRecord(sort, context);
	assertKnownOptionKeys(record, SORT_SPEC_KEYS, context);
	const rawDirection = ownOptionValue(record, 'direction');
	if (rawDirection !== undefined && rawDirection !== 'asc' && rawDirection !== 'desc') {
		throw new ActiveTsValidationError(invalidValueMessage('Sort direction', rawDirection));
	}
	const direction: SortDirection = rawDirection === 'desc' ? 'desc' : 'asc';
	return { field: assertSafeFieldPath(ownOptionValue(record, 'field'), fieldContext ?? `${context}.field`), direction };
}

function normalizeIncludeSpecs(value: unknown, context: string, fieldContext?: string) {
	return normalizeFieldPathList(arrayOrEmpty<string>(value, context), context, fieldContext);
}

function normalizeFieldPathList(fields: readonly unknown[], context: string, fieldContext?: string) {
	const normalized: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		normalized[index] = assertSafeFieldPath(fields[index], fieldContext ?? `${context}[${index}]`);
	}
	return normalized;
}

function normalizeStoreNative(native: unknown, context: string): QueryNative | undefined {
	if (native === undefined) return undefined;
	const record = assertPlainRecord(native, context);
	assertKnownOptionKeys(record, NATIVE_QUERY_KEYS, context);
	if (!Object.prototype.hasOwnProperty.call(record, 'payload')) {
		throw new ActiveTsValidationError(`${context}.payload is required.`);
	}
	const adapter = ownOptionValue(record, 'adapter');
	const payload = ownOptionValue(record, 'payload');
	if (payload === undefined) {
		throw new ActiveTsValidationError(`${context}.payload is required.`);
	}
	return {
		adapter: adapter === undefined ? undefined : assertSafeSchemaIdentifier(adapter, `${context}.adapter`),
		payload: cloneNativePayload(payload, `${context}.payload`)
	};
}

function normalizePlanMeta(meta: unknown, context: string): QueryPlan['meta'] | undefined {
	return clonePlanMeta(meta, context);
}

function collectWhereEntries(plan: Pick<QueryPlan, 'where' | 'or'>): QueryPlan['where'] {
	const entries = cloneWhereEntries(plan.where);
	for (let index = 0; index < plan.or.length; index++) {
		const branchEntries = collectWhereEntries(plan.or[index]);
		for (let branchIndex = 0; branchIndex < branchEntries.length; branchIndex++) {
			entries[entries.length] = branchEntries[branchIndex];
		}
	}
	return entries;
}

function isRangeOperator(op: QueryPlan['where'][number]['op']) {
	return op === '>' || op === '>=' || op === '<' || op === '<=' || op === 'between';
}

function invalidValueMessage(label: string, value: unknown) {
	return typeof value === 'string' ? `${label} "${value}" is not allowed.` : `${label} is not allowed.`;
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

function constrainOrBranch(branch: QueryPlan, constraints: QueryPlan['where']): QueryPlan {
	const hasOwnAlternative = branch.where.length > 0 || branch.or.length === 0;
	const where = hasOwnAlternative ? mergeWhereConstraints(constraints, branch.where) : [];
	const or: QueryPlan['or'] = [];
	for (let index = 0; index < branch.or.length; index++) {
		or[index] = constrainOrBranch(branch.or[index], constraints);
	}
	return {
		...branch,
		where,
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

function cloneWhereEntries(entries: QueryPlan['where']): QueryPlan['where'] {
	const cloned: QueryPlan['where'] = [];
	for (let index = 0; index < entries.length; index++) {
		cloned[index] = cloneWhereEntry(entries[index]);
	}
	return cloned;
}

function cloneWhereEntry(entry: QueryPlan['where'][number]): QueryPlan['where'][number] {
	return entry.value2 === undefined
		? { field: entry.field, op: entry.op, value: cloneQueryOperand(entry.value) }
		: { field: entry.field, op: entry.op, value: cloneQueryOperand(entry.value), value2: cloneQueryOperand(entry.value2) };
}

function hasMatchingWhereEntry(entries: QueryPlan['where'], constraint: QueryPlan['where'][number]) {
	for (let index = 0; index < entries.length; index++) {
		if (sameWhereEntry(entries[index], constraint)) return true;
	}
	return false;
}

function sameWhereEntry(left: QueryPlan['where'][number], right: QueryPlan['where'][number]) {
	return left.field === right.field &&
		left.op === right.op &&
		isDeepStrictEqual(left.value, right.value) &&
		isDeepStrictEqual(left.value2, right.value2);
}
