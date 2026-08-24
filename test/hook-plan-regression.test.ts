import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsConfigurationError,
	ActiveTsValidationError,
	MemoryStoreAdapter,
	Model,
	type AggregateResult,
	type QueryResult,
	type ResolvedModelMeta,
	type SearchAdapter,
	type SearchOptions,
	createActiveTs,
	defineModel
} from '../src/index.js';

type HookPlanData = {
	id: number;
	value: number;
	label: string;
};

class UnsafeQueryHookRecord extends Model<HookPlanData> {}
class UnsafeAggregateHookRecord extends Model<HookPlanData> {}
class UnsafeSearchHookRecord extends Model<HookPlanData> {}
class UnsafeQueryCursorHookRecord extends Model<HookPlanData> {}
class UnsafeSearchCursorHookRecord extends Model<HookPlanData> {}
class UnsafeAfterQueryHookRecord extends Model<HookPlanData> {}
class UnsafeAfterAggregateHookRecord extends Model<HookPlanData> {}
class UnsafeAfterSearchHookRecord extends Model<HookPlanData> {}
class IteratorAfterQueryHookRecord extends Model<HookPlanData> {}
class IteratorAfterSearchHookRecord extends Model<HookPlanData> {}
class MalformedQueryPlanHookRecord extends Model<HookPlanData> {}
class MalformedAggregatePlanHookRecord extends Model<HookPlanData> {}
class MalformedSearchOptionsHookRecord extends Model<HookPlanData> {}
class UnknownQueryPlanHookRecord extends Model<HookPlanData> {}
class UnknownAggregatePlanHookRecord extends Model<HookPlanData> {}
class UnknownSearchOptionsHookRecord extends Model<HookPlanData> {}
class MalformedQueryArrayHookRecord extends Model<HookPlanData> {}
class MalformedAggregateArrayHookRecord extends Model<HookPlanData> {}
class MalformedQueryNativeHookRecord extends Model<HookPlanData> {}
class MalformedAggregateNativeHookRecord extends Model<HookPlanData> {}
class MalformedQueryMetaHookRecord extends Model<HookPlanData> {}
class HiddenQueryMetaHookRecord extends Model<HookPlanData> {}
class MalformedAggregateMetaHookRecord extends Model<HookPlanData> {}
class InheritedQueryWhereHookRecord extends Model<HookPlanData> {}
class InheritedAggregateWhereHookRecord extends Model<HookPlanData> {}
class UnsafeNativeAdapterHookRecord extends Model<HookPlanData> {}
class UnsafeHookResultRecord extends Model<HookPlanData> {}
class InheritedSearchResultRecord extends Model<HookPlanData> {}
class MutatingAfterInstantiateIdRecord extends Model<HookPlanData> {}
class MutatingAfterInstantiateDataRecord extends Model<HookPlanData> {}
class MutatingAfterCreateIdRecord extends Model<HookPlanData> {}
class MutatingAfterUpdateIdRecord extends Model<HookPlanData> {}
class MutatingAfterCreateDataRecord extends Model<HookPlanData> {}
class MutatingAfterCreateInstantiateDataRecord extends Model<HookPlanData> {}
class MutatingAfterUpdateDataRecord extends Model<HookPlanData> {}
class MutatingAfterQueryIdRecord extends Model<HookPlanData> {}
class MutatingAfterSearchIdRecord extends Model<HookPlanData> {}
class DuplicateAfterQueryResultRecord extends Model<HookPlanData> {}
class DuplicateAfterSearchResultRecord extends Model<HookPlanData> {}
class RuntimeHookDispatchRecord extends Model<HookPlanData> {}

type MixedOrHookData = {
	id: number;
	tenantId: string;
	status: 'open' | 'pending' | 'closed' | 'missing';
};

class MixedOrHookRecord extends Model<MixedOrHookData> {}
class NestedMixedOrHookRecord extends Model<MixedOrHookData> {}
class ScopedNestedPublicOrHookRecord extends Model<MixedOrHookData> {}

const runtimeHookDispatchEvents: string[] = [];

defineModel<HookPlanData>('hook_unsafe_query_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					where: [{ field: '__proto__', op: '=', value: 'pollute' }]
				}
			};
		}
	})
	.attach(UnsafeQueryHookRecord);

defineModel<HookPlanData>('hook_after_instantiate_id_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterInstantiate(payload) {
			(payload.target as any).data.id = 999;
		}
	})
	.attach(MutatingAfterInstantiateIdRecord);

defineModel<HookPlanData>('hook_after_instantiate_data_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterInstantiate(payload) {
			(payload.data as any).__unsafe = true;
		}
	})
	.attach(MutatingAfterInstantiateDataRecord);

defineModel<HookPlanData>('hook_after_create_id_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterCreate(payload) {
			(payload.target as any).data.id = 999;
		}
	})
	.attach(MutatingAfterCreateIdRecord);

defineModel<HookPlanData>('hook_after_update_id_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterUpdate(payload) {
			(payload.target as any).data.id = 999;
		}
	})
	.attach(MutatingAfterUpdateIdRecord);

defineModel<HookPlanData>('hook_after_create_data_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterCreate(payload) {
			(payload.target as any).data.label = 'hook-only-create';
		}
	})
	.attach(MutatingAfterCreateDataRecord);

defineModel<HookPlanData>('hook_after_create_instantiate_data_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterInstantiate(payload) {
			if (payload.operation === 'create') {
				(payload.target as any).data.label = 'hook-only-instantiate';
			}
		}
	})
	.attach(MutatingAfterCreateInstantiateDataRecord);

defineModel<HookPlanData>('hook_after_update_data_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterUpdate(payload) {
			(payload.target as any).data.label = 'hook-only-update';
		}
	})
	.attach(MutatingAfterUpdateDataRecord);

defineModel<HookPlanData>('hook_after_query_id_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterQuery(payload) {
			((payload.result as QueryResult<MutatingAfterQueryIdRecord>).list[0] as any).data.id = 999;
		}
	})
	.attach(MutatingAfterQueryIdRecord);

defineModel<HookPlanData>('hook_after_search_id_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		afterSearch(payload) {
			((payload.result as QueryResult<MutatingAfterSearchIdRecord>).list[0] as any).data.id = 999;
		}
	})
	.attach(MutatingAfterSearchIdRecord);

defineModel<HookPlanData>('hook_duplicate_after_query_result_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterQuery(payload) {
			const result = payload.result as QueryResult<DuplicateAfterQueryResultRecord>;
			return { result: { ...result, list: [result.list[0], result.list[0]] } };
		}
	})
	.attach(DuplicateAfterQueryResultRecord);

defineModel<HookPlanData>('hook_duplicate_after_search_result_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		afterSearch(payload) {
			const result = payload.result as QueryResult<DuplicateAfterSearchResultRecord>;
			return { result: { ...result, list: [result.list[0], result.list[0]] } };
		}
	})
	.attach(DuplicateAfterSearchResultRecord);

defineModel<HookPlanData>('runtime_hook_dispatch_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeRead() {
			runtimeHookDispatchEvents[runtimeHookDispatchEvents.length] = 'model';
		}
	})
	.attach(RuntimeHookDispatchRecord);

defineModel<HookPlanData>('hook_unsafe_aggregate_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					aggregates: [{ op: 'sum', field: '__proto__', as: 'bad' }]
				}
			};
		}
	})
	.attach(UnsafeAggregateHookRecord);

defineModel<HookPlanData>('hook_unsafe_search_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeSearch(payload) {
			return { ...payload, query: { text: payload.query } as any };
		}
	})
	.attach(UnsafeSearchHookRecord);

defineModel<HookPlanData>('hook_unsafe_query_cursor_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, cursor: { unsafe: true } } };
		}
	})
	.attach(UnsafeQueryCursorHookRecord);

defineModel<HookPlanData>('hook_unsafe_search_cursor_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeSearch(payload) {
			return { ...payload, options: { ...(payload.options as any), cursor: { unsafe: true } } };
		}
	})
	.attach(UnsafeSearchCursorHookRecord);

defineModel<HookPlanData>('hook_unsafe_after_query_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterQuery(payload) {
			return { result: { ...(payload.result as any), list: [{ id: 1, label: 'not a model' }] } };
		}
	})
	.attach(UnsafeAfterQueryHookRecord);

defineModel<HookPlanData>('hook_unsafe_after_aggregate_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterAggregate() {
			return { result: { count: { unsafe: true } } };
		}
	})
	.attach(UnsafeAfterAggregateHookRecord);

defineModel<HookPlanData>('hook_unsafe_after_search_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		afterSearch(payload) {
			return { result: { ...(payload.result as any), cursor: { unsafe: true } } };
		}
	})
	.attach(UnsafeAfterSearchHookRecord);

let afterQueryListIteratorCalls = 0;
defineModel<HookPlanData>('hook_iterator_after_query_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		afterQuery(payload) {
			const list = [...((payload.result as QueryResult<IteratorAfterQueryHookRecord>).list as any[])];
			Object.defineProperty(list, Symbol.iterator, {
				value() {
					afterQueryListIteratorCalls++;
					throw new Error('custom afterQuery result iterator should not run');
				}
			});
			return { result: { ...(payload.result as any), list } };
		}
	})
	.attach(IteratorAfterQueryHookRecord);

