import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsCommittedWriteError,
	ActiveTsValidationError,
	clearDefaultContext,
	Model,
	createActiveTs,
	createAesGcmCacheCodec,
	createCacheMiddlewareAdapter,
	createCodecCacheAdapter,
	createFunctionCache,
	createOutboxPlugin,
	defineModel,
	getFunctionCacheDiagnostics,
	isPartialModel,
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemoryStoreAdapter,
	setDefaultContext
} from '../src/index.js';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';
import { runCacheAdapterContract } from '../src/testing/index.js';
import {
	assertNoAggregateFieldCodecSpecs,
	encodeAggregatePlanFieldCodecs,
	encodeQueryPlanFieldCodecs,
	stripFieldCodecQueryOperandMarker
} from '../src/core/field-codecs.js';
import type { CacheAdapter } from '../src/index.js';

type CacheRegressionData = {
	id: number;
	value: string;
};

type StaticUpdateCacheData = {
	id: number;
	a: string;
	b: string;
};

type ThrowingCreateData = {
	id: number;
	value: string;
};

type NestedCodecData = {
	id: number;
	label: string;
	profile: {
		secret: string;
		public?: string;
	};
};

type ParentCodecData = {
	id: number;
	profile: {
		score: number;
		bio: string;
	};
};

type ThrowingCodecData = {
	id: number;
	value: string;
};

type UndefinedCodecData = {
	id: number;
	value: string;
};

type UnsafeDecodedData = {
	id: number;
	payload: unknown;
};

type PostWriteHookData = {
	id: number;
	value: string;
};

type QueryableCodecData = {
	id: number;
	token: string;
};

type OperatorAwareCodecData = {
	id: number;
	token: string;
};

type ThrowingQueryCodecData = {
	id: number;
	token: string;
};

class CacheRegressionRecord extends Model<CacheRegressionData> {}
class StaticUpdateCacheRecord extends Model<StaticUpdateCacheData> {}
class ThrowingCreateRecord extends Model<ThrowingCreateData> {
	constructor(data: ThrowingCreateData, context?: any, options?: any) {
		super(data, context, options);
		if (data.value === 'throw') throw new Error('constructor failed');
	}
}
class NestedCodecRecord extends Model<NestedCodecData> {}
class ParentCodecRecord extends Model<ParentCodecData> {}
class ThrowingCodecRecord extends Model<ThrowingCodecData> {}
class UndefinedEncodeCodecRecord extends Model<UndefinedCodecData> {}
class UndefinedDecodeCodecRecord extends Model<UndefinedCodecData> {}
class UnsafeDecodedRecord extends Model<UnsafeDecodedData> {}
class PostWriteHookRecord extends Model<PostWriteHookData> {}
class QueryableCodecRecord extends Model<QueryableCodecData> {}
class OperatorAwareCodecRecord extends Model<OperatorAwareCodecData> {}
class CacheHookRecord extends Model<CacheRegressionData> {}
class ThrowingQueryCodecRecord extends Model<ThrowingQueryCodecData> {}
class UnsafeQueryCodecRecord extends Model<ThrowingQueryCodecData> {}

const NESTED_CODEC_VALUE = 'fixture-value';

defineModel<CacheRegressionData>({
	name: 'cache_regression_record',
	cache: { ttl: 60 }
})
	.id('id')
	.validate((input) => input as CacheRegressionData)
	.attach(CacheRegressionRecord);

defineModel<StaticUpdateCacheData>({
	name: 'static_update_cache_record',
	cache: { ttl: 60 }
})
	.id('id')
	.validate((input) => input as StaticUpdateCacheData)
	.attach(StaticUpdateCacheRecord);

defineModel<ThrowingCreateData>({
	name: 'throwing_create_record',
	cache: { ttl: 60, negativeTtl: 60 }
})
	.id('id')
	.validate((input) => input as ThrowingCreateData)
	.attach(ThrowingCreateRecord);

defineModel<CacheRegressionData>({
	name: 'cache_hook_record',
	cache: { ttl: 60, negativeTtl: 60 }
})
	.id('id')
	.validate((input) => input as CacheRegressionData)
	.attach(CacheHookRecord);

defineModel<NestedCodecData>('nested_codec_record')
	.id('id')
	.validate((input) => input as NestedCodecData)
	.fieldCodec('profile.secret', {
		name: 'nested-base64',
		encode: (value) => Buffer.from(String(value), 'utf8').toString('base64url'),
		decode: (value) => Buffer.from(String(value), 'base64url').toString('utf8')
	})
	.attach(NestedCodecRecord);

defineModel<ParentCodecData>('parent_codec_record')
	.id('id')
	.validate((input) => input as ParentCodecData)
	.fieldCodec('profile', {
		name: 'parent-json-codec',
		encode: (value) => JSON.stringify(value),
		decode: (value) => JSON.parse(String(value)),
		encodeQuery: (value) => JSON.stringify(value)
	})
	.attach(ParentCodecRecord);

defineModel<ThrowingCodecData>('throwing_codec_record')
	.id('id')
	.validate((input) => input as ThrowingCodecData)
	.fieldCodec('value', {
		name: 'throwing-field-codec',
		encode() {
			throw new Error('field encode failed');
		},
		decode() {
			throw new Error('field decode failed');
		}
	})
	.attach(ThrowingCodecRecord);

defineModel<UndefinedCodecData>('undefined_encode_codec_record')
	.id('id')
	.validate((input) => input as UndefinedCodecData)
	.fieldCodec('value', {
		name: 'undefined-encode',
		encode: () => undefined,
		decode: (value) => value
	})
	.attach(UndefinedEncodeCodecRecord);

defineModel<UndefinedCodecData>('undefined_decode_codec_record')
	.id('id')
	.validate((input) => input as UndefinedCodecData)
	.fieldCodec('value', {
		name: 'undefined-decode',
		encode: (value) => value,
		decode: () => undefined
	})
	.attach(UndefinedDecodeCodecRecord);

defineModel<UnsafeDecodedData>('unsafe_decoded_record')
	.id('id')
	.validate((input) => input as UnsafeDecodedData)
	.fieldCodec('payload', {
		name: 'unsafe-decode',
		encode: (value) => value,
		decode: () => ({ __decoded: true })
	})
	.attach(UnsafeDecodedRecord);

defineModel<PostWriteHookData>('post_write_hook_record')
	.id('id')
	.validate((input) => input as PostWriteHookData)
	.hooks({
		afterCreate() {
			throw new Error('after create side effect failed');
		}
	})
	.attach(PostWriteHookRecord);

const encodeToken = (value: unknown) => Buffer.from(String(value), 'utf8').toString('base64url');
const operatorAwareQueryOperators: Array<string | undefined> = [];
defineModel<QueryableCodecData>('queryable_codec_record')
	.id('id')
	.validate((input) => input as QueryableCodecData)
	.fieldCodec('token', {
		name: 'queryable-base64',
		encode: encodeToken,
		decode: (value) => Buffer.from(String(value), 'base64url').toString('utf8'),
		encodeQuery: encodeToken
	})
	.attach(QueryableCodecRecord);

defineModel<OperatorAwareCodecData>('operator_aware_codec_record')
	.id('id')
	.validate((input) => input as OperatorAwareCodecData)
	.fieldCodec('token', {
		name: 'operator-aware-codec',
		encode: (value) => `stored:${String(value)}`,
		decode: (value) => String(value).replace(/^stored:/, ''),
		encodeQuery: (value, context) => {
			operatorAwareQueryOperators.push(context.operator);
			return `stored:${String(value)}`;
		},
		queryOperators: ['startsWith']
	})
	.attach(OperatorAwareCodecRecord);

defineModel<ThrowingQueryCodecData>('throwing_query_codec_record')
	.id('id')
	.validate((input) => input as ThrowingQueryCodecData)
	.fieldCodec('token', {
		name: 'throwing-query-field-codec',
		encode: (value) => value,
		decode: (value) => value,
		encodeQuery() {
			throw new Error('query encode failed');
		}
	})
	.attach(ThrowingQueryCodecRecord);

defineModel<ThrowingQueryCodecData>('unsafe_query_codec_record')
	.id('id')
	.validate((input) => input as ThrowingQueryCodecData)
	.fieldCodec('token', {
		name: 'unsafe-query-field-codec',
		encode: (value) => value,
		decode: (value) => value,
		encodeQuery: () => ({ unsafe: true })
	})
	.attach(UnsafeQueryCodecRecord);

class TrackingStore extends MemoryStoreAdapter {
	readonly getManyBatches: unknown[][] = [];
	createCalls = 0;

	override async getMany(model: any, ids: any[]) {
		this.getManyBatches.push([...ids]);
		return await super.getMany(model, ids);
	}

	override async create(...args: Parameters<MemoryStoreAdapter['create']>) {
		this.createCalls++;
		return await super.create(...args);
	}
}

class BlockingSetCache extends MemoryCacheAdapter {
	readonly entered: Promise<void>;
	private resolveEntered!: () => void;
	private releaseSet!: () => void;
	private readonly releasePromise: Promise<void>;
	private shouldBlock = true;

	constructor() {
		super();
		this.entered = new Promise<void>((resolve) => {
			this.resolveEntered = resolve;
		});
		this.releasePromise = new Promise<void>((resolve) => {
			this.releaseSet = resolve;
		});
	}

	unblock() {
		this.releaseSet();
	}

	override async setMany(...args: Parameters<MemoryCacheAdapter['setMany']>) {
		if (this.shouldBlock) {
			this.shouldBlock = false;
			this.resolveEntered();
			await this.releasePromise;
		}
		await super.setMany(...args);
	}
}

class FailingStaleCleanupCache extends BlockingSetCache {
	failDeletes = false;

	override async deleteMany(...args: Parameters<MemoryCacheAdapter['deleteMany']>) {
		if (this.failDeletes) throw new Error('stale cleanup delete failed');
		return await super.deleteMany(...args);
	}
}

class BlockingGetCache extends MemoryCacheAdapter {
	readonly entered: Promise<void>;
	private resolveEntered!: () => void;
	private releaseGet!: () => void;
	private readonly releasePromise: Promise<void>;
	private shouldBlock = true;

	constructor() {
		super();
		this.entered = new Promise<void>((resolve) => {
			this.resolveEntered = resolve;
		});
		this.releasePromise = new Promise<void>((resolve) => {
			this.releaseGet = resolve;
		});
	}

	unblock() {
		this.releaseGet();
	}

	override async getMany(...args: Parameters<MemoryCacheAdapter['getMany']>) {
		const result = await super.getMany(...args);
		if (this.shouldBlock) {
			this.shouldBlock = false;
			this.resolveEntered();
			await this.releasePromise;
		}
		return result;
	}
}

class ReferenceRetainingCacheAdapter implements CacheAdapter {
	readonly kind = 'reference-retaining-cache';
	readonly entries = new Map<string, any>();

	async getMany(keys: string[]) {
		return keys.map((key) => {
			if (!this.entries.has(key)) return undefined;
			const value = this.entries.get(key);
			return value === undefined ? value : structuredClone(value);
		});
	}

	async setMany(entries: Array<[string, any]>) {
		for (const [key, value] of entries) this.entries.set(key, value);
	}

	async deleteMany(keys: string[]) {
		for (const key of keys) this.entries.delete(key);
	}
}

function setup() {
	const store = new TrackingStore();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	return { store, cache, Record };
}

function flushBackground() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

test('duplicate concurrent find calls share one batch and store read', async () => {
	const { store, cache, Record } = setup();
	await store.seed('cache_regression_record', [{ id: 1, value: 'one' }]);

	const [first, second, third] = await Promise.all([
		Record.find(1).load(),
		Record.find(1).load(),
		Record.find(1).load()
	]);

	assert.equal(first?.data.value, 'one');
	assert.equal(second?.data.value, 'one');
	assert.equal(third?.data.value, 'one');
	assert.deepEqual(store.getManyBatches, [[1]]);
	assert.equal(cache.stats.setMany, 1);

	const cached = await Record.find(1).load();
	assert.equal(cached?.data.value, 'one');
	assert.deepEqual(store.getManyBatches, [[1]]);
	assert.equal(cache.stats.hits, 1);
});

test('save and delete invalidate positive cache entries before the next find', async () => {
	const { store, cache, Record } = setup();
	await store.seed('cache_regression_record', [{ id: 7, value: 'before' }]);

	const loaded = await Record.find(7).load();
	assert.equal(loaded?.data.value, 'before');
	assert.equal(cache.stats.setMany, 1);

	loaded!.data.value = 'after';
	await loaded!.save();
	assert.equal(cache.stats.deleteMany, 1);

	const afterSave = await Record.find(7).load();
	assert.equal(afterSave?.data.value, 'after');
	assert.deepEqual(store.getManyBatches, [[7], [7]]);

	await Record.delete(7);
	assert.equal(cache.stats.deleteMany, 2);

	const afterDelete = await Record.find(7).load();
	assert.equal(afterDelete, null);
	assert.deepEqual(store.getManyBatches, [[7], [7], [7]]);
});

test('static update and delete misses invalidate stale positive cache entries', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	const meta = context.meta(CacheRegressionRecord);
	await store.seed(meta, [
		{ id: 31, value: 'update-stale' },
		{ id: 32, value: 'delete-stale' }
	]);
	await Record.find(31).load();
	await Record.find(32).load();
	cache.resetStats();
	await store.delete(meta, 31);
	await store.delete(meta, 32);

	const updated = await Record.update(31, { value: 'ignored' });
	await Record.delete(32);

	assert.equal(updated, null);
	assert.equal(cache.stats.deleteMany, 2);
	assert.equal(await Record.find(31).load(), null);
	assert.equal(await Record.find(32).load(), null);
});

test('entity cache does not write stale miss results after invalidation races', async () => {
	const store = new TrackingStore();
	const cache = new BlockingSetCache();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [{ id: 23, value: 'old' }]);

	const firstLoad = Record.find(23).load();
	await cache.entered;

	const meta = context.meta(CacheRegressionRecord);
	await store.update(meta, 23, { id: 23, value: 'new' });
	await context.invalidate(meta, 23);
	cache.unblock();

	const first = await firstLoad;
	assert.equal(first?.data.value, 'old');
	assert.equal(cache.snapshot()['cache_regression_record:number:23'], undefined);

	const second = await Record.find(23).load();
	assert.equal(second?.data.value, 'new');
	assert.equal(cache.snapshot()['cache_regression_record:number:23'].value.value, 'new');
	assert.deepEqual(store.getManyBatches, [[23], [23]]);
});

test('entity cache ignores hits invalidated during afterCacheGet hooks', async () => {
	const store = new TrackingStore();
	const cache = new MemoryCacheAdapter();
	let shouldBlock = false;
	let entered!: () => void;
	let release!: () => void;
	const enteredHook = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const releaseHook = new Promise<void>((resolve) => {
		release = resolve;
	});
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'blocking-after-cache-get',
				hooks: {
					async afterCacheGet(payload) {
						if (!shouldBlock) return payload;
						shouldBlock = false;
						entered();
						await releaseHook;
						return payload;
					}
				}
			}
		]
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	const meta = context.meta(CacheRegressionRecord);
	await store.seed(meta, [{ id: 25, value: 'old' }]);
	assert.equal((await Record.find(25).load())?.data.value, 'old');

	await store.update(meta, 25, { id: 25, value: 'new' });
	shouldBlock = true;
	const load = Record.find(25).load();
	await enteredHook;
	await context.invalidate(meta, 25);
	release();

	const loaded = await load;
	assert.equal(loaded?.data.value, 'new');
	assert.equal(cache.snapshot()['cache_regression_record:number:25'], undefined);
	assert.equal((await Record.find(25).load())?.data.value, 'new');
	assert.equal(cache.snapshot()['cache_regression_record:number:25'].value.value, 'new');
	assert.deepEqual(store.getManyBatches, [[25], [25], [25]]);
});

test('entity cache cleanup failures poison stale race writes', async () => {
	const store = new TrackingStore();
	const cache = new FailingStaleCleanupCache();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	const meta = context.meta(CacheRegressionRecord);
	await store.seed(meta, [{ id: 24, value: 'old' }]);

	const firstLoad = Record.find(24).load();
	await cache.entered;
	await store.update(meta, 24, { id: 24, value: 'new' });
	await context.invalidate(meta, 24);
	cache.failDeletes = true;
	cache.unblock();

	await assert.rejects(() => firstLoad, /stale cleanup delete failed/);
	assert.equal(cache.snapshot()['cache_regression_record:number:24'].value.value, 'old');

	cache.failDeletes = false;
	const second = await Record.find(24).load();
	assert.equal(second?.data.value, 'new');
	assert.equal(cache.snapshot()['cache_regression_record:number:24'].value.value, 'new');
	assert.deepEqual(store.getManyBatches, [[24], [24]]);
});

test('entity cache afterCacheSet failures remove committed cache entries', async () => {
	const store = new TrackingStore();
	const cache = new MemoryCacheAdapter();
	let failAfterSet = true;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'entity-cache-after-set-failure',
				hooks: {
					afterCacheSet(payload) {
						if (payload.operation !== 'read' || !failAfterSet) return;
						failAfterSet = false;
						throw new Error('entity cache after set failed');
					}
				}
			}
		]
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [{ id: 26, value: 'old' }]);

	await assert.rejects(() => Record.find(26).load(), /entity cache after set failed/);
	assert.equal(cache.snapshot()['cache_regression_record:number:26'], undefined);

	const loaded = await Record.find(26).load();
	assert.equal(loaded?.data.value, 'old');
	assert.equal(cache.snapshot()['cache_regression_record:number:26'].value.value, 'old');
	assert.deepEqual(store.getManyBatches, [[26], [26]]);
});

test('entity cache afterCacheSet cleanup failures poison stale persistent hits', async () => {
	class FailingDeleteCache extends MemoryCacheAdapter {
		failDeletes = false;

		override async deleteMany(...args: Parameters<MemoryCacheAdapter['deleteMany']>) {
			if (this.failDeletes) throw new Error('entity cache cleanup failed');
			return await super.deleteMany(...args);
		}
	}
	const store = new TrackingStore();
	const cache = new FailingDeleteCache();
	let failAfterSet = true;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'entity-cache-after-set-cleanup-failure',
				hooks: {
					afterCacheSet(payload) {
						if (payload.operation !== 'read' || !failAfterSet) return;
						failAfterSet = false;
						throw new Error('entity cache after set failed');
					}
				}
			}
		]
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	const meta = context.meta(CacheRegressionRecord);
	await store.seed(meta, [{ id: 27, value: 'old' }]);

	cache.failDeletes = true;
	await assert.rejects(
		() => Record.find(27).load(),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /Entity cache set hook failed and cleanup failed/);
			assert.match((error.errors[0] as Error).message, /entity cache after set failed/);
			assert.match((error.errors[1] as Error).message, /entity cache cleanup failed/);
			return true;
		}
	);
	assert.equal(cache.snapshot()['cache_regression_record:number:27'].value.value, 'old');

	await store.update(meta, 27, { id: 27, value: 'new' });
	cache.failDeletes = false;
	const loaded = await Record.find(27).load();
	assert.equal(loaded?.data.value, 'new');
	assert.equal(cache.snapshot()['cache_regression_record:number:27'].value.value, 'new');
	assert.deepEqual(store.getManyBatches, [[27], [27]]);
});

test('static update patches a fresh store row instead of stale positive cache data', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = StaticUpdateCacheRecord.use(context) as unknown as typeof StaticUpdateCacheRecord;
	const meta = context.meta(StaticUpdateCacheRecord);
	await store.seed(meta, [{ id: 1, a: 'current', b: 'old' }]);
	await cache.setMany([
		['static_update_cache_record:number:1', { id: 1, a: 'stale', b: 'old' }]
	], { ttl: 60 });

	const updated = await Record.update(1, { b: 'patched' });

	assert.deepEqual(updated?.data, { id: 1, a: 'current', b: 'patched' });
	assert.deepEqual(store.dump('static_update_cache_record'), [{ id: 1, a: 'current', b: 'patched' }]);
});

test('create constructs models before committing store writes', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [createOutboxPlugin({ outbox, includeData: true })]
	});
	const Record = ThrowingCreateRecord.use(context) as unknown as typeof ThrowingCreateRecord;

	assert.equal(await Record.find(1).load(), null);
	await assert.rejects(() => Record.create({ id: 1, value: 'throw' }), /constructor failed/);

	assert.deepEqual(store.dump('throwing_create_record'), []);
	assert.equal(cache.snapshot()['throwing_create_record:number:1'].value, null);
	assert.deepEqual(await outbox.list(), []);
});

test('post-write cache invalidation failures expose committed write status', async () => {
	class FailingDeleteCache extends MemoryCacheAdapter {
		override async deleteMany() {
			throw new Error('cache delete failed');
		}
	}
	const store = new TrackingStore();
	const cache = new FailingDeleteCache();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [{ id: 17, value: 'before' }]);
	const loaded = await Record.find(17).load();
	loaded!.data.value = 'after';

	await assert.rejects(
		() => loaded!.save(),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedWriteError);
			assert.equal(error.committed, true);
			assert.deepEqual(error.details, { model: 'cache_regression_record', operation: 'update', id: 17 });
			assert.match((error.cause as Error).message, /cache delete failed/);
			return true;
		}
	);
	assert.deepEqual(store.dump('cache_regression_record'), [{ id: 17, value: 'after' }]);
	const fresh = await Record.find(17).load();
	assert.deepEqual(fresh?.data, { id: 17, value: 'after' });
	assert.deepEqual(cache.snapshot()['cache_regression_record:number:17'].value, { id: 17, value: 'after' });
});

test('entity cache invalidation failures are scoped to the failing adapter', async () => {
	class FailingDeleteCache extends MemoryCacheAdapter {
		override async deleteMany() {
			throw new Error('entity cache delete failed');
		}
	}
	const store = new MemoryStoreAdapter();
	const failingCache = new FailingDeleteCache();
	const otherCache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: failingCache },
		defaultCache: 'default'
	});
	const meta = context.meta(CacheRegressionRecord);
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed(meta, [{ id: 19, value: 'old' }]);
	assert.equal((await Record.find(19).load())?.data.value, 'old');
	await store.update(meta, 19, { id: 19, value: 'new' });
	await assert.rejects(() => context.invalidate(meta, 19), /entity cache delete failed/);

	const fork = (context as any).fork({ caches: { default: otherCache } });
	const ForkRecord = CacheRegressionRecord.use(fork) as unknown as typeof CacheRegressionRecord;
	assert.equal((await ForkRecord.find(19).load())?.data.value, 'new');
	assert.equal((await Record.find(19).load())?.data.value, 'new');
});

test('post-write hook failures expose committed write status', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = PostWriteHookRecord.use(context) as unknown as typeof PostWriteHookRecord;

	await assert.rejects(
		() => Record.create({ id: 1, value: 'created' }),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedWriteError);
			assert.equal(error.committed, true);
			assert.deepEqual(error.details, { model: 'post_write_hook_record', operation: 'create', id: 1 });
			assert.match((error.cause as Error).message, /after create side effect failed/);
			return true;
		}
	);
	assert.deepEqual(store.dump('post_write_hook_record'), [{ id: 1, value: 'created' }]);
});

