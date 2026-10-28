import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';

test('Redis rejects lossy keys and prefixes before transport, preserving valid encodings', async () => {
	const values = new Map<string, string>();
	let calls = 0;
	const client = {
		async mGet(keys: string[]) { calls++; return keys.map(key => values.get(key) ?? null); },
		async mSet(entries: Record<string, string>) { calls++; for (const [key, value] of Object.entries(entries)) values.set(key, value); return 'OK'; },
		multi() { calls++; throw new Error('unexpected multi'); },
		async del() { calls++; return 0; }
	};
	for (const prefix of ['\ud800', '\ud801', '\udc00']) {
		await assert.rejects(createRedisValkeyCacheAdapter({ client, prefix }), /unpaired UTF-16/);
	}
	const cache = await createRedisValkeyCacheAdapter({ client });
	for (const key of ['\ud800', '\ud801', '\udc00']) {
		await assert.rejects(cache.setMany([['valid', 'keep'], [key, 'bad']]), /unpaired UTF-16/);
		await assert.rejects(cache.deleteMany(['valid', key]), /unpaired UTF-16/);
		await assert.rejects(cache.getMany(['valid', key]), /unpaired UTF-16/);
	}
	assert.equal(calls, 0);
	await cache.setMany([['😀', 'emoji'], ['\ufffd', 'replacement']]);
	assert.deepEqual(await cache.getMany(['😀', '\ufffd']), ['emoji', 'replacement']);
	assert.ok(values.has(`active-ts::${Buffer.from('😀', 'utf8').toString('base64url')}`));
});
