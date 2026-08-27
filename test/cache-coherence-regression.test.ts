import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	createCodecCacheAdapter,
	createFunctionCache,
	defineModel
} from '../src/index.js';
import type { CacheAdapter, CacheVersionedEntry } from '../src/index.js';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import {
	normalizeCacheVersionedEntries,
	normalizeCacheVersionedSetResult,
	normalizeCacheVersionedValues
} from '../src/core/cache-versioning.js';
import { cacheAdapterSource } from '../src/core/cache-utils.js';
import { storeAdapterSource } from '../src/core/store-utils.js';

type SharedEpochData = {
	id: number;
	value: string;
};

class SharedEpochRecord extends Model<SharedEpochData> {}
class DistributedEpochRecord extends Model<SharedEpochData> {}

defineModel<SharedEpochData>({
	name: 'shared_epoch_record',
	cache: { ttl: 60 }
})
	.id('id')
	.validate((input) => input as SharedEpochData)
	.attach(SharedEpochRecord);

defineModel<SharedEpochData>({
	name: 'distributed_epoch_record',
	cache: { ttl: 60, consistency: 'distributed' }
})
	.id('id')
	.validate((input) => input as SharedEpochData)
	.attach(DistributedEpochRecord);

type SharedVersionedBackend = {
	values: Map<string, unknown>;
	versions: Map<string, number>;
};

class SharedVersionedCache implements CacheAdapter {
	readonly kind = 'shared-versioned';
	setManyCalls = 0;
	setManyVersionedCalls = 0;
	invalidateManyCalls = 0;

	constructor(protected readonly backend: SharedVersionedBackend) {}

	async getMany(keys: string[]) {
		return keys.map((key) => structuredClone(this.backend.values.get(key)));
	}

	async setMany(entries: Array<[string, unknown]>) {
		this.setManyCalls++;
		for (const [key, value] of entries) {
			this.backend.versions.set(key, (this.backend.versions.get(key) ?? 0) + 1);
			this.backend.values.set(key, structuredClone(value));
		}
	}

	async deleteMany(keys: string[]) {
		for (const key of keys) {
			this.backend.versions.set(key, (this.backend.versions.get(key) ?? 0) + 1);
			this.backend.values.delete(key);
		}
	}

	async getManyVersioned(keys: string[]) {
		return keys.map((key) => ({
			value: structuredClone(this.backend.values.get(key)),
			version: String(this.backend.versions.get(key) ?? 0)
		}));
	}

	async setManyVersioned(entries: CacheVersionedEntry[]) {
		this.setManyVersionedCalls++;
		return entries.map(([key, value, version]) => {
			if (String(this.backend.versions.get(key) ?? 0) !== version) return false;
			this.backend.values.set(key, structuredClone(value));
			return true;
		});
	}

	async invalidateMany(keys: string[]) {
		this.invalidateManyCalls++;
		for (const key of keys) {
			this.backend.versions.set(key, (this.backend.versions.get(key) ?? 0) + 1);
			this.backend.values.delete(key);
		}
	}
}

type FakeRedisEntry = { value: string | Buffer; expiresAt?: number };

class FakeEvalRedisClient {
	readonly entries = new Map<string, FakeRedisEntry>();
	readonly evalCalls: Array<{ script: string; keys: string[]; arguments: Array<string | Buffer> }> = [];
	private now = 1_000;

	advance(milliseconds: number) {
		this.now += milliseconds;
	}

	async mGet(keys: string[]) {
		return keys.map((key) => this.read(key));
	}

	async mSet(entries: Array<string | Buffer>) {
		for (let index = 0; index < entries.length; index += 2) {
			this.entries.set(String(entries[index]), { value: entries[index + 1] });
		}
		return 'OK';
	}

	multi() {
		const writes: Array<{ key: string; value: string | Buffer; ttl?: number }> = [];
		return {
			set: (key: string, value: string | Buffer, options?: { EX?: number }) => {
				writes.push({ key, value, ttl: options?.EX });
				return this;
			},
			exec: async () => {
				for (const write of writes) this.write(write.key, write.value, write.ttl);
				return writes.map(() => 'OK');
			}
		};
	}