test('cache codec decode failures fail closed before store fallback', async () => {
	const store = new TrackingStore();
	const rawCache = new MemoryCacheAdapter();
	await store.seed('cache_regression_record', [{ id: 9, value: 'store' }]);
	await rawCache.setMany([['cache_regression_record:number:9', 'not-json']]);
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'throwing-test-codec',
		encode: (value) => value,
		decode() {
			throw new Error('corrupt cache payload');
		}
	});
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;

	await assert.rejects(() => Record.find(9).load(), /corrupt cache payload/);
	assert.deepEqual(store.getManyBatches, []);
});

test('entity cache getMany results are validated before store fallback', async () => {
	const store = new TrackingStore();
	await store.seed('cache_regression_record', [{ id: 10, value: 'store' }]);
	const cache = {
		kind: 'malformed-cache',
		getMany: async () => null as any,
		setMany: async () => undefined,
		deleteMany: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;

	await assert.rejects(
		() => Record.find(10).load(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Cache adapter "malformed-cache" getMany result/.test(error.message)
	);
	assert.deepEqual(store.getManyBatches, []);
});

test('entity cache rejects malformed hit rows before store fallback', async () => {
	const store = new TrackingStore();
	await store.seed('cache_regression_record', [{ id: 11, value: 'store' }]);
	const cache = {
		kind: 'malformed-hit-cache',
		getMany: async () => ['cached-primitive'] as any,
		setMany: async () => undefined,
		deleteMany: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;

	await assert.rejects(() => Record.find(11).load(), /Cache adapter "malformed-hit-cache" getMany result\[0\]/);
	assert.deepEqual(store.getManyBatches, []);
});

test('store read results are validated before entity cache writes', async () => {
	class MalformedReadStore extends TrackingStore {
		override async getMany(_model: any, ids: any[]) {
			this.getManyBatches.push([...ids]);
			return ['store-primitive'] as any;
		}
	}
	const store = new MalformedReadStore();
	const cache = new MemoryCacheAdapter();
	let afterReadCalled = false;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'read-sanitizer-observer',
				hooks: {
					afterRead() {
						afterReadCalled = true;
					}
				}
			}
		]
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;

	await assert.rejects(() => Record.find(12).load(), /Store adapter "memory" getMany result\[0\]/);
	assert.deepEqual(store.getManyBatches, [[12]]);
	assert.deepEqual(cache.snapshot(), {});
	assert.equal(cache.stats.setMany, 0);
	assert.equal(afterReadCalled, false);
});

test('read observer hook mutations do not change ids or cache keys', async () => {
	const store = new TrackingStore();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'mutating-read-observer',
				hooks: {
					beforeRead(payload) {
						if (payload.ids?.length) payload.ids[0] = 2;
					},
					beforeCacheGet(payload) {
						if (payload.ids?.length) payload.ids[0] = 2;
						const keys = (payload.meta as { keys?: string[] } | undefined)?.keys;
						if (keys?.length) keys[0] = 'cache_regression_record:number:2';
					}
				}
			}
		]
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	assert.equal((await Record.find(1).load())?.data.value, 'one');
	assert.equal((await Record.find(1).load())?.data.value, 'one');
	assert.deepEqual(store.getManyBatches, [[1]]);
	assert.equal(cache.stats.hits, 1);
});

test('afterRead and afterCacheGet hook metadata mutations do not remap requested ids', async () => {
	const store = new TrackingStore();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'mutating-after-read-observer',
				hooks: {
					afterRead(payload) {
						if (payload.ids?.length) payload.ids[0] = 2;
					},
					afterCacheGet(payload) {
						if (payload.ids) payload.ids.length = 0;
						const keys = (payload.meta as { keys?: string[] } | undefined)?.keys;
						if (keys) keys.length = 0;
					}
				}
			}
		]
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	assert.equal((await Record.find(1).load())?.data.value, 'one');
	assert.equal(cache.snapshot()['cache_regression_record:number:1'].value.id, 1);
	assert.equal(cache.snapshot()['cache_regression_record:number:2'], undefined);
	assert.equal((await Record.find(1).load())?.data.value, 'one');
	assert.deepEqual(store.getManyBatches, [[1]]);
	assert.equal(cache.stats.hits, 1);
});

test('read and cache hook rows must preserve requested ids', async () => {
	const store = new TrackingStore();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'wrong-id-after-read',
				hooks: {
					afterRead(payload) {
						return {
							result: payload.result.map((item: CacheRegressionData | null) =>
								item ? { ...item, id: 2, value: 'wrong' } : item
							)
						};
					}
				}
			}
		]
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	await assert.rejects(() => Record.find(1).load(), /afterRead result\[0\] id field "id" must match the requested id/);
	assert.deepEqual(cache.snapshot(), {});

	const poisonedCache = new MemoryCacheAdapter();
	await poisonedCache.setMany([['cache_regression_record:number:1', { id: 2, value: 'wrong' }]]);
	const poisonedContext = createActiveTs({
		stores: { default: store },
		caches: { default: poisonedCache }
	});
	const PoisonedRecord = CacheRegressionRecord.use(poisonedContext) as unknown as typeof CacheRegressionRecord;
	await assert.rejects(
		() => PoisonedRecord.find(1).load(),
		/Cache adapter "memory" getMany result\[0\] id field "id" must match the requested id/
	);
});

test('null cache hits require an explicit negative cache policy', async () => {
	const store = new TrackingStore();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [{ id: 4, value: 'from-store' }]);
	await cache.setMany([['cache_regression_record:number:4', null]]);

	assert.equal((await Record.find(4).load())?.data.value, 'from-store');
	assert.deepEqual(store.getManyBatches, [[4]]);

	const negativeStore = new TrackingStore();
	const negativeCache = new MemoryCacheAdapter();
	const negativeContext = createActiveTs({
		stores: { default: negativeStore },
		caches: { default: negativeCache }
	});
	const NegativeRecord = CacheHookRecord.use(negativeContext) as unknown as typeof CacheHookRecord;
	await negativeStore.seed('cache_hook_record', [{ id: 5, value: 'hidden-by-negative-cache' }]);
	await negativeCache.setMany([['cache_hook_record:number:5', null]]);

	assert.equal(await NegativeRecord.find(5).load(), null);
	assert.deepEqual(negativeStore.getManyBatches, []);
});

test('cache codec wrapper validates adapter, codec, and option shapes', () => {
	const rawCache = new MemoryCacheAdapter();
	const codec = {
		name: 'shape-codec',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};

	assert.throws(() => createCodecCacheAdapter(null as any, codec), /codec cache adapter must be a cache adapter object/);
	assert.throws(
		() => createCodecCacheAdapter({ kind: 'bad-cache', getMany: async () => [] } as any, codec),
		/codec cache adapter must provide/
	);
	assert.throws(
		() =>
			createCodecCacheAdapter({
				kind: 'bad\0cache',
				getMany: async () => [],
				setMany: async () => undefined,
				deleteMany: async () => undefined
			}, codec),
		/codec cache adapter must provide/
	);
	assert.throws(() => createCodecCacheAdapter(rawCache, null as any), /cache codec must be an object/);
	assert.throws(
		() => createCodecCacheAdapter(rawCache, { name: '', encode: (value: unknown) => value, decode: (value: unknown) => value }),
		/cache codec name must be a non-empty string/
	);
	assert.throws(
		() => createCodecCacheAdapter(rawCache, { name: 'bad-codec', encode: null as any, decode: (value: unknown) => value }),
		/cache codec encode must be a function/
	);
		assert.throws(
			() => createCodecCacheAdapter(rawCache, { name: 'bad-codec', encode: (value: unknown) => value, decode: null as any }),
			/cache codec decode must be a function/
		);
		const hiddenAdapter = {
			kind: 'hidden-cache',
			getMany: async () => [],
			setMany: async () => undefined
		} as any;
		Object.defineProperty(hiddenAdapter, 'deleteMany', {
			enumerable: false,
			value: async () => undefined
		});
		assert.throws(
			() => createCodecCacheAdapter(hiddenAdapter, codec),
			/deleteMany must be enumerable/
		);
		const hiddenCodec = {
			name: 'hidden-codec',
			decode: (value: unknown) => value
		} as any;
		Object.defineProperty(hiddenCodec, 'encode', {
			enumerable: false,
			value: (value: unknown) => value
		});
		assert.throws(
			() => createCodecCacheAdapter(rawCache, hiddenCodec),
			/encode must be enumerable/
		);
		let accessorReads = 0;
		const accessorAdapter = {
			kind: 'accessor-cache',
		getMany: async () => [],
		setMany: async () => undefined
	} as any;
	Object.defineProperty(accessorAdapter, 'deleteMany', {
		enumerable: true,
		get() {
			accessorReads++;
			return async () => undefined;
		}
	});
	assert.throws(
		() => createCodecCacheAdapter(accessorAdapter, codec),
		/deleteMany must be a data property/
	);
	assert.equal(accessorReads, 0);
	const accessorCodec = {
		name: 'accessor-codec',
		encode: (value: unknown) => value
	} as any;
	Object.defineProperty(accessorCodec, 'decode', {
		enumerable: true,
		get() {
			accessorReads++;
			return (value: unknown) => value;
		}
	});
	assert.throws(
		() => createCodecCacheAdapter(rawCache, accessorCodec),
		/decode must be a data property/
	);
	assert.equal(accessorReads, 0);
	assert.throws(
		() => createCodecCacheAdapter(rawCache, codec, { kind: 'bad\0kind' }),
		/codec cache adapter kind must be a non-empty string/
	);
	Object.defineProperty(Object.prototype, 'kind', {
		value: 'polluted-cache',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'getMany', {
		value: async () => [],
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'setMany', {
		value: async () => undefined,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'deleteMany', {
		value: async () => undefined,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'name', {
		value: 'polluted-codec',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'encode', {
		value: (value: unknown) => value,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'decode', {
		value: (value: unknown) => value,
		configurable: true
	});
	try {
		assert.throws(
			() => createCodecCacheAdapter({} as any, codec),
			/codec cache adapter must provide/
		);
		assert.throws(
			() => createCodecCacheAdapter(rawCache, {} as any),
			/cache codec name must be a non-empty string/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).kind;
		delete (Object.prototype as Record<string, unknown>).getMany;
		delete (Object.prototype as Record<string, unknown>).setMany;
		delete (Object.prototype as Record<string, unknown>).deleteMany;
		delete (Object.prototype as Record<string, unknown>).name;
		delete (Object.prototype as Record<string, unknown>).encode;
		delete (Object.prototype as Record<string, unknown>).decode;
	}
	assert.doesNotThrow(() => createCodecCacheAdapter(rawCache, codec, { kind: 'memory-shape-codec' }));
});

test('cache codec wrapper snapshots codec functions at construction', async () => {
	const rawCache = new MemoryCacheAdapter();
	const codec = {
		name: 'snapshot-codec',
		encode: (value: unknown) => `old:${String(value)}`,
		decode: (value: unknown) => String(value).replace(/^old:/, '')
	};
	const cache = createCodecCacheAdapter(rawCache, codec);
	codec.encode = (value: unknown) => `new:${String(value)}`;
	codec.decode = (value: unknown) => String(value).replace(/^new:/, '');

	await cache.setMany([['row', 'value']]);

	assert.deepEqual(rawCache.snapshot(), { row: { value: 'old:value', expires: undefined } });
	assert.deepEqual(await cache.getMany(['row']), ['value']);
});

test('cache codec wrapper validates direct operation shapes before codecs run', async () => {
	let encodeCalls = 0;
	let decodeCalls = 0;
	let adapterCalls = 0;
	const rawCache = {
		kind: 'raw-shape-cache',
		getMany: async () => {
			adapterCalls++;
			return [];
		},
		setMany: async () => {
			adapterCalls++;
		},
		deleteMany: async () => {
			adapterCalls++;
		}
	};
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'shape-codec',
		encode(value) {
			encodeCalls++;
			return value;
		},
		decode(value) {
			decodeCalls++;
			return value;
		}
	});

	await assert.rejects(() => cache.getMany(null as any), /codec cache keys must be an array/);
	await assert.rejects(() => cache.deleteMany([{} as any]), /codec cache keys\[0\] must be a string/);
	await assert.rejects(() => cache.setMany(null as any), /codec cache entries must be an array/);
	await assert.rejects(
		() => cache.setMany(['bad-entry'] as any),
		/codec cache entries\[0\] must be a \[key, value\] tuple/
	);
	await assert.rejects(
		() => cache.setMany([['key', 'value', 'extra'] as any]),
		/codec cache entries\[0\] must be a \[key, value\] tuple/
	);
	await assert.rejects(() => cache.setMany([['bad\0key', 'value']]), /codec cache entries\[0\] key must not contain null bytes/);
	await assert.rejects(() => cache.setMany([['key', 'value']], null as any), /codec cache write options must be a plain object/);
	let getterCalls = 0;
	const accessorWriteOptions = Object.defineProperty({}, 'ttl', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(
		() => cache.setMany([['key', 'value']], accessorWriteOptions as any),
		/codec cache write options "ttl" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenWriteOptions = Object.defineProperty({}, 'ttl', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => cache.setMany([['key', 'value']], hiddenWriteOptions as any),
		/codec cache write options "ttl" must be enumerable/
	);
	await assert.rejects(
		() => cache.setMany([['key', 'value']], { [Symbol('ttl')]: 1 } as any),
		/codec cache write options cannot contain symbol fields/
	);
	await assert.rejects(
		() => cache.setMany([['key', 'value']], { ttll: 1 } as any),
		/codec cache write options contains unknown option "ttll"/
	);
	await assert.rejects(() => cache.setMany([['key', 'value']], { ttl: 0 }), /positive number/);
	assert.equal(adapterCalls, 0);
	assert.equal(encodeCalls, 0);
	assert.equal(decodeCalls, 0);
});

test('cache setMany rejects duplicate keys before writes', async () => {
	const memory = new MemoryCacheAdapter();
	await assert.rejects(
		() => memory.setMany([['dup', 'first'], ['dup', 'second']]),
		/duplicate key "dup"/
	);
	assert.deepEqual(await memory.getMany(['dup']), [undefined]);

	let middlewareCalls = 0;
	const middleware = createCacheMiddlewareAdapter(new MemoryCacheAdapter(), [
		async (_operation, next) => {
			middlewareCalls++;
			return next();
		}
	]);
	await assert.rejects(
		() => middleware.setMany([['dup', 'first'], ['dup', 'second']]),
		/duplicate key "dup"/
	);
	assert.equal(middlewareCalls, 0);

	let rawSetManyCalls = 0;
	const codec = createCodecCacheAdapter(
		{
			kind: 'duplicate-key-raw-cache',
			getMany: async () => [],
			setMany: async () => {
				rawSetManyCalls++;
			},
			deleteMany: async () => undefined
		},
		{
			name: 'identity',
			encode: (value) => value,
			decode: (value) => value
		}
	);
	await assert.rejects(
		() => codec.setMany([['dup', 'first'], ['dup', 'second']]),
		/duplicate key "dup"/
	);
	assert.equal(rawSetManyCalls, 0);
});

test('cache codec wrapper treats empty batches as no-ops', async () => {
	let adapterCalls = 0;
	let codecCalls = 0;
	const cache = createCodecCacheAdapter({
		kind: 'empty-batch-cache',
		getMany: async () => {
			adapterCalls++;
			throw new Error('empty getMany should not reach wrapped cache');
		},
		setMany: async () => {
			adapterCalls++;
			throw new Error('empty setMany should not reach wrapped cache');
		},
		deleteMany: async () => {
			adapterCalls++;
			throw new Error('empty deleteMany should not reach wrapped cache');
		}
	}, {
		name: 'empty-batch-codec',
		encode(value) {
			codecCalls++;
			return value;
		},
		decode(value) {
			codecCalls++;
			return value;
		}
	});

	assert.deepEqual(await cache.getMany([]), []);
	await cache.setMany([], { ttl: 1 });
	await cache.deleteMany([]);

	assert.equal(adapterCalls, 0);
	assert.equal(codecCalls, 0);
});

test('cache codec wrapper validates wrapped getMany result shape', async () => {
	const codec = {
		name: 'result-shape-codec',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};
	const shortCache = createCodecCacheAdapter({
		kind: 'short-cache',
		getMany: async () => [],
		setMany: async () => undefined,
		deleteMany: async () => undefined
	}, codec);
	await assert.rejects(
		() => shortCache.getMany(['key']),
		/codec cache adapter "short-cache" getMany result must be an array with 1 entries/
	);

	const sparseCache = createCodecCacheAdapter({
		kind: 'sparse-cache',
		getMany: async () => new Array(1),
		setMany: async () => undefined,
		deleteMany: async () => undefined
	}, codec);
	await assert.rejects(
		() => sparseCache.getMany(['key']),
		/codec cache adapter "sparse-cache" getMany result\[0\] is missing/
	);

	let mapCalls = 0;
	const mappedCache = createCodecCacheAdapter({
		kind: 'mapped-cache',
		getMany: async () => {
			const rows = ['encoded'] as any[];
			Object.defineProperty(rows, 'map', {
				value() {
					mapCalls++;
					throw new Error('custom result map should not run');
				}
			});
			return rows;
		},
		setMany: async () => undefined,
		deleteMany: async () => undefined
	}, codec);
	assert.deepEqual(await mappedCache.getMany(['key']), ['encoded']);
	assert.equal(mapCalls, 0);
});

test('cache codec wrapper snapshots operation arrays before adapter calls', async () => {
	const rawCache = new MemoryCacheAdapter();
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'array-method-codec',
		encode: (value) => value,
		decode: (value) => value
	});
	let mapCalls = 0;
	const codecKeys = ['key'] as any[];
	Object.defineProperty(codecKeys, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom codec key map should not run');
		}
	});
	const codecEntries = [['key', 'value']] as any[];
	Object.defineProperty(codecEntries, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom codec entries map should not run');
		}
	});

	await cache.setMany(codecEntries);
	assert.deepEqual(await cache.getMany(codecKeys as string[]), ['value']);
	await cache.deleteMany(codecKeys as string[]);

	assert.equal(mapCalls, 0);
});

test('cache codec wrapper direct operations ignore patched Array map', async () => {
	const rawCache = new MemoryCacheAdapter();
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'global-map-codec',
		encode: (value) => ({ encoded: value }),
		decode: (value) => (value as { encoded: unknown }).encoded
	});
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	let hit: unknown[] = [];
	let miss: unknown[] = [];
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	try {
		await cache.setMany([['codec-global-map-key', { ok: true }]]);
		hit = await cache.getMany(['codec-global-map-key']);
		await cache.deleteMany(['codec-global-map-key']);
		miss = await cache.getMany(['codec-global-map-key']);
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
	}

	assert.deepEqual(hit, [{ ok: true }]);
	assert.deepEqual(miss, [undefined]);
});

test('cache codec wrapper validates encoded payloads before adapter writes', async () => {
	let writeCalls = 0;
	const rawCache = {
		kind: 'unsafe-encoded-cache',
		getMany: async () => [],
		setMany: async () => {
			writeCalls++;
		},
		deleteMany: async () => undefined
	};
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'unsafe-encode',
		encode: () => undefined,
		decode: (value) => value
	});

	await assert.rejects(
		() => cache.setMany([['key', { value: 1 }]]),
		/codec cache adapter "unsafe-encoded-cache" encoded payload: Cache values cannot be undefined/
	);
	assert.equal(writeCalls, 0);
});

test('cache codec decoded payloads are checked for reserved keys', async () => {
	const store = new TrackingStore();
	const rawCache = new MemoryCacheAdapter();
	await rawCache.setMany([['cache_regression_record:number:12', 'encoded']]);
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'unsafe-cache-decode',
		encode: (value) => value,
		decode: () => ({ id: 12, value: 'unsafe', __decoded: true })
	});
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;

	await assert.rejects(() => Record.find(12).load(), /Reserved data key/);
	assert.deepEqual(store.getManyBatches, []);
});

test('cache codec decode results are validated before callers receive them', async () => {
	const rawCache = new MemoryCacheAdapter();
	await rawCache.setMany([['date', 'encoded-date'], ['reserved', 'encoded-reserved']]);
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'unsafe-direct-decode',
		encode: (value) => value,
		decode(value) {
			if (value === 'encoded-date') return { seenAt: new Date('2026-05-14T00:00:00.000Z') };
			return { id: 1, __decoded: true };
		}
	});

	await assert.rejects(() => cache.getMany(['date']), /cannot contain Date/);
	await assert.rejects(() => cache.getMany(['reserved']), /Reserved data key/);
});

test('AES-GCM cache codec rejects non-string payloads without coercion', async () => {
	let toStringCalls = 0;
	const malformedPayload = Object.defineProperty({}, 'toString', {
		enumerable: true,
		value() {
			toStringCalls++;
			return 'v1:bad:bad:bad';
		}
	});
	const codec = createAesGcmCacheCodec({
		key: Buffer.alloc(32, 8),
		randomBytes: (size) => Buffer.alloc(size, 4)
	});

	assert.throws(
		() => codec.decode(malformedPayload as any, { key: 'row', operation: 'get' }),
		/AES-GCM cache codec payload must be a string or Buffer/
	);
	assert.equal(toStringCalls, 0);
});

