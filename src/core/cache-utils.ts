import type { CacheAdapter } from './types.js';
import { WEAKMAP_GET, WEAKMAP_SET } from './collection-intrinsics.js';

const cacheAdapterSources = new WeakMap<object, object>();

export function markCacheAdapterSource<TAdapter extends CacheAdapter>(adapter: TAdapter, source: object): TAdapter {
	WEAKMAP_SET.call(cacheAdapterSources, adapter, source);
	return adapter;
}

export function cacheAdapterSource(adapter: CacheAdapter) {
	return resolveCacheAdapterSource(adapter);
}

export function cacheAdapterSourceChain(adapter: CacheAdapter): object[] {
	return resolveCacheAdapterSourceChain(adapter);
}

function resolveCacheAdapterSource(source: object) {
	const chain = resolveCacheAdapterSourceChain(source);
	return chain[chain.length - 1];
}

function resolveCacheAdapterSourceChain(source: object) {
	let current = source;
	const seen: object[] = [];
	while (true) {
		seen[seen.length] = current;
		const next = WEAKMAP_GET.call(cacheAdapterSources, current) as object | undefined;
		if (!next || hasSeenSource(seen, next)) return seen;
		current = next;
	}
}

function hasSeenSource(seen: object[], source: object) {
	for (let index = 0; index < seen.length; index++) {
		if (seen[index] === source) return true;
	}
	return false;
}
