import { ActiveTsValidationError } from './errors.js';
import { assertDenseArrayItems, defineDataProperty } from './safe-keys.js';
import { cloneDate } from './date-intrinsics.js';
import {
	SET_ADD,
	SET_HAS,
	WEAKMAP_GET,
	WEAKMAP_HAS,
	WEAKMAP_SET,
	WEAKSET_ADD,
	WEAKSET_DELETE,
	WEAKSET_HAS
} from './collection-intrinsics.js';

export function cloneNativePayload(payload: unknown, path = 'native payload', seen = new WeakMap<object, unknown>()): unknown {
	if (payload === null || typeof payload !== 'object') return payload;
	const builtInClone = cloneMutableBuiltIn(payload, path);
	if (builtInClone.cloned) return builtInClone.value;
	if (!Array.isArray(payload)) {
		const prototype = Object.getPrototypeOf(payload);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError(
				`${path} must be a plain object, array, function, or supported built-in value.`
			);
		}
	}
	if (WEAKMAP_HAS.call(seen, payload)) return WEAKMAP_GET.call(seen, payload);
	if (Array.isArray(payload)) {
		if (Object.getOwnPropertySymbols(payload).length) {
			throw new ActiveTsValidationError(`${path} cannot contain symbol fields.`);
		}
		assertDenseArrayItems(payload, path);
		for (const property of Object.getOwnPropertyNames(payload)) {
			if (property === 'length') continue;
			if (!isArrayIndexProperty(property, payload.length)) {
				throw new ActiveTsValidationError(`${path} cannot contain non-index array property "${property}".`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(payload, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${path}[${property}] must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`${path}[${property}] must be enumerable.`);
			}
		}
		const clone: unknown[] = [];
		WEAKMAP_SET.call(seen, payload, clone);
		for (let index = 0; index < payload.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(payload, String(index));
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${path}[${index}] must be a data property.`);
			}
			clone[index] = cloneNativePayload(descriptor.value, `${path}[${index}]`, seen);
		}
		return clone;
	}
	if (Object.getOwnPropertySymbols(payload).length) {
		throw new ActiveTsValidationError(`${path} cannot contain symbol fields.`);
	}
	const clone: Record<string, unknown> = {};
	WEAKMAP_SET.call(seen, payload, clone);
	for (const key of Object.getOwnPropertyNames(payload)) {
		const descriptor = Object.getOwnPropertyDescriptor(payload, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${path}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${path}.${key} must be enumerable.`);
		}
		defineDataProperty(clone, key, cloneNativePayload(descriptor.value, `${path}.${key}`, seen), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return clone;
}

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function cloneJsonTransportPayload(payload: unknown, path = 'JSON transport payload', seen = new WeakSet<object>()): unknown {
	if (payload === undefined) {
		throw new ActiveTsValidationError(`${path} cannot contain undefined. Use null or omit the field.`);
	}
	if (payload === null || typeof payload !== 'object') return payload;
	if (WEAKSET_HAS.call(seen, payload)) {
		throw new ActiveTsValidationError(`${path} must not contain circular references.`);
	}
	if (Array.isArray(payload)) {
		if (Object.getOwnPropertySymbols(payload).length) {
			throw new ActiveTsValidationError(`${path} cannot contain symbol fields.`);
		}
		assertDenseArrayItems(payload, path);
		for (const property of Object.getOwnPropertyNames(payload)) {
			if (property === 'length') continue;
			if (!isArrayIndexProperty(property, payload.length)) {
				throw new ActiveTsValidationError(`${path} cannot contain non-index array property "${property}".`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(payload, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${path}[${property}] must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`${path}[${property}] must be enumerable.`);
			}
		}
		WEAKSET_ADD.call(seen, payload);
		try {
			const clone: unknown[] = [];
			for (let index = 0; index < payload.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(payload, String(index));
				if (!descriptor || !('value' in descriptor)) {
					throw new ActiveTsValidationError(`${path}[${index}] must be a data property.`);
				}
				defineDataProperty(clone, String(index), cloneJsonTransportPayload(descriptor.value, `${path}[${index}]`, seen), {
					enumerable: true,
					configurable: true,
					writable: true
				});
			}
			Object.setPrototypeOf(clone, null);
			return clone;
		} finally {
			WEAKSET_DELETE.call(seen, payload);
		}
	}
	const prototype = Object.getPrototypeOf(payload);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${path} must be plain JSON data.`);
	}
	if (Object.getOwnPropertySymbols(payload).length) {
		throw new ActiveTsValidationError(`${path} cannot contain symbol fields.`);
	}
	WEAKSET_ADD.call(seen, payload);
	try {
		const clone = Object.create(null) as Record<string, unknown>;
		for (const key of Object.getOwnPropertyNames(payload)) {
			const descriptor = Object.getOwnPropertyDescriptor(payload, key);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${path}.${key} must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`${path}.${key} must be enumerable.`);
			}
			defineDataProperty(clone, key, cloneJsonTransportPayload(descriptor.value, `${path}.${key}`, seen), {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
		return clone;
	} finally {
		WEAKSET_DELETE.call(seen, payload);
	}
}

function cloneMutableBuiltIn(payload: object, path: string): { cloned: true; value: unknown } | { cloned: false } {
	if (payload instanceof Date) {
		assertNoCustomBuiltInProperties(payload, path);
		return { cloned: true, value: cloneDate(payload) };
	}
	if (payload instanceof RegExp) {
		if (Object.getPrototypeOf(payload) !== RegExp.prototype) {
			throw new ActiveTsValidationError(`${path} must be a built-in RegExp value.`);
		}
		assertNoCustomBuiltInProperties(payload, path, stringSet(['lastIndex']));
		const clone = new RegExp(payload.source, payload.flags);
		clone.lastIndex = payload.lastIndex;
		return { cloned: true, value: clone };
	}
	if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
		assertNoCustomBuiltInProperties(payload, path, undefined, typedArrayIndexLength(payload));
		return { cloned: true, value: structuredClone(payload) };
	}
	return { cloned: false };
}

function assertNoCustomBuiltInProperties(
	payload: object,
	path: string,
	allowedProperties = new Set<string>(),
	allowedIndexLength?: number
) {
	if (Object.getOwnPropertySymbols(payload).length) {
		throw new ActiveTsValidationError(`${path} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(payload)) {
		if (SET_HAS.call(allowedProperties, property)) continue;
		if (allowedIndexLength !== undefined && isArrayIndexProperty(property, allowedIndexLength)) continue;
		throw new ActiveTsValidationError(`${path} cannot contain custom built-in property "${property}".`);
	}
}

function typedArrayIndexLength(payload: object) {
	if (!ArrayBuffer.isView(payload) || payload instanceof DataView) return undefined;
	const length = (payload as { length?: unknown }).length;
	return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}