test('AES-GCM cache codec ignores inherited toJSON before encryption', async () => {
	let toJsonCalls = 0;
	Object.defineProperty(Object.prototype, 'toJSON', {
		configurable: true,
		value() {
			toJsonCalls++;
			return { value: 'polluted' };
		}
	});
	try {
		const codec = createAesGcmCacheCodec({
			key: Buffer.alloc(32, 9),
			randomBytes: (size) => Buffer.alloc(size, 5)
		});
		const encoded = await codec.encode({ value: 'safe', nested: { flag: true } }, { key: 'row', operation: 'set' });
		assert.equal(toJsonCalls, 0);
		assert.deepEqual(await codec.decode(encoded, { key: 'row', operation: 'get' }), {
			value: 'safe',
			nested: { flag: true }
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).toJSON;
	}
});

test('AES-GCM cache codec ignores patched JSON intrinsics after import', async () => {
	const originalStringify = JSON.stringify;
	const originalParse = JSON.parse;
	Object.defineProperty(JSON, 'stringify', {
		configurable: true,
		value() {
			throw new Error('patched JSON.stringify should not run for AES-GCM cache codec');
		}
	});
	Object.defineProperty(JSON, 'parse', {
		configurable: true,
		value() {
			throw new Error('patched JSON.parse should not run for AES-GCM cache codec');
		}
	});
	try {
		const codec = createAesGcmCacheCodec({
			key: Buffer.alloc(32, 9),
			randomBytes: (size) => Buffer.alloc(size, 5)
		});
		const encoded = await codec.encode({ value: 'safe', nested: { flag: true } }, { key: 'row', operation: 'set' });
		assert.deepEqual(await codec.decode(encoded, { key: 'row', operation: 'get' }), {
			value: 'safe',
			nested: { flag: true }
		});
	} finally {
		Object.defineProperty(JSON, 'stringify', { configurable: true, value: originalStringify });
		Object.defineProperty(JSON, 'parse', { configurable: true, value: originalParse });
	}
});

test('AES-GCM cache codec rejects accessor values before encryption', async () => {
	const codec = createAesGcmCacheCodec({
		key: Buffer.alloc(32, 10),
		randomBytes: (size) => Buffer.alloc(size, 6)
	});
	const value = Object.defineProperty({}, 'secret', {
		enumerable: true,
		get() {
			throw new Error('getter should not run');
		}
	});

	assert.throws(
		() => codec.encode(value, { key: 'row', operation: 'set' }),
		/Unsupported data accessor/
	);
});

test('cache JSON snapshots ignore polluted property descriptor prototypes', async () => {
	Object.defineProperties(Object.prototype, {
		get: { value: () => undefined, configurable: true },
		set: { value: () => undefined, configurable: true },
		value: { value: 'polluted descriptor value', configurable: true },
		writable: { value: false, configurable: true }
	});
	try {
		const codec = createAesGcmCacheCodec({
			key: Buffer.alloc(32, 11),
			randomBytes: (size) => Buffer.alloc(size, 7)
		});
		const encoded = await codec.encode({ value: 'safe', nested: { flag: true } }, { key: 'row', operation: 'set' });
		assert.deepEqual(await codec.decode(encoded, { key: 'row', operation: 'get' }), {
			value: 'safe',
			nested: { flag: true }
		});

		const stored = new Map<string, string | Buffer>();
		const adapter = await createRedisValkeyCacheAdapter({
			client: {
				mGet: async (keys: string[]) => keys.map((key) => stored.get(key) ?? null),
				mSet: async (entries: Record<string, string | Buffer>) => {
					for (const [key, value] of Object.entries(entries)) stored.set(key, value);
					return 'OK';
				},
				multi: () => ({
					set() {
						return this;
					},
					exec: async () => []
				}),
				del: async () => 0
			}
		});
		await adapter.setMany([['row', { value: 'safe', nested: { flag: true } }]]);
		assert.equal(stored.get(adapter.codecKey!('row')), '{"value":"safe","nested":{"flag":true}}');
	} finally {
		delete (Object.prototype as Record<string, unknown>).get;
		delete (Object.prototype as Record<string, unknown>).set;
		delete (Object.prototype as Record<string, unknown>).value;
		delete (Object.prototype as Record<string, unknown>).writable;
	}
});

test('cache JSON snapshots use captured collection intrinsics', async () => {
	const weakSetHas = WeakSet.prototype.has;
	const weakSetAdd = WeakSet.prototype.add;
	const weakSetDelete = WeakSet.prototype.delete;
	const setHas = Set.prototype.has;
	const setAdd = Set.prototype.add;
	WeakSet.prototype.has = function () {
		throw new Error('patched WeakSet.has');
	};
	WeakSet.prototype.add = function () {
		throw new Error('patched WeakSet.add');
	};
	WeakSet.prototype.delete = function () {
		throw new Error('patched WeakSet.delete');
	};
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	Set.prototype.add = function () {
		throw new Error('patched Set.add');
	};
	let decoded: unknown;
	let aesOptionError: unknown;
	let redisStored: string | Buffer | undefined;
	let redisDecoded: unknown;
	let redisOptionError: unknown;
	try {
		const codec = createAesGcmCacheCodec({
			key: Buffer.alloc(32, 12),
			randomBytes: (size) => Buffer.alloc(size, 8)
		});
		const encoded = await codec.encode({ value: 'safe', nested: { flag: true } }, { key: 'row', operation: 'set' });
		decoded = await codec.decode(encoded, { key: 'row', operation: 'get' });
		try {
			createAesGcmCacheCodec({ key: Buffer.alloc(32, 12), unknown: true } as any);
		} catch (error) {
			aesOptionError = error;
		}

		const stored = new Map<string, string | Buffer>();
		const adapter = await createRedisValkeyCacheAdapter({
			client: {
				mGet: async (keys: string[]) => keys.map((key) => stored.get(key) ?? null),
				mSet: async (entries: Record<string, string | Buffer>) => {
					for (const [key, value] of Object.entries(entries)) stored.set(key, value);
					return 'OK';
				},
				multi: () => ({
					set(key: string, value: string | Buffer) {
						stored.set(key, value);
						return this;
					},
					exec: async () => ['OK']
				}),
				del: async () => 0
			}
		});
		await adapter.setMany([['row', { value: 'safe', nested: { flag: true } }]], { ttl: 30 });
		redisStored = stored.get(adapter.codecKey!('row'));
		redisDecoded = await adapter.getMany(['row']);
		try {
			await createRedisValkeyCacheAdapter({ client: {}, unknown: true } as any);
		} catch (error) {
			redisOptionError = error;
		}
	} finally {
		WeakSet.prototype.has = weakSetHas;
		WeakSet.prototype.add = weakSetAdd;
		WeakSet.prototype.delete = weakSetDelete;
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
	assert.deepEqual(decoded, {
		value: 'safe',
		nested: { flag: true }
	});
	assert.match(String((aesOptionError as Error | undefined)?.message), /AES-GCM cache codec options contains unknown option "unknown"/);
	assert.equal(redisStored, '{"value":"safe","nested":{"flag":true}}');
	assert.deepEqual(redisDecoded, [{ value: 'safe', nested: { flag: true } }]);
	assert.match(String((redisOptionError as Error | undefined)?.message), /redis-valkey cache options contains unknown option "unknown"/);
});

test('cache codec wrapper clones encoded hits before decode', async () => {
	const stored = new Map<string, any>();
	const rawCache = {
		kind: 'live-encoded-cache',
		getMany: async (keys: string[]) => keys.map((key) => stored.get(key)),
		setMany: async (entries: Array<[string, any]>) => {
			for (const [key, value] of entries) stored.set(key, value);
		},
		deleteMany: async () => undefined
	};
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'mutating-encoded-decode',
		encode: (value: any) => ({ payload: value }),
		decode(encoded: any) {
			const result = encoded.payload;
			encoded.payload = { value: 'corrupted' };
			return result;
		}
	});

	await cache.setMany([['key', { value: 'original' }]]);
	const raw = stored.get('key');

	assert.deepEqual(await cache.getMany(['key']), [{ value: 'original' }]);
	assert.deepEqual(raw, { payload: { value: 'original' } });
	assert.deepEqual(await cache.getMany(['key']), [{ value: 'original' }]);
});

test('cache codec wrapper isolates codec input and decoded payloads', async () => {
	const rawCache = new MemoryCacheAdapter();
	const decodedSingleton = { id: 1, nested: { value: 'decoded' } };
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'mutation-isolation-codec',
		encode(value: any) {
			value.nested.value = 'codec-mutated';
			return 'encoded';
		},
		decode: () => decodedSingleton
	});
	const input = { nested: { value: 'input' } };

	await cache.setMany([['key', input]]);
	assert.equal(input.nested.value, 'input');

	const [first] = await cache.getMany(['key']);
	(first as any).nested.value = 'caller-mutated';
	const [second] = await cache.getMany(['key']);

	assert.deepEqual(second, { id: 1, nested: { value: 'decoded' } });
	assert.deepEqual(decodedSingleton, { id: 1, nested: { value: 'decoded' } });
});

test('redis-valkey codec decode results are validated before callers receive them', async () => {
	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => ['encoded'],
			mSet: async () => undefined,
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => undefined
		},
		codec: {
			name: 'unsafe-redis-decode',
			encode: (value) => value,
			decode: () => ({ seenAt: new Date('2026-05-14T00:00:00.000Z') })
		}
	});

	await assert.rejects(() => adapter.getMany(['key']), /cannot contain Date/);
});

test('redis-valkey codec isolates codec input and decoded payloads', async () => {
	const decodedSingleton = { id: 1, nested: { value: 'decoded' } };
	const writes: Record<string, unknown>[] = [];
	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => ['encoded'],
			mSet: async (entries: Record<string, unknown>) => {
				writes.push(entries);
				return 'OK';
			},
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => undefined
		},
		codec: {
			name: 'mutation-isolation-redis-codec',
			encode(value: any) {
				value.nested.value = 'codec-mutated';
				return 'encoded';
			},
			decode: () => decodedSingleton
		}
	});
	const input = { nested: { value: 'input' } };

	await adapter.setMany([['key', input]]);
	assert.equal(input.nested.value, 'input');
	assert.deepEqual(writes, [{ [adapter.codecKey!('key')]: 'encoded' }]);

	const [first] = await adapter.getMany(['key']);
	(first as any).nested.value = 'caller-mutated';
	const [second] = await adapter.getMany(['key']);

	assert.deepEqual(second, { id: 1, nested: { value: 'decoded' } });
	assert.deepEqual(decodedSingleton, { id: 1, nested: { value: 'decoded' } });
});

test('redis-valkey codec clones Buffer payloads across encode and decode', async () => {
	const stored = Buffer.from('stored-buffer');
	const writes: Record<string, unknown>[] = [];
	let encodedBuffer = Buffer.from('encoded-buffer');
	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => [stored],
			mSet: async (entries: Record<string, unknown>) => {
				writes.push(entries);
				return 'OK';
			},
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => undefined
		},
		codec: {
			name: 'buffer-isolation-redis-codec',
			encode() {
				return encodedBuffer;
			},
			decode(value) {
				assert.ok(Buffer.isBuffer(value));
				const text = value.toString('utf8');
				value.fill(0);
				return { value: text };
			}
		}
	});

	await adapter.setMany([['row', { value: 'input' }]]);
	const written = writes[0][adapter.codecKey!('row')] as Buffer;
	assert.ok(Buffer.isBuffer(written));
	assert.notEqual(written, encodedBuffer);
	assert.equal(written.toString('utf8'), 'encoded-buffer');
	encodedBuffer.fill(0);
	assert.equal(written.toString('utf8'), 'encoded-buffer');

	assert.deepEqual(await adapter.getMany(['row']), [{ value: 'stored-buffer' }]);
	assert.equal(stored.toString('utf8'), 'stored-buffer');
});

test('redis-valkey AES codec binds ciphertext to physical prefixed keys', async () => {
	const stored = new Map<string, string | Buffer>();
	const client = {
		mGet: async (keys: string[]) => keys.map((key) => stored.get(key) ?? null),
		mSet: async (entries: Record<string, string | Buffer>) => {
			for (const [key, value] of Object.entries(entries)) stored.set(key, value);
			return 'OK';
		},
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async (keys: string[]) => {
			for (const key of keys) stored.delete(key);
			return keys.length;
		}
	};
	const codec = createAesGcmCacheCodec({
		key: Buffer.alloc(32, 7),
		randomBytes: (size) => Buffer.alloc(size, 3)
	});
	const tenantA = await createRedisValkeyCacheAdapter({ client, codec, prefix: 'tenant-a' });
	const tenantB = await createRedisValkeyCacheAdapter({ client, codec, prefix: 'tenant-b' });

	await tenantA.setMany([['row', { value: 'alpha' }]]);
	const ciphertext = stored.get(tenantA.codecKey!('row'));
	assert.ok(ciphertext);
	stored.set(tenantB.codecKey!('row'), ciphertext);

	await assert.rejects(
		() => tenantB.getMany(['row']),
		/Failed to decode AES-GCM cache codec payload/
	);
	assert.deepEqual(await tenantA.getMany(['row']), [{ value: 'alpha' }]);
});

test('generic codec wrapper uses redis-valkey physical prefixed keys for AES context', async () => {
	const stored = new Map<string, string | Buffer>();
	const client = {
		mGet: async (keys: string[]) => keys.map((key) => stored.get(key) ?? null),
		mSet: async (entries: Record<string, string | Buffer>) => {
			for (const [key, value] of Object.entries(entries)) stored.set(key, value);
			return 'OK';
		},
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async (keys: string[]) => {
			for (const key of keys) stored.delete(key);
			return keys.length;
		}
	};
	const codec = createAesGcmCacheCodec({
		key: Buffer.alloc(32, 9),
		randomBytes: (size) => Buffer.alloc(size, 5)
	});
	const tenantA = createCodecCacheAdapter(await createRedisValkeyCacheAdapter({ client, prefix: 'tenant-a' }), codec);
	const tenantB = createCodecCacheAdapter(await createRedisValkeyCacheAdapter({ client, prefix: 'tenant-b' }), codec);

	await tenantA.setMany([['row', { value: 'alpha' }]]);
	const ciphertext = stored.get(tenantA.codecKey!('row'));
	assert.ok(ciphertext);
	stored.set(tenantB.codecKey!('row'), ciphertext);

	await assert.rejects(
		() => tenantB.getMany(['row']),
		/Failed to decode AES-GCM cache codec payload/
	);
	assert.deepEqual(await tenantA.getMany(['row']), [{ value: 'alpha' }]);
});

test('redis-valkey physical keys separate prefix and logical key boundaries', async () => {
	const stored = new Map<string, string | Buffer>();
	const deleted: string[][] = [];
	const client = {
		mGet: async (keys: string[]) => keys.map((key) => stored.get(key) ?? null),
		mSet: async (entries: Record<string, string | Buffer>) => {
			for (const [key, value] of Object.entries(entries)) stored.set(key, value);
			return 'OK';
		},
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async (keys: string[]) => {
			deleted.push(keys);
			for (const key of keys) stored.delete(key);
			return keys.length;
		}
	};
	const first = await createRedisValkeyCacheAdapter({ client, prefix: 'a' });
	const second = await createRedisValkeyCacheAdapter({ client, prefix: 'a:b' });

	await first.setMany([['b:c', { value: 'first' }]]);
	assert.notEqual(first.codecKey!('b:c'), second.codecKey!('c'));
	assert.deepEqual(await second.getMany(['c']), [undefined]);
	await second.deleteMany(['c']);
	assert.deepEqual(await first.getMany(['b:c']), [{ value: 'first' }]);
	assert.deepEqual(deleted, [[second.codecKey!('c')]]);
});

test('redis-valkey validates expanded physical key length for direct and wrapped codecs', async () => {
	let writes = 0;
	const client = {
		mGet: async () => [],
		mSet: async () => {
			writes++;
			return 'OK';
		},
		multi: () => ({
			set() {
				writes++;
				return this;
			},
			exec: async () => []
		}),
		del: async () => undefined
	};
	const prefix = 'p'.repeat(2048);
	const logicalKey = 'k'.repeat(2048);
	const adapter = await createRedisValkeyCacheAdapter({ client, prefix });

	assert.throws(() => adapter.codecKey!(logicalKey), /redis-valkey physical cache key is too long/);
	await assert.rejects(
		() => adapter.setMany([[logicalKey, { value: 'too-long' }]]),
		/redis-valkey physical cache key is too long/
	);

	const wrapped = createCodecCacheAdapter(adapter, {
		name: 'physical-key-wrapper-codec',
		encode: (value) => value,
		decode: (value) => value
	});
	await assert.rejects(
		() => wrapped.setMany([[logicalKey, { value: 'too-long' }]]),
		/redis-valkey physical cache key is too long/
	);
	assert.equal(writes, 0);
});

test('redis-valkey default JSON packing ignores inherited toJSON', async () => {
	const stored = new Map<string, string | Buffer>();
	let objectToJsonCalls = 0;
	let arrayToJsonCalls = 0;
	const client = {
		mGet: async (keys: string[]) => keys.map((key) => stored.get(key) ?? null),
		mSet: async (entries: Record<string, string | Buffer>) => {
			for (const [key, value] of Object.entries(entries)) stored.set(key, value);
			return 'OK';
		},
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async (keys: string[]) => {
			for (const key of keys) stored.delete(key);
			return keys.length;
		}
	};
	const adapter = await createRedisValkeyCacheAdapter({ client });
	Object.defineProperty(Object.prototype, 'toJSON', {
		configurable: true,
		value() {
			objectToJsonCalls++;
			return { value: 'polluted' };
		}
	});
	Object.defineProperty(Array.prototype, 'toJSON', {
		configurable: true,
		value() {
			arrayToJsonCalls++;
			return { value: 'polluted' };
		}
	});
	try {
		await adapter.setMany([['row', { value: 'safe', nested: { flag: true }, items: ['a', 'b'] }]]);
	} finally {
		delete (Object.prototype as Record<string, unknown>).toJSON;
		delete (Array.prototype as unknown as Record<string, unknown>).toJSON;
	}

	assert.equal(objectToJsonCalls, 0);
	assert.equal(arrayToJsonCalls, 0);
	assert.equal(stored.get(adapter.codecKey!('row')), '{"value":"safe","nested":{"flag":true},"items":["a","b"]}');
	assert.deepEqual(await adapter.getMany(['row']), [{ value: 'safe', nested: { flag: true }, items: ['a', 'b'] }]);
});

test('redis-valkey default JSON packing ignores patched JSON intrinsics after import', async () => {
	const stored = new Map<string, string | Buffer>();
	const client = {
		mGet: async (keys: string[]) => keys.map((key) => stored.get(key) ?? null),
		mSet: async (entries: Record<string, string | Buffer>) => {
			for (const [key, value] of Object.entries(entries)) stored.set(key, value);
			return 'OK';
		},
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async (keys: string[]) => {
			for (const key of keys) stored.delete(key);
			return keys.length;
		}
	};
	const adapter = await createRedisValkeyCacheAdapter({ client });
	const originalStringify = JSON.stringify;
	const originalParse = JSON.parse;
	Object.defineProperty(JSON, 'stringify', {
		configurable: true,
		value() {
			throw new Error('patched JSON.stringify should not run for redis-valkey cache');
		}
	});
	Object.defineProperty(JSON, 'parse', {
		configurable: true,
		value() {
			throw new Error('patched JSON.parse should not run for redis-valkey cache');
		}
	});
	try {
		await adapter.setMany([['row', { value: 'safe', nested: { flag: true } }]]);
		assert.equal(stored.get(adapter.codecKey!('row')), '{"value":"safe","nested":{"flag":true}}');
		assert.deepEqual(await adapter.getMany(['row']), [{ value: 'safe', nested: { flag: true } }]);
	} finally {
		Object.defineProperty(JSON, 'stringify', { configurable: true, value: originalStringify });
		Object.defineProperty(JSON, 'parse', { configurable: true, value: originalParse });
	}
});

test('redis-valkey codec encoded payloads are validated before backend writes', async () => {
	const writes: Record<string, unknown>[] = [];
	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => [],
			mSet: async (entries: Record<string, unknown>) => {
				writes.push(entries);
				return 'OK';
			},
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => undefined
		},
		codec: {
			name: 'unsafe-redis-encode',
			encode: () => ({ encoded: true }) as any,
			decode: (value) => value
		}
	});

	await assert.rejects(
		() => adapter.setMany([['key', { value: 1 }]]),
		/codec encoded payload must be a string or Buffer/
	);
	assert.deepEqual(writes, []);
});

test('redis-valkey adapter normalizes malformed backend cache payloads', async () => {
	const validClient = {
		mGet: async () => ['{'],
		mSet: async () => undefined,
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async () => undefined
	};
	const malformedJson = await createRedisValkeyCacheAdapter({ client: validClient });
	await assert.rejects(() => malformedJson.getMany(['key']), /payload must be valid JSON/);

	const badShape = await createRedisValkeyCacheAdapter({
		client: {
			...validClient,
			mGet: async () => null as any
		}
	});
	await assert.rejects(() => badShape.getMany(['key']), /mGet result must be an array with 1 entries/);

	const badLength = await createRedisValkeyCacheAdapter({
		client: {
			...validClient,
			mGet: async () => []
		}
	});
	await assert.rejects(() => badLength.getMany(['key']), /mGet result must be an array with 1 entries/);

	const badPayload = await createRedisValkeyCacheAdapter({
		client: {
			...validClient,
			mGet: async () => [42 as any]
		}
	});
	await assert.rejects(() => badPayload.getMany(['key']), /payload must be a string, Buffer, or null/);
});

test('redis-valkey adapter rejects malformed factory options', async () => {
	const client = {
		mGet: async () => [],
		mSet: async () => undefined,
		multi: () => ({ set: () => undefined, exec: async () => undefined }),
		del: async () => undefined
	};

	await assert.rejects(
		() => createRedisValkeyCacheAdapter(null as any),
		/redis-valkey cache options must be an object/
	);
		await assert.rejects(
			() => createRedisValkeyCacheAdapter({ client: {} } as any),
			/client.mGet must be a function/
		);
		const hiddenClient = {
			mSet: async () => undefined,
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => undefined
		} as any;
		Object.defineProperty(hiddenClient, 'mGet', {
			enumerable: false,
			value: async () => []
		});
		await assert.rejects(
			() => createRedisValkeyCacheAdapter({ client: hiddenClient } as any),
			/redis-valkey cache client\.mGet must be enumerable/
		);
		await assert.rejects(
			() => createRedisValkeyCacheAdapter({ client, url: 1 as any }),
			/url must be a string/
	);
	await assert.rejects(
		() => createRedisValkeyCacheAdapter({ client, url: 'redis://localhost:6379' }),
		/redis-valkey cache options cannot combine client and url/
	);
	const hiddenRedisOptions = Object.defineProperty({ client }, 'url', {
		enumerable: false,
		value: 'redis://localhost:6379'
	});
	await assert.rejects(
		() => createRedisValkeyCacheAdapter(hiddenRedisOptions as any),
		/redis-valkey cache option "url" must be enumerable/
	);
		await assert.rejects(
			() => createRedisValkeyCacheAdapter({ client, codec: { name: 'bad', encode: null, decode: (value: unknown) => value } as any }),
			/codec encode must be a function/
		);
		const hiddenRedisCodec = {
			name: 'hidden-redis-codec',
			decode: (value: unknown) => value
		} as any;
		Object.defineProperty(hiddenRedisCodec, 'encode', {
			enumerable: false,
			value: (value: unknown) => value
		});
		await assert.rejects(
			() => createRedisValkeyCacheAdapter({ client, codec: hiddenRedisCodec }),
			/redis-valkey cache codec encode must be enumerable/
		);
		Object.defineProperties(Object.prototype, {
			mGet: { value: async () => [], configurable: true },
		mSet: { value: async () => undefined, configurable: true },
		multi: { value: () => ({ set: () => undefined, exec: async () => undefined }), configurable: true },
		del: { value: async () => undefined, configurable: true },
		name: { value: 'polluted-codec', configurable: true },
		encode: { value: (value: unknown) => value, configurable: true },
		decode: { value: (value: unknown) => value, configurable: true }
	});
	try {
		await assert.rejects(
			() => createRedisValkeyCacheAdapter({ client: {} } as any),
			/client.mGet must be a function/
		);
		await assert.rejects(
			() => createRedisValkeyCacheAdapter({ client, codec: {} as any }),
			/codec name must be a non-empty string/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).mGet;
		delete (Object.prototype as Record<string, unknown>).mSet;
		delete (Object.prototype as Record<string, unknown>).multi;
		delete (Object.prototype as Record<string, unknown>).del;
		delete (Object.prototype as Record<string, unknown>).name;
		delete (Object.prototype as Record<string, unknown>).encode;
		delete (Object.prototype as Record<string, unknown>).decode;
	}
});

