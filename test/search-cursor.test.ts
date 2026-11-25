import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCursorFingerprint, searchCursorForPage, searchPageFromCursor } from '../src/core/search-cursor.js';

test('cursor fingerprints ignore object insertion order and retain array/filter semantics', () => {
	const first = searchCursorFingerprint({ query: 'hello', filter: { a: 1, b: [2, 3] } });
	assert.equal(first, searchCursorFingerprint({ filter: { b: [2, 3], a: 1 }, query: 'hello' }));
	assert.notEqual(first, searchCursorFingerprint({ query: 'hello', filter: { a: 1, b: [3, 2] } }));
	assert.notEqual(first, searchCursorFingerprint({ query: 'other', filter: { a: 1, b: [2, 3] } }));
});

test('shared page cursors preserve existing formats and reject cross-adapter reuse', () => {
	const fingerprint = 'same-request';
	for (const kind of ['algolia', 'meilisearch'] as const) {
		const old = Buffer.from(JSON.stringify({ v: 1, kind, page: 2, fingerprint })).toString('base64url');
		assert.equal(searchCursorForPage(2, fingerprint, kind), old);
		assert.equal(searchPageFromCursor(old, fingerprint, kind), 2);
		assert.throws(() => searchPageFromCursor(old, fingerprint, kind === 'algolia' ? 'meilisearch' : 'algolia'), /different search/);
		assert.throws(() => searchPageFromCursor(old, 'other-request', kind), /different search/);
		assert.throws(() => searchPageFromCursor('2', fingerprint, kind), /invalid/);
	}
	assert.equal(searchPageFromCursor(undefined, fingerprint, 'algolia'), undefined);
	assert.equal(searchPageFromCursor(searchCursorForPage(0, fingerprint, 'algolia'), fingerprint, 'algolia'), 0);
	assert.throws(() => searchPageFromCursor(searchCursorForPage(0, fingerprint, 'meilisearch'), fingerprint, 'meilisearch'), /invalid/);
});

test('cursor encoding does not invoke inherited serialization hooks', () => {
	const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
	let calls = 0;
	Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: () => { calls++; throw new Error('unexpected hook'); } });
	try {
		const cursor = searchCursorForPage(2, 'request', 'algolia');
		assert.equal(searchPageFromCursor(cursor, 'request', 'algolia'), 2);
		assert.equal(calls, 0);
	} finally {
		if (descriptor) Object.defineProperty(Object.prototype, 'toJSON', descriptor);
		else delete (Object.prototype as any).toJSON;
	}
});
