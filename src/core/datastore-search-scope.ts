import { JSON_PARSE, JSON_STRINGIFY } from './json-intrinsics.js';
import { cloneJsonTransportPayload } from './native-payload.js';
import { ActiveTsConfigurationError } from './errors.js';
import type { StoreAdapter } from './types.js';

type ScopeStore = Pick<StoreAdapter, 'kind' | 'cacheScope' | 'datastoreProjectId' | 'datastoreDatabaseId' | 'datastoreNamespace' | 'datastoreKeyEncoding'>;

/** Canonical, portable identity metadata. Never infer an unknown physical database. */
export function datastoreSearchScopeForStore(store: ScopeStore): string | undefined {
	const { datastoreProjectId: project, datastoreDatabaseId: database, datastoreNamespace: namespace, datastoreKeyEncoding: encoding } = store;
	if (store.kind !== 'datastore' && project === undefined && database === undefined && encoding === undefined) return undefined;
	if (!validName(project) || (database !== null && !validName(database)) ||
		(namespace !== undefined && !validName(namespace)) || (store.cacheScope !== undefined && !validName(store.cacheScope)) ||
		(encoding !== 'active-ts' && encoding !== 'native')) {
		throw new ActiveTsConfigurationError('Datastore search requires known datastoreProjectId, datastoreDatabaseId (null for default), datastoreKeyEncoding, and a valid namespace.');
	}
	return JSON_STRINGIFY(cloneJsonTransportPayload([project, database, namespace ?? null, encoding, store.cacheScope ?? null]));
}

export function normalizeDatastoreSearchScope(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	let parts: unknown;
	try { parts = typeof value === 'string' ? JSON_PARSE(value) : undefined; } catch { /* rejected below */ }
	if (!Array.isArray(parts) || parts.length !== 5 || !validName(parts[0]) ||
		(parts[1] !== null && !validName(parts[1])) || (parts[2] !== null && !validName(parts[2])) ||
		(parts[3] !== 'active-ts' && parts[3] !== 'native') || (parts[4] !== null && !validName(parts[4])) || JSON_STRINGIFY(cloneJsonTransportPayload(parts)) !== value) {
		throw new ActiveTsConfigurationError('Datastore search scope must be canonical project/database/namespace/key-encoding metadata.');
	}
	return value as string;
}

export function datastoreSearchScopeNamespace(scope: string): string | undefined {
	return (JSON_PARSE(normalizeDatastoreSearchScope(scope)!) as [string, string | null, string | null, string, string | null])[2] ?? undefined;
}

function validName(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}