	async del(keys: string[]) {
		let deleted = 0;
		for (const key of keys) {
			if (this.entries.delete(key)) deleted++;
		}
		return deleted;
	}

	async eval(script: string, options: { keys: string[]; arguments: Array<string | Buffer> }) {
		this.evalCalls.push({ script, keys: [...options.keys], arguments: [...options.arguments] });
		const [valueKey, versionKey] = options.keys;
		if (script.includes("redis.call('PTTL', KEYS[1])")) {
			const value = this.read(valueKey);
			let version = this.read(versionKey);
			if (version === null) {
				version = options.arguments[0];
				if (value === null) {
					this.write(versionKey, version, redisTtl(options.arguments[1]));
				} else {
					this.writeMilliseconds(versionKey, version, this.remainingMilliseconds(valueKey));
				}
			} else if (value !== null) {
				this.writeMilliseconds(versionKey, version, this.remainingMilliseconds(valueKey));
			} else if (this.remainingMilliseconds(versionKey) < 0) {
				this.write(versionKey, version, redisTtl(options.arguments[1]));
			}
			return [value, version];
		}
		if (script.includes('if version ~= ARGV[1]')) {
			const version = this.read(versionKey);
			if (version === null) {
				let replacement = options.arguments[3];
				if (String(replacement) === String(options.arguments[0])) replacement = `${String(replacement)}:rotated`;
				this.write(versionKey, replacement, redisTtl(options.arguments[4]));
				return 0;
			}
			if (String(version) !== String(options.arguments[0])) return 0;
			const ttl = redisTtl(options.arguments[2]);
			this.write(valueKey, options.arguments[1], ttl);
			this.write(versionKey, version, ttl);
			return 1;
		}
		if (script.includes('local token = ARGV[3]')) {
			let token = options.arguments[2];
			const version = this.read(versionKey);
			if (version !== null && String(token) === String(version)) token = `${String(token)}:rotated`;
			const ttl = redisTtl(options.arguments[1]);
			this.write(valueKey, options.arguments[0], ttl);
			this.write(versionKey, token, ttl);
			return 1;
		}
		if (script.includes("redis.call('DEL', KEYS[1])")) {
			let token = options.arguments[0];
			const version = this.read(versionKey);
			if (version !== null && String(token) === String(version)) token = `${String(token)}:rotated`;
			this.entries.delete(valueKey);
			this.write(versionKey, token, redisTtl(options.arguments[1]));
			return 1;
		}
		throw new Error('Unexpected Redis Lua script.');
	}

	private read(key: string) {
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
			this.entries.delete(key);
			return null;
		}
		return entry.value;
	}

	private write(key: string, value: string | Buffer, ttl?: number) {
		this.entries.set(key, {
			value,
			expiresAt: ttl === undefined ? undefined : this.now + ttl * 1_000
		});
	}

	private writeMilliseconds(key: string, value: string | Buffer, ttl: number) {
		this.entries.set(key, {
			value,
			expiresAt: ttl < 0 ? undefined : this.now + ttl
		});
	}

	private remainingMilliseconds(key: string) {
		if (this.read(key) === null) return -2;
		const expiresAt = this.entries.get(key)?.expiresAt;
		return expiresAt === undefined ? -1 : expiresAt - this.now;
	}
}

function redisTtl(value: string | Buffer | undefined) {
	if (value === undefined || String(value) === '') return undefined;
	return Number(value);
}

function redisClusterHashInput(key: string) {
	const start = key.indexOf('{');
	const end = key.indexOf('}', start + 1);
	return start >= 0 && end > start + 1 ? key.slice(start + 1, end) : key;
}

