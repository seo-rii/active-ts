// Search adapter route selection and legacy metadata resolution.
import { ActiveContext } from './context.js';
import { ActiveTsConfigurationError, safeErrorMessage } from './errors.js';
import { assertSafeSchemaIdentifier } from './safe-keys.js';
import { searchAdapterSource, searchIndexAdapterKind, withSearchIndexesForAdapter } from './search-utils.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import { OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_GET_PROTOTYPE_OF, OBJECT_HAS_OWN } from './object-intrinsics.js';
import { resolveModelMeta } from './metadata.js';
import type { ModelConstructor, ResolvedModelMeta, SearchAdapter } from './types.js';

export function resolveSearchSyncAdapterRoutes(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	requested: string | undefined,
	search: SearchAdapter,
	searchSource: SearchAdapter
) {
	if (!context || requested !== undefined) {
		const route = requested ?? meta.search ?? search.kind;
		return [assertSearchSyncRouteHasIndexes(meta, searchSyncAdapterForRoute(context, meta, route, search, searchSource))];
	}
	const fallbackRoute = meta.search ?? search.kind;
	let registeredRoutes: ReturnType<ActiveContext['searchAdapterSchemaRoutesFor']>;
	try {
		registeredRoutes = context.searchAdapterSchemaRoutesFor(meta);
		const seenRoutes = new Set<string>();
		for (let index = 0; index < registeredRoutes.length; index++) {
			SET_ADD.call(seenRoutes, registeredRoutes[index].name);
			SET_ADD.call(seenRoutes, registeredRoutes[index].indexKind);
		}
		for (let index = 0; index < meta.searchIndexes.length; index++) {
			const adapterName = meta.searchIndexes[index].adapter;
			if (adapterName === undefined || SET_HAS.call(seenRoutes, adapterName)) continue;
			const route = context.searchAdapterRouteFor(meta, '', {}, adapterName);
			registeredRoutes[registeredRoutes.length] = route;
			SET_ADD.call(seenRoutes, adapterName);
			SET_ADD.call(seenRoutes, route.indexKind);
		}
	} catch (error) {
		if (safeErrorMessage(error) === `Search adapter "${fallbackRoute}" is not registered.`) {
			assertProvidedSearchAdapterMatchesRoute(fallbackRoute, search, searchIndexAdapterKind(search, fallbackRoute));
			return [{ name: fallbackRoute, indexKind: searchIndexAdapterKind(search, fallbackRoute), adapter: search }];
		}
		throw error;
	}
	let providedAdapterMatchesRegisteredRoute = false;
	const routes: Array<{ name: string; indexKind: string; adapter: SearchAdapter }> = [];
	for (let index = 0; index < registeredRoutes.length; index++) {
		const registered = registeredRoutes[index];
		if (isRegisteredSearchAdapterSource(registered.adapter, searchSource)) {
			providedAdapterMatchesRegisteredRoute = true;
		}
		const routedMeta = withSearchIndexesForAdapter(meta, registered.name, registered.indexKind);
		if (!routedMeta.searchIndexes.length) continue;
		routes[routes.length] = {
			name: registered.name,
			indexKind: registered.indexKind,
			adapter: registered.adapter
		};
	}
	if (!providedAdapterMatchesRegisteredRoute) {
		throw new ActiveTsConfigurationError(
			'Outbox search sync adapter does not match any registered search adapter route.'
		);
	}
	if (routes.length === 1 && isRegisteredSearchAdapterSource(routes[0].adapter, searchSource)) {
		return [{
			name: routes[0].name,
			indexKind: routes[0].indexKind,
			adapter: searchSyncExecutionAdapter(routes[0].adapter)
		}];
	}
	return routes;
}

export function searchSyncAdapterForRoute(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	route: string,
	search: SearchAdapter,
	searchSource: SearchAdapter
) {
	const actualIndexKind = searchIndexAdapterKind(search, route);
	if (!context) {
		assertProvidedSearchAdapterMatchesRoute(route, search, actualIndexKind);
		return { name: route, indexKind: actualIndexKind, adapter: search };
	}
	let registered: ReturnType<ActiveContext['searchAdapterRouteFor']>;
	try {
		registered = context.searchAdapterRouteFor(meta, '', {}, route);
	} catch (error) {
		if (safeErrorMessage(error) === `Search adapter "${route}" is not registered.`) {
			const physicalRoute = searchSyncAdapterForPhysicalRoute(
				context,
				meta,
				route,
				search,
				searchSource,
				actualIndexKind
			);
			if (physicalRoute) return physicalRoute;
			assertProvidedSearchAdapterMatchesRoute(route, search, actualIndexKind);
			return { name: route, indexKind: actualIndexKind, adapter: search };
		}
		throw error;
	}
	if (!isRegisteredSearchAdapterSource(registered.adapter, searchSource)) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match the registered search adapter.`
		);
	}
	if (registered.indexKind !== actualIndexKind) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match the provided search adapter "${search.kind}".`
		);
	}
	return {
		name: registered.name,
		indexKind: registered.indexKind,
		adapter: searchSyncExecutionAdapter(registered.adapter)
	};
}

