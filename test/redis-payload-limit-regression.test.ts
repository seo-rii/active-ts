import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';
import type { CacheCodec } from '../src/index.js';

function redisFixture(versioned = false) {
	const values = new Map<string, string | Buffer>();
	const writes: string[] = [];
	const client: Record<string, any> = {
		mGet: async (keys: string[]) => keys.map((key) => values.get(key) ?? null),
		mSet: async (entries: Record<string, string | Buffer>) => {
			writes.push('mSet');
			for (const [key, value] of Object.entries(entries)) values.set(key, value);
			return 'OK';
		},
		multi: () => {
			const pending: Array<[string, string | Buffer]> = [];
			return {
				set(key: string, value: string | Buffer) { pending.push([key, value]); return this; },
				exec: async () => {
					writes.push('exec');
					for (const [key, value] of pending) values.set(key, value);
					return pending.map(() => 'OK');
				}
			};
		},
		del: async () => 0
	};
	if (versioned) {
		client.eval = async (script: string, options: { keys: string[]; arguments: Array<string | Buffer> }) => {
			if (script.includes('return { value, version }')) return [values.get(options.keys[0]) ?? null, 'version-1'];
			writes.push('eval');
			const payloadIndex = script.includes('if version ~= ARGV[1]') ? 1 : 0;
			values.set(options.keys[0], options.arguments[payloadIndex]);
			return 1;
		};
	}
	return { client, values, writes };
}

test('Redis payload limit counts UTF-8 bytes and permits the exact JSON boundary', async () => {
	const fixture = redisFixture();
	const cache = await createRedisValkeyCacheAdapter({ client: fixture.client, maxPayloadBytes: 5 });
	await cache.setMany([['one', '한'], ['two', '한']]);
	assert.deepEqual(await cache.getMany(['one', 'two']), ['한', '한']);
	assert.equal(Buffer.byteLength(fixture.values.get(cache.codecKey!('one'))!), 5);
	await assert.rejects(cache.setMany([['too-large', '한글']]), /exceeds maxPayloadBytes \(5 bytes\)/);
	assert.deepEqual(fixture.writes, ['mSet']);
});

test('oversized reads are rejected before JSON parsing, while cache misses stay misses', async () => {
	const fixture = redisFixture();
	const cache = await createRedisValkeyCacheAdapter({ client: fixture.client, maxPayloadBytes: 4 });
	fixture.values.set(cache.codecKey!('bad'), 'not-json');
	await assert.rejects(cache.getMany(['bad']), /exceeds maxPayloadBytes/);
	fixture.values.set(cache.codecKey!('valid'), 'null');
	assert.deepEqual(await cache.getMany(['valid', 'missing']), [null, undefined]);
});

test('string and Buffer codec payloads are bounded before decoding or writing', async () => {
	for (const binary of [false, true]) {
		const fixture = redisFixture(true);
		let decodeCalls = 0;
		const codec: CacheCodec<string | Buffer> = {
			name: 'text',
			encode: (value) => binary ? Buffer.from(value) : value,
			decode: (value) => { decodeCalls++; return String(value); }
		};
		const cache = await createRedisValkeyCacheAdapter({ client: fixture.client, codec, maxPayloadBytes: 3 });
		await cache.setMany([['boundary', '한']]);
		assert.deepEqual(await cache.getMany(['boundary']), ['한']);
		assert.equal(decodeCalls, 1);
		const oversized = binary ? Buffer.from('한글') : '한글';
		fixture.values.set(cache.codecKey!('large'), oversized);
		await assert.rejects(cache.getMany(['large']), /exceeds maxPayloadBytes/);
		await assert.rejects(cache.getManyVersioned!(['large']), /exceeds maxPayloadBytes/);
		assert.equal(decodeCalls, 1);
		await assert.rejects(cache.setMany([['large', '한글']]), /exceeds maxPayloadBytes/);
		assert.deepEqual(fixture.writes, ['eval']);
	}
});

