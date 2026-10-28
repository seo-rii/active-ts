import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, createFunctionCache, MemoryCacheAdapter, MemoryStoreAdapter, type CacheAdapter } from '../src/index.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

for (const read of ['get', 'peek'] as const) {
	test(`a persistent ${read} begun before refresh cannot prime memory with its stale hit`, async () => {
		const remote = new MemoryCacheAdapter();
		const started = deferred();
		const release = deferred();
		let blockNextRead = false;
		const delayed: CacheAdapter = {
			kind: 'refresh-delayed-hit',
			async getMany(keys) {
				const snapshot = await remote.getMany(keys);
				if (blockNextRead) {
					blockNextRead = false;
					started.resolve();
					await release.promise;
				}
				return snapshot;
			},
			setMany: (...args) => remote.setMany(...args),
			deleteMany: (...args) => remote.deleteMany(...args)
		};
		const cache = createFunctionCache({ prefix: `refresh-hit-${read}`, cache: delayed, factory: () => ({ revision: 2 }) });
		await cache.set(1, { revision: 1 });
		cache.clearMemory();
		blockNextRead = true;
		const normal = cache[read](1);
		await started.promise;
		assert.deepEqual(await cache.get(1, { refresh: true }), { revision: 2 });
		release.resolve();
		assert.deepEqual(await normal, { revision: 1 });
		assert.deepEqual(await cache.get(1), { revision: 2 });
		assert.deepEqual(Object.values(remote.snapshot()).map(entry => entry.value), [{ revision: 2 }]);
	});
}

for (const persistent of [false, true]) {
	for (const singleFlight of [false, true]) {
		test(`refresh fences an older factory (${persistent ? 'persistent' : 'memory'}, singleFlight=${singleFlight})`, async () => {
			const started = deferred();
			const release = deferred();
			let calls = 0;
			const cache = createFunctionCache({
				prefix: `refresh-factory-${persistent}-${singleFlight}`, cache: persistent ? new MemoryCacheAdapter() : false,
				...(persistent ? { memory: false as const } : {}), singleFlight,
				async factory() {
					const revision = ++calls;
					if (revision === 1) { started.resolve(); await release.promise; }
					return { revision };
				}
			});
			const normal = cache.get(1);
			await started.promise;
			assert.deepEqual(await cache.get(1, { refresh: true }), { revision: 2 });
			release.resolve();
			assert.deepEqual(await normal, { revision: 1 });
			assert.deepEqual(await cache.get(1), { revision: 2 });
			assert.equal(calls, 2);
		});
	}
}

test('concurrent refresh callers share one generation and receive isolated results', async () => {
	const started = deferred();
	const release = deferred();
	let calls = 0;
	const cache = createFunctionCache({ prefix: 'refresh-generation-singleflight', cache: false,
		async factory() { calls++; started.resolve(); await release.promise; return { nested: ['fresh'] }; } });
	const first = cache.get(1, { refresh: true });
	await started.promise;
	const second = cache.get(1, { refresh: true });
	release.resolve();
	const [one, two] = await Promise.all([first, second]);
	assert.equal(calls, 1);
	one.nested.push('changed');
	assert.deepEqual(two, { nested: ['fresh'] });
});

test('a transaction refresh leaves root memory and in-flight publication unchanged on rollback', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const cache = createFunctionCache({ prefix: 'refresh-transaction-bypass', context, cache: false,
		factory: () => ({ revision: context.isInTransaction() ? 'tx' : 'root' }) });
	assert.deepEqual(await cache.get(1), { revision: 'root' });
	await assert.rejects(context.transaction(async () => {
		assert.deepEqual(await cache.get(1, { refresh: true }), { revision: 'tx' });
		throw new Error('rollback refresh');
	}), /rollback refresh/);
	assert.deepEqual(await cache.get(1), { revision: 'root' });
	assert.equal(cache.stats.memoryHits, 1);
});

