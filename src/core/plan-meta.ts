import { ActiveTsValidationError } from './errors.js';
import { cloneNativePayload } from './native-payload.js';
import { assertSafeFieldPath, defineDataProperty } from './safe-keys.js';
import type { QueryMeta } from './types.js';

export function clonePlanMeta(meta: unknown, context = 'query meta'): QueryMeta | undefined {
	if (meta === undefined) return undefined;
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(meta);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(meta).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	const record = meta as Record<string, unknown>;
	const normalized: QueryMeta = {};
	for (const key of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
		}
		const safeKey = assertSafeFieldPath(key, `${context} key`);
		defineDataProperty(normalized, safeKey, cloneNativePayload(descriptor.value, `${context}.${safeKey}`), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return normalized;
}
