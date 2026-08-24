import type { EntityId, QueryPlan, WhereShape } from './types.js';
import { assertSafeDataKeys, assertSafeEntityId, assertSafeFieldPath, assertSafeLimit, defineDataProperty } from './safe-keys.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { snapshotArrayInput } from './array-input.js';
import { dateIsoString, dateTime } from './date-intrinsics.js';
import { SET_ADD, SET_HAS, WEAKSET_ADD, WEAKSET_HAS } from './collection-intrinsics.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF,
	OBJECT_HAS_OWN,
	OBJECT_KEYS
} from './object-intrinsics.js';

const FILTER_WHERE_ENTRY_KEYS = capturedSet(['field', 'op', 'value', 'value2']);
const QUERY_OPERATORS = capturedSet<QueryPlan['where'][number]['op']>([
	'=',
	'!=',
	'>',
	'>=',
	'<',
	'<=',
	'in',
	'between',
	'isNull',
	'isNotNull',
	'contains',
	'arrayContains',
	'textContains',
	'jsonContains',
	'startsWith'
]);

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function entityIdKey(id: EntityId) {
	assertSafeEntityId(id);
	return `${typeof id}:${String(id)}`;
}

export function entityIdFromKey(key: string): EntityId {
	const separator = key.indexOf(':');
	if (separator < 0) {
		assertSafeEntityId(key, `Encoded entity id "${key}"`);
		return key;
	}
	const type = key.slice(0, separator);
	const value = key.slice(separator + 1);
	if (type === 'number') {
		const id = Number(value);
		assertSafeEntityId(id, `Encoded entity id "${key}"`);
		if (entityIdKey(id) !== key) throw new ActiveTsValidationError(`Encoded entity id "${key}" is not canonical.`);
		return id;
	}
	if (type === 'string') {
		assertSafeEntityId(value, `Encoded entity id "${key}"`);
		return value;
	}
	assertSafeEntityId(key, `Encoded entity id "${key}"`);
	return key;
}

export function entityIdFromCanonicalKey(key: string, context = 'Encoded entity id key'): EntityId {
	const id = entityIdFromKey(key);
	if (entityIdKey(id) !== key) {
		throw new ActiveTsValidationError(`${context} must be a canonical active-ts entity id key.`);
	}
	return id;
}

export function cloneQueryOperand<T>(value: T): T {
	return structuredClone(value);
}

export function withIdField(fields: readonly string[] | undefined, idField: string) {
	if (!fields?.length) return fields ? [idField] : undefined;
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const field of [idField, ...fields]) {
		if (SET_HAS.call(seen, field)) continue;
		SET_ADD.call(seen, field);
		unique.push(field);
	}
	return unique;
}

export function limitWithLookahead(limit: number | undefined, context = 'query limit') {
	if (limit === undefined) return undefined;
	const safeLimit = assertSafeLimit(limit, context) as number;
	return safeLimit < Number.MAX_SAFE_INTEGER ? safeLimit + 1 : safeLimit;
}

export function trimLookaheadRows<T>(rows: T[], limit: number | undefined, context = 'query limit') {
	if (limit === undefined) return { rows, more: false };
	const safeLimit = assertSafeLimit(limit, context) as number;
	const more = rows.length > safeLimit;
	if (!more) return { rows, more };
	const trimmed: T[] = [];
	for (let index = 0; index < safeLimit; index++) trimmed[index] = rows[index];
	return { rows: trimmed, more };
}

export function assertNoOverlappingFieldPaths(fields: readonly string[], context = 'field list') {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const field of fields) {
		const safeField = assertSafeFieldPath(field, context);
		if (SET_HAS.call(seen, safeField)) continue;
		SET_ADD.call(seen, safeField);
		unique.push(safeField);
	}
	for (let parentIndex = 0; parentIndex < unique.length; parentIndex++) {
		const parent = unique[parentIndex];
		for (let childIndex = 0; childIndex < unique.length; childIndex++) {
			if (parentIndex === childIndex) continue;
			const child = unique[childIndex];
			if (!child.startsWith(`${parent}.`)) continue;
			throw new ActiveTsValidationError(
				`${context} cannot include both "${parent}" and nested field "${child}".`
			);
		}
	}
	return unique;
}