for (const delay of ['before-write', 'after-write'] as const) {
	for (const sharedInstance of [false, true]) {
		test(`refresh preserves its persistent value across an older ${delay} adapter call (${sharedInstance ? 'two instances' : 'one instance'})`, async () => {
			const remote = new MemoryCacheAdapter();
			const oldWriteStarted = deferred();
			const releaseOldWrite = deferred();
			const refreshFactoryStarted = deferred();
			let calls = 0;
			const adapter: CacheAdapter = {
				kind: 'refresh-blocked-write',
				getMany: (...args) => remote.getMany(...args),
				async setMany(entries, options) {
					if (entries[0][1].revision === 1) {
						if (delay === 'after-write') await remote.setMany(entries, options);
						oldWriteStarted.resolve();
						await releaseOldWrite.promise;
						if (delay === 'before-write') await remote.setMany(entries, options);
					} else await remote.setMany(entries, options);
				},
				deleteMany: (...args) => remote.deleteMany(...args)
			};
			const options = {
				prefix: `refresh-adapter-write-${delay}-${sharedInstance}`, cache: adapter, memory: false as const,
				factory() {
					const revision = ++calls;
					if (revision === 2) refreshFactoryStarted.resolve();
					return { revision };
				}
			};
			const cache = createFunctionCache(options);
			const refresher = sharedInstance ? createFunctionCache(options) : cache;
			const old = cache.get(1);
			await oldWriteStarted.promise;
			const refreshed = refresher.get(1, { refresh: true });
			await refreshFactoryStarted.promise;
			// Let an unfenced refresh complete while the older adapter call remains blocked.
			await new Promise<void>(resolve => setImmediate(resolve));
			releaseOldWrite.resolve();
			assert.deepEqual(await refreshed, { revision: 2 });
			assert.deepEqual(await old, { revision: 1 });
			assert.deepEqual(Object.values(remote.snapshot()).map(entry => entry.value), [{ revision: 2 }]);
			assert.deepEqual(await cache.get(1), { revision: 2 });
			assert.equal(calls, 2);
		});
	}
}

class VersionedCache implements CacheAdapter {
	readonly kind = 'refresh-versioned-memory';
	readonly storage = new MemoryCacheAdapter();
	readonly versions = new Map<string, number>();
	invalidations = 0;
	failInvalidation = false;
	getMany = this.storage.getMany.bind(this.storage);
	setMany = this.storage.setMany.bind(this.storage);
	deleteMany = this.storage.deleteMany.bind(this.storage);
	async getManyVersioned(keys: string[]) {
		const values = await this.getMany(keys);
		return keys.map((key, index) => ({ value: values[index], version: String(this.versions.get(key) ?? 0) }));
	}
	async setManyVersioned(entries: Array<[string, unknown, string]>) {
		const results: boolean[] = [];
		for (const [key, value, expected] of entries) {
			const accepted = String(this.versions.get(key) ?? 0) === expected;
			if (accepted) await this.setMany([[key, value]]);
			results.push(accepted);
		}
		return results;
	}
	async invalidateMany(keys: string[]) {
		this.invalidations++;
		if (this.failInvalidation) throw new Error('refresh invalidation failed');
		for (const key of keys) this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
		await this.deleteMany(keys);
	}
}

test('distributed refresh advances the persistent token and rejects an older remote factory', async () => {
	const adapter = new VersionedCache();
	const cache = createFunctionCache({ prefix: 'refresh-distributed-token', cache: adapter,
		consistency: 'distributed', factory: () => ({ revision: 2 }) });
	await cache.set(1, { revision: 1 });
	const key = Object.keys(adapter.storage.snapshot())[0];
	const [old] = await adapter.getManyVersioned([key]);
	assert.deepEqual(await cache.get(1, { refresh: true }), { revision: 2 });
	assert.deepEqual(await adapter.setManyVersioned([[key, { revision: 1 }, old.version]]), [false]);
	assert.deepEqual(await cache.get(1), { revision: 2 });
	assert.equal(adapter.invalidations, 1);
});

test('distributed refresh singleflight shares one persistent invalidation and recovers from failure', async () => {
	const adapter = new VersionedCache();
	const cache = createFunctionCache({ prefix: 'refresh-distributed-recovery', cache: adapter,
		consistency: 'distributed', factory: () => ({ revision: 2 }) });
	await cache.set(1, { revision: 1 });
	adapter.failInvalidation = true;
	await assert.rejects(cache.get(1, { refresh: true }), /refresh invalidation failed/);
	adapter.failInvalidation = false;
	const [first, second] = await Promise.all([cache.get(1, { refresh: true }), cache.get(1, { refresh: true })]);
	assert.deepEqual(first, { revision: 2 });
	assert.deepEqual(second, { revision: 2 });
	assert.equal(adapter.invalidations, 2);
	assert.deepEqual(await cache.get(1), { revision: 2 });
});

