import assert from 'node:assert/strict';

const DEFAULT_SEEDS = [0x5eed1234, 0x91e10da5];
const MARKERS = ['amberquartz', 'cobaltwhale', 'jademeteor', 'silverorchard'];
const IDS = [...Array.from({ length: 8 }, (_, index) => index + 1).flatMap((id) => [id, String(id)]), 'custom-alpha', 'custom-beta'];
const ALL = 'activefuzz';

function integer(value, name, min, max) {
	const parsed = Number(value);
	assert.ok(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max, `${name} must be an integer in ${min}..${max}`);
	return parsed;
}

function randomGenerator(seed) {
	let state = seed >>> 0;
	return (bound) => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) % bound;
	};
}

function sortedRows(rows, idField) {
	return [...rows].sort((left, right) => {
		const a = `${typeof left[idField]}:${left[idField]}`;
		const b = `${typeof right[idField]}:${right[idField]}`;
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

async function timed(run, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(run),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Search fuzz request exceeded ${timeoutMs}ms`)), timeoutMs); })
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Actual-backend differential checks. The caller supplies an isolated base model
 * with custom idField "slug" and searchable title/subtitle/score, creates each
 * seed's physical index in prepareModel, and removes its own index prefix later.
 * SDK request timeouts should also be bounded; this harness cannot cancel an
 * adapter request after its timeout. refresh is called once per mutation.
 */
export async function runSearchAdapterFuzz({
	adapter, backend, meta, prepareModel = async () => {}, refresh = async () => {},
	nativePageOptions, settleMs = 1_000, requestTimeoutMs = 5_000,
	seeds = (process.env.ACTIVE_TS_SEARCH_FUZZ_SEEDS ?? DEFAULT_SEEDS.join(',')).split(','),
	iterations = process.env.ACTIVE_TS_SEARCH_FUZZ_ITERATIONS ?? 100
}) {
	assert.equal(meta.idField, 'slug', 'Search fuzz uses a custom ID field');
	assert.ok(Array.isArray(seeds) && seeds.length > 0 && seeds.length <= 8, 'Search fuzz needs 1..8 seeds');
	seeds = seeds.map((seed) => integer(seed, 'seed', 0, 0xffffffff));
	assert.equal(new Set(seeds).size, seeds.length, 'Search fuzz seeds must be unique');
	iterations = integer(iterations, 'iterations', 1, 5_000);
	settleMs = integer(settleMs, 'settleMs', 0, 30_000);
	requestTimeoutMs = integer(requestTimeoutMs, 'requestTimeoutMs', 1, 60_000);
	const revisionWrites = adapter.capabilities?.revisionWrites === true;
	const started = Date.now();
	let completed = 0;
	for (const seed of seeds) {
		const model = { ...meta, name: `${meta.name}_seed_${seed.toString(16)}` };
		const random = randomGenerator(seed);
		// A map of last accepted events is the reference model, independent of
		// physical IDs, SDK request encoding, search ranking and adapter helpers.
		const state = new Map();
		const touched = new Set();
		const history = [];
		let step = -1;
		let current = { kind: 'prepare' };
		let failure;
		const call = (run) => timed(run, requestTimeoutMs);
		const liveRows = (query = ALL) => [...state.values()]
			.filter((entry) => entry.row && (query === ALL || entry.marker === query))
			.map((entry) => entry.row);
		const search = (query, options) => call(() => adapter.search(model, query, options));
		function assertResult(result, expected, limit, complete = false) {
			assert.ok(Array.isArray(result.list), 'Search result list must be an array');
			assert.equal(result.list.length, Math.min(expected.length, limit), 'Search must return the requested result window');
			assert.equal(result.count, result.list.length, 'Search count is the returned hit count');
			if (result.total !== undefined) assert.equal(result.total, expected.length, 'Small result windows have an exact total');
			assert.equal(result.more, expected.length > limit, 'Search more must describe the remaining result window');
			const seen = new Set();
			for (const row of result.list) {
				assert.ok(Object.hasOwn(row, model.idField), 'Every hit must contain the custom ID');
				assert.ok(!seen.has(row[model.idField]), 'Search must not return duplicate typed IDs');
				seen.add(row[model.idField]);
				const wanted = expected.find((candidate) => Object.is(candidate[model.idField], row[model.idField]));
				assert.ok(wanted, `Unexpected typed ID ${JSON.stringify([typeof row[model.idField], row[model.idField]])}`);
				assert.deepEqual(row, wanted, 'Hits must contain only the declared projection and latest replacement values');
			}
			if (complete) assert.deepEqual(sortedRows(result.list, model.idField), sortedRows(expected, model.idField));
		}
		async function verifyState() {
			const deadline = Date.now() + settleMs;
			for (;;) {
				try {
					assertResult(await search(ALL, { limit: 32 }), liveRows(), 32, true);
					return;
				} catch (error) {
					if (!(error instanceof assert.AssertionError) || Date.now() >= deadline) throw error;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
		}
		function makeIndex(id, marker = MARKERS[random(MARKERS.length)], subtitle = random(2) === 0) {
			const row = { slug: id, title: `${ALL} ${marker}`, score: random(201) - 100 };
			if (subtitle) row.subtitle = `caption ${random(1000)}`;
			return { kind: 'index', id, marker, row, input: { ...row, secret: 'privatefuzz', privateObject: { leaked: true } } };
		}
		async function execute(operation) {
			current = operation;
			step++;
			history.push(operation);
			if (operation.kind === 'search') {
				const expected = liveRows(operation.query);
				assertResult(await search(operation.query, { limit: operation.limit }), expected, operation.limit,
					operation.limit >= expected.length);
				return;
			}
			touched.add(operation.id);
			const options = operation.revision === undefined ? {} : { revision: operation.revision };
			const mutate = () => operation.kind === 'index'
				? adapter.index(model, operation.id, operation.input, options)
				: adapter.delete(model, operation.id, options);
			if (operation.rejectRevision) {
				await assert.rejects(() => call(mutate), /revision/i, 'Unsupported revision writes must reject explicitly');
			} else {
				await call(mutate);
				const previous = state.get(operation.id);
				if (!revisionWrites || operation.revision > (previous?.revision ?? 0)) {
					state.set(operation.id, { revision: operation.revision,
						row: operation.kind === 'index' ? operation.row : null, marker: operation.marker });
				}
			}
			await call(() => refresh(model));
			await verifyState();
		}
		async function verifyPages() {
			current = { kind: 'pagination', limit: 3 };
			// Native query/pagination cannot be combined with portable search fields.
			// The same physical index is queried through its native-only ID projection;
			// complete declared-field projections are checked separately by verifyState.
			const pageModel = nativePageOptions ? { ...model, searchIndexes: [] } : model;
			const expected = nativePageOptions ? liveRows().map((row) => ({ [model.idField]: row[model.idField] })) : liveRows();
			const gathered = [];
			let cursor;
			for (let offset = 0; offset <= expected.length; offset += 3) {
				const options = nativePageOptions
					? nativePageOptions({ offset, limit: 3 })
					: { limit: 3, ...(cursor === undefined ? {} : { cursor }) };
				const result = await call(() => adapter.search(pageModel, nativePageOptions ? '' : ALL, options));
				const remaining = Math.max(0, expected.length - offset);
				assert.equal(result.list.length, Math.min(3, remaining), 'Pagination must stay within the result window');
				assert.equal(result.count, result.list.length);
				if (result.total !== undefined) assert.equal(result.total, expected.length);
				assert.equal(result.more, remaining > 3);
				gathered.push(...result.list);
				if (!result.more) break;
				if (!nativePageOptions) {
					assert.equal(typeof result.cursor, 'string', 'More results require a portable cursor');
					assert.notEqual(result.cursor, cursor, 'Pagination must advance the cursor');
					cursor = result.cursor;
				}
			}
			assert.deepEqual(sortedRows(gathered, model.idField), sortedRows(expected, model.idField),
				'Pagination must visit every projected typed ID exactly once');
		}
		try {
			await call(() => prepareModel(model));
			await execute({ ...makeIndex(1, MARKERS[0], true), ...(revisionWrites ? { revision: 10 } : {}) });
			await execute({ ...makeIndex('1', MARKERS[1], true), ...(revisionWrites ? { revision: 10 } : {}) });
			await execute({ ...makeIndex(1, MARKERS[2], false), ...(revisionWrites ? { revision: 11 } : {}) });
			await execute({ kind: 'delete', id: 'missing-id', ...(revisionWrites ? { revision: 1 } : {}) });
			if (revisionWrites) {
				await execute({ kind: 'delete', id: 1, revision: 13 });
				for (const revision of [12, 13]) await execute({ ...makeIndex(1), revision });
				await execute({ ...makeIndex(1), revision: 14 });
			} else {
				await execute({ ...makeIndex(1), revision: 1, rejectRevision: true });
				await execute({ kind: 'delete', id: '1', revision: 1, rejectRevision: true });
			}
			for (let index = 0; index < iterations; index++) {
				const choice = random(10);
				if (choice >= 7) {
					const query = [...MARKERS, ALL, 'privatefuzz', 'absenttungsten'][random(MARKERS.length + 3)];
					await execute({ kind: 'search', query, limit: 1 + random(8) });
				} else {
					const id = IDS[random(IDS.length)];
					const operation = choice < 5 ? makeIndex(id) : { kind: 'delete', id };
					if (revisionWrites) {
						const previous = state.get(id)?.revision ?? 0;
						const direction = random(4);
						operation.revision = direction < 2 ? previous + 1 + random(3) : Math.max(1, previous - (direction - 2));
					}
					await execute(operation);
				}
				if (index % 20 === 19 && (adapter.capabilities?.cursor === true || nativePageOptions)) await verifyPages();
			}
			current = { kind: 'final-state' };
			await verifyState();
			completed += history.length;
		} catch (error) {
			failure = new Error(`${backend} search fuzz failed: seed=${seed} step=${step} operation=${JSON.stringify(current)}\n` +
				`Replay: ACTIVE_TS_INTEGRATION_TARGETS=${backend} ACTIVE_TS_SEARCH_FUZZ_SEEDS=${seed} ACTIVE_TS_SEARCH_FUZZ_ITERATIONS=${iterations}\n` +
				`Recent operations: ${JSON.stringify(history.slice(-12))}`, { cause: error });
		}
		const cleanup = await Promise.allSettled([...touched].map((id) => call(() => adapter.delete(model, id,
			revisionWrites ? { revision: (state.get(id)?.revision ?? 0) + 1 } : {}))));
		const cleanupErrors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
		if (failure) cleanupErrors.unshift(failure);
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, `${backend} search fuzz/cleanup failed`);
	}
	console.log(`${backend} seeded search fuzz passed: seeds=${seeds.join(',')} iterations=${iterations} operations=${completed} elapsedMs=${Date.now() - started}`);
}
