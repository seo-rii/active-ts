import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter, Model, createActiveTs, defineModel } from '../src/index.js';

type ReadValidationData = {
	id: number;
	name: string;
};

class WarnReadShapeRecord extends Model<ReadValidationData> {}
class ErrorReadShapeRecord extends Model<ReadValidationData> {}
class WarnReadIdentityRecord extends Model<ReadValidationData> {}
class ErrorReadIdentityRecord extends Model<ReadValidationData> {}
class SharedReadOutputRecord extends Model<ReadValidationData & { nested: { label: string }; tags: string[] }> {}

let sharedReadOutput: ReadValidationData & { nested: { label: string }; tags: string[] } = {
	id: 1,
	name: 'validated',
	nested: { label: 'original' },
	tags: ['one']
};

defineModel<ReadValidationData>('warn_read_shape_record')
	.id('id')
	.validate(() => null as any)
	.readValidation('warn')
	.attach(WarnReadShapeRecord);

defineModel<ReadValidationData>('error_read_shape_record')
	.id('id')
	.validate(() => null as any)
	.readValidation('error')
	.attach(ErrorReadShapeRecord);

defineModel<ReadValidationData>('warn_read_identity_record')
	.id('id')
	.validate((input) => ({ ...(input as ReadValidationData), id: 2 }))
	.readValidation('warn')
	.attach(WarnReadIdentityRecord);

defineModel<ReadValidationData>('error_read_identity_record')
	.id('id')
	.validate((input) => ({ ...(input as ReadValidationData), id: 2 }))
	.readValidation('error')
	.attach(ErrorReadIdentityRecord);

defineModel<ReadValidationData & { nested: { label: string }; tags: string[] }>('shared_read_output_record')
	.id('id')
	.validate(() => sharedReadOutput)
	.readValidation('error')
	.attach(SharedReadOutputRecord);

test('warn read validation handles invalid validator return shapes like thrown failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = WarnReadShapeRecord.use(context) as unknown as typeof WarnReadShapeRecord;
	await store.seed('warn_read_shape_record', [{ id: 1, name: 'stored' }]);
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		const loaded = await Record.find(1).load();
		assert.deepEqual(loaded?.data, { id: 1, name: 'stored' });
		assert.match(warnings[0] ?? '', /Read validation failed for warn_read_shape_record/);
		assert.match(warnings[0] ?? '', /read data must be a plain object/);
	} finally {
		console.warn = originalWarn;
	}
});

test('error read validation wraps invalid validator return shapes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ErrorReadShapeRecord.use(context) as unknown as typeof ErrorReadShapeRecord;
	await store.seed('error_read_shape_record', [{ id: 1, name: 'stored' }]);

	await assert.rejects(
		() => Record.find(1).load(),
		/Read validation failed for error_read_shape_record: error_read_shape_record read data must be a plain object/
	);
});

test('warn read validation keeps decoded identity when validator changes ids', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = WarnReadIdentityRecord.use(context) as unknown as typeof WarnReadIdentityRecord;
	await store.seed('warn_read_identity_record', [{ id: 1, name: 'stored' }]);
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		const loaded = await Record.find(1).load();
		assert.deepEqual(loaded?.data, { id: 1, name: 'stored' });
		assert.equal(loaded?.id, 1);
		assert.match(warnings[0] ?? '', /read validator cannot change id field "id"/);
	} finally {
		console.warn = originalWarn;
	}
});

test('error read validation rejects validator id changes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ErrorReadIdentityRecord.use(context) as unknown as typeof ErrorReadIdentityRecord;
	await store.seed('error_read_identity_record', [{ id: 1, name: 'stored' }]);

	await assert.rejects(
		() => Record.find(1).load(),
		/Read validation failed for error_read_identity_record: error_read_identity_record read validator cannot change id field "id"/
	);
});

test('error read validation snapshots validator output before model instantiation', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = SharedReadOutputRecord.use(context) as unknown as typeof SharedReadOutputRecord;
	await store.seed('shared_read_output_record', [{ id: 1, name: 'stored' }]);
	sharedReadOutput = {
		id: 1,
		name: 'validated',
		nested: { label: 'original' },
		tags: ['one']
	};

	const first = await Record.find(1).load();
	assert.ok(first);
	assert.notEqual(first.data, sharedReadOutput);
	assert.notEqual(first.data.nested, sharedReadOutput.nested);
	assert.notEqual(first.data.tags, sharedReadOutput.tags);

	first.data.name = 'mutated instance';
	first.data.nested.label = 'mutated nested';
	first.data.tags.push('two');

	assert.deepEqual(sharedReadOutput, {
		id: 1,
		name: 'validated',
		nested: { label: 'original' },
		tags: ['one']
	});

	const second = await Record.find(1).load();
	assert.ok(second);
	assert.notEqual(second.data, first.data);
	assert.deepEqual(second.data, {
		id: 1,
		name: 'validated',
		nested: { label: 'original' },
		tags: ['one']
	});
});
