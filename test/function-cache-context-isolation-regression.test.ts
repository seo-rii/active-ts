import test from 'node:test';
import assert from 'node:assert/strict';
import {
	clearDefaultContext,
	createActiveTs,
	createFunctionCache,
	getCurrentDefaultContext,
	getDefaultContext,
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	setDefaultContext,
	type CacheAdapter
} from '../src/index.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function context(cache: CacheAdapter) {
	return createActiveTs({ stores: { default: new MemoryStoreAdapter() }, caches: { default: cache } });
}

function preserveDefault(t: { after: (cleanup: () => void) => void }) {
	const previous = getCurrentDefaultContext();
	t.after(() => previous ? setDefaultContext(previous) : clearDefaultContext());
}

test('one function cache follows independent default contexts for get and peek', async t => {
	preserveDefault(t);
	const firstCache = new MemoryCacheAdapter(), secondCache = new MemoryCacheAdapter();
	const first = context(firstCache), second = context(secondCache);
	let calls = 0;
	const lookup = createFunctionCache({ prefix: 'context-isolation-read', factory() {
		calls++;
		return getDefaultContext() === first ? 'first' : 'second';
	} });
	setDefaultContext(first);
	assert.equal(await lookup.get(1), 'first');
	setDefaultContext(second);
	assert.equal(await lookup.peek(1), undefined);
	assert.equal(await lookup.get(1), 'second');
	assert.equal(await lookup.peek(1), 'second');
	assert.equal(await lookup.get(1), 'second');
	setDefaultContext(first);
	assert.equal(await lookup.peek(1), 'first');
	assert.equal(await lookup.get(1), 'first');
	assert.equal(calls, 2);
	assert.deepEqual(Object.values(firstCache.snapshot()).map(entry => entry.value), ['first']);
	assert.deepEqual(Object.values(secondCache.snapshot()).map(entry => entry.value), ['second']);
});

test('root singleflight does not join factories from a different default context', async t => {
	preserveDefault(t);
	const firstCache = new MemoryCacheAdapter(), secondCache = new MemoryCacheAdapter();
	const first = context(firstCache), second = context(secondCache);
	const started = deferred(), release = deferred();
	let calls = 0;
	const lookup = createFunctionCache({ prefix: 'context-isolation-flight', async factory() {
		calls++;
		const value = getDefaultContext() === first ? 'first' : 'second';
		if (value === 'first') { started.resolve(); await release.promise; }
		return value;
	} });
	setDefaultContext(first);
	const firstRead = lookup.get(1);
	await started.promise;
	setDefaultContext(second);
	const secondRead = lookup.get(1);
	await new Promise<void>(done => setImmediate(done));
	release.resolve();
	assert.deepEqual(await Promise.all([firstRead, secondRead]), ['first', 'second']);
	assert.equal(calls, 2);
	assert.deepEqual(Object.values(firstCache.snapshot()).map(entry => entry.value), ['first']);
	assert.deepEqual(Object.values(secondCache.snapshot()).map(entry => entry.value), ['second']);
});

test('a delayed persistent hit stays attached to its initiating cache and memory scope', async t => {
	preserveDefault(t);
	const remote = new MemoryCacheAdapter(), secondCache = new MemoryCacheAdapter();
	const started = deferred(), release = deferred();
	let block = false;
	const first = context({ kind: 'context-delayed-cache',
		async getMany(keys) {
			const values = await remote.getMany(keys);
			if (block) { block = false; started.resolve(); await release.promise; }
			return values;
		}, setMany: (...args) => remote.setMany(...args), deleteMany: (...args) => remote.deleteMany(...args)
	});
	const second = context(secondCache);
	const lookup = createFunctionCache({ prefix: 'context-isolation-persistent-hit', factory: () => 'unexpected' });
	setDefaultContext(first); await lookup.set(1, 'first');
	setDefaultContext(second); await lookup.set(1, 'second');
	lookup.clearMemory();
	setDefaultContext(first); block = true;
	const firstRead = lookup.get(1);
	await started.promise;
	setDefaultContext(second);
	const secondRead = lookup.get(1);
	await new Promise<void>(done => setImmediate(done));
	release.resolve();
	assert.equal(await secondRead, 'second');
	assert.equal(await firstRead, 'first');
	assert.equal(await lookup.get(1), 'second');
	assert.equal(lookup.stats.misses, 0);
});

