import { ActiveTsConfigurationError } from './errors.js';
import { assertPlainDataObject, assertSafeFieldPath } from './safe-keys.js';
import type { Model } from './model.js';
import type { MaybePromise, ViewInput, ViewResolver } from './types.js';

const typeBrand: unique symbol = Symbol('active-ts typed view');

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

/**
 * Define once, register with defineModel().view(contract), and read with model.view(contract).
 * Calling by the legacy string name still validates output. This is not authorization,
 * a DTO transport codec, or a way to promote partial models to full models.
 */
export function defineTypedView<Data extends Record<string, any>>() {
	return function<Output>(options: {
		readonly name: string;
		readonly resolve: (input: ViewInput<Model<Data>, Data>) => MaybePromise<unknown>;
		readonly parse: (value: unknown) => MaybePromise<Output>;
	}): TypedView<Data, Output> {
		assertPlainDataObject(options, 'typed view options');
		const { name, resolve, parse } = options;
		const safeName = assertSafeFieldPath(name, 'view name');
		if (typeof resolve !== 'function' || typeof parse !== 'function') {
			throw new ActiveTsConfigurationError('Typed views require a resolver and an output parser.');
		}
		// Both callbacks run inside Model.view()'s tracked transaction operation.
		const resolver: ViewResolver<Data> = async (input) => parse(await resolve(input));
		const contract = Object.freeze({ name: safeName, parse }) as TypedView<Data, Output>;
		contracts.set(contract, Object.freeze({ name: safeName, resolver }));
		return contract;
	};
}
