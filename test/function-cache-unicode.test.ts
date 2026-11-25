import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionCache } from '../src/core/function-cache.js';

test('function cache rejects lossy default and custom keys before computing or changing entries', async () => {
	for (const key of [undefined, (input: string) => input]) {
		let calls = 0;
		const cache = createFunctionCache({ prefix: key ? 'custom_unicode' : 'default_unicode', cache: false,
			key, factory: (input: string) => { calls++; return input; } });
		for (const input of ['\ud800', '\ud801', '\udc00', 'x\ud800y']) {
			await assert.rejects(cache.get(input), /unpaired UTF-16/);
			await assert.rejects(cache.set(input, 'bad'), /unpaired UTF-16/);
			await assert.rejects(cache.invalidate(input), /unpaired UTF-16/);
		}
		assert.equal(calls, 0);
		for (const input of ['\ufffd', '한글', '😀', '\\ud800']) assert.equal(await cache.get(input), input);
		assert.equal(calls, 4);
	}
});

test('function cache rejects unpaired surrogates in default object keys and values', async () => {
	const cache = createFunctionCache({ prefix: 'object_unicode', cache: false, factory: (input: object) => input });
	await assert.rejects(cache.get({ ['\ud800']: 'value' }), /unpaired UTF-16/);
	await assert.rejects(cache.get({ nested: ['\udc00'] }), /unpaired UTF-16/);
});
