import type { ActiveTsHook, ActiveTsHookName, ActiveTsHookPayload, ActiveTsHooks } from './types.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { snapshotArrayInput } from './array-input.js';
import { defineDataProperty } from './safe-keys.js';
import {
	MAP_SET,
	SET_ADD,
	SET_HAS,
	SET_VALUES,
	WEAKSET_ADD,
	WEAKSET_DELETE,
	WEAKSET_HAS
} from './collection-intrinsics.js';
import {
	OBJECT_ENTRIES,
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF
} from './object-intrinsics.js';

const HOOK_NAMES = capturedSet<ActiveTsHookName>([
	'beforeValidate',
	'afterValidate',
	'beforeRead',
	'afterRead',
	'afterInstantiate',
	'beforeCreate',
	'afterCreate',
	'beforeUpdate',
	'afterUpdate',
	'beforeDelete',
	'afterDelete',
	'afterStoreWrite',
	'beforeQuery',
	'afterQuery',
	'beforeAggregate',
	'afterAggregate',
	'beforeSearch',
	'afterSearch',
	'beforeIndex',
	'afterIndex',
	'beforeCacheGet',
	'afterCacheGet',
	'beforeCacheSet',
	'afterCacheSet',
	'beforeCacheInvalidate',
	'afterCacheInvalidate',
	'beforeRelationLoad',
	'afterRelationLoad'
]);
const HOOK_PAYLOAD_KEYS = capturedSet<keyof ActiveTsHookPayload>([
	'context',
	'model',
	'target',
	'id',
	'ids',
	'data',
	'patch',
	'plan',
	'query',
	'options',
	'result',
	'error',
	'operation',
	'meta'
]);
const IMMUTABLE_HOOK_PAYLOAD_KEYS = capturedSet<keyof ActiveTsHookPayload>([
	'context',
	'model',
	'target',
	'id',
	'ids',
	'operation',
	'meta'
]);

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function toHookList(hook: ActiveTsHooks[ActiveTsHookName] | undefined, context = 'hook') {
	if (hook === undefined) return [];
	const list = Array.isArray(hook) ? snapshotArrayInput<ActiveTsHook>(hook, context) : [hook];
	for (let index = 0; index < list.length; index++) {
		const item = list[index];
		if (typeof item !== 'function') {
			throw new ActiveTsConfigurationError(`${context}${list.length > 1 ? `[${index}]` : ''} must be a function.`);
		}
	}
	return list;
}

export function sanitizeHooks(hooks: ActiveTsHooks, context = 'hooks') {
	if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(hooks);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(hooks).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol hook names.`);
	}
	const normalized = Object.create(null) as ActiveTsHooks;
	for (const name of OBJECT_GET_OWN_PROPERTY_NAMES(hooks) as ActiveTsHookName[]) {
		if (!SET_HAS.call(HOOK_NAMES, name)) throw new ActiveTsConfigurationError(`${context} contains unknown hook "${name}".`);
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(hooks, name);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${name} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${name} must be enumerable.`);
		}
		const hook = descriptor.value as ActiveTsHooks[ActiveTsHookName];
		const list = toHookList(hook, `${context}.${name}`);
		defineDataProperty(
			normalized,
			name,
			Array.isArray(hook) ? Object.freeze([...list]) as ActiveTsHook[] : list[0],
			{ enumerable: true, configurable: true, writable: true }
		);
	}
	return Object.freeze(normalized);
}