export function valueFor(data: any, field: string) {
	assertSafeFieldPath(field, 'field path');
	let current = data;
	const path: string[] = [];
	for (const key of field.split('.')) {
		path.push(key);
		if (!current || typeof current !== 'object' || !OBJECT_HAS_OWN(current, key)) {
			return undefined;
		}
		current = ownFieldValue(current, key, `field path "${field}" segment "${path.join('.')}"`);
	}
	return current;
}

export function setPath(target: Record<string, any>, field: string, value: any) {
	const parts = assertSafeFieldPath(field, 'field path').split('.');
	let current = target;
	const prefix: string[] = [];
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index];
		prefix.push(part);
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, part);
		if (descriptor && !('value' in descriptor)) {
			throw new ActiveTsValidationError(
				`Cannot set field path "${field}" because "${prefix.join('.')}" must be a data property.`
			);
		}
		if (descriptor && !descriptor.enumerable) {
			throw new ActiveTsValidationError(
				`Cannot set field path "${field}" because "${prefix.join('.')}" must be enumerable.`
			);
		}
		const existing = descriptor ? descriptor.value : undefined;
		if (existing === undefined || existing === null) {
			defineDataProperty(current, part, {}, { enumerable: true, configurable: true, writable: true });
		} else if (!isPlainObject(existing)) {
			throw new ActiveTsValidationError(
				`Cannot set field path "${field}" because "${prefix.join('.')}" is not a plain object.`
			);
		}
		current = existing === undefined || existing === null ? ownFieldValue(current, part, `field path "${field}" segment "${prefix.join('.')}"`) : existing;
	}
	const leaf = parts[parts.length - 1];
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, leaf);
	if (descriptor) {
		if (!('value' in descriptor)) {
			throw new ActiveTsValidationError(
				`Cannot set field path "${field}" because "${field}" must be a data property.`
			);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(
				`Cannot set field path "${field}" because "${field}" must be enumerable.`
			);
		}
		if (descriptor.writable === false) {
			throw new ActiveTsValidationError(
				`Cannot set field path "${field}" because "${field}" is not writable.`
			);
		}
		current[leaf] = value;
	} else {
		defineDataProperty(current, leaf, value, { enumerable: true, configurable: true, writable: true });
	}
}

