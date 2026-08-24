import { ActiveTsValidationError } from './errors.js';
import { validateAggregateSpecs, normalizeAggregateResult } from './aggregate.js';
import { assertSafeFieldPath, cloneSafeData } from './safe-keys.js';
import { copyFieldCodecQueryOperandMarker } from './field-codecs.js';
import {
	assertValidWhereOperand,
	assertWhereArrayArity,
	isOperator,
	setPath,
	valueFor,
	whereShapeEntries,
	whereShapeToPlan
} from './query-utils.js';
import { snapshotArrayInput } from './array-input.js';
import { dateIsoString, dateTime } from './date-intrinsics.js';
import { MAP_ENTRIES, MAP_GET, SET_ADD, SET_HAS } from './collection-intrinsics.js';
import type { AggregatePlan, AggregateResult, AggregateSpec, FieldType, QueryPlan, ResolvedModelMeta, WhereShape } from './types.js';

type FieldTypeOperation = 'read' | 'write';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WHERE_ENTRY_KEYS = ['field', 'op', 'value', 'value2'] as const;

export function applyFieldTypeTransforms(
	meta: ResolvedModelMeta,
	data: any,
	operation: FieldTypeOperation
) {
	const next = cloneSafeData(data);
	for (const [field, type] of MAP_ENTRIES.call(meta.fieldTypes) as Iterable<[string, FieldType]>) {
		if (type !== 'date') continue;
		const current = valueFor(next, field);
		if (current === undefined || current === null) continue;
		setPath(
			next,
			field,
			operation === 'write'
				? normalizeDateStorageValue(current, `${meta.name}.${field}`)
				: normalizeDateRuntimeValue(current, `${meta.name}.${field}`)
		);
	}
	return next;
}

export function normalizeWhereFieldTypes(meta: ResolvedModelMeta, entries: QueryPlan['where']) {
	const safeEntries = snapshotArrayInput<QueryPlan['where'][number]>(entries, 'where entries');
	const normalizedEntries: QueryPlan['where'] = [];
	for (let index = 0; index < safeEntries.length; index++) {
		const where = safeEntries[index];
		const entry = normalizeWhereEntry(where, `where entries[${index}]`);
		const type = fieldTypeFor(meta, entry.field);
		if (type !== 'date') {
			assertWhereCompatibleWithFieldType(type, entry, `${meta.name}.${entry.field}`);
			normalizedEntries[index] = entry;
			continue;
		}
		const value = normalizeDateQueryValue(entry.value, `${meta.name}.${entry.field}`);
		const hasValue2 = Object.prototype.hasOwnProperty.call(entry, 'value2');
		const value2 = hasValue2
			? normalizeDateQueryValue(entry.value2, `${meta.name}.${entry.field}`)
			: undefined;
		assertValidWhereOperand(entry.op, value, value2, entry.field);
		const normalized = {
			...entry,
			value,
			...(hasValue2 ? { value2 } : {})
		};
		assertWhereCompatibleWithFieldType(type, normalized, `${meta.name}.${entry.field}`);
		normalizedEntries[index] = normalized;
	}
	return normalizedEntries;
}

export function normalizeWhereShapeFieldTypes(meta: ResolvedModelMeta, where: WhereShape | undefined) {
	if (where === undefined) return where;
	const normalizedWhere: WhereShape = {};
	for (const [field, value] of whereShapeEntries(where, 'where')) {
		const type = fieldTypeFor(meta, field);
		const normalized = type === 'date'
			? normalizeWhereShapeDateValue(value, `${meta.name}.${field}`)
			: value;
		for (const entry of whereShapeToPlan({ [field]: normalized } as WhereShape, 'where').where) {
			assertWhereCompatibleWithFieldType(type, entry, `${meta.name}.${field}`);
		}
		normalizedWhere[field] = normalized as WhereShape[string];
	}
	return normalizedWhere;
}

export function normalizeQueryPlanFieldTypes(meta: ResolvedModelMeta, plan: QueryPlan): QueryPlan {
	const or: QueryPlan['or'] = [];
	for (let index = 0; index < plan.or.length; index++) {
		or[index] = normalizeQueryPlanFieldTypes(meta, plan.or[index]);
	}
	return copyFieldCodecQueryOperandMarker(plan, {
		...plan,
		where: normalizeWhereFieldTypes(meta, plan.where),
		or
	});
}

