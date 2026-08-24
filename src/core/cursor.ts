import { ActiveTsConfigurationError } from './errors.js';
import { valueFor } from './query-utils.js';
import { assertDenseArrayItems, assertSafeCursor, assertSafeFieldPath, defineDataProperty } from './safe-keys.js';
import { dateIsoString, dateTime } from './date-intrinsics.js';
import { JSON_PARSE, JSON_STRINGIFY } from './json-intrinsics.js';
import type { QueryPlan, SortDirection } from './types.js';

type Comparable = string | number | boolean | null;

export type CursorSort = {
	field: string;
	direction: SortDirection;
};

export type KeysetCursor = {
	v: 1;
	kind: 'keyset';
	sort: CursorSort[];
	values: unknown[];
};

export function sortWithStableId(plan: Pick<QueryPlan, 'sort'>, idField: string): CursorSort[] {
	const safeIdField = assertSafeFieldPath(idField, 'cursor id field');
	const sort = sanitizeCursorSortList(cursorPlanSort(plan), 'cursor sort');
	let hasIdField = false;
	for (let index = 0; index < sort.length; index++) {
		if (sort[index].field !== safeIdField) continue;
		hasIdField = true;
		break;
	}
	if (!hasIdField) sort.push({ field: safeIdField, direction: 'asc' });
	return sort;
}

export function encodeCursor(cursor: KeysetCursor) {
	return Buffer.from(JSON_STRINGIFY(keysetCursorJson(sanitizeKeysetCursor(cursor))), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): KeysetCursor {
	const safeCursor = assertSafeCursor(cursor, 'active-ts cursor');
	if (safeCursor === undefined) throw new ActiveTsConfigurationError('Cursor is required.');
	try {
		const parsed = JSON_PARSE(Buffer.from(safeCursor, 'base64url').toString('utf8')) as Partial<KeysetCursor>;
		return sanitizeKeysetCursor(parsed);
	} catch {
		throw new ActiveTsConfigurationError('Invalid active-ts cursor.');
	}
}

export function assertCursorMatchesSort(cursor: KeysetCursor, sort: CursorSort[]) {
	const safeCursor = sanitizeKeysetCursor(cursor);
	const safeSort = sanitizeCursorSortList(sort, 'cursor sort');
	if (!cursorSortsEqual(safeCursor.sort, safeSort))
		throw new ActiveTsConfigurationError('Cursor was created for a different query ordering.');
}

export function cursorValues(row: any, sort: CursorSort[]) {
	const safeSort = sanitizeCursorSortList(sort, 'cursor sort');
	const values: Comparable[] = [];
	for (const entry of safeSort) values.push(comparable(valueFor(row, entry.field)));
	return values;
}

export function compareRowsBySort(a: any, b: any, sort: CursorSort[]) {
	for (const entry of sanitizeCursorSortList(sort, 'cursor sort')) {
		const order = compareValues(comparable(valueFor(a, entry.field)), comparable(valueFor(b, entry.field)));
		if (order !== 0) return entry.direction === 'asc' ? order : -order;
	}
	return 0;
}

export function compareRowToCursor(row: any, cursor: KeysetCursor) {
	const safeCursor = sanitizeKeysetCursor(cursor);
	for (let i = 0; i < safeCursor.sort.length; i++) {
		const entry = safeCursor.sort[i];
		const order = compareValues(comparable(valueFor(row, entry.field)), comparable(safeCursor.values[i]));
		if (order !== 0) return entry.direction === 'asc' ? order : -order;
	}
	return 0;
}

function comparable(value: unknown): Comparable {
	if (value instanceof Date) return cursorDateComparable(value);
	if (value === undefined) return null;
	if (value === null) return value;
	if (typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new ActiveTsConfigurationError('Cursor value must be a finite number.');
		return value;
	}
	throw new ActiveTsConfigurationError('Sort and cursor values must be string, number, boolean, Date, null, or missing.');
}

function cursorDateComparable(value: Date) {
	if (!Number.isFinite(dateTime(value))) {
		throw new ActiveTsConfigurationError('Sort and cursor Date values must be valid.');
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsConfigurationError('Sort and cursor Date values cannot contain symbol fields.');
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		throw new ActiveTsConfigurationError(`Sort and cursor Date values cannot contain custom property "${property}".`);
	}
	return dateIsoString(value);
}

function assertSafeCursorValue(value: unknown): asserts value is Comparable {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number' && Number.isFinite(value)) return;
	throw new ActiveTsConfigurationError('Cursor values must be string, number, boolean, or null.');
}

function compareValues(a: Comparable, b: Comparable) {
	if (a === b) return 0;
	if (a === null) return -1;
	if (b === null) return 1;
	const rankA = comparableTypeRank(a);
	const rankB = comparableTypeRank(b);
	if (rankA !== rankB) return rankA - rankB;
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
	return a > b ? 1 : -1;
}

function comparableTypeRank(value: Comparable) {
	if (typeof value === 'boolean') return 1;
	if (typeof value === 'number') return 2;
	return 3;
}

function sanitizeKeysetCursor(cursor: unknown): KeysetCursor {
	if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
		throw new ActiveTsConfigurationError('Cursor payload must be an object.');
	}
	const candidate = cursor as Record<string, unknown>;
	assertNoCursorAccessorFields(candidate, 'Cursor payload');
	if (ownCursorValue(candidate, 'v') !== 1 || ownCursorValue(candidate, 'kind') !== 'keyset') {
		throw new ActiveTsConfigurationError('Cursor payload version is not supported.');
	}
	const sort = sanitizeCursorSortList(ownCursorValue(candidate, 'sort'), 'cursor sort');
	const values = ownCursorValue(candidate, 'values');
	const safeValues = cursorArrayValues(values, 'Cursor values');
	if (sort.length !== safeValues.length) {
		throw new ActiveTsConfigurationError('Cursor sort and values must have the same length.');
	}
	for (const value of safeValues) assertSafeCursorValue(value);
	return {
		v: 1,
		kind: 'keyset',
		sort,
		values: safeValues
	};
}

