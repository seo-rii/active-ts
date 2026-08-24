import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ActiveTsValidationError } from './errors.js';
import { assertCacheableValue, assertSafeCacheKey, assertSafeTtl, defineDataProperty } from './safe-keys.js';
import type { CacheAdapter, CacheCodec, CacheWriteOptions } from './types.js';
import { snapshotArrayInput } from './array-input.js';
import { markCacheAdapterSource } from './cache-utils.js';
import { SET_ADD, SET_HAS, WEAKSET_ADD, WEAKSET_DELETE, WEAKSET_HAS } from './collection-intrinsics.js';
import { JSON_PARSE, JSON_STRINGIFY } from './json-intrinsics.js';

export type CodecCacheAdapterOptions = {
	kind?: string;
};
const CODEC_CACHE_ADAPTER_OPTION_KEYS = ['kind'] as const;
const CACHE_WRITE_OPTION_KEYS = ['ttl'] as const;

export function createCodecCacheAdapter(
	adapter: CacheAdapter,
	codec: CacheCodec,
	options: CodecCacheAdapterOptions = {}
): CacheAdapter {
	const wrapped = normalizeCacheAdapterShape(adapter, 'codec cache adapter');
	const normalizedCodec = normalizeCacheCodecShape(codec);
	options = normalizeCodecCacheAdapterOptions(options);
	const codecAdapter: CacheAdapter = {
		kind: options.kind ?? `${wrapped.kind}+${normalizedCodec.name}`,
		codecKey: wrapped.codecKey,
		async getMany(keys) {
			keys = normalizeCodecCacheKeys(keys, 'codec cache keys');
			if (!keys.length) return [];
			const codecKeys = codecContextKeys(wrapped, keys);
			const rows = normalizeCodecCacheGetManyResult(
				await wrapped.getMany(keys),
				keys.length,
				`codec cache adapter "${wrapped.kind}" getMany`
			);
			const decodeTasks: Array<Promise<any | undefined>> = [];
			for (let index = 0; index < rows.length; index++) {
				const value = rows[index];
				decodeTasks[index] = value === undefined
					? Promise.resolve(undefined)
					: decodeCodecCacheValue(normalizedCodec, wrapped.kind, codecKeys[index], value);
			}
			return await Promise.all(decodeTasks);
		},
		async setMany(entries: Array<[string, any]>, writeOptions: CacheWriteOptions = {}) {
			entries = normalizeCodecCacheEntries(entries, 'codec cache entries');
			writeOptions = normalizeCodecCacheWriteOptions(writeOptions, 'codec cache write options');
			for (const [, value] of entries) assertCacheableValue(value);
			if (!entries.length) return;
			const encodeTasks: Array<Promise<[string, any]>> = [];
			for (let index = 0; index < entries.length; index++) {
				const [key, value] = entries[index];
				encodeTasks[index] = encodeCodecCacheEntry(normalizedCodec, wrapped, key, value);
			}
			const encoded = await Promise.all(encodeTasks);
			await wrapped.setMany(encoded, writeOptions);
		},
		async deleteMany(keys) {
			keys = normalizeCodecCacheKeys(keys, 'codec cache keys');
			if (!keys.length) return;
			await wrapped.deleteMany(keys);
		}
	};
	return markCacheAdapterSource(codecAdapter, adapter);
}

function cloneCodecEncodedInput<T>(value: T, context: string): T {
	if (value === null || typeof value !== 'object') return value;
	if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
	try {
		return structuredClone(value);
	} catch {
		throw new ActiveTsValidationError(`${context} must be cloneable before decode.`);
	}
}

function assertCodecEncodedPayload(value: unknown, context: string) {
	try {
		assertCacheableValue(value);
	} catch (error) {
		if (error instanceof ActiveTsValidationError) {
			throw new ActiveTsValidationError(`${context}: ${error.message}`);
		}
		throw error;
	}
}

async function decodeCodecCacheValue(codec: CacheCodec, adapter: string, key: string, value: unknown) {
	const decoded = await codec.decode(
		cloneCodecEncodedInput(value, `codec cache adapter "${adapter}" encoded payload`),
		{
			key,
			adapter,
			operation: 'get'
		}
	);
	assertCacheableValue(decoded);
	return structuredClone(decoded);
}