function ownFieldValue(record: object, key: string, context: string) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} must be enumerable.`);
	}
	return descriptor.value;
}

function isPlainObject(value: unknown): value is Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	return prototype === Object.prototype || prototype === null;
}

export function pickFields(data: any, fields: string[], idField: string) {
	const picked: Record<string, any> = {};
	setPath(picked, idField, valueFor(data, idField));
	for (const field of withIdField(fields, idField) ?? []) {
		const value = valueFor(data, field);
		if (value !== undefined) setPath(picked, field, value);
	}
	return picked;
}

export function compareWhere(data: any, where: QueryPlan['where'][number]) {
	const value = valueFor(data, where.field);
	if (where.op === '=') return value === where.value;
	if (where.op === '!=') return value !== undefined && value !== where.value;
	if (where.op === '>') return compareRangeValues(value, where.value) > 0;
	if (where.op === '>=') return compareRangeValues(value, where.value) >= 0;
	if (where.op === '<') return compareRangeValues(value, where.value) < 0;
	if (where.op === '<=') return compareRangeValues(value, where.value) <= 0;
	if (where.op === 'in') return arrayIncludesValue(where.value, value, 'Query operator "in" value array');
	if (where.op === 'between')
		return compareRangeValues(value, where.value) >= 0 && compareRangeValues(value, where.value2) <= 0;
	if (where.op === 'isNull') return value === null || value === undefined;
	if (where.op === 'isNotNull') return value !== null && value !== undefined;
	if (where.op === 'contains')
		throw new ActiveTsConfigurationError(
			'The legacy contains operator is ambiguous. Use arrayContains, textContains, or jsonContains.'
		);
	if (where.op === 'arrayContains') return arrayIncludesValue(value, where.value, `arrayContains row value "${where.field}"`);
	if (where.op === 'textContains') return textContainsValue(value, String(where.value));
	if (where.op === 'jsonContains') return jsonContains(value, where.value);
	if (where.op === 'startsWith') return typeof value === 'string' && value.startsWith(String(where.value));
	return false;
}

function compareRangeValues(value: unknown, expected: unknown) {
	const left = rangeComparable(value, expected);
	const right = rangeComparable(expected, expected);
	if (left === undefined || right === undefined) return Number.NaN;
	if (left === right) return 0;
	return left > right ? 1 : -1;
}

function rangeComparable(value: unknown, expected: unknown): string | number | undefined {
	if (expected instanceof Date) {
		return value instanceof Date && Number.isFinite(dateTime(value)) ? dateIsoString(value) : undefined;
	}
	if (typeof expected === 'number') {
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	}
	if (typeof expected === 'string') {
		return typeof value === 'string' ? value : undefined;
	}
	return undefined;
}

function textContainsValue(value: unknown, expected: string) {
	const query = expected.toLowerCase();
	if (typeof value === 'string') return value.toLowerCase().includes(query);
	if (!Array.isArray(value)) return false;
	for (const item of safeArrayValues(value, 'textContains row value')) {
		if (typeof item === 'string' && item.toLowerCase().includes(query)) return true;
	}
	return false;
}

function arrayIncludesValue(array: unknown, expected: unknown, context: string) {
	if (!Array.isArray(array)) return false;
	for (const item of safeArrayValues(array, context)) {
		if (Object.is(item, expected) || item === expected) return true;
	}
	return false;
}

function safeArrayValues(array: readonly unknown[], context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(array).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(array)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, array.length)) {
			throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(array, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${property}] must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}[${property}] must be enumerable.`);
		}
	}
	const values: unknown[] = [];
	for (let index = 0; index < array.length; index++) {
		if (!OBJECT_HAS_OWN(array, index)) {
			throw new ActiveTsValidationError(`${context}[${index}] is missing. Sparse arrays are not allowed.`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(array, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}[${index}] must be enumerable.`);
		}
		values.push(descriptor.value);
	}
	return values;
}

function jsonContains(value: unknown, expected: unknown): boolean {
	assertJsonContainsExpected(expected);
	if (Object.is(value, expected)) return true;
	if (Array.isArray(value)) {
		const items = safeArrayValues(value, 'jsonContains array value');
		if (Array.isArray(expected)) {
			const expectedItems = safeArrayValues(expected, 'jsonContains expected array value');
			for (const expectedItem of expectedItems) {
				let matched = false;
				for (const item of items) {
					if (jsonContains(item, expectedItem)) {
						matched = true;
						break;
					}
				}
				if (!matched) return false;
			}
			return true;
		}
		for (const item of items) {
			if (jsonContains(item, expected)) return true;
		}
		return false;
	}
	if (value && typeof value === 'object' && !isPlainObject(value)) {
		throw new ActiveTsValidationError('jsonContains value must be a plain object or array.');
	}
	if (!value || !expected || typeof value !== 'object' || typeof expected !== 'object') return false;
	if (Array.isArray(expected)) return false;
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(expected).length) {
		throw new ActiveTsValidationError('jsonContains expected value cannot contain symbol fields.');
	}
	const expectedKeys = OBJECT_GET_OWN_PROPERTY_NAMES(expected);
	for (let index = 0; index < expectedKeys.length; index++) {
		const key = expectedKeys[index];
		const expectedDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(expected, key);
		if (!expectedDescriptor || !('value' in expectedDescriptor)) {
			throw new ActiveTsValidationError(`jsonContains expected value at "${key}" must be a data property.`);
		}
		if (!expectedDescriptor.enumerable) {
			throw new ActiveTsValidationError(`jsonContains expected value at "${key}" must be enumerable.`);
		}
		const valueDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (!valueDescriptor) return false;
		if (!('value' in valueDescriptor)) {
			throw new ActiveTsValidationError(`jsonContains value at "${key}" must be a data property.`);
		}
		if (!valueDescriptor.enumerable) {
			throw new ActiveTsValidationError(`jsonContains value at "${key}" must be enumerable.`);
		}
		if (!jsonContains(valueDescriptor.value, expectedDescriptor.value)) return false;
	}
	return true;
}

function assertJsonContainsExpected(expected: unknown) {
	if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return;
	if (!isPlainObject(expected)) {
		throw new ActiveTsValidationError('jsonContains expected value must be a plain object or array.');
	}
}

export function filterRows<T>(rows: T[], plan: Pick<QueryPlan, 'where' | 'or'>, _idField = 'id') {
	const safeRows = snapshotArrayInput<T>(rows, 'portable filter rows');
	const safePlan = snapshotFilterPlan(plan, 'portable filter plan');
	const filtered: T[] = [];
	for (const item of safeRows) {
		if (matchesPlan(item, safePlan)) filtered.push(item);
	}
	return filtered;
}

function matchesPlan(data: unknown, plan: Pick<QueryPlan, 'where' | 'or'>): boolean {
	let baseMatches = true;
	for (const where of plan.where) {
		if (!compareWhere(data, where)) {
			baseMatches = false;
			break;
		}
	}
	if (!plan.or.length) return baseMatches;
	if (plan.where.length && baseMatches) return true;
	for (const branch of plan.or) {
		if (matchesPlan(data, branch)) return true;
	}
	return false;
}

function snapshotFilterPlan(plan: unknown, context: string): Pick<QueryPlan, 'where' | 'or'> {
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(plan);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(plan).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	const record = plan as Record<string, unknown>;
	const rawWhere = snapshotArrayInput<QueryPlan['where'][number]>(
		ownFilterPlanValue(record, 'where', context),
		`${context}.where`
	);
	const where: QueryPlan['where'] = [];
	for (let index = 0; index < rawWhere.length; index++) {
		where[index] = snapshotFilterWhereEntry(rawWhere[index], `${context}.where[${index}]`);
	}
	const rawOr = snapshotArrayInput<Pick<QueryPlan, 'where' | 'or'>>(
		ownFilterPlanValue(record, 'or', context),
		`${context}.or`
	);
	const or: QueryPlan['or'] = [];
	for (let index = 0; index < rawOr.length; index++) {
		or.push(snapshotFilterPlan(rawOr[index], `${context}.or[${index}]`) as QueryPlan);
	}
	return { where, or };
}

function snapshotFilterWhereEntry(entry: unknown, context: string): QueryPlan['where'][number] {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(entry);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(entry).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	const record = entry as Record<string, unknown>;
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		if (!SET_HAS.call(FILTER_WHERE_ENTRY_KEYS, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
	}
	const field = assertSafeFieldPath(ownFilterEntryValue(record, 'field', context), 'query field');
	const op = ownFilterEntryValue(record, 'op', context);
	if (typeof op !== 'string' || !isOperator(op)) {
		throw new ActiveTsValidationError(invalidValueMessage('Query operator', op));
	}
	const value = ownFilterEntryValue(record, 'value', context);
	const hasValue2 = OBJECT_HAS_OWN(record, 'value2');
	const value2 = ownFilterEntryValue(record, 'value2', context);
	assertValidWhereOperand(op, value, value2, field);
	if (op !== 'between' && hasValue2) {
		throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" does not accept value2.`);
	}
	return value2 === undefined
		? { field, op, value: cloneQueryOperand(value) }
		: { field, op, value: cloneQueryOperand(value), value2: cloneQueryOperand(value2) };
}

