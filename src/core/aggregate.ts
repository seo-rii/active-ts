import { ActiveTsValidationError } from './errors.js';
import { assertDenseArrayItems, assertSafeFieldPath, defineDataProperty } from './safe-keys.js';
import { dateTime } from './date-intrinsics.js';
import { MAP_ENTRIES, MAP_GET, MAP_SET, SET_ADD, SET_HAS } from './collection-intrinsics.js';
import type { AggregateOperator, AggregateResult, AggregateSpec, FieldType, ResolvedModelMeta } from './types.js';

const AGGREGATE_OPERATORS = capturedSet<AggregateOperator>(['count', 'sum', 'avg', 'min', 'max']);
const AGGREGATE_SPEC_KEYS = ['op', 'as', 'field'] as const;
const NUMERIC_RESULT = /^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/;

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function assertSafeAggregateAlias(alias: unknown) {
	const safeAlias = assertSafeFieldPath(alias, 'aggregate alias');
	if (safeAlias.includes('.')) {
		throw new ActiveTsValidationError(`Aggregate alias "${safeAlias}" cannot contain ".".`);
	}
	return safeAlias;
}

export function validateAggregateSpecs(specs: AggregateSpec[]) {
	const rawSpecs = aggregateArrayValues(specs, 'Aggregate specs');
	const aliases = new Set<string>();
	const safeSpecs: AggregateSpec[] = [];
	for (let index = 0; index < rawSpecs.length; index++) {
		const spec = rawSpecs[index];
		if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
			throw new ActiveTsValidationError(`Aggregate spec at index ${index} must be a plain object.`);
		}
		const prototype = Object.getPrototypeOf(spec);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError(`Aggregate spec at index ${index} must be a plain object.`);
		}
		if (Object.getOwnPropertySymbols(spec).length) {
			throw new ActiveTsValidationError(`Aggregate spec at index ${index} cannot contain symbol fields.`);
		}
		for (const property of Object.getOwnPropertyNames(spec)) {
			const descriptor = Object.getOwnPropertyDescriptor(spec, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`Aggregate spec at index ${index}.${property} must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`Aggregate spec at index ${index}.${property} must be enumerable.`);
			}
		}
		assertKnownAggregateSpecKeys(spec, `Aggregate spec at index ${index}`);
		const op = ownAggregateValue(spec, 'op', `Aggregate spec at index ${index}`);
		if (!SET_HAS.call(AGGREGATE_OPERATORS, op as AggregateOperator)) {
			throw new ActiveTsValidationError(invalidValueMessage('Aggregate operator', op));
		}
		const as = assertSafeAggregateAlias(ownAggregateValue(spec, 'as', `Aggregate spec at index ${index}`));
		if (SET_HAS.call(aliases, as)) {
			throw new ActiveTsValidationError(`Duplicate aggregate alias "${as}" is not allowed.`);
		}
		SET_ADD.call(aliases, as);
		const rawField = ownAggregateValue(spec, 'field', `Aggregate spec at index ${index}`);
		if (op !== 'count' && rawField === undefined) {
			throw new ActiveTsValidationError(`Aggregate "${as}" requires a field.`);
		}
		if (op === 'count' && rawField !== undefined) {
			throw new ActiveTsValidationError(`Aggregate "${as}" does not accept a field for count.`);
		}
		if (op === 'count') {
			safeSpecs.push({ op, as });
			continue;
		}
		const field = assertSafeFieldPath(rawField, `${op} aggregate field`);
		safeSpecs.push({ op: op as Exclude<AggregateOperator, 'count'>, as, field });
	}
	return safeSpecs;
}

export function assertAggregateSpecsCompatibleWithModel(
	model: Pick<ResolvedModelMeta, 'fieldTypes'>,
	specs: AggregateSpec[],
	context = 'Aggregate'
) {
	const safeSpecs = validateAggregateSpecs(specs);
	for (const spec of safeSpecs) {
		if (!spec.field) continue;
		const type = MAP_GET.call(model.fieldTypes, spec.field) as FieldType | undefined;
		if ((spec.op === 'sum' || spec.op === 'avg') && type !== undefined && type !== 'number') {
			throw new ActiveTsValidationError(`${context} "${spec.as}" requires a number field.`);
		}
		if ((spec.op === 'min' || spec.op === 'max') && type === 'boolean') {
			throw new ActiveTsValidationError(`${context} "${spec.as}" does not support boolean min/max fields.`);
		}
	}
	return safeSpecs;
}

function invalidValueMessage(label: string, value: unknown) {
	return typeof value === 'string' ? `${label} "${value}" is not allowed.` : `${label} is not allowed.`;
}


function assertKnownAggregateSpecKeys(record: object, context: string) {
	const allowed = capturedSet<string>(AGGREGATE_SPEC_KEYS);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function ownAggregateValue(record: object, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}

export function defaultAggregateValue(spec: AggregateSpec) {
	return defaultAggregateValueFromSpec(validateAggregateSpecs([spec])[0]);
}

function defaultAggregateValueFromSpec(spec: AggregateSpec) {
	if (spec.op === 'count' || spec.op === 'sum') return 0;
	return null;
}

export function defaultAggregateResult(specs: AggregateSpec[]): AggregateResult {
	const safeSpecs = validateAggregateSpecs(specs);
	return defaultAggregateResultFromSpecs(safeSpecs);
}

export function normalizeAggregateResult(
	row: Record<string, any> | null | undefined,
	specs: AggregateSpec[],
	context = 'Aggregate'
) {
	const safeSpecs = validateAggregateSpecs(specs);
	if (row !== undefined && row !== null) {
		assertPlainAggregateResultRow(row, context);
		assertKnownAggregateResultKeys(row, safeSpecs, context);
	}
	const result = defaultAggregateResultFromSpecs(safeSpecs);
	for (const spec of safeSpecs) {
		const value = row ? ownAggregateResultValue(row, spec.as, context) : undefined;
		if (value === undefined || value === null) continue;
		if (spec.op === 'count' || spec.op === 'sum' || spec.op === 'avg') {
			result[spec.as] = numericAggregateResult(value, spec, context);
		} else if (spec.op === 'min' || spec.op === 'max') {
			result[spec.as] = comparableValue(value, spec);
		} else {
			result[spec.as] = value;
		}
	}
	return result;
}

function assertPlainAggregateResultRow(row: unknown, context: string): asserts row is Record<string, any> {
	if (!row || typeof row !== 'object' || Array.isArray(row)) {
		throw new ActiveTsValidationError(`${context} result must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(row);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} result must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(row).length) {
		throw new ActiveTsValidationError(`${context} result cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(row)) {
		const descriptor = Object.getOwnPropertyDescriptor(row, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context} result.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context} result.${property} must be enumerable.`);
		}
	}
}