test('oversized entries reject an entire prepared write batch before backend mutations', async () => {
	for (const versioned of [false, true]) {
		for (const ttl of [undefined, 60]) {
			const fixture = redisFixture(versioned);
			const cache = await createRedisValkeyCacheAdapter({ client: fixture.client, maxPayloadBytes: 4 });
			await assert.rejects(cache.setMany([['small', 1], ['large', 'private data']], { ttl }), /exceeds maxPayloadBytes/);
			assert.deepEqual(fixture.writes, []);
			assert.equal(fixture.values.size, 0);
			if (versioned) {
				await assert.rejects(cache.setManyVersioned!([
					['small', 1, 'version-1'], ['large', 'private data', 'version-1']
				], { ttl }), /exceeds maxPayloadBytes/);
				assert.deepEqual(fixture.writes, []);
				assert.equal(fixture.values.size, 0);
			}
		}
	}
});

test('versioned codec failures cannot publish an earlier entry from the batch', async () => {
	const fixture = redisFixture(true);
	const failure = new Error('encoder unavailable');
	const cache = await createRedisValkeyCacheAdapter({ client: fixture.client, maxPayloadBytes: 4, codec: {
		name: 'fail-second',
		encode: (value) => { if (value === 'fail') throw failure; return String(value); },
		decode: (value) => String(value)
	} });
	await assert.rejects(cache.setManyVersioned!([
		['first', 'ok', 'version-1'], ['second', 'fail', 'version-1']
	]), (error) => error === failure);
	assert.deepEqual(fixture.writes, []);
	assert.equal(fixture.values.size, 0);
});

test('Buffer payload limits use the actual view size without invoking shadowed properties', async () => {
	const fixture = redisFixture();
	let getterCalls = 0;
	const buffer = Buffer.alloc(8);
	Object.defineProperty(buffer, 'byteLength', { get: () => { getterCalls++; return 1; } });
	const cache = await createRedisValkeyCacheAdapter({ client: fixture.client, maxPayloadBytes: 4, codec: {
		name: 'buffer-size',
		encode: () => buffer,
		decode: () => 'decoded'
	} });
	await assert.rejects(cache.setMany([['key', 1]]), /exceeds maxPayloadBytes/);
	fixture.values.set(cache.codecKey!('key'), buffer);
	await assert.rejects(cache.getMany(['key']), /exceeds maxPayloadBytes/);
	assert.equal(getterCalls, 0);
	assert.deepEqual(fixture.writes, []);
});

test('versioned writes retain CAS results and TTL behavior at the allowed boundary', async () => {
	const fixture = redisFixture(true);
	const cache = await createRedisValkeyCacheAdapter({ client: fixture.client, maxPayloadBytes: 5 });
	assert.deepEqual(await cache.setManyVersioned!([['one', '한', 'version-1']], { ttl: 30 }), [true]);
	assert.deepEqual(await cache.getManyVersioned!(['one']), [{ value: '한', version: 'version-1' }]);
	assert.deepEqual(fixture.writes, ['eval']);
});

test('payload budget is optional, snapshotted, and validated without invoking accessors', async () => {
	const fixture = redisFixture();
	const unbounded = await createRedisValkeyCacheAdapter({ client: fixture.client });
	await unbounded.setMany([['large', 'x'.repeat(1024)]]);
	assert.deepEqual(await unbounded.getMany(['large']), ['x'.repeat(1024)]);
	const options = { client: fixture.client, maxPayloadBytes: 4 };
	const bounded = await createRedisValkeyCacheAdapter(options);
	options.maxPayloadBytes = 1024;
	await assert.rejects(bounded.setMany([['large', 'xxxxx']]), /exceeds maxPayloadBytes/);
	for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
		await assert.rejects(createRedisValkeyCacheAdapter({ client: fixture.client, maxPayloadBytes: value as number }), /positive safe integer/);
	}
	let getterCalls = 0;
	const accessorOptions = Object.defineProperty({ client: fixture.client }, 'maxPayloadBytes', {
		enumerable: true,
		get: () => { getterCalls++; return 1; }
	});
	await assert.rejects(createRedisValkeyCacheAdapter(accessorOptions), /data property/);
	assert.equal(getterCalls, 0);
});