test('independent contexts sharing a cache cannot restore an invalidated stale read', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	let releaseRead!: () => void;
	let markRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markRead = resolve;
	});
	const readMayReturn = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const originalGetMany = store.getMany.bind(store);
	let delayNextRead = true;
	store.getMany = async (model, ids, options) => {
		const rows = await originalGetMany(model, ids, options);
		if (delayNextRead) {
			delayNextRead = false;
			markRead();
			await readMayReturn;
		}
		return rows;
	};

	const firstContext = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const secondContext = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const FirstRecord = SharedEpochRecord.use(firstContext) as unknown as typeof SharedEpochRecord;
	const SecondRecord = SharedEpochRecord.use(secondContext) as unknown as typeof SharedEpochRecord;
	const meta = firstContext.meta(SharedEpochRecord);
	await store.seed(meta, [{ id: 1, value: 'before' }]);

	const staleRead = FirstRecord.find(1).load();
	await readStarted;
	await store.update(meta, 1, { id: 1, value: 'after' });
	await secondContext.invalidate(secondContext.meta(SharedEpochRecord), 1);
	releaseRead();

	assert.equal((await staleRead)?.data.value, 'before');
	assert.deepEqual(cache.snapshot(), {});
	assert.equal((await SecondRecord.find(1).load())?.data.value, 'after');
});

test('independent physical stores cannot alias entity entries in a shared cache', async () => {
	const firstStore = new MemoryStoreAdapter();
	const secondStore = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const firstContext = createActiveTs({ stores: { default: firstStore }, caches: { default: cache } });
	const secondContext = createActiveTs({ stores: { default: secondStore }, caches: { default: cache } });
	const FirstRecord = SharedEpochRecord.use(firstContext) as unknown as typeof SharedEpochRecord;
	const SecondRecord = SharedEpochRecord.use(secondContext) as unknown as typeof SharedEpochRecord;
	await firstStore.seed(firstContext.meta(SharedEpochRecord), [{ id: 2, value: 'first store' }]);
	await secondStore.seed(secondContext.meta(SharedEpochRecord), [{ id: 2, value: 'second store' }]);

	assert.equal((await FirstRecord.find(2).load())?.data.value, 'first store');
	assert.equal((await SecondRecord.find(2).load())?.data.value, 'second store');
	assert.equal(Object.keys(cache.snapshot()).length, 2);
});

test('physical store cache isolation does not depend on matching route names', async () => {
	const firstStore = new MemoryStoreAdapter();
	const secondStore = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const firstContext = createActiveTs({
		stores: { primary: firstStore },
		caches: { default: cache },
		defaultStore: 'primary'
	});
	const secondContext = createActiveTs({
		stores: { secondary: secondStore },
		caches: { default: cache },
		defaultStore: 'secondary'
	});
	const FirstRecord = SharedEpochRecord.use(firstContext) as unknown as typeof SharedEpochRecord;
	const SecondRecord = SharedEpochRecord.use(secondContext) as unknown as typeof SharedEpochRecord;
	await firstStore.seed(firstContext.meta(SharedEpochRecord), [{ id: 4, value: 'primary store' }]);
	await secondStore.seed(secondContext.meta(SharedEpochRecord), [{ id: 4, value: 'secondary store' }]);

	assert.equal((await FirstRecord.find(4).load())?.data.value, 'primary store');
	assert.equal((await SecondRecord.find(4).load())?.data.value, 'secondary store');
	assert.equal(Object.keys(cache.snapshot()).length, 2);
});

test('generated local store scopes cannot collide with explicit cache scopes', async () => {
	const cache = new MemoryCacheAdapter();
	const primaryStore = new MemoryStoreAdapter();
	const generatedStore = new MemoryStoreAdapter();
	const primaryContext = createActiveTs({ stores: { default: primaryStore }, caches: { default: cache } });
	const generatedContext = createActiveTs({ stores: { default: generatedStore }, caches: { default: cache } });
	const PrimaryRecord = SharedEpochRecord.use(primaryContext) as unknown as typeof SharedEpochRecord;
	const GeneratedRecord = SharedEpochRecord.use(generatedContext) as unknown as typeof SharedEpochRecord;
	await primaryStore.seed(primaryContext.meta(SharedEpochRecord), [{ id: 6, value: 'primary' }]);
	await generatedStore.seed(generatedContext.meta(SharedEpochRecord), [{ id: 6, value: 'generated' }]);
	assert.equal((await PrimaryRecord.find(6).load())?.data.value, 'primary');
	assert.equal((await GeneratedRecord.find(6).load())?.data.value, 'generated');

	const generatedKey = Object.keys(cache.snapshot()).find((key) => key.includes(':local-scope:'));
	assert.ok(generatedKey);
	const generatedScope = /:local-scope:\d+:(local-\d+):/.exec(generatedKey)?.[1];
	assert.ok(generatedScope);
	const explicitStore = new MemoryStoreAdapter({ cacheScope: generatedScope });
	const explicitContext = createActiveTs({ stores: { default: explicitStore }, caches: { default: cache } });
	const ExplicitRecord = SharedEpochRecord.use(explicitContext) as unknown as typeof SharedEpochRecord;
	await explicitStore.seed(explicitContext.meta(SharedEpochRecord), [{ id: 6, value: 'explicit' }]);

	assert.equal((await ExplicitRecord.find(6).load())?.data.value, 'explicit');
	assert.equal(Object.keys(cache.snapshot()).length, 3);
});

