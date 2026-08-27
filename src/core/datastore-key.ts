import { ActiveTsValidationError } from './errors.js';
import {
	assertSafeEntityId,
	assertSafePhysicalIdentifierLength,
	assertSafeSchemaIdentifier
} from './safe-keys.js';
import { SET_ADD, SET_HAS, WEAKSET_ADD, WEAKSET_HAS } from './collection-intrinsics.js';
import { entityIdFromCanonicalKey, entityIdFromKey, entityIdKey } from './query-utils.js';
import {
	datastoreInt64Id,
	isDatastoreInt64Id,
	type DatastoreInt64Id
} from './datastore-int64-id.js';
import type { DatastoreKey, DatastoreKeyPart, EntityId } from './types.js';

export type DatastoreAncestorMetadata = {
	datastoreAncestor: DatastoreKey;
};
export type DatastoreAncestorReadOptions = {
	meta: DatastoreAncestorMetadata;
};
export type DatastoreAncestorWriteOptions = {
	meta: DatastoreAncestorMetadata;
};
export type DatastoreAncestorOptions = DatastoreAncestorReadOptions & DatastoreAncestorWriteOptions;
export type DatastoreReadConsistency = 'strong' | 'eventual';
export type DatastoreReadPolicy =
	| { readTime: number; consistency?: never }
	| { readTime?: never; consistency: DatastoreReadConsistency };
export type DatastoreReadOptionsInput =
	| { readTime: number | Date; consistency?: never; ancestor?: DatastoreKey }
	| { readTime?: never; consistency: DatastoreReadConsistency; ancestor?: DatastoreKey };
export type DatastoreReadMetadata = {
	datastoreRead: DatastoreReadPolicy;
	datastoreAncestor?: DatastoreKey;
};
export type DatastoreReadOptions = {
	meta: DatastoreReadMetadata;
};
export type DatastoreKeyEncoding = 'active-ts' | 'native';

const DATASTORE_KEY_KEYS = ['path', 'namespace'] as const;
const DATASTORE_KEY_PART_KEYS = ['kind', 'id'] as const;
const DATASTORE_KEY_OPTION_KEYS = ['parent', 'namespace'] as const;
const DATASTORE_READ_POLICY_KEYS = ['readTime', 'consistency'] as const;
const DATASTORE_READ_OPTION_KEYS = ['readTime', 'consistency', 'ancestor'] as const;

export function datastoreKey(
	kind: string,
	id: EntityId,
	options: { parent?: DatastoreKey; namespace?: string } = {}
): DatastoreKey {
	const optionRecord = assertPlainRecord(options, 'Datastore key options');
	assertKnownKeys(optionRecord, DATASTORE_KEY_OPTION_KEYS, 'Datastore key options');
	const parent = ownValue(optionRecord, 'parent') as DatastoreKey | undefined;
	const namespace = normalizeDatastoreNamespace(ownValue(optionRecord, 'namespace'), 'Datastore key options.namespace');
	const parentKey = parent === undefined ? undefined : normalizeDatastoreKey(parent, 'Datastore key options.parent');
	const parentNamespace = parentKey?.namespace;
	if (parentNamespace !== undefined && namespace !== undefined && parentNamespace !== namespace) {
		throw new ActiveTsValidationError('Datastore key namespace must match parent namespace.');
	}
	const path = parentKey ? cloneDatastoreKeyParts(parentKey.path) : [];
	path[path.length] = {
		kind: normalizeDatastoreKind(kind, 'Datastore key kind'),
		id: normalizeDatastoreEntityId(id, 'Datastore key id')
	};
	return freezeDatastoreKey({
		path,
		namespace: namespace ?? parentNamespace
	});
}

export function datastoreAncestorOptions(ancestor: DatastoreKey): DatastoreAncestorOptions {
	const safeAncestor = normalizeDatastoreKey(ancestor, 'Datastore ancestor options.datastoreAncestor');
	return Object.freeze({
		meta: Object.freeze({
			datastoreAncestor: safeAncestor
		})
	});
}

