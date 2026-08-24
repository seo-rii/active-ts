import test from 'node:test';
import assert from 'node:assert/strict';
import {
	assertAggregateSpecsCompatibleWithModel,
	type AggregateResult,
	type ResolvedModelMeta
} from '../src/index.js';
import {
	applyFieldTypeTransforms,
	normalizeAggregateFieldTypes,
	normalizeAggregatePlanFieldTypes,
	normalizeQueryPlanFieldTypes,
	normalizeWhereFieldTypes,
	normalizeWhereShapeFieldTypes
} from '../src/core/field-types.js';
import { validateModelFieldTransformMetadata } from '../src/core/model-metadata-invariants.js';

function restorePrototypeProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
	} else {
		delete (target as Record<PropertyKey, unknown>)[key];
	}
}

test('field type normalization uses captured Map intrinsics', () => {
	const iso = '2026-05-14T00:00:00.000Z';
	const date = new Date(iso);
	const meta = {
		name: 'field_type_intrinsics_record',
		fieldTypes: new Map([
			['score', 'number'],
			['title', 'string'],
			['active', 'boolean'],
			['seenAt', 'date']
		])
	} as ResolvedModelMeta;
	const originalGet = Object.getOwnPropertyDescriptor(Map.prototype, 'get');
	const originalIterator = Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator);
	let getCalls = 0;
	let iteratorCalls = 0;

	try {
		Object.defineProperty(Map.prototype, 'get', {
			configurable: true,
			value() {
				getCalls++;
				throw new Error('polluted Map.prototype.get should not run');
			}
		});
		Object.defineProperty(Map.prototype, Symbol.iterator, {
			configurable: true,
			value() {
				iteratorCalls++;
				throw new Error('polluted Map.prototype iterator should not run');
			}
		});

		const write = applyFieldTypeTransforms(meta, { seenAt: date }, 'write');
		assert.equal(write.seenAt, iso);
		const read = applyFieldTypeTransforms(meta, { seenAt: iso }, 'read');
		assert.ok(read.seenAt instanceof Date);
		assert.equal(read.seenAt.toISOString(), iso);

		const where = normalizeWhereFieldTypes(meta, [{ field: 'seenAt', op: '=', value: date }]);
		assert.equal(where[0]?.value, iso);
		const whereShape = normalizeWhereShapeFieldTypes(meta, { seenAt: date });
		assert.deepEqual(whereShape, { seenAt: iso });
		const queryPlan = normalizeQueryPlanFieldTypes(meta, {
			where: [{ field: 'score', op: '>=', value: 1 }],
			or: [{ where: [{ field: 'seenAt', op: '<=', value: date }], or: [], sort: [], include: [] }],
			sort: [],
			include: []
		});
		assert.equal(queryPlan.or[0]?.where[0]?.value, iso);

		const aggregatePlan = normalizeAggregatePlanFieldTypes(meta, {
			where: [{ field: 'seenAt', op: '=', value: date }],
			or: [],
			aggregates: [{ op: 'max', field: 'seenAt', as: 'latest' }]
		});
		assert.equal(aggregatePlan.where[0]?.value, iso);
		assert.deepEqual(
			assertAggregateSpecsCompatibleWithModel(meta, [{ op: 'sum', field: 'score', as: 'total' }]),
			[{ op: 'sum', field: 'score', as: 'total' }]
		);
		assert.throws(
			() => assertAggregateSpecsCompatibleWithModel(meta, [{ op: 'max', field: 'active', as: 'latestActive' }]),
			/does not support boolean min\/max fields/
		);
		const aggregate = normalizeAggregateFieldTypes(
			meta,
			[{ op: 'max', field: 'seenAt', as: 'latest' }],
			{ latest: iso } as AggregateResult
		);
		assert.ok(aggregate.latest instanceof Date);
		assert.equal(aggregate.latest.toISOString(), iso);
	} finally {
		restorePrototypeProperty(Map.prototype, 'get', originalGet);
		restorePrototypeProperty(Map.prototype, Symbol.iterator, originalIterator);
	}

	assert.equal(getCalls, 0);
	assert.equal(iteratorCalls, 0);
});

test('field transform metadata invariants use captured Map size and has intrinsics', () => {
	let sizeCalls = 0;
	let hasCalls = 0;
	class TrapMap<K, V> extends Map<K, V> {
		override get size(): number {
			sizeCalls++;
			throw new Error('polluted metadata Map.size should not run');
		}

		override has(_key: K): boolean {
			hasCalls++;
			throw new Error('polluted metadata Map.has should not run');
		}
	}
	const codecs = new TrapMap<string, any>([
		[
			'secret',
			{
				encode: (value: unknown) => value,
				decode: (value: unknown) => value
			}
		]
	]);
	const types = new TrapMap<string, any>([['seenAt', 'date']]);

	validateModelFieldTransformMetadata('field_transform_intrinsics_record', 'id', codecs, types);

	assert.equal(sizeCalls, 0);
	assert.equal(hasCalls, 0);
});