test('transaction cache wrappers retain the root physical cache source', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: new MemoryCacheAdapter() }
	});
	const rootCache = context.cache('default')!;
	await context.transaction(async (transaction) => {
		assert.equal(
			cacheAdapterSource(transaction.cache('default')!),
			cacheAdapterSource(rootCache)
		);
	});
});

test('transaction non-target stores retain their root physical source', async () => {
	const context = createActiveTs({
		defaultStore: 'primary',
		stores: {
			primary: new MemoryStoreAdapter(),
			secondary: new MemoryStoreAdapter()
		},
		caches: { default: new MemoryCacheAdapter() }
	});
	const rootSecondary = context.store('secondary');
	await context.transaction(async (transaction) => {
		assert.equal(
			storeAdapterSource(transaction.store('secondary')),
			storeAdapterSource(rootSecondary)
		);
	}, { store: 'primary' });
});

test('pruned shared invalidation epochs still fence stale cache backfills', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	let releaseRead!: () => void;
	let markRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markRead = resolve;
	});
	const readMayReturn = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const originalGetMany = store.getMany.bind(store);
	store.getMany = async (model, ids, options) => {
		const rows = await originalGetMany(model, ids, options);
		markRead();
		await readMayReturn;
		return rows;
	};
	const context = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const Record = SharedEpochRecord.use(context) as unknown as typeof SharedEpochRecord;
	const meta = context.meta(SharedEpochRecord);
	await store.seed(meta, [{ id: 7, value: 'stale' }]);

	const staleRead = Record.find(7).load();
	await readStarted;
	await context.invalidate(meta, 7);
	for (let id = 10_000; id <= 14_096; id++) await context.invalidate(meta, id);
	releaseRead();

	assert.equal((await staleRead)?.data.value, 'stale');
	assert.equal(cache.snapshot()['shared_epoch_record:number:7'], undefined);
});

test('distributed cache versions reject stale backfills from another adapter instance', async () => {
	const store = new MemoryStoreAdapter({ cacheScope: 'shared-store' });
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const firstCache = new SharedVersionedCache(backend);
	const secondCache = new SharedVersionedCache(backend);
	let releaseRead!: () => void;
	let markRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markRead = resolve;
	});
	const readMayReturn = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const originalGetMany = store.getMany.bind(store);
	let delayNextRead = true;
	store.getMany = async (model, ids, options) => {
		const rows = await originalGetMany(model, ids, options);
		if (delayNextRead) {
			delayNextRead = false;
			markRead();
			await readMayReturn;
		}
		return rows;
	};

	const firstContext = createActiveTs({ stores: { default: store }, caches: { default: firstCache } });
	const secondContext = createActiveTs({ stores: { default: store }, caches: { default: secondCache } });
	const FirstRecord = DistributedEpochRecord.use(firstContext) as unknown as typeof DistributedEpochRecord;
	const SecondRecord = DistributedEpochRecord.use(secondContext) as unknown as typeof DistributedEpochRecord;
	const meta = firstContext.meta(DistributedEpochRecord);
	await store.seed(meta, [{ id: 3, value: 'before' }]);

	const staleRead = FirstRecord.find(3).load();
	await readStarted;
	await store.update(meta, 3, { id: 3, value: 'after' });
	await secondContext.invalidate(secondContext.meta(DistributedEpochRecord), 3);
	releaseRead();

	assert.equal((await staleRead)?.data.value, 'before');
	assert.equal(backend.values.size, 0);
	assert.equal((await SecondRecord.find(3).load())?.data.value, 'after');
});