export function mergeHooks(...sources: Array<ActiveTsHooks | undefined>) {
	const merged = Object.create(null) as ActiveTsHooks;
	for (const source of sources) {
		if (!source) continue;
		for (const [name, hook] of OBJECT_ENTRIES(sanitizeHooks(source)) as Array<[ActiveTsHookName, ActiveTsHook | ActiveTsHook[]]>) {
			const existing = toHookList(merged[name]);
			defineDataProperty(merged, name, [...existing, ...toHookList(hook)], {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
	}
	return sanitizeHooks(merged);
}

export async function runHookList(
	hooks: ActiveTsHook[],
	payload: ActiveTsHookPayload,
	options?: { independent?: boolean }
) {
	if (options?.independent) {
		const tasks: Array<Promise<ActiveTsHookPayload>> = [];
		for (let index = 0; index < hooks.length; index++) {
			const independent = Object.create(null) as ActiveTsHookPayload;
			for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(payload) as Array<keyof ActiveTsHookPayload>) {
				const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(payload, key);
				if (!descriptor || !('value' in descriptor)) continue;
				defineDataProperty(independent, key, descriptor.value, {
					enumerable: true,
					configurable: true,
					writable: true
				});
			}
			tasks[index] = runHookList([hooks[index]], independent);
		}
		const results = await Promise.allSettled(tasks);
		const errors: unknown[] = [];
		for (let index = 0; index < results.length; index++) {
			const result = results[index];
			if (result.status === 'rejected') errors[errors.length] = result.reason;
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, 'Multiple independent lifecycle hooks failed.');
		return payload;
	}
	const immutableValues = snapshotImmutablePayload(payload);
	validateHookPayloadContainer(payload, immutableValues);
	for (const hook of hooks) {
		const next = await hook(payload);
		validateHookPayloadContainer(payload, immutableValues);
		if (next === undefined || next === null) continue;
		mergeHookResult(payload, next);
		validateHookPayloadContainer(payload, immutableValues);
	}
	return payload;
}

function snapshotImmutablePayload(payload: ActiveTsHookPayload) {
	const immutableValues = new Map<keyof ActiveTsHookPayload, unknown>();
	for (const key of SET_VALUES.call(IMMUTABLE_HOOK_PAYLOAD_KEYS)) {
		MAP_SET.call(immutableValues, key, hookPayloadValue(payload, key, `Hook payload key "${key}"`));
	}
	return immutableValues;
}

function validateHookPayloadContainer(
	payload: ActiveTsHookPayload,
	immutableValues: Map<keyof ActiveTsHookPayload, unknown>
) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new ActiveTsValidationError('Hook payload must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(payload);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('Hook payload must be a plain object.');
	}
	if (Object.getOwnPropertySymbols(payload).length) {
		throw new ActiveTsValidationError('Hook payload cannot contain symbol keys.');
	}
	for (const rawKey of Object.getOwnPropertyNames(payload)) {
		if (rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') {
			throw new ActiveTsValidationError(`Hook payload key "${rawKey}" is not allowed.`);
		}
		if (!SET_HAS.call(HOOK_PAYLOAD_KEYS, rawKey as keyof ActiveTsHookPayload)) {
			throw new ActiveTsValidationError(`Hook payload key "${rawKey}" is not recognized.`);
		}
		hookPayloadValue(payload, rawKey as keyof ActiveTsHookPayload, `Hook payload key "${rawKey}"`);
	}
	for (const [key, expected] of immutableValues) {
		const current = hookPayloadValue(payload, key, `Hook payload key "${key}"`);
		if (current !== expected) {
			throw new ActiveTsValidationError(`Hook payload key "${key}" cannot replace immutable payload metadata.`);
		}
	}
}

function hookPayloadValue(payload: ActiveTsHookPayload, key: keyof ActiveTsHookPayload, context: string) {
	if (!Object.prototype.hasOwnProperty.call(payload, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(payload, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} must be enumerable.`);
	}
	return descriptor.value;
}

function mergeHookResult(payload: ActiveTsHookPayload, next: Partial<ActiveTsHookPayload>) {
	if (!next || typeof next !== 'object' || Array.isArray(next)) {
		throw new ActiveTsValidationError('Hook result must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(next);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('Hook result must be a plain object.');
	}
	if (Object.getOwnPropertySymbols(next).length) {
		throw new ActiveTsValidationError('Hook result cannot contain symbol keys.');
	}
	for (const rawKey of Object.getOwnPropertyNames(next)) {
		if (rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') {
			throw new ActiveTsValidationError(`Hook result key "${rawKey}" is not allowed.`);
		}
		if (!SET_HAS.call(HOOK_PAYLOAD_KEYS, rawKey as keyof ActiveTsHookPayload)) {
			throw new ActiveTsValidationError(`Hook result key "${rawKey}" is not recognized.`);
		}
		const key = rawKey as keyof ActiveTsHookPayload;
		const descriptor = Object.getOwnPropertyDescriptor(next, rawKey);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`Hook result key "${rawKey}" must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`Hook result key "${rawKey}" must be enumerable.`);
		}
		const value = descriptor.value as never;
		if (SET_HAS.call(IMMUTABLE_HOOK_PAYLOAD_KEYS, key) && value !== payload[key]) {
			throw new ActiveTsValidationError(`Hook result key "${rawKey}" cannot replace immutable payload metadata.`);
		}
		validateHookResultValue(key, value);
		defineDataProperty(payload, key, value, { enumerable: true, configurable: true, writable: true });
	}
}

function validateHookResultValue(key: keyof ActiveTsHookPayload, value: unknown) {
	const context = `Hook result key "${String(key)}"`;
	if ((key === 'plan' || key === 'options') && value !== undefined) {
		validatePlainHookContainer(value, context);
	}
	validateNestedHookValue(value, context);
}

function validatePlainHookContainer(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
}

function validateNestedHookValue(value: unknown, context: string, seen = new WeakSet<object>()) {
	if (value === null || typeof value !== 'object') return;
	if (WEAKSET_HAS.call(seen, value)) {
		throw new ActiveTsValidationError(`${context} cannot contain circular references.`);
	}
	if (Array.isArray(value)) {
		WEAKSET_ADD.call(seen, value);
		try {
			validateNestedHookArray(value, context, seen);
		} finally {
			WEAKSET_DELETE.call(seen, value);
		}
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return;
	WEAKSET_ADD.call(seen, value);
	try {
		validateNestedHookObject(value as Record<string, unknown>, context, seen);
	} finally {
		WEAKSET_DELETE.call(seen, value);
	}
}

function validateNestedHookObject(value: Record<string, unknown>, context: string, seen: WeakSet<object>) {
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol keys.`);
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		const path = `${context}.${property}`;
		if (property === '__proto__' || property === 'constructor' || property === 'prototype') {
			throw new ActiveTsValidationError(`${path} is not allowed.`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${path} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${path} must be enumerable.`);
		}
		validateNestedHookValue(descriptor.value, path, seen);
	}
}

function validateNestedHookArray(value: unknown[], context: string, seen: WeakSet<object>) {
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, value.length)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, property);
			if (isArrayMethodShadowProperty(property) && descriptor && 'value' in descriptor) continue;
			throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
		}
	}
	for (let index = 0; index < value.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) {
			throw new ActiveTsValidationError(`${context}[${index}] is missing. Sparse arrays are not allowed.`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}[${index}] must be enumerable.`);
		}
		validateNestedHookValue(descriptor.value, `${context}[${index}]`, seen);
	}
}

function isArrayIndexProperty(property: string, length: number) {
	if (!property) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === property;
}

function isArrayMethodShadowProperty(property: string) {
	if (property === 'constructor') return false;
	const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, property);
	return !!descriptor && 'value' in descriptor && typeof descriptor.value === 'function';
}