function ownFilterEntryValue(record: Record<string, unknown>, key: string, context: string) {
	if (!OBJECT_HAS_OWN(record, key)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}

function ownFilterPlanValue(record: Record<string, unknown>, key: 'where' | 'or', context: string) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}

export function whereShapeToPlan(where: WhereShape | undefined, context = 'where'): Pick<QueryPlan, 'where' | 'or'> {
	const entries: QueryPlan['where'] = [];
	for (const [field, raw] of whereShapeEntries(where, context)) {
		const safeField = assertSafeFieldPath(field, 'where field');
		if (raw === undefined) {
			throw new ActiveTsValidationError(`where field "${safeField}" cannot be undefined. Use null, isNull, or omit the field.`);
		}
		if (Array.isArray(raw)) {
			assertDenseArray(raw, `Query array operand on "${safeField}"`);
			const operator = ownArrayValue(raw, 0);
			if (operator === 'between') {
				const lower = ownArrayValue(raw, 1);
				const upper = ownArrayValue(raw, 2);
				assertValidWhereOperand('between', lower, upper, safeField);
				assertWhereArrayArity(raw, 'between', safeField);
				entries.push({
					field: safeField,
					op: 'between',
					value: cloneQueryOperand(lower),
					value2: cloneQueryOperand(upper)
				});
			} else if (typeof operator === 'string' && isOperator(operator)) {
				const operand = ownArrayValue(raw, 1);
				assertValidWhereOperand(operator, operand, undefined, safeField);
				assertWhereArrayArity(raw, operator, safeField);
				entries.push({ field: safeField, op: operator, value: cloneQueryOperand(operand) });
			} else {
				assertValidWhereOperand('in', raw, undefined, safeField);
				entries.push({ field: safeField, op: 'in', value: cloneQueryOperand(raw) });
			}
		} else {
			assertValidWhereOperand('=', raw, undefined, safeField);
			entries.push({ field: safeField, op: '=', value: cloneQueryOperand(raw) });
		}
	}
	return { where: entries, or: [] };
}