function assertKnownAggregateResultKeys(record: Record<string, unknown>, specs: AggregateSpec[], context: string) {
	const allowed = new Set<string>();
	for (let index = 0; index < specs.length; index++) {
		SET_ADD.call(allowed, specs[index].as);
	}
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsValidationError(`${context} result contains unknown option "${property}".`);
		}
	}
}

function defaultAggregateResultFromSpecs(specs: AggregateSpec[]): AggregateResult {
	const result: AggregateResult = {};
	for (const spec of specs) {
		defineDataProperty(result, spec.as, defaultAggregateValueFromSpec(spec), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return result;
}

export function normalizeAggregateRow(row: unknown, specs: AggregateSpec[], context = 'Aggregate') {
	if (row === undefined) return normalizeAggregateResult(undefined, specs, context);
	assertPlainAggregateResultRow(row, context);
	const record = row as Record<string, unknown>;
	const safeSpecs = validateAggregateSpecs(specs);
	assertKnownAggregateResultKeys(record, safeSpecs, context);
	const ownResult: Record<string, unknown> = {};
	for (const spec of safeSpecs) {
		defineDataProperty(ownResult, spec.as, ownAggregateResultValue(record, spec.as, context), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return normalizeAggregateResult(ownResult, safeSpecs, context);
}

function ownAggregateResultValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} result.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} result.${key} must be enumerable.`);
	}
	return descriptor.value;
}

export function aggregateRows(rows: any[], specs: AggregateSpec[]) {
	const safeRows = aggregateArrayValues(rows, 'Aggregate rows');
	const safeSpecs = validateAggregateSpecs(specs);
	const result = defaultAggregateResult(safeSpecs);
	const avgState = new Map<string, { sum: number; count: number }>();

	for (const spec of safeSpecs) {
		if (spec.op === 'count') {
			result[spec.as] = safeRows.length;
			continue;
		}
		for (let index = 0; index < safeRows.length; index++) {
			const row = safeRows[index];
			const value = valueFor(row, spec.field!);
			if (value === undefined || value === null) continue;
			if (spec.op === 'sum') {
				result[spec.as] = Number(result[spec.as] ?? 0) + numberValue(value, spec);
			} else if (spec.op === 'avg') {
				const state = (MAP_GET.call(avgState, spec.as) as { sum: number; count: number } | undefined) ?? {
					sum: 0,
					count: 0
				};
				state.sum += numberValue(value, spec);
				state.count++;
				MAP_SET.call(avgState, spec.as, state);
			} else if (spec.op === 'min') {
				const comparable = comparableValue(value, spec);
				if (
					result[spec.as] === null ||
					compareComparableValues(comparable, comparableValue(result[spec.as], spec), spec) < 0
				) {
					result[spec.as] = comparable;
				}
			} else if (spec.op === 'max') {
				const comparable = comparableValue(value, spec);
				if (
					result[spec.as] === null ||
					compareComparableValues(comparable, comparableValue(result[spec.as], spec), spec) > 0
				) {
					result[spec.as] = comparable;
				}
			}
		}
	}

	for (const [as, state] of MAP_ENTRIES.call(avgState)) {
		result[as] = state.count ? state.sum / state.count : null;
	}
	return result;
}

function aggregateArrayValues(value: unknown, context: string) {
	if (!Array.isArray(value)) throw new ActiveTsValidationError(`${context} must be an array.`);
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const values: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		values.push(descriptor.value);
	}
	return values;
}

function valueFor(data: any, field: string) {
	assertSafeFieldPath(field, 'aggregate field');
	let current = data;
	const path: string[] = [];
	for (const key of field.split('.')) {
		path.push(key);
		if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
			return undefined;
		}
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`Aggregate field "${field}" segment "${path.join('.')}" must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`Aggregate field "${field}" segment "${path.join('.')}" must be enumerable.`);
		}
		current = descriptor.value;
	}
	return current;
}

