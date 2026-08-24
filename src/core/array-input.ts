import { ActiveTsValidationError } from './errors.js';
import { assertDenseArrayItems } from './safe-keys.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS
} from './object-intrinsics.js';

export function snapshotArrayInput<T = unknown>(value: unknown, context: string): T[] {
	if (!Array.isArray(value)) throw new ActiveTsValidationError(`${context} must be an array.`);
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const items: T[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		items.push(descriptor.value as T);
	}
	return items;
}
