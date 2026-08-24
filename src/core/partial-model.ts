import { ActiveTsConfigurationError } from './errors.js';
import { defineDataProperty } from './safe-keys.js';

export const PARTIAL_MODEL = Symbol.for('active-ts.partial-model');

type BlockedPartialOperations = 'save' | 'include' | 'ref' | 'view' | 'can';

export type PartialModel<
	TModel extends { data: Record<string, any> },
	TSelectedData extends Record<string, any> = Partial<TModel['data']>
> = Omit<TModel, 'data' | BlockedPartialOperations> & {
	readonly data: TSelectedData;
} & {
	[TOperation in BlockedPartialOperations]: never;
};

export function markPartialModel<T extends object>(model: T) {
	if (!model || typeof model !== 'object') {
		throw new ActiveTsConfigurationError('partial model marker target must be an object.');
	}
	if (isPartialModel(model)) return model;
	if (!Object.isExtensible(model)) {
		throw new ActiveTsConfigurationError('partial model marker target must be extensible.');
	}
	defineDataProperty(model, PARTIAL_MODEL, true, { enumerable: false, configurable: false });
	return model;
}

export function isPartialModel(model: unknown) {
	if (!model || typeof model !== 'object') return false;
	const descriptor = Object.getOwnPropertyDescriptor(model, PARTIAL_MODEL);
	if (!descriptor) return false;
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('partial model marker must be a data property.');
	}
	return descriptor.value === true;
}