test('distributed cache configuration fails before a durable model write', async () => {
	const store = new MemoryStoreAdapter();
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new SharedVersionedCache(backend) }
	});
	const Record = DistributedEpochRecord.use(context) as unknown as typeof DistributedEpochRecord;

	await assert.rejects(
		() => Record.create({ id: 30, value: 'must not commit' }),
		/must expose an explicit cacheScope/
	);
	assert.deepEqual(store.dump('distributed_epoch_record'), []);
});

test('distributed invalidation failures recover through an authoritative CAS backfill', async () => {
	class RecoveringVersionedCache extends SharedVersionedCache {
		failInvalidation = true;

		override async invalidateMany(keys: string[]) {
			if (this.failInvalidation) {
				this.failInvalidation = false;
				throw new Error('temporary invalidation failure');
			}
			await super.invalidateMany(keys);
		}
	}

	const store = new MemoryStoreAdapter({ cacheScope: 'recovery-store' });
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const cache = new RecoveringVersionedCache(backend);
	const context = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const Record = DistributedEpochRecord.use(context) as unknown as typeof DistributedEpochRecord;
	const meta = context.meta(DistributedEpochRecord);
	const key = 'store:7:default:scope:14:recovery-store:distributed_epoch_record:number:31';
	await store.seed(meta, [{ id: 31, value: 'authoritative' }]);
	backend.values.set(key, { id: 31, value: 'stale' });

	await assert.rejects(() => context.invalidate(meta, 31), /temporary invalidation failure/);
	assert.equal((await Record.find(31).load())?.data.value, 'authoritative');
	assert.equal(store.stats.getMany, 1);
	assert.equal((await Record.find(31).load())?.data.value, 'authoritative');
	assert.equal(store.stats.getMany, 1);
	assert.deepEqual(backend.values.get(key), { id: 31, value: 'authoritative' });
});

test('distributed function caches reject stale factories across adapter instances', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	let source = 'before';
	let releaseFactory!: () => void;
	let markFactory!: () => void;
	const factoryStarted = new Promise<void>((resolve) => {
		markFactory = resolve;
	});
	const factoryMayReturn = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const first = createFunctionCache<number, string>({
		prefix: 'distributed-function',
		cache: new SharedVersionedCache(backend),
		consistency: 'distributed',
		memory: false,
		factory: async () => {
			const value = source;
			markFactory();
			await factoryMayReturn;
			return value;
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'distributed-function',
		cache: new SharedVersionedCache(backend),
		consistency: 'distributed',
		memory: false,
		factory: async () => source
	});

	const stale = first.get(1);
	await factoryStarted;
	source = 'after';
	await second.invalidate(1);
	releaseFactory();

	assert.equal(await stale, 'before');
	assert.equal(backend.values.size, 0);
	assert.equal(await second.get(1), 'after');
});

test('distributed function cache explicit set fences an older factory without invalidate-read races', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	let releaseFactory!: () => void;
	let markFactory!: () => void;
	const factoryStarted = new Promise<void>((resolve) => {
		markFactory = resolve;
	});
	const factoryMayReturn = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const firstAdapter = new SharedVersionedCache(backend);
	const secondAdapter = new SharedVersionedCache(backend);
	const first = createFunctionCache<number, string>({
		prefix: 'distributed-explicit-set',
		cache: firstAdapter,
		consistency: 'distributed',
		memory: false,
		factory: async () => {
			markFactory();
			await factoryMayReturn;
			return 'stale';
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'distributed-explicit-set',
		cache: secondAdapter,
		consistency: 'distributed',
		memory: false,
		factory: async () => 'unused'
	});

	const stale = first.get(1);
	await factoryStarted;
	await second.set(1, 'authoritative');
	releaseFactory();

	assert.equal(await stale, 'stale');
	assert.equal(await second.peek(1), 'authoritative');
	assert.equal(secondAdapter.invalidateManyCalls, 0);
	assert.equal(secondAdapter.setManyCalls, 1);
	assert.equal(firstAdapter.setManyVersionedCalls, 0);
});

