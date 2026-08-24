import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsConfigurationError,
	MemoryStoreAdapter,
	Model,
	assertCursorMatchesSort,
	compareRowsBySort,
	createActiveTs,
	cursorValues,
	decodeCursor,
	defineModel,
	encodeCursor,
	sortWithStableId
} from '../src/index.js';

type CursorData = {
	id: number;
	group: string;
	score: number;
	title: string;
	profile?: { rank: number };
};

type MixedIdCursorData = {
	id: number | string;
	score: number;
	title: string;
};

class CursorRecord extends Model<CursorData> {}
class MixedIdCursorRecord extends Model<MixedIdCursorData> {}

defineModel<CursorData>('cursor_regression_record')
	.id('id')
	.validate((input) => input as CursorData)
	.fieldType('score', 'number')
	.attach(CursorRecord);

defineModel<MixedIdCursorData>('mixed_id_cursor_regression_record')
	.id('id')
	.validate((input) => input as MixedIdCursorData)
	.fieldType('score', 'number')
	.attach(MixedIdCursorRecord);

test('cursor pagination fuzz preserves stable order without duplicates or gaps', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = CursorRecord.use(context) as unknown as typeof CursorRecord;
	const rows = Array.from({ length: 54 }, (_, index) => ({
		id: index + 1,
		group: index % 2 === 0 ? 'even' : 'odd',
		score: Math.floor(index / 3),
		title: `row-${index + 1}`
	}));
	await store.seed('cursor_regression_record', rows);

	for (const sort of ['score', '-score', 'group', '-group'] as const) {
		for (const limit of [1, 2, 5, 13]) {
			const seen: number[] = [];
			let cursor: string | undefined;
			let guard = 0;
			do {
				const page = await Record.query().orderBy(sort).limit(limit).cursor(cursor).load();
				seen.push(...page.list.map((item) => item.data.id));
				cursor = page.cursor;
				assert.equal(page.more, !!cursor);
				assert.ok(++guard < 100, `cursor pagination did not terminate for ${sort}/${limit}`);
			} while (cursor);

			assert.deepEqual(seen, expectedOrder(rows, sort), `${sort}/${limit}`);
			assert.equal(new Set(seen).size, rows.length, `${sort}/${limit} should not duplicate ids`);
		}
	}
});

test('cursor pagination uses deterministic tie breakers for mixed string and number ids', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = MixedIdCursorRecord.use(context) as unknown as typeof MixedIdCursorRecord;
	await store.seed('mixed_id_cursor_regression_record', [
		{ id: '1', score: 1, title: 'string-one' },
		{ id: 2, score: 1, title: 'number-two' },
		{ id: 1, score: 1, title: 'number-one' }
	]);

	const seen: Array<number | string> = [];
	let cursor: string | undefined;
	let guard = 0;
	do {
		const page = await Record.query().orderBy('score').limit(1).cursor(cursor).load();
		seen.push(...page.list.map((item) => item.data.id));
		cursor = page.cursor;
		assert.equal(page.more, !!cursor);
		assert.ok(++guard < 10);
	} while (cursor);

	assert.deepEqual(seen, [1, 2, '1']);
});

test('cursor rejects reuse with a different ordering', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = CursorRecord.use(context) as unknown as typeof CursorRecord;
	await store.seed('cursor_regression_record', [
		{ id: 1, group: 'a', score: 1, title: 'one' },
		{ id: 2, group: 'a', score: 2, title: 'two' }
	]);

	const first = await Record.query().orderBy('score').limit(1).load();
	await assert.rejects(
		() => Record.query().orderBy('-score').limit(1).cursor(first.cursor).load(),
		/different query ordering/
	);
});

test('cursor rejects unsafe sort fields and non-scalar values', async () => {
	assert.throws(
		() =>
			decodeCursor(
				encodeCursorPayload({
					v: 1,
					kind: 'keyset',
					sort: [{ field: '__proto__', direction: 'asc' }],
					values: [1]
				})
			),
		/Invalid active-ts cursor/
	);

	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = CursorRecord.use(context) as unknown as typeof CursorRecord;
	await store.seed('cursor_regression_record', [{ id: 1, group: 'a', score: 1, title: 'one' }]);

	const objectValueCursor = encodeCursorPayload({
		v: 1,
		kind: 'keyset',
		sort: [
			{ field: 'score', direction: 'asc' },
			{ field: 'id', direction: 'asc' }
		],
		values: [{ nested: 1 }, 1]
	});

	await assert.rejects(() => Record.query().orderBy('score').limit(1).cursor(objectValueCursor).load(), /Invalid active-ts cursor/);
});