let afterSearchListIteratorCalls = 0;
defineModel<HookPlanData>('hook_iterator_after_search_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		afterSearch(payload) {
			const list = [{ id: 1, value: 1, label: 'one' }] as any[];
			Object.defineProperty(list, Symbol.iterator, {
				value() {
					afterSearchListIteratorCalls++;
					throw new Error('custom afterSearch result iterator should not run');
				}
			});
			return { result: { ...(payload.result as any), list } };
		}
	})
	.attach(IteratorAfterSearchHookRecord);

defineModel<HookPlanData>('hook_malformed_query_plan_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery() {
			return { plan: null as any };
		}
	})
	.attach(MalformedQueryPlanHookRecord);

defineModel<HookPlanData>('hook_malformed_aggregate_plan_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeAggregate() {
			return { plan: [] as any };
		}
	})
	.attach(MalformedAggregatePlanHookRecord);

defineModel<HookPlanData>('hook_malformed_search_options_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeSearch() {
			return { options: [] as any };
		}
	})
	.attach(MalformedSearchOptionsHookRecord);

defineModel<HookPlanData>('hook_unknown_query_plan_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, limt: 1 } };
		}
	})
	.attach(UnknownQueryPlanHookRecord);

defineModel<HookPlanData>('hook_unknown_aggregate_plan_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, aggregats: [{ op: 'count', as: 'count' }] } };
		}
	})
	.attach(UnknownAggregatePlanHookRecord);

defineModel<HookPlanData>('hook_unknown_search_options_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeSearch(payload) {
			return { ...payload, options: { ...(payload.options as any), limt: 1 } };
		}
	})
	.attach(UnknownSearchOptionsHookRecord);

defineModel<HookPlanData>('hook_malformed_query_array_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, where: {} as any } };
		}
	})
	.attach(MalformedQueryArrayHookRecord);

defineModel<HookPlanData>('hook_malformed_aggregate_array_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, aggregates: {} as any } };
		}
	})
	.attach(MalformedAggregateArrayHookRecord);

defineModel<HookPlanData>('hook_inherited_query_where_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					where: [Object.create({ field: 'label', op: '=', value: 'one' })]
				}
			};
		}
	})
	.attach(InheritedQueryWhereHookRecord);

defineModel<HookPlanData>('hook_inherited_aggregate_where_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					where: [Object.create({ field: 'label', op: '=', value: 'one' })]
				}
			};
		}
	})
	.attach(InheritedAggregateWhereHookRecord);

defineModel<HookPlanData>('hook_malformed_query_native_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, native: null as any } };
		}
	})
	.attach(MalformedQueryNativeHookRecord);

defineModel<HookPlanData>('hook_malformed_aggregate_native_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, native: { adapter: 'default' } as any } };
		}
	})
	.attach(MalformedAggregateNativeHookRecord);

defineModel<HookPlanData>('hook_malformed_query_meta_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, meta: [] as any } };
		}
	})
	.attach(MalformedQueryMetaHookRecord);

defineModel<HookPlanData>('hook_hidden_query_meta_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					meta: Object.defineProperty({}, 'softDelete', {
						enumerable: false,
						value: 'with'
					})
				}
			};
		}
	})
	.attach(HiddenQueryMetaHookRecord);

defineModel<HookPlanData>('hook_malformed_aggregate_meta_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, meta: null as any } };
		}
	})
	.attach(MalformedAggregateMetaHookRecord);

defineModel<HookPlanData>('hook_unsafe_native_adapter_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return { plan: { ...plan, native: { adapter: '__proto__', payload: {} } as any } };
		}
	})
	.attach(UnsafeNativeAdapterHookRecord);

defineModel<HookPlanData>('hook_unsafe_result_record')
	.id('id')
	.validate((input) => input as HookPlanData)
	.hooks({
		beforeQuery() {
			return JSON.parse('{"__proto__":{"polluted":true},"plan":null}');
		}
	})
	.attach(UnsafeHookResultRecord);

defineModel<HookPlanData>('hook_inherited_search_result_record')
	.id('id')
	.search('default', ['label'])
	.validate((input) => input as HookPlanData)
	.attach(InheritedSearchResultRecord);

defineModel<MixedOrHookData>('hook_mixed_or_record')
	.id('id')
	.validate((input) => input as MixedOrHookData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					where: [{ field: 'tenantId', op: '=', value: 'a' }],
					or: [
						{ where: [{ field: 'status', op: '=', value: 'open' }], or: [], sort: [], include: [] },
						{ where: [{ field: 'id', op: '=', value: 3 }], or: [], sort: [], include: [] }
					]
				}
			};
		}
	})
	.attach(MixedOrHookRecord);

defineModel<MixedOrHookData>('hook_nested_mixed_or_record')
	.id('id')
	.validate((input) => input as MixedOrHookData)
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					or: [
						{
							where: [{ field: 'status', op: '=', value: 'missing' }],
							or: [
								{
									where: [{ field: 'status', op: '=', value: 'pending' }],
									or: [],
									sort: [],
									include: []
								}
							],
							sort: [],
							include: []
						}
					]
				}
			};
		},
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					or: [
						{
							where: [{ field: 'status', op: '=', value: 'missing' }],
							or: [
								{
									where: [{ field: 'status', op: '=', value: 'pending' }],
									or: [],
									sort: [],
									include: []
								}
							],
							sort: [],
							include: []
						}
					]
				}
			};
		}
	})
	.attach(NestedMixedOrHookRecord);

defineModel<MixedOrHookData>('hook_scoped_nested_public_or_record')
	.id('id')
	.validate((input) => input as MixedOrHookData)
	.scope('tenant', ({ viewer }) => ({ tenantId: (viewer as { tenantId: string }).tenantId }))
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			if (!plan.or?.[0]) return;
			return {
				plan: {
					...plan,
					or: [
						{
							...plan.or[0],
							or: [
								{
									where: [{ field: 'status', op: '=', value: 'pending' }],
									or: [],
									sort: [],
									include: []
								}
							]
						}
					]
				}
			};
		},
		beforeAggregate(payload) {
			const plan = payload.plan as any;
			if (!plan.or?.[0]) return;
			return {
				plan: {
					...plan,
					or: [
						{
							...plan.or[0],
							or: [
								{
									where: [{ field: 'status', op: '=', value: 'pending' }],
									or: [],
									sort: [],
									include: []
								}
							]
						}
					]
				}
			};
		}
	})
	.attach(ScopedNestedPublicOrHookRecord);

class TrackingStore extends MemoryStoreAdapter {
	queryCalls = 0;
	aggregateCalls = 0;

	override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
		this.queryCalls++;
		return await super.query(...args);
	}

	override async aggregate(...args: Parameters<NonNullable<MemoryStoreAdapter['aggregate']>>) {
		this.aggregateCalls++;
		return await super.aggregate!(...args);
	}
}

const NATIVE_PAYLOAD_STORE_CAPABILITIES = Object.freeze({
	...new MemoryStoreAdapter().capabilities,
	native: true
});

class NativePayloadStore extends MemoryStoreAdapter {
	override readonly capabilities = NATIVE_PAYLOAD_STORE_CAPABILITIES;
	nativePayloads: unknown[] = [];

	override async query(_model: ResolvedModelMeta, plan: any): Promise<QueryResult> {
		this.nativePayloads.push(plan.native?.payload);
		return {
			list: [{ id: 1, value: 1, label: plan.native?.payload?.label ?? 'missing' }],
			more: false,
			count: 1
		};
	}

	override async aggregate(_model: ResolvedModelMeta, plan: any): Promise<AggregateResult> {
		this.nativePayloads.push(plan.native?.payload);
		return { count: plan.native?.payload?.count ?? 0 };
	}
}

class TrackingSearch implements SearchAdapter {
	readonly kind = 'tracking-search';
	readonly capabilities = { where: true, cursor: false, native: false, index: false };
	searchCalls = 0;
	optionsSeen: Array<SearchOptions | undefined> = [];

	async search(_model: ResolvedModelMeta, _query: string, options?: SearchOptions): Promise<QueryResult> {
		this.searchCalls++;
		this.optionsSeen.push(options);
		return { list: [], more: false, count: 0 };
	}

	async index() {}
	async delete() {}
}

class NativeTrackingSearch implements SearchAdapter {
	readonly kind = 'native-tracking-search';
	readonly capabilities = { where: false, cursor: false, native: true, index: false };
	nativePayloads: unknown[] = [];

	async search(_model: ResolvedModelMeta, _query: string, options?: SearchOptions): Promise<QueryResult> {
		this.nativePayloads.push(options?.native);
		return {
			list: [{ id: 1, label: (options?.native as any)?.label ?? 'missing' }],
			more: false,
			count: 1
		};
	}

	async index() {}
	async delete() {}
}

class MalformedQueryStore extends TrackingStore {
	override async query(): Promise<QueryResult> {
		this.queryCalls++;
		return { list: null as any, more: false };
	}
}

class SparseQueryStore extends TrackingStore {
	override async query(): Promise<QueryResult> {
		this.queryCalls++;
		return { list: new Array(1) as any, more: false };
	}
}

class InheritedQueryResultStore extends TrackingStore {
	override async query(): Promise<QueryResult> {
		this.queryCalls++;
		return Object.create({ list: [], more: false }) as QueryResult;
	}
}

