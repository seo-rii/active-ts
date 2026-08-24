import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsNotFoundError,
	Model,
	MemoryStoreAdapter,
	clearDefaultContext,
	createActiveTs,
	defineModel,
	setDefaultContext,
	type StoreAdapter
} from '../src/index.js';
import { BOUND_CONTEXT, SOURCE_MODEL } from '../src/core/model-markers.js';
import { createTestContext, seed, withTestContext } from '../src/testing/index.js';

type IdentityAccountData = {
	id: number;
	handle: string;
	score?: number;
	nickname?: string;
};

type SlugIdentityData = {
	slug: string;
	title: string;
};

type HookValidatedData = {
	id: number;
	value: string;
};

class IdentityAccount extends Model<IdentityAccountData> {}
class HookMutatingIdentityAccount extends Model<IdentityAccountData> {}
class SlugIdentityRecord extends Model<SlugIdentityData> {}
class AfterValidateCreateRecord extends Model<HookValidatedData> {}
class AfterValidateUpdateRecord extends Model<HookValidatedData> {}
class PrunedIdentityAccount extends Model<IdentityAccountData> {}
class HookAugmentedIdentityAccount extends Model<IdentityAccountData> {}

function parseHookValidated(input: any) {
	if (typeof input?.id !== 'number') throw new Error('id must be number');
	if (typeof input?.value !== 'string') throw new Error('value must be string');
	return { id: input.id, value: input.value } satisfies HookValidatedData;
}

function parseIdentityAccount(input: any) {
	if (typeof input?.id !== 'number') throw new Error('id must be number');
	if (typeof input?.handle !== 'string') throw new Error('handle must be string');
	const data: IdentityAccountData = { id: input.id, handle: input.handle };
	if (typeof input.score === 'number') data.score = input.score;
	return data;
}

defineModel<IdentityAccountData>('identity_regression_account')
	.id('id')
	.validate((input) => input as IdentityAccountData)
	.attach(IdentityAccount);

defineModel<IdentityAccountData>('hook_mutating_identity_account')
	.id('id')
	.validate((input) => input as IdentityAccountData)
	.hooks({
		beforeValidate(payload) {
			if (payload.operation !== 'update') return payload;
			const data = payload.data as IdentityAccountData;
			return { data: { ...data, id: data.id + 1 } };
		}
	})
	.attach(HookMutatingIdentityAccount);

defineModel<SlugIdentityData>('slug_identity_record')
	.id('slug')
	.validate((input) => input as SlugIdentityData)
	.attach(SlugIdentityRecord);

defineModel<HookValidatedData>('after_validate_create_record')
	.id('id')
	.validate(parseHookValidated)
	.hooks({
		afterValidate(payload) {
			if (payload.operation !== 'create') return payload;
			return { data: { ...(payload.data as HookValidatedData), value: 123 } };
		}
	})
	.attach(AfterValidateCreateRecord);

defineModel<HookValidatedData>('after_validate_update_record')
	.id('id')
	.validate(parseHookValidated)
	.hooks({
		afterValidate(payload) {
			if (payload.operation !== 'update') return payload;
			return { data: { ...(payload.data as HookValidatedData), value: 123 } };
		}
	})
	.attach(AfterValidateUpdateRecord);

defineModel<IdentityAccountData>('pruned_identity_account')
	.id('id')
	.validate(parseIdentityAccount)
	.attach(PrunedIdentityAccount);

defineModel<IdentityAccountData>('hook_augmented_identity_account')
	.id('id')
	.validate((input) => input as IdentityAccountData)
	.hooks({
		beforeUpdate(payload) {
			return { data: { ...(payload.data as IdentityAccountData), nickname: 'hooked' } };
		}
	})
	.attach(HookAugmentedIdentityAccount);

test('model identity is immutable across update patches and in-place mutations', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;
	setDefaultContext(context);
	await store.seed('identity_regression_account', [{ id: 401, handle: 'stable', score: 1 }]);

	await assert.rejects(
		() => Account.update(401, { id: 402, handle: 'moved' } as any),
		/Cannot change id field "id"/
	);
	assert.deepEqual(store.dump('identity_regression_account'), [{ id: 401, handle: 'stable', score: 1 }]);

	const account = await Account.find(401).load();
	assert.ok(account);
	account.data.id = 402;
	await assert.rejects(() => account.save(), /Cannot change id field "id"/);
	assert.deepEqual(store.dump('identity_regression_account'), [{ id: 401, handle: 'stable', score: 1 }]);
});