export function datastoreReadOptions(options: DatastoreReadOptionsInput): DatastoreReadOptions {
	const record = assertPlainRecord(options, 'Datastore read options');
	assertKnownKeys(record, DATASTORE_READ_OPTION_KEYS, 'Datastore read options');
	const readTime = ownValue(record, 'readTime');
	const consistency = ownValue(record, 'consistency');
	const policy = normalizeDatastoreReadPolicy(
		readTime === undefined
			? { consistency }
			: {
					readTime: normalizeDatastoreReadTime(readTime, 'Datastore read options.readTime'),
					consistency
				},
		'Datastore read options'
	);
	const ancestorValue = ownValue(record, 'ancestor');
	const ancestor = ancestorValue === undefined
		? undefined
		: normalizeDatastoreKey(ancestorValue, 'Datastore read options.ancestor');
	const meta: DatastoreReadMetadata = ancestor === undefined
		? { datastoreRead: policy }
		: { datastoreRead: policy, datastoreAncestor: ancestor };
	Object.freeze(policy);
	Object.freeze(meta);
	return Object.freeze({ meta });
}

export function normalizeDatastoreReadPolicy(value: unknown, context: string): DatastoreReadPolicy {
	const record = assertPlainRecord(value, context);
	assertKnownKeys(record, DATASTORE_READ_POLICY_KEYS, context);
	const rawReadTime = ownValue(record, 'readTime');
	const consistency = ownValue(record, 'consistency');
	if (rawReadTime !== undefined && consistency !== undefined) {
		throw new ActiveTsValidationError(`${context} cannot combine readTime with consistency.`);
	}
	if (rawReadTime === undefined && consistency === undefined) {
		throw new ActiveTsValidationError(`${context} requires readTime or consistency.`);
	}
	if (rawReadTime !== undefined) {
		return { readTime: normalizeDatastoreReadTime(rawReadTime, `${context}.readTime`) };
	}
	if (consistency !== 'strong' && consistency !== 'eventual') {
		throw new ActiveTsValidationError(`${context}.consistency must be "strong" or "eventual".`);
	}
	return { consistency };
}

export function normalizeDatastoreReadTime(value: unknown, context: string): number {
	let readTime = value;
	if (value instanceof Date) {
		try {
			readTime = Date.prototype.getTime.call(value);
		} catch {
			throw new ActiveTsValidationError(`${context} must be a positive safe integer timestamp or valid Date.`);
		}
	}
	if (typeof readTime !== 'number' || !Number.isSafeInteger(readTime) || readTime <= 0) {
		throw new ActiveTsValidationError(`${context} must be a positive safe integer timestamp or valid Date.`);
	}
	return readTime;
}

