import type { Operator, SearchCapabilities, StoreCapabilities } from './types.js';

export function storeCapability(
	capabilities: StoreCapabilities | undefined,
	key: keyof StoreCapabilities
) {
	return ownBooleanCapability(capabilities, key);
}

export function searchCapability(
	capabilities: SearchCapabilities | undefined,
	key: Exclude<keyof SearchCapabilities, 'whereOperators'>
) {
	return ownBooleanCapability(capabilities, key);
}

export function searchWhereOperatorCapability(
	capabilities: SearchCapabilities | undefined,
	operator: Operator
) {
	return ownBooleanCapability(capabilities?.whereOperators, operator);
}

function ownBooleanCapability(record: object | undefined, key: string) {
	if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return false;
	return (record as Record<string, unknown>)[key] === true;
}