function keysetCursorJson(cursor: KeysetCursor) {
	const sort = new Array(cursor.sort.length);
	for (let index = 0; index < cursor.sort.length; index++) {
		const entry = Object.create(null);
		defineDataProperty(entry, 'field', cursor.sort[index].field, { enumerable: true, configurable: true, writable: true });
		defineDataProperty(entry, 'direction', cursor.sort[index].direction, { enumerable: true, configurable: true, writable: true });
		sort[index] = entry;
	}
	Object.setPrototypeOf(sort, null);
	const values = new Array(cursor.values.length);
	for (let index = 0; index < cursor.values.length; index++) values[index] = cursor.values[index];
	Object.setPrototypeOf(values, null);
	const payload = Object.create(null);
	defineDataProperty(payload, 'v', 1, { enumerable: true, configurable: true, writable: true });
	defineDataProperty(payload, 'kind', 'keyset', { enumerable: true, configurable: true, writable: true });
	defineDataProperty(payload, 'sort', sort, { enumerable: true, configurable: true, writable: true });
	defineDataProperty(payload, 'values', values, { enumerable: true, configurable: true, writable: true });
	return payload;
}

function cursorSortsEqual(left: CursorSort[], right: CursorSort[]) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index].field !== right[index].field || left[index].direction !== right[index].direction) return false;
	}
	return true;
}

function cursorPlanSort(plan: unknown) {
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return undefined;
	if (!Object.prototype.hasOwnProperty.call(plan, 'sort')) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(plan, 'sort');
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError('cursor plan.sort must be a data property.');
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError('cursor plan.sort must be enumerable.');
	}
	return descriptor.value;
}

function sanitizeCursorSortList(sort: unknown, context: string): CursorSort[] {
	const entries = cursorArrayValues(sort, context);
	const safeSort: CursorSort[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new ActiveTsConfigurationError(`${context} entry at index ${index} must be an object.`);
		}
		const record = entry as Record<string, unknown>;
		assertNoCursorAccessorFields(record, `${context} entry at index ${index}`);
		const field = assertSafeFieldPath(ownCursorValue(record, 'field'), 'cursor sort field');
		const direction = ownCursorValue(record, 'direction');
		if (direction !== 'asc' && direction !== 'desc') {
			throw new ActiveTsConfigurationError(`${context} direction at index ${index} must be "asc" or "desc".`);
		}
		safeSort.push({ field, direction });
	}
	return safeSort;
}

function cursorArrayValues(value: unknown, context: string) {
	if (!Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an array.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const values: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be a data property.`);
		}
		values.push(descriptor.value);
	}
	return values;
}

function ownCursorValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${key} must be enumerable.`);
	}
	return descriptor.value;
}

function assertNoCursorAccessorFields(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
		}
	}
}
