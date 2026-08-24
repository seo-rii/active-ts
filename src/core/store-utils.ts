import type { StoreAdapter } from './types.js';
import { WEAKMAP_GET, WEAKMAP_SET } from './collection-intrinsics.js';

const storeAdapterSources = new WeakMap<object, object>();

export function markStoreAdapterSource<TAdapter extends StoreAdapter>(adapter: TAdapter, source: object): TAdapter {
	WEAKMAP_SET.call(storeAdapterSources, adapter, source);
	return adapter;
}

export function storeAdapterSource(adapter: StoreAdapter) {
	return resolveStoreAdapterSource(adapter);
}

export function storeAdapterSourceChain(adapter: StoreAdapter): object[] {
	return resolveStoreAdapterSourceChain(adapter);
}

function resolveStoreAdapterSource(source: object) {
	const chain = resolveStoreAdapterSourceChain(source);
	return chain[chain.length - 1];
}

function resolveStoreAdapterSourceChain(source: object) {
	let current = source;
	const seen: object[] = [];
	while (true) {
		seen[seen.length] = current;
		const next = WEAKMAP_GET.call(storeAdapterSources, current) as object | undefined;
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
