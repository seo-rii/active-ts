import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';

function clientFixture() {
	let active = 0, peak = 0, calls = 0;
	const values = new Map<string, number>();
	const client = {
		mGet: async (keys: string[]) => keys.map(() => null), mSet: async () => 'OK', del: async () => 0,
		multi: () => ({ set() { return this; }, exec: async () => [] }),
		async eval(script: string, options: { keys: string[] }) {
			calls++; active++; peak = Math.max(peak, active);
			const call = calls;
			await new Promise<void>(resolve => setImmediate(resolve));
			if (call % 2 === 1) await new Promise<void>(resolve => setImmediate(resolve));
			active--;
			return script.includes('return { value, version }') ? [JSON.stringify(values.get(options.keys[0]) ?? null), 'revision'] : 1;
		}
	};
	return { client, values, state: () => ({ active, peak, calls }), reset: () => { peak = 0; calls = 0; } };
}

test('Redis script operations respect configured concurrency and preserve result order', async () => {
	const fixture = clientFixture();
	const adapter = await createRedisValkeyCacheAdapter({ client: fixture.client, maxConcurrency: 2 });
	const keys = Array.from({ length: 9 }, (_, index) => `key-${index}`);
	keys.forEach((key, index) => fixture.values.set(adapter.codecKey!(key), index));
	const ordered = await adapter.getManyVersioned!(keys);
	assert.deepEqual(ordered.map(entry => entry.value), keys.map((_, index) => index));
	for (const operation of [
		() => adapter.getManyVersioned!(keys),
		() => adapter.setManyVersioned!(keys.map((key, index) => [key, index, 'revision'])),
		() => adapter.invalidateMany!(keys),
		() => adapter.setMany(keys.map((key, index) => [key, index])),
		() => adapter.deleteMany(keys)
	]) {
		fixture.reset();
		const result = await operation();
		assert.deepEqual(fixture.state(), { active: 0, peak: 2, calls: 9 });
		if (Array.isArray(result)) assert.equal(result.length, keys.length);
	}
});

test('a Redis batch waits for dispatched peers before rejecting and stops queued work', async () => {
	const fixture = clientFixture();
	let calls = 0, pendingPeer = true;
	fixture.client.eval = async () => {
		const index = calls++;
		if (index === 0) throw undefined;
		await new Promise<void>(resolve => setImmediate(resolve));
		pendingPeer = false;
		return 1;
	};
	const adapter = await createRedisValkeyCacheAdapter({ client: fixture.client, maxConcurrency: 2 });
	let rejected = false;
	try { await adapter.invalidateMany!(['a', 'b', 'c', 'd']); }
	catch (error) { rejected = true; assert.equal(error, undefined); }
	assert.equal(rejected, true);
	assert.equal(pendingPeer, false);
	assert.equal(calls, 2);
});

test('Redis maxConcurrency validates data properties before creating a client', async () => {
	for (const maxConcurrency of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(createRedisValkeyCacheAdapter({ maxConcurrency }), /positive safe integer/);
	}
	let read = false;
	await assert.rejects(createRedisValkeyCacheAdapter({ get maxConcurrency() { read = true; return 2; } }), /data property/);
	assert.equal(read, false);
});
