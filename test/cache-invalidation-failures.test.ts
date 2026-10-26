import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheInvalidationFailures } from '../src/core/cache-invalidation-failures.js';

test('failure overflow preserves protection and source isolation', () => {
	const failures = new CacheInvalidationFailures(2);
	const source = {}, other = {};
	failures.mark(source, 'a');
	failures.mark(source, 'b');
	assert.equal(failures.has(source, 'fresh'), false);
	failures.mark(source, 'c');
	for (const key of ['a', 'b', 'c', 'fresh']) assert.equal(failures.has(source, key), true);
	assert.equal(failures.has(other, 'a'), false);
	failures.clear(source, 'a');
	assert.equal(failures.has(source, 'a'), false);
	assert.equal(failures.has(source, 'b'), true);
});

test('recovery eviction and later overflow fail closed', () => {
	const failures = new CacheInvalidationFailures(2);
	const source = {};
	for (const key of ['a', 'b', 'c']) failures.mark(source, key);
	for (const key of ['a', 'b', 'c']) failures.clear(source, key);
	assert.equal(failures.has(source, 'a'), true);
	assert.equal(failures.has(source, 'b'), false);
	assert.equal(failures.has(source, 'c'), false);
	failures.mark(source, 'b');
	assert.equal(failures.has(source, 'b'), true);
	for (const key of ['d', 'e']) failures.mark(source, key);
	assert.equal(failures.has(source, 'c'), true);
});

test('ordinary successful recovery removes only its failed key', () => {
	const failures = new CacheInvalidationFailures(2);
	const source = {};
	failures.mark(source, 'a');
	failures.mark(source, 'b');
	failures.clear(source, 'a');
	assert.equal(failures.has(source, 'a'), false);
	assert.equal(failures.has(source, 'b'), true);
	failures.clear(source, 'b');
	assert.equal(failures.has(source, 'b'), false);
});
