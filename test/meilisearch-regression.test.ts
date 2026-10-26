import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeilisearchSearchAdapter } from '../src/adapters/search/meilisearch.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from '../src/core/errors.js';
import type { ResolvedModelMeta } from '../src/core/types.js';
import { datastoreKey } from '../src/core/datastore-key.js';
import { searchDocumentIdentity, searchHitDocumentIdentity } from '../src/core/search-utils.js';

function metadata(overrides: Partial<ResolvedModelMeta> = {}): ResolvedModelMeta {
	return { model: class {}, name: 'meili_record', store: 'memory', search: 'meilisearch', idField: 'slug',
		readValidation: 'off', indexes: [], searchIndexes: [{ name: 'text', fields: ['title', 'profile.city'] }],
		relations: new Map(), hooks: {}, views: new Map(), policies: new Map(), scopes: new Map(),
		fieldCodecs: new Map(), fieldTypes: new Map(), ...overrides };
}

function fake() {
	const docs = new Map<string, any>();
	const requests: { operation: string; value: any }[] = [];
	let taskId = 0;
	let finish: ((task: any) => any | Promise<any>) = (task) => ({ ...task, status: 'succeeded' });
	let transform: ((response: any) => any) = (response) => response;
	let info: any = { uid: 'meili_record', primaryKey: 'active_ts_id' };
	const task = (indexUid: string, action: () => void) => {
		const uid = taskId++;
		const promise = Promise.resolve({ taskUid: uid, indexUid, status: 'enqueued' });
		Object.defineProperty(promise, 'waitTask', { value: async (options: any) => {
			requests.push({ operation: 'wait', value: options });
			const result = await finish({ uid, indexUid, status: 'succeeded', error: null });
			if (result.status === 'succeeded') action();
			return result;
		} });
		return promise;
	};
	const client = {
		async getRawIndex(name: string) { requests.push({ operation: 'info', value: name }); return { ...info }; },
		index(name: string) { return {
			addDocuments(values: any[], options: any) {
				const copy = JSON.parse(JSON.stringify(values));
				requests.push({ operation: 'index', value: { documents: copy, options } });
				return task(name, () => { for (const row of copy) docs.set(row.active_ts_id, row); });
			},
			deleteDocument(id: string) { requests.push({ operation: 'delete', value: id }); return task(name, () => { docs.delete(id); }); },
			async search(query: string, options: any) {
				requests.push({ operation: 'search', value: { query, options } });
				const rows = [...docs.values()].filter((row) => !query || row.title?.includes(query));
				const start = (options.page - 1) * options.hitsPerPage;
				return transform({ hits: JSON.parse(JSON.stringify(rows.slice(start, start + options.hitsPerPage))),
					page: options.page, hitsPerPage: options.hitsPerPage, totalPages: options.hitsPerPage ? Math.ceil(rows.length / options.hitsPerPage) : 0,
					totalHits: rows.length });
			}
		}; }
	};
	return { client, docs, requests, setFinish: (value: typeof finish) => { finish = value; },
		setResponse: (value: typeof transform) => { transform = value; }, setInfo: (value: any) => { info = value; } };
}

test('Meilisearch preserves typed/custom IDs, projects nested fields and replaces removed fields', async () => {
	const fixture = fake(); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client }); const model = metadata();
	await adapter.index(model, 1, { slug: 1, title: 'shared first', private: 'hidden', profile: { city: 'Seoul', private: 'hidden' } });
	await adapter.index(model, '1', { slug: '1', title: 'shared second' });
	assert.equal(fixture.docs.size, 2);
	for (const key of fixture.docs.keys()) assert.match(key, /^[A-Za-z0-9_-]+$/);
	const rows = await adapter.search(model, 'shared', {});
	assert.deepEqual(rows.list, [{ slug: 1, title: 'shared first', profile: { city: 'Seoul' } }, { slug: '1', title: 'shared second' }]);
	assert.equal(rows.total, undefined);
	assert.equal(searchHitDocumentIdentity(rows.list[0]), 'number:1');
	await adapter.index(model, 1, { slug: 1, title: 'replacement' });
	assert.deepEqual((await adapter.search(model, 'replacement', {})).list, [{ slug: 1, title: 'replacement' }]);
	await adapter.delete(model, '1'); await adapter.delete(model, 'absent');
	assert.equal(fixture.docs.size, 1);
});

