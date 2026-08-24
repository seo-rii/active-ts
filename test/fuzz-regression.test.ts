import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	createOutboxPlugin,
	defineModel
} from '../src/index.js';
import { entityIdFromCanonicalKey, entityIdFromKey, entityIdKey } from '../src/core/query-utils.js';

type FuzzQueryData = {
	id: number;
	tenantId: 'tenant-a' | 'tenant-b';
	score: number;
	title: string;
	tags: string[];
	profile: {
		city: string;
		tier: number;
	};
	active: boolean;
};

class FuzzQueryRecord extends Model<FuzzQueryData> {}

defineModel<FuzzQueryData>('fuzz_query_record')
	.id('id')
	.validate((input) => input as FuzzQueryData)
	.scope('tenant', ({ viewer }) => ({ tenantId: (viewer as { tenantId: string }).tenantId }))
	.attach(FuzzQueryRecord);

type FuzzGuardData = {
	id: number;
	value: string;
	nested?: Record<string, unknown>;
};

type FuzzIdData = {
	id: string | number;
	label: string;
};

class FuzzGuardRecord extends Model<FuzzGuardData> {}
class FuzzIdRecord extends Model<FuzzIdData> {}

defineModel<FuzzGuardData>('fuzz_guard_record')
	.id('id')
	.validate((input) => input as FuzzGuardData)
	.attach(FuzzGuardRecord);

defineModel<FuzzIdData>({ name: 'fuzz_id_record', cache: { ttl: 60 }, search: 'memory' })
	.id('id')
	.validate((input) => input as FuzzIdData)
	.search('memory', ['label'])
	.attach(FuzzIdRecord);

type FuzzWhereShape = Record<string, any>;

const cities = ['Seoul', 'Busan', 'Tokyo', 'Austin'];
const tags = ['red', 'blue', 'green', 'urgent', 'archived'];
const titleWords = ['alpha', 'beta', 'gamma', 'delta', 'omega'];

test('fuzz: memory query results match an independent oracle for portable operators', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = FuzzQueryRecord.use(context) as unknown as typeof FuzzQueryRecord;
	const rng = mulberry32(0x5eed_2026);
	const rows = Array.from({ length: 48 }, (_, index) => makeFuzzRow(index + 1, rng));
	await store.seed('fuzz_query_record', rows);

	for (let iteration = 0; iteration < 160; iteration++) {
		const tenantId = pick(rng, ['tenant-a', 'tenant-b'] as const);
		const globalWhere = randomWhere(rng);
		const branches = rng() < 0.6 ? Array.from({ length: 1 + int(rng, 3) }, () => randomWhere(rng)) : [];
		const sort = pick(rng, ['id', '-id', 'score', '-score', 'title', 'profile.city'] as const);
		const limit = rng() < 0.35 ? 1 + int(rng, 12) : undefined;

		let query = Record.scope('tenant', { tenantId }).where(globalWhere).orderBy(sort);
		if (branches.length) query = query.whereAny(branches);
		if (limit !== undefined) query = query.limit(limit);

		const actual = await query.load();
		const expected = oracle(rows, tenantId, globalWhere, branches, sort, limit);
		assert.deepEqual(
			actual.list.map((item) => item.data.id),
			expected.map((item) => item.id),
			`iteration ${iteration}`
		);
	}
});

test('fuzz: generated unsafe field paths and data keys are rejected before store execution', async () => {
	class ThrowingQueryStore extends MemoryStoreAdapter {
		queryReached = false;

		override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
			this.queryReached = true;
			return await super.query(...args);
		}
	}

	const store = new ThrowingQueryStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = FuzzGuardRecord.use(context) as unknown as typeof FuzzGuardRecord;
	const rng = mulberry32(0xbad_c0de);

	for (let iteration = 0; iteration < 120; iteration++) {
		const field = unsafeFieldPath(rng);
		await assert.rejects(
			async () => {
				await Record.query().where(field, '=', 'x').load();
			},
			/Reserved|Empty/,
			`where field ${field}`
		);
		assert.throws(() => Record.query().orderBy(field), /Reserved|Empty/, `sort field ${field}`);
		assert.throws(() => Record.query().select(field), /Reserved|Empty/, `select field ${field}`);
	}
	assert.equal(store.queryReached, false);

	for (let iteration = 0; iteration < 80; iteration++) {
		const payload = unsafeDataPayload(iteration, rng);
		await assert.rejects(() => Record.create(payload as FuzzGuardData, context), /Reserved data key/);
	}
});