export function whereShapeEntries(where: WhereShape | undefined, context = 'where'): Array<[string, unknown]> {
	where = assertPlainWhereShape(where, context);
	if (!where) return [];
	const fields = OBJECT_KEYS(where);
	const entries: Array<[string, unknown]> = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(where as Record<string, unknown>, field);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${field} must be a data property.`);
		}
		entries[index] = [field, descriptor.value];
	}
	return entries;
}

export function assertPlainWhereShape(where: WhereShape | undefined, context = 'where') {
	if (where === undefined) return undefined;
	if (!where || typeof where !== 'object' || Array.isArray(where)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(where);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(where).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(where)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(where, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
	}
	return where;
}

function ownArrayValue(array: readonly unknown[], index: number, context = 'Query array operand') {
	if (!OBJECT_HAS_OWN(array, index)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(array, String(index));
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} must not contain accessors at index ${index}.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}[${index}] must be enumerable.`);
	}
	return descriptor.value;
}

function assertDenseArray(array: readonly unknown[], context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(array).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(array)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, array.length)) {
			throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(array, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context} must not contain accessors at index ${property}.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}[${property}] must be enumerable.`);
		}
	}
	for (let index = 0; index < array.length; index++) {
		if (!OBJECT_HAS_OWN(array, index)) {
			throw new ActiveTsValidationError(`${context} must not be sparse or inherit array items.`);
		}
	}
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

export function isOperator(value: string): value is QueryPlan['where'][number]['op'] {
	return SET_HAS.call(QUERY_OPERATORS, value as QueryPlan['where'][number]['op']);
}

export function assertValidWhereOperand(
	op: QueryPlan['where'][number]['op'],
	value: unknown,
	value2: unknown,
	field: string
) {
	if (op === 'contains') {
		throw new ActiveTsConfigurationError(
			'The legacy contains operator is ambiguous. Use arrayContains, textContains, or jsonContains.'
		);
	}
	if (typeof op !== 'string' || !isOperator(op)) {
		throw new ActiveTsValidationError(invalidValueMessage('Query operator', op));
	}
	if (op === 'in' && !Array.isArray(value)) {
		throw new ActiveTsValidationError(`Query operator "in" on "${field}" requires an array value.`);
	}
	if (op === 'in' && Array.isArray(value)) {
		if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
			throw new ActiveTsValidationError(`Query operator "in" on "${field}" array operand cannot contain symbol fields.`);
		}
		assertDenseArray(value, `Query operator "in" on "${field}" array operand`);
		if (!value.length) throw new ActiveTsValidationError(`Query operator "in" on "${field}" requires at least one value.`);
		if (value.length > 30)
			throw new ActiveTsValidationError(`Query operator "in" on "${field}" supports at most 30 values.`);
		for (let index = 0; index < value.length; index++) {
			assertPortableScalar(
				ownArrayValue(value, index, `Query operator "in" on "${field}" array operand`),
				`Query operator "in" on "${field}"`
			);
		}
	}
	if (op === '=' || op === '!=' || op === 'arrayContains') {
		assertPortableScalar(value, `Query operator "${op}" on "${field}"`);
	}
	if (op === 'between') {
		if (value === undefined || value2 === undefined) {
			throw new ActiveTsValidationError(`Query operator "between" on "${field}" requires both bounds.`);
		}
		assertRangeOperand(value, `Query operator "between" on "${field}"`);
		assertRangeOperand(value2, `Query operator "between" on "${field}"`);
		if (comparableKind(value) !== comparableKind(value2)) {
			throw new ActiveTsValidationError(`Query operator "between" on "${field}" requires matching bound types.`);
		}
	}
	if ((op === '>' || op === '>=' || op === '<' || op === '<=') && value === undefined) {
		throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" requires a value.`);
	}
	if (op === '>' || op === '>=' || op === '<' || op === '<=') {
		assertRangeOperand(value, `Query operator "${op}" on "${field}"`);
	}
	if ((op === 'isNull' || op === 'isNotNull') && value !== undefined) {
		throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" does not accept a value.`);
	}
	if ((op === 'textContains' || op === 'startsWith') && typeof value !== 'string') {
		throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" requires a string value.`);
	}
	if (op === 'jsonContains') {
		assertSafeDataKeys(value);
		assertNoUndefinedJsonOperand(value, `Query operator "${op}" on "${field}"`);
	}
}

