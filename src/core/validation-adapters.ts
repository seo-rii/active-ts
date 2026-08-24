import type { Validator } from './types.js';
import { ActiveTsConfigurationError, ActiveTsValidationError, safeErrorMessage } from './errors.js';

export type ArkTypeAdapterOptions = {
	isProblem?: (result: unknown) => boolean;
};

export function fromTypia<TData>(assertPrune: (input: unknown) => TData): Validator<TData> {
	assertFunction(assertPrune, 'fromTypia assertPrune');
	return (input) => assertPrune(input);
}

export function fromZod<TData>(schema: { parse: (input: unknown) => TData }): Validator<TData> {
	if (!schema || typeof schema !== 'object') {
		throw new ActiveTsConfigurationError('fromZod requires a schema with a parse function.');
	}
	const parse = validationMethod(schema, 'parse', 'fromZod requires a schema with a parse function.');
	return (input) => parse(input);
}

export function fromValibot<TData>(
	schema: unknown,
	adapter?: { parse: (schema: unknown, input: unknown) => TData }
): Validator<TData> {
	if (!adapter || typeof adapter !== 'object') {
		throw new ActiveTsConfigurationError('fromValibot requires a valibot parse adapter.');
	}
	const parse = validationMethod(adapter, 'parse', 'fromValibot requires a valibot parse adapter.');
	return (input) => {
		return parse(schema, input);
	};
}

export function fromArkType<TData>(
	schema: (input: unknown) => TData | { problems: unknown },
	options?: ArkTypeAdapterOptions
): Validator<TData> {
	assertFunction(schema, 'fromArkType schema');
	const problemPredicate = normalizeArkTypeOptions(options).isProblem;
	return (input) => {
		const result = schema(input);
		const problems = arkTypeProblems(result, problemPredicate);
		if (problems.detected) {
			throw new ActiveTsValidationError(safeErrorMessage(problems.value));
		}
		return result as TData;
	};
}

function normalizeArkTypeOptions(options: ArkTypeAdapterOptions | undefined): ArkTypeAdapterOptions {
	if (options === undefined) return Object.freeze({});
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('fromArkType options must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError('fromArkType options must be a plain object.');
	}
	if (Object.getOwnPropertySymbols(options).length) {
		throw new ActiveTsConfigurationError('fromArkType options cannot contain symbol fields.');
	}
	const normalized: ArkTypeAdapterOptions = {};
	for (const property of Object.getOwnPropertyNames(options)) {
		if (property !== 'isProblem') {
			throw new ActiveTsConfigurationError(`fromArkType options contains unknown option "${property}".`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(options, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`fromArkType options.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`fromArkType options.${property} must be enumerable.`);
		}
		if (typeof descriptor.value !== 'function') {
			throw new ActiveTsConfigurationError(`fromArkType options.${property} must be a function.`);
		}
		normalized.isProblem = descriptor.value;
	}
	return Object.freeze(normalized);
}

function arkTypeProblems(
	result: unknown,
	isProblem: ((result: unknown) => boolean) | undefined
): { detected: true; value: unknown } | { detected: false } {
	if (!result || typeof result !== 'object') return { detected: false };
	const explicit = isProblem?.(result) === true;
	const implicit = !isProblem && isLegacyArkTypeProblemOnlyResult(result);
	if (!explicit && !implicit) return { detected: false };
	const descriptor = Object.getOwnPropertyDescriptor(result, 'problems');
	if (!descriptor) return { detected: true, value: result };
	if (!('value' in descriptor)) {
		throw new ActiveTsValidationError('fromArkType result.problems must be a data property.');
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError('fromArkType result.problems must be enumerable.');
	}
	return { detected: true, value: descriptor.value };
}

function isLegacyArkTypeProblemOnlyResult(result: object) {
	if (!Object.prototype.hasOwnProperty.call(result, 'problems')) return false;
	const names = Object.getOwnPropertyNames(result);
	return names.length === 1 && names[0] === 'problems';
}

function assertFunction(value: unknown, context: string): asserts value is (...args: any[]) => any {
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
}

function validationMethod(target: object, method: string, errorMessage: string) {
	let current: object | null = target;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, method)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, method);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${method} must be a data property.`);
			}
			if (current === target && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${method} must be enumerable.`);
			}
			const value = descriptor.value;
			if (typeof value !== 'function') {
				throw new ActiveTsConfigurationError(errorMessage);
			}
			return value.bind(target);
		}
		current = Object.getPrototypeOf(current);
	}
	throw new ActiveTsConfigurationError(errorMessage);
}
