import {
	createActiveTs,
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	type CacheAdapter,
	type StoreAdapter
} from '../src/index.js';

// Custom structural adapters could already expose synchronous close methods.
// Adding the optional lifecycle contract must continue to accept those adapters.
class SynchronousCloseStore extends MemoryStoreAdapter {
	close(): void {}
}

class SynchronousCloseCache extends MemoryCacheAdapter {
	close(): void {}
}

function synchronousCloseAdapterCompatibility() {
	const store = new SynchronousCloseStore();
	const cache = new SynchronousCloseCache();
	const storeContract: StoreAdapter = store;
	const cacheContract: CacheAdapter = cache;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	return { context, storeContract, cacheContract };
}

void synchronousCloseAdapterCompatibility;