export function normalizeAggregatePlanFieldTypes(meta: ResolvedModelMeta, plan: AggregatePlan): AggregatePlan {
	const or: AggregatePlan['or'] = [];
	for (let index = 0; index < plan.or.length; index++) {
		or[index] = normalizeQueryPlanFieldTypes(meta, plan.or[index]);
	}
	return copyFieldCodecQueryOperandMarker(plan, {
		...plan,
		where: normalizeWhereFieldTypes(meta, plan.where),
		or
	});
}

export function normalizeAggregateFieldTypes(
	meta: ResolvedModelMeta,
	specs: AggregateSpec[],
	result: AggregateResult
) {
	const safeSpecs = validateAggregateSpecs(specs);
	const next = normalizeAggregateResult(result, safeSpecs, 'Aggregate field types');
	for (const spec of safeSpecs) {
		if ((spec.op !== 'min' && spec.op !== 'max') || !spec.field) continue;
		const type = fieldTypeFor(meta, spec.field);
		if (type === undefined) continue;
		const value = next[spec.as];
		if (value === undefined || value === null) continue;
		next[spec.as] = normalizeMinMaxResultValue(value, type, `${meta.name}.${spec.field}`, spec);
	}
	return next;
}

function fieldTypeFor(meta: Pick<ResolvedModelMeta, 'fieldTypes'>, field: string) {
	return MAP_GET.call(meta.fieldTypes, field) as FieldType | undefined;
}

function normalizeMinMaxResultValue(value: AggregateResult[string], type: FieldType, context: string, spec: AggregateSpec) {
	if (type === 'date') return normalizeDateRuntimeValue(value, context);
	if (typeof value !== type) {
		throw new ActiveTsValidationError(
			`Aggregate "${spec.as}" result for field "${spec.field}" must match ${type} field type.`
		);
	}
	if (type === 'number' && !Number.isFinite(value)) {
		throw new ActiveTsValidationError(
			`Aggregate "${spec.as}" result for field "${spec.field}" must match number field type.`
		);
	}
	return value;
}

function normalizeWhereEntry(where: QueryPlan['where'][number], context: string): QueryPlan['where'][number] {
	assertPlainFieldTypeObject(where, context);
	assertKnownFieldTypeKeys(where, WHERE_ENTRY_KEYS, context);
	const field = assertSafeFieldPath(ownFieldTypeValue(where, 'field', context), 'query field');
	const op = ownFieldTypeValue(where, 'op', context);
	if (typeof op !== 'string' || !isOperator(op)) {
		throw new ActiveTsValidationError(invalidValueMessage('Query operator', op));
	}
	const value = ownFieldTypeValue(where, 'value', context);
	const hasValue2 = Object.prototype.hasOwnProperty.call(where, 'value2');
	const value2 = ownFieldTypeValue(where, 'value2', context);
	assertValidWhereOperand(op, value, value2, field);
	if (op !== 'between' && hasValue2) {
		throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" does not accept value2.`);
	}
	return hasValue2 ? { field, op, value, value2 } : { field, op, value };
}

function assertWhereCompatibleWithFieldType(
	type: FieldType | undefined,
	entry: QueryPlan['where'][number],
	context: string
) {
	if (type === undefined || entry.op === 'isNull' || entry.op === 'isNotNull' || entry.op === 'jsonContains') return;
	if (entry.op === 'in') {
		if (!Array.isArray(entry.value)) return;
		for (let index = 0; index < entry.value.length; index++) {
			assertOperandCompatibleWithFieldType(type, entry.value[index], `${context} in operand`);
		}
		return;
	}
	if (entry.op === 'between') {
		assertOperandCompatibleWithFieldType(type, entry.value, `${context} between lower bound`);
		assertOperandCompatibleWithFieldType(type, entry.value2, `${context} between upper bound`);
		return;
	}
	if (entry.op === 'startsWith' || entry.op === 'textContains') {
		if (type !== 'string') {
			throw new ActiveTsValidationError(`Query operator "${entry.op}" on "${context}" requires a string field type.`);
		}
		assertOperandCompatibleWithFieldType(type, entry.value, `${context} ${entry.op} operand`);
		return;
	}
	assertOperandCompatibleWithFieldType(type, entry.value, `${context} ${entry.op} operand`);
}

function assertOperandCompatibleWithFieldType(type: FieldType, value: unknown, context: string) {
	if (value === null || value === undefined) return;
	if (type === 'date') {
		if (typeof value === 'string') return;
		throw new ActiveTsValidationError(`${context} must match date field type.`);
	}
	if (typeof value !== type) {
		throw new ActiveTsValidationError(`${context} must match ${type} field type.`);
	}
}