test('a persistent read started during refresh cannot restore its old snapshot afterward', async () => {
	const remote = new MemoryCacheAdapter();
	const factoryStarted = deferred();
	const releaseFactory = deferred();
	const readStarted = deferred();
	const releaseRead = deferred();
	let blockRead = false;
	const adapter: CacheAdapter = {
		kind: 'during-refresh-read',
		async getMany(keys) {
			const values = await remote.getMany(keys);
			if (blockRead) { blockRead = false; readStarted.resolve(); await releaseRead.promise; }
			return values;
		},
		setMany: (...args) => remote.setMany(...args),
		deleteMany: (...args) => remote.deleteMany(...args)
	};
	const cache = createFunctionCache({ prefix: 'refresh-overlapping-read', cache: adapter,
		async factory() { factoryStarted.resolve(); await releaseFactory.promise; return { revision: 2 }; } });
	await cache.set(1, { revision: 1 });
	cache.clearMemory();
	const refreshed = cache.get(1, { refresh: true });
	await factoryStarted.promise;
	blockRead = true;
	const normal = cache.get(1);
	await readStarted.promise;
	releaseFactory.resolve();
	assert.deepEqual(await refreshed, { revision: 2 });
	releaseRead.resolve();
	assert.deepEqual(await normal, { revision: 1 });
	assert.deepEqual(await cache.get(1), { revision: 2 });
});

for (const persistent of [false, true]) {
	test(`a factory started during refresh cannot publish afterward (${persistent ? 'persistent' : 'memory'})`, async () => {
		const refreshStarted = deferred();
		const releaseRefresh = deferred();
		const normalStarted = deferred();
		const releaseNormal = deferred();
		let calls = 0;
		const cache = createFunctionCache({
			prefix: `refresh-overlapping-factory-${persistent}`, cache: persistent ? new MemoryCacheAdapter() : false,
			...(persistent ? { memory: false as const } : {}),
			async factory() {
				if (++calls === 1) { refreshStarted.resolve(); await releaseRefresh.promise; return { revision: 2 }; }
				normalStarted.resolve(); await releaseNormal.promise; return { revision: 1 };
			}
		});
		const refreshed = cache.get(1, { refresh: true });
		await refreshStarted.promise;
		const normal = cache.get(1);
		await normalStarted.promise;
		releaseRefresh.resolve();
		assert.deepEqual(await refreshed, { revision: 2 });
		releaseNormal.resolve();
		assert.deepEqual(await normal, { revision: 1 });
		assert.deepEqual(await cache.get(1), { revision: 2 });
		assert.equal(calls, 2);
	});
}

test('refresh expires existing memory in other local cache instances sharing the key', async () => {
	const remote = new MemoryCacheAdapter();
	const first = createFunctionCache({ prefix: 'refresh-shared-memory', cache: remote, factory: () => ({ revision: 2 }) });
	const second = createFunctionCache({ prefix: 'refresh-shared-memory', cache: remote,
		factory() { throw new Error('The persistent refreshed value must be present.'); } });
	await first.set(1, { revision: 1 });
	assert.deepEqual(await second.get(1), { revision: 1 });
	assert.deepEqual(await first.get(1, { refresh: true }), { revision: 2 });
	assert.deepEqual(await second.get(1), { revision: 2 });
});

test('refresh singleflight remains shared while afterCacheSet hooks finish', async () => {
	const hookStarted = deferred();
	const releaseHook = deferred();
	let calls = 0;
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, plugins: [{
		name: 'refresh-after-set-singleflight', hooks: { async afterCacheSet(payload) {
			if (payload.operation !== 'function-cache') return;
			hookStarted.resolve(); await releaseHook.promise;
		} }
	}] });
	const cache = createFunctionCache({ prefix: 'refresh-after-set-singleflight', context, cache: false,
		factory: () => ({ revision: ++calls }) });
	const first = cache.get(1, { refresh: true });
	await hookStarted.promise;
	const second = cache.get(1, { refresh: true });
	releaseHook.resolve();
	assert.deepEqual(await first, { revision: 1 });
	assert.deepEqual(await second, { revision: 1 });
	assert.equal(calls, 1);
});