for (const [name, prototype] of [['Array', Array.prototype], ['Object', Object.prototype]] as const) {
	test(`Meilisearch keeps typed document identities stable with inherited ${name}.toJSON`, async () => {
		const fixture = fake(); const originalIndex = fixture.client.index;
		fixture.client.index = (indexName) => ({ ...originalIndex(indexName), search: async (_query, options) => {
			JSON.stringify(options);
			// The real server serializes outside the application's patched prototypes.
			return { hits: structuredClone([...fixture.docs.values()]), page: options.page,
				hitsPerPage: options.hitsPerPage, totalPages: fixture.docs.size ? 1 : 0, totalHits: fixture.docs.size };
		} });
		const adapter = await createMeilisearchSearchAdapter({ client: fixture.client }); const model = metadata();
		await adapter.index(model, 1, { slug: 1, title: 'shared original' });
		const originalKey = [...fixture.docs.keys()][0];
		const previous = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
		let calls = 0;
		Object.defineProperty(prototype, 'toJSON', { configurable: true, value() {
			calls++;
			return ['forced_model', 'forced_identity'];
		} });
		try {
			await adapter.index(model, 1, { slug: 1, title: 'shared replacement' });
			await adapter.index(model, '1', { slug: '1', title: 'shared string' });
			assert.equal(fixture.docs.size, 2);
			assert.equal(fixture.docs.get(originalKey).title, 'shared replacement');
			const result = await adapter.search(model, 'shared', {});
			assert.deepEqual(result.list, [{ slug: 1, title: 'shared replacement' }, { slug: '1', title: 'shared string' }]);
			assert.deepEqual(result.list.map(searchHitDocumentIdentity), ['number:1', 'string:1']);
			await adapter.delete(model, 1);
			assert.equal(fixture.docs.has(originalKey), false);
			assert.deepEqual((await adapter.search(model, 'shared', {})).list, [{ slug: '1', title: 'shared string' }]);
			await adapter.delete(model, '1');
			assert.equal(fixture.docs.size, 0);
		} finally {
			if (previous) Object.defineProperty(prototype, 'toJSON', previous);
			else Reflect.deleteProperty(prototype, 'toJSON');
		}
		assert.equal(calls, 0);
	});
}

test('Meilisearch awaits successful matched task completion instead of accepting the queue acknowledgement', async () => {
	const fixture = fake(); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client, taskTimeoutMs: 321, taskIntervalMs: 7 });
	let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	fixture.setFinish(async (task) => { await gate; return task; });
	let settled = false; const pending = adapter.index(metadata(), 1, { slug: 1, title: 'queued' }).then(() => { settled = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false); assert.equal(fixture.docs.size, 0); release(); await pending;
	assert.equal(fixture.docs.size, 1);
	assert.deepEqual(fixture.requests.find((entry) => entry.operation === 'wait')!.value, { timeout: 321, interval: 7 });
});

test('Meilisearch rejects failed, canceled, pending, mismatched and errored task results for both operations', async () => {
	for (const mutate of [
		(task: any) => ({ ...task, status: 'failed', error: { code: 'invalid_document_id', message: 'bad document' } }),
		(task: any) => ({ ...task, status: 'canceled' }),
		(task: any) => ({ ...task, status: 'processing' }),
		(task: any) => ({ ...task, uid: task.uid + 1 }),
		(task: any) => ({ ...task, indexUid: 'wrong_index' }),
		(task: any) => ({ ...task, error: { code: 'unexpected' } })
	]) {
		const fixture = fake(); fixture.setFinish(mutate); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
		await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1, title: 'x' }));
		await assert.rejects(() => adapter.delete(metadata(), 1));
	}
	const fixture = fake(); const timeout = new Error('task timeout'); fixture.setFinish(() => { throw timeout; });
	const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
	await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1 }), (error) => error === timeout);
});

test('Meilisearch checks primary-key ownership before mutations', async () => {
	for (const info of [{ uid: 'meili_record', primaryKey: 'slug' }, { uid: 'wrong', primaryKey: 'active_ts_id' }, { uid: 'meili_record', primaryKey: null }]) {
		const fixture = fake(); fixture.setInfo(info); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
		await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1 }), /primary|index/i);
		await assert.rejects(() => adapter.delete(metadata(), 1), /primary|index/i);
		assert.equal(fixture.requests.some((entry) => entry.operation !== 'info'), false);
	}
});