test('fuzz: malformed query operator operands fail fast', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = FuzzQueryRecord.use(context) as unknown as typeof FuzzQueryRecord;
	const rng = mulberry32(0x0ade_2026);

	for (let iteration = 0; iteration < 120; iteration++) {
		const shape = invalidOperatorShape(rng);
		assert.throws(() => Record.where(shape), /Query operator/, `invalid operand ${JSON.stringify(shape)}`);
	}
});

test('fuzz: typed ids roundtrip across store cache search and outbox without collisions', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const search = new MemorySearchAdapter();
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `id-event-${Math.random()}` })]
	});
	const Record = FuzzIdRecord.use(context) as unknown as typeof FuzzIdRecord;
	const ids: Array<string | number> = [0, -1, 1, 42, '1', 'number:1', 'string:1'];

	for (const id of ids) {
		assert.equal(entityIdFromKey(entityIdKey(id)), id);
		await Record.create({ id, label: `label:${typeof id}:${String(id)}` });
		await search.index(context.meta(FuzzIdRecord), id, { id, label: `label:${typeof id}:${String(id)}` });
	}

	const loaded = await Promise.all(ids.map((id) => Record.find(id).load()));
	assert.deepEqual(
		loaded.map((item) => item?.data.label),
		ids.map((id) => `label:${typeof id}:${String(id)}`)
	);
	assert.deepEqual(
		Object.keys(cache.snapshot()).sort(),
		ids.map((id) => `fuzz_id_record:${typeof id}:${String(id)}`).sort()
	);
	assert.deepEqual(
		(await search.search(context.meta(FuzzIdRecord), 'label:', {})).list.map((item) => item.id),
		ids
	);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.modelId),
		ids
	);

	for (const id of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
		assert.throws(() => entityIdKey(id), /Entity id/);
		await assert.rejects(() => Record.create({ id, label: 'bad' }), /safe integer|finite numbers|not allowed/);
		await assert.rejects(() => Record.find(id).load(), /safe integer|not allowed/);
	}

	for (const key of ['number:', 'number:01', 'number:-0', 'number:1.5', 'string:']) {
		assert.throws(() => entityIdFromKey(key), /Encoded entity id/, `malformed key ${key}`);
	}
	for (const key of ['1', 'boolean:true', 'string:', 'number:01']) {
		assert.throws(
			() => entityIdFromCanonicalKey(key, `fuzz backend key ${key}`),
			/canonical active-ts entity id key|Encoded entity id/,
			`noncanonical backend key ${key}`
		);
	}
	assert.equal(entityIdFromCanonicalKey('number:7'), 7);
	assert.equal(entityIdFromCanonicalKey('string:7'), '7');
});

function makeFuzzRow(id: number, rng: () => number): FuzzQueryData {
	const city = pick(rng, cities);
	const title = `${pick(rng, titleWords)}-${pick(rng, titleWords)}-${id % 7}`;
	return {
		id,
		tenantId: rng() < 0.5 ? 'tenant-a' : 'tenant-b',
		score: int(rng, 101),
		title,
		tags: Array.from(new Set(Array.from({ length: int(rng, 4) }, () => pick(rng, tags)))),
		profile: { city, tier: 1 + int(rng, 5) },
		active: rng() < 0.5
	};
}

function randomWhere(rng: () => number): FuzzWhereShape {
	const choice = int(rng, 10);
	if (choice === 0) return { score: ['>=', int(rng, 101)] };
	if (choice === 1) {
		const low = int(rng, 80);
		return { score: ['between', low, low + int(rng, 21)] };
	}
	if (choice === 2) return { title: ['startsWith', pick(rng, titleWords).slice(0, 2)] };
	if (choice === 3) return { title: ['textContains', pick(rng, titleWords).slice(1, 4)] };
	if (choice === 4) return { tags: ['arrayContains', pick(rng, tags)] };
	if (choice === 5) return { profile: ['jsonContains', { city: pick(rng, cities) }] };
	if (choice === 6) return { 'profile.city': pick(rng, cities) };
	if (choice === 7) return { active: rng() < 0.5 };
	if (choice === 8) return { id: ['in', Array.from({ length: 1 + int(rng, 5) }, () => 1 + int(rng, 48))] };
	return { score: ['<', int(rng, 101)] };
}

