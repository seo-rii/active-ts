import assert from 'node:assert/strict';

export async function runMongoNumericFieldOrder({ adapter, meta }) {
	const model = {
		...meta, name: `${meta.name}_numeric`,
		fieldTypes: new Map([['2', 'number'], ['1', 'number']]),
		indexes: [{ name: 'numeric_order', fields: ['2', '1'], unique: true }]
	};
	await adapter.schema.apply([model], { mode: 'safe' });
	await adapter.create(model, 'a', { id: 'a', '2': 2, '1': 1 });
	await adapter.create(model, 'b', { id: 'b', '2': 1, '1': 2 });
	for (const [direction, expected] of [['asc', ['b', 'a']], ['desc', ['a', 'b']]]) {
		const result = await adapter.query(model, {
			where: [], or: [], include: [], sort: [{ field: '2', direction }, { field: '1', direction }]
		});
		assert.deepEqual(result.list.map((row) => row.id), expected);
	}
	assert.deepEqual((await adapter.schema.plan([model])).changes, []);
	assert.deepEqual((await adapter.schema.apply([model], { mode: 'safe' })).changes, []);
	await assert.rejects(adapter.create(model, 'c', { id: 'c', '2': 1, '1': 2 }), /already exists/);
	await assert.rejects(adapter.schema.plan([{ ...model, indexes: [{ ...model.indexes[0], fields: ['1', '2'] }] }]), /does not match/);
	console.log('PASS MongoDB preserves numeric field order in sorts, indexes, and raw BSON discovery');
}