test('Meilisearch searches with search-only credentials while retaining hit and write validation', async () => {
	const fixture = fake(); const model = metadata();
	const writer = await createMeilisearchSearchAdapter({ client: fixture.client });
	await writer.index(model, 1, { slug: 1, title: 'shared number' });
	await writer.index(model, '1', { slug: '1', title: 'shared string' });
	fixture.requests.length = 0;
	const forbidden = Object.assign(new Error('The API key lacks indexes.get permission.'), { code: 'invalid_api_key', status: 403 });
	fixture.client.getRawIndex = async (name) => {
		fixture.requests.push({ operation: 'info', value: name });
		throw forbidden;
	};
	const reader = await createMeilisearchSearchAdapter({ client: fixture.client });
	const result = await reader.search(model, 'shared', {});
	assert.deepEqual(result.list, [{ slug: 1, title: 'shared number' }, { slug: '1', title: 'shared string' }]);
	assert.equal(fixture.requests.some((entry) => entry.operation === 'info'), false);
	fixture.setResponse((response) => ({ ...response, hits: [{ ...response.hits[0], slug: '1' }] }));
	await assert.rejects(() => reader.search(model, 'shared', {}), ActiveTsValidationError);
	assert.equal(fixture.requests.some((entry) => entry.operation === 'info'), false);
	await assert.rejects(() => reader.index(model, 2, { slug: 2, title: 'forbidden' }), (error) => error === forbidden);
	await assert.rejects(() => reader.delete(model, 1), (error) => error === forbidden);
	assert.equal(fixture.requests.some((entry) => entry.operation === 'index' || entry.operation === 'delete'), false);
});

test('Meilisearch owns query, fields and pagination while forwarding native filter parameters', async () => {
	const fixture = fake(); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client }); const model = metadata();
	await adapter.index(model, 1, { slug: 1, title: 'shared one' }); await adapter.index(model, 2, { slug: 2, title: 'shared two' });
	const first = await adapter.search(model, 'shared', { limit: 1, native: { filter: 'score > 1' } });
	assert.equal(first.more, true); assert.ok(first.cursor);
	const second = await adapter.search(model, 'shared', { limit: 1, cursor: first.cursor, native: { filter: 'score > 1' } });
	assert.deepEqual(second.list.map((row) => row.slug), [2]); assert.equal(second.more, false);
	const request = fixture.requests.filter((entry) => entry.operation === 'search')[0].value;
	assert.deepEqual(JSON.parse(JSON.stringify(request.options.attributesToRetrieve)), ['active_ts_id', 'slug', 'title', 'profile.city']);
	assert.deepEqual(JSON.parse(JSON.stringify(request.options.attributesToSearchOn)), ['title', 'profile.city']);
	assert.equal(request.options.filter, 'score > 1');
	for (const key of ['q', 'limit', 'offset', 'page', 'hitsPerPage', 'attributesToSearchOn', 'attributesToRetrieve']) {
		await assert.rejects(() => adapter.search(model, 'shared', { native: { [key]: 1 } }), /native/i);
	}
	for (const cursor of ['', '-1', '0', '01', '1.5', '9007199254740992']) await assert.rejects(() => adapter.search(model, 'shared', { cursor }));
	await assert.rejects(() => adapter.search(model, 'shared', { limit: 0 }), /limit/i);
});

test('Meilisearch rejects forged hit identities and malformed pagination', async () => {
	for (const transform of [
		(response: any) => ({ ...response, page: 99 }),
		(response: any) => ({ ...response, totalPages: -1 }),
		(response: any) => ({ ...response, hitsPerPage: 99 }),
		(response: any) => ({ ...response, hits: [response.hits[0], response.hits[0]] }),
		(response: any) => ({ ...response, hits: [{ ...response.hits[0], slug: '1' }] }),
		(response: any) => ({ ...response, hits: [{ ...response.hits[0], active_ts_id: 'not-canonical' }] }),
		(response: any) => ({ ...response, hits: [{ ...response.hits[0], active_ts_id: Buffer.from(JSON.stringify(['other', 'number:1'])).toString('base64url') }] })
	]) {
		const fixture = fake(); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
		await adapter.index(metadata(), 1, { slug: 1, title: 'shared' }); fixture.setResponse(transform);
		await assert.rejects(() => adapter.search(metadata(), 'shared', {}), ActiveTsValidationError);
	}
});

test('Meilisearch forbids reserved fields, portable filters and revision fences before side effects', async () => {
	const fixture = fake(); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client }); const model = metadata();
	assert.equal(adapter.capabilities?.revisionWrites, false);
	await assert.rejects(() => adapter.index(model, 1, { slug: 1 }, { revision: 1 }), /revision/i);
	await assert.rejects(() => adapter.delete(model, 1, { revision: 1 }), /revision/i);
	await assert.rejects(() => adapter.search(model, 'x', { where: { title: 'x' } }), /where/i);
	for (const field of ['active_ts_id', 'active_ts_id.child', '_formatted.title', '_geo']) {
		const invalid = metadata({ searchIndexes: [{ name: 'invalid', fields: [field] }] });
		await assert.rejects(() => adapter.index(invalid, 1, { slug: 1 }), /reserved/i);
	}
	assert.equal(fixture.requests.length, 0);
});