test('redis-valkey adapter snapshots client and codec methods at creation', async () => {
	const calls: string[] = [];
	const stored = new Map<string, string>();
	const client = {
		mGet: async (keys: string[]) => {
			calls.push('mGet');
			return keys.map((key) => stored.get(key) ?? null);
		},
		mSet: async (entries: Record<string, string>) => {
			calls.push('mSet');
			for (const [key, value] of Object.entries(entries)) stored.set(key, value);
			return 'OK';
		},
		multi: () => {
			calls.push('multi');
			const queued: Array<[string, string]> = [];
			return {
				set: (key: string, value: string) => {
					calls.push('multi.set');
					queued.push([key, value]);
				},
				exec: async () => {
					calls.push('multi.exec');
					for (const [key, value] of queued) stored.set(key, value);
					return queued.map(() => 'OK');
				}
			};
		},
		del: async (keys: string[]) => {
			calls.push('del');
			for (const key of keys) stored.delete(key);
			return keys.length;
		}
	};
	const codec = {
		name: 'snapshot-redis-codec',
		encode: async (value: unknown) => {
			calls.push('encode');
			return `encoded:${JSON.stringify(value)}`;
		},
		decode: async (value: string | Buffer) => {
			calls.push('decode');
			return JSON.parse(String(value).slice('encoded:'.length));
		}
	};
	const adapter = await createRedisValkeyCacheAdapter({ client, codec, prefix: 'tenant' });
	client.mGet = async () => {
		throw new Error('mutated redis mGet should not run');
	};
	client.mSet = async () => {
		throw new Error('mutated redis mSet should not run');
	};
	client.multi = () => {
		throw new Error('mutated redis multi should not run');
	};
	client.del = async () => {
		throw new Error('mutated redis del should not run');
	};
	codec.encode = async () => {
		throw new Error('mutated redis codec encode should not run');
	};
	codec.decode = async () => {
		throw new Error('mutated redis codec decode should not run');
	};

	await adapter.setMany([['plain', { value: 1 }]]);
	await adapter.setMany([['ttl', { value: 2 }]], { ttl: 1 });
	assert.deepEqual(await adapter.getMany(['plain', 'ttl']), [{ value: 1 }, { value: 2 }]);
	await adapter.deleteMany(['plain']);
	assert.equal(stored.has('tenant:plain'), false);
	assert.deepEqual(calls, ['encode', 'mSet', 'multi', 'encode', 'multi.set', 'multi.exec', 'mGet', 'decode', 'decode', 'del']);
});

test('redis-valkey adapter rejects malformed multi results', async () => {
	const hiddenMultiClient = {
		mGet: async () => [],
		mSet: async () => undefined,
		multi: () =>
			Object.defineProperty({ exec: async () => undefined }, 'set', {
				enumerable: false,
				value: () => undefined
			}),
		del: async () => undefined
	};
	const hiddenMultiAdapter = await createRedisValkeyCacheAdapter({ client: hiddenMultiClient });
	await assert.rejects(
		() => hiddenMultiAdapter.setMany([['ttl', 'value']], { ttl: 1 }),
		/redis-valkey cache multi\.set must be enumerable/
	);

	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => [],
			mSet: async () => undefined,
			multi: () => ({}),
			del: async () => undefined
		}
	});
	Object.defineProperties(Object.prototype, {
		set: { value: () => undefined, configurable: true },
		exec: { value: async () => undefined, configurable: true }
	});
	try {
		await assert.rejects(
			() => adapter.setMany([['ttl', 'value']], { ttl: 1 }),
			/redis-valkey cache multi.set must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).set;
		delete (Object.prototype as Record<string, unknown>).exec;
	}
});

test('redis-valkey adapter rejects failed write acknowledgements', async () => {
	for (const reply of [undefined, null]) {
		const failedMSet = await createRedisValkeyCacheAdapter({
			client: {
				mGet: async () => [],
				mSet: async () => reply,
				multi: () => ({ set: () => undefined, exec: async () => undefined }),
				del: async () => 0
			}
		});
		await assert.rejects(
			() => failedMSet.setMany([['plain', 'value']]),
			/redis-valkey cache mSet acknowledgement failed/
		);
	}

	for (const reply of [undefined, null]) {
		const failedExec = await createRedisValkeyCacheAdapter({
			client: {
				mGet: async () => [],
				mSet: async () => 'OK',
				multi: () => ({ set: () => undefined, exec: async () => reply }),
				del: async () => 0
			}
		});
		await assert.rejects(
			() => failedExec.setMany([['ttl', 'value']], { ttl: 1 }),
			/redis-valkey cache multi\.exec result must be an array/
		);
	}

	const shortExec = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => [],
			mSet: async () => 'OK',
			multi: () => ({ set: () => undefined, exec: async () => [] }),
			del: async () => 0
		}
	});
	await assert.rejects(
		() => shortExec.setMany([['ttl', 'value']], { ttl: 1 }),
		/redis-valkey cache multi\.exec result must contain 1 replies/
	);

	const errorExec = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => [],
			mSet: async () => 'OK',
			multi: () => ({ set: () => undefined, exec: async () => [new Error('write failed')] }),
			del: async () => 0
		}
	});
	await assert.rejects(
		() => errorExec.setMany([['ttl', 'value']], { ttl: 1 }),
		/redis-valkey cache multi\.exec reply returned an error/
	);

	for (const reply of [undefined, null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		const failedDel = await createRedisValkeyCacheAdapter({
			client: {
				mGet: async () => [],
				mSet: async () => 'OK',
				multi: () => ({ set: () => undefined, exec: async () => undefined }),
				del: async () => reply
			}
		});
		await assert.rejects(
			() => failedDel.deleteMany(['plain']),
			/redis-valkey cache del acknowledgement failed/
		);
	}
	const errorDel = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => [],
			mSet: async () => 'OK',
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => new Error('delete failed')
		}
	});
	await assert.rejects(
		() => errorDel.deleteMany(['plain']),
		/redis-valkey cache del returned an error/
	);
});

test('redis-valkey adapter validates direct cache operation shapes', async () => {
	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => [],
			mSet: async () => undefined,
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => undefined
		}
	});

	await assert.rejects(() => adapter.getMany(null as any), /redis-valkey cache keys must be an array/);
	await assert.rejects(() => adapter.getMany(['x'.repeat(4097)]), /redis-valkey cache keys\[0\] is too long/);
	await assert.rejects(() => adapter.deleteMany(null as any), /redis-valkey cache keys must be an array/);
	await assert.rejects(() => adapter.setMany(null as any), /redis-valkey cache entries must be an array/);
	await assert.rejects(() => adapter.setMany(['bad-entry'] as any), /redis-valkey cache entries must contain/);
	await assert.rejects(
		() => adapter.setMany([['bad-options', 'value']], null as any),
		/redis-valkey cache write options/
	);
	await assert.rejects(
		() => adapter.setMany([['bad-options', 'value']], new Date('2026-05-14T00:00:00.000Z') as any),
		/redis-valkey cache write options must be a plain object/
	);
	let getterCalls = 0;
	const accessorOptions = Object.defineProperty({}, 'ttl', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(
		() => adapter.setMany([['accessor-options', 'value']], accessorOptions as any),
		/ttl must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenOptions = Object.defineProperty({}, 'ttl', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => adapter.setMany([['hidden-options', 'value']], hiddenOptions as any),
		/ttl must be enumerable/
	);
	await assert.rejects(
		() => adapter.setMany([['symbol-options', 'value']], { [Symbol('ttl')]: 1 } as any),
		/redis-valkey cache write options cannot contain symbol fields/
	);
	await assert.rejects(
		() => adapter.setMany([['unknown-options', 'value']], { ttll: 1 } as any),
		/redis-valkey cache write options contains unknown option "ttll"/
	);
	await assert.rejects(
		() => adapter.setMany([['fractional-ttl', 'value']], { ttl: 0.5 }),
		/positive number and safe integer/
	);
});

test('redis-valkey adapter snapshots cache arrays before client calls', async () => {
	let mapCalls = 0;
	const result = ['"value"'] as any[];
	Object.defineProperty(result, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom redis result map should not run');
		}
	});
	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async () => result,
			mSet: async () => 'OK',
			multi: () => ({ set: () => undefined, exec: async () => undefined }),
			del: async () => 0
		}
	});
	const keys = ['redis-array-key'] as any[];
	Object.defineProperty(keys, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom redis key map should not run');
		}
	});
	const entries = [['redis-array-key', 'value']] as any[];
	Object.defineProperty(entries, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom redis entries map should not run');
		}
	});

	await adapter.setMany(entries);
	assert.deepEqual(await adapter.getMany(keys as string[]), ['value']);
	await adapter.deleteMany(keys as string[]);

	assert.equal(mapCalls, 0);
});

test('redis-valkey adapter direct operations ignore patched Array map', async () => {
	const stored = new Map<string, string | Buffer>();
	const adapter = await createRedisValkeyCacheAdapter({
		client: {
			mGet: async (keys: string[]) => {
				const result: Array<string | Buffer | null> = [];
				for (let index = 0; index < keys.length; index++) {
					result[index] = stored.get(keys[index]) ?? null;
				}
				return result;
			},
			mSet: async (entries: Record<string, string | Buffer>) => {
				for (const key of Object.getOwnPropertyNames(entries)) {
					stored.set(key, entries[key]);
				}
				return 'OK';
			},
			multi: () => ({
				set() {
					return this;
				},
				exec: async () => []
			}),
			del: async (keys: string[]) => {
				for (let index = 0; index < keys.length; index++) {
					stored.delete(keys[index]);
				}
				return keys.length;
			}
		}
	});
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	let hit: unknown[] = [];
	let miss: unknown[] = [];
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	try {
		await adapter.setMany([['redis-global-map-key', { ok: true }]]);
		hit = await adapter.getMany(['redis-global-map-key']);
		await adapter.deleteMany(['redis-global-map-key']);
		miss = await adapter.getMany(['redis-global-map-key']);
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
	}

	assert.deepEqual(hit, [{ ok: true }]);
	assert.deepEqual(miss, [undefined]);
});

test('configured cache registries fail fast on missing adapter names', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed('cache_regression_record', [{ id: 14, value: 'store' }]);
	const context = createActiveTs({
		stores: { default: store },
		caches: { other: new MemoryCacheAdapter() }
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;

	await assert.rejects(() => Record.find(14).load(), /Cache adapter "default" is not registered/);

	let calls = 0;
	const lookup = createFunctionCache<string, string>({
		prefix: 'cache-regression-missing-adapter',
		context,
		cache: 'missing',
		factory: async () => {
			calls++;
			return 'value';
		}
	});
	await assert.rejects(() => lookup.get('key'), /Cache adapter "missing" is not registered/);
	assert.equal(calls, 0);
});

test('field codec encode failures do not reach store writes', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ThrowingCodecRecord.use(context) as unknown as typeof ThrowingCodecRecord;

	await assert.rejects(
		() => Record.create({ id: 1, value: 'plain' }),
		(error) =>
			error instanceof ActiveTsValidationError &&
			/Field codec "throwing-field-codec" write failed/.test(error.message) &&
			/field encode failed/.test(error.message)
	);
	assert.equal(store.createCalls, 0);
	assert.deepEqual(store.dump('throwing_codec_record'), []);
});

test('field codec undefined results are rejected instead of pruning fields', async () => {
	const encodeStore = new TrackingStore();
	const encodeContext = createActiveTs({ stores: { default: encodeStore } });
	const UndefinedEncodeRecord = UndefinedEncodeCodecRecord.use(encodeContext) as unknown as typeof UndefinedEncodeCodecRecord;
	await assert.rejects(
		() => UndefinedEncodeRecord.create({ id: 1, value: 'plain' }),
		/Field codec "undefined-encode" write returned undefined/
	);
	assert.equal(encodeStore.createCalls, 0);
	assert.deepEqual(encodeStore.dump('undefined_encode_codec_record'), []);

	const decodeStore = new MemoryStoreAdapter();
	const decodeContext = createActiveTs({ stores: { default: decodeStore } });
	const UndefinedDecodeRecord = UndefinedDecodeCodecRecord.use(decodeContext) as unknown as typeof UndefinedDecodeCodecRecord;
	await decodeStore.seed('undefined_decode_codec_record', [{ id: 1, value: 'stored' }]);
	await assert.rejects(
		() => UndefinedDecodeRecord.find(1).load(),
		/Field codec "undefined-decode" read returned undefined/
	);
});

test('field codec decode failures and unsafe decoded keys reject reads', async () => {
	const failingStore = new MemoryStoreAdapter();
	const failingContext = createActiveTs({ stores: { default: failingStore } });
	const ThrowingRecord = ThrowingCodecRecord.use(failingContext) as unknown as typeof ThrowingCodecRecord;
	await failingStore.seed('throwing_codec_record', [{ id: 1, value: 'stored' }]);
	await assert.rejects(
		() => ThrowingRecord.find(1).load(),
		(error) =>
			error instanceof ActiveTsValidationError &&
			/Field codec "throwing-field-codec" read failed/.test(error.message) &&
			/field decode failed/.test(error.message)
	);

	const unsafeStore = new MemoryStoreAdapter();
	const unsafeContext = createActiveTs({ stores: { default: unsafeStore } });
	const UnsafeRecord = UnsafeDecodedRecord.use(unsafeContext) as unknown as typeof UnsafeDecodedRecord;
	await unsafeStore.seed('unsafe_decoded_record', [{ id: 1, payload: 'encoded' }]);
	await assert.rejects(() => UnsafeRecord.find(1).load(), /Reserved data key/);
});

test('field codec query failures and unsafe query encodings fail before adapter execution', async () => {
	const throwingStore = new MemoryStoreAdapter();
	const throwingContext = createActiveTs({ stores: { default: throwingStore } });
	const ThrowingRecord = ThrowingQueryCodecRecord.use(throwingContext) as unknown as typeof ThrowingQueryCodecRecord;

	await assert.rejects(
		() => ThrowingRecord.where({ token: 'plain' }).load(),
		(error) =>
			error instanceof ActiveTsValidationError &&
			/Field codec "throwing-query-field-codec" query failed/.test(error.message) &&
			/query encode failed/.test(error.message)
	);

	const unsafeStore = new MemoryStoreAdapter();
	const unsafeContext = createActiveTs({ stores: { default: unsafeStore } });
	const UnsafeRecord = UnsafeQueryCodecRecord.use(unsafeContext) as unknown as typeof UnsafeQueryCodecRecord;

	await assert.rejects(
		() => UnsafeRecord.where({ token: 'plain' }).load(),
		/Query operator "=" on "token" requires string, number, boolean, Date, or null values/
	);
});

test('field codec null operators fail fast before adapter execution', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = QueryableCodecRecord.use(context) as unknown as typeof QueryableCodecRecord;
	const meta = context.meta(QueryableCodecRecord);

	await assert.rejects(
		() => Record.where({ token: ['isNull'] as any }).load(),
		/does not support portable null operators/
	);
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'token', op: 'isNotNull', value: undefined }],
				or: [],
				sort: [],
				include: []
			}),
		/does not support portable null operators/
	);
	assert.equal(store.stats.query, 0);
});

test('field codec parent query overlaps fail fast before adapter execution', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = NestedCodecRecord.use(context) as unknown as typeof NestedCodecRecord;
	const meta = context.meta(NestedCodecRecord);

	await assert.rejects(
		() => Record.where({ profile: ['jsonContains', { secret: NESTED_CODEC_VALUE }] } as any).load(),
		/Field codec "nested-base64" on nested_codec_record\.profile\.secret overlaps query field "profile"/
	);
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'profile', op: 'jsonContains', value: { secret: NESTED_CODEC_VALUE } }],
				or: [],
				sort: [],
				include: []
			}),
		/Field codec "nested-base64" on nested_codec_record\.profile\.secret overlaps query field "profile"/
	);
	assert.equal(store.stats.query, 0);
});

test('field codec child aggregate overlaps require decoded fallback or reject direct stores', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ParentCodecRecord.use(context) as unknown as typeof ParentCodecRecord;
	const meta = context.meta(ParentCodecRecord);

	await assert.rejects(
		() => Record.query().sum('profile.score' as any),
		/Aggregates on field-codec fields require aggregate\.allowQueryFallback/
	);
	await assert.rejects(
		() =>
			store.aggregate(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'profile.score', as: 'sum' }]
			}),
		/memory aggregate cannot aggregate field "profile\.score" because it overlaps field-codec field "profile"/
	);
	assert.equal(store.stats.aggregate, 0);
});

test('cache codec encode failures leave underlying cache untouched', async () => {
	const rawCache = new MemoryCacheAdapter();
	const cache = createCodecCacheAdapter(rawCache, {
		name: 'sometimes-throwing-codec',
		encode(value) {
			if (value === 'bad') throw new Error('cache encode failed');
			return `encoded:${String(value)}`;
		},
		decode: (value) => value
	});

	await assert.rejects(
		() => cache.setMany([['first', 'ok'], ['second', 'bad']]),
		/cache encode failed/
	);
	assert.deepEqual(rawCache.snapshot(), {});
});

test('cache adapter contract rejects setMany input retention', async () => {
	await assert.rejects(
		() => runCacheAdapterContract(new ReferenceRetainingCacheAdapter()),
		/cache setMany must not retain input value object references/
	);
});

test('cache adapters reject undefined values and non-positive TTLs', async () => {
	const cache = new MemoryCacheAdapter();
	await assert.rejects(() => cache.getMany(null as any), /memory cache keys must be an array/);
	await assert.rejects(() => cache.getMany(new Array(1) as any), /memory cache keys\[0\] is missing/);
	await assert.rejects(() => cache.deleteMany(null as any), /memory cache keys must be an array/);
	await assert.rejects(() => cache.setMany(null as any), /memory cache entries must be an array/);
	await assert.rejects(() => cache.setMany(new Array(1) as any), /memory cache entries\[0\] is missing/);
	await assert.rejects(() => cache.setMany(['bad-entry'] as any), /memory cache entries must contain/);
	let mapCalls = 0;
	const keysWithMap = ['snapshot-key'] as any[];
	Object.defineProperty(keysWithMap, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom key map should not run');
		}
	});
	const entriesWithMap = [['snapshot-key', 'value']] as any[];
	Object.defineProperty(entriesWithMap, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom entries map should not run');
		}
	});
	await cache.setMany(entriesWithMap);
	assert.deepEqual(await cache.getMany(keysWithMap as string[]), ['value']);
	assert.equal(mapCalls, 0);
	let valueForEachCalls = 0;
	const arrayValue = ['alpha', 'beta'] as any[];
	Object.defineProperty(arrayValue, 'forEach', {
		value() {
			valueForEachCalls++;
			throw new Error('custom cache value forEach should not run');
		}
	});
	await assert.rejects(
		() => cache.setMany([['array-value', arrayValue]]),
		/Unsupported data value at "\$" cannot contain non-index array property "forEach"/
	);
	assert.equal(valueForEachCalls, 0);
	const hiddenObjectValue = { visible: 'yes' };
	Object.defineProperty(hiddenObjectValue, 'hidden', { value: 'no', enumerable: false });
	await assert.rejects(
		() => cache.setMany([['hidden-object', hiddenObjectValue]]),
		/Unsupported non-enumerable data key "\$\.hidden"/
	);
	const hiddenArrayValue = ['alpha'] as any[];
	Object.defineProperty(hiddenArrayValue, '0', { enumerable: false, value: 'alpha' });
	await assert.rejects(
		() => cache.setMany([['hidden-array-index', hiddenArrayValue]]),
		/Unsupported data value at "\$\[0\]" must be enumerable/
	);
	await assert.rejects(
		() => cache.deleteMany(Object.assign(['snapshot-key'], { [Symbol('keys')]: true }) as any),
		/memory cache keys cannot contain symbol fields/
	);
	const sparseEntry = ['sparse-key'] as unknown[];
	sparseEntry.length = 2;
	await assert.rejects(
		() => cache.setMany([sparseEntry as [string, unknown]]),
		/memory cache entries\[0\]\[1\] is missing/
	);
	let getterCalls = 0;
	const accessorKeys = ['key'] as unknown[];
	Object.defineProperty(accessorKeys, '0', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'key';
		}
	});
	await assert.rejects(
		() => cache.getMany(accessorKeys as string[]),
		/memory cache keys\[0\] must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenOptions = Object.defineProperty({}, 'ttl', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => cache.setMany([['hidden-options', 'value']], hiddenOptions as any),
		/memory cache write options\.ttl must be enumerable/
	);

	const accessorEntry = ['key', 'value'] as unknown[];
	Object.defineProperty(accessorEntry, '1', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'value';
		}
	});
	await assert.rejects(
		() => cache.setMany([accessorEntry as [string, unknown]]),
		/memory cache entries\[0\]\[1\] must be a data property/
	);
	assert.equal(getterCalls, 0);
	await assert.rejects(() => cache.setMany([['bad-options', 'value']], null as any), /memory cache write options/);
	await assert.rejects(
		() => cache.setMany([['bad-options', 'value']], new Date('2026-05-14T00:00:00.000Z') as any),
		/memory cache write options must be a plain object/
	);
	const accessorWriteOptions = Object.defineProperty({}, 'ttl', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(
		() => cache.setMany([['accessor-options', 'value']], accessorWriteOptions as any),
		/memory cache write options\.ttl must be a data property/
	);
	assert.equal(getterCalls, 0);
	await assert.rejects(
		() => cache.setMany([['symbol-options', 'value']], { [Symbol('ttl')]: 1 } as any),
		/memory cache write options cannot contain symbol fields/
	);
	await assert.rejects(
		() => cache.setMany([['unknown-options', 'value']], { ttll: 1 } as any),
		/memory cache write options contains unknown option "ttll"/
	);
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
			() => cache.setMany([['unknown-options-set', 'value']], { ttll: 1 } as any),
			/memory cache write options contains unknown option "ttll"/
		);
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
	await assert.rejects(() => cache.getMany([{} as any]), /memory cache key must be a string/);
	await assert.rejects(() => cache.setMany([[{} as any, 'value']]), /memory cache entries\[0\] key must be a string/);
	await assert.rejects(
		() => cache.setMany([['bad\0key', 'value']]),
		/memory cache entries\[0\] key must not contain null bytes/
	);
	await assert.rejects(() => cache.setMany([['undefined', undefined]]), /Cache values cannot be undefined/);
	await assert.rejects(() => cache.setMany([['nested-undefined', { value: undefined }]]), /cannot contain undefined/);
	await assert.rejects(() => cache.setMany([['sparse-array', [1, , 3]]]), /Unsupported data value at "\$\[1\]"/);
	const accessorValue: Record<string, unknown> = {};
	Object.defineProperty(accessorValue, 'secret', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'value';
		}
	});
	await assert.rejects(
		() => cache.setMany([['accessor', accessorValue]]),
		/Unsupported data accessor at "\$\.secret"/
	);
	assert.equal(getterCalls, 0);
	await assert.rejects(() => cache.setMany([['date', new Date('2026-05-14T00:00:00.000Z')]]), /cannot contain Date/);
	await assert.rejects(() => cache.setMany([['binary', new Uint8Array([1, 2, 3])]]), /binary data/);
	const customDate = new Date('2026-05-14T00:00:00.000Z') as Date & { extra?: string };
	customDate.extra = 'dropped';
	await assert.rejects(
		() => cache.setMany([['custom-date', customDate]]),
		/Unsupported custom data key "\$\.extra"/
	);
	const customBinary = new Uint8Array([1, 2, 3]) as Uint8Array & { extra?: string };
	customBinary.extra = 'dropped';
	await assert.rejects(
		() => cache.setMany([['custom-binary', customBinary]]),
		/Unsupported custom data key "\$\.extra"/
	);
	await assert.rejects(() => cache.setMany([['bigint', 1n]]), /Unsupported data value/);
	await assert.rejects(() => cache.setMany([['zero-ttl', 'value']], { ttl: 0 }), /positive number/);
	await assert.rejects(
		() => cache.setMany([['fractional-ttl', 'value']], { ttl: 0.5 }),
		/positive number and safe integer/
	);
	let ttlCoercionCalls = 0;
	const hostileTtl = {
		toString() {
			ttlCoercionCalls++;
			throw new Error('ttl coercion should not run');
		}
	};
	await assert.rejects(
		() => cache.setMany([['object-ttl', 'value']], { ttl: hostileTtl as any }),
		/memory cache ttl must be a positive number and safe integer/
	);
	assert.equal(ttlCoercionCalls, 0);
	await assert.rejects(
		() => cache.setMany([['first-valid', 'ok'], ['second-date', new Date('2026-05-14T00:00:00.000Z')]]),
		/cannot contain Date/
	);
	assert.equal((cache.snapshot() as Record<string, unknown>)['first-valid'], undefined);

	const lookup = createFunctionCache<string, string | undefined>({
		prefix: 'cache-regression-defined-values',
		cache: false,
		factory: async () => undefined
	});
	await assert.rejects(() => lookup.get('missing'), /Cache values cannot be undefined/);
	const dateLookup = createFunctionCache<string, Date>({
		prefix: 'cache-regression-date-values',
		cache: false,
		factory: async () => new Date('2026-05-14T00:00:00.000Z')
	});
	await assert.rejects(() => dateLookup.get('date'), /cannot contain Date/);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-bad-ttl',
				cache: false,
				ttl: 0,
				factory: async () => 'value'
			}),
		/positive number/
	);
});

