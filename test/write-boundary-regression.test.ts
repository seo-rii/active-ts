import test from 'node:test';
import assert from 'node:assert/strict';

import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

type WriteBoundaryData = {
	id: number;
	value: string;
	extra?: string;
};

class HookInputRecord extends Model<WriteBoundaryData> {}
class ValidatorInputRecord extends Model<WriteBoundaryData> {}

defineModel<WriteBoundaryData>('hook_input_record')
	.id('id')
	.attach(HookInputRecord);

let validatorCalls = 0;
defineModel<WriteBoundaryData>('validator_input_record')
	.id('id')
	.validate((input: unknown) => {
		validatorCalls++;
		return input as WriteBoundaryData;
	})
	.attach(ValidatorInputRecord);

function accessorData(id: number, value = 'safe') {
	let reads = 0;
	const data = Object.defineProperty({ id, value }, 'extra', {
		enumerable: true,
		get() {
			reads++;
			return 'unsafe';
		}
	}) as WriteBoundaryData;
	return {
		data,
		reads: () => reads
	};
}

test('create data is sanitized before beforeCreate hooks receive it', async () => {
	const store = new MemoryStoreAdapter();
	let beforeCreateCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'write-boundary-create',
				hooks: {
					beforeCreate: () => {
						beforeCreateCalls++;
					}
				}
			}
		]
	});
	const Record = HookInputRecord.use(context) as unknown as typeof HookInputRecord;
	const input = accessorData(1);

	await assert.rejects(() => Record.create(input.data), /Unsupported data accessor at "\$\.extra"/);

	assert.equal(input.reads(), 0);
	assert.equal(beforeCreateCalls, 0);
	assert.deepEqual(store.dump('hook_input_record'), []);
});

test('beforeCreate hook data is sanitized before beforeValidate hooks receive it', async () => {
	const store = new MemoryStoreAdapter();
	const unsafe = accessorData(2);
	let beforeValidateCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'write-boundary-create-return',
				hooks: {
					beforeCreate: () => ({ data: unsafe.data }),
					beforeValidate: () => {
						beforeValidateCalls++;
					}
				}
			}
		]
	});
	const Record = HookInputRecord.use(context) as unknown as typeof HookInputRecord;

	await assert.rejects(
		() => Record.create({ id: 2, value: 'safe' }),
		/Hook result key "data"\.extra must be a data property/
	);

	assert.equal(unsafe.reads(), 0);
	assert.equal(beforeValidateCalls, 0);
	assert.deepEqual(store.dump('hook_input_record'), []);
});

test('beforeValidate hook data is sanitized before validators receive it', async () => {
	const store = new MemoryStoreAdapter();
	const unsafe = accessorData(3);
	validatorCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'write-boundary-before-validate',
				hooks: {
					beforeValidate: () => ({ data: unsafe.data })
				}
			}
		]
	});
	const Record = ValidatorInputRecord.use(context) as unknown as typeof ValidatorInputRecord;

	await assert.rejects(
		() => Record.create({ id: 3, value: 'safe' }),
		/Hook result key "data"\.extra must be a data property/
	);

	assert.equal(unsafe.reads(), 0);
	assert.equal(validatorCalls, 0);
	assert.deepEqual(store.dump('validator_input_record'), []);
});

test('save data is sanitized before beforeUpdate hooks receive it', async () => {
	const store = new MemoryStoreAdapter();
	let beforeUpdateCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'write-boundary-update',
				hooks: {
					beforeUpdate: () => {
						beforeUpdateCalls++;
					}
				}
			}
		]
	});
	const Record = HookInputRecord.use(context) as unknown as typeof HookInputRecord;
	await Record.create({ id: 4, value: 'stored' });
	const loaded = await Record.find(4).load();
	assert.ok(loaded);
	const unsafe = accessorData(4, 'updated');
	Object.defineProperty(loaded.data, 'extra', Object.getOwnPropertyDescriptor(unsafe.data, 'extra')!);
	loaded.data.value = unsafe.data.value;

	await assert.rejects(() => loaded.save(), /Unsupported data accessor at "\$\.extra"/);

	assert.equal(unsafe.reads(), 0);
	assert.equal(beforeUpdateCalls, 0);
	assert.deepEqual(store.dump('hook_input_record'), [{ id: 4, value: 'stored' }]);
});
