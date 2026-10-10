import { ActiveTsConfigurationError } from './errors.js';
import { assertSafeFieldPath } from './safe-keys.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS, OBJECT_GET_PROTOTYPE_OF, OBJECT_HAS_OWN
} from './object-intrinsics.js';
import type { Model } from './model.js';
import type { MaybePromise, ViewInput, ViewResolver } from './types.js';

const typeBrand: unique symbol = Symbol('active-ts typed view');
const plainObjectPrototype = Object.prototype;

/** A server-owned view contract. The parser, not a caller assertion, defines Output. */
export interface TypedView<Data, Output> {
	readonly name: string;
	readonly parse: (value: unknown) => MaybePromise<Output>;
	readonly [typeBrand]: (data: Data) => Output;
}

interface ViewDetails {
	readonly name: string;
	readonly resolver: ViewResolver;
}
const contracts = new WeakMap<object, ViewDetails>();

/** Internal: reject forged descriptors and retain the exact registered resolver identity. */
export function typedViewDetails(value: unknown): ViewDetails {
	if (!value || typeof value !== 'object') {
		throw new ActiveTsConfigurationError('Expected a registered typed view contract.');
	}
	const details = contracts.get(value);
	if (!details) throw new ActiveTsConfigurationError('Expected a registered typed view contract.');
	return details;
}

// Configuration intentionally contains callbacks: a stored-data validator must not
// inspect it recursively. Inspect own data descriptors without invoking getters.
function readOptions(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError('Typed view options must be a plain object.');
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== plainObjectPrototype && prototype !== null) {
		throw new ActiveTsConfigurationError('Typed view options must be a plain object.');
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError('Typed view options cannot contain symbols.');
	}
	const required = ['name', 'resolve', 'parse'] as const;
	const keys = OBJECT_GET_OWN_PROPERTY_NAMES(value);
	if (keys.length !== required.length) {
		throw new ActiveTsConfigurationError('Typed views require exactly name, resolve and parse.');
	}
	for (const key of required) {
		if (!OBJECT_HAS_OWN(value, key)) {
			throw new ActiveTsConfigurationError('Typed view options must declare their own required properties.');
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (!descriptor || !descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
			throw new ActiveTsConfigurationError('Typed view options must be enumerable data properties.');
		}
	}
	const name = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, 'name')!.value;
	const resolve = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, 'resolve')!.value;
	const parse = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, 'parse')!.value;
	if (typeof name !== 'string' || typeof resolve !== 'function' || typeof parse !== 'function') {
		throw new ActiveTsConfigurationError('Typed views require a name, resolver and output parser.');
	}
	return { name: assertSafeFieldPath(name, 'view name'), resolve, parse };
}

/**
 * Define once, register with defineModel().view(contract), and read with model.view(contract).
 * Legacy string reads also validate output. This does not authorize data access,
 * implement a transport codec, or promote partial models into full models.
 */
export function defineTypedView<Data extends Record<string, any>>() {
	return function<Output>(options: {
		readonly name: string;
		readonly resolve: (input: ViewInput<Model<Data>, Data>) => MaybePromise<unknown>;
		readonly parse: (value: unknown) => MaybePromise<Output>;
	}): TypedView<Data, Output> {
		const { name, resolve, parse } = readOptions(options);
		// Both captured callbacks run inside Model.view()'s tracked operation.
		const resolver: ViewResolver<Data> = async (input) => parse(await resolve(input));
		const contract = Object.freeze({ name, parse }) as TypedView<Data, Output>;
		contracts.set(contract, Object.freeze({ name, resolver }));
		return contract;
	};
}
