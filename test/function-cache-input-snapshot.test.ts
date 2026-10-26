import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionCache } from '../src/index.js';

test('function cache keys and factory use the input captured when get starts', async () => {
	let calls = 0;
	const cache = createFunctionCache({
		prefix: 'input-snapshot-default', cache: false,
		factory: async (input: { nested: { id: number }; date: Date }) => {
			calls++;
			return { id: input.nested.id, year: input.date.getUTCFullYear() };
		}
	});
	const input = { nested: { id: 1 }, date: new Date('2026-01-01T00:00:00.000Z') };
	const pending = cache.get(input);
	input.nested.id = 2;
	input.date.setUTCFullYear(2030);
	assert.deepEqual(await pending, { id: 1, year: 2026 });
	assert.deepEqual(await cache.get({ nested: { id: 1 }, date: new Date('2026-01-01T00:00:00.000Z') }), { id: 1, year: 2026 });
	assert.equal(calls, 1);
});

test('async key and namespace resolvers see the same captured input as the factory', async () => {
	const seen: number[] = [];
	const cache = createFunctionCache({
		prefix: 'input-snapshot-custom', cache: false,
		key: async (input: { id: number }) => { await Promise.resolve(); seen.push(input.id); return String(input.id); },
		namespace: async (input) => { await Promise.resolve(); seen.push(input.id); return `tenant-${input.id}`; },
		factory: async (input) => { seen.push(input.id); return input.id; }
	});
	const input = { id: 1 };
	const pending = cache.get(input);
	input.id = 2;
	assert.equal(await pending, 1);
	assert.deepEqual(seen, [1, 1, 1]);
});

test('custom key inputs retain opaque object methods and default keys reject accessors without reading them', async () => {
	class Opaque { id() { return 7; } }
	const opaque = new Opaque();
	const cache = createFunctionCache({ prefix: 'input-snapshot-opaque', cache: false, key: (input: Opaque) => String(input.id()), factory: (input) => input.id() });
	assert.equal(await cache.get(opaque), 7);
	let getterCalls = 0;
	const guarded = createFunctionCache({ prefix: 'input-snapshot-accessor', cache: false, factory: async (_input: object) => 'unused' });
	await assert.rejects(guarded.get({ get id() { getterCalls++; return 1; } }), /JSON-like inputs/);
	assert.equal(getterCalls, 0);
});

test('plain input snapshots use captured WeakMap methods', async () => {
	const get = WeakMap.prototype.get, set = WeakMap.prototype.set;
	const cache = createFunctionCache({ prefix: 'input-snapshot-intrinsics', cache: false, factory: (input: { id: number }) => input.id });
	WeakMap.prototype.get = function () { throw new Error('patched get'); };
	WeakMap.prototype.set = function () { throw new Error('patched set'); };
	try { assert.equal(await cache.get({ id: 1 }), 1); }
	finally { WeakMap.prototype.get = get; WeakMap.prototype.set = set; }
});
