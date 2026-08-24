import { optionalImport } from '../../core/optional-import.js';
import { assertCacheableValue, assertSafeCacheKey, assertSafeTtl, defineDataProperty } from '../../core/safe-keys.js';
import { ActiveTsValidationError } from '../../core/errors.js';
import type { CacheAdapter, CacheCodec, CacheWriteOptions } from '../../core/types.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { SET_ADD, SET_HAS, WEAKSET_ADD, WEAKSET_DELETE, WEAKSET_HAS } from '../../core/collection-intrinsics.js';
import { JSON_PARSE, JSON_STRINGIFY } from '../../core/json-intrinsics.js';

export type RedisValkeyOptions = {
	client?: any;
	url?: string;
	prefix?: string;
	codec?: CacheCodec<string | Buffer>;
};
const REDIS_VALKEY_OPTION_KEYS = ['client', 'url', 'prefix', 'codec'] as const;
const CACHE_WRITE_OPTION_KEYS = ['ttl'] as const;

const pack = (value: any) => {
	const serialized = JSON_STRINGIFY(snapshotRedisValkeyJson(value));
	if (serialized === undefined) {
		throw new ActiveTsValidationError('redis-valkey cache value must be JSON serializable.');
	}
	return serialized;
};
const unpack = (value: string | Buffer | null) => {
	if (value === null) return undefined;
	try {
		return JSON_PARSE(Buffer.isBuffer(value) ? value.toString('utf8') : value);
	} catch {
		throw new ActiveTsValidationError('redis-valkey cache payload must be valid JSON.');
	}
};

export async function createRedisValkeyCacheAdapter(options: RedisValkeyOptions = {}): Promise<CacheAdapter> {
	options = validateRedisValkeyOptions(options);
	const mod = options.client ? undefined : await optionalImport('redis', 'RedisValkeyCacheAdapter');
	const rawClient = options.client ?? mod.createClient({ url: options.url });
	if (!options.client) await rawClient.connect();
	const client = normalizeRedisValkeyClient(rawClient);
	const codec = options.codec;
	const prefix = normalizePrefix(options.prefix);
	const key = (raw: string) => redisValkeyPhysicalKey(prefix, assertSafeCacheKey(raw, 'redis-valkey cache key'));
	const encode = async (entryKey: string, value: any) => {
		const physicalKey = key(entryKey);
		if (!codec) return pack(value);
		return cloneRedisValkeyEncodedPayload(
			await codec.encode(structuredClone(value), {
				key: physicalKey,
				adapter: 'redis-valkey',
				operation: 'set'
			})
		);
	};
	const decode = async (entryKey: string, value: string | Buffer | null) => {
		if (value === null) return undefined;
		const physicalKey = key(entryKey);
		const decoded = !codec
			? unpack(value)
			: await codec.decode(cloneRedisValkeyEncodedPayload(value), {
					key: physicalKey,
					adapter: 'redis-valkey',
					operation: 'get'
				});
		assertCacheableValue(decoded);
		return structuredClone(decoded);
	};

	return {
		kind: 'redis-valkey',
		codecKey: key,
		async getMany(keys) {
			keys = normalizeCacheKeys(keys, 'redis-valkey cache keys');
			if (!keys.length) return [];
			const physicalKeys: string[] = [];
			for (let index = 0; index < keys.length; index++) {
				physicalKeys[index] = key(keys[index]);
			}
			const raw = assertRedisGetManyResult(await client.mGet(physicalKeys), keys.length);
			const decodeTasks: Array<Promise<any | undefined>> = [];
			for (let index = 0; index < raw.length; index++) {
				decodeTasks[index] = decode(keys[index], raw[index]);
			}
			return await Promise.all(decodeTasks);
		},
		async setMany(entries: Array<[string, any]>, writeOptions: CacheWriteOptions = {}) {
			entries = normalizeCacheEntries(entries, 'redis-valkey cache entries');
			writeOptions = normalizeCacheWriteOptions(writeOptions, 'redis-valkey cache write options');
			if (!entries.length) return;
			for (const [, value] of entries) {
				assertCacheableValue(value);
			}
			const ttl = assertSafeTtl(writeOptions.ttl, 'redis-valkey cache ttl');
			if (ttl !== undefined) {
				const multi = normalizeRedisValkeyMulti(client.multi());
				for (const [entryKey, value] of entries)
					multi.set(key(entryKey), await encode(entryKey, value), { EX: Math.ceil(ttl) });
				assertRedisMultiExecResult(await multi.exec(), entries.length);
				return;
			}
			assertRedisWriteAcknowledgement(
				await client.mSet(await encodeRedisValkeyEntries(entries, key, encode)),
				'redis-valkey cache mSet'
			);
		},
		async deleteMany(keys) {
			keys = normalizeCacheKeys(keys, 'redis-valkey cache keys');
			if (keys.length) {
				const physicalKeys: string[] = [];
				for (let index = 0; index < keys.length; index++) {
					physicalKeys[index] = key(keys[index]);
				}
				assertRedisDeleteAcknowledgement(await client.del(physicalKeys), 'redis-valkey cache del');
			}
		}
	};
}