function invalidValueMessage(label: string, value: unknown) {
	return typeof value === 'string' ? `${label} "${value}" is not allowed.` : `${label} is not allowed.`;
}

function assertPlainFieldTypeObject(value: unknown, context: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
	}
}

function assertKnownFieldTypeKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = new Set<string>();
	for (const key of allowed) SET_ADD.call(allowedKeys, key);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function ownFieldTypeValue(record: Record<string, unknown>, key: string, context: string) {
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

function normalizeWhereShapeDateValue(value: unknown, context: string): unknown {
	if (Array.isArray(value)) {
		const safeValue = snapshotDateArrayInput(value, context);
		if (safeValue[0] === 'between') {
			const lower = normalizeDateQueryValue(safeValue[1], context);
			const upper = normalizeDateQueryValue(safeValue[2], context);
			assertValidWhereOperand('between', lower, upper, context);
			assertWhereArrayArity(safeValue, 'between', context);
			return [
				'between',
				lower,
				upper
			];
		}
		if (safeValue[0] === 'isNull' || safeValue[0] === 'isNotNull') {
			assertValidWhereOperand(safeValue[0], undefined, undefined, context);
			assertWhereArrayArity(safeValue, safeValue[0], context);
			return [safeValue[0]];
		}
		if (typeof safeValue[0] === 'string' && isOperator(safeValue[0])) {
			const operand = normalizeDateQueryValue(safeValue[1], context);
			assertValidWhereOperand(safeValue[0], operand, undefined, context);
			assertWhereArrayArity(safeValue, safeValue[0], context);
			return [safeValue[0], operand];
		}
		const normalizedValues: unknown[] = [];
		for (let index = 0; index < safeValue.length; index++) {
			normalizedValues[index] = normalizeDateQueryValue(safeValue[index], context);
		}
		return normalizedValues;
	}
	return normalizeDateQueryValue(value, context);
}

function normalizeDateQueryValue(value: unknown, context: string): unknown {
	if (Array.isArray(value)) {
		const safeValue = snapshotDateArrayInput(value, context);
		const normalizedValues: unknown[] = [];
		for (let index = 0; index < safeValue.length; index++) {
			normalizedValues[index] = normalizeDateQueryValue(safeValue[index], context);
		}
		return normalizedValues;
	}
	if (value === null || value === undefined) return value;
	return normalizeDateStorageValue(value, context);
}

function snapshotDateArrayInput(value: unknown, context: string) {
	const safeValue = snapshotArrayInput(value, context);
	for (const property of Object.getOwnPropertyNames(value)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, safeValue.length)) {
			throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${property}] must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}[${property}] must be enumerable.`);
		}
	}
	return safeValue;
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function normalizeDateStorageValue(value: unknown, context: string) {
	if (value instanceof Date) {
		assertValidDate(value, context);
		return dateIsoString(value);
	}
	if (typeof value === 'string') {
		return normalizeDateString(value, context);
	}
	throw new ActiveTsValidationError(`${context} must be a Date or ISO date string.`);
}

function normalizeDateRuntimeValue(value: unknown, context: string) {
	if (value instanceof Date) {
		assertValidDate(value, context);
		return value;
	}
	if (typeof value === 'string') {
		const date = new Date(normalizeDateString(value, context));
		return date;
	}
	throw new ActiveTsValidationError(`${context} must be a Date or ISO date string.`);
}

function normalizeDateString(value: string, context: string) {
	if (DATE_ONLY.test(value)) {
		const date = new Date(`${value}T00:00:00.000Z`);
		assertValidDate(date, context);
		if (dateIsoString(date).slice(0, 10) !== value) {
			throw new ActiveTsValidationError(`${context} must be a valid ISO date string.`);
		}
		return dateIsoString(date);
	}
	const date = new Date(value);
	assertValidDate(date, context);
	if (dateIsoString(date) !== value) {
		throw new ActiveTsValidationError(`${context} must be a Date, YYYY-MM-DD, or canonical ISO date string.`);
	}
	return value;
}

function assertValidDate(value: Date, context: string) {
	if (!Number.isFinite(dateTime(value))) {
		throw new ActiveTsValidationError(`${context} must be a valid date.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} Date value cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		throw new ActiveTsValidationError(`${context} Date value cannot contain custom property "${property}".`);
	}
}