test('cache write options ignore inherited ttl values', async () => {
	const rawCache = new MemoryCacheAdapter();
	const codecCache = createCodecCacheAdapter(rawCache, {
		name: 'identity-cache-codec',
		encode: (value) => value,
		decode: (value) => value
	});

	Object.defineProperty(Object.prototype, 'ttl', {
		value: 1,
		configurable: true
	});
	try {
		await rawCache.setMany([['direct', 'value']], {});
		await rawCache.setMany([['defaulted', 'value']]);
		await codecCache.setMany([['codec', 'value']], {});
	} finally {
		delete (Object.prototype as Record<string, unknown>).ttl;
	}

	const snapshot = rawCache.snapshot() as Record<string, { expires?: number }>;
	assert.equal(snapshot.direct.expires, undefined);
	assert.equal(snapshot.defaulted.expires, undefined);
	assert.equal(snapshot.codec.expires, undefined);
});

test('memory cache snapshot omits expired TTL entries before reads', async () => {
	const cache = new MemoryCacheAdapter();
	const originalNow = Date.now;
	let now = new Date('2026-05-20T00:00:00.000Z').getTime();
	Date.now = () => now;
	try {
		await cache.setMany([['ttl-entry', 'expires']], { ttl: 1 });
		await cache.setMany([['plain-entry', 'stays']]);
		assert.deepEqual(Object.keys(cache.snapshot()).sort(), ['plain-entry', 'ttl-entry']);

		now += 1001;
		assert.deepEqual(cache.snapshot(), {
			'plain-entry': { value: 'stays', expires: undefined }
		});
		assert.deepEqual(await cache.getMany(['ttl-entry', 'plain-entry']), [undefined, 'stays']);
	} finally {
		Date.now = originalNow;
	}
});

test('memory cache snapshot ignores patched Array.from', async () => {
	const cache = new MemoryCacheAdapter();
	await cache.setMany([['array-from-entry', { ok: true }]]);
	const originalFrom = Array.from;
	let snapshot: ReturnType<MemoryCacheAdapter['snapshot']> | undefined;
	Object.defineProperty(Array, 'from', {
		configurable: true,
		value() {
			throw new Error('patched Array.from');
		}
	});
	try {
		snapshot = cache.snapshot();
	} finally {
		Object.defineProperty(Array, 'from', { configurable: true, value: originalFrom });
	}
	assert.deepEqual(snapshot, {
		'array-from-entry': { value: { ok: true }, expires: undefined }
	});
});

test('entity cache key resolvers must return safe string keys', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		cacheKey: (() => ({ key: 'bad' })) as any
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [{ id: 51, value: 'stored' }]);

	await assert.rejects(() => Record.find(51).load(), /cache key must be a string/);

	const nullByteContext = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		cacheKey: () => 'bad\0key'
	});
	const NullByteRecord = CacheRegressionRecord.use(nullByteContext) as unknown as typeof CacheRegressionRecord;
	await assert.rejects(() => NullByteRecord.find(51).load(), /cache key must not contain null bytes/);
});

test('entity cache key resolver collisions and non-determinism fail fast', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const collisionContext = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		cacheKey: ({ id }) => id === 1 || id === 2 ? 'same-physical-key' : `cache:${String(id)}`
	});
	const CollisionRecord = CacheRegressionRecord.use(collisionContext) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	assert.equal((await CollisionRecord.find(1).load())?.data.value, 'one');
	await assert.rejects(
		() => CollisionRecord.find(2).load(),
		/Entity cache key "same-physical-key" is already associated/
	);

	let suffix = 0;
	const unstableContext = createActiveTs({
		stores: { default: store },
		caches: { default: new MemoryCacheAdapter() },
		cacheKey: ({ id }) => `unstable:${String(id)}:${++suffix}`
	});
	const UnstableRecord = CacheRegressionRecord.use(unstableContext) as unknown as typeof CacheRegressionRecord;
	await assert.rejects(
		async () => {
			await UnstableRecord.find(1).load();
			await UnstableRecord.find(1).load();
		},
		/Cache key resolvers must be deterministic/
	);
});

test('entity cache keys isolate same-named models across stores', async () => {
	class PrimaryRecord extends Model<CacheRegressionData> {}
	class ArchiveRecord extends Model<CacheRegressionData> {}
	defineModel<CacheRegressionData>({
		name: 'cross_store_cache_record',
		store: 'primary',
		cache: { ttl: 60 }
	})
		.id('id')
		.validate((input) => input as CacheRegressionData)
		.attach(PrimaryRecord);
	defineModel<CacheRegressionData>({
		name: 'cross_store_cache_record',
		store: 'archive',
		cache: { ttl: 60 }
	})
		.id('id')
		.validate((input) => input as CacheRegressionData)
		.attach(ArchiveRecord);

	const primary = new MemoryStoreAdapter();
	const archive = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		defaultStore: 'primary',
		stores: { primary, archive },
		caches: { default: cache }
	});
	await primary.seed(context.meta(PrimaryRecord), [{ id: 1, value: 'primary' }]);
	await archive.seed(context.meta(ArchiveRecord), [{ id: 1, value: 'archive' }]);

	const Primary = PrimaryRecord.use(context) as unknown as typeof PrimaryRecord;
	const Archive = ArchiveRecord.use(context) as unknown as typeof ArchiveRecord;
	assert.equal((await Primary.find(1).load())?.data.value, 'primary');
	assert.equal((await Archive.find(1).load())?.data.value, 'archive');
	assert.equal(primary.stats.getMany, 1);
	assert.equal(archive.stats.getMany, 1);
	const keys = Object.keys(cache.snapshot()).sort();
	assert.equal(keys.length, 2);
	assert.ok(keys.includes('cross_store_cache_record:number:1'));
	assert.match(
		keys.find((key) => key !== 'cross_store_cache_record:number:1') ?? '',
		/^store:7:archive:local-scope:\d+:local-\d+:cross_store_cache_record:number:1$/
	);
});

test('custom entity cache keys cannot collapse same-named models across stores', async () => {
	class PrimaryRecord extends Model<CacheRegressionData> {}
	class ArchiveRecord extends Model<CacheRegressionData> {}
	defineModel<CacheRegressionData>({ name: 'custom_cross_store_cache_record', store: 'primary', cache: {} })
		.id('id')
		.validate((input) => input as CacheRegressionData)
		.attach(PrimaryRecord);
	defineModel<CacheRegressionData>({ name: 'custom_cross_store_cache_record', store: 'archive', cache: {} })
		.id('id')
		.validate((input) => input as CacheRegressionData)
		.attach(ArchiveRecord);

	const primary = new MemoryStoreAdapter();
	const archive = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		defaultStore: 'primary',
		stores: { primary, archive },
		caches: { default: cache },
		cacheKey: ({ model, id }) => `${model.name}:${typeof id}:${String(id)}`
	});
	await primary.seed(context.meta(PrimaryRecord), [{ id: 1, value: 'primary' }]);
	await archive.seed(context.meta(ArchiveRecord), [{ id: 1, value: 'archive' }]);
	const Primary = PrimaryRecord.use(context) as unknown as typeof PrimaryRecord;
	const Archive = ArchiveRecord.use(context) as unknown as typeof ArchiveRecord;

	assert.equal((await Primary.find(1).load())?.data.value, 'primary');
	assert.equal((await Archive.find(1).load())?.data.value, 'archive');
	assert.equal(archive.stats.getMany, 1);
	assert.equal(Object.keys(cache.snapshot()).length, 2);
});

test('entity cache scopes isolate positive and negative entries across store instances', async () => {
	class ScopedCacheRecord extends Model<CacheRegressionData> {}
	defineModel<CacheRegressionData>({ name: 'store_instance_cache_record', cache: { negativeTtl: 60 } })
		.id('id')
		.validate((input) => input as CacheRegressionData)
		.attach(ScopedCacheRecord);

	const tenantA = new MemoryStoreAdapter();
	const tenantB = new MemoryStoreAdapter();
	Object.defineProperty(tenantA, 'cacheScope', { value: 'tenant:a', enumerable: true, configurable: true });
	Object.defineProperty(tenantB, 'cacheScope', { value: 'tenant:b', enumerable: true, configurable: true });
	const cache = new MemoryCacheAdapter();
	const observedBaseKeys: string[] = [];
	const config = (store: MemoryStoreAdapter) => createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		cacheKey: ({ baseKey }) => {
			observedBaseKeys.push(baseKey);
			return baseKey;
		}
	});
	const contextA = config(tenantA);
	const contextB = config(tenantB);
	await tenantA.seed(contextA.meta(ScopedCacheRecord), [{ id: 1, value: 'tenant-a' }]);
	await tenantB.seed(contextB.meta(ScopedCacheRecord), [
		{ id: 1, value: 'tenant-b' },
		{ id: 2, value: 'tenant-b-only' }
	]);
	const RecordA = ScopedCacheRecord.use(contextA) as unknown as typeof ScopedCacheRecord;
	const RecordB = ScopedCacheRecord.use(contextB) as unknown as typeof ScopedCacheRecord;

	assert.equal((await RecordA.find(1).load())?.data.value, 'tenant-a');
	assert.equal((await RecordB.find(1).load())?.data.value, 'tenant-b');
	assert.equal(await RecordA.find(2).load(), null);
	assert.equal((await RecordB.find(2).load())?.data.value, 'tenant-b-only');
	assert.equal(tenantA.stats.getMany, 2);
	assert.equal(tenantB.stats.getMany, 2);
	assert.equal(new Set(observedBaseKeys).size, 4);
	assert.ok(observedBaseKeys.some((key) => key.includes('scope:8:tenant:a')));
	assert.ok(observedBaseKeys.some((key) => key.includes('scope:8:tenant:b')));
});

test('store cache scopes and Datastore namespaces must be non-empty safe strings', () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'cacheScope', { value: '', enumerable: true, configurable: true });
	assert.throws(
		() => createActiveTs({ stores: { default: store } }),
		/store adapter name "default"\.cacheScope must be a non-empty string without null bytes/
	);
	const datastoreStore = new MemoryStoreAdapter();
	Object.defineProperty(datastoreStore, 'datastoreNamespace', {
		value: '',
		enumerable: true,
		configurable: true
	});
	assert.throws(
		() => createActiveTs({ stores: { default: datastoreStore } }),
		/store adapter name "default"\.datastoreNamespace must be a non-empty string without null bytes/
	);
	const projectStore = new MemoryStoreAdapter();
	Object.defineProperty(projectStore, 'datastoreProjectId', {
		value: '',
		enumerable: true,
		configurable: true
	});
	assert.throws(
		() => createActiveTs({ stores: { default: projectStore } }),
		/store adapter name "default"\.datastoreProjectId must be a non-empty string without null bytes/
	);
});

test('entity cacheKey resolver is skipped when no cache adapter is registered', async () => {
	const store = new TrackingStore();
	const context = createActiveTs({
		stores: { default: store },
		cacheKey() {
			throw new Error('cacheKey should not run');
		}
	});
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	await store.seed('cache_regression_record', [{ id: 41, value: 'stored' }]);

	assert.equal((await Record.find(41).load())?.data.value, 'stored');
	await Record.create({ id: 42, value: 'created' });
	assert.equal((await Record.find(42).load())?.data.value, 'created');
});

test('function cache stale-while-revalidate keeps stale value after refresh failure and later recovers', async () => {
	let now = 0;
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		let calls = 0;
		const lookup = createFunctionCache<string, string>({
			prefix: 'cache-regression-swr',
			cache: false,
			ttl: 1,
			staleWhileRevalidate: 5,
			factory: async (key) => {
				calls++;
				if (calls === 2) throw new Error('refresh failed');
				return `${key}:${calls}`;
			}
		});

		assert.equal(await lookup.get('item'), 'item:1');
		now = 1500;

		assert.equal(await lookup.get('item'), 'item:1');
		await flushBackground();
		assert.equal(calls, 2);

		assert.equal(await lookup.get('item'), 'item:1');
		await flushBackground();
		assert.equal(calls, 3);
		assert.equal(await lookup.get('item'), 'item:3');
	} finally {
		Date.now = originalNow;
	}
});

test('function cache coalesces concurrent calls after async key resolution', async () => {
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-async-key',
		cache: false,
		key: async (value) => {
			await Promise.resolve();
			return `shared:${value % 2}`;
		},
		factory: async (value) => {
			calls++;
			await gate;
			return `value:${value}`;
		}
	});

	const first = lookup.get(1);
	const second = lookup.get(3);
	release();

	assert.deepEqual(await Promise.all([first, second]), ['value:1', 'value:1']);
	assert.equal(calls, 1);
});

test('function cache singleflight covers slow persistent cache misses', async () => {
	class BlockingMissCache {
		readonly kind = 'blocking-miss-cache';
		getManyCalls = 0;
		private readonly pending: Array<() => void> = [];

		async getMany() {
			this.getManyCalls++;
			await new Promise<void>((resolve) => this.pending.push(resolve));
			return [undefined];
		}

		async setMany() {}

		async deleteMany() {}

		pendingReads() {
			return this.pending.length;
		}

		releaseAll() {
			this.pending.splice(0).forEach((resolve) => resolve());
		}
	}

	const cache = new BlockingMissCache();
	let factoryCalls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-persistent-singleflight',
		context: createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			caches: { default: cache }
		}),
		factory: async (value) => `value:${value}:${++factoryCalls}`
	});

	const first = lookup.get(1);
	const second = lookup.get(1);
	for (let attempt = 0; attempt < 5 && cache.pendingReads() === 0; attempt++) await flushBackground();
	const observedCacheReads = cache.getManyCalls;
	cache.releaseAll();

	assert.deepEqual(await Promise.all([first, second]), ['value:1:1', 'value:1:1']);
	assert.equal(observedCacheReads, 1);
	assert.equal(factoryCalls, 1);
});

test('function cache refresh does not join non-refresh persistent hits', async () => {
	class BlockingHitCache {
		readonly kind = 'blocking-hit-cache';
		getManyCalls = 0;
		setManyCalls = 0;
		private readonly pending: Array<() => void> = [];

		async getMany() {
			this.getManyCalls++;
			await new Promise<void>((resolve) => this.pending.push(resolve));
			return ['cached'];
		}

		async setMany() {
			this.setManyCalls++;
		}

		async deleteMany() {}

		pendingReads() {
			return this.pending.length;
		}

		releaseAll() {
			this.pending.splice(0).forEach((resolve) => resolve());
		}
	}

	const cache = new BlockingHitCache();
	let factoryCalls = 0;
	const lookup = createFunctionCache<string, string>({
		prefix: 'cache-regression-refresh-singleflight',
		cache,
		memory: false,
		factory: async () => `fresh:${++factoryCalls}`
	});

	const normal = lookup.get('row');
	for (let attempt = 0; attempt < 5 && cache.pendingReads() === 0; attempt++) await flushBackground();
	assert.equal(cache.pendingReads(), 1);

	const refresh = lookup.get('row', { refresh: true });
	assert.equal(await refresh, 'fresh:1');
	cache.releaseAll();

	assert.equal(await normal, 'cached');
	assert.equal(factoryCalls, 1);
	assert.equal(cache.getManyCalls, 1);
	assert.equal(cache.setManyCalls, 1);
});

test('function cache validates cache getMany results before factory fallback', async () => {
	let calls = 0;
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const cache = {
		kind: 'bad-function-cache',
		getMany: async () => null as any,
		setMany: async () => undefined,
		deleteMany: async () => undefined
	};
	const lookup = createFunctionCache<number, string>({
		prefix: 'badcache',
		context,
		cache,
		factory: async () => {
			calls++;
			return 'computed';
		}
	});

	await assert.rejects(
		() => lookup.get(1),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Function cache adapter "bad-function-cache" getMany result/.test(error.message)
	);
	assert.equal(calls, 0);

	const sparseCache = {
		kind: 'sparse-function-cache',
		getMany: async () => new Array(1) as any,
		setMany: async () => undefined,
		deleteMany: async () => undefined
	};
	const sparseLookup = createFunctionCache<number, string>({
		prefix: 'sparse-badcache',
		context,
		cache: sparseCache,
		factory: async () => 'computed'
	});
	await assert.rejects(() => sparseLookup.get(1), /sparse-function-cache" getMany result\[0\] is missing/);

	let iteratorCalls = 0;
	let iteratorFactoryCalls = 0;
	const iteratorCache = {
		kind: 'iterator-function-cache',
		getMany: async () => {
			const rows = [undefined] as any[];
			Object.defineProperty(rows, Symbol.iterator, {
				value() {
					iteratorCalls++;
					throw new Error('custom function-cache result iterator should not run');
				}
			});
			return rows;
		},
		setMany: async () => undefined,
		deleteMany: async () => undefined
	};
	const iteratorLookup = createFunctionCache<number, string>({
		prefix: 'iterator-badcache',
		context,
		cache: iteratorCache,
		factory: async () => {
			iteratorFactoryCalls++;
			return 'computed';
		}
	});
	await assert.rejects(
		() => iteratorLookup.get(1),
		/iterator-function-cache" getMany result cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	assert.equal(iteratorFactoryCalls, 0);
});

test('function cache stable keys reject unsupported object values and circular input', async () => {
	let calls = 0;
	const lookup = createFunctionCache<Record<string, unknown>, string>({
		prefix: 'cache-regression-stable-key-fuzz',
		cache: false,
		factory: async () => `value:${++calls}`
	});

	await assert.rejects(
		() => lookup.get({ a: 1, b: undefined, c: Symbol('skip'), d: () => 'skip' }),
		(error: unknown) => error instanceof ActiveTsValidationError && /JSON-like inputs/.test(error.message)
	);
	assert.equal(await lookup.get({ a: 1 }), 'value:1');
	assert.equal(calls, 1);

	await assert.rejects(() => lookup.get(new Map([['a', 1]]) as any), /JSON-like inputs/);
	await assert.rejects(() => lookup.get(/unsafe/ as any), /JSON-like inputs/);
	await assert.rejects(() => lookup.get({ a: Number.NaN }), /JSON-like inputs/);
	await assert.rejects(() => lookup.get([, 1] as any), /JSON-like inputs/);
	let getterCalls = 0;
	const accessorInput: Record<string, unknown> = {};
	Object.defineProperty(accessorInput, 'a', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(() => lookup.get(accessorInput), /JSON-like inputs/);
	assert.equal(getterCalls, 0);
	const hiddenInput = Object.defineProperty({}, 'a', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(() => lookup.get(hiddenInput), /JSON-like inputs/);
	assert.equal(calls, 1);

	const accessorArray = [1, 2] as unknown[];
	Object.defineProperty(accessorArray, '0', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(() => lookup.get(accessorArray as any), /JSON-like inputs/);
	assert.equal(getterCalls, 0);
	const metadataArray = [1] as any[];
	Object.defineProperty(metadataArray, 'meta', {
		enumerable: false,
		value: 2
	});
	await assert.rejects(() => lookup.get(metadataArray as any), /JSON-like inputs/);
	const hiddenIndexArray = [1] as any[];
	Object.defineProperty(hiddenIndexArray, '0', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(() => lookup.get(hiddenIndexArray as any), /JSON-like inputs/);
	Object.defineProperty(Array.prototype, '0', {
		value: 'inherited',
		writable: true,
		configurable: true
	});
	try {
		await assert.rejects(() => lookup.get([, 1] as any), /JSON-like inputs/);
	} finally {
		delete (Array.prototype as unknown as Record<string, unknown>)['0'];
	}

	const circular: Record<string, unknown> = { a: 1 };
	circular.self = circular;
	await assert.rejects(
		() => lookup.get(circular),
		(error: unknown) => error instanceof ActiveTsValidationError && /circular input/.test(error.message)
	);
});

test('function cache default keys ignore polluted WeakSet cycle methods', async () => {
	const weakSetAdd = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'add')!;
	const weakSetHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'has')!;
	const weakSetDelete = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'delete')!;
	try {
		Object.defineProperty(WeakSet.prototype, 'add', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted weakset add');
			}
		});
		Object.defineProperty(WeakSet.prototype, 'has', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted weakset has');
			}
		});
		Object.defineProperty(WeakSet.prototype, 'delete', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted weakset delete');
			}
		});

		let calls = 0;
		const lookup = createFunctionCache<Record<string, unknown>, string>({
			prefix: 'cache-regression-weakset-intrinsic-key',
			cache: false,
			factory: async () => `value:${++calls}`
		});
		assert.equal(await lookup.get({ nested: { value: 1 } }), 'value:1');
		assert.equal(await lookup.get({ nested: { value: 1 } }), 'value:1');
		assert.equal(calls, 1);

		const circular: Record<string, unknown> = { value: 1 };
		circular.self = circular;
		await assert.rejects(
			() => lookup.get(circular),
			(error: unknown) => error instanceof ActiveTsValidationError && /circular input/.test(error.message)
		);
	} finally {
		Object.defineProperty(WeakSet.prototype, 'add', weakSetAdd);
		Object.defineProperty(WeakSet.prototype, 'has', weakSetHas);
		Object.defineProperty(WeakSet.prototype, 'delete', weakSetDelete);
	}
});