for (const operation of ['set', 'invalidate'] as const) {
	test(`${operation} captures its cache before asynchronous key resolution`, async t => {
		preserveDefault(t);
		const firstCache = new MemoryCacheAdapter(), secondCache = new MemoryCacheAdapter();
		const first = context(firstCache), second = context(secondCache);
		const started = deferred(), release = deferred();
		let block = false;
		const lookup = createFunctionCache({ prefix: `context-isolation-${operation}`, memory: false,
			async key() { if (block) { block = false; started.resolve(); await release.promise; } return 'one'; },
			factory: () => 'unexpected'
		});
		setDefaultContext(first); await lookup.set(1, 'first');
		setDefaultContext(second); await lookup.set(1, 'second');
		setDefaultContext(first); block = true;
		const pending = operation === 'set' ? lookup.set(1, 'updated-first') : lookup.invalidate(1);
		await started.promise;
		setDefaultContext(second); release.resolve(); await pending;
		assert.equal(await lookup.peek(1), 'second');
		setDefaultContext(first);
		assert.equal(await lookup.peek(1), operation === 'set' ? 'updated-first' : undefined);
	});
}

test('a standalone direct-adapter cache is independent of unrelated default context changes', async t => {
	preserveDefault(t);
	const cache = new MemoryCacheAdapter();
	let calls = 0;
	const lookup = createFunctionCache({ prefix: 'context-isolation-direct-control', cache, factory: () => ++calls });
	setDefaultContext(context(new MemoryCacheAdapter()));
	assert.equal(await lookup.get(1), 1);
	setDefaultContext(context(new MemoryCacheAdapter()));
	assert.equal(await lookup.get(1), 1);
	assert.equal(calls, 1);
});

test('key validation still precedes missing runtime errors for every cache operation', async t => {
	preserveDefault(t);
	clearDefaultContext();
	const lookup = createFunctionCache({ prefix: 'context-isolation-invalid-key',
		key: (() => 1) as any, factory: () => 'unused' });
	for (const run of [() => lookup.get(1), () => lookup.peek(1), () => lookup.set(1, 'value'), () => lookup.invalidate(1)]) {
		await assert.rejects(run(), /key resolver must return a string/);
	}
});

test('a stale background refresh publishes to its initiating context after the default changes', async t => {
	preserveDefault(t);
	const originalNow = Date.now;
	let now = 1_800_000_000_000;
	Date.now = () => now;
	t.after(() => { Date.now = originalNow; });
	const firstCache = new MemoryCacheAdapter(), secondCache = new MemoryCacheAdapter();
	const first = context(firstCache), second = context(secondCache);
	const started = deferred(), release = deferred();
	t.after(() => release.resolve());
	let firstCalls = 0;
	const lookup = createFunctionCache({ prefix: 'context-isolation-stale-refresh', ttl: 1, staleWhileRevalidate: 30,
		async factory() {
			if (getDefaultContext() !== first) return 'second';
			if (++firstCalls === 1) return 'first-old';
			started.resolve(); await release.promise;
			return 'first-fresh';
		}
	});
	setDefaultContext(first); assert.equal(await lookup.get(1), 'first-old');
	now += 1_500;
	assert.equal(await lookup.get(1), 'first-old');
	await started.promise;
	setDefaultContext(second); assert.equal(await lookup.get(1), 'second');
	release.resolve();
	await new Promise<void>(done => setImmediate(done));
	assert.deepEqual(Object.values(firstCache.snapshot()).map(entry => entry.value), ['first-fresh']);
	assert.deepEqual(Object.values(secondCache.snapshot()).map(entry => entry.value), ['second']);
	assert.equal(await lookup.get(1), 'second');
});