export function assertWhereArrayArity(
	array: readonly unknown[],
	op: QueryPlan['where'][number]['op'],
	field: string
) {
	const expectedLength = op === 'between' ? 3 : op === 'isNull' || op === 'isNotNull' ? 1 : 2;
	if (array.length > expectedLength) {
		throw new ActiveTsValidationError(`Query operator "${op}" on "${field}" does not accept extra operands.`);
	}
}

function assertNoUndefinedJsonOperand(value: unknown, context: string, path = '$', seen = new WeakSet<object>()) {
	if (value === undefined) {
		throw new ActiveTsValidationError(`${context} does not support undefined values at "${path}". Use null or omit the field.`);
	}
	if (value instanceof Date) {
		throw new ActiveTsValidationError(`${context} does not support Date values at "${path}". Encode dates as strings.`);
	}
	if (value instanceof Uint8Array) {
		throw new ActiveTsValidationError(`${context} does not support binary values at "${path}". Encode binary values first.`);
	}
	if (!value || typeof value !== 'object') return;
	if (WEAKSET_HAS.call(seen, value)) return;
	WEAKSET_ADD.call(seen, value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${context} array value at "${path}[${index}]" must be a data property.`);
			}
			assertNoUndefinedJsonOperand(descriptor.value, context, `${path}[${index}]`, seen);
		}
		return;
	}
	for (const key of OBJECT_KEYS(value)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context} object value at "${path}.${key}" must be a data property.`);
		}
		assertNoUndefinedJsonOperand(descriptor.value, context, `${path}.${key}`, seen);
	}
}

function invalidValueMessage(label: string, value: unknown) {
	return typeof value === 'string' ? `${label} "${value}" is not allowed.` : `${label} is not allowed.`;
}

function comparableKind(value: unknown) {
	if (value instanceof Date) return 'date';
	return typeof value;
}

function assertRangeOperand(value: unknown, context: string) {
	if (typeof value === 'string') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
			throw new ActiveTsValidationError(`${context} requires finite safe number values.`);
		}
		return;
	}
	if (value instanceof Date) {
		assertPlainDateOperand(value, context);
		return;
	}
	throw new ActiveTsValidationError(`${context} requires string, number, or Date values.`);
}

export function assertPortableScalar(value: unknown, context: string) {
	if (value === null) return;
	if (typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
			throw new ActiveTsValidationError(`${context} requires finite safe number values.`);
		}
		return;
	}
	if (value instanceof Date) {
		assertPlainDateOperand(value, context);
		return;
	}
	throw new ActiveTsValidationError(`${context} requires string, number, boolean, Date, or null values.`);
}

export function portableScalarKey(value: unknown, context: string) {
	assertPortableScalar(value, context);
	if (value === null) return 'null:';
	if (value instanceof Date) return `date:${dateIsoString(value)}`;
	return `${typeof value}:${String(value)}`;
}

function assertPlainDateOperand(value: Date, context: string) {
	if (!Number.isFinite(dateTime(value))) {
		throw new ActiveTsValidationError(`${context} requires valid Date values.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsValidationError(`${context} Date value cannot contain symbol fields.`);
	}
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		throw new ActiveTsValidationError(`${context} Date value cannot contain custom property "${property}".`);
	}
}