test('Meilisearch snapshots write payloads before asynchronous metadata lookup', async () => {
	const fixture = fake(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	const original = fixture.client.getRawIndex;
	fixture.client.getRawIndex = async (name) => { await gate; return original(name); };
	const adapter = await createMeilisearchSearchAdapter({ client: fixture.client }); const model = metadata();
	const data = { slug: 1, title: 'before', profile: { city: 'before' } };
	const pending = adapter.index(model, 1, data); data.title = 'after'; data.profile.city = 'after'; model.name = 'changed'; release(); await pending;
	const stored = [...fixture.docs.values()][0]; assert.equal(stored.title, 'before'); assert.equal(stored.profile.city, 'before');
});

test('Meilisearch avoids Unicode ID collisions and validates ancestor identity on reads/deletes', async () => {
	const fixture = fake(); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
	for (const id of ['\ud800', '\ud801', '\ufffd', '한글/문서']) await adapter.index(metadata(), id, { slug: id, title: 'shared' });
	assert.equal(fixture.docs.size, 4);
	const model = metadata({ datastore: { ancestorFields: ['parentId'], ancestor: ({ data }) => data ? datastoreKey('parent', data.parentId) : undefined } });
	await adapter.index(model, 1, { slug: 1, title: 'ancestor', parentId: 10 });
	await adapter.index(model, 1, { slug: 1, title: 'ancestor', parentId: 20 });
	const result = await adapter.search(model, 'ancestor', {});
	assert.equal(result.list.length, 2);
	assert.notEqual(searchHitDocumentIdentity(result.list[0]), searchHitDocumentIdentity(result.list[1]));
	const identity = searchDocumentIdentity(model, 1, 'test', { slug: 1, parentId: 10 });
	await adapter.delete({ ...model, searchDocumentIdentity: identity }, 1);
	assert.equal((await adapter.search(model, 'ancestor', {})).list.length, 1);
});

test('Meilisearch manual schema is side-effect free and validates options without getters', async () => {
	const fixture = fake(); const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
	const plan = await adapter.schema!.apply([metadata()], { mode: 'safe' }); assert.equal(plan.status, 'manual'); assert.equal(plan.changes.length, 1);
	assert.deepEqual(await adapter.syncSchema!([metadata()]), plan); assert.equal(fixture.requests.length, 0);
	for (const options of [{ client: null }, { client: fixture.client, host: 'http://localhost' }, { host: 'bad' }, { client: fixture.client, taskTimeoutMs: 0 },
		{ client: fixture.client, taskIntervalMs: -1 }, { client: fixture.client, taskIntervalMs: 20, taskTimeoutMs: 10 },
		{ client: fixture.client, indexPrefix: '../' }, { client: fixture.client, extra: true }]) {
		await assert.rejects(() => createMeilisearchSearchAdapter(options as any));
	}
	let reads = 0;
	await assert.rejects(() => createMeilisearchSearchAdapter(Object.defineProperty({}, 'client', { enumerable: true, get() { reads++; return fixture.client; } })), ActiveTsConfigurationError);
	await assert.rejects(() => createMeilisearchSearchAdapter({ client: Object.defineProperty({}, 'index', { enumerable: true, get() { reads++; return fixture.client.index; } }) }), ActiveTsConfigurationError);
	assert.equal(reads, 0);
});

test('Meilisearch refuses malformed acknowledgements and accessor-based task waiters', async () => {
	for (const queued of [{ taskUid: -1, indexUid: 'meili_record' }, { taskUid: 1, indexUid: 'wrong' }, { indexUid: 'meili_record' }]) {
		const fixture = fake(); const originalIndex = fixture.client.index;
		fixture.client.index = (name) => ({ ...originalIndex(name), addDocuments: () => {
			const pending = Promise.resolve(queued);
			Object.defineProperty(pending, 'waitTask', { value: async () => { throw new Error('must not wait'); } });
			return pending as any;
		} });
		const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
		await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1 }), ActiveTsValidationError);
	}
	const fixture = fake(); const originalIndex = fixture.client.index; let reads = 0;
	fixture.client.index = (name) => ({ ...originalIndex(name), addDocuments: () => {
		const pending = Promise.resolve({ taskUid: 1, indexUid: name });
		Object.defineProperty(pending, 'waitTask', { get() { reads++; return () => Promise.resolve({ uid: 1, indexUid: name, status: 'succeeded' }); } });
		return pending as any;
	} });
	const adapter = await createMeilisearchSearchAdapter({ client: fixture.client });
	await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1 }), ActiveTsConfigurationError);
	assert.equal(reads, 0);
});