test('hard delete validates existence probe row identity before side effects', async () => {
	const hookEvents: string[] = [];
	let deleteCalls = 0;
	const store: StoreAdapter = {
		kind: 'wrong-delete-probe-store',
		get: async () => ({ id: 2, handle: 'wrong-row' }),
		getMany: async () => [],
		query: async () => ({ list: [] }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => {
			deleteCalls++;
		}
	};
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'delete-probe-observer',
				hooks: {
					beforeDelete(payload) {
						hookEvents.push(`before:${payload.id}`);
					},
					afterDelete(payload) {
						hookEvents.push(`after:${payload.id}`);
					}
				}
			}
		]
	});
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;

	await assert.rejects(
		() => Account.delete(1),
		/delete probe id field "id" must match the requested id/
	);
	assert.deepEqual(hookEvents, []);
	assert.equal(deleteCalls, 0);
});

test('model static markers ignore Function prototype pollution', async () => {
	const defaultStore = new MemoryStoreAdapter();
	const pollutedStore = new MemoryStoreAdapter();
	const defaultContext = createActiveTs({ stores: { default: defaultStore } });
	const pollutedContext = createActiveTs({ stores: { default: pollutedStore } });
	await defaultStore.seed('identity_regression_account', [{ id: 701, handle: 'default' }]);
	await pollutedStore.seed('identity_regression_account', [{ id: 701, handle: 'polluted' }]);

	Object.defineProperty(Function.prototype, BOUND_CONTEXT, {
		value: pollutedContext,
		configurable: true
	});
	Object.defineProperty(Function.prototype, SOURCE_MODEL, {
		value: SlugIdentityRecord,
		configurable: true
	});
	try {
		setDefaultContext(defaultContext);
		const direct = await IdentityAccount.find(701).load();
		assert.equal(direct?.data.handle, 'default');

		const BoundAccount = IdentityAccount.use(defaultContext) as unknown as typeof IdentityAccount;
		const bound = await BoundAccount.find(701).load();
		assert.equal(bound?.data.handle, 'default');
	} finally {
		delete (Function.prototype as any)[BOUND_CONTEXT];
		delete (Function.prototype as any)[SOURCE_MODEL];
		clearDefaultContext();
	}

	let markerReads = 0;
	Object.defineProperty(IdentityAccount, BOUND_CONTEXT, {
		configurable: true,
		get() {
			markerReads++;
			return pollutedContext;
		}
	});
	try {
		setDefaultContext(defaultContext);
		assert.throws(() => IdentityAccount.find(701), /Static model marker must be a data property/);
		assert.equal(markerReads, 0);
	} finally {
		delete (IdentityAccount as any)[BOUND_CONTEXT];
		clearDefaultContext();
	}

	Object.defineProperty(IdentityAccount, BOUND_CONTEXT, {
		value: pollutedContext,
		enumerable: false,
		configurable: true
	});
	try {
		setDefaultContext(defaultContext);
		assert.throws(() => IdentityAccount.find(701), /Static model marker must be enumerable/);
	} finally {
		delete (IdentityAccount as any)[BOUND_CONTEXT];
		clearDefaultContext();
	}
});

test('update patches reject reserved keys before loading or mutating models', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;
	await store.seed('identity_regression_account', [{ id: 501, handle: 'stable', score: 1 }]);

	await assert.rejects(
		() => Account.update(501, JSON.parse('{"__bad":true,"handle":"polluted"}')),
		/Reserved data key/
	);

	assert.equal(store.stats.getMany, 0);
	assert.deepEqual(store.dump('identity_regression_account'), [{ id: 501, handle: 'stable', score: 1 }]);
});

test('update patches reject prototype keys before merging into model data', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;
	await store.seed('identity_regression_account', [{ id: 502, handle: 'stable', score: 1 }]);

	await assert.rejects(
		() => Account.update(502, JSON.parse('{"__proto__":{"polluted":true},"handle":"polluted"}')),
		/Reserved data key/
	);

	assert.equal(({} as any).polluted, undefined);
	assert.equal(store.stats.getMany, 0);
	assert.deepEqual(store.dump('identity_regression_account'), [{ id: 502, handle: 'stable', score: 1 }]);
});