function numberValue(value: unknown, spec: AggregateSpec) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new ActiveTsValidationError(
			`Aggregate "${spec.as}" expected numeric values in field "${spec.field}".`
		);
	}
	return value;
}

type ComparableAggregateValue = string | number | Date;

function comparableValue(value: unknown, spec: AggregateSpec): ComparableAggregateValue {
	if (typeof value === 'number') {
		if (Number.isFinite(value)) return value;
	} else if (typeof value === 'string') {
		return value;
	} else if (value instanceof Date) {
		if (!Number.isFinite(dateTime(value))) {
			throw new ActiveTsValidationError(
				`Aggregate "${spec.as}" expected scalar comparable values in field "${spec.field}".`
			);
		}
		assertPlainAggregateDate(value, spec);
		return value;
	}
	throw new ActiveTsValidationError(
		`Aggregate "${spec.as}" expected scalar comparable values in field "${spec.field}".`
	);
}

function assertPlainAggregateDate(value: Date, spec: AggregateSpec) {
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`Aggregate "${spec.as}" Date value cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		throw new ActiveTsValidationError(`Aggregate "${spec.as}" Date value cannot contain custom property "${property}".`);
	}
}

function comparableKind(value: ComparableAggregateValue) {
	return value instanceof Date ? 'date' : typeof value;
}

function compareComparableValues(
	left: ComparableAggregateValue,
	right: ComparableAggregateValue,
	spec: AggregateSpec
) {
	const leftKind = comparableKind(left);
	const rightKind = comparableKind(right);
	if (leftKind !== rightKind) {
		throw new ActiveTsValidationError(
			`Aggregate "${spec.as}" expected comparable values of one scalar type in field "${spec.field}".`
		);
	}
	if (left instanceof Date && right instanceof Date) return dateTime(left) - dateTime(right);
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function numericAggregateResult(value: unknown, spec: AggregateSpec, context: string) {
	let numeric: number;
	if (typeof value === 'number') {
		numeric = value;
	} else if (typeof value === 'string' && NUMERIC_RESULT.test(value)) {
		numeric = Number(value);
	} else {
		throw new ActiveTsValidationError(`${context} "${spec.as}" expected a numeric result.`);
	}
	if (!Number.isFinite(numeric)) {
		throw new ActiveTsValidationError(`${context} "${spec.as}" expected a finite numeric result.`);
	}
	if (spec.op === 'count' && (!Number.isSafeInteger(numeric) || numeric < 0)) {
		throw new ActiveTsValidationError(`${context} "${spec.as}" expected a non-negative safe integer count.`);
	}
	return numeric;
}