test('function cache default keys ignore polluted Array transform methods', async () => {
	const arraySort = Object.getOwnPropertyDescriptor(Array.prototype, 'sort')!;
	const arrayFlatMap = Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap')!;
	try {
		Object.defineProperty(Array.prototype, 'sort', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted array sort');
			}
		});
		Object.defineProperty(Array.prototype, 'flatMap', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted array flatMap');
			}
		});

		let calls = 0;
		const lookup = createFunctionCache<unknown, string>({
			prefix: 'cache-regression-array-transform-intrinsic-key',
			cache: false,
			factory: async () => `value:${++calls}`
		});
		assert.equal(await lookup.get({ b: [2, 3], a: { c: 1 } }), 'value:1');
		assert.equal(await lookup.get({ a: { c: 1 }, b: [2, 3] }), 'value:1');
		assert.equal(calls, 1);
	} finally {
		Object.defineProperty(Array.prototype, 'sort', arraySort);
		Object.defineProperty(Array.prototype, 'flatMap', arrayFlatMap);
	}
});

test('function cache default keys ignore patched JSON stringify', async () => {
	const originalStringify = JSON.stringify;
	Object.defineProperty(JSON, 'stringify', {
		configurable: true,
		writable: true,
		value() {
			return '"same"';
		}
	});
	try {
		let stringCalls = 0;
		const stringLookup = createFunctionCache<string, string>({
			prefix: 'cache-regression-json-stringify-string-key',
			cache: false,
			factory: async (input) => `${input}:${++stringCalls}`
		});
		assert.equal(await stringLookup.get('a'), 'a:1');
		assert.equal(await stringLookup.get('b'), 'b:2');
		assert.equal(await stringLookup.get('a'), 'a:1');

		let objectCalls = 0;
		const objectLookup = createFunctionCache<Record<string, number>, string>({
			prefix: 'cache-regression-json-stringify-object-key',
			cache: false,
			factory: async (input) => `${Object.getOwnPropertyNames(input)[0]}:${++objectCalls}`
		});
		assert.equal(await objectLookup.get({ a: 1 }), 'a:1');
		assert.equal(await objectLookup.get({ b: 1 }), 'b:2');
		assert.equal(await objectLookup.get({ a: 1 }), 'a:1');
	} finally {
		Object.defineProperty(JSON, 'stringify', {
			configurable: true,
			writable: true,
			value: originalStringify
		});
	}
});

test('function cache snapshot and key composition ignore patched Array map and filter', async () => {
	const arrayMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const arrayFilter = Object.getOwnPropertyDescriptor(Array.prototype, 'filter')!;
	let snapshot;
	let first;
	let second;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		writable: true,
		value() {
			throw new Error('polluted array map');
		}
	});
	Object.defineProperty(Array.prototype, 'filter', {
		configurable: true,
		writable: true,
		value() {
			throw new Error('polluted array filter');
		}
	});
	try {
		let calls = 0;
		const lookup = createFunctionCache<number, string>({
			prefix: 'cache-regression-array-map-filter-key',
			namespace: 'tenant',
			cache: false,
			memory: { ttl: 60 },
			factory: async (input) => `value:${input}:${++calls}`
		});
		first = await lookup.get(1);
		second = await lookup.get(1);
		snapshot = lookup.snapshotMemory();
	} finally {
		Object.defineProperty(Array.prototype, 'map', arrayMap);
		Object.defineProperty(Array.prototype, 'filter', arrayFilter);
	}
	assert.equal(first, 'value:1:1');
	assert.equal(second, 'value:1:1');
	assert.deepEqual(Object.values(snapshot as Record<string, { value: string }>).map((entry) => entry.value), ['value:1:1']);
});

test('function cache default date keys do not invoke overridden date methods', async () => {
	let calls = 0;
	const lookup = createFunctionCache<unknown, string>({
		prefix: 'cache-regression-intrinsic-date-key',
		cache: false,
		factory: async () => `value:${++calls}`
	});

	class HostileDate extends Date {
		override getTime(): number {
			throw new Error('custom getTime should not run');
		}

		override toISOString(): string {
			throw new Error('custom toISOString should not run');
		}
	}

	assert.equal(await lookup.get(new HostileDate('2026-05-14T00:00:00.000Z')), 'value:1');
	assert.equal(await lookup.get(new Date('2026-05-14T00:00:00.000Z')), 'value:1');

	const originalGetTime = Date.prototype.getTime;
	const originalToISOString = Date.prototype.toISOString;
	Object.defineProperty(Date.prototype, 'getTime', {
		configurable: true,
		value() {
			throw new Error('polluted getTime should not run');
		}
	});
	Object.defineProperty(Date.prototype, 'toISOString', {
		configurable: true,
		value() {
			throw new Error('polluted toISOString should not run');
		}
	});
	try {
		assert.equal(await lookup.get(new Date('2026-05-15T00:00:00.000Z')), 'value:2');
	} finally {
		Object.defineProperty(Date.prototype, 'getTime', {
			configurable: true,
			writable: true,
			value: originalGetTime
		});
		Object.defineProperty(Date.prototype, 'toISOString', {
			configurable: true,
			writable: true,
			value: originalToISOString
		});
	}
});

test('function cache default keys include value type tags', async () => {
	let calls = 0;
	const lookup = createFunctionCache<unknown, string>({
		prefix: 'cache-regression-type-tagged-key',
		cache: false,
		factory: async (input) => `${typeof input}:${Object.is(input, -0) ? '-0' : String(input)}:${++calls}`
	});

	assert.equal(await lookup.get(1), 'number:1:1');
	assert.equal(await lookup.get('1'), 'string:1:2');
	assert.equal(await lookup.get(1n), 'bigint:1:3');
	assert.equal(await lookup.get(true), 'boolean:true:4');
	assert.equal(await lookup.get('true'), 'string:true:5');
	assert.equal(await lookup.get(1), 'number:1:1');
	assert.equal(await lookup.get(-0), 'number:-0:6');
	assert.equal(await lookup.get(0), 'number:0:7');
	assert.equal(await lookup.get(-0), 'number:-0:6');
	assert.equal(calls, 7);
});

test('function cache validates runtime key options', async () => {
	assert.throws(
		() => createFunctionCache(null as any),
		/function cache options must be a plain object/
	);
	let getterCalls = 0;
	const accessorOptions = Object.defineProperty(
		{ prefix: 'cache-regression-accessor-options', cache: false },
		'factory',
		{
			enumerable: true,
			get() {
				getterCalls++;
				return async () => 'value';
			}
		}
	);
	assert.throws(
		() => createFunctionCache(accessorOptions as any),
		/function cache options "factory" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenOptions = Object.defineProperty(
		{ prefix: 'cache-regression-hidden-options', cache: false },
		'factory',
		{ enumerable: false, value: async () => 'value' }
	);
	assert.throws(
		() => createFunctionCache(hiddenOptions as any),
		/function cache options "factory" must be enumerable/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-symbol-options',
				cache: false,
				factory: async () => 'value',
				[Symbol('option')]: true
			} as any),
		/function cache options cannot contain symbol fields/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-unknown-options',
				cache: false,
				factory: async () => 'value',
				ttll: 60
			} as any),
		/function cache options contains unknown option "ttll"/
	);
	const accessorMemoryOptions = Object.defineProperty({}, 'ttl', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-accessor-memory',
				cache: false,
				factory: async () => 'value',
				memory: accessorMemoryOptions as any
			}),
		/function cache memory options "ttl" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenMemoryOptions = Object.defineProperty({}, 'ttl', {
		enumerable: false,
		value: 1
	});
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-hidden-memory',
				cache: false,
				factory: async () => 'value',
				memory: hiddenMemoryOptions as any
		}),
		/function cache memory options "ttl" must be enumerable/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-unknown-memory',
				cache: false,
				factory: async () => 'value',
				memory: { maxEntry: 10 }
			} as any),
		/function cache memory options contains unknown option "maxEntry"/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-bad-factory',
				factory: null as any
			}),
		/function cache factory must be a function/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-bad-key-shape',
				key: 'key' as any,
				factory: async () => 'value'
			}),
		/function cache key resolver must be a function/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-bad-namespace-shape',
				namespace: { tenant: 'a' } as any,
				factory: async () => 'value'
			}),
		/function cache namespace must be a string or function/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-bad-memory-shape',
				memory: true as any,
				factory: async () => 'value'
			}),
		/function cache memory options must be false or a plain object/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-bad-adapter-shape',
				cache: { kind: 'bad-cache', getMany: async () => [] } as any,
				factory: async () => 'value'
			}),
		/function cache adapter object must provide/
	);
	const accessorAdapter = {
		kind: 'accessor-cache',
		getMany: async () => [undefined],
		setMany: async () => undefined
	} as any;
	Object.defineProperty(accessorAdapter, 'deleteMany', {
		enumerable: true,
		get() {
			getterCalls++;
			return async () => undefined;
		}
	});
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-accessor-adapter',
				cache: accessorAdapter,
				factory: async () => 'value'
			}),
		/function cache adapter object "deleteMany" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenAdapter = {
		kind: 'hidden-cache',
		getMany: async () => [undefined],
		setMany: async () => undefined
	} as any;
	Object.defineProperty(hiddenAdapter, 'deleteMany', {
		enumerable: false,
		value: async () => undefined
	});
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-hidden-adapter',
				cache: hiddenAdapter,
				factory: async () => 'value'
			}),
		/function cache adapter object "deleteMany" must be enumerable/
	);
	assert.throws(
		() =>
			createFunctionCache({
				prefix: 'cache-regression-bad-adapter-kind',
				cache: {
					kind: 'bad\0cache',
					getMany: async () => [undefined],
					setMany: async () => undefined,
					deleteMany: async () => undefined
				},
				factory: async () => 'value'
			}),
		/function cache adapter object must provide/
	);
	Object.defineProperties(Object.prototype, {
		kind: { value: 'polluted-function-cache', configurable: true },
		getMany: { value: async () => [undefined], configurable: true },
		setMany: { value: async () => undefined, configurable: true },
		deleteMany: { value: async () => undefined, configurable: true }
	});
	try {
		assert.throws(
			() =>
				createFunctionCache({
					prefix: 'cache-regression-polluted-adapter-shape',
					cache: {} as any,
					factory: async () => 'value'
				}),
			/function cache adapter object must provide/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).kind;
		delete (Object.prototype as Record<string, unknown>).getMany;
		delete (Object.prototype as Record<string, unknown>).setMany;
		delete (Object.prototype as Record<string, unknown>).deleteMany;
	}
	assert.throws(
		() =>
			createFunctionCache<number, string>({
				prefix: 'cache-regression-bad-memory-size',
				memory: { maxEntries: 0 },
				factory: async () => 'value'
			}),
		/maxEntries/
	);
	assert.throws(
		() =>
			createFunctionCache<number, string>({
				prefix: 'cache-regression-bad-stale-window',
				staleWhileRevalidate: 0,
				factory: async () => 'value'
			}),
		/function cache staleWhileRevalidate/
	);
	assert.throws(
		() =>
			createFunctionCache<number, string>({
				prefix: 'cache-regression-bad-singleflight',
				singleFlight: 'no' as any,
				factory: async () => 'value'
			}),
		/function cache singleFlight option must be a boolean/
	);
	assert.throws(
		() =>
			createFunctionCache<number, string>({
				prefix: 'cache-regression-bad-context',
				context: {} as any,
				factory: async () => 'value'
			}),
		/function cache context must be an ActiveContext/
	);
	assert.throws(
		() =>
			createFunctionCache<number, string>({
				prefix: 'cache-regression-bad-cache-name',
				cache: '__proto__',
				factory: async () => 'value'
			}),
		/function cache adapter name/
	);

	const badKey = createFunctionCache<number, string>({
		prefix: 'cache-regression-bad-key',
		key: (() => ({ id: 1 })) as any,
		factory: async () => 'value'
	});
	await assert.rejects(
		() => badKey.get(1),
		(error: unknown) => error instanceof ActiveTsValidationError && /key resolver must return a string/.test(error.message)
	);

	const badNamespace = createFunctionCache<number, string>({
		prefix: 'cache-regression-bad-namespace',
		namespace: (() => ({ tenant: 'a' })) as any,
		factory: async () => 'value'
	});
	await assert.rejects(
		() => badNamespace.get(1),
		(error: unknown) => error instanceof ActiveTsValidationError && /namespace resolver must return a string/.test(error.message)
	);

	let getManyCalls = 0;
	const longKeyCache = createFunctionCache<number, string>({
		prefix: 'a'.repeat(4090),
		namespace: 'tenant',
		cache: {
			kind: 'long-key-cache',
			getMany: async () => {
				getManyCalls++;
				return [undefined];
			},
			setMany: async () => undefined,
			deleteMany: async () => undefined
		},
		memory: false,
		factory: async () => 'value'
	});
	await assert.rejects(
		() => longKeyCache.get(1),
		(error: unknown) => error instanceof ActiveTsValidationError && /function cache key is too long/.test(error.message)
	);
	assert.equal(getManyCalls, 0);

	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-bad-get-options',
		cache: false,
		factory: async (value) => `value:${value}`
	});
	assert.equal(await lookup.get(1, undefined as any), 'value:1');
	await assert.rejects(
		() => lookup.get(1, null as any),
		(error: unknown) => error instanceof ActiveTsValidationError && /get options must be a plain object/.test(error.message)
	);
	await assert.rejects(
		() => lookup.get(1, { refresh: 'yes' } as any),
		(error: unknown) => error instanceof ActiveTsValidationError && /get refresh option must be a boolean/.test(error.message)
	);
	await assert.rejects(
		() => lookup.get(1, { refesh: true } as any),
		/function cache get options contains unknown option "refesh"/
	);
	const accessorGetOptions = Object.defineProperty({}, 'refresh', {
		enumerable: true,
		get() {
			getterCalls++;
			return true;
		}
	});
	await assert.rejects(
		() => lookup.get(1, accessorGetOptions as any),
		/function cache get options "refresh" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenGetOptions = Object.defineProperty({}, 'refresh', {
		enumerable: false,
		value: true
	});
	await assert.rejects(
		() => lookup.get(1, hiddenGetOptions as any),
		/function cache get options "refresh" must be enumerable/
	);
	await assert.rejects(
		() => lookup.get(1, { [Symbol('refresh')]: true } as any),
		/function cache get options cannot contain symbol fields/
	);
});

test('function cache ignores inherited option and get option fields', async () => {
	Object.defineProperty(Object.prototype, 'factory', {
		value: async () => 'polluted',
		configurable: true
	});
	try {
		assert.throws(
			() => createFunctionCache({ prefix: 'cache-regression-inherited-factory' } as any),
			/function cache factory must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).factory;
	}

	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-inherited-options',
		cache: false,
		factory: async (value) => `value:${value}:${++calls}`
	});
	Object.defineProperty(Object.prototype, 'refresh', {
		value: true,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'ttl', {
		value: 1,
		configurable: true
	});
	try {
		assert.equal(await lookup.get(1), 'value:1:1');
		assert.equal(await lookup.get(1, {}), 'value:1:1');
		assert.equal(calls, 1);
		const [entry] = Object.values(lookup.snapshotMemory()) as Array<{ expires?: number }>;
		assert.equal(entry.expires, undefined);
	} finally {
		delete (Object.prototype as Record<string, unknown>).refresh;
		delete (Object.prototype as Record<string, unknown>).ttl;
	}
});

test('function cache snapshots direct cache adapter methods at creation', async () => {
	const calls: string[] = [];
	const cache = {
		kind: 'direct-function-cache',
		getMany: async (keys: string[]) => {
			calls.push(`get:${keys.length}`);
			return [undefined];
		},
		setMany: async (entries: Array<[string, unknown]>) => {
			calls.push(`set:${entries.length}`);
		},
		deleteMany: async (keys: string[]) => {
			calls.push(`delete:${keys.length}`);
		}
	};
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-direct-adapter-snapshot',
		context: createActiveTs({ stores: { default: new MemoryStoreAdapter() } }),
		cache,
		memory: false,
		factory: async (value) => `value:${value}`
	});
	cache.kind = 'mutated-function-cache';
	cache.getMany = async () => {
		throw new Error('mutated function cache getMany should not run');
	};
	cache.setMany = async () => {
		throw new Error('mutated function cache setMany should not run');
	};
	cache.deleteMany = async () => {
		throw new Error('mutated function cache deleteMany should not run');
	};

	assert.equal(await lookup.get(1), 'value:1');
	await lookup.invalidate(1);
	assert.deepEqual(calls, ['get:1', 'set:1', 'delete:1']);
});

test('function cache direct adapters work without a default context', async () => {
	clearDefaultContext();
	const cache = new MemoryCacheAdapter();
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-direct-standalone',
		cache,
		memory: false,
		factory: async (value) => `value:${value}:${++calls}`
	});

	assert.equal(await lookup.get(1), 'value:1:1');
	assert.equal(await lookup.get(1), 'value:1:1');
	await lookup.invalidate(1);
	assert.equal(calls, 1);
	assert.equal(cache.stats.getMany, 2);
	assert.equal(cache.stats.setMany, 1);
	assert.equal(cache.stats.deleteMany, 1);
});

test('function cache invalidate fences in-flight factory writes', async () => {
	const cache = new MemoryCacheAdapter();
	let source = 'old';
	let calls = 0;
	let releaseFactory!: () => void;
	let resolveStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-invalidate-fence',
		cache,
		factory: async () => {
			calls++;
			const value = source;
			resolveStarted();
			await release;
			return value;
		}
	});

	const firstLoad = lookup.get(1);
	await started;
	source = 'new';
	await lookup.invalidate(1);
	releaseFactory();

	assert.equal(await firstLoad, 'old');
	assert.deepEqual(Object.values(lookup.snapshotMemory()), []);
	assert.equal(await lookup.get(1), 'new');
	assert.equal(calls, 2);
});

test('function cache explicit set fences older in-flight factory writes', async () => {
	const cache = new MemoryCacheAdapter();
	let releaseFactory!: () => void;
	let resolveStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-set-fences-inflight',
		cache,
		memory: false,
		key: (id) => String(id),
		factory: async () => {
			resolveStarted();
			await release;
			return 'old-factory';
		}
	});

	const pending = lookup.get(1, { refresh: true });
	await started;
	await lookup.set(1, 'explicit');
	releaseFactory();

	assert.equal(await pending, 'old-factory');
	assert.equal(await lookup.peek(1), 'explicit');
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['explicit']);
});

test('function cache cleanup failures poison stale race writes', async () => {
	const cache = new FailingStaleCleanupCache();
	let source = 'old';
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-stale-cleanup-failure',
		cache,
		memory: false,
		factory: async () => {
			calls++;
			return source;
		}
	});

	const firstLoad = lookup.get(1);
	await cache.entered;
	source = 'new';
	await lookup.invalidate(1);
	cache.failDeletes = true;
	cache.unblock();

	await assert.rejects(() => firstLoad, /stale cleanup delete failed/);
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['old']);

	cache.failDeletes = false;
	assert.equal(await lookup.get(1), 'new');
	assert.equal(calls, 2);
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['new']);
});

test('function cache invalidation failures do not trust stale persistent hits', async () => {
	class FailingDeleteCache extends MemoryCacheAdapter {
		override async deleteMany() {
			throw new Error('function cache delete failed');
		}
	}
	const cache = new FailingDeleteCache();
	let source = 'old';
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-failed-invalidate',
		cache,
		factory: async () => {
			calls++;
			return source;
		}
	});

	assert.equal(await lookup.get(1), 'old');
	source = 'new';
	await assert.rejects(() => lookup.invalidate(1), /function cache delete failed/);

	assert.equal(await lookup.get(1), 'new');
	assert.equal(calls, 2);
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['new']);
});

test('function cache skips persistent hits while invalidation delete is pending', async () => {
	class BlockingDeleteCache extends MemoryCacheAdapter {
		private releaseDelete!: () => void;
		private resolveEnteredDelete!: () => void;
		readonly enteredDelete: Promise<void>;
		private readonly release: Promise<void>;

		constructor() {
			super();
			this.enteredDelete = new Promise<void>((resolve) => {
				this.resolveEnteredDelete = resolve;
			});
			this.release = new Promise<void>((resolve) => {
				this.releaseDelete = resolve;
			});
		}

		override async deleteMany(keys: string[]) {
			this.resolveEnteredDelete();
			await this.release;
			return await super.deleteMany(keys);
		}

		unblockDelete() {
			this.releaseDelete();
		}
	}
	const cache = new BlockingDeleteCache();
	let source = 'old';
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-pending-invalidate-fence',
		cache,
		key: (value) => `id:${value}`,
		factory: async () => {
			calls++;
			return source;
		}
	});

	assert.equal(await lookup.get(1), 'old');
	lookup.clearMemory();
	source = 'new';
	const invalidating = lookup.invalidate(1);
	await cache.enteredDelete;

	assert.equal(await lookup.get(1), 'new');
	cache.unblockDelete();
	await invalidating;
	assert.equal(await lookup.get(1), 'new');
	assert.equal(calls, 3);
});

test('function cache invalidation failures are scoped to the failing adapter', async () => {
	class FailingDeleteCache extends MemoryCacheAdapter {
		override async deleteMany() {
			throw new Error('function cache scoped delete failed');
		}
	}
	const failing = new FailingDeleteCache();
	const other = new MemoryCacheAdapter();
	let source = 'old';
	let calls = 0;
	const first = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-failed-invalidate-scope',
		cache: failing,
		memory: false,
		key: (value) => `id:${value}`,
		factory: async () => {
			calls++;
			return source;
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-failed-invalidate-scope',
		cache: other,
		memory: false,
		key: (value) => `id:${value}`,
		factory: async () => 'other'
	});

	assert.equal(await first.get(1), 'old');
	source = 'new';
	await assert.rejects(() => first.invalidate(1), /function cache scoped delete failed/);
	await second.set(1, 'other');

	assert.equal(await first.get(1), 'new');
	assert.equal(calls, 2);
	assert.deepEqual(Object.values(failing.snapshot()).map((entry) => entry.value), ['new']);
});

test('function cache invalidation failures are shared through layered cache wrappers', async () => {
	class ToggleDeleteCache extends MemoryCacheAdapter {
		failDeletes = false;

		override async deleteMany(keys: string[]) {
			if (this.failDeletes) throw new Error('function cache wrapper delete failed');
			return await super.deleteMany(keys);
		}
	}
	const cache = new ToggleDeleteCache();
	const codec = {
		name: 'wrapper-source-identity-codec',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};
	const firstCache = createCacheMiddlewareAdapter(
		createCodecCacheAdapter(cache, codec, { kind: 'wrapper-source-first-codec' }),
		[],
		'wrapper-source-first'
	);
	const secondCache = createCacheMiddlewareAdapter(
		createCodecCacheAdapter(cache, codec, { kind: 'wrapper-source-second-codec' }),
		[],
		'wrapper-source-second'
	);
	let source = 'old';
	let firstCalls = 0;
	let secondCalls = 0;
	const first = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-wrapper-failed-invalidate-source',
		cache: firstCache,
		memory: false,
		key: (value) => `id:${value}`,
		factory: async () => {
			firstCalls++;
			return source;
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-wrapper-failed-invalidate-source',
		cache: secondCache,
		memory: false,
		key: (value) => `id:${value}`,
		factory: async () => {
			secondCalls++;
			return source;
		}
	});

	assert.equal(await first.get(1), 'old');
	source = 'new';
	cache.failDeletes = true;
	await assert.rejects(() => first.invalidate(1), /function cache wrapper delete failed/);
	cache.failDeletes = false;

	assert.equal(await second.get(1), 'new');
	assert.equal(secondCalls, 1);
	assert.equal(await first.get(1), 'new');
	assert.equal(firstCalls, 1);
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['new']);
});

