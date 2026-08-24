import { ActiveTsConfigurationError } from './errors.js';

export const BOUND_CONTEXT = Symbol.for('active-ts.bound-context');
export const SOURCE_MODEL = Symbol.for('active-ts.source-model');

export function staticMarkerValue<T = unknown>(model: unknown, marker: symbol): T | undefined {
	let current = model;
	while (typeof current === 'function') {
		if (Object.prototype.hasOwnProperty.call(current, marker)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, marker);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError('Static model marker must be a data property.');
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsConfigurationError('Static model marker must be enumerable.');
			}
			return descriptor.value as T;
		}
		const next = Object.getPrototypeOf(current);
		if (!next || next === Function.prototype) return undefined;
		current = next;
	}
	return undefined;
}