async function encodeCodecCacheEntry(codec: CacheCodec, adapter: CacheAdapter, key: string, value: any): Promise<[string, any]> {
	const encodedValue = await codec.encode(structuredClone(value), {
		key: codecContextKey(adapter, key),
		adapter: adapter.kind,
		operation: 'set'
	});
	assertCodecEncodedPayload(encodedValue, `codec cache adapter "${adapter.kind}" encoded payload`);
	return [key, structuredClone(encodedValue)];
}

function normalizeCodecCacheGetManyResult(value: unknown, expected: number, context: string) {
	if (!Array.isArray(value) || value.length !== expected) {
		throw new ActiveTsValidationError(`${context} result must be an array with ${expected} entries.`);
	}
	return snapshotArrayInput(value, `${context} result`);
}

function normalizeCodecCacheKeys(keys: unknown, context: string) {
	const rawKeys = snapshotArrayInput(keys, context);
	const safeKeys: string[] = [];
	for (let index = 0; index < rawKeys.length; index++) {
		safeKeys[index] = assertSafeCacheKey(rawKeys[index], `${context}[${index}]`);
	}
	return safeKeys;
}

function normalizeCodecCacheEntries(entries: unknown, context: string): Array<[string, any]> {
	const rawEntries = snapshotArrayInput(entries, context);
	const safeEntries: Array<[string, any]> = [];
	const keys = new Set<string>();
	for (let index = 0; index < rawEntries.length; index++) {
		const entry = rawEntries[index];
		if (!Array.isArray(entry) || entry.length !== 2) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a [key, value] tuple.`);
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

function normalizeCodecCacheWriteOptions(options: unknown, context: string): CacheWriteOptions {
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
	const ttl = assertSafeTtl(ownOptionValue(options as Record<string, unknown>, 'ttl', context), `${context}.ttl`);
	return { ttl };
}

function normalizeCodecCacheAdapterOptions(value: unknown): CodecCacheAdapterOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError('codec cache adapter options must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('codec cache adapter options must be a plain object.');
	}
	assertNoSymbolOptions(value as Record<string, unknown>, 'codec cache adapter options');
	assertKnownOptions(value as Record<string, unknown>, CODEC_CACHE_ADAPTER_OPTION_KEYS, 'codec cache adapter options');
	const kind = ownOptionValue(value as Record<string, unknown>, 'kind', 'codec cache adapter options');
	if (kind !== undefined && (typeof kind !== 'string' || !kind || kind.includes('\0'))) {
		throw new ActiveTsValidationError('codec cache adapter kind must be a non-empty string without null bytes.');
	}
	return { kind: kind as string | undefined };
}

function normalizeCacheAdapterShape(adapter: unknown, context: string): CacheAdapter {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
		throw new ActiveTsValidationError(`${context} must be a cache adapter object.`);
	}
	const candidate = adapter as CacheAdapter;
	const kind = objectMember(adapter, 'kind');
	const getMany = objectMember(adapter, 'getMany');
	const setMany = objectMember(adapter, 'setMany');
	const deleteMany = objectMember(adapter, 'deleteMany');
	const codecKey = objectMember(adapter, 'codecKey');
	if (
		typeof kind !== 'string' ||
		!kind ||
		kind.includes('\0') ||
		typeof getMany !== 'function' ||
		typeof setMany !== 'function' ||
		typeof deleteMany !== 'function'
	) {
		throw new ActiveTsValidationError(`${context} must provide kind, getMany, setMany, and deleteMany.`);
	}
	const normalized: CacheAdapter = {
		kind,
		getMany: getMany.bind(candidate),
		setMany: setMany.bind(candidate),
		deleteMany: deleteMany.bind(candidate)
	};
	if (codecKey !== undefined) {
		if (typeof codecKey !== 'function') throw new ActiveTsValidationError(`${context}.codecKey must be a function.`);
		normalized.codecKey = codecKey.bind(candidate);
	}
	return normalized;
}

function codecContextKeys(adapter: CacheAdapter, keys: string[]) {
	if (!adapter.codecKey) return keys;
	const codecKey = adapter.codecKey;
	const codecKeys: string[] = [];
	for (let index = 0; index < keys.length; index++) {
		codecKeys[index] = assertSafeCacheKey(
			codecKey(keys[index]),
			`codec cache adapter "${adapter.kind}" codecKey result[${index}]`
		);
	}
	return codecKeys;
}

function codecContextKey(adapter: CacheAdapter, key: string) {
	if (!adapter.codecKey) return key;
	return assertSafeCacheKey(adapter.codecKey(key), `codec cache adapter "${adapter.kind}" codecKey result`);
}

function normalizeCacheCodecShape(codec: unknown): CacheCodec {
	if (!codec || typeof codec !== 'object' || Array.isArray(codec)) {
		throw new ActiveTsValidationError('cache codec must be an object.');
	}
	const candidate = codec as CacheCodec;
	const name = objectMember(codec, 'name');
	const encode = objectMember(codec, 'encode');
	const decode = objectMember(codec, 'decode');
	if (typeof name !== 'string' || !name || name.includes('\0')) {
		throw new ActiveTsValidationError('cache codec name must be a non-empty string without null bytes.');
	}
	if (typeof encode !== 'function') throw new ActiveTsValidationError('cache codec encode must be a function.');
	if (typeof decode !== 'function') throw new ActiveTsValidationError('cache codec decode must be a function.');
	return {
		name,
		encode: encode.bind(candidate),
		decode: decode.bind(candidate)
	};
}

function objectMember(record: object, key: string) {
	let current: object | null = record;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, key)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${key} must be a data property.`);
			}
			if (current === record && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsValidationError(`${key} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

export type AesGcmCacheCodecOptions = {
	key: string | Buffer | Uint8Array;
	version?: string;
	aad?: string | Buffer | Uint8Array;
	randomBytes?: (size: number) => Buffer | Uint8Array;
};
const AES_GCM_OPTION_KEYS = ['key', 'version', 'aad', 'randomBytes'] as const;

export function createAesGcmCacheCodec(options: AesGcmCacheCodecOptions): CacheCodec<string | Buffer> {
	options = normalizeAesGcmOptions(options);
	const key = normalizeAesKey(options.key);
	const version = normalizePayloadVersion(options.version ?? 'v1');
	const aad = options.aad === undefined ? undefined : normalizeBytes(options.aad, 'AES-GCM cache codec AAD');
	const random = options.randomBytes ?? randomBytes;

	return {
		name: 'aes-256-gcm',
		encode(value, context) {
			const contextKey = normalizeAesContextKey(context, 'AES-GCM cache codec encode context');
			assertCacheableValue(value);
			const iv = normalizeBytes(random(12), 'AES-GCM cache codec IV');
			if (iv.length !== 12) throw new ActiveTsValidationError('AES-GCM cache codec IV must be exactly 12 bytes.');
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			cipher.setAAD(aadForKey(contextKey, aad));
			const plaintext = Buffer.from(JSON_STRINGIFY(snapshotAesGcmJson(value)), 'utf8');
			const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
			const tag = cipher.getAuthTag();
			return [version, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
		},
		decode(value, context) {
			const contextKey = normalizeAesContextKey(context, 'AES-GCM cache codec decode context');
			if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
				throw new ActiveTsValidationError('AES-GCM cache codec payload must be a string or Buffer.');
			}
			const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
			const parts = text.split(':');
			if (parts.length !== 4) {
				throw new ActiveTsValidationError('Unsupported cache codec payload format.');
			}
			const [valueVersion, iv, tag, ciphertext] = parts;
			if (valueVersion !== version || !iv || !tag || !ciphertext) {
				throw new ActiveTsValidationError(`Unsupported cache codec payload version "${valueVersion}".`);
			}
			try {
				const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
				decipher.setAAD(aadForKey(contextKey, aad));
				decipher.setAuthTag(Buffer.from(tag, 'base64url'));
				const plaintext = Buffer.concat([
					decipher.update(Buffer.from(ciphertext, 'base64url')),
					decipher.final()
				]);
				const decoded = JSON_PARSE(plaintext.toString('utf8'));
				assertCacheableValue(decoded);
				return decoded;
			} catch (error) {
				if (error instanceof ActiveTsValidationError) throw error;
				throw new ActiveTsValidationError('Failed to decode AES-GCM cache codec payload.');
			}
		}
	};
}

function snapshotAesGcmJson(value: unknown, path = '$', seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (WEAKSET_HAS.call(seen, value)) {
		throw new ActiveTsValidationError(`AES-GCM cache codec value contains circular reference at "${path}".`);
	}
	WEAKSET_ADD.call(seen, value);
	try {
		if (Array.isArray(value)) {
			const next = new Array(value.length);
			Object.setPrototypeOf(next, null);
			for (let index = 0; index < value.length; index++) {
				next[index] = snapshotAesGcmJson(aesGcmJsonDataProperty(value, String(index), `${path}[${index}]`), `${path}[${index}]`, seen);
			}
			return next;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError(`AES-GCM cache codec value at "${path}" must be a plain object.`);
		}
		const next: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value)) {
			const propertyPath = `${path}.${key}`;
			defineDataProperty(next, key, snapshotAesGcmJson(aesGcmJsonDataProperty(value, key, propertyPath), propertyPath, seen), {
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

function aesGcmJsonDataProperty(value: object, key: string, path: string) {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`AES-GCM cache codec value at "${path}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`AES-GCM cache codec value at "${path}" must be enumerable.`);
	}
	return descriptor.value;
}