test('function cache invalidation failure tracking ignores polluted Set methods', async () => {
	const setAdd = Object.getOwnPropertyDescriptor(Set.prototype, 'add')!;
	const setHas = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!;
	const setDelete = Object.getOwnPropertyDescriptor(Set.prototype, 'delete')!;
	try {
		Object.defineProperty(Set.prototype, 'add', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted set add');
			}
		});
		Object.defineProperty(Set.prototype, 'has', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted set has');
			}
		});
		Object.defineProperty(Set.prototype, 'delete', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted set delete');
			}
		});

		let optionError: unknown;
		try {
			createFunctionCache({
				prefix: 'cache-regression-function-set-pollution-options',
				cache: false,
				factory: async () => 'unused',
				unknown: true
			} as any);
		} catch (error) {
			optionError = error;
		}
		assert.ok(optionError instanceof ActiveTsValidationError);
		assert.match(optionError.message, /unknown option "unknown"/);

		const rows = new Map<string, unknown>();
		let failDeletes = false;
		const cache = {
			kind: 'set-pollution-function-cache',
			async getMany(keys: string[]) {
				return keys.map((key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined));
			},
			async setMany(entries: Array<[string, any]>) {
				for (const [key, value] of entries) rows.set(key, structuredClone(value));
			},
			async deleteMany(keys: string[]) {
				if (failDeletes) throw new Error('set pollution delete failed');
				for (const key of keys) rows.delete(key);
			}
		};
		let source = 'old';
		let calls = 0;
		const lookup = createFunctionCache<number, string>({
			prefix: 'cache-regression-function-set-pollution-invalidation',
			cache,
			memory: false,
			key: (value) => `id:${value}`,
			factory: async () => {
				calls++;
				return source;
			}
		});

		assert.equal(await lookup.get(1), 'old');
		source = 'new';
		failDeletes = true;
		await assert.rejects(() => lookup.invalidate(1), /set pollution delete failed/);
		failDeletes = false;
		assert.equal(await lookup.get(1), 'new');
		assert.equal(calls, 2);
		assert.deepEqual(Array.from(rows.values()), ['new']);
	} finally {
		Object.defineProperty(Set.prototype, 'add', setAdd);
		Object.defineProperty(Set.prototype, 'has', setHas);
		Object.defineProperty(Set.prototype, 'delete', setDelete);
	}
});

test('function cache wrapper source and failure tracking ignore polluted WeakMap methods', async () => {
	const weakMapGet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')!;
	const weakMapSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')!;
	const weakMapDelete = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'delete')!;
	try {
		Object.defineProperty(WeakMap.prototype, 'get', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted weakmap get');
			}
		});
		Object.defineProperty(WeakMap.prototype, 'set', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted weakmap set');
			}
		});
		Object.defineProperty(WeakMap.prototype, 'delete', {
			configurable: true,
			writable: true,
			value() {
				throw new Error('polluted weakmap delete');
			}
		});

		class ToggleDeleteCache extends MemoryCacheAdapter {
			failDeletes = false;

			override async deleteMany(keys: string[]) {
				if (this.failDeletes) throw new Error('weakmap pollution delete failed');
				return await super.deleteMany(keys);
			}
		}
		const cache = new ToggleDeleteCache();
		const codec = {
			name: 'weakmap-source-identity-codec',
			encode: (value: unknown) => value,
			decode: (value: unknown) => value
		};
		const firstCache = createCacheMiddlewareAdapter(
			createCodecCacheAdapter(cache, codec, { kind: 'weakmap-source-first-codec' }),
			[],
			'weakmap-source-first'
		);
		const secondCache = createCacheMiddlewareAdapter(
			createCodecCacheAdapter(cache, codec, { kind: 'weakmap-source-second-codec' }),
			[],
			'weakmap-source-second'
		);
		let source = 'old';
		let firstCalls = 0;
		let secondCalls = 0;
		const first = createFunctionCache<number, string>({
			prefix: 'cache-regression-function-weakmap-pollution-source',
			cache: firstCache,
			memory: false,
			key: (value) => `id:${value}`,
			factory: async () => {
				firstCalls++;
				return source;
			}
		});
		const second = createFunctionCache<number, string>({
			prefix: 'cache-regression-function-weakmap-pollution-source',
			cache: secondCache,
			memory: false,
			key: (value) => `id:${value}`,
			factory: async () => {
				secondCalls++;
				return source;
			}
		});

		assert.equal(await first.get(1), 'old');
		source = 'new';
		cache.failDeletes = true;
		await assert.rejects(() => first.invalidate(1), /weakmap pollution delete failed/);
		cache.failDeletes = false;
		assert.equal(await second.get(1), 'new');
		assert.equal(secondCalls, 1);
		assert.equal(await first.get(1), 'new');
		assert.equal(firstCalls, 1);
	} finally {
		Object.defineProperty(WeakMap.prototype, 'get', weakMapGet);
		Object.defineProperty(WeakMap.prototype, 'set', weakMapSet);
		Object.defineProperty(WeakMap.prototype, 'delete', weakMapDelete);
	}
});

test('function cache transaction invalidation failures poison root cache handle hits', async () => {
	class FailingDeleteCache extends MemoryCacheAdapter {
		failDeletes = false;

		override async deleteMany(keys: string[]) {
			if (this.failDeletes) throw new Error('function cache transaction delete failed');
			return await super.deleteMany(keys);
		}
	}
	const cache = new FailingDeleteCache();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache }
	});
	let source = 'old';
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-transaction-failed-invalidate',
		context,
		cache: 'default',
		memory: false,
		key: (value) => `id:${value}`,
		factory: async () => `${source}:${++calls}`
	});

	assert.equal(await lookup.get(1), 'old:1');
	source = 'new';
	cache.failDeletes = true;
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await lookup.invalidate(1);
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.ok(error.cause instanceof AggregateError);
			assert.match(error.message, /afterCommit task failed/);
			assert.match((error.cause.errors[0] as Error).message, /function cache transaction delete failed/);
			return true;
		}
	);

	cache.failDeletes = false;
	assert.equal(await lookup.get(1), 'new:2');
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['new:2']);
});

test('function cache peek does not memoize persistent hits invalidated during the read', async () => {
	const cache = new BlockingGetCache();
	let source = 'old';
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-peek-invalidate-fence',
		cache,
		factory: async () => {
			calls++;
			return source;
		}
	});
	await lookup.set(1, 'old');
	lookup.clearMemory();

	const peeked = lookup.peek(1);
	await cache.entered;
	source = 'new';
	await lookup.invalidate(1);
	cache.unblock();

	assert.equal(await peeked, undefined);
	assert.deepEqual(Object.values(lookup.snapshotMemory()), []);
	assert.equal(await lookup.get(1), 'new');
	assert.equal(calls, 1);
});

test('function cache memory hits recheck invalidation after async cache hooks', async () => {
	const cache = new MemoryCacheAdapter();
	let source = 'old';
	let calls = 0;
	let releaseHook!: () => void;
	let resolveEntered!: () => void;
	const entered = new Promise<void>((resolve) => {
		resolveEntered = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseHook = resolve;
	});
	let shouldBlock = true;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-block-memory-hit',
				hooks: {
					async afterCacheGet(payload) {
						if (payload.operation !== 'function-cache' || payload.result === undefined || !shouldBlock) return undefined;
						shouldBlock = false;
						resolveEntered();
						await release;
						return { result: payload.result };
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-memory-hit-invalidate-fence',
		context,
		factory: async () => {
			calls++;
			return source;
		}
	});
	await lookup.set(1, 'old');

	const blocked = lookup.get(1);
	await entered;
	source = 'new';
	await lookup.invalidate(1);
	releaseHook();

	assert.equal(await blocked, 'new');
	assert.equal(lookup.stats.memoryHits, 0);
	assert.deepEqual(Object.values(lookup.snapshotMemory()).map((entry) => entry.value), ['new']);
	assert.equal(calls, 1);
});

test('function cache invalidation fences shared persistent cache instances', async () => {
	const cache = new MemoryCacheAdapter();
	let source = 'old';
	let callsA = 0;
	let callsB = 0;
	let releaseFactory!: () => void;
	let resolveStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const first = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-shared-invalidate-fence',
		cache,
		factory: async () => {
			callsA++;
			const value = source;
			resolveStarted();
			await release;
			return value;
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-shared-invalidate-fence',
		cache,
		factory: async () => {
			callsB++;
			return source;
		}
	});

	const firstLoad = first.get(1);
	await started;
	source = 'new';
	await second.invalidate(1);
	releaseFactory();

	assert.equal(await firstLoad, 'old');
	assert.deepEqual(Object.values(first.snapshotMemory()), []);
	assert.equal(await second.get(1), 'new');
	assert.equal(callsA, 1);
	assert.equal(callsB, 1);
});

test('function cache shared invalidation expires other instances memory entries', async () => {
	const cache = new MemoryCacheAdapter();
	let source = 'old';
	let calls = 0;
	const first = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-shared-memory-invalidate',
		cache,
		factory: async () => {
			calls++;
			return source;
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-shared-memory-invalidate',
		cache,
		factory: async () => source
	});

	assert.equal(await first.get(1), 'old');
	source = 'new';
	await second.invalidate(1);
	assert.equal(await first.get(1), 'new');
	assert.equal(calls, 2);
});

test('function cache invalidation epoch registry is bounded without resurrecting stale memory', async () => {
	let source = 'old';
	let calls = 0;
	const first = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-epoch-prune',
		cache: false,
		key: (value) => String(value),
		factory: async () => {
			calls++;
			return source;
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-epoch-prune',
		cache: false,
		key: (value) => String(value),
		factory: async () => source
	});
	const sweeper = createFunctionCache<number, string>({
		prefix: 'cache-regression-function-epoch-prune-sweep',
		cache: false,
		key: (value) => String(value),
		factory: async (value) => `sweep-${value}`
	});

	assert.equal(await first.get(1), 'old');
	source = 'new';
	await second.invalidate(1);

	const { invalidationEpochLimit } = getFunctionCacheDiagnostics();
	for (let index = 0; index < invalidationEpochLimit + 8; index++) {
		await sweeper.invalidate(index);
	}
	const diagnostics = getFunctionCacheDiagnostics();
	assert.ok(diagnostics.invalidationEpochs <= diagnostics.invalidationEpochLimit);
	assert.equal(await first.get(1), 'new');
	assert.equal(calls, 2);
});

test('function cache combines async namespace and key resolvers into stable keys', async () => {
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-async-namespace',
		cache: false,
		namespace: async (value) => {
			await Promise.resolve();
			return `tenant-${value % 2}`;
		},
		key: async (value) => {
			await Promise.resolve();
			return `entity:${value}`;
		},
		factory: async (value) => `value:${value}`
	});

	assert.equal(await lookup.get(3), 'value:3');
	const [key] = Object.keys(lookup.snapshotMemory());
	assert.match(key, /^cache-regression-async-namespace:tenant-1:/);
});

test('function cache writes computed values with the already resolved key', async () => {
	let keyCalls = 0;
	let namespaceCalls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'cache-regression-resolved-key',
		cache: false,
		namespace: async () => `tenant-${++namespaceCalls}`,
		key: async () => `key-${++keyCalls}`,
		factory: async (value) => `value:${value}`
	});

	assert.equal(await lookup.get(7), 'value:7');
	assert.equal(keyCalls, 1);
	assert.equal(namespaceCalls, 1);
	const [key] = Object.keys(lookup.snapshotMemory());
	assert.match(key, /^cache-regression-resolved-key:tenant-1:/);
});

test('function cache hooks consume cache set and get payload mutations', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-hook-mutations',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation === 'function-cache') return { data: 'cached' };
					},
					afterCacheGet(payload) {
						if (payload.operation === 'function-cache' && payload.result !== undefined)
							return { result: 'after-cache' };
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-hooks',
		context,
		memory: false,
		factory: async (value) => `computed:${value}`
	});

	assert.equal(await lookup.get(1), 'computed:1');
	assert.equal(Object.values(cache.snapshot())[0].value, 'cached');
	assert.equal(await lookup.get(1), 'after-cache');
});

test('function cache does not populate memory when persistent cache writes fail', async () => {
	class FailingSetCache extends MemoryCacheAdapter {
		override async setMany() {
			throw new Error('persistent cache write failed');
		}
	}
	let factoryCalls = 0;
	const lookup = createFunctionCache<number, { value: string }>({
		prefix: 'function-cache-set-failure',
		context: createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			caches: { default: new FailingSetCache() }
		}),
		factory: async () => ({ value: `computed:${++factoryCalls}` })
	});

	await assert.rejects(() => lookup.get(1), /persistent cache write failed/);
	assert.deepEqual(lookup.snapshotMemory(), {});
	await assert.rejects(() => lookup.get(1), /persistent cache write failed/);
	assert.equal(factoryCalls, 2);
});

test('function cache rejects unsafe persistent cache read values before returning or memoizing', async () => {
	class UnsafeReadCache extends MemoryCacheAdapter {
		override async getMany(keys: string[]) {
			await super.getMany(keys);
			return keys.map(() => new Date('2026-05-14T00:00:00.000Z'));
		}
	}
	let factoryCalls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: new UnsafeReadCache() }
	});
	const lookup = createFunctionCache<string, unknown>({
		prefix: 'function-cache-unsafe-read',
		context,
		factory: async () => ({ value: `computed:${++factoryCalls}` })
	});

	await assert.rejects(() => lookup.get('item'), /cannot contain Date/);
	assert.equal(factoryCalls, 0);
	assert.deepEqual(lookup.snapshotMemory(), {});
});

test('function cache validates direct persistent hits when memory is disabled', async () => {
	let factoryCalls = 0;
	const lookup = createFunctionCache<string, unknown>({
		prefix: 'function-cache-direct-unsafe-read',
		cache: {
			kind: 'direct-unsafe-function-cache',
			getMany: async () => [new Date('2026-05-14T00:00:00.000Z')],
			setMany: async () => undefined,
			deleteMany: async () => undefined
		},
		memory: false,
		factory: async () => ({ value: `computed:${++factoryCalls}` })
	});

	await assert.rejects(
		() => lookup.get('item'),
		/Function cache adapter "direct-unsafe-function-cache" getMany result\[0\]: Cache values cannot contain Date/
	);
	assert.equal(factoryCalls, 0);
	assert.deepEqual(lookup.snapshotMemory(), {});
});

test('function cache rejects unsafe afterCacheGet mutations from persistent and memory hits', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: new MemoryCacheAdapter() },
		plugins: [
			{
				name: 'function-cache-unsafe-read-hooks',
				hooks: {
					afterCacheGet(payload) {
						if (payload.operation === 'function-cache' && payload.result !== undefined) {
							return { result: { value: new Date('2026-05-14T00:00:00.000Z') } };
						}
					}
				}
			}
		]
	});
	const persistentLookup = createFunctionCache<number, { value: string }>({
		prefix: 'function-cache-unsafe-persistent-hook',
		context,
		factory: async (value) => ({ value: `computed:${value}` })
	});
	await persistentLookup.set(1, { value: 'safe' });
	persistentLookup.clearMemory();

	await assert.rejects(() => persistentLookup.get(1), /cannot contain Date/);
	assert.deepEqual(persistentLookup.snapshotMemory(), {});

	const memoryLookup = createFunctionCache<number, { value: string }>({
		prefix: 'function-cache-unsafe-memory-hook',
		context,
		factory: async (value) => ({ value: `computed:${value}` })
	});
	await memoryLookup.set(1, { value: 'safe' });

	await assert.rejects(() => memoryLookup.get(1), /cannot contain Date/);
	assert.deepEqual(Object.values(memoryLookup.snapshotMemory())[0].value, { value: 'safe' });
});

test('function cache memory layer stores beforeCacheSet payload mutations', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-memory-hook-mutations',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation === 'function-cache') return { data: { value: 'cached' } };
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, { value: string }>({
		prefix: 'function-cache-memory-hooks',
		context,
		factory: async (value) => ({ value: `computed:${value}` })
	});

	assert.deepEqual(await lookup.get(1), { value: 'computed:1' });
	assert.deepEqual(Object.values(cache.snapshot())[0].value, { value: 'cached' });
	assert.deepEqual(Object.values(lookup.snapshotMemory())[0].value, { value: 'cached' });
	assert.deepEqual(await lookup.get(1), { value: 'cached' });
});

test('function cache beforeCacheSet payload mutations do not rewrite caller-owned values', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-hook-isolation',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation !== 'function-cache') return;
						payload.data.value = 'cached';
						payload.data.nested.seen = true;
					}
				}
			}
		]
	});
	const produced = { value: 'computed', nested: { seen: false } };
	const lookup = createFunctionCache<number, typeof produced>({
		prefix: 'function-cache-hook-isolation',
		context,
		factory: async () => produced
	});

	const returned = await lookup.get(1);

	assert.equal(returned, produced);
	assert.deepEqual(produced, { value: 'computed', nested: { seen: false } });
	assert.deepEqual(Object.values(cache.snapshot())[0].value, { value: 'cached', nested: { seen: true } });
	assert.deepEqual(Object.values(lookup.snapshotMemory())[0].value, { value: 'cached', nested: { seen: true } });
});

test('function cache afterCacheSet mutations do not rewrite reference-retaining persistent adapters', async () => {
	const cache = new ReferenceRetainingCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'function-cache-after-set-reference-isolation',
				hooks: {
					afterCacheSet(payload) {
						if (payload.operation !== 'function-cache') return;
						const data = payload.data as { value: string; nested: { after: boolean } };
						data.value = 'after-hook';
						data.nested.after = true;
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, { value: string; nested: { after: boolean } }>({
		prefix: 'function-cache-after-set-reference-isolation',
		context,
		cache,
		memory: false,
		key: (value) => `id:${value}`,
		factory: async () => ({ value: 'computed', nested: { after: false } })
	});

	await lookup.set(1, { value: 'stored', nested: { after: false } });

	assert.equal(cache.entries.size, 1);
	assert.deepEqual(await cache.getMany([...cache.entries.keys()]), [
		{ value: 'stored', nested: { after: false } }
	]);
	assert.deepEqual(await lookup.peek(1), { value: 'stored', nested: { after: false } });
});

test('function cache memory hits consume afterCacheGet payload mutations', async () => {
	const cache = new MemoryCacheAdapter();
	let afterCacheGetCalls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-memory-hit-hooks',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation === 'function-cache') return { data: { value: 'cached' } };
					},
					afterCacheGet(payload) {
						if (payload.operation === 'function-cache' && payload.result !== undefined) {
							afterCacheGetCalls++;
							return { result: { value: 'after-cache' } };
						}
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, { value: string }>({
		prefix: 'function-cache-memory-hit-hooks',
		context,
		factory: async (value) => ({ value: `computed:${value}` })
	});

	assert.deepEqual(await lookup.get(1), { value: 'computed:1' });
	cache.resetStats();
	assert.deepEqual(await lookup.get(1), { value: 'after-cache' });
	assert.equal(cache.stats.getMany, 0);
	assert.equal(lookup.stats.memoryHits, 1);
	assert.equal(afterCacheGetCalls, 1);
});

test('function cache persistent hits memoize stored representation before afterCacheGet', async () => {
	const cache = new MemoryCacheAdapter();
	let afterCacheGetCalls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-persistent-hit-stored-representation',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation === 'function-cache') {
							const value = payload.data as { plain: string };
							return { data: { encoded: value.plain } };
						}
					},
					afterCacheGet(payload) {
						if (payload.operation !== 'function-cache' || payload.result === undefined) return undefined;
						afterCacheGetCalls++;
						const value = payload.result as { encoded?: string };
						if (typeof value.encoded !== 'string') throw new Error('expected encoded cache payload');
						return { result: { plain: value.encoded } };
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, { plain: string }>({
		prefix: 'function-cache-persistent-hit-stored-representation',
		context,
		factory: async (value) => ({ plain: `computed:${value}` })
	});

	assert.deepEqual(await lookup.get(1), { plain: 'computed:1' });
	lookup.clearMemory();
	cache.resetStats();

	assert.deepEqual(await lookup.get(1), { plain: 'computed:1' });
	assert.equal(cache.stats.getMany, 1);
	assert.deepEqual(await lookup.get(1), { plain: 'computed:1' });
	assert.equal(cache.stats.getMany, 1);
	assert.equal(afterCacheGetCalls, 2);
	assert.deepEqual(Object.values(lookup.snapshotMemory())[0].value, { encoded: 'computed:1' });
});

test('memory-only function cache runs cache hooks when a context is supplied', async () => {
	const calls = {
		beforeSet: 0,
		afterSet: 0,
		beforeGet: 0,
		afterGet: 0,
		beforeInvalidate: 0,
		afterInvalidate: 0
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'memory-only-function-cache-hooks',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation === 'function-cache') {
							calls.beforeSet++;
							return { data: { value: 'cached' } };
						}
					},
					afterCacheSet(payload) {
						if (payload.operation === 'function-cache') calls.afterSet++;
					},
					beforeCacheGet(payload) {
						if (payload.operation === 'function-cache') calls.beforeGet++;
					},
					afterCacheGet(payload) {
						if (payload.operation === 'function-cache' && payload.result !== undefined) {
							calls.afterGet++;
							return { result: { value: 'after-cache' } };
						}
					},
					beforeCacheInvalidate(payload) {
						if (payload.operation === 'function-cache') calls.beforeInvalidate++;
					},
					afterCacheInvalidate(payload) {
						if (payload.operation === 'function-cache') calls.afterInvalidate++;
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, { value: string }>({
		prefix: 'memory-only-function-cache-hooks',
		context,
		cache: false,
		factory: async (value) => ({ value: `computed:${value}` })
	});

	assert.deepEqual(await lookup.get(1), { value: 'computed:1' });
	assert.deepEqual(Object.values(lookup.snapshotMemory())[0].value, { value: 'cached' });
	assert.deepEqual(await lookup.get(1), { value: 'after-cache' });
	await lookup.invalidate(1);

	assert.deepEqual(calls, {
		beforeSet: 1,
		afterSet: 1,
		beforeGet: 1,
		afterGet: 1,
		beforeInvalidate: 1,
		afterInvalidate: 1
	});
});

test('function cache explicit contexts follow ambient transaction scope for hooks', async () => {
	const hookTransactionStates: boolean[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'function-cache-transaction-scope',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation === 'function-cache') {
							hookTransactionStates.push((payload.context as any).isInTransaction() === true);
						}
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-transaction-scope',
		context,
		cache: false,
		factory: async (value) => `value:${value}`
	});

	await context.transaction(async () => {
		assert.equal(await lookup.get(1), 'value:1');
	});

	assert.deepEqual(hookTransactionStates, [true]);
});