test('distributed function cache does not treat a missing read version as an authoritative write', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	let releaseInvalidation!: () => void;
	let markInvalidation!: () => void;
	const invalidationStarted = new Promise<void>((resolve) => {
		markInvalidation = resolve;
	});
	const invalidationMayFinish = new Promise<void>((resolve) => {
		releaseInvalidation = resolve;
	});
	class BlockingInvalidationCache extends SharedVersionedCache {
		override async invalidateMany(keys: string[]) {
			markInvalidation();
			await invalidationMayFinish;
			await super.invalidateMany(keys);
		}
	}
	const invalidator = createFunctionCache<number, string>({
		prefix: 'distributed-pending-invalidation',
		cache: new BlockingInvalidationCache(backend),
		consistency: 'distributed',
		memory: false,
		factory: async () => 'unused'
	});
	const readerAdapter = new SharedVersionedCache(backend);
	const reader = createFunctionCache<number, string>({
		prefix: 'distributed-pending-invalidation',
		cache: readerAdapter,
		consistency: 'distributed',
		memory: false,
		factory: async () => 'computed'
	});

	const invalidation = invalidator.invalidate(1);
	await invalidationStarted;
	assert.equal(await reader.get(1), 'computed');
	assert.equal(readerAdapter.setManyCalls, 0);
	assert.equal(readerAdapter.setManyVersionedCalls, 0);
	releaseInvalidation();
	await invalidation;
});

test('Redis versioned cache mixes ordinary writes and deletes without reopening stale CAS', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'coherence' });
	assert.ok(cache.getManyVersioned && cache.setManyVersioned && cache.invalidateMany);

	const initial = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(initial.value, undefined);
	await cache.setMany([['entry', { value: 'fresh' }]], { ttl: 2 });
	const afterSet = (await cache.getManyVersioned(['entry']))[0];
	assert.deepEqual(afterSet.value, { value: 'fresh' });
	assert.notEqual(afterSet.version, initial.version);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale' }, initial.version]]), [false]);

	client.advance(2_000);
	const expired = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(expired.value, undefined);
	assert.notEqual(expired.version, afterSet.version);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'expired stale' }, afterSet.version]]), [false]);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'refreshed' }, expired.version]]), [true]);

	await cache.deleteMany(['entry']);
	const afterDelete = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(afterDelete.value, undefined);
	assert.notEqual(afterDelete.version, expired.version);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale again' }, expired.version]]), [false]);
	for (const call of client.evalCalls) {
		assert.equal(call.keys.length, 2);
		assert.equal(redisClusterHashInput(call.keys[0]), redisClusterHashInput(call.keys[1]));
	}
});

test('Redis version tombstone expiry rejects an old CAS token and initializes a new fence', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'bounded' });
	assert.ok(cache.getManyVersioned && cache.setManyVersioned);

	const missing = (await cache.getManyVersioned(['entry']))[0];
	client.advance(24 * 60 * 60 * 1_000 + 1);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale' }, missing.version]]), [false]);

	const afterExpiry = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(afterExpiry.value, undefined);
	assert.notEqual(afterExpiry.version, missing.version);
	assert.deepEqual(await cache.getMany(['entry']), [undefined]);
});

test('Redis versioning preserves legacy value keys and hashes version keys with the exact value key', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'legacy' });
	const valueKey = `active-ts:${Buffer.from('legacy').toString('base64url')}:${Buffer.from('entry').toString('base64url')}`;

	assert.equal(cache.codecKey?.('entry'), valueKey);
	await cache.getManyVersioned?.(['entry']);
	const [call] = client.evalCalls;
	assert.equal(call.keys[0], valueKey);
	assert.equal(call.keys[1], `active-ts:version:{${valueKey}}`);
	assert.equal(redisClusterHashInput(call.keys[0]), redisClusterHashInput(call.keys[1]));
});