test('persisted data rejects symbol keys instead of silently dropping them', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;
	const symbol = Symbol('hidden');

	const createPayload = { id: 503, handle: 'symbol-create', [symbol]: 'lost' } as any;
	await assert.rejects(() => Account.create(createPayload), /Unsupported data symbol key/);
	assert.deepEqual(store.dump('identity_regression_account'), []);

	await Account.create({ id: 504, handle: 'stable' });
	const updatePatch = { handle: 'changed', [Symbol('patch')]: 'lost' } as any;
	await assert.rejects(() => Account.update(504, updatePatch), /Unsupported data symbol key/);
	assert.deepEqual(store.dump('identity_regression_account'), [{ id: 504, handle: 'stable' }]);
});

test('model identity cannot be changed by validation hooks during save', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = HookMutatingIdentityAccount.use(context) as unknown as typeof HookMutatingIdentityAccount;

	await Account.create({ id: 1, handle: 'hooked' });
	const account = await Account.find(1).load();
	assert.ok(account);
	account.data.handle = 'changed';

	await assert.rejects(() => account.save(), /Cannot change id field "id"/);
	assert.deepEqual(store.dump('hook_mutating_identity_account'), [{ id: 1, handle: 'hooked' }]);
});

test('custom id fields are immutable across update patches and saves', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = SlugIdentityRecord.use(context) as unknown as typeof SlugIdentityRecord;

	await Record.create({ slug: 'post-1', title: 'Original' });
	await assert.rejects(
		() => Record.update('post-1', { slug: 'post-2', title: 'Moved' } as any),
		/Cannot change id field "slug"/
	);

	const record = await Record.find('post-1').load();
	assert.ok(record);
	record.data.slug = 'post-2';
	await assert.rejects(() => record.save(), /Cannot change id field "slug"/);

	assert.deepEqual(store.dump('slug_identity_record'), [{ slug: 'post-1', title: 'Original' }]);
	assert.equal(await Record.find('post-2').load(), null);
});

test('chained bound models use the newest context and original metadata', async () => {
	const firstStore = new MemoryStoreAdapter();
	const secondStore = new MemoryStoreAdapter();
	const firstContext = createActiveTs({ stores: { default: firstStore } });
	const secondContext = createActiveTs({ stores: { default: secondStore } });
	const FirstBound = IdentityAccount.use(firstContext) as unknown as typeof IdentityAccount;
	const SecondBound = FirstBound.use(secondContext) as unknown as typeof IdentityAccount;
	await firstStore.seed('identity_regression_account', [{ id: 601, handle: 'first' }]);
	await secondStore.seed('identity_regression_account', [{ id: 601, handle: 'second' }]);

	const found = await SecondBound.find(601).load();

	assert.equal(found?.data.handle, 'second');
	assert.equal((await FirstBound.find(601).load())?.data.handle, 'first');
	await SecondBound.create({ id: 602, handle: 'created in second' });
	assert.equal(secondStore.dump('identity_regression_account').length, 2);
	assert.equal(firstStore.dump('identity_regression_account').length, 1);
});

test('manually constructed models cannot save as implicit upserts', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;
	const account = new Account({ id: 701, handle: 'manual' });

	await assert.rejects(
		() => account.save(),
		/not loaded or created by active-ts/
	);

	assert.deepEqual(store.dump('identity_regression_account'), []);

	assert.throws(
		() => new Account({ id: 702, handle: 'manual persisted' }, context, { persisted: true } as any),
		/persisted option is reserved for active-ts internals/
	);
	assert.throws(
		() => new Account({ id: 703, handle: 'bad options' }, context, null as any),
		/Model constructor options must be a plain object/
	);
});

test('stale loaded models cannot save after their row is deleted', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;

	await Account.create({ id: 702, handle: 'loaded' });
	const account = await Account.find(702).load();
	assert.ok(account);
	await Account.delete(702);

	account.data.handle = 'revived';
	await assert.rejects(
		() => account.save(),
		(error: unknown) =>
			error instanceof ActiveTsNotFoundError &&
			/Cannot update identity_regression_account:702 because it does not exist/.test(error.message)
	);
	assert.deepEqual(store.dump('identity_regression_account'), []);
});

