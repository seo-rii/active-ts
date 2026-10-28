import { randomUUID } from 'node:crypto';
import { ActiveTsConfigurationError, safeErrorMessage } from '../../core/errors.js';
import { JSON_STRINGIFY } from '../../core/json-intrinsics.js';
import { WEAKMAP_GET, WEAKMAP_SET } from '../../core/collection-intrinsics.js';
import { datastoreMember, datastoreOptionalMethod, ownFactoryOptionValue } from './datastore-client-properties.js';

export type DatastorePhysicalIdentity = {
	projectId: string | undefined;
	databaseId: string | null | undefined;
	endpoint: string | undefined;
};

const DATASTORE_CLIENT_CACHE_SCOPE_IDS = new WeakMap<object, string>();

/** Snapshot physical connection identity without resolving credentials for injected clients. */
export async function resolveDatastorePhysicalIdentity(client: object, injected: boolean): Promise<DatastorePhysicalIdentity> {
	return {
		projectId: injected ? readConfiguredDatastoreProjectId(client) : await resolveDatastoreProjectId(client),
		databaseId: readDatastoreDatabaseId(client),
		endpoint: readDatastoreEndpointIdentity(client)
	};
}

/** Missing physical coordinates force a stable, per-client cache scope. */
export function datastorePhysicalCacheScope(
	client: object,
	identity: DatastorePhysicalIdentity,
	namespace: string | undefined,
	keyEncoding: 'active-ts' | 'native'
) {
	const projectId = identity.projectId;
	const databaseId = identity.databaseId;
	let clientIdentity: string | undefined;
	if (projectId === undefined || databaseId === undefined || identity.endpoint === undefined) {
		clientIdentity = WEAKMAP_GET.call(DATASTORE_CLIENT_CACHE_SCOPE_IDS, client) as string | undefined;
		if (clientIdentity === undefined) {
			clientIdentity = randomUUID();
			WEAKMAP_SET.call(DATASTORE_CLIENT_CACHE_SCOPE_IDS, client, clientIdentity);
		}
	}
	const projectPart = projectId === undefined ? '-' : `${projectId.length}:${projectId}`;
	const databasePart = databaseId === undefined
		? '-'
		: databaseId === null
			? 'default'
			: `${databaseId.length}:${databaseId}`;
	const namespacePart = namespace === undefined ? '-' : `${namespace.length}:${namespace}`;
	const clientPart = clientIdentity === undefined ? '-' : `${clientIdentity.length}:${clientIdentity}`;
	const endpointPart = identity.endpoint === undefined ? '-' : `${identity.endpoint.length}:${identity.endpoint}`;
	const keyEncodingPart = keyEncoding === 'native' ? '|keyEncoding=6:native' : '';
	return `datastore|project=${projectPart}|database=${databasePart}|namespace=${namespacePart}|client=${clientPart}|endpoint=${endpointPart}${keyEncodingPart}`;
}

// Use the configured client's endpoint snapshot, including the SDK-resolved
// emulator servicePath/port. Never infer an injected client's endpoint from the
// current process environment or from detached factory options.
function readDatastoreEndpointIdentity(client: object): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(client, 'options');
	if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) return undefined;
	const options = descriptor.value as Record<string, unknown>;
	const parts: Record<string, string | number> = {};
	let knownHost = false;
	for (const key of ['apiEndpoint', 'servicePath'] as const) {
		const value = ownFactoryOptionValue(options, key, 'Datastore adapter client.options');
		if (value === undefined) continue;
		if (typeof value !== 'string' || !value || value.includes('\0')) {
			throw new ActiveTsConfigurationError(`Datastore adapter client.options.${key} must be a non-empty string without null bytes.`);
		}
		parts[key] = value;
		knownHost = true;
	}
	const port = ownFactoryOptionValue(options, 'port', 'Datastore adapter client.options');
	if (port !== undefined) {
		if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
			throw new ActiveTsConfigurationError('Datastore adapter client.options.port must be a valid TCP port.');
		}
		parts.port = port as number;
	}
	return knownHost ? JSON_STRINGIFY(parts) : undefined;
}

function readConfiguredDatastoreProjectId(client: object): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(client, 'options');
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('Datastore adapter client.options must be a data property.');
	}
	if (!descriptor.enumerable && descriptor.value !== undefined) {
		throw new ActiveTsConfigurationError('Datastore adapter client.options must be enumerable.');
	}
	const options = descriptor.value;
	if (options === undefined) return undefined;
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Datastore adapter client.options must be an object.');
	}
	const projectId = ownFactoryOptionValue(
		options as Record<string, unknown>,
		'projectId',
		'Datastore adapter client.options'
	);
	if (projectId === undefined) return undefined;
	if (typeof projectId !== 'string' || !projectId || projectId.includes('\0')) {
		throw new ActiveTsConfigurationError(
			'Datastore adapter client.options.projectId must be a non-empty string without null bytes.'
		);
	}
	return projectId;
}

async function resolveDatastoreProjectId(client: object): Promise<string | undefined> {
	const configured = readConfiguredDatastoreProjectId(client);
	if (configured !== undefined) return configured;
	const getProjectId = datastoreMember(client, 'getProjectId', 'Datastore adapter client.getProjectId');
	if (getProjectId === undefined) return undefined;
	if (typeof getProjectId !== 'function') {
		throw new ActiveTsConfigurationError('Datastore adapter client.getProjectId must be a function.');
	}
	let projectId: unknown;
	try {
		projectId = await Reflect.apply(getProjectId, client, []);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`Datastore adapter client.getProjectId failed: ${safeErrorMessage(error)}`
		);
	}
	if (typeof projectId !== 'string' || !projectId || projectId.includes('\0')) {
		throw new ActiveTsConfigurationError(
			'Datastore adapter client.getProjectId must resolve to a non-empty string without null bytes.'
		);
	}
	return projectId;
}

function readDatastoreDatabaseId(client: object): string | null | undefined {
	const getDatabaseId = datastoreOptionalMethod(
		client,
		'getDatabaseId',
		'Datastore adapter client.getDatabaseId'
	);
	if (!getDatabaseId) return undefined;
	let databaseId: unknown;
	try {
		databaseId = getDatabaseId();
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`Datastore adapter client.getDatabaseId failed: ${safeErrorMessage(error)}`
		);
	}
	if (databaseId === undefined) return null;
	if (typeof databaseId !== 'string' || !databaseId || databaseId.includes('\0')) {
		throw new ActiveTsConfigurationError(
			'Datastore adapter client.getDatabaseId must return a non-empty string without null bytes, or undefined for the default database.'
		);
	}
	return databaseId;
}

