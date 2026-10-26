import test from 'node:test';
import assert from 'node:assert/strict';
import { stableSortedCopy } from '../src/adapters/store/datastore-row-sort.js';

test('Datastore stable sort preserves equal-key order without mutating source rows', () => {
	const rows = [{ key: 2, name: 'a' }, { key: 1, name: 'b' }, { key: 2, name: 'c' }, { key: 1, name: 'd' }];
	const result = stableSortedCopy(rows, (left, right) => left.key - right.key);
	assert.deepEqual(result.map(row => row.name), ['b', 'd', 'a', 'c']);
	assert.deepEqual(rows.map(row => row.name), ['a', 'b', 'c', 'd']);
	assert.equal(result[0], rows[1]);
});

test('Datastore sort comparison count remains n log n on reverse-ordered rows', () => {
	const count = 4096;
	const rows = Array.from({ length: count }, (_, index) => count - index);
	let comparisons = 0;
	const result = stableSortedCopy(rows, (left, right) => { comparisons++; return left - right; });
	assert.deepEqual(result, Array.from({ length: count }, (_, index) => index + 1));
	assert.ok(comparisons <= count * Math.log2(count), `comparison count: ${comparisons}`);
});

test('Datastore sort does not depend on live array sorting or copying methods', () => {
	const originalSort = Array.prototype.sort;
	const originalSlice = Array.prototype.slice;
	let result: number[];
	try {
		Array.prototype.sort = () => { throw new Error('patched sort'); };
		Array.prototype.slice = () => { throw new Error('patched slice'); };
		result = stableSortedCopy([3, 1, 2], (left, right) => left - right);
	} finally { Array.prototype.sort = originalSort; Array.prototype.slice = originalSlice; }
	assert.deepEqual(result!, [1, 2, 3]);
});