class InheritedAggregateResultStore extends TrackingStore {
	override async aggregate(): Promise<AggregateResult> {
		this.aggregateCalls++;
		return Object.create({ count: 99 }) as AggregateResult;
	}
}

class EmptyQueryResultStore extends TrackingStore {
	override async query(): Promise<QueryResult> {
		this.queryCalls++;
		return {} as QueryResult;
	}
}

class EmptyAggregateResultStore extends TrackingStore {
	override async aggregate(): Promise<AggregateResult> {
		this.aggregateCalls++;
		return {} as AggregateResult;
	}
}

class MalformedSearch implements SearchAdapter {
	readonly kind = 'malformed-search';
	readonly capabilities = { where: false, cursor: false, native: false, index: false };

	async search(): Promise<QueryResult> {
		return { list: null as any, more: false };
	}

	async index() {}
	async delete() {}
}

class SparseSearch implements SearchAdapter {
	readonly kind = 'sparse-search';
	readonly capabilities = { where: false, cursor: false, native: false, index: false };

	async search(): Promise<QueryResult> {
		return { list: new Array(1) as any, more: false };
	}

	async index() {}
	async delete() {}
}

class InheritedSearchResult implements SearchAdapter {
	readonly kind = 'inherited-search';
	readonly capabilities = { where: false, cursor: false, native: false, index: false };

	async search(): Promise<QueryResult> {
		return Object.create({ list: [], more: false }) as QueryResult;
	}

	async index() {}
	async delete() {}
}

class EmptySearchResult implements SearchAdapter {
	readonly kind = 'empty-search';
	readonly capabilities = { where: false, cursor: false, native: false, index: false };

	async search(): Promise<QueryResult> {
		return {} as QueryResult;
	}

	async index() {}
	async delete() {}
}

class ExtraQueryResultStore extends TrackingStore {
	override async query(): Promise<QueryResult> {
		this.queryCalls++;
		return { list: [{ id: 1, value: 1, label: 'one' }], more: false, totla: 1 } as any;
	}
}

class ExtraSearchResult implements SearchAdapter {
	readonly kind = 'extra-result-search';
	readonly capabilities = { where: false, cursor: false, native: false, index: false };

	async search(): Promise<QueryResult> {
		return { list: [{ id: 1, value: 1, label: 'one' }], more: false, totla: 1 } as any;
	}

	async index() {}
	async delete() {}
}

test('beforeQuery hooks cannot smuggle unsafe fields to store adapters', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = UnsafeQueryHookRecord.use(context) as unknown as typeof UnsafeQueryHookRecord;
	await store.seed('hook_unsafe_query_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(() => Record.query().load(), /Reserved query field/);
	assert.equal(store.queryCalls, 0);
});

test('beforeAggregate hooks cannot smuggle unsafe aggregate fields to store adapters', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = UnsafeAggregateHookRecord.use(context) as unknown as typeof UnsafeAggregateHookRecord;
	await store.seed('hook_unsafe_aggregate_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(() => Record.count(), /Reserved .*aggregate field/);
	assert.equal(store.aggregateCalls, 0);
	assert.equal(store.queryCalls, 0);
});

test('beforeSearch hooks cannot smuggle non-string queries to search adapters', async () => {
	const store = new TrackingStore();
	const search = new TrackingSearch();
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const Record = UnsafeSearchHookRecord.use(context) as unknown as typeof UnsafeSearchHookRecord;

	await assert.rejects(() => Record.search('one').load(), /Search query/);
	assert.equal(search.searchCalls, 0);
});

test('hook-mutated cursors are sanitized before adapters', async () => {
	const store = new TrackingStore();
	const search = new TrackingSearch();
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const QueryRecord = UnsafeQueryCursorHookRecord.use(context) as unknown as typeof UnsafeQueryCursorHookRecord;
	const SearchRecord = UnsafeSearchCursorHookRecord.use(context) as unknown as typeof UnsafeSearchCursorHookRecord;
	await store.seed('hook_unsafe_query_cursor_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(() => QueryRecord.query().load(), /query cursor must be a string/);
	await assert.rejects(() => SearchRecord.search('one').load(), /search cursor must be a string/);
	assert.equal(store.queryCalls, 0);
	assert.equal(search.searchCalls, 0);
});

test('hook-mutated plan and option containers are sanitized before adapters', async () => {
	const store = new TrackingStore();
	const search = new TrackingSearch();
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const QueryRecord = MalformedQueryPlanHookRecord.use(context) as unknown as typeof MalformedQueryPlanHookRecord;
	const AggregateRecord = MalformedAggregatePlanHookRecord.use(context) as unknown as typeof MalformedAggregatePlanHookRecord;
	const SearchRecord = MalformedSearchOptionsHookRecord.use(context) as unknown as typeof MalformedSearchOptionsHookRecord;
	const UnknownQueryRecord = UnknownQueryPlanHookRecord.use(context) as unknown as typeof UnknownQueryPlanHookRecord;
	const UnknownAggregateRecord = UnknownAggregatePlanHookRecord.use(context) as unknown as typeof UnknownAggregatePlanHookRecord;
	const UnknownSearchRecord = UnknownSearchOptionsHookRecord.use(context) as unknown as typeof UnknownSearchOptionsHookRecord;
	const QueryArrayRecord = MalformedQueryArrayHookRecord.use(context) as unknown as typeof MalformedQueryArrayHookRecord;
	const AggregateArrayRecord = MalformedAggregateArrayHookRecord.use(context) as unknown as typeof MalformedAggregateArrayHookRecord;
	const QueryMetaRecord = MalformedQueryMetaHookRecord.use(context) as unknown as typeof MalformedQueryMetaHookRecord;
	const HiddenQueryMetaRecord = HiddenQueryMetaHookRecord.use(context) as unknown as typeof HiddenQueryMetaHookRecord;
	const AggregateMetaRecord = MalformedAggregateMetaHookRecord.use(context) as unknown as typeof MalformedAggregateMetaHookRecord;

	await assert.rejects(() => QueryRecord.query().load(), /must be a plain object/);
	await assert.rejects(() => AggregateRecord.count(), /must be a plain object/);
	await assert.rejects(() => SearchRecord.search('one').load(), /must be a plain object/);
	await assert.rejects(() => UnknownQueryRecord.query().load(), /query plan contains unknown option "limt"/);
	await assert.rejects(() => UnknownAggregateRecord.count(), /aggregate plan contains unknown option "aggregats"/);
	await assert.rejects(() => UnknownSearchRecord.search('one').load(), /search options contains unknown option "limt"/);
	await assert.rejects(() => QueryArrayRecord.query().load(), /query where must be an array/);
	await assert.rejects(() => AggregateArrayRecord.count(), /Aggregate specs must be an array/);
	await assert.rejects(() => QueryMetaRecord.query().load(), /query meta must be a plain object/);
	await assert.rejects(() => HiddenQueryMetaRecord.query().load(), /meta\.softDelete must be enumerable/);
	await assert.rejects(() => AggregateMetaRecord.count(), /aggregate meta must be a plain object/);
	assert.equal(store.queryCalls, 0);
	assert.equal(store.aggregateCalls, 0);
	assert.equal(search.searchCalls, 0);
});

test('query and search result sanitizers reject unknown metadata keys', async () => {
	const queryStore = new ExtraQueryResultStore();
	const queryContext = createActiveTs({ stores: { default: queryStore } });
	const QueryRecord = InheritedSearchResultRecord.use(queryContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => QueryRecord.query().load(),
		/Store adapter "memory" query result contains unknown option "totla"/
	);
	assert.equal(queryStore.queryCalls, 1);

	const afterQueryStore = new TrackingStore();
	const afterQueryContext = createActiveTs({
		stores: { default: afterQueryStore },
		plugins: [
			{
				name: 'extra-after-query-result',
				hooks: {
					afterQuery(payload) {
						return { result: { ...(payload.result as QueryResult), totla: 1 } };
					}
				}
			}
		]
	});
	const AfterQueryRecord = InheritedSearchResultRecord.use(afterQueryContext) as unknown as typeof InheritedSearchResultRecord;
	await afterQueryStore.seed('hook_inherited_search_result_record', [{ id: 1, value: 1, label: 'one' }]);
	await assert.rejects(
		() => AfterQueryRecord.query().load(),
		/afterQuery result contains unknown option "totla"/
	);

	const search = new ExtraSearchResult();
	const searchContext = createActiveTs({
		stores: { default: new TrackingStore() },
		search: { default: search },
		defaultSearch: 'default'
	});
	const SearchRecord = InheritedSearchResultRecord.use(searchContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => SearchRecord.search('one').load(),
		/Search adapter "extra-result-search" search result contains unknown option "totla"/
	);

	const afterSearch = new TrackingSearch();
	const afterSearchContext = createActiveTs({
		stores: { default: new TrackingStore() },
		search: { default: afterSearch },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'extra-after-search-result',
				hooks: {
					afterSearch(payload) {
						return { result: { ...(payload.result as QueryResult), totla: 1 } };
					}
				}
			}
		]
	});
	const AfterSearchRecord = InheritedSearchResultRecord.use(afterSearchContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => AfterSearchRecord.search('one').load(),
		/afterSearch result contains unknown option "totla"/
	);
});

