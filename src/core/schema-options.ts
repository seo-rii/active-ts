import { ActiveTsConfigurationError } from './errors.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF,
	OBJECT_HAS_OWN
} from './object-intrinsics.js';

const STORE_SCHEMA_APPLY_OPTION_KEYS = ['mode'] as const;

export function normalizeStoreSchemaApplyOptions(
	options: unknown,
	context: string
): { mode: 'safe' } {
	if (options === undefined) return { mode: 'safe' };
	assertPlainOptionObject(options, context);
	assertKnownOptionKeys(options, STORE_SCHEMA_APPLY_OPTION_KEYS, context);
	const mode = ownValue(options as Record<string, unknown>, 'mode', context);
	if (mode !== undefined && mode !== 'safe') {
		throw new ActiveTsConfigurationError(`${context}.mode must be "safe".`);
	}
	return { mode: 'safe' };
}

function assertPlainOptionObject(value: unknown, context: string): asserts value is object {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownOptionKeys(value: object, allowed: readonly string[], context: string) {
	const allowedKeys = stringSet(allowed);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function ownValue(record: Record<string, unknown>, key: string, context: string) {
	if (!OBJECT_HAS_OWN(record, key)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}