test('memory cursor sorting rejects non-scalar row values', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = CursorRecord.use(context) as unknown as typeof CursorRecord;
	await store.seed('cursor_regression_record', [
		{ id: 1, group: 'a', score: 1, title: 'one', profile: { rank: 1 } },
		{ id: 2, group: 'b', score: 2, title: 'two', profile: { rank: 2 } }
	]);

	await assert.rejects(
		() => Record.query().orderBy('profile').limit(1).load(),
		/Sort and cursor values must be/
	);
});

test('public cursor helpers validate malformed runtime inputs', () => {
	assert.throws(
		() => encodeCursor({ v: 1, kind: 'keyset', sort: [{ field: 'id', direction: 'asc' }], values: [1n] } as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Cursor values must be string, number, boolean, or null/.test(error.message)
	);
	assert.throws(
		() => encodeCursor({ v: 1, kind: 'keyset', sort: [{ field: 'id', direction: 'sideways' }], values: [1] } as any),
		/cursor sort direction/
	);
	assert.throws(
		() => encodeCursor({ v: 1, kind: 'keyset', sort: new Array(1), values: [] } as any),
		/cursor sort\[0\] is missing/
	);
	let getterCalls = 0;
	const accessorPayload = Object.defineProperty(
		{
			kind: 'keyset',
			sort: [{ field: 'id', direction: 'asc' }],
			values: [1]
		},
		'v',
		{
			enumerable: true,
			get() {
				getterCalls++;
				return 1;
			}
		}
	);
	assert.throws(() => encodeCursor(accessorPayload as any), /Cursor payload\.v must be a data property/);
	assert.equal(getterCalls, 0);
	const hiddenPayload = Object.defineProperty(
		{
			kind: 'keyset',
			sort: [{ field: 'id', direction: 'asc' }],
			values: [1]
		},
		'v',
		{
			enumerable: false,
			value: 1
		}
	);
	assert.throws(() => encodeCursor(hiddenPayload as any), /Cursor payload\.v must be enumerable/);
	const accessorSort = Object.defineProperty({ direction: 'asc' }, 'field', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'id';
		}
	});
	assert.throws(
		() => encodeCursor({ v: 1, kind: 'keyset', sort: [accessorSort], values: [1] } as any),
		/cursor sort entry at index 0\.field must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenSort = Object.defineProperty({ direction: 'asc' }, 'field', {
		enumerable: false,
		value: 'id'
	});
	assert.throws(
		() => encodeCursor({ v: 1, kind: 'keyset', sort: [hiddenSort], values: [1] } as any),
		/cursor sort entry at index 0\.field must be enumerable/
	);
	assert.throws(
		() => encodeCursor({ v: 1, kind: 'keyset', sort: [{ field: 'id', direction: 'asc' }], values: [1], [Symbol('cursor')]: true } as any),
		/Cursor payload cannot contain symbol fields/
	);
	assert.throws(
		() =>
			encodeCursor({
				v: 1,
				kind: 'keyset',
				sort: [{ field: 'id', direction: 'asc' }],
				values: new Array(1)
			} as any),
		/Cursor values\[0\] is missing/
	);
	let iteratorCalls = 0;
	const iteratorValues = [1] as unknown[];
	Object.defineProperty(iteratorValues, Symbol.iterator, {
		configurable: true,
		value: function* () {
			iteratorCalls++;
			yield 'polluted';
		}
	});
	assert.throws(
		() =>
			encodeCursor({
				v: 1,
				kind: 'keyset',
				sort: [{ field: 'id', direction: 'asc' }],
				values: iteratorValues
			} as any),
		/Cursor values cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	let mapCalls = 0;
	const mappedSort = [{ field: 'id', direction: 'asc' }] as any[];
	Object.defineProperty(mappedSort, 'map', {
		configurable: true,
		value() {
			mapCalls++;
			return [];
		}
	});
	assert.deepEqual(
		decodeCursor(encodeCursor({ v: 1, kind: 'keyset', sort: mappedSort, values: [1] } as any)).sort,
		[{ field: 'id', direction: 'asc' }]
	);
	assert.equal(mapCalls, 0);
	assert.throws(() => sortWithStableId({} as any, 'id'), /cursor sort must be an array/);
	assert.throws(() => sortWithStableId({ sort: [] } as any, '__proto__'), /Reserved cursor id field/);
	let planGetterCalls = 0;
	const accessorPlan = Object.defineProperty({}, 'sort', {
		enumerable: true,
		get() {
			planGetterCalls++;
			return [];
		}
	});
	assert.throws(() => sortWithStableId(accessorPlan as any, 'id'), /cursor plan\.sort must be a data property/);
	assert.equal(planGetterCalls, 0);
	const hiddenPlan = Object.defineProperty({}, 'sort', {
		enumerable: false,
		value: []
	});
	assert.throws(() => sortWithStableId(hiddenPlan as any, 'id'), /cursor plan\.sort must be enumerable/);
	Object.defineProperty(Object.prototype, 'sort', {
		configurable: true,
		get() {
			planGetterCalls++;
			return [];
		}
	});
	try {
		assert.throws(() => sortWithStableId({} as any, 'id'), /cursor sort must be an array/);
		assert.equal(planGetterCalls, 0);
	} finally {
		delete (Object.prototype as Record<string, unknown>).sort;
	}
	assert.throws(
		() =>
			assertCursorMatchesSort(
				{ v: 1, kind: 'keyset', sort: [{ field: 'id', direction: 'asc' }], values: [{ nested: 1 }] } as any,
				[{ field: 'id', direction: 'asc' }]
			),
			/Cursor values must be string, number, boolean, or null/
	);
	assert.throws(() => decodeCursor(undefined as any), /Cursor is required/);
	assert.throws(() => decodeCursor(null as any), /active-ts cursor must be a string/);
	assert.throws(() => decodeCursor('a'.repeat(4097)), /active-ts cursor is too long/);
	assert.throws(() => decodeCursor('cursor\0payload'), /active-ts cursor must not contain null bytes/);
	assert.throws(() => decodeCursor('not-json'), /Invalid active-ts cursor/);
});

test('cursor stable sort ignores patched Array some', () => {
	const some = Object.getOwnPropertyDescriptor(Array.prototype, 'some')!;
	let withoutId;
	let withId;
	Object.defineProperty(Array.prototype, 'some', {
		configurable: true,
		value() {
			throw new Error('patched Array.some');
		}
	});
	try {
		withoutId = sortWithStableId({ sort: [{ field: 'score', direction: 'desc' }] } as any, 'id');
		withId = sortWithStableId({ sort: [{ field: 'id', direction: 'desc' }] } as any, 'id');
	} finally {
		Object.defineProperty(Array.prototype, 'some', some);
	}
	assert.deepEqual(withoutId, [
		{ field: 'score', direction: 'desc' },
		{ field: 'id', direction: 'asc' }
	]);
	assert.deepEqual(withId, [{ field: 'id', direction: 'desc' }]);
});

test('public cursor helpers strip extra decoded payload fields', () => {
	const encoded = encodeCursor({
		v: 1,
		kind: 'keyset',
		sort: [{ field: 'id', direction: 'asc', ignored: true } as any],
		values: [1],
		extra: 'ignored'
	} as any);
	const decoded = decodeCursor(encoded) as any;
	assert.deepEqual(Object.keys(decoded), ['v', 'kind', 'sort', 'values']);
	assert.deepEqual(Object.keys(decoded.sort[0]), ['field', 'direction']);
	assert.deepEqual(decoded, {
		v: 1,
		kind: 'keyset',
		sort: [{ field: 'id', direction: 'asc' }],
		values: [1]
	});
});

test('cursor helpers ignore inherited payload and sort entry fields', () => {
	Object.defineProperty(Object.prototype, 'v', { value: 1, configurable: true });
	Object.defineProperty(Object.prototype, 'kind', { value: 'keyset', configurable: true });
	Object.defineProperty(Object.prototype, 'sort', {
		value: [{ field: 'id', direction: 'asc' }],
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'values', { value: [1], configurable: true });
	try {
		assert.throws(() => encodeCursor({} as any), /Cursor payload version/);
		assert.throws(() => decodeCursor(encodeCursorPayload({})), /Invalid active-ts cursor/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).v;
		delete (Object.prototype as Record<string, unknown>).kind;
		delete (Object.prototype as Record<string, unknown>).sort;
		delete (Object.prototype as Record<string, unknown>).values;
	}

	Object.defineProperty(Object.prototype, 'field', { value: 'id', configurable: true });
	Object.defineProperty(Object.prototype, 'direction', { value: 'asc', configurable: true });
	try {
		assert.throws(
			() => encodeCursor({ v: 1, kind: 'keyset', sort: [{}], values: [1] } as any),
			/cursor sort field must be a string/
		);
		assert.throws(
			() =>
				decodeCursor(
					encodeCursorPayload({
						v: 1,
						kind: 'keyset',
						sort: [{}],
						values: [1]
					})
				),
			/Invalid active-ts cursor/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).field;
		delete (Object.prototype as Record<string, unknown>).direction;
	}
});

test('cursor helpers ignore inherited toJSON during encoding and sort matching', () => {
	let toJsonCalls = 0;
	Object.defineProperty(Object.prototype, 'toJSON', {
		configurable: true,
		value() {
			toJsonCalls++;
			return { v: 1, kind: 'keyset', sort: [], values: [] };
		}
	});
	try {
		const cursor: Parameters<typeof encodeCursor>[0] = {
			v: 1,
			kind: 'keyset',
			sort: [
				{ field: 'score', direction: 'asc' },
				{ field: 'id', direction: 'asc' }
			],
			values: [10, 1]
		};
		const encoded = encodeCursor(cursor);
		assert.equal(toJsonCalls, 0);
		assert.deepEqual(decodeCursor(encoded), cursor);
		assert.throws(
			() => assertCursorMatchesSort(cursor, [{ field: 'id', direction: 'asc' }]),
			/different query ordering/
		);
		assert.equal(toJsonCalls, 0);
	} finally {
		delete (Object.prototype as Record<string, unknown>).toJSON;
	}
});

test('cursor helpers ignore patched JSON intrinsics after import', () => {
	const originalStringify = JSON.stringify;
	const originalParse = JSON.parse;
	Object.defineProperty(JSON, 'stringify', {
		configurable: true,
		value() {
			throw new Error('patched JSON.stringify should not run for active-ts cursors');
		}
	});
	Object.defineProperty(JSON, 'parse', {
		configurable: true,
		value() {
			throw new Error('patched JSON.parse should not run for active-ts cursors');
		}
	});
	try {
		const cursor: Parameters<typeof encodeCursor>[0] = {
			v: 1,
			kind: 'keyset',
			sort: [{ field: 'id', direction: 'asc' }],
			values: [1]
		};
		assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
	} finally {
		Object.defineProperty(JSON, 'stringify', { configurable: true, value: originalStringify });
		Object.defineProperty(JSON, 'parse', { configurable: true, value: originalParse });
	}
});

test('cursor utilities reject custom Date metadata in sort values', () => {
	const customDate = new Date('2026-05-14T00:00:00.000Z') as Date & { extra?: string };
	customDate.extra = 'dropped';
	const symbolDate = new Date('2026-05-15T00:00:00.000Z');
	Object.defineProperty(symbolDate, Symbol('extra'), { value: true });

	assert.throws(
		() => cursorValues({ id: 1, seenAt: customDate }, [{ field: 'seenAt', direction: 'asc' }]),
		/Date values cannot contain custom property "extra"/
	);
	assert.throws(
		() => cursorValues({ id: 1, seenAt: symbolDate }, [{ field: 'seenAt', direction: 'asc' }]),
		/Date values cannot contain symbol fields/
	);
	assert.throws(
		() =>
			compareRowsBySort(
				{ id: 1, seenAt: customDate },
				{ id: 2, seenAt: new Date('2026-05-16T00:00:00.000Z') },
				[{ field: 'seenAt', direction: 'asc' }]
			),
		/Date values cannot contain custom property "extra"/
	);
});

function encodeCursorPayload(payload: unknown) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function expectedOrder(rows: CursorData[], sort: string) {
	const desc = sort.startsWith('-');
	const field = (desc ? sort.slice(1) : sort) as keyof CursorData;
	return rows
		.toSorted((left, right) => {
			const fieldCompare = compare(left[field], right[field]);
			const result = fieldCompare || left.id - right.id;
			return desc && fieldCompare ? -fieldCompare : result;
		})
		.map((row) => row.id);
}

function compare(left: unknown, right: unknown) {
	if (left === right) return 0;
	return (left as any) > (right as any) ? 1 : -1;
}