function normalizeAesGcmOptions(value: unknown): AesGcmCacheCodecOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError('AES-GCM cache codec options must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('AES-GCM cache codec options must be a plain object.');
	}
	const options = value as Record<string, unknown>;
	assertNoSymbolOptions(options, 'AES-GCM cache codec options');
	assertKnownOptions(options, AES_GCM_OPTION_KEYS, 'AES-GCM cache codec options');
	const key = ownOptionValue(options, 'key', 'AES-GCM cache codec options');
	const version = ownOptionValue(options, 'version', 'AES-GCM cache codec options');
	const aad = ownOptionValue(options, 'aad', 'AES-GCM cache codec options');
	const randomBytesOption = ownOptionValue(options, 'randomBytes', 'AES-GCM cache codec options');
	if (randomBytesOption !== undefined && typeof randomBytesOption !== 'function') {
		throw new ActiveTsValidationError('AES-GCM cache codec randomBytes must be a function.');
	}
	return {
		key: key as AesGcmCacheCodecOptions['key'],
		version: version as string | undefined,
		aad: aad as AesGcmCacheCodecOptions['aad'],
		randomBytes: randomBytesOption as AesGcmCacheCodecOptions['randomBytes']
	};
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

function ownOptionValue(record: Record<string, unknown>, key: string, context: string) {
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

function normalizePayloadVersion(version: unknown) {
	if (typeof version !== 'string') {
		throw new ActiveTsValidationError('AES-GCM cache codec payload version must be a string.');
	}
	if (!version || version.includes(':') || version.includes('\0')) {
		throw new ActiveTsValidationError('AES-GCM cache codec payload version is not allowed.');
	}
	return version;
}

function normalizeAesKey(key: unknown) {
	const bytes = normalizeBytes(key, 'AES-GCM cache codec key');
	if (bytes.length === 32) return bytes;
	throw new ActiveTsValidationError('AES-GCM cache codec key must be exactly 32 bytes.');
}

function normalizeBytes(value: unknown, context: string) {
	if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return Buffer.from(value);
	}
	throw new ActiveTsValidationError(`${context} must be a string or bytes.`);
}

function normalizeAesContextKey(context: unknown, label: string) {
	if (!context || typeof context !== 'object' || Array.isArray(context)) {
		throw new ActiveTsValidationError(`${label} must be an object with a cache key.`);
	}
	const key = ownOptionValue(context as Record<string, unknown>, 'key', label);
	return assertSafeCacheKey(key, `${label}.key`);
}

function aadForKey(key: string, aad: Buffer | undefined) {
	const keyBytes = Buffer.from(key, 'utf8');
	if (!aad) return keyBytes;
	return Buffer.concat([aad, Buffer.from([0]), keyBytes]);
}