export function normalizeDatastoreKey(value: unknown, context = 'Datastore key'): DatastoreKey {
	const record = assertPlainRecord(value, context);
	assertKnownKeys(record, DATASTORE_KEY_KEYS, context);
	const path = ownValue(record, 'path');
	if (!Array.isArray(path) || !path.length) {
		throw new ActiveTsValidationError(`${context}.path must be a non-empty array.`);
	}
	if (Object.getOwnPropertySymbols(path).length) {
		throw new ActiveTsValidationError(`${context}.path cannot contain symbol fields.`);
	}
	const parts: DatastoreKeyPart[] = [];
	for (let index = 0; index < path.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(path, index)) {
			throw new ActiveTsValidationError(`${context}.path[${index}] is missing.`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(path, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.path[${index}] must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.path[${index}] must be enumerable.`);
		}
		parts[index] = normalizeDatastoreKeyPart(descriptor.value, `${context}.path[${index}]`);
	}
	for (const property of Object.getOwnPropertyNames(path)) {
		if (property === 'length') continue;
		if (!/^(0|[1-9]\d*)$/.test(property) || Number(property) >= path.length) {
			throw new ActiveTsValidationError(`${context}.path cannot contain non-index array property "${property}".`);
		}
	}
	return freezeDatastoreKey({
		path: parts,
		namespace: normalizeDatastoreNamespace(ownValue(record, 'namespace'), `${context}.namespace`)
	});
}

export function datastoreKeyWithNamespace(
	key: DatastoreKey,
	namespace: string | undefined,
	context = 'Datastore key'
): DatastoreKey {
	const safeKey = normalizeDatastoreKey(key, context);
	const safeNamespace = normalizeDatastoreNamespace(namespace, `${context}.namespace`);
	if (safeNamespace === undefined || safeKey.namespace === safeNamespace) return safeKey;
	if (safeKey.namespace !== undefined) {
		throw new ActiveTsValidationError(`${context} namespace must match adapter namespace.`);
	}
	return freezeDatastoreKey({
		path: cloneDatastoreKeyParts(safeKey.path),
		namespace: safeNamespace
	});
}

export function datastoreKeyPathValues(
	key: DatastoreKey,
	keyEncoding: DatastoreKeyEncoding = 'active-ts'
): Array<string | number | DatastoreInt64Id> {
	const safeKey = normalizeDatastoreKey(key);
	const path: Array<string | number | DatastoreInt64Id> = [];
	for (let index = 0; index < safeKey.path.length; index++) {
		const part = safeKey.path[index];
		path[path.length] = part.kind;
		path[path.length] = keyEncoding === 'native'
			? assertNativeDatastoreEntityId(part.id, `Datastore key path[${index}].id`)
			: entityIdKey(part.id);
	}
	return path;
}

export function assertNativeDatastoreEntityId(value: EntityId, context: string): EntityId {
	assertSafeEntityId(value, context);
	if (isDatastoreInt64Id(value)) return value;
	if (typeof value === 'number' && value === 0) {
		throw new ActiveTsValidationError(`${context} cannot be zero for native Datastore key encoding.`);
	}
	return value;
}

export function datastoreEntityIdFromNativeNumeric(value: string | number, context: string): EntityId {
	if (typeof value === 'number') return assertNativeDatastoreEntityId(value, context);
	if (!/^-?(0|[1-9]\d*)$/.test(value) || value === '-0') {
		throw new ActiveTsValidationError(`${context} must be a canonical Datastore integer.`);
	}
	let parsed: bigint;
	try {
		parsed = BigInt(value);
	} catch {
		throw new ActiveTsValidationError(`${context} must be a canonical Datastore integer.`);
	}
	if (parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) {
		const id = Number(parsed);
		assertNativeDatastoreEntityId(id, context);
		return id;
	}
	return datastoreInt64Id(value);
}

export function datastoreAncestorFromEntityKey(
	key: unknown,
	modelKind: string,
	expectedId: EntityId,
	context: string,
	keyEncoding: DatastoreKeyEncoding = 'active-ts'
): DatastoreKey | undefined {
	let normalizedEntityKey: DatastoreKey | undefined;
	if (keyEncoding === 'native' && datastoreKeyOptionalProperty(key, 'kind', context) !== undefined) {
		const reversedPath: DatastoreKeyPart[] = [];
		const seen = new WeakSet<object>();
		let cursor: unknown = key;
		while (cursor !== undefined) {
			if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
				throw new ActiveTsValidationError(`${context}.parent must be a Datastore key object.`);
			}
			if (WEAKSET_HAS.call(seen, cursor as object)) {
				throw new ActiveTsValidationError(`${context}.parent cannot contain a cycle.`);
			}
			WEAKSET_ADD.call(seen, cursor as object);
			const partContext = `${context} key part[${reversedPath.length}]`;
			const kind = datastorePathKind(datastoreKeyOptionalProperty(cursor, 'kind', partContext), `${partContext}.kind`);
			const name = datastoreKeyOptionalProperty(cursor, 'name', partContext);
			const rawId = datastoreKeyOptionalProperty(cursor, 'id', partContext);
			if (name !== undefined && rawId !== undefined) {
				throw new ActiveTsValidationError(`${partContext} cannot contain both name and id.`);
			}
			let id: EntityId;
			if (name !== undefined) {
				if (typeof name !== 'string') {
					throw new ActiveTsValidationError(`${partContext}.name must be a string.`);
				}
				assertSafeEntityId(name, `${partContext}.name`);
				id = name;
			} else if (typeof rawId === 'number' || typeof rawId === 'string') {
				id = datastoreEntityIdFromNativeNumeric(rawId, `${partContext}.id`);
			} else {
				throw new ActiveTsValidationError(`${partContext}.id must be a number or canonical integer string.`);
			}
			reversedPath[reversedPath.length] = { kind, id };
			cursor = datastoreKeyOptionalProperty(cursor, 'parent', partContext);
		}
		const path: DatastoreKeyPart[] = [];
		for (let index = reversedPath.length - 1; index >= 0; index--) {
			path[path.length] = reversedPath[index];
		}
		const namespace = datastoreKeyOptionalProperty(key, 'namespace', context);
		normalizedEntityKey = normalizeDatastoreKey({ path, namespace }, context);
	}
	const rawPath = normalizedEntityKey === undefined ? datastoreKeyOptionalPathProperty(key, context) : undefined;
	if (normalizedEntityKey === undefined && rawPath === undefined) return undefined;
	if (
		normalizedEntityKey === undefined &&
		Array.isArray(rawPath) &&
		rawPath.length &&
		rawPath[0] &&
		typeof rawPath[0] === 'object'
	) {
		normalizedEntityKey = normalizeDatastoreKey(key, context);
	}
	if (normalizedEntityKey !== undefined) {
		if (keyEncoding === 'native') {
			for (let index = 0; index < normalizedEntityKey.path.length; index++) {
				assertNativeDatastoreEntityId(
					normalizedEntityKey.path[index].id,
					`${context}.path[${index}].id`
				);
			}
		}
		const final = normalizedEntityKey.path[normalizedEntityKey.path.length - 1];
		if (final.kind !== modelKind) {
			throw new ActiveTsValidationError(`${context}.path final kind must match Datastore model kind "${modelKind}".`);
		}
		if (entityIdKey(final.id) !== entityIdKey(expectedId)) {
			throw new ActiveTsValidationError(`${context}.path final id must match the row id.`);
		}
		if (normalizedEntityKey.path.length === 1) return undefined;
		return normalizeDatastoreKey({
			path: normalizedEntityKey.path.slice(0, -1),
			namespace: normalizedEntityKey.namespace
		}, `${context} ancestor`);
	}
	if (!Array.isArray(rawPath) || rawPath.length < 2 || rawPath.length % 2 !== 0) {
		throw new ActiveTsValidationError(`${context}.path must contain kind/id pairs.`);
	}
	const finalKind = datastorePathKind(rawPath[rawPath.length - 2], `${context}.path[${rawPath.length - 2}]`);
	if (finalKind !== modelKind) {
		throw new ActiveTsValidationError(`${context}.path final kind must match Datastore model kind "${modelKind}".`);
	}
	const finalId = datastorePathId(
		rawPath[rawPath.length - 1],
		`${context}.path[${rawPath.length - 1}]`,
		keyEncoding
	);
	if (entityIdKey(finalId) !== entityIdKey(expectedId)) {
		throw new ActiveTsValidationError(`${context}.path final id must match the row id.`);
	}
	const namespace = normalizeDatastoreNamespace(
		datastoreKeyOptionalProperty(key, 'namespace', context),
		`${context}.namespace`
	);
	if (rawPath.length === 2) return undefined;
	const path: DatastoreKey['path'] = [];
	for (let index = 0; index < rawPath.length - 2; index += 2) {
		path[path.length] = {
			kind: datastorePathKind(rawPath[index], `${context}.path[${index}]`),
			id: datastorePathId(rawPath[index + 1], `${context}.path[${index + 1}]`, keyEncoding)
		};
	}
	return normalizeDatastoreKey({ path, namespace }, `${context} ancestor`);
}

export function datastoreEntityKeyNamespace(key: unknown, context: string): string | undefined {
	const namespace = datastoreKeyOptionalProperty(key, 'namespace', context);
	return normalizeDatastoreNamespace(namespace, `${context}.namespace`);
}

export function datastoreKeyIdentity(key: DatastoreKey) {
	const safeKey = normalizeDatastoreKey(key);
	let identity = safeKey.namespace === undefined
		? 'namespace:'
		: `namespace:${safeKey.namespace.length}:${safeKey.namespace}:`;
	for (let index = 0; index < safeKey.path.length; index++) {
		const part = safeKey.path[index];
		const id = entityIdKey(part.id);
		identity += `kind:${part.kind.length}:${part.kind}:id:${id.length}:${id}:`;
	}
	return identity;
}

export function datastoreScopedAncestorMatches(actual: DatastoreKey | undefined, expected: DatastoreKey | undefined) {
	if (!actual || !expected) return actual === expected;
	const safeActual = normalizeDatastoreKey(actual);
	const safeExpected = normalizeDatastoreKey(expected);
	if (safeActual.path.length !== safeExpected.path.length) return false;
	for (let index = 0; index < safeActual.path.length; index++) {
		const actualPart = safeActual.path[index];
		const expectedPart = safeExpected.path[index];
		if (actualPart.kind !== expectedPart.kind) return false;
		if (entityIdKey(actualPart.id) !== entityIdKey(expectedPart.id)) return false;
	}
	if (safeActual.namespace !== undefined && safeExpected.namespace === undefined) return false;
	if (safeActual.namespace === undefined || safeExpected.namespace === undefined) return true;
	return safeActual.namespace === safeExpected.namespace;
}

function normalizeDatastoreKeyPart(value: unknown, context: string): DatastoreKeyPart {
	const record = assertPlainRecord(value, context);
	assertKnownKeys(record, DATASTORE_KEY_PART_KEYS, context);
	return {
		kind: normalizeDatastoreKind(ownValue(record, 'kind'), `${context}.kind`),
		id: normalizeDatastoreEntityId(ownValue(record, 'id'), `${context}.id`)
	};
}

function normalizeDatastoreKind(value: unknown, context: string) {
	return assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(value, context),
		context
	);
}

function normalizeDatastoreEntityId(value: unknown, context: string): EntityId {
	assertSafeEntityId(value, context);
	return value;
}

function datastoreKeyOptionalProperty(key: unknown, property: string, context: string) {
	if (!key || typeof key !== 'object' || Array.isArray(key)) {
		throw new ActiveTsValidationError(`${context} must be an object.`);
	}
	if (!Object.prototype.hasOwnProperty.call(key, property)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(key, property);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
	}
	return descriptor.value;
}

function datastoreKeyOptionalPathProperty(key: unknown, context: string) {
	if (!key || typeof key !== 'object' || Array.isArray(key)) {
		throw new ActiveTsValidationError(`${context} must be an object.`);
	}
	if (!Object.prototype.hasOwnProperty.call(key, 'path')) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(key, 'path');
	if (!descriptor || !('value' in descriptor)) {
		const prototype = Object.getPrototypeOf(key);
		if (prototype !== Object.prototype && prototype !== null && descriptor?.get && descriptor.set === undefined) {
			return descriptor.get.call(key);
		}
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		throw new ActiveTsValidationError(`${context}.path must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.path must be enumerable.`);
	}
	return descriptor.value;
}

function datastorePathKind(value: unknown, context: string) {
	return normalizeDatastoreKind(value, context);
}

function datastorePathId(value: unknown, context: string, keyEncoding: DatastoreKeyEncoding): EntityId {
	if (typeof value === 'number') {
		if (keyEncoding === 'native') return assertNativeDatastoreEntityId(value, context);
		assertSafeEntityId(value, context);
		return value;
	}
	if (typeof value === 'string') {
		if (keyEncoding === 'native') {
			assertSafeEntityId(value, context);
			if (/^-?(0|[1-9]\d*)$/.test(value)) {
				throw new ActiveTsValidationError(
					`${context} cannot decode a numeric-looking native Datastore path segment without id/name metadata.`
				);
			}
			return value;
		}
		if (/^-?(0|[1-9]\d*)$/.test(value)) {
			const parsed = Number(value);
			assertSafeEntityId(parsed, context);
			if (String(parsed) !== value) throw new ActiveTsValidationError(`${context} must be canonical.`);
			return parsed;
		}
		return value.includes(':') ? entityIdFromCanonicalKey(value, context) : entityIdFromKey(value);
	}
	assertSafeEntityId(value, context);
	return value;
}

function normalizeDatastoreNamespace(value: unknown, context: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsValidationError(
			`${context} must be a non-empty string without null bytes, or undefined for the default namespace.`
		);
	}
	return value;
}

function cloneDatastoreKeyParts(parts: readonly DatastoreKeyPart[]) {
	const cloned: DatastoreKeyPart[] = [];
	for (let index = 0; index < parts.length; index++) {
		cloned[index] = { ...parts[index] };
	}
	return cloned;
}

function freezeDatastoreKey(key: DatastoreKey): DatastoreKey {
	for (let index = 0; index < key.path.length; index++) Object.freeze(key.path[index]);
	Object.freeze(key.path);
	return Object.freeze(key);
}

function assertPlainRecord(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	return value as Record<string, unknown>;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedSet = new Set<string>();
	for (const key of allowed) SET_ADD.call(allowedSet, key);
	for (const property of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
		if (!SET_HAS.call(allowedSet, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function ownValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${key} property must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${key} property must be enumerable.`);
	}
	return descriptor.value;
}