function oracle(
	rows: FuzzQueryData[],
	tenantId: string,
	globalWhere: FuzzWhereShape,
	branches: FuzzWhereShape[],
	sort: string,
	limit: number | undefined
) {
	const global = (row: FuzzQueryData) => row.tenantId === tenantId && matchesShape(row, globalWhere);
	const filtered = rows.filter((row) => {
		if (!global(row)) return false;
		return branches.length ? branches.some((branch) => matchesShape(row, branch)) : true;
	});
	const sorted = filtered.toSorted((a, b) => compareForSort(a, b, sort) || a.id - b.id);
	return limit === undefined ? sorted : sorted.slice(0, limit);
}

function matchesShape(row: FuzzQueryData, shape: FuzzWhereShape) {
	return Object.entries(shape).every(([field, raw]) => {
		const value = pathValue(row, field);
		if (!Array.isArray(raw)) return Object.is(value, raw);
		const [op, expected, expected2] = raw;
		if (op === '>=') return Number(value) >= Number(expected);
		if (op === '<') return Number(value) < Number(expected);
		if (op === 'between') return Number(value) >= Number(expected) && Number(value) <= Number(expected2);
		if (op === 'startsWith') return String(value).startsWith(String(expected));
		if (op === 'textContains') return String(value).toLowerCase().includes(String(expected).toLowerCase());
		if (op === 'arrayContains') return Array.isArray(value) && value.includes(expected);
		if (op === 'jsonContains') return jsonContains(value, expected);
		if (op === 'in') return Array.isArray(expected) && expected.includes(value);
		throw new Error(`unsupported fuzz op ${String(op)}`);
	});
}

function compareForSort(a: FuzzQueryData, b: FuzzQueryData, sort: string) {
	const desc = sort.startsWith('-');
	const field = desc ? sort.slice(1) : sort;
	const left = pathValue(a, field);
	const right = pathValue(b, field);
	const result = left === right ? 0 : left > right ? 1 : -1;
	return desc ? -result : result;
}

function pathValue(row: FuzzQueryData, field: string): any {
	return field.split('.').reduce((value: any, key) => value?.[key], row);
}

function jsonContains(value: unknown, expected: unknown): boolean {
	if (Object.is(value, expected)) return true;
	if (Array.isArray(value)) return value.some((item) => jsonContains(item, expected));
	if (!value || !expected || typeof value !== 'object' || typeof expected !== 'object') return false;
	return Object.entries(expected as Record<string, unknown>).every(([key, nested]) =>
		jsonContains((value as Record<string, unknown>)[key], nested)
	);
}

function unsafeFieldPath(rng: () => number) {
	const unsafe = pick(rng, ['__proto__', '__tenant', 'constructor', 'prototype', '', '.name', 'name.', 'profile..city']);
	const safe = pick(rng, ['name', 'profile', 'meta', 'stats']);
	if (unsafe.startsWith('.') || unsafe.endsWith('.') || unsafe.includes('..')) return unsafe;
	return rng() < 0.5 ? unsafe : `${safe}.${unsafe}`;
}

function unsafeDataPayload(id: number, rng: () => number): Record<string, unknown> {
	const key = pick(rng, ['__proto__', '__meta', 'constructor', 'prototype']);
	if (rng() < 0.35) return { id, value: 'bad', [key]: 'blocked' };
	if (rng() < 0.7) return { id, value: 'bad', nested: { [key]: 'blocked' } };
	return { id, value: 'bad', nested: { list: [{ [key]: 'blocked' }] } };
}

function invalidOperatorShape(rng: () => number): FuzzWhereShape {
	const choice = int(rng, 4);
	if (choice === 0) return { id: ['in', 1] };
	if (choice === 1) return { score: ['between', int(rng, 20)] };
	if (choice === 2) return { score: ['between', int(rng, 20), String(int(rng, 20))] };
	return { score: ['>', undefined] };
}

function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function int(rng: () => number, maxExclusive: number) {
	return Math.floor(rng() * maxExclusive);
}

function pick<T>(rng: () => number, values: readonly T[]) {
	return values[int(rng, values.length)]!;
}