test('Redis keeps the legacy physical key format when versioning is unavailable', async () => {
	const client = {
		mGet: async () => [],
		mSet: async () => 'OK',
		multi: () => ({ set: () => undefined, exec: async () => [] }),
		del: async () => 0
	};
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'legacy' });
	assert.equal(
		cache.codecKey?.('entry'),
		`active-ts:${Buffer.from('legacy').toString('base64url')}:${Buffer.from('entry').toString('base64url')}`
	);
	assert.equal(cache.getManyVersioned, undefined);
});

test('codec cache adapters preserve version snapshots and conditional write results', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const cache = createCodecCacheAdapter(new SharedVersionedCache(backend), {
		name: 'tagged',
		encode: (value) => ({ encoded: value }),
		decode: (value: any) => value.encoded
	});
	assert.ok(cache.getManyVersioned && cache.setManyVersioned && cache.invalidateMany);
	const before = (await cache.getManyVersioned(['codec']))[0];
	assert.deepEqual(await cache.setManyVersioned([['codec', { answer: 42 }, before.version]]), [true]);
	assert.deepEqual((await cache.getManyVersioned(['codec']))[0].value, { answer: 42 });
});

test('cache version validators reject extra fields and detach accepted inputs', () => {
	const tuple = ['key', { nested: { value: 1 } }, 'version'] as unknown[];
	Object.defineProperty(tuple, 'map', { value: () => undefined, enumerable: true });
	assert.throws(() => normalizeCacheVersionedEntries([tuple], 'entries'), /non-index array property "map"/);

	const results = [true];
	Object.defineProperty(results, 'filter', { value: () => undefined, enumerable: true });
	assert.throws(() => normalizeCacheVersionedSetResult(results, 1, 'results'), /non-index array property "filter"/);

	const rows = [{ value: { nested: { value: 1 } }, version: 'version' }];
	Object.defineProperty(rows, 'forEach', { value: () => undefined, enumerable: true });
	assert.throws(() => normalizeCacheVersionedValues(rows, 1, 'rows'), /non-index array property "forEach"/);
	assert.throws(
		() => normalizeCacheVersionedValues([{ value: 1, version: 'version', extra: true }], 1, 'rows'),
		/unknown field "extra"/
	);

	const source = { nested: { value: 1 } };
	const normalized = normalizeCacheVersionedEntries([['key', source, 'version']], 'entries');
	source.nested.value = 2;
	assert.equal((normalized[0][1] as typeof source).nested.value, 1);
	assert.throws(
		() => normalizeCacheVersionedValues([{ get value() { return 1; }, version: 'version' }], 1, 'rows'),
		/enumerable data property/
	);
});

test('store cacheScope options are explicit, validated, and absent by default', async () => {
	assert.equal(new MemoryStoreAdapter().cacheScope, undefined);
	assert.equal(new MemoryStoreAdapter({ cacheScope: 'memory:tenant' }).cacheScope, 'memory:tenant');
	assert.throws(() => new MemoryStoreAdapter({ cacheScope: '' }), /cacheScope must be a non-empty string/);
	assert.throws(
		() => new MemoryStoreAdapter({ cacheScope: 'memory:tenant', typo: true } as any),
		/unknown option "typo"/
	);

	const postgres = await createPostgresStoreAdapter({
		pool: { query: async () => ({ rows: [] }) },
		cacheScope: 'postgres:tenant'
	});
	assert.equal(postgres.cacheScope, 'postgres:tenant');
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: { query: async () => ({ rows: [] }) }, cacheScope: '' }),
		/cacheScope must be a non-empty string/
	);

	const firestoreClient = {
		collection: () => ({}),
		getAll: async () => [],
		runTransaction: async () => undefined
	};
	const firestore = await createFirestoreStoreAdapter({ client: firestoreClient, cacheScope: 'firestore:tenant' });
	assert.equal(firestore.cacheScope, 'firestore:tenant');
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client: firestoreClient, cacheScope: '\0' }),
		/cacheScope must be a non-empty string/
	);
});