test('function cache bypasses and does not persist values computed inside rolled-back transactions', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	const meta = context.meta(CacheRegressionRecord);
	await store.seed(meta, [{ id: 91, value: 'old' }]);
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-transaction-rollback',
		context,
		cache,
		factory: async (id) => {
			calls++;
			return (await Record.find(id).load())?.data.value ?? 'missing';
		}
	});

	assert.equal(await lookup.get(91), 'old');
	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = CacheRegressionRecord.use(tx) as unknown as typeof CacheRegressionRecord;
				const row = await TxRecord.find(91).load();
				row!.data.value = 'tx';
				await row!.save();
				assert.equal(await lookup.get(91), 'tx');
				assert.equal(await lookup.peek(91), undefined);
				throw new Error('rollback function cache');
			}),
		/rollback function cache/
	);

	assert.equal(await lookup.get(91), 'old');
	assert.equal(calls, 2);
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['old']);
});

test('function cache singleflight is scoped per transaction context', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const started: string[] = [];
	const releases: Array<() => void> = [];
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-transaction-singleflight',
		context,
		cache: false,
		factory: async () => {
			const label = context.isInTransaction() ? 'tx' : 'root';
			started.push(label);
			await new Promise<void>((resolve) => {
				releases.push(resolve);
			});
			return label;
		}
	});

	const txValue = context.transaction(async () => lookup.get(1));
	while (started.length < 1) await flushBackground();
	const rootValue = lookup.get(1);
	while (started.length < 2) await flushBackground();

	for (const release of releases) release();

	assert.equal(await txValue, 'tx');
	assert.equal(await rootValue, 'root');
	assert.deepEqual(started.sort(), ['root', 'tx']);
});

test('function cache direct adapters bypass transaction reads and writes', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = CacheRegressionRecord.use(context) as unknown as typeof CacheRegressionRecord;
	const meta = context.meta(CacheRegressionRecord);
	await store.seed(meta, [{ id: 92, value: 'old' }]);
	setDefaultContext(context);
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-direct-transaction-rollback',
		cache,
		memory: false,
		factory: async (id) => {
			calls++;
			return (await Record.find(id).load())?.data.value ?? 'missing';
		}
	});

	try {
		assert.equal(await lookup.get(92), 'old');
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					const TxRecord = CacheRegressionRecord.use(tx) as unknown as typeof CacheRegressionRecord;
					const row = await TxRecord.find(92).load();
					row!.data.value = 'tx';
					await row!.save();
					assert.equal(await lookup.get(92, { refresh: true }), 'tx');
					assert.equal(await lookup.peek(92), undefined);
					throw new Error('rollback direct function cache');
				}),
			/rollback direct function cache/
		);

		assert.equal(await lookup.get(92), 'old');
		assert.equal(calls, 2);
		assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['old']);
	} finally {
		clearDefaultContext();
	}
});

test('function cache invalidation waits for transaction commit', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let source = 'old';
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-transaction-invalidate',
		context,
		cache,
		memory: false,
		factory: async () => source
	});

	assert.equal(await lookup.get(1), 'old');
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await lookup.invalidate(1);
				throw new Error('rollback invalidation');
			}),
		/rollback invalidation/
	);
	assert.equal(await lookup.peek(1), 'old');

	source = 'new';
	await context.transaction(async () => {
		await lookup.invalidate(1);
	});
	assert.equal(await lookup.peek(1), undefined);
	assert.equal(await lookup.get(1), 'new');
});

test('function cache explicit set waits for transaction commit', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-transaction-explicit-set',
		context,
		cache,
		memory: false,
		factory: async () => 'factory'
	});

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await lookup.set(1, 'rolled-back');
				assert.equal(await lookup.peek(1), undefined);
				throw new Error('rollback explicit set');
			}),
		/rollback explicit set/
	);
	assert.equal(await lookup.peek(1), undefined);

	await context.transaction(async () => {
		await lookup.set(1, 'committed');
		assert.equal(await lookup.peek(1), undefined);
	});

	assert.equal(await lookup.peek(1), 'committed');
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['committed']);
});

test('function cache afterCacheSet failures poison committed values', async () => {
	const cache = new MemoryCacheAdapter();
	let failAfterSet = true;
	let calls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-after-set-failure',
				hooks: {
					afterCacheSet(payload) {
						if (payload.operation !== 'function-cache' || !failAfterSet) return;
						failAfterSet = false;
						throw new Error('function cache after set failed');
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-after-set-poison',
		context,
		cache: 'default',
		key: (value) => `id:${value}`,
		factory: async (value) => `computed:${value}:${++calls}`
	});

	await assert.rejects(() => lookup.set(1, 'manual'), /function cache after set failed/);
	assert.deepEqual(cache.snapshot(), {});
	assert.deepEqual(lookup.snapshotMemory(), {});
	assert.equal(await lookup.get(1), 'computed:1:1');
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['computed:1:1']);
	assert.deepEqual(Object.values(lookup.snapshotMemory()).map((entry) => entry.value), ['computed:1:1']);
});

test('function cache afterCacheSet cleanup failures block stale persistent hits', async () => {
	class FailingDeleteCache extends MemoryCacheAdapter {
		failDeletes = false;

		override async deleteMany(...args: Parameters<MemoryCacheAdapter['deleteMany']>) {
			if (this.failDeletes) throw new Error('function cache cleanup failed');
			return await super.deleteMany(...args);
		}
	}
	const cache = new FailingDeleteCache();
	let failAfterSet = true;
	let calls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-after-set-cleanup-failure',
				hooks: {
					afterCacheSet(payload) {
						if (payload.operation !== 'function-cache' || !failAfterSet) return;
						failAfterSet = false;
						throw new Error('function cache after set failed');
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-after-set-cleanup-poison',
		context,
		cache: 'default',
		memory: false,
		key: (value) => `id:${value}`,
		factory: async (value) => `computed:${value}:${++calls}`
	});

	cache.failDeletes = true;
	await assert.rejects(
		() => lookup.set(1, 'manual'),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /Function cache set hook failed and cleanup failed/);
			assert.match((error.errors[0] as Error).message, /function cache after set failed/);
			assert.match((error.errors[1] as Error).message, /function cache cleanup failed/);
			return true;
		}
	);
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['manual']);

	cache.failDeletes = false;
	assert.equal(await lookup.get(1), 'computed:1:1');
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['computed:1:1']);
});

test('function cache beforeCacheSet failures poison stale persistent hits', async () => {
	const cache = new MemoryCacheAdapter();
	let failBeforeSet = false;
	let calls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		plugins: [
			{
				name: 'function-cache-before-set-failure',
				hooks: {
					beforeCacheSet(payload) {
						if (payload.operation !== 'function-cache' || !failBeforeSet) return;
						failBeforeSet = false;
						throw new Error('function cache before set failed');
					}
				}
			}
		]
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-before-set-poison',
		context,
		cache: 'default',
		memory: false,
		key: (value) => `id:${value}`,
		factory: async (value) => `computed:${value}:${++calls}`
	});

	await lookup.set(1, 'old');
	failBeforeSet = true;
	await assert.rejects(() => lookup.set(1, 'new'), /function cache before set failed/);
	assert.equal(await lookup.peek(1), undefined);
	assert.equal(await lookup.get(1), 'computed:1:1');

	await lookup.set(2, 'old-transaction');
	failBeforeSet = true;
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await lookup.set(2, 'new-transaction');
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.ok(error.cause instanceof AggregateError);
			assert.match(error.message, /afterCommit task failed/);
			assert.match((error.cause.errors[0] as Error).message, /function cache before set failed/);
			return true;
		}
	);
	assert.equal(await lookup.peek(2), undefined);
	assert.equal(await lookup.get(2), 'computed:2:2');
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value).sort(), ['computed:1:1', 'computed:2:2']);
});

test('function cache set failures poison stale persistent hits', async () => {
	class FailingSetCache extends MemoryCacheAdapter {
		failSets = false;

		override async setMany(...args: Parameters<MemoryCacheAdapter['setMany']>) {
			if (this.failSets) throw new Error('function cache set failed');
			return await super.setMany(...args);
		}
	}
	const cache = new FailingSetCache();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache }
	});
	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-set-failure-poisons-stale',
		context,
		cache: 'default',
		memory: false,
		key: (value) => `id:${value}`,
		factory: async (value) => `computed:${value}:${++calls}`
	});

	await lookup.set(1, 'old');
	cache.failSets = true;
	await assert.rejects(() => lookup.set(1, 'new'), /function cache set failed/);
	cache.failSets = false;
	assert.equal(await lookup.get(1), 'computed:1:1');

	await lookup.set(2, 'old-transaction');
	cache.failSets = true;
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await lookup.set(2, 'new-transaction');
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.ok(error.cause instanceof AggregateError);
			assert.match(error.message, /afterCommit task failed/);
			assert.match((error.cause.errors[0] as Error).message, /function cache set failed/);
			return true;
		}
	);
	cache.failSets = false;
	assert.equal(await lookup.get(2), 'computed:2:2');
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value).sort(), ['computed:1:1', 'computed:2:2']);
});

test('function cache deferred transaction tasks capture ambient root context', async () => {
	clearDefaultContext();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache }
	});
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-deferred-ambient-root',
		cache: 'default',
		memory: false,
		key: (id) => String(id),
		factory: async () => 'factory'
	});

	await context.transaction(async () => {
		await lookup.set(1, 'committed');
	});
	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['committed']);

	await context.transaction(async () => {
		await lookup.invalidate(1);
	});
	assert.deepEqual(Object.values(cache.snapshot()), []);
});

test('function cache deferred transaction tasks do not re-enter closed transaction contexts', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache }
	});

	await context.transaction(async (tx) => {
		const lookup = createFunctionCache<number, string>({
			prefix: 'function-cache-deferred-tx-context',
			context: tx,
			cache: 'default',
			memory: false,
			key: (id) => String(id),
			factory: async () => 'factory'
		});
		await lookup.set(1, 'committed');
	});

	assert.deepEqual(Object.values(cache.snapshot()).map((entry) => entry.value), ['committed']);
});

test('function cache explicit set preserves transaction invalidation order', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-transaction-explicit-set-order',
		context,
		cache,
		memory: false,
		factory: async () => 'factory'
	});

	await lookup.set(1, 'old');
	await context.transaction(async () => {
		await lookup.invalidate(1);
		await lookup.set(1, 'new');
	});
	assert.equal(await lookup.peek(1), 'new');

	await context.transaction(async () => {
		await lookup.set(1, 'stale');
		await lookup.invalidate(1);
	});
	assert.equal(await lookup.peek(1), undefined);
});

test('read-only transactions reject deferred function cache writes', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-readonly-transaction',
		context,
		cache,
		memory: false,
		key: (id) => String(id),
		factory: async () => 'factory'
	});

	await lookup.set(1, 'old');
	cache.resetStats();
	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await lookup.set(1, 'new');
				},
				{ readOnly: true }
			),
		/read-only transaction/
	);
	assert.equal(cache.stats.setMany, 0);
	assert.equal(await lookup.peek(1), 'old');

	cache.resetStats();
	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await lookup.invalidate(1);
				},
				{ readOnly: true }
			),
		/read-only transaction/
	);
	assert.equal(cache.stats.deleteMany, 0);
	assert.equal(await lookup.peek(1), 'old');
});

test('read-only transactions reject standalone direct function cache writes', async () => {
	clearDefaultContext();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const lookup = createFunctionCache<number, string>({
		prefix: 'function-cache-readonly-direct-standalone',
		cache,
		memory: false,
		key: (id) => String(id),
		factory: async () => 'factory'
	});

	await lookup.set(1, 'old');
	cache.resetStats();
	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await lookup.set(1, 'new');
				},
				{ readOnly: true }
			),
		/read-only transaction/
	);
	assert.equal(cache.stats.setMany, 0);
	assert.equal(await lookup.peek(1), 'old');

	cache.resetStats();
	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await lookup.invalidate(1);
				},
				{ readOnly: true }
			),
		/read-only transaction/
	);
	assert.equal(cache.stats.deleteMany, 0);
	assert.equal(await lookup.peek(1), 'old');
});

test('nested field codecs decode partial select shape without exposing stored encoding', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = NestedCodecRecord.use(context) as unknown as typeof NestedCodecRecord;

	await Record.create({
		id: 1,
		label: 'row',
		profile: { secret: NESTED_CODEC_VALUE, public: 'visible' }
	});
	assert.equal(
		store.dump('nested_codec_record')[0].profile.secret,
		Buffer.from(NESTED_CODEC_VALUE, 'utf8').toString('base64url')
	);

	const partial = await Record.query().select('profile.secret').first();
	assert.equal(isPartialModel(partial), true);
	assert.deepEqual(partial?.data, { id: 1, profile: { secret: NESTED_CODEC_VALUE } });
	await assert.rejects(() => (partial as any).save(), /Cannot save on partial/);
});

test('field codecs can explicitly encode portable query operands', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = QueryableCodecRecord.use(context) as unknown as typeof QueryableCodecRecord;
	await Record.create({ id: 1, token: 'alpha' });
	await Record.create({ id: 2, token: 'beta' });

	assert.deepEqual(store.dump('queryable_codec_record'), [
		{ id: 1, token: encodeToken('alpha') },
		{ id: 2, token: encodeToken('beta') }
	]);
	const result = await Record.where({ token: 'alpha' }).load();
	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
});

test('field codec non-equality query operators require explicit opt-in', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = QueryableCodecRecord.use(context) as unknown as typeof QueryableCodecRecord;
	const meta = context.meta(QueryableCodecRecord);

	await assert.rejects(
		() => Record.where({ token: ['startsWith', 'al'] }).load(),
		/Field codec "queryable-base64" on queryable_codec_record\.token does not support portable query operator "startsWith"/
	);
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'token', op: '>', value: 'alpha' }],
				or: [],
				sort: [],
				include: []
			}),
		/Field codec "queryable-base64" on queryable_codec_record\.token does not support portable query operator ">"/
	);
	assert.equal(store.stats.query, 0);
});

test('field codec query operator opt-in passes the operator to encodeQuery', async () => {
	operatorAwareQueryOperators.length = 0;
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = OperatorAwareCodecRecord.use(context) as unknown as typeof OperatorAwareCodecRecord;
	await Record.create({ id: 1, token: 'alpha' });
	await Record.create({ id: 2, token: 'beta' });

	const result = await Record.where({ token: ['startsWith', 'al'] }).load();

	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
	assert.deepEqual(operatorAwareQueryOperators, ['startsWith']);
});

test('field codec query operator opt-in ignores patched Array includes', async () => {
	operatorAwareQueryOperators.length = 0;
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = OperatorAwareCodecRecord.use(context) as unknown as typeof OperatorAwareCodecRecord;
	await Record.create({ id: 1, token: 'alpha' });

	const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!;
	Object.defineProperty(Array.prototype, 'includes', {
		configurable: true,
		value() {
			throw new Error('patched Array.includes');
		}
	});
	try {
		const result = await Record.where({ token: ['startsWith', 'al'] }).load();
		assert.deepEqual(result.list.map((item) => item.data.id), [1]);
		assert.deepEqual(operatorAwareQueryOperators, ['startsWith']);
	} finally {
		Object.defineProperty(Array.prototype, 'includes', includes);
	}
});

test('field codec plan encoding ignores patched Array transforms', () => {
	operatorAwareQueryOperators.length = 0;
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const inMeta = context.meta(QueryableCodecRecord);
	const operatorMeta = context.meta(OperatorAwareCodecRecord);
	const queryPlan = {
		where: [{ field: 'token', op: 'in', value: ['alpha', 'beta'] }],
		or: [
			{
				where: [{ field: 'token', op: '=', value: 'gamma' }],
				or: [],
				sort: [],
				include: []
			}
		],
		sort: [],
		include: []
	} as any;
	const aggregatePlan = {
		where: [{ field: 'token', op: 'startsWith', value: 'al' }],
		or: [
			{
				where: [{ field: 'id', op: '=', value: 1 }],
				or: [],
				sort: [],
				include: []
			}
		],
		aggregates: [{ op: 'count', as: 'total' }]
	} as any;
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const find = Object.getOwnPropertyDescriptor(Array.prototype, 'find')!;
	let encodedQuery: any;
	let encodedAggregate: any;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'find', {
		configurable: true,
		value() {
			throw new Error('patched Array.find');
		}
	});
	try {
		encodedQuery = encodeQueryPlanFieldCodecs(inMeta, queryPlan);
		encodedAggregate = encodeAggregatePlanFieldCodecs(operatorMeta, aggregatePlan);
		assertNoAggregateFieldCodecSpecs(operatorMeta, [{ op: 'count', as: 'total' }], 'aggregate regression');
		stripFieldCodecQueryOperandMarker(encodedQuery);
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
		Object.defineProperty(Array.prototype, 'find', find);
	}

	assert.deepEqual(encodedQuery.where[0].value, [encodeToken('alpha'), encodeToken('beta')]);
	assert.deepEqual(encodedQuery.or[0].where[0].value, encodeToken('gamma'));
	assert.deepEqual(encodedAggregate.where[0].value, 'stored:al');
	assert.deepEqual(operatorAwareQueryOperators, ['startsWith']);
});

test('read and cache hooks consume returned payloads with aligned ids', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const cacheSetPayloads: Array<{ ids: unknown[]; data: Array<[string, any]> }> = [];
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'cache-hook-mutations',
				hooks: {
					afterRead(payload) {
						return {
							result: payload.result.map((item: CacheRegressionData | null) =>
								item ? { ...item, value: 'after-read' } : item
							)
						};
					},
					beforeCacheSet(payload) {
						cacheSetPayloads.push({ ids: [...(payload.ids ?? [])], data: payload.data });
						return {
							data: payload.data.map(([key, value]: [string, CacheRegressionData | null]) => [
								key,
								value ? { ...value, value: 'cached' } : value
							])
						};
					},
					afterCacheGet(payload) {
						return {
							result: payload.result.map((item: CacheRegressionData | null | undefined) =>
								item && item !== null ? { ...item, value: 'after-cache' } : item
							)
						};
					}
				}
			}
		]
	});
	const Record = CacheHookRecord.use(context) as unknown as typeof CacheHookRecord;
	await store.seed('cache_hook_record', [{ id: 1, value: 'store' }]);

	const [first, missing] = await Promise.all([Record.find(1).load(), Record.find(2).load()]);
	assert.equal(first?.data.value, 'after-read');
	assert.equal(missing, null);
	assert.deepEqual(cacheSetPayloads.map((item) => item.ids), [[1], [2]]);
	assert.deepEqual(cacheSetPayloads.map((item) => item.data.length), [1, 1]);
	assert.equal(cache.snapshot()['cache_hook_record:number:1'].value.value, 'cached');
	assert.equal(cache.snapshot()['cache_hook_record:number:2'].value, null);

	const cached = await Record.find(1).load();
	assert.equal(cached?.data.value, 'after-cache');
});

test('entity cache beforeCacheSet in-place mutations do not rewrite loaded rows', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'entity-cache-hook-isolation',
				hooks: {
					beforeCacheSet(payload) {
						const first = payload.data?.[0]?.[1];
						if (first) first.value = 'cached';
					}
				}
			}
		]
	});
	const Record = CacheHookRecord.use(context) as unknown as typeof CacheHookRecord;
	await store.seed('cache_hook_record', [{ id: 1, value: 'store' }]);

	const first = await Record.find(1).load();

	assert.equal(first?.data.value, 'store');
	assert.equal(cache.snapshot()['cache_hook_record:number:1'].value.value, 'cached');
	assert.equal((await Record.find(1).load())?.data.value, 'cached');
});

test('entity cache hooks snapshot result arrays without caller-controlled methods', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	let arrayMethodCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'cache-array-methods',
				hooks: {
					beforeCacheSet(payload) {
						const data = payload.data.map(([key, value]: [string, CacheRegressionData | null]) => [
							key,
							value ? { ...value, value: 'cached-array' } : value
						]) as any[];
						Object.defineProperty(data, 'map', {
							value() {
								arrayMethodCalls++;
								throw new Error('custom cache set map should not run');
							}
						});
						return { data };
					},
					afterCacheGet(payload) {
						const result = payload.result.map((item: CacheRegressionData | null | undefined) =>
							item && item !== null ? { ...item, value: 'after-cache-array' } : item
						) as any[];
						Object.defineProperty(result, 'forEach', {
							value() {
								arrayMethodCalls++;
								throw new Error('custom cache result forEach should not run');
							}
						});
						return { result };
					}
				}
			}
		]
	});
	const Record = CacheHookRecord.use(context) as unknown as typeof CacheHookRecord;
	await store.seed('cache_hook_record', [{ id: 1, value: 'store' }]);

	assert.equal((await Record.find(1).load())?.data.value, 'store');
	assert.equal(cache.snapshot()['cache_hook_record:number:1'].value.value, 'cached-array');
	assert.equal((await Record.find(1).load())?.data.value, 'after-cache-array');
	assert.equal(arrayMethodCalls, 0);
});

test('entity cache set hooks cannot rewrite cache keys', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'cache-key-rewriter',
				hooks: {
					beforeCacheSet(payload) {
						return {
							data: payload.data.map(([, value]: [string, CacheRegressionData | null]) => [
								'cache_hook_record:number:2',
								value
							])
						};
					}
				}
			}
		]
	});
	const Record = CacheHookRecord.use(context) as unknown as typeof CacheHookRecord;
	await store.seed('cache_hook_record', [{ id: 1, value: 'store' }]);

	await assert.rejects(() => Record.find(1).load(), /beforeCacheSet data cannot change cache entry keys/);
	assert.deepEqual(cache.snapshot(), {});
});

test('entity cache set hooks cannot rewrite cache value identity', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'cache-value-rewriter',
				hooks: {
					beforeCacheSet(payload) {
						return {
							data: payload.data.map(([key, value]: [string, CacheRegressionData | null]) => [
								key,
								value ? { ...value, id: 2 } : { id: 2, value: 'not-null' }
							])
						};
					}
				}
			}
		]
	});
	const Record = CacheHookRecord.use(context) as unknown as typeof CacheHookRecord;
	await store.seed('cache_hook_record', [{ id: 1, value: 'store' }]);

	await assert.rejects(
		() => Record.find(1).load(),
		/beforeCacheSet data\[0\] value id field "id" must match the requested id/
	);
	assert.deepEqual(cache.snapshot(), {});
});

test('entity cache set hooks cannot realign values by mutating hook ids', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'cache-id-realigner',
				hooks: {
					beforeCacheSet(payload) {
						payload.ids?.reverse();
						const first = payload.data[0][1];
						payload.data[0][1] = payload.data[1][1];
						payload.data[1][1] = first;
					}
				}
			}
		]
	});
	await store.seed('cache_hook_record', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	await assert.rejects(
		() => context.loadManyNow(CacheHookRecord, [1, 2]),
		/beforeCacheSet data\[0\] value id field "id" must match the requested id/
	);
	assert.deepEqual(cache.snapshot(), {});
});

test('entity cache set hooks cannot rewrite keys through hook metadata', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'cache-meta-key-rewriter',
				hooks: {
					beforeCacheSet(payload) {
						const firstKey = payload.data[0][0];
						payload.data[0][0] = payload.data[1][0];
						payload.data[1][0] = firstKey;
						const hookKeys = payload.meta?.keys;
						if (Array.isArray(hookKeys)) hookKeys.reverse();
					}
				}
			}
		]
	});
	await store.seed('cache_hook_record', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	await assert.rejects(
		() => context.loadManyNow(CacheHookRecord, [1, 2]),
		/beforeCacheSet data cannot change cache entry keys/
	);
	assert.deepEqual(cache.snapshot(), {});
});