test('memory and test-context seed helpers respect custom id fields', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = SlugIdentityRecord.use(context) as unknown as typeof SlugIdentityRecord;
	await store.seed(context.meta(SlugIdentityRecord), [{ slug: 'direct-seed', title: 'Direct' }]);
	assert.equal((await Record.find('direct-seed').load())?.data.title, 'Direct');

	const testContext = createTestContext();
	const TestRecord = SlugIdentityRecord.use(testContext.context) as unknown as typeof SlugIdentityRecord;
	await withTestContext(testContext, async () => {
		await seed(TestRecord, [{ slug: 'helper-seed', title: 'Helper' }]);
		assert.equal((await TestRecord.find('helper-seed').load())?.data.title, 'Helper');
	});
});

test('afterValidate hooks cannot smuggle invalid create data to store adapters', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AfterValidateCreateRecord.use(context) as unknown as typeof AfterValidateCreateRecord;

	await assert.rejects(() => Record.create({ id: 1, value: 'valid' }), /Write validation failed/);
	assert.deepEqual(store.dump('after_validate_create_record'), []);
});

test('afterValidate hooks cannot smuggle invalid update data to store adapters', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = AfterValidateUpdateRecord.use(context) as unknown as typeof AfterValidateUpdateRecord;

	await Record.create({ id: 1, value: 'valid' });
	const record = await Record.find(1).load();
	assert.ok(record);
	record.data.value = 'next';

	await assert.rejects(() => record.save(), /Write validation failed/);
	assert.deepEqual(store.dump('after_validate_update_record'), [{ id: 1, value: 'valid' }]);
});

test('save replaces model data with validated shape after pruning', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = PrunedIdentityAccount.use(context) as unknown as typeof PrunedIdentityAccount;

	await Account.create({ id: 1, handle: 'clean', score: 3 });
	const account = await Account.find(1).load();
	assert.ok(account);
	(account.data as any).debug = 'local-only';
	account.data.handle = 'saved';

	await account.save();

	assert.deepEqual(account.data, { id: 1, handle: 'saved', score: 3 });
	assert.deepEqual(store.dump('pruned_identity_account'), [{ id: 1, handle: 'saved', score: 3 }]);
});

test('static update defines patch fields without invoking inherited setters', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = IdentityAccount.use(context) as unknown as typeof IdentityAccount;
	await store.seed('identity_regression_account', [{ id: 801, handle: 'stable' }]);

	let setterCalls = 0;
	Object.defineProperty(Object.prototype, 'score', {
		configurable: true,
		set() {
			setterCalls++;
		}
	});
	try {
		const updated = await Account.update(801, { score: 7 });

		assert.equal(setterCalls, 0);
		assert.equal(Object.prototype.hasOwnProperty.call(updated!.data, 'score'), true);
		assert.equal(updated!.data.score, 7);
		assert.deepEqual(store.dump('identity_regression_account'), [{ id: 801, handle: 'stable', score: 7 }]);
	} finally {
		delete (Object.prototype as Record<string, unknown>).score;
	}
});

test('save defines hook-added fields without invoking inherited setters', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Account = HookAugmentedIdentityAccount.use(context) as unknown as typeof HookAugmentedIdentityAccount;
	await Account.create({ id: 802, handle: 'stable' });
	const account = await Account.find(802).load();
	assert.ok(account);
	account.data.handle = 'saved';

	let setterCalls = 0;
	Object.defineProperty(Object.prototype, 'nickname', {
		configurable: true,
		set() {
			setterCalls++;
		}
	});
	try {
		await account.save();

		assert.equal(setterCalls, 0);
		assert.equal(Object.prototype.hasOwnProperty.call(account.data, 'nickname'), true);
		assert.equal(account.data.nickname, 'hooked');
		assert.deepEqual(store.dump('hook_augmented_identity_account'), [
			{ id: 802, handle: 'saved', nickname: 'hooked' }
		]);
	} finally {
		delete (Object.prototype as Record<string, unknown>).nickname;
	}
});