export function searchSyncAdapterForPhysicalRoute(
	context: ActiveContext,
	meta: ResolvedModelMeta,
	route: string,
	search: SearchAdapter,
	searchSource: SearchAdapter,
	actualIndexKind: string
) {
	let registeredRoutes: ReturnType<ActiveContext['searchAdapterSchemaRoutesFor']>;
	try {
		registeredRoutes = context.searchAdapterSchemaRoutesFor(meta);
	} catch (error) {
		if (/^Search adapter ".+" is not registered\.$/.test(safeErrorMessage(error))) return undefined;
		throw error;
	}
	let matchedPhysicalRoute = false;
	for (let index = 0; index < registeredRoutes.length; index++) {
		const registered = registeredRoutes[index];
		if (registered.indexKind !== route) continue;
		matchedPhysicalRoute = true;
		if (!isRegisteredSearchAdapterSource(registered.adapter, searchSource)) continue;
		if (registered.indexKind !== actualIndexKind) {
			throw new ActiveTsConfigurationError(
				`Outbox search sync adapter "${route}" does not match the provided search adapter "${search.kind}".`
			);
		}
		return {
			name: registered.name,
			indexKind: registered.indexKind,
			adapter: searchSyncExecutionAdapter(registered.adapter)
		};
	}
	if (matchedPhysicalRoute) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match the registered search adapter.`
		);
	}
	return undefined;
}

export function assertSearchSyncRouteHasIndexes<T extends { name: string; indexKind: string }>(
	meta: ResolvedModelMeta,
	route: T
): T {
	if (!meta.searchIndexes.length) return route;
	if (withSearchIndexesForAdapter(meta, route.name, route.indexKind).searchIndexes.length) return route;
	throw new ActiveTsConfigurationError(
		`Outbox search sync adapter "${route.name}" has no search indexes for model "${meta.name}".`
	);
}

export function isRegisteredSearchAdapterSource(registered: SearchAdapter, provided: SearchAdapter) {
	const registeredSources = searchAdapterSourceChain(registered);
	for (const adapter of searchAdapterSourceChain(provided)) {
		if (SET_HAS.call(registeredSources, adapter)) return true;
	}
	return false;
}

export function searchSyncExecutionAdapter(registered: SearchAdapter) {
	return registered;
}

export function searchAdapterSourceChain(start: SearchAdapter) {
	const chain = new Set<SearchAdapter>();
	let current: SearchAdapter | undefined = start;
	while (current) {
		if (SET_HAS.call(chain, current)) return chain;
		SET_ADD.call(chain, current);
		const next = searchAdapterSource(current);
		if (next === current) return chain;
		current = next;
	}
	return chain;
}

export function assertProvidedSearchAdapterMatchesRoute(route: string, search: SearchAdapter, actualIndexKind: string) {
	if (search.kind !== route && actualIndexKind !== route) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match search adapter "${search.kind}".`
		);
	}
}

export function legacyOutboxMeta(model: ModelConstructor, name: string): ResolvedModelMeta {
	const resolved = legacyResolvedOutboxMeta(model);
	return {
		model,
		name,
		store: 'outbox',
		idField: resolved?.datastore?.ancestor ? resolved.idField : 'id',
		readValidation: resolved?.datastore?.ancestor ? resolved.readValidation : 'off' as const,
		indexes: [],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: resolved?.datastore?.ancestor ? resolved.fieldCodecs : new Map(),
		fieldTypes: resolved?.datastore?.ancestor ? resolved.fieldTypes : new Map(),
		datastore: resolved?.datastore
	};
}

export function legacyResolvedOutboxMeta(model: ModelConstructor) {
	try {
		return resolveModelMeta(model, { store: 'outbox' });
	} catch (error) {
		if (
			error instanceof ActiveTsConfigurationError &&
			/ is missing entity metadata\./.test(safeErrorMessage(error))
		) {
			return undefined;
		}
		throw error;
	}
}

export function outboxModelName(model: ModelConstructor) {
	const modelName = staticModelString(model, 'modelName', true);
	return assertSafeSchemaIdentifier(modelName ?? staticModelString(model, 'name', false), 'Outbox search sync model name');
}

export function staticModelString(model: ModelConstructor, property: 'modelName' | 'name', inherited: boolean) {
	let current: unknown = model;
	while (typeof current === 'function') {
		if (OBJECT_HAS_OWN(current, property)) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`Outbox search sync model ${property} must be a data property.`);
			}
			if (descriptor.value !== undefined && typeof descriptor.value !== 'string') {
				throw new ActiveTsConfigurationError(`Outbox search sync model ${property} must be a string.`);
			}
			return descriptor.value as string | undefined;
		}
		if (!inherited) return undefined;
		const next = OBJECT_GET_PROTOTYPE_OF(current);
		if (!next || next === Function.prototype) return undefined;
		current = next;
	}
	return undefined;
}