function normalizeCacheKeys(keys: unknown, context: string): string[] {
	const rawKeys = snapshotArrayInput<string>(keys, context);
	const safeKeys: string[] = [];
	for (let index = 0; index < rawKeys.length; index++) {
		safeKeys[index] = assertSafeCacheKey(rawKeys[index], `${context}[${index}]`);
	}
	return safeKeys;
}

function normalizeCacheEntries(entries: unknown, context: string): Array<[string, any]> {
	const rawEntries = snapshotArrayInput<unknown>(entries, context);
	const safeEntries: Array<[string, any]> = [];
	const keys = new Set<string>();
	for (let index = 0; index < rawEntries.length; index++) {
		const entry = rawEntries[index];
		if (!Array.isArray(entry) || entry.length !== 2) {
			throw new ActiveTsValidationError(`${context} must contain [key, value] entries.`);
		}
		const tuple = snapshotArrayInput(entry, `${context}[${index}]`);
		const key = assertSafeCacheKey(tuple[0], `${context}[${index}] key`);
		if (SET_HAS.call(keys, key)) {
			throw new ActiveTsValidationError(`${context} contains duplicate key "${key}".`);
		}
		SET_ADD.call(keys, key);
		safeEntries[index] = [key, tuple[1]];
	}
	return safeEntries;
}

function normalizeCacheWriteOptions(options: unknown, context: string): CacheWriteOptions {
	if (options === undefined) return { ttl: undefined };
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	assertNoSymbolOptions(options as Record<string, unknown>, context);
	assertKnownOptions(options as Record<string, unknown>, CACHE_WRITE_OPTION_KEYS, context);
	return {
		ttl: ownOptionValue(options as Record<string, unknown>, 'ttl')
	};
}

function assertRedisGetManyResult(value: unknown, expected: number): Array<string | Buffer | null> {
	if (!Array.isArray(value) || value.length !== expected) {
		throw new ActiveTsValidationError(`redis-valkey cache mGet result must be an array with ${expected} entries.`);
	}
	const items = snapshotArrayInput<string | Buffer | null>(value, 'redis-valkey cache mGet result');
	const safeItems: Array<string | Buffer | null> = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item === null || typeof item === 'string' || Buffer.isBuffer(item)) {
			safeItems[index] = item;
			continue;
		}
		throw new ActiveTsValidationError('redis-valkey cache payload must be a string, Buffer, or null.');
	}
	return safeItems;
}

