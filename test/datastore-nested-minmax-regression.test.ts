import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import type { ResolvedModelMeta } from '../src/index.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'nested_min_max', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
	fieldTypes: new Map([['score', 'number'], ['metrics.score', 'number'], ['metrics.label', 'string']]) };

// Datastore projections return an embedded property as one flat "a.b" property.
function projectionClient(entity: Record<string, any>) {
	const projections: string[][] = [];
	const client = { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {},
		update: async () => {}, delete: async () => {},
		createQuery: () => {
			let selected: string[] | undefined;
			const query = {
				filter() { return query; }, order() { return query; }, limit() { return query; },
				select(fields: string[]) { selected = fields; projections.push(fields); return query; },
				run() {
					if (!selected) return entity;
					const row: Record<string, unknown> = {};
					for (const field of selected) {
						let value: any = entity;
						for (const part of field.split('.')) value = value?.[part];
						row[field] = value;
					}
					return row;
				}
			};
			return query;
		},
		runQuery: async (query: { run(): unknown }) => [[query.run()], { moreResults: 'NO_MORE_RESULTS' }],
		createAggregationQuery() { throw new Error('min/max must use ordered lookups'); },
		runAggregationQuery: async () => [[]]
	};
	return { client, projections };
}

for (const op of ['min', 'max'] as const) {
	test(`Datastore typed ${op} reads nested fields from full entities`, async () => {
		const { client, projections } = projectionClient({ id: 1, score: 3, metrics: { score: 5, label: 'b' } });
		const datastore = await createDatastoreStoreAdapter({ client });
		for (const [field, expected] of [['metrics.score', 5], ['metrics.label', 'b']] as const) {
			assert.deepEqual(
				await datastore.aggregate!(meta, { where: [], or: [], aggregates: [{ op, field, as: 'value' }] }),
				{ value: expected }
			);
			assert.deepEqual(
				await datastore.aggregate!(meta, {
					where: [{ field, op: '>', value: typeof expected === 'number' ? 0 : 'a' }],
					or: [],
					aggregates: [{ op, field, as: 'value' }]
				}),
				{ value: expected }
			);
		}
		assert.deepEqual(projections, [], 'dotted min/max fields must not use projection queries');
		assert.deepEqual(
			await datastore.aggregate!(meta, { where: [], or: [], aggregates: [{ op, field: 'score', as: 'value' }] }),
			{ value: 3 }
		);
		assert.deepEqual(projections, [['id', 'score']], 'top-level min/max fields keep the projection');
	});
}