test('hook-mutated where entries must use own plain predicate fields', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({
		stores: { default: store }
	});
	const QueryRecord = InheritedQueryWhereHookRecord.use(context) as unknown as typeof InheritedQueryWhereHookRecord;
	const AggregateRecord = InheritedAggregateWhereHookRecord.use(context) as unknown as typeof InheritedAggregateWhereHookRecord;

	await assert.rejects(() => QueryRecord.query().load(), /query where\[0\] must be a plain object/);
	await assert.rejects(() => AggregateRecord.count(), /aggregate where\[0\] must be a plain object/);
	assert.equal(store.queryCalls, 0);
	assert.equal(store.aggregateCalls, 0);
});

test('hook-mutated query plan arrays are snapshotted without caller-controlled array methods', async () => {
	const store = new TrackingStore();
	let queryMapCalls = 0;
	let aggregateMapCalls = 0;
	const queryWhere = [{ field: 'label', op: '=', value: 'one' }] as any[];
	const aggregateWhere = [{ field: 'label', op: '=', value: 'one' }] as any[];
	Object.defineProperty(queryWhere, 'map', {
		value() {
			queryMapCalls++;
			throw new Error('custom query map should not run');
		}
	});
	Object.defineProperty(aggregateWhere, 'map', {
		value() {
			aggregateMapCalls++;
			throw new Error('custom aggregate map should not run');
		}
	});
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'array-method-plan',
				hooks: {
					beforeQuery(payload) {
						return { plan: { ...(payload.plan as any), where: queryWhere } };
					},
					beforeAggregate(payload) {
						return { plan: { ...(payload.plan as any), where: aggregateWhere } };
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [
		{ id: 1, value: 1, label: 'one' },
		{ id: 2, value: 2, label: 'two' }
	]);

	const result = await Record.query().load();
	const count = await Record.count();

	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
	assert.equal(count, 1);
	assert.equal(queryMapCalls, 0);
	assert.equal(aggregateMapCalls, 0);
});

test('hook-mutated query and aggregate plans reject empty OR branches', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'empty-or-branch',
				hooks: {
					beforeQuery(payload) {
						return {
							plan: {
								...(payload.plan as any),
								or: [{ where: [], or: [], sort: [], include: [] }]
							}
						};
					},
					beforeAggregate(payload) {
						return {
							plan: {
								...(payload.plan as any),
								or: [{ where: [], or: [], sort: [], include: [] }]
							}
						};
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(() => Record.query().load(), /query or branch requires at least one where condition/);
	await assert.rejects(() => Record.count(), /query or branch requires at least one where condition/);
	assert.equal(store.queryCalls, 0);
	assert.equal(store.aggregateCalls, 0);
});

test('hook-mutated plan, option, and result wrappers reject accessors and symbols', async () => {
	let getterCalls = 0;
	const queryStore = new TrackingStore();
	const queryContext = createActiveTs({
		stores: { default: queryStore },
		plugins: [
			{
				name: 'accessor-query-plan',
				hooks: {
					beforeQuery(payload) {
						const plan = { ...(payload.plan as any) };
						Object.defineProperty(plan, 'limit', {
							enumerable: true,
							get() {
								getterCalls++;
								return 1;
							}
						});
						return { plan };
					}
				}
			}
		]
	});
	const QueryRecord = InheritedSearchResultRecord.use(queryContext) as unknown as typeof InheritedSearchResultRecord;
	await queryStore.seed('hook_inherited_search_result_record', [{ id: 1, value: 1, label: 'one' }]);
	await assert.rejects(() => QueryRecord.query().load(), /plan.*limit must be a data property/);
	assert.equal(getterCalls, 0);
	assert.equal(queryStore.queryCalls, 0);

	const symbolStore = new TrackingStore();
	const symbolContext = createActiveTs({
		stores: { default: symbolStore },
		plugins: [
			{
				name: 'symbol-query-plan',
				hooks: {
					beforeQuery(payload) {
						return { plan: { ...(payload.plan as any), [Symbol('plan')]: true } };
					}
				}
			}
		]
	});
	const SymbolRecord = InheritedSearchResultRecord.use(symbolContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(() => SymbolRecord.query().load(), /plan.*symbol/);
	assert.equal(symbolStore.queryCalls, 0);

	const search = new TrackingSearch();
	const searchContext = createActiveTs({
		stores: { default: new TrackingStore() },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'accessor-search-options',
				hooks: {
					beforeSearch(payload) {
						const options = { ...(payload.options as SearchOptions) };
						Object.defineProperty(options, 'limit', {
							enumerable: true,
							get() {
								getterCalls++;
								return 1;
							}
						});
						return { options };
					}
				}
			}
		]
	});
	const SearchRecord = InheritedSearchResultRecord.use(searchContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(() => SearchRecord.search('one').load(), /options.*limit must be a data property/);
	assert.equal(getterCalls, 0);
	assert.equal(search.searchCalls, 0);

	const resultStore = new TrackingStore();
	const resultContext = createActiveTs({
		stores: { default: resultStore },
		plugins: [
			{
				name: 'accessor-query-result',
				hooks: {
					afterQuery(payload) {
						const result = { ...(payload.result as QueryResult) };
						Object.defineProperty(result, 'more', {
							enumerable: true,
							get() {
								getterCalls++;
								return false;
							}
						});
						return { result };
					}
				}
			}
		]
	});
	const ResultRecord = InheritedSearchResultRecord.use(resultContext) as unknown as typeof InheritedSearchResultRecord;
	await resultStore.seed('hook_inherited_search_result_record', [{ id: 1, value: 1, label: 'one' }]);
	await assert.rejects(() => ResultRecord.query().load(), /result.*more must be a data property/);
	assert.equal(getterCalls, 0);
	assert.equal(resultStore.queryCalls, 1);
});

test('beforeSearch hooks cannot mutate reusable builder options', async () => {
	const store = new TrackingStore();
	const search = new TrackingSearch();
	let mutated = false;
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'mutating-search-options',
				hooks: {
					beforeSearch(payload) {
						if (!mutated) {
							mutated = true;
							(payload.options as SearchOptions).limit = 1;
						}
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	const query = Record.search('one');

	await query.load();
	await query.load();

	assert.equal(search.optionsSeen[0]?.limit, 1);
	assert.equal(search.optionsSeen[1]?.limit, undefined);
});

test('beforeSearch hooks cannot silently drop undefined where filters', async () => {
	const store = new TrackingStore();
	const search = new TrackingSearch();
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'undefined-search-where',
				hooks: {
					beforeSearch(payload) {
						return {
							options: {
								...(payload.options as SearchOptions),
								where: { label: undefined }
							}
						};
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;

	await assert.rejects(
		() => Record.search('one').load(),
		/search where field "label" cannot be undefined/
	);
	assert.equal(search.searchCalls, 0);
});

test('beforeSearch hook where operands are snapshotted before adapters', async () => {
	const ids = [2];
	const search: SearchAdapter = {
		kind: 'mutating-search-where',
		capabilities: {
			where: true,
			whereOperators: { in: true },
			cursor: false,
			native: false,
			index: false
		},
		async search(_model, _query, options = {}) {
			const shape = options.where as any;
			shape.id[1][0] = 99;
			return { list: [{ id: 2, value: 2, label: 'two' }], more: false, count: 1 };
		},
		async index() {
			throw new Error('not used');
		},
		async delete() {
			throw new Error('not used');
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'search-where-snapshot',
				hooks: {
					beforeSearch(payload) {
						return {
							options: {
								...(payload.options as SearchOptions),
								where: { id: ['in', ids] }
							}
						};
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;

	const result = await Record.search('two').load();

	assert.deepEqual(result.list.map((item) => item.data.id), [2]);
	assert.deepEqual(ids, [2]);
});

test('beforeQuery hooks cannot mutate reusable builder plan entries', async () => {
	const store = new TrackingStore();
	let mutated = false;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'mutating-query-plan',
				hooks: {
					beforeQuery(payload) {
						if (mutated) return;
						mutated = true;
						(payload.plan as any).where[0].value = 'two';
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [
		{ id: 1, value: 1, label: 'one' },
		{ id: 2, value: 2, label: 'one' },
		{ id: 3, value: 3, label: 'two' }
	]);
	const query = Record.where({ label: 'one' });

	const first = await query.load();
	const second = await query.load();

	assert.deepEqual(first.list.map((item) => item.data.id), [3]);
	assert.deepEqual(second.list.map((item) => item.data.id), [1, 2]);
});

test('beforeAggregate hooks cannot mutate reusable builder plan entries', async () => {
	const store = new TrackingStore();
	let mutated = false;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'mutating-aggregate-plan',
				hooks: {
					beforeAggregate(payload) {
						if (mutated) return;
						mutated = true;
						(payload.plan as any).where[0].value = 'two';
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [
		{ id: 1, value: 1, label: 'one' },
		{ id: 2, value: 2, label: 'one' },
		{ id: 3, value: 3, label: 'two' }
	]);
	const query = Record.where({ label: 'one' });

	const first = await query.count();
	const second = await query.count();

	assert.equal(first, 1);
	assert.equal(second, 2);
});

test('store query adapters cannot mutate afterQuery plan payloads', async () => {
	class MutatingQueryPlanStore extends TrackingStore {
		override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
			const result = await super.query(...args);
			const plan = args[1] as any;
			plan.where[0].value = 'two';
			return result;
		}
	}
	const store = new MutatingQueryPlanStore();
	const plans: any[] = [];
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'capture-after-query-plan',
				hooks: {
					afterQuery(payload) {
						plans.push(payload.plan);
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [
		{ id: 1, value: 1, label: 'one' },
		{ id: 2, value: 2, label: 'one' },
		{ id: 3, value: 3, label: 'two' }
	]);

	const result = await Record.where({ label: 'one' }).load();

	assert.deepEqual(result.list.map((item) => item.data.id), [1, 2]);
	assert.equal(plans[0].where[0].value, 'one');
});

test('store aggregate adapters cannot mutate afterAggregate plan payloads', async () => {
	class MutatingAggregatePlanStore extends TrackingStore {
		override async aggregate(...args: Parameters<NonNullable<MemoryStoreAdapter['aggregate']>>) {
			const result = await super.aggregate(...args);
			const plan = args[1] as any;
			plan.where[0].value = 'two';
			plan.aggregates[0].as = 'mutated';
			return result;
		}
	}
	const store = new MutatingAggregatePlanStore();
	const plans: any[] = [];
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'capture-after-aggregate-plan',
				hooks: {
					afterAggregate(payload) {
						plans.push(payload.plan);
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [
		{ id: 1, value: 1, label: 'one' },
		{ id: 2, value: 2, label: 'one' },
		{ id: 3, value: 3, label: 'two' }
	]);

	const count = await Record.where({ label: 'one' }).count();

	assert.equal(count, 2);
	assert.equal(plans[0].where[0].value, 'one');
	assert.equal(plans[0].aggregates[0].as, 'count');
});

test('search adapters cannot mutate afterSearch option payloads', async () => {
	class MutatingSearchOptions extends TrackingSearch {
		override readonly capabilities = {
			where: true,
			whereOperators: { '=': true },
			cursor: false,
			native: false,
			index: false
		};

		override async search(_model: ResolvedModelMeta, _query: string, options?: SearchOptions): Promise<QueryResult> {
			const result = { list: [{ id: 1, value: 1, label: 'one' }], more: false, count: 1 };
			(options!.where as any).id = 2;
			return result;
		}
	}
	const search = new MutatingSearchOptions();
	const optionsSeen: SearchOptions[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'capture-after-search-options',
				hooks: {
					afterSearch(payload) {
						optionsSeen.push(payload.options as SearchOptions);
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;

	const result = await Record.search('one').where({ id: 1 }).load();

	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
	assert.deepEqual(optionsSeen[0].where, { id: 1 });
});

test('beforeQuery and beforeSearch hooks cannot mutate reusable native payloads', async () => {
	let queryMutated = false;
	const store = new NativePayloadStore();
	const queryContext = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'mutating-native-query-payload',
				hooks: {
					beforeQuery(payload) {
						if (queryMutated) return;
						queryMutated = true;
						(payload.plan as any).native.payload.label = 'two';
					}
				}
			}
		]
	});
	const QueryRecord = InheritedSearchResultRecord.use(queryContext) as unknown as typeof InheritedSearchResultRecord;
	const query = QueryRecord.query().native({ label: 'one' });

	assert.deepEqual((await query.load()).list.map((item) => item.data.label), ['two']);
	assert.deepEqual((await query.load()).list.map((item) => item.data.label), ['one']);
	const callerQueryPayload = { label: 'one' };
	const callerQuery = QueryRecord.query().native(callerQueryPayload);
	callerQueryPayload.label = 'two';
	assert.deepEqual((await callerQuery.load()).list.map((item) => item.data.label), ['one']);

	let aggregateMutated = false;
	const aggregateStore = new NativePayloadStore();
	const aggregateContext = createActiveTs({
		stores: { default: aggregateStore },
		plugins: [
			{
				name: 'mutating-native-aggregate-payload',
				hooks: {
					beforeAggregate(payload) {
						if (aggregateMutated) return;
						aggregateMutated = true;
						(payload.plan as any).native.payload.count = 2;
					}
				}
			}
		]
	});
	const AggregateRecord = InheritedSearchResultRecord.use(aggregateContext) as unknown as typeof InheritedSearchResultRecord;
	const aggregate = AggregateRecord.query().native({ count: 1 });

	assert.equal(await aggregate.count(), 2);
	assert.equal(await aggregate.count(), 1);
	const callerAggregatePayload = { count: 1 };
	const callerAggregate = AggregateRecord.query().native(callerAggregatePayload);
	callerAggregatePayload.count = 2;
	assert.equal(await callerAggregate.count(), 1);

	let searchMutated = false;
	const search = new NativeTrackingSearch();
	const searchContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'mutating-native-search-payload',
				hooks: {
					beforeSearch(payload) {
						if (searchMutated) return;
						searchMutated = true;
						(payload.options as any).native.label = 'two';
					}
				}
			}
		]
	});
	const SearchRecord = InheritedSearchResultRecord.use(searchContext) as unknown as typeof InheritedSearchResultRecord;
	const searchQuery = SearchRecord.search('ignored').native({ label: 'one' });

	assert.deepEqual((await searchQuery.load()).list.map((item) => item.data.label), ['two']);
	assert.deepEqual((await searchQuery.load()).list.map((item) => item.data.label), ['one']);
	const callerSearchPayload = { label: 'one' };
	const callerSearchQuery = SearchRecord.search('ignored').native(callerSearchPayload);
	callerSearchPayload.label = 'two';
	assert.deepEqual((await callerSearchQuery.load()).list.map((item) => item.data.label), ['one']);
});

test('hook-mutated native query and aggregate plans are sanitized before adapters', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const QueryRecord = MalformedQueryNativeHookRecord.use(context) as unknown as typeof MalformedQueryNativeHookRecord;
	const AggregateRecord = MalformedAggregateNativeHookRecord.use(context) as unknown as typeof MalformedAggregateNativeHookRecord;
	const UnsafeAdapterRecord = UnsafeNativeAdapterHookRecord.use(context) as unknown as typeof UnsafeNativeAdapterHookRecord;

	await assert.rejects(() => QueryRecord.query().load(), /query native must be a plain object/);
	await assert.rejects(() => AggregateRecord.count(), /aggregate native\.payload is required/);
	await assert.rejects(() => UnsafeAdapterRecord.query().load(), /query native\.adapter "__proto__" is not allowed/);
	assert.equal(store.queryCalls, 0);
	assert.equal(store.aggregateCalls, 0);
});

test('hook-mutated where entries reject value2 on non-between operators before adapters', async () => {
	const queryStore = new TrackingStore();
	const queryContext = createActiveTs({
		stores: { default: queryStore },
		plugins: [
			{
				name: 'extra-query-value2',
				hooks: {
					beforeQuery(payload) {
						const plan = payload.plan as any;
						return {
							plan: {
								...plan,
								where: [{ field: 'label', op: '=', value: 'one', value2: 'two' }]
							}
						};
					}
				}
			}
		]
	});
	const QueryRecord = InheritedSearchResultRecord.use(queryContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => QueryRecord.query().load(),
		/Query operator "=" on "label" does not accept value2/
	);
	assert.equal(queryStore.queryCalls, 0);

	const aggregateStore = new TrackingStore();
	const aggregateContext = createActiveTs({
		stores: { default: aggregateStore },
		plugins: [
			{
				name: 'extra-aggregate-value2',
				hooks: {
					beforeAggregate(payload) {
						const plan = payload.plan as any;
						return {
							plan: {
								...plan,
								where: [{ field: 'label', op: 'isNull', value: undefined, value2: undefined }]
							}
						};
					}
				}
			}
		]
	});
	const AggregateRecord = InheritedSearchResultRecord.use(aggregateContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => AggregateRecord.count(),
		/Query operator "isNull" on "label" does not accept value2/
	);
	assert.equal(aggregateStore.aggregateCalls, 0);
});

test('hook result containers reject prototype keys before payload merge', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = UnsafeHookResultRecord.use(context) as unknown as typeof UnsafeHookResultRecord;

	await assert.rejects(
		() => Record.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook result key "__proto__" is not allowed/.test(error.message)
	);
	assert.equal(({} as any).polluted, undefined);
	assert.equal(store.queryCalls, 0);
});

test('hook result containers reject unknown payload keys', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'unknown-hook-result-key',
				hooks: {
					beforeQuery() {
						return { plna: null } as any;
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;

	await assert.rejects(
		() => Record.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook result key "plna" is not recognized/.test(error.message)
	);
	assert.equal(store.queryCalls, 0);
});

test('hook result containers reject accessor payload keys without invoking them', async () => {
	const store = new TrackingStore();
	let resultReads = 0;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'accessor-hook-result',
				hooks: {
					beforeQuery(payload) {
						return Object.defineProperty({}, 'plan', {
							enumerable: true,
							get() {
								resultReads++;
								return payload.plan;
							}
						}) as any;
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;

	await assert.rejects(
		() => Record.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook result key "plan" must be a data property/.test(error.message)
	);
	assert.equal(resultReads, 0);
	assert.equal(store.queryCalls, 0);
});

test('hook result containers reject non-enumerable payload keys', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'hidden-hook-result',
				hooks: {
					beforeQuery(payload) {
						return Object.defineProperty({}, 'plan', {
							enumerable: false,
							value: payload.plan
						}) as any;
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;

	await assert.rejects(
		() => Record.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook result key "plan" must be enumerable/.test(error.message)
	);
	assert.equal(store.queryCalls, 0);
});

test('hook result nested payloads reject before later hooks observe them', async () => {
	let getterCalls = 0;
	let laterHookCalls = 0;
	const queryStore = new TrackingStore();
	const queryContext = createActiveTs({
		stores: { default: queryStore },
		plugins: [
			{
				name: 'nested-query-accessor',
				hooks: {
					beforeQuery(payload) {
						const predicate = Object.defineProperty({ field: 'label', op: '=' }, 'value', {
							enumerable: true,
							get() {
								getterCalls++;
								return 'one';
							}
						});
						return { plan: { ...(payload.plan as any), where: [predicate] } };
					}
				}
			},
			{
				name: 'later-query-observer',
				hooks: {
					beforeQuery() {
						laterHookCalls++;
					}
				}
			}
		]
	});
	const QueryRecord = InheritedSearchResultRecord.use(queryContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => QueryRecord.query().load(),
		/Hook result key "plan"\.where\[0\]\.value must be a data property/
	);
	assert.equal(getterCalls, 0);
	assert.equal(laterHookCalls, 0);
	assert.equal(queryStore.queryCalls, 0);

	const search = new TrackingSearch();
	const searchContext = createActiveTs({
		stores: { default: new TrackingStore() },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'nested-search-hidden',
				hooks: {
					beforeSearch(payload) {
						const predicate = { field: 'label', op: '=', value: 'one' };
						Object.defineProperty(predicate, 'value', { enumerable: false, value: 'hidden' });
						return { options: { ...(payload.options as SearchOptions), where: [predicate] } };
					}
				}
			},
			{
				name: 'later-search-observer',
				hooks: {
					beforeSearch() {
						laterHookCalls++;
					}
				}
			}
		]
	});
	const SearchRecord = InheritedSearchResultRecord.use(searchContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => SearchRecord.search('one').load(),
		/Hook result key "options"\.where\[0\]\.value must be enumerable/
	);
	assert.equal(laterHookCalls, 0);
	assert.equal(search.searchCalls, 0);

	const cacheData = Object.defineProperty({ value: 'cached' }, 'nested', {
		enumerable: true,
		get() {
			getterCalls++;
			return true;
		}
	});
	const cacheContext = createActiveTs({
		stores: { default: new TrackingStore() },
		plugins: [
			{
				name: 'nested-cache-accessor',
				hooks: {
					beforeCacheSet() {
						return { data: cacheData };
					}
				}
			},
			{
				name: 'later-cache-observer',
				hooks: {
					beforeCacheSet() {
						laterHookCalls++;
					}
				}
			}
		]
	});
	await assert.rejects(
		() => cacheContext.runHooks('beforeCacheSet', {
			id: 'cache-key',
			data: { value: 'original' },
			operation: 'function-cache',
			meta: { prefix: 'hook-regression', key: 'cache-key' }
		}),
		/Hook result key "data"\.nested must be a data property/
	);
	assert.equal(getterCalls, 0);
	assert.equal(laterHookCalls, 0);

	const resultStore = new TrackingStore();
	const resultContext = createActiveTs({
		stores: { default: resultStore },
		plugins: [
			{
				name: 'nested-result-array',
				hooks: {
					afterQuery(payload) {
						const result = { ...(payload.result as QueryResult) };
						const list = [...(result.list ?? [])];
						Object.defineProperty(list, '0', { enumerable: false, value: list[0] });
						return { result: { ...result, list } };
					}
				}
			},
			{
				name: 'later-result-observer',
				hooks: {
					afterQuery() {
						laterHookCalls++;
					}
				}
			}
		]
	});
	const ResultRecord = InheritedSearchResultRecord.use(resultContext) as unknown as typeof InheritedSearchResultRecord;
	await resultStore.seed('hook_inherited_search_result_record', [{ id: 1, value: 1, label: 'one' }]);
	await assert.rejects(
		() => ResultRecord.query().load(),
		/Hook result key "result"\.list\[0\] must be enumerable/
	);
	assert.equal(laterHookCalls, 0);
	assert.equal(resultStore.queryCalls, 1);
});

test('hook payload containers reject accessor keys without invoking them', async () => {
	const context = createActiveTs({ stores: { default: new TrackingStore() } });
	let payloadReads = 0;
	const accessorPayload = Object.defineProperty({ operation: 'query' }, 'plan', {
		enumerable: true,
		get() {
			payloadReads++;
			return { where: [], or: [], sort: [], include: [] };
		}
	});

	await assert.rejects(
		() => context.runHooks('beforeQuery', accessorPayload as any),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook payload key "plan" must be a data property/.test(error.message)
	);
	assert.equal(payloadReads, 0);
	const hiddenPayload = Object.defineProperty({ operation: 'query' }, 'plan', {
		enumerable: false,
		value: { where: [], or: [], sort: [], include: [] }
	});
	await assert.rejects(
		() => context.runHooks('beforeQuery', hiddenPayload as any),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook payload key "plan" must be enumerable/.test(error.message)
	);
	await assert.rejects(
		() => context.runHooks('beforeQuery', { operation: 'query', [Symbol('payload')]: true } as any),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook payload cannot contain symbol keys/.test(error.message)
	);
});

test('hook payload and result merges shadow inherited non-writable payload keys', async () => {
	Object.defineProperty(Object.prototype, 'plan', {
		value: 'polluted-plan',
		writable: false,
		configurable: true
	});
	try {
		const context = createActiveTs({ stores: { default: new TrackingStore() } });
		const inputPlan = { where: [], or: [], sort: [], include: [] };
		const direct = await context.runHooks('beforeQuery', { operation: 'query', plan: inputPlan });
		assert.equal(direct.plan, inputPlan);

		const mergeContext = createActiveTs({
			stores: { default: new TrackingStore() },
			plugins: [
				{
					name: 'replace-plan-under-polluted-prototype',
					hooks: {
						beforeQuery() {
							return { plan: { where: [], or: [], sort: [], include: [], limit: 1 } as any };
						}
					}
				}
			]
		});
		const merged = await mergeContext.runHooks('beforeQuery', { operation: 'query' });
		assert.equal((merged.plan as any).limit, 1);

		const mutateContext = createActiveTs({
			stores: { default: new TrackingStore() },
			plugins: [
				{
					name: 'mutate-plan-under-polluted-prototype',
					hooks: {
						beforeQuery(payload) {
							(payload as any).plan = { where: [], or: [], sort: [], include: [], limit: 2 };
						}
					}
				}
			]
		});
		const mutated = await mutateContext.runHooks('beforeQuery', { operation: 'query' });
		assert.equal((mutated.plan as any).limit, 2);
	} finally {
		delete (Object.prototype as Record<string, unknown>).plan;
	}
});

test('hook payload model hooks reject accessors without invoking them', async () => {
	const context = createActiveTs({ stores: { default: new TrackingStore() } });
	let hookReads = 0;
	const accessorModel = Object.defineProperty({ name: 'accessor_hook_payload_model' }, 'hooks', {
		enumerable: true,
		get() {
			hookReads++;
			return {};
		}
	});

	await assert.rejects(
		() => context.runHooks('beforeQuery', {
			operation: 'query',
			model: accessorModel as any,
			plan: { where: [], or: [], sort: [], include: [] }
		}),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Hook payload model\.hooks must be a data property/.test(error.message)
	);
	assert.equal(hookReads, 0);

	let hookListReads = 0;
	const accessorHooks = Object.defineProperty({}, 'beforeQuery', {
		enumerable: true,
		get() {
			hookListReads++;
			return [];
		}
	});

	await assert.rejects(
		() => context.runHooks('beforeQuery', {
			operation: 'query',
			model: { name: 'accessor_hook_payload_model', hooks: accessorHooks } as any,
			plan: { where: [], or: [], sort: [], include: [] }
		}),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Hook payload model\.hooks\.beforeQuery must be a data property/.test(error.message)
	);
	assert.equal(hookListReads, 0);
});

test('hooks cannot directly mutate payload immutable keys or install accessors', async () => {
	const immutableStore = new TrackingStore();
	const immutableContext = createActiveTs({
		stores: { default: immutableStore },
		plugins: [
			{
				name: 'direct-immutable-payload-mutation',
				hooks: {
					beforeQuery(payload) {
						(payload as any).model = { name: 'mutated_model', hooks: {} };
					}
				}
			}
		]
	});
	const ImmutableRecord = InheritedSearchResultRecord.use(immutableContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => ImmutableRecord.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook payload key "model" cannot replace immutable payload metadata/.test(error.message)
	);
	assert.equal(immutableStore.queryCalls, 0);

	const accessorStore = new TrackingStore();
	let planReads = 0;
	const accessorContext = createActiveTs({
		stores: { default: accessorStore },
		plugins: [
			{
				name: 'direct-accessor-payload-mutation',
				hooks: {
					beforeQuery(payload) {
						Object.defineProperty(payload, 'plan', {
							enumerable: true,
							configurable: true,
							get() {
								planReads++;
								return { where: [], or: [], sort: [], include: [] };
							}
						});
					}
				}
			}
		]
	});
	const AccessorRecord = InheritedSearchResultRecord.use(accessorContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => AccessorRecord.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook payload key "plan" must be a data property/.test(error.message)
	);
	assert.equal(planReads, 0);
	assert.equal(accessorStore.queryCalls, 0);

	const hiddenStore = new TrackingStore();
	const hiddenContext = createActiveTs({
		stores: { default: hiddenStore },
		plugins: [
			{
				name: 'direct-hidden-payload-mutation',
				hooks: {
					beforeQuery(payload) {
						Object.defineProperty(payload, 'plan', {
							enumerable: false,
							configurable: true,
							value: payload.plan
						});
					}
				}
			}
		]
	});
	const HiddenRecord = InheritedSearchResultRecord.use(hiddenContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => HiddenRecord.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook payload key "plan" must be enumerable/.test(error.message)
	);
	assert.equal(hiddenStore.queryCalls, 0);
});

test('hook results and direct payload mutations reject non-enumerable symbols', async () => {
	const resultSymbolStore = new TrackingStore();
	const resultSymbol = Symbol('hook-result');
	const resultSymbolContext = createActiveTs({
		stores: { default: resultSymbolStore },
		plugins: [
			{
				name: 'non-enumerable-result-symbol',
				hooks: {
					beforeQuery() {
						return Object.defineProperty({}, resultSymbol, {
							value: true,
							enumerable: false
						}) as any;
					}
				}
			}
		]
	});
	const ResultSymbolRecord = InheritedSearchResultRecord.use(resultSymbolContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => ResultSymbolRecord.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook result cannot contain symbol keys/.test(error.message)
	);
	assert.equal(resultSymbolStore.queryCalls, 0);

	const payloadSymbolStore = new TrackingStore();
	const payloadSymbol = Symbol('hook-payload');
	const payloadSymbolContext = createActiveTs({
		stores: { default: payloadSymbolStore },
		plugins: [
			{
				name: 'non-enumerable-payload-symbol',
				hooks: {
					beforeQuery(payload) {
						Object.defineProperty(payload, payloadSymbol, {
							value: true,
							enumerable: false
						});
					}
				}
			}
		]
	});
	const PayloadSymbolRecord = InheritedSearchResultRecord.use(payloadSymbolContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => PayloadSymbolRecord.query().load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Hook payload cannot contain symbol keys/.test(error.message)
	);
	assert.equal(payloadSymbolStore.queryCalls, 0);
});

test('result-mutating hooks are sanitized before returning to callers', async () => {
	const store = new TrackingStore();
	const search = new TrackingSearch();
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const QueryRecord = UnsafeAfterQueryHookRecord.use(context) as unknown as typeof UnsafeAfterQueryHookRecord;
	const AggregateRecord = UnsafeAfterAggregateHookRecord.use(context) as unknown as typeof UnsafeAfterAggregateHookRecord;
	const SearchRecord = UnsafeAfterSearchHookRecord.use(context) as unknown as typeof UnsafeAfterSearchHookRecord;
	const IteratorQueryRecord = IteratorAfterQueryHookRecord.use(context) as unknown as typeof IteratorAfterQueryHookRecord;
	const IteratorSearchRecord = IteratorAfterSearchHookRecord.use(context) as unknown as typeof IteratorAfterSearchHookRecord;
	await store.seed('hook_unsafe_after_query_record', [{ id: 1, value: 1, label: 'one' }]);
	await store.seed('hook_unsafe_after_aggregate_record', [{ id: 1, value: 1, label: 'one' }]);
	await store.seed('hook_iterator_after_query_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(() => QueryRecord.query().load(), /afterQuery result\.list/);
	await assert.rejects(() => AggregateRecord.count(), /afterAggregate "count"/);
	await assert.rejects(() => SearchRecord.search('one').load(), /afterSearch result cursor/);
	afterQueryListIteratorCalls = 0;
	await assert.rejects(
		() => IteratorQueryRecord.query().load(),
		/result.*list cannot contain symbol fields/
	);
	assert.equal(afterQueryListIteratorCalls, 0);
	afterSearchListIteratorCalls = 0;
	await assert.rejects(
		() => IteratorSearchRecord.search('one').load(),
		/result.*list cannot contain symbol fields/
	);
	assert.equal(afterSearchListIteratorCalls, 0);
});

test('post-instantiation hooks cannot change returned model ids', async () => {
	const store = new TrackingStore();
	const search: SearchAdapter = {
		kind: 'id-mutating-search',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({
			list: [{ id: 1, value: 1, label: 'one' }],
			more: false,
			count: 1
		}),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const CreateRecord = MutatingAfterCreateIdRecord.use(context) as unknown as typeof MutatingAfterCreateIdRecord;
	const UpdateRecord = MutatingAfterUpdateIdRecord.use(context) as unknown as typeof MutatingAfterUpdateIdRecord;
	const QueryRecord = MutatingAfterQueryIdRecord.use(context) as unknown as typeof MutatingAfterQueryIdRecord;
	const SearchRecord = MutatingAfterSearchIdRecord.use(context) as unknown as typeof MutatingAfterSearchIdRecord;
	await store.seed('hook_after_update_id_record', [{ id: 1, value: 1, label: 'one' }]);
	await store.seed('hook_after_query_id_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(
		() => CreateRecord.create({ id: 1, value: 1, label: 'one' }),
		/Post-write create side effect failed.*afterCreate target cannot change hook_after_create_id_record\.id/
	);
	await assert.rejects(
		() => UpdateRecord.update(1, { label: 'updated' }),
		/Post-write update side effect failed.*afterUpdate target cannot change hook_after_update_id_record\.id/
	);
	await assert.rejects(
		() => QueryRecord.query().load(),
		/afterQuery result\.list item cannot change hook_after_query_id_record\.id/
	);
	await assert.rejects(
		() => SearchRecord.search('one').load(),
		/afterSearch result\.list item cannot change hook_after_search_id_record\.id/
	);
});

test('post-write hooks cannot change committed model data', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const AfterCreate = MutatingAfterCreateDataRecord.use(context) as unknown as typeof MutatingAfterCreateDataRecord;
	const AfterInstantiate = MutatingAfterCreateInstantiateDataRecord.use(context) as unknown as typeof MutatingAfterCreateInstantiateDataRecord;
	const AfterUpdate = MutatingAfterUpdateDataRecord.use(context) as unknown as typeof MutatingAfterUpdateDataRecord;

	await assert.rejects(
		() => AfterCreate.create({ id: 1, value: 1, label: 'committed-create' }),
		/Post-write create side effect failed.*afterCreate target cannot change committed hook_after_create_data_record data/
	);
	assert.equal((await AfterCreate.find(1).load())?.data.label, 'committed-create');

	await assert.rejects(
		() => AfterInstantiate.create({ id: 2, value: 2, label: 'committed-instantiate' }),
		/Post-write create side effect failed.*afterCreate target cannot change committed hook_after_create_instantiate_data_record data/
	);
	assert.equal((await AfterInstantiate.find(2).load())?.data.label, 'committed-instantiate');

	await store.seed('hook_after_update_data_record', [{ id: 3, value: 3, label: 'before-update' }]);
	await assert.rejects(
		() => AfterUpdate.update(3, { label: 'committed-update' }),
		/Post-write update side effect failed.*afterUpdate target cannot change committed hook_after_update_data_record data/
	);
	assert.equal((await AfterUpdate.find(3).load())?.data.label, 'committed-update');
});

test('result hooks cannot duplicate original model instances', async () => {
	const store = new MemoryStoreAdapter();
	const search: SearchAdapter = {
		kind: 'duplicate-hook-search',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({
			list: [{ id: 1, value: 1, label: 'one' }],
			more: false,
			count: 1
		}),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const QueryRecord = DuplicateAfterQueryResultRecord.use(context) as unknown as typeof DuplicateAfterQueryResultRecord;
	const SearchRecord = DuplicateAfterSearchResultRecord.use(context) as unknown as typeof DuplicateAfterSearchResultRecord;
	await store.seed('hook_duplicate_after_query_result_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(
		() => QueryRecord.query().load(),
		/afterQuery result\.list cannot contain duplicate model instances/
	);
	await assert.rejects(
		() => SearchRecord.search('one').load(),
		/afterSearch result\.list cannot contain duplicate model instances/
	);
});

test('result hooks cannot override returned page count', async () => {
	const store = new TrackingStore();
	const search: SearchAdapter = {
		kind: 'count-overriding-search',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({
			list: [{ id: 1, label: 'one' }],
			more: false,
			count: 999,
			total: 999
		}),
		index: async () => {},
		delete: async () => {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'count-overrider',
				hooks: {
					afterQuery(payload) {
						return { result: { ...(payload.result as QueryResult), count: 999, total: 123 } };
					},
					afterSearch(payload) {
						return { result: { ...(payload.result as QueryResult), count: 999, total: 123 } };
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [
		{ id: 1, value: 1, label: 'one' },
		{ id: 2, value: 2, label: 'two' }
	]);

	const query = await Record.query().orderBy('id').load();
	assert.equal(query.list.length, 2);
	assert.equal(query.count, 2);
	assert.equal(query.total, 123);

	const searched = await Record.search('one').load();
	assert.equal(searched.list.length, 1);
	assert.equal(searched.count, 1);
	assert.equal(searched.total, 123);
});

test('result hook totals must be safe integers', async () => {
	const store = new TrackingStore();
	const search: SearchAdapter = {
		kind: 'fractional-total-hook-search',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({
			list: [{ id: 1, label: 'one' }],
			more: false,
			count: 1,
			total: 1
		}),
		index: async () => {},
		delete: async () => {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'fractional-total-hook',
				hooks: {
					afterQuery(payload) {
						return { result: { ...(payload.result as QueryResult), total: 1.5 } };
					},
					afterSearch(payload) {
						return { result: { ...(payload.result as QueryResult), total: 1.5 } };
					}
				}
			}
		]
	});
	const Record = InheritedSearchResultRecord.use(context) as unknown as typeof InheritedSearchResultRecord;
	await store.seed('hook_inherited_search_result_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(() => Record.query().load(), /afterQuery result\.total must be a non-negative safe integer/);
	await assert.rejects(() => Record.search('one').load(), /afterSearch result\.total must be a non-negative safe integer/);
});

test('adapter query and search results are sanitized before model instantiation', async () => {
	const store = new MalformedQueryStore();
	const search = new MalformedSearch();
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const QueryRecord = MixedOrHookRecord.use(context) as unknown as typeof MixedOrHookRecord;
	const SearchRecord = UnsafeAfterSearchHookRecord.use(context) as unknown as typeof UnsafeAfterSearchHookRecord;

	await assert.rejects(() => QueryRecord.query().load(), /Store adapter "memory" query result\.list/);
	await assert.rejects(() => SearchRecord.search('one').load(), /Search adapter "malformed-search" search result\.list/);

	const sparseStore = new SparseQueryStore();
	const sparseSearch = new SparseSearch();
	const sparseContext = createActiveTs({
		stores: { default: sparseStore },
		search: { default: sparseSearch },
		defaultSearch: 'default'
	});
	const SparseQueryRecord = MixedOrHookRecord.use(sparseContext) as unknown as typeof MixedOrHookRecord;
	const SparseSearchRecord = UnsafeAfterSearchHookRecord.use(sparseContext) as unknown as typeof UnsafeAfterSearchHookRecord;
	await assert.rejects(() => SparseQueryRecord.query().load(), /Store adapter "memory" query result\.list\[0\] is missing/);
	await assert.rejects(
		() => SparseSearchRecord.search('one').load(),
		/Search adapter "sparse-search" search result\.list\[0\] is missing/
	);
});

test('adapter result sanitizers do not accept inherited result fields', async () => {
	const queryStore = new InheritedQueryResultStore();
	const queryContext = createActiveTs({ stores: { default: queryStore } });
	const QueryRecord = MixedOrHookRecord.use(queryContext) as unknown as typeof MixedOrHookRecord;
	await assert.rejects(() => QueryRecord.query().load(), /Store adapter "memory" query result must be a plain object/);

	const aggregateStore = new InheritedAggregateResultStore();
	const aggregateContext = createActiveTs({ stores: { default: aggregateStore } });
	const AggregateRecord = MixedOrHookRecord.use(aggregateContext) as unknown as typeof MixedOrHookRecord;
	await assert.rejects(() => AggregateRecord.count(), /Store adapter "memory" aggregate result must be a plain object/);

	const search = new InheritedSearchResult();
	const searchContext = createActiveTs({
		stores: { default: new TrackingStore() },
		search: { default: search },
		defaultSearch: 'default'
	});
	const SearchRecord = InheritedSearchResultRecord.use(searchContext) as unknown as typeof InheritedSearchResultRecord;
	await assert.rejects(
		() => SearchRecord.search('one').load(),
		/Search adapter "inherited-search" search result must be a plain object/
	);
});

test('adapter result sanitizers ignore Object.prototype result fields', async () => {
	Object.defineProperties(Object.prototype, {
		list: { value: [], configurable: true },
		more: { value: false, configurable: true },
		count: { value: 99, configurable: true }
	});
	try {
		const queryStore = new EmptyQueryResultStore();
		const queryContext = createActiveTs({ stores: { default: queryStore } });
		const QueryRecord = MixedOrHookRecord.use(queryContext) as unknown as typeof MixedOrHookRecord;
		await assert.rejects(() => QueryRecord.query().load(), /Store adapter "memory" query result\.list/);

		const aggregateStore = new EmptyAggregateResultStore();
		const aggregateContext = createActiveTs({ stores: { default: aggregateStore } });
		const AggregateRecord = MixedOrHookRecord.use(aggregateContext) as unknown as typeof MixedOrHookRecord;
		assert.equal(await AggregateRecord.count(), 0);

		const search = new EmptySearchResult();
		const searchContext = createActiveTs({
			stores: { default: new TrackingStore() },
			search: { default: search },
			defaultSearch: 'default'
		});
		const SearchRecord = InheritedSearchResultRecord.use(searchContext) as unknown as typeof InheritedSearchResultRecord;
		await assert.rejects(() => SearchRecord.search('one').load(), /Search adapter "empty-search" search result\.list/);
	} finally {
		delete (Object.prototype as any).list;
		delete (Object.prototype as any).more;
		delete (Object.prototype as any).count;
	}
});

test('afterInstantiate mutations are revalidated before returning models', async () => {
	const idStore = new MemoryStoreAdapter();
	const idContext = createActiveTs({ stores: { default: idStore } });
	const IdRecord = MutatingAfterInstantiateIdRecord.use(idContext) as unknown as typeof MutatingAfterInstantiateIdRecord;
	await idStore.seed('hook_after_instantiate_id_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(
		() => IdRecord.find(1).load(),
		/afterInstantiate hook cannot change hook_after_instantiate_id_record\.id/
	);

	const dataStore = new MemoryStoreAdapter();
	const dataContext = createActiveTs({ stores: { default: dataStore } });
	const DataRecord = MutatingAfterInstantiateDataRecord.use(dataContext) as unknown as typeof MutatingAfterInstantiateDataRecord;
	await dataStore.seed('hook_after_instantiate_data_record', [{ id: 1, value: 1, label: 'one' }]);

	await assert.rejects(
		() => DataRecord.query().load(),
		/Reserved data key/
	);
});

test('hook-mutated mixed where and or plans keep global constraints in every branch', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = MixedOrHookRecord.use(context) as unknown as typeof MixedOrHookRecord;
	await store.seed('hook_mixed_or_record', [
		{ id: 1, tenantId: 'a', status: 'open' },
		{ id: 2, tenantId: 'b', status: 'open' },
		{ id: 3, tenantId: 'b', status: 'pending' },
		{ id: 4, tenantId: 'a', status: 'pending' }
	]);

	const result = await Record.query().orderBy('id').load();
	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
});

test('hook-mutated nested OR plans keep user constraints in every leaf branch', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = NestedMixedOrHookRecord.use(context) as unknown as typeof NestedMixedOrHookRecord;
	await store.seed('hook_nested_mixed_or_record', [
		{ id: 1, tenantId: 'a', status: 'open' },
		{ id: 2, tenantId: 'b', status: 'pending' },
		{ id: 3, tenantId: 'a', status: 'pending' },
		{ id: 4, tenantId: 'b', status: 'missing' }
	]);

	const result = await Record.query().where({ tenantId: 'a' }).orderBy('id').load();
	const count = await Record.query().where({ tenantId: 'a' }).count();

	assert.deepEqual(result.list.map((item) => item.data.id), [3]);
	assert.equal(count, 1);
});

test('hook-added nested OR branches under public whereAny keep scoped constraints', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ScopedNestedPublicOrHookRecord.use(context) as unknown as typeof ScopedNestedPublicOrHookRecord;
	await store.seed('hook_scoped_nested_public_or_record', [
		{ id: 1, tenantId: 'a', status: 'missing' },
		{ id: 2, tenantId: 'b', status: 'pending' },
		{ id: 3, tenantId: 'a', status: 'pending' },
		{ id: 4, tenantId: 'b', status: 'missing' }
	]);

	const query = await Record.scope('tenant', { tenantId: 'a' })
		.whereAny({ status: 'missing' })
		.orderBy('id')
		.load();
	const count = await Record.scope('tenant', { tenantId: 'a' })
		.whereAny({ status: 'missing' })
		.count();

	assert.deepEqual(query.list.map((item) => item.data.id), [1, 3]);
	assert.equal(count, 2);
});

test('runtime hook dispatch ignores patched Array transform helpers', async () => {
	runtimeHookDispatchEvents.length = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'runtime-hook-dispatch-plugin',
				hooks: {
					beforeRead() {
						runtimeHookDispatchEvents[runtimeHookDispatchEvents.length] = 'plugin';
					}
				}
			}
		]
	});
	const Record = RuntimeHookDispatchRecord.use(context) as unknown as typeof RuntimeHookDispatchRecord;
	const meta = context.meta(Record);
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const filter = Object.getOwnPropertyDescriptor(Array.prototype, 'filter')!;
	const flatMap = Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap')!;
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
	try {
		await context.runHooks('beforeRead', {
			model: meta,
			ids: [1],
			operation: 'read'
		});
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
		Object.defineProperty(Array.prototype, 'filter', filter);
		Object.defineProperty(Array.prototype, 'flatMap', flatMap);
	}

	assert.deepEqual(runtimeHookDispatchEvents, ['plugin', 'model']);
});