async function encodeRedisValkeyEntries(
	entries: Array<[string, any]>,
	key: (raw: string) => string,
	encode: (entryKey: string, value: any) => Promise<string | Buffer>
) {
	const encoded = {} as Record<string, string | Buffer>;
	for (let index = 0; index < entries.length; index++) {
		const [entryKey, value] = entries[index];
		defineDataProperty(encoded, key(entryKey), await encode(entryKey, value), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return encoded;
}

function assertRedisWriteAcknowledgement(value: unknown, context: string) {
	if (value === 'OK' || value === true) return;
	if (value instanceof Error) {
		throw new ActiveTsValidationError(`${context} returned an error.`);
	}
	throw new ActiveTsValidationError(`${context} acknowledgement failed.`);
}

function assertRedisDeleteAcknowledgement(value: unknown, context: string) {
	if (value instanceof Error) {
		throw new ActiveTsValidationError(`${context} returned an error.`);
	}
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return;
	throw new ActiveTsValidationError(`${context} acknowledgement failed.`);
}

function assertRedisMultiExecResult(value: unknown, expected: number) {
	if (!Array.isArray(value)) {
		throw new ActiveTsValidationError('redis-valkey cache multi.exec result must be an array.');
	}
	const replies = snapshotArrayInput(value, 'redis-valkey cache multi.exec result');
	if (replies.length !== expected) {
		throw new ActiveTsValidationError(`redis-valkey cache multi.exec result must contain ${expected} replies.`);
	}
	for (const reply of replies) {
		assertRedisWriteAcknowledgement(reply, 'redis-valkey cache multi.exec reply');
	}
}

function snapshotRedisValkeyJson(value: unknown, path = '$', seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (WEAKSET_HAS.call(seen, value)) {
		throw new ActiveTsValidationError(`redis-valkey cache value contains circular reference at "${path}".`);
	}
	WEAKSET_ADD.call(seen, value);
	try {
		if (Array.isArray(value)) {
			const next = new Array(value.length);
			Object.setPrototypeOf(next, null);
			for (let index = 0; index < value.length; index++) {
				next[index] = snapshotRedisValkeyJson(redisValkeyJsonDataProperty(value, String(index), `${path}[${index}]`), `${path}[${index}]`, seen);
			}
			return next;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError(`redis-valkey cache value at "${path}" must be a plain object.`);
		}
		const next: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value)) {
			const propertyPath = `${path}.${key}`;
			defineDataProperty(next, key, snapshotRedisValkeyJson(redisValkeyJsonDataProperty(value, key, propertyPath), propertyPath, seen), {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
		return next;
	} finally {
		WEAKSET_DELETE.call(seen, value);
	}
}

function redisValkeyJsonDataProperty(value: object, key: string, path: string) {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`redis-valkey cache value at "${path}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`redis-valkey cache value at "${path}" must be enumerable.`);
	}
	return descriptor.value;
}

function validateRedisValkeyOptions(options: RedisValkeyOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError('redis-valkey cache options must be an object.');
	}
	assertPlainFactoryOptions(options, 'redis-valkey cache options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'redis-valkey cache options');
	assertKnownOptions(record, REDIS_VALKEY_OPTION_KEYS, 'redis-valkey cache options');
	const client = ownFactoryOptionValue(record, 'client', 'redis-valkey cache option');
	const url = ownFactoryOptionValue(record, 'url', 'redis-valkey cache option');
	const prefix = ownFactoryOptionValue(record, 'prefix', 'redis-valkey cache option');
	const codec = ownFactoryOptionValue(record, 'codec', 'redis-valkey cache option');
	if (url !== undefined && typeof url !== 'string') {
		throw new ActiveTsValidationError('redis-valkey cache url must be a string.');
	}
	if (client !== undefined && url !== undefined) {
		throw new ActiveTsValidationError('redis-valkey cache options cannot combine client and url.');
	}
	if (client !== undefined) {
		normalizeRedisValkeyClient(client);
	}
	if (prefix !== undefined) normalizePrefix(prefix);
	if (codec !== undefined) {
		normalizeRedisValkeyCodec(codec);
	}
	return { client, url, prefix, codec: codec === undefined ? undefined : normalizeRedisValkeyCodec(codec) } as RedisValkeyOptions;
}

function assertPlainFactoryOptions(options: object, context: string) {
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
}

function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownOptions(record: Record<string, unknown>, allowedKeys: readonly string[], context: string) {
	const allowed = new Set<string>();
	for (const key of allowedKeys) SET_ADD.call(allowed, key);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function ownFactoryOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function normalizeRedisValkeyClient(client: unknown) {
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsValidationError('redis-valkey cache client must be an object.');
	}
	const mGet = clientMethod(client, 'mGet', 'redis-valkey cache client.mGet');
	const mSet = clientMethod(client, 'mSet', 'redis-valkey cache client.mSet');
	const multi = clientMethod(client, 'multi', 'redis-valkey cache client.multi');
	const del = clientMethod(client, 'del', 'redis-valkey cache client.del');
	return Object.freeze({ mGet, mSet, multi, del });
}

function normalizeRedisValkeyMulti(multi: unknown) {
	if (!multi || typeof multi !== 'object' || Array.isArray(multi)) {
		throw new ActiveTsValidationError('redis-valkey cache multi result must be an object.');
	}
	const set = clientMethod(multi, 'set', 'redis-valkey cache multi.set');
	const exec = clientMethod(multi, 'exec', 'redis-valkey cache multi.exec');
	return Object.freeze({ set, exec });
}

function normalizeRedisValkeyCodec(codec: unknown): CacheCodec<string | Buffer> {
	if (!codec || typeof codec !== 'object' || Array.isArray(codec)) {
		throw new ActiveTsValidationError('redis-valkey cache codec must be an object.');
	}
	const name = clientMember(codec, 'name', 'redis-valkey cache codec name');
	if (typeof name !== 'string' || !name || name.includes('\0')) {
		throw new ActiveTsValidationError('redis-valkey cache codec name must be a non-empty string.');
	}
	const encode = clientMethod(codec, 'encode', 'redis-valkey cache codec encode');
	const decode = clientMethod(codec, 'decode', 'redis-valkey cache codec decode');
	return Object.freeze({ name, encode, decode });
}

function normalizeRedisValkeyEncodedPayload(value: unknown) {
	if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
	throw new ActiveTsValidationError('redis-valkey cache codec encoded payload must be a string or Buffer.');
}

function cloneRedisValkeyEncodedPayload(value: unknown) {
	const safe = normalizeRedisValkeyEncodedPayload(value);
	return Buffer.isBuffer(safe) ? Buffer.from(safe) : safe;
}

function clientMethod(client: object, method: string, context: string) {
	const value = clientMember(client, method, context);
	if (typeof value !== 'function') {
		throw new ActiveTsValidationError(`${context} must be a function.`);
	}
	return value.bind(client);
}

function clientMember(client: object, property: string, context: string) {
	let current: object | null = client;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${context} must be a data property.`);
			}
			if (current === client && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsValidationError(`${context} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${key} must be enumerable.`);
	}
	return descriptor.value;
}

function normalizePrefix(prefix: unknown) {
	if (prefix === undefined || prefix === '') return '';
	if (typeof prefix !== 'string' || prefix.includes('\0')) {
		throw new ActiveTsValidationError('redis-valkey cache prefix must be a string without null bytes.');
	}
	return assertSafeCacheKey(prefix, 'redis-valkey cache prefix');
}

function redisValkeyPhysicalKey(prefix: string, key: string) {
	return assertSafeCacheKey(
		`active-ts:${redisValkeyKeyPart(prefix)}:${redisValkeyKeyPart(key)}`,
		'redis-valkey physical cache key'
	);
}

function redisValkeyKeyPart(value: string) {
	return Buffer.from(value, 'utf8').toString('base64url');
}
