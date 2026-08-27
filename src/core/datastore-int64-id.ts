import { ActiveTsValidationError } from './errors.js';

declare const DATASTORE_INT64_ID_BRAND: unique symbol;

export type DatastoreInt64Id = string & {
	readonly [DATASTORE_INT64_ID_BRAND]: 'DatastoreInt64Id';
};

const DATASTORE_INT64_ID_PREFIX = '\0active-ts:datastore-int64:';
const DATASTORE_INT64_MIN = -(1n << 63n);
const DATASTORE_INT64_MAX = (1n << 63n) - 1n;
const SAFE_INTEGER_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function datastoreInt64Decimal(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.startsWith(DATASTORE_INT64_ID_PREFIX)) return undefined;
	const decimal = value.slice(DATASTORE_INT64_ID_PREFIX.length);
	if (!/^-?(0|[1-9]\d*)$/.test(decimal) || decimal === '-0') return undefined;
	let parsed: bigint;
	try {
		parsed = BigInt(decimal);
	} catch {
		return undefined;
	}
	if (parsed === 0n || parsed < DATASTORE_INT64_MIN || parsed > DATASTORE_INT64_MAX) return undefined;
	if (parsed >= SAFE_INTEGER_MIN && parsed <= SAFE_INTEGER_MAX) return undefined;
	return decimal;
}

export function datastoreInt64Id(value: string | bigint): DatastoreInt64Id {
	const decimal = typeof value === 'bigint' ? value.toString() : value;
	if (typeof decimal !== 'string' || !/^-?(0|[1-9]\d*)$/.test(decimal) || decimal === '-0') {
		throw new ActiveTsValidationError('Datastore int64 id must be a canonical decimal string or bigint.');
	}
	let parsed: bigint;
	try {
		parsed = BigInt(decimal);
	} catch {
		throw new ActiveTsValidationError('Datastore int64 id must be a canonical decimal string or bigint.');
	}
	if (parsed === 0n) {
		throw new ActiveTsValidationError('Datastore int64 id cannot be zero.');
	}
	if (parsed < DATASTORE_INT64_MIN || parsed > DATASTORE_INT64_MAX) {
		throw new ActiveTsValidationError('Datastore int64 id must fit in a signed 64-bit integer.');
	}
	if (parsed >= SAFE_INTEGER_MIN && parsed <= SAFE_INTEGER_MAX) {
		throw new ActiveTsValidationError(
			'Datastore int64 id is within the JavaScript safe-integer range; use a number entity id instead.'
		);
	}
	return `${DATASTORE_INT64_ID_PREFIX}${decimal}` as DatastoreInt64Id;
}

export function isDatastoreInt64Id(value: unknown): value is DatastoreInt64Id {
	return datastoreInt64Decimal(value) !== undefined;
}

export function datastoreInt64IdValue(id: DatastoreInt64Id): string {
	const decimal = datastoreInt64Decimal(id);
	if (decimal === undefined) {
		throw new ActiveTsValidationError('Datastore int64 id must use the reserved canonical int64 representation.');
	}
	return decimal;
}
