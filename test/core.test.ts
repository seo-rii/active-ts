import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsValidationError,
	ActiveTsNotFoundError,
	Model,
	ACTIVE_TS_ENTITY_KEY,
	clearDefaultContext,
	createAesGcmCacheCodec,
	createActiveTs,
	createCacheMiddlewareAdapter,
	createCodecCacheAdapter,
	createFunctionCache,
	createOutboxPlugin,
	createSearchMiddlewareAdapter,
	createSoftDeletePlugin,
	createStoreMiddlewareAdapter,
	defineModel,
	entity,
	field,
	index as decoratorIndex,
	modelMeta,
	ref,
	runSearchSyncWorker,
	searchIndex,
	restore,
	softDelete,
	setDefaultContext,
	typedField,
	type LazyRef,
	fromArkType,
	fromTypia,
	fromValibot,
	fromZod,
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter
} from '../src/index.js';
import {
	createAdapterContractSuite,
	createIntegrationHarness,
	createTestContext,
	expectNoLazyLoadWarnings,
	fixture,
	runStoreAdapterContract,
	seed,
	snapshotStore,
	withTestContext
} from '../src/testing/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';
import { createAlgoliaSearchAdapter } from '../src/adapters/search/algolia.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import { createNativeSearchAdapter } from '../src/adapters/search/native.js';

type AccountData = {
	id: number;
	handle: string;
	name?: string;
	score?: number;
};

type RankData = {
	id: number;
	rank: number;
	tier: number;
};

type HookedData = {
	id: number;
	handle: string;
	ownerId: number;
	score?: number;
};

type SecureData = {
	id: number;
	tenantId: string;
	email: string;
	secret: string;
};

type MixedIdData = {
	id: string | number;
	label: string;
};

type NegativeData = {
	id: number;
	handle: string;
};

type ProfileData = {
	id: number;
	accountHandle: string;
	bio: string;
};

type DateOwnerData = {
	id: number;
	happenedAt: Date;
	label: string;
};

type DateEventData = {
	id: number;
	happenedAt: Date;
	title: string;
};

type SoftData = {
	id: number;
	handle: string;
	deletedAt?: string | null;
};

type VersionedData = {
	id: number;
	value: string;
	version: number;
};

type SlugSearchData = {
	slug: string;
	title: string;
	body?: string;
};

type ArkProblemFieldData = {
	id: number;
	problems: string;
};

const FIELD_CODEC_VALUE = 'fixture-value';
const FIELD_CODEC_OTHER_VALUE = 'other-fixture-value';

class CountingStore extends MemoryStoreAdapter {
	getManyCalls = 0;

	override async getMany(model: any, ids: any[]) {
		this.getManyCalls++;
		return await super.getMany(model, ids);
	}
}

class OrderedTransactionStore extends MemoryStoreAdapter {
	constructor(private readonly events: string[]) {
		super();
	}

	override async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
		this.events.push('begin');
		return await super.transaction(async (tx) => {
			const result = await fn(tx);
			this.events.push('commit');
			return result;
		});
	}
}

class Account extends Model<AccountData> {}
class QuietAccount extends Model<AccountData> {}
class Rank extends Model<RankData> {}
class Hooked extends Model<HookedData> {}
class SecureRecord extends Model<SecureData> {}
class MixedId extends Model<MixedIdData> {}
class NegativeAccount extends Model<NegativeData> {}
class Profile extends Model<ProfileData> {}
class DateOwner extends Model<DateOwnerData> {}
class DateEvent extends Model<DateEventData> {}
class SoftAccount extends Model<SoftData> {}
class VersionedRecord extends Model<VersionedData> {}
class VersionPruningRecord extends Model<VersionedData> {}
class SlugSearchRecord extends Model<SlugSearchData> {}
class ArkProblemFieldRecord extends Model<ArkProblemFieldData> {}

class DecoratedRank extends Model<RankData> {
	static schema = defineModel<RankData>({ name: 'decorated_rank', cache: { ttl: 60 } }).id('id').build();
}

@entity({ name: 'decorated_account', cache: { ttl: 60 } })
class DecoratedAccount extends Model<AccountData> {
	static schema = defineModel<AccountData>().id('id').build();

	@ref(() => DecoratedRank, { localKey: 'id', foreignKey: 'id' })
	declare rank: LazyRef<DecoratedRank>;
}

defineModel<AccountData>({ name: 'account', cache: { ttl: 60 }, search: 'memory' })
	.id('id')
	.validate((input) => {
		const data = input as AccountData;
		if (!data || typeof data.id !== 'number' || typeof data.handle !== 'string')
			throw new Error('invalid account');
		return { id: data.id, handle: data.handle, name: data.name, score: data.score };
	})
	.readValidation('error')
	.index('handle', { unique: true })
	.fieldType('score', 'number')
	.search('memory', ['handle', 'name'])
	.ref('rank', () => Rank, { localKey: 'id', foreignKey: 'id', preload: ['rank', 'tier'] })
	.ref('profile', () => Profile, { localKey: 'handle', foreignKey: 'accountHandle', preload: ['bio'] })
	.attach(Account);

defineModel<AccountData>({ name: 'quiet_account', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as AccountData)
	.ref('rank', () => Rank, { localKey: 'id', foreignKey: 'id', warnOnLazy: false })
	.attach(QuietAccount);

defineModel<RankData>({ name: 'rank', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => {
		const data = input as RankData;
		if (!data || typeof data.id !== 'number') throw new Error('invalid rank');
		return data;
	})
	.attach(Rank);

const modelHookEvents: string[] = [];

defineModel<HookedData>({ name: 'hooked', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => {
		const data = input as HookedData;
		if (!data || typeof data.id !== 'number' || typeof data.handle !== 'string')
			throw new Error('invalid hooked');
		return { id: data.id, handle: data.handle, ownerId: data.ownerId, score: data.score };
	})
	.hooks({
		beforeValidate(payload) {
			modelHookEvents.push(`beforeValidate:${payload.operation}`);
			const data = payload.data as HookedData;
			return { data: { ...data, handle: data.handle.trim().toLowerCase() } };
		},
		afterValidate(payload) {
			modelHookEvents.push(`afterValidate:${payload.operation}`);
			return payload;
		},
		beforeUpdate(payload) {
			modelHookEvents.push(`beforeUpdate:${payload.id}`);
		},
		afterUpdate(payload) {
			modelHookEvents.push(`afterUpdate:${payload.id}`);
		}
	})
	.view('summary', ({ data }) => ({ id: data.id, label: data.handle }))
	.policy('editable', ({ data, viewer }) => (viewer as { id?: number } | undefined)?.id === data.ownerId)
	.attach(Hooked);

defineModel<SecureData>({ name: 'secure_record', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => {
		const data = input as SecureData;
		if (!data || typeof data.id !== 'number' || typeof data.tenantId !== 'string' || typeof data.secret !== 'string')
			throw new Error('invalid secure record');
		return { id: data.id, tenantId: data.tenantId, email: data.email, secret: data.secret };
	})
	.scope('tenant', ({ viewer }) => ({ tenantId: (viewer as { tenantId: string }).tenantId }))
	.fieldCodec('secret', {
		name: 'base64-test',
		encode: (value) => Buffer.from(String(value), 'utf8').toString('base64url'),
		decode: (value) => Buffer.from(String(value), 'base64url').toString('utf8')
	})
	.attach(SecureRecord);

defineModel<MixedIdData>({ name: 'mixed_id', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as MixedIdData)
	.attach(MixedId);

defineModel<NegativeData>({ name: 'negative_account', cache: { ttl: 60, negativeTtl: 60 } })
	.id('id')
	.validate((input) => {
		const data = input as NegativeData;
		if (!data || typeof data.id !== 'number' || typeof data.handle !== 'string')
			throw new Error('invalid negative account');
		return data;
	})
	.attach(NegativeAccount);

defineModel<ProfileData>({ name: 'profile', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as ProfileData)
	.attach(Profile);

defineModel<DateOwnerData>({ name: 'date_owner', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as DateOwnerData)
	.fieldType('happenedAt', 'date')
	.ref('event', () => DateEvent, { localKey: 'happenedAt', foreignKey: 'happenedAt' })
	.attach(DateOwner);

defineModel<DateEventData>({ name: 'date_event', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as DateEventData)
	.fieldType('happenedAt', 'date')
	.attach(DateEvent);

defineModel<SoftData>({ name: 'soft_account', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as SoftData)
	.attach(SoftAccount);

defineModel<VersionedData>({ name: 'versioned_record', cache: false })
	.id('id')
	.validate((input) => input as VersionedData)
	.attach(VersionedRecord);

defineModel<VersionedData>({ name: 'version_pruning_record', cache: false })
	.id('id')
	.validate((input) => input as VersionedData)
	.hooks({
		beforeUpdate(payload) {
			const { version: _version, ...data } = payload.data as VersionedData;
			return { data };
		}
	})
	.attach(VersionPruningRecord);

defineModel<SlugSearchData>({ name: 'slug_search_record', search: 'memory' })
	.id('slug')
	.validate((input) => input as SlugSearchData)
	.search('memory', ['title'])
	.attach(SlugSearchRecord);

defineModel<ArkProblemFieldData>('ark_problem_field_record')
	.id('id')
	.validate(fromArkType((input: unknown) => input as ArkProblemFieldData))
	.attach(ArkProblemFieldRecord);

function setup() {
	const store = new CountingStore();
	const cache = new MemoryCacheAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	setDefaultContext(context);
	return { store, cache, search, context };
}

test('loads by id through cache-backed batch loader', async () => {
	const { store } = setup();
	await store.seed('account', [
		{ id: 1, handle: 'seo' },
		{ id: 2, handle: 'han' }
	]);

	const [a, b] = await Promise.all([Account.find(1).load(), Account.find(2).load()]);

	assert.equal(a?.data.handle, 'seo');
	assert.equal(b?.data.handle, 'han');
	assert.equal(store.getManyCalls, 1);

	const again = await Account.find(1).load();
	assert.equal(again?.data.handle, 'seo');
	assert.equal(store.getManyCalls, 1);
});

test('bound models use their explicit context for static APIs', async () => {
	const defaultStore = new CountingStore();
	const boundStore = new CountingStore();
	const defaultContext = createActiveTs({ stores: { default: defaultStore } });
	const boundContext = createActiveTs({ stores: { default: boundStore } });
	setDefaultContext(defaultContext);
	await defaultStore.seed('account', [{ id: 1, handle: 'default' }]);
	await boundStore.seed('account', [{ id: 1, handle: 'bound' }]);

	const BoundAccount = Account.use(boundContext) as unknown as typeof Account;
	assert.equal((await Account.find(1).load())?.data.handle, 'default');
	assert.equal((await BoundAccount.find(1).load())?.data.handle, 'bound');
	assert.equal((await BoundAccount.create({ id: 2, handle: 'created' })).data.handle, 'created');
	assert.equal((await Account.find(2).load()), null);
});

test('negative cache misses are invalidated on create', async () => {
	const { store, cache } = setup();
	assert.equal(await NegativeAccount.find(55).load(), null);
	assert.equal(cache.stats.setMany, 1);

	await NegativeAccount.create({ id: 55, handle: 'created-after-miss' });
	const loaded = await NegativeAccount.find(55).load();
	assert.equal(loaded?.data.handle, 'created-after-miss');
	assert.equal(store.getManyCalls, 2);
});

test('number and string ids do not collide in batches, memory store, or cache', async () => {
	const { store } = setup();
	await store.seed('mixed_id', [
		{ id: 1, label: 'number-one' },
		{ id: '1', label: 'string-one' }
	]);

	const [numberOne, stringOne] = await Promise.all([MixedId.find(1).load(), MixedId.find('1').load()]);
	assert.equal(numberOne?.data.label, 'number-one');
	assert.equal(stringOne?.data.label, 'string-one');

	const [againNumber, againString] = await Promise.all([MixedId.find(1).load(), MixedId.find('1').load()]);
	assert.equal(againNumber?.data.label, 'number-one');
	assert.equal(againString?.data.label, 'string-one');
	await assert.rejects(() => MixedId.find('bad\0id').load(), /loadById id must not contain null bytes/);
	await assert.rejects(
		() => MixedId.create({ id: 'bad\0id', label: 'bad-id' }),
		/mixed_id\.id must not contain null bytes/
	);
});

test('loads included relation without warning and lazy relation with warning', async () => {
	const { store } = setup();
	await store.seed('account', [{ id: 1, handle: 'seo' }]);
	await store.seed('rank', [{ id: 1, rank: 7, tier: 3 }]);

	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: any) => warnings.push(String(message));
	try {
		const account = await Account.find(1).include('rank').load();
		const planned = await account?.ref<Rank>('rank');
		assert.equal((planned as Rank).data.rank, 7);
		assert.equal(warnings.length, 0);

		const account2 = await Account.find(1).load();
		const lazy = await account2?.ref<Rank>('rank');
		assert.equal((lazy as Rank).data.tier, 3);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /without include/);
	} finally {
		console.warn = originalWarn;
	}
});

test('direct lazy relation loads emit hooks and relation-level warning options are preserved', async () => {
	const store = new CountingStore();
	const relationEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new MemoryCacheAdapter() },
		plugins: [
			{
				name: 'relation-audit',
				hooks: {
					beforeRelationLoad: (payload) => {
						relationEvents.push(`before:${payload.meta?.relation}`);
					},
					afterRelationLoad: (payload) => {
						relationEvents.push(`after:${payload.meta?.relation}`);
					}
				}
			}
		]
	});
	setDefaultContext(context);
	await store.seed('account', [{ id: 2, handle: 'hooked' }]);
	await store.seed('quiet_account', [{ id: 2, handle: 'quiet' }]);
	await store.seed('rank', [{ id: 2, rank: 8, tier: 4 }]);
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: any) => warnings.push(String(message));
	try {
		const included = await Account.find(2).include('rank').load();
		await included?.ref<Rank>('rank');
		assert.deepEqual(relationEvents, ['before:rank', 'after:rank']);
		assert.deepEqual(warnings, []);

		relationEvents.length = 0;
		const lazy = await Account.find(2).load();
		await lazy?.ref<Rank>('rank');
		assert.deepEqual(relationEvents, ['before:rank', 'after:rank']);
		assert.equal(warnings.length, 1);

		const quiet = await QuietAccount.find(2).load();
		await quiet?.ref<Rank>('rank');
		assert.equal(context.meta(QuietAccount).relations.get('rank')?.warnOnLazy, false);
		assert.equal(warnings.length, 1);
	} finally {
		console.warn = originalWarn;
	}
});

test('one relations query by foreignKey when it is not the target id field', async () => {
	const { store } = setup();
	await store.seed('account', [{ id: 10, handle: 'seo' }]);
	await store.seed('profile', [{ id: 99, accountHandle: 'seo', bio: 'writer' }]);

	const account = await Account.find(10).include('profile').load();
	const profile = await account?.ref<Profile>('profile');
	assert.equal((profile as Profile).data.id, 99);
	assert.equal((profile as Profile).data.bio, 'writer');
});

test('relation include supports object notation and batches foreign-key preloads', async () => {
	const { store } = setup();
	await store.seed('account', [
		{ id: 10, handle: 'seo' },
		{ id: 11, handle: 'han' }
	]);
	await store.seed('profile', [
		{ id: 99, accountHandle: 'seo', bio: 'writer' },
		{ id: 100, accountHandle: 'han', bio: 'builder' }
	]);

	const result = await Account.query().orderBy('id').include({ profile: true }).load();
	const profiles = await Promise.all(result.list.map((account) => account.ref<Profile>('profile')));
	assert.deepEqual(
		profiles.map((profile) => (Array.isArray(profile) ? undefined : profile?.data.bio)),
		['writer', 'builder']
	);
	assert.equal(store.stats.query, 2);
});

test('relation include matches date-valued non-id foreign keys by value', async () => {
	const { store } = setup();
	const happenedAt = '2026-05-19T00:00:00.000Z';
	await store.seed('date_owner', [{ id: 1, happenedAt, label: 'owner' } as any]);
	await store.seed('date_event', [{ id: 10, happenedAt, title: 'matched' } as any]);

	const owner = await DateOwner.find(1).include('event').load();
	const event = (await owner?.ref<DateEvent>('event')) as DateEvent | null | undefined;
	assert.equal(event?.data.title, 'matched');
	assert.notEqual(owner?.data.happenedAt, event?.data.happenedAt);
	assert.equal(owner?.data.happenedAt.toISOString(), event?.data.happenedAt.toISOString());
});

test('queries and searches models', async () => {
	const { store, search, context } = setup();
	await store.seed('account', [
		{ id: 1, handle: 'seo', name: 'Seorii', score: 10 },
		{ id: 2, handle: 'han', name: 'Han', score: 20 }
	]);
	await search.index(context.meta(Account), 1, { id: 1, handle: 'seo', name: 'Seorii' });
	await search.index(context.meta(Account), 4, { id: 4, handle: 'nope', name: 'Nope', hidden: 'seo' });

	const query = await Account.where({ handle: 'seo' }).load();
	assert.equal(query.list.length, 1);
	assert.equal(query.list[0].data.id, 1);

	const found = await Account.search('seo').load();
	assert.equal(found.list.length, 1);
	assert.equal(found.list[0].data.handle, 'seo');

	const filtered = await Account.search('seo').where({ handle: 'seo' }).load();
	assert.equal(filtered.list.length, 1);
	assert.equal(filtered.list[0].data.handle, 'seo');

	const filteredOut = await Account.search('seo').where({ handle: 'han' }).load();
	assert.equal(filteredOut.list.length, 0);

	const hiddenOnly = await Account.search('hidden').load();
	assert.equal(hiddenOnly.list.length, 0);
	await search.index(context.meta(Rank), 1, { id: 1, rank: 7, tier: 3, searchable: 'seo' });
	assert.equal((await search.search(context.meta(Rank), 'seo', {})).list.length, 0);

	const union = await Account.query().whereAny({ handle: 'seo' }, { handle: 'han' }).orderBy('id').load();
	assert.deepEqual(
		union.list.map((item) => item.data.handle),
		['seo', 'han']
	);
	assert.throws(
		() => Account.query().where({ handle: ['contains', 'seo'] } as any),
		/contains/
	);

	const partial = await Account.query().where({ handle: 'seo' }).select('score').load();
	assert.equal(partial.list[0].data.id, 1);
	assert.equal(partial.list[0].data.score, 10);
	assert.equal(partial.list[0].data.handle, undefined);
	partial.list[0].data.score = 11;
	await assert.rejects(() => (partial.list[0] as any).save(), /partial account instance/);
	assert.throws(() => (partial.list[0] as any).ref('rank'), /partial account instance/);
	await assert.rejects(() => (partial.list[0] as any).include('rank'), /partial account instance/);

	await assert.rejects(
		() => search.index(context.meta(Account), 3, { id: 3, handle: 'bad', __search: true }),
		/Reserved data key/
	);
});

test('query first does not mutate reusable builder limits', async () => {
	const { store } = setup();
	await store.seed('account', [
		{ id: 1, handle: 'seo', score: 10 },
		{ id: 2, handle: 'han', score: 20 }
	]);

	const query = Account.query().orderBy('id');
	assert.equal((await query.first())?.data.id, 1);
	assert.deepEqual(
		(await query.load()).list.map((item) => item.data.id),
		[1, 2]
	);
});

test('memory store returns stable keyset cursors', async () => {
	const { store } = setup();
	await store.seed('account', [
		{ id: 2, handle: 'han', score: 10 },
		{ id: 1, handle: 'seo', score: 10 },
		{ id: 3, handle: 'kim', score: 20 }
	]);

	const first = await Account.query().orderBy('score').limit(2).load();
	assert.deepEqual(
		first.list.map((item) => item.data.id),
		[1, 2]
	);
	assert.equal(first.more, true);
	assert.ok(first.cursor);

	const second = await Account.query().orderBy('score').limit(2).cursor(first.cursor).load();
	assert.deepEqual(
		second.list.map((item) => item.data.id),
		[3]
	);
	assert.equal(second.more, false);

	await assert.rejects(
		() => Account.query().orderBy('-score').limit(2).cursor(first.cursor).load(),
		/different query ordering/
	);
});

test('store queries support validated offset pagination', async () => {
	const { store, context } = setup();
	await store.seed('account', [
		{ id: 1, handle: 'one', score: 10 },
		{ id: 2, handle: 'two', score: 20 },
		{ id: 3, handle: 'three', score: 30 },
		{ id: 4, handle: 'four', score: 40 }
	]);

	const page = await Account.query().orderBy('score').offset(1).limit(2).load();
	assert.deepEqual(page.list.map((item) => item.data.id), [2, 3]);
	assert.equal(page.more, true);
	assert.equal((await Account.query().orderBy('score').offset(2).first())?.data.id, 3);
	assert.deepEqual(
		(await Account.query().orderBy('score').offset(0).load()).list.map((item) => item.data.id),
		[1, 2, 3, 4]
	);

	assert.throws(() => Account.query().offset(1).cursor('cursor'), /cannot combine offset\(\) with cursor\(\)/);
	assert.throws(() => Account.query().cursor('cursor').offset(1), /cannot combine offset\(\) with cursor\(\)/);
	await assert.rejects(
		() =>
			store.query(context.meta(Account), {
				where: [],
				or: [],
				sort: [],
				include: [],
				offset: 1,
				cursor: 'cursor'
			}),
		/cannot combine offset\(\) with cursor\(\)/
	);
});

test('context rejects unsupported store capabilities before adapter execution', async () => {
	const store = new MemoryStoreAdapter();
	Object.assign(store.capabilities, {
		startsWith: false,
		numericComparisons: false,
		cursor: false,
		offset: false
	});
	const context = createActiveTs({ stores: { default: store } });
	const LimitedAccount = Account.use(context) as unknown as typeof Account;

	await assert.rejects(() => LimitedAccount.where({ handle: ['startsWith', 's'] }).load(), /startsWith/);
	await assert.rejects(() => LimitedAccount.query().where('score', '>', 1).load(), /range comparisons/);
	await assert.rejects(() => LimitedAccount.query().limit(1).cursor('cursor').load(), /cursor pagination/);
	await assert.rejects(() => LimitedAccount.query().offset(1).load(), /offset pagination/);
	assert.equal(store.stats.query, 0);
});

test('resolved model metadata containers are immutable', () => {
	const { context } = setup();
	const meta = context.meta(Account);
	assert.equal(Object.isFrozen(meta), true);
	assert.equal(Object.isFrozen(meta.indexes), true);
	assert.equal(Object.isFrozen(meta.relations), true);
	assert.equal(Object.isFrozen(meta.relations.get('rank')), true);
	assert.throws(() => {
		(meta as any).store = 'replica';
	}, TypeError);
	assert.throws(() => {
		(meta.indexes as any).push({ name: 'late', fields: ['handle'] });
	}, TypeError);
	assert.throws(() => {
		meta.relations.set('late', meta.relations.get('rank')!);
	}, /resolved model metadata/);
	assert.throws(() => {
		(meta.relations.get('rank') as any).foreignKey = 'other';
	}, TypeError);
	assert.equal(context.meta(Account).store, 'default');
	assert.equal(context.meta(Account).relations.get('rank')?.foreignKey, 'id');
});

test('aggregates queries through optimized store path', async () => {
	const { store } = setup();
	await store.seed('account', [
		{ id: 1, handle: 'seo', score: 10 },
		{ id: 2, handle: 'han', score: 20 },
		{ id: 3, handle: 'seo-2', score: 30 }
	]);

	assert.equal(await Account.count(), 3);
	assert.equal(await Account.where({ handle: ['startsWith', 'seo'] }).count(), 2);
	assert.equal(await Account.query().sum('score'), 60);
	assert.equal(await Account.query().avg('score'), 20);
	assert.equal(await Account.query().min('score'), 10);
	assert.equal(await Account.query().max('score'), 30);

	const grouped = await Account.query().where('score', '>=', 20).aggregate({
		total: { op: 'sum', field: 'score' },
		highest: { op: 'max', field: 'score' },
		count: 'count'
	});
	assert.deepEqual(grouped, { total: 50, highest: 30, count: 2 });
	assert.equal(store.stats.aggregate, 7);
	assert.equal(store.stats.query, 0);
});

test('aggregate hooks can replace aggregate specs consistently', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'aggregate-rewrite',
				hooks: {
					beforeAggregate: (payload) => {
						const plan = payload.plan as any;
						return {
							plan: {
								...plan,
								aggregates: [{ op: 'max', field: 'score', as: 'highest' }]
							}
						};
					}
				}
			}
		]
	});
	setDefaultContext(context);
	await Account.create({ id: 1, handle: 'low', score: 10 });
	await Account.create({ id: 2, handle: 'high', score: 30 });

	const result = await Account.query().aggregate({ total: { op: 'sum', field: 'score' } });
	assert.deepEqual(result, { highest: 30 });
	assert.equal(Object.prototype.hasOwnProperty.call(result, 'total'), false);
});

test('runs lifecycle hooks, plugins, views, policies, and function cache hooks', async () => {
	modelHookEvents.length = 0;
	const store = new CountingStore();
	const cache = new MemoryCacheAdapter();
	const pluginEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [
			{
				name: 'audit',
				hooks: {
					beforeCreate: () => {
						pluginEvents.push('beforeCreate');
					},
					afterCreate: () => {
						pluginEvents.push('afterCreate');
					},
					afterQuery: () => {
						pluginEvents.push('afterQuery');
					},
					beforeAggregate: () => {
						pluginEvents.push('beforeAggregate');
					},
					afterAggregate: () => {
						pluginEvents.push('afterAggregate');
					},
					afterCacheInvalidate: () => {
						pluginEvents.push('afterCacheInvalidate');
					}
				}
			}
		]
	});
	setDefaultContext(context);

	const item = await Hooked.create({ id: 1, handle: ' SEO ', ownerId: 7, score: 10 });
	assert.equal(item.data.handle, 'seo');
	assert.deepEqual(await item.view('summary'), { id: 1, label: 'seo' });
	assert.equal(await item.can('editable', { id: 7 }), true);
	assert.equal(await item.can('editable', { id: 8 }), false);

	item.data.score = 15;
	await item.save();
	const found = await Hooked.where({ handle: 'seo' }).load();
	assert.equal(found.list.length, 1);
	assert.equal(await Hooked.count(), 1);

	await Hooked.delete(1);
	assert.deepEqual(modelHookEvents, [
		'beforeValidate:create',
		'afterValidate:create',
		'beforeUpdate:1',
		'beforeValidate:update',
		'afterValidate:update',
		'afterUpdate:1'
	]);
	assert.deepEqual(pluginEvents, [
		'beforeCreate',
		'afterCacheInvalidate',
		'afterCreate',
		'afterCacheInvalidate',
		'afterQuery',
		'beforeAggregate',
		'afterAggregate',
		'afterCacheInvalidate'
	]);

	let calls = 0;
	const lookup = createFunctionCache<number, string>({
		prefix: 'lookup',
		context,
		ttl: 60,
		key: (id) => `id:${id}`,
		factory: async (id) => {
			calls++;
			return `value:${id}:${calls}`;
		}
	});
	assert.equal(await lookup.get(5), 'value:5:1');
	assert.equal(await lookup.get(5), 'value:5:1');
	lookup.clearMemory();
	assert.equal(await lookup.get(5), 'value:5:1');
	await lookup.invalidate(5);
	assert.equal(await lookup.peek(5), undefined);
	assert.equal(await lookup.get(5), 'value:5:2');
	assert.equal(calls, 2);
	assert.equal(lookup.stats.memoryHits, 1);
	assert.equal(lookup.stats.cacheHits, 1);
	assert.equal(lookup.stats.misses, 2);
});

test('cache codecs can wrap adapters and encrypt redis-valkey payloads as an extension', async () => {
	assert.throws(() => createAesGcmCacheCodec(null as any), /options must be a plain object/);
	assert.throws(() => createAesGcmCacheCodec({ key: 1 as any }), /key must be a string or bytes/);
	assert.throws(() => createAesGcmCacheCodec({ key: 'short-key' }), /32 bytes/);
	assert.throws(() => createAesGcmCacheCodec({ key: Buffer.alloc(32), version: 1 as any }), /payload version must be a string/);
	assert.throws(() => createAesGcmCacheCodec({ key: Buffer.alloc(32), version: '' }), /payload version/);
	assert.throws(() => createAesGcmCacheCodec({ key: Buffer.alloc(32), version: 'v1:extra' }), /payload version/);
	assert.throws(() => createAesGcmCacheCodec({ key: Buffer.alloc(32), aad: 1 as any }), /AAD must be a string or bytes/);
	assert.throws(
		() => createAesGcmCacheCodec({ key: Buffer.alloc(32), randomBytes: 1 as any }),
		/randomBytes must be a function/
	);
	const nonBytesIvCodec = createAesGcmCacheCodec({
		key: Buffer.alloc(32, 8),
		randomBytes: () => 1 as any
	});
	assert.throws(
		() => nonBytesIvCodec.encode({ id: 1 }, { key: 'account:bad', operation: 'set' }),
		/IV must be a string or bytes/
	);
	const badIvCodec = createAesGcmCacheCodec({
		key: Buffer.alloc(32, 8),
		randomBytes: () => Buffer.alloc(8)
	});
	await assert.rejects(
		async () => await badIvCodec.encode({ id: 1 }, { key: 'account:bad', operation: 'set' }),
		/IV must be exactly 12 bytes/
	);
	const codec = createAesGcmCacheCodec({
		key: Buffer.alloc(32, 7),
		randomBytes: (size) => Buffer.alloc(size, 1)
	});
	assert.throws(
		() => codec.encode({ id: 1 }, null as any),
		/AES-GCM cache codec encode context must be an object with a cache key/
	);
	assert.throws(
		() => codec.encode({ id: 1 }, { key: 'bad\0key', operation: 'set' }),
		/AES-GCM cache codec encode context\.key must not contain null bytes/
	);
	assert.throws(
		() => codec.encode({ seenAt: new Date('2026-05-18T00:00:00.000Z') }, { key: 'account:bad', operation: 'set' }),
		/Cache values cannot contain Date/
	);
	assert.throws(
		() => codec.decode('v1:a:b:c', { key: 'bad\0key', operation: 'get' }),
		/AES-GCM cache codec decode context\.key must not contain null bytes/
	);
	assert.throws(
		() => codec.decode('v1:a:b:c:d', { key: 'account:bad', operation: 'get' }),
		(error: unknown) => error instanceof ActiveTsValidationError && /payload format/.test(error.message)
	);
	assert.throws(
		() => codec.decode('v2:a:b:c', { key: 'account:bad', operation: 'get' }),
		(error: unknown) => error instanceof ActiveTsValidationError && /payload version/.test(error.message)
	);
	assert.throws(
		() => codec.decode('v1:bad:bad:bad', { key: 'account:bad', operation: 'get' }),
		(error: unknown) => error instanceof ActiveTsValidationError && /Failed to decode/.test(error.message)
	);
	const rawCache = new MemoryCacheAdapter();
	const codedCache = createCodecCacheAdapter(rawCache, codec);

	await codedCache.setMany([['account:1', { id: 1, secret: 'plain' }]]);
	const rawSnapshot = rawCache.snapshot() as Record<string, { value: string }>;
	assert.equal(typeof rawSnapshot['account:1'].value, 'string');
	assert.doesNotMatch(rawSnapshot['account:1'].value, /plain/);
	assert.deepEqual(await codedCache.getMany(['account:1']), [{ id: 1, secret: 'plain' }]);
	await assert.rejects(
		() => codedCache.setMany([['account:bad-date', { seenAt: new Date('2026-05-14T00:00:00.000Z') }]]),
		/cannot contain Date/
	);

	const redisValues = new Map<string, string | Buffer>();
	const client = {
		mGet: async (keys: string[]) => keys.map((key) => redisValues.get(key) ?? null),
		mSet: async (entries: Record<string, string | Buffer>) => {
			for (const [key, value] of Object.entries(entries)) redisValues.set(key, value);
			return 'OK';
		},
		multi: () => {
			const commands: Array<[string, string | Buffer]> = [];
			return {
				set(key: string, value: string | Buffer) {
					commands.push([key, value]);
					return this;
				},
				async exec() {
					for (const [key, value] of commands) redisValues.set(key, value);
					return commands.map(() => 'OK');
				}
			};
		},
		del: async (keys: string[]) => {
			let deleted = 0;
			keys.forEach((key) => {
				if (redisValues.delete(key)) deleted++;
			});
			return deleted;
		}
	};
	const redis = await createRedisValkeyCacheAdapter({
		client,
		prefix: 'app:',
		codec
	});

	await redis.setMany([['account:1', { id: 1, secret: 'plain' }]], { ttl: 60 });
	const stored = redisValues.get(redis.codecKey!('account:1'));
	assert.equal(typeof stored, 'string');
	assert.doesNotMatch(String(stored), /plain/);
	assert.deepEqual(await redis.getMany(['account:1']), [{ id: 1, secret: 'plain' }]);
	await assert.rejects(
		() => redis.setMany([['account:bad-date', { seenAt: new Date('2026-05-14T00:00:00.000Z') }]]),
		/cannot contain Date/
	);
	await redis.deleteMany(['account:1']);
	assert.deepEqual(await redis.getMany(['account:1']), [undefined]);

	const prefixedWithoutDelimiter = await createRedisValkeyCacheAdapter({ client, prefix: 'tenant' });
	await prefixedWithoutDelimiter.setMany([['account:2', { id: 2 }]]);
	assert.ok(redisValues.has(prefixedWithoutDelimiter.codecKey!('account:2')));
	await assert.rejects(
		() => createRedisValkeyCacheAdapter({ client, prefix: 'bad\0prefix' }),
		/redis-valkey cache prefix/
	);
	await assert.rejects(
		() => createRedisValkeyCacheAdapter(Object.assign(Object.create({}), { client }) as any),
		/redis-valkey cache options must be a plain object/
	);
});

test('field codecs and query scopes transform stored data and constrain queries', async () => {
	const { store } = setup();
	const record = await SecureRecord.create({
		id: 1,
		tenantId: 'tenant-a',
		email: 'a@example.com',
		secret: FIELD_CODEC_VALUE
	});
	await SecureRecord.create({
		id: 2,
		tenantId: 'tenant-b',
		email: 'b@example.com',
		secret: FIELD_CODEC_OTHER_VALUE
	});

	assert.equal(record.data.secret, FIELD_CODEC_VALUE);
	const stored = store.snapshot('secure_record') as SecureData[];
	const storedRecord = stored.find((item) => item.id === 1);
	assert.equal(storedRecord?.secret, Buffer.from(FIELD_CODEC_VALUE, 'utf8').toString('base64url'));

	const loaded = await SecureRecord.find(1).load();
	assert.equal(loaded?.data.secret, FIELD_CODEC_VALUE);

	const scoped = await SecureRecord.scope('tenant', { tenantId: 'tenant-a' }).load();
	assert.deepEqual(
		scoped.list.map((item) => item.data.id),
		[1]
	);
	await assert.rejects(
		() => SecureRecord.where({ secret: FIELD_CODEC_VALUE }).load(),
		/does not support portable query operands/
	);

	const scopedOr = await SecureRecord.scope('tenant', { tenantId: 'tenant-a' })
		.whereAny({ email: 'missing@example.com' }, { email: 'b@example.com' })
		.load();
	assert.deepEqual(scopedOr.list, []);

	assert.throws(
		() => SecureRecord.where({ tenantId: 'tenant-a' }).orWhere({ email: 'b@example.com' }),
		/orWhere\(\) cannot be chained/
	);
});

test('adapter middleware wraps store, cache, and search adapters', async () => {
	const events: string[] = [];
	const updateArgs: unknown[][] = [];
	const store = createStoreMiddlewareAdapter(new MemoryStoreAdapter(), [
		async (ctx, next) => {
			events.push(`store:${ctx.operation}:before`);
			if (ctx.operation === 'update') updateArgs.push(ctx.args);
			const result = await next();
			events.push(`store:${ctx.operation}:after`);
			return result;
		}
	]);
	const cache = createCacheMiddlewareAdapter(new MemoryCacheAdapter(), [
		async (ctx, next) => {
			events.push(`cache:${ctx.operation}`);
			return await next();
		}
	]);
	const search = createSearchMiddlewareAdapter(new MemorySearchAdapter(), [
		async (ctx, next) => {
			events.push(`search:${ctx.operation}`);
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	setDefaultContext(context);

	await Account.create({ id: 91, handle: 'mw' });
	await Account.find(91).load();
	await Account.where({ handle: 'mw' }).load();
	await search.index(context.meta(Account), 91, { id: 91, handle: 'mw' });
	await Account.search('mw').load();
	const locked = await VersionedRecord.create({ id: 92, value: 'mw-lock', version: 1 });
	locked.data.value = 'mw-lock-updated';
	await locked.save();

	assert.ok(events.includes('store:create:before'));
	assert.ok(events.includes('store:getMany:after'));
	assert.ok(events.includes('store:query:after'));
	assert.ok(events.includes('cache:getMany'));
	assert.ok(events.includes('search:index'));
	assert.ok(events.includes('search:search'));
	assert.equal((updateArgs.at(-1)?.[2] as any)?.expectedVersion, 1);

	const lateStoreLayers: Parameters<typeof createStoreMiddlewareAdapter>[1] = [];
	const snapshottedStore = createStoreMiddlewareAdapter(new MemoryStoreAdapter(), lateStoreLayers);
	lateStoreLayers.push(async () => {
		throw new Error('late store middleware should not run');
	});
	const meta = context.meta(Account);
	const snapshotValidatingStore = createStoreMiddlewareAdapter(new MemoryStoreAdapter(), [
		async () => {
			throw new Error('invalid snapshot middleware call should fail before middleware execution');
		}
	]);
	let middlewareArgReads = 0;
	const accessorNativePayload = Object.defineProperty({}, 'filter', {
		enumerable: true,
		get() {
			middlewareArgReads++;
			return { id: 1 };
		}
	});
	await assert.rejects(
		() => snapshotValidatingStore.get(meta, 91, { native: accessorNativePayload }),
		/store middleware get options\.native\.filter must be a data property/
	);
	assert.equal(middlewareArgReads, 0);
	await snapshottedStore.create(meta, 501, { id: 501, handle: 'snapshot' });
	assert.equal((await snapshottedStore.get(meta, 501))?.handle, 'snapshot');
	const mutableBaseStore = new MemoryStoreAdapter();
	const mutableStore = createStoreMiddlewareAdapter(mutableBaseStore, []);
	await mutableBaseStore.seed('account', [{ id: 502, handle: 'snapshotted-method' }]);
	(mutableBaseStore as any).get = async () => {
		throw new Error('mutated store get should not run');
	};
	assert.equal((await mutableStore.get(meta, 502))?.handle, 'snapshotted-method');
	const nonEnumerableStore = new MemoryStoreAdapter();
	const schemaCalls: string[] = [];
	const schema = {
		plan: async () => {
			schemaCalls.push('plan:original');
			return { adapter: 'non-enumerable-store', changes: [] };
		},
		apply: async () => {
			schemaCalls.push('apply:original');
			return { adapter: 'non-enumerable-store', changes: [], status: 'applied' as const };
		}
	};
	Object.defineProperty(nonEnumerableStore, 'capabilities', {
		value: { select: true, aggregate: true },
		enumerable: true
	});
	Object.defineProperty(nonEnumerableStore, 'schema', {
		value: schema,
		enumerable: false
	});
	const nonEnumerableWrappedStore = createStoreMiddlewareAdapter(nonEnumerableStore, []);
	assert.deepEqual(nonEnumerableWrappedStore.capabilities, { select: true, aggregate: true });
	schema.plan = async () => {
		throw new Error('mutated schema plan should not run');
	};
	schema.apply = async () => {
		throw new Error('mutated schema apply should not run');
	};
	assert.equal((await nonEnumerableWrappedStore.schema!.plan([meta])).adapter, 'non-enumerable-store');
	assert.equal((await nonEnumerableWrappedStore.schema!.apply([meta], { mode: 'safe' })).status, 'applied');
	assert.deepEqual(schemaCalls, ['plan:original', 'apply:original']);
	assert.notEqual(nonEnumerableWrappedStore.schema, schema);
	const nonEnumerableSearch = new MemorySearchAdapter();
	const syncSchemaCalls: string[] = [];
	const syncSchema = async () => {
		syncSchemaCalls.push('sync:original');
		return { adapter: 'non-enumerable-search', changes: [] };
	};
	Object.defineProperty(nonEnumerableSearch, 'capabilities', {
		value: { where: true, index: true },
		enumerable: true
	});
	Object.defineProperty(nonEnumerableSearch, 'syncSchema', {
		value: syncSchema,
		enumerable: false,
		configurable: true
	});
	const nonEnumerableWrappedSearch = createSearchMiddlewareAdapter(nonEnumerableSearch, []);
	assert.deepEqual(nonEnumerableWrappedSearch.capabilities, { where: true, index: true });
	Object.defineProperty(nonEnumerableSearch, 'syncSchema', {
		value: async () => {
			throw new Error('mutated sync schema should not run');
		},
		enumerable: false,
		configurable: true
	});
	assert.equal((await nonEnumerableWrappedSearch.syncSchema!([meta])).adapter, 'non-enumerable-search');
	assert.deepEqual(syncSchemaCalls, ['sync:original']);
	const liveCapabilityStore = new MemoryStoreAdapter();
	const snapshottedCapabilityStore = createStoreMiddlewareAdapter(liveCapabilityStore, []);
	(liveCapabilityStore.capabilities as any).or = false;
	(liveCapabilityStore.capabilities as any).aggregate = false;
	assert.equal(snapshottedCapabilityStore.capabilities?.or, true);
	assert.equal(snapshottedCapabilityStore.capabilities?.aggregate, true);
	assert.equal(Object.isFrozen(snapshottedCapabilityStore.capabilities), true);
	const liveCapabilitySearch = new MemorySearchAdapter();
	const snapshottedCapabilitySearch = createSearchMiddlewareAdapter(liveCapabilitySearch, []);
	(liveCapabilitySearch.capabilities as any).where = false;
	(liveCapabilitySearch.capabilities.whereOperators as any).textContains = false;
	assert.equal(snapshottedCapabilitySearch.capabilities?.where, true);
	assert.equal(snapshottedCapabilitySearch.capabilities?.whereOperators?.textContains, true);
	assert.equal(Object.isFrozen(snapshottedCapabilitySearch.capabilities?.whereOperators), true);
	assert.throws(
		() => createStoreMiddlewareAdapter(null as any, []),
		/store middleware adapter must be an adapter object/
	);
	assert.throws(
		() => createStoreMiddlewareAdapter({ kind: 'bad-store', get: async () => null } as any, []),
		/store middleware adapter\.getMany must be a function/
	);
	let accessorReads = 0;
	const accessorStore = {
		kind: 'accessor-store',
		getMany: async () => [],
		query: async () => ({ list: [] }),
		create: async () => {},
		update: async () => {},
		delete: async () => {}
	} as any;
	Object.defineProperty(accessorStore, 'get', {
		enumerable: true,
		get() {
			accessorReads++;
			return async () => null;
		}
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(accessorStore, []),
		/store middleware adapter\.get must be a data property/
	);
	assert.equal(accessorReads, 0);
	const accessorCapabilityStore = new MemoryStoreAdapter() as any;
	Object.defineProperty(accessorCapabilityStore, 'capabilities', {
		enumerable: true,
		configurable: true,
		value: Object.defineProperty({}, 'or', {
			enumerable: true,
			get() {
				accessorReads++;
				return true;
			}
		})
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(accessorCapabilityStore, []),
		/store middleware adapter\.capabilities\.or must be a data property/
	);
	assert.equal(accessorReads, 0);
	assert.throws(
		() => createCacheMiddlewareAdapter({ kind: 'bad-cache', getMany: async () => [] } as any, []),
		/cache middleware adapter\.setMany must be a function/
	);
	assert.throws(
		() => createSearchMiddlewareAdapter({ kind: 'bad-search', search: async () => ({ list: [] }) } as any, []),
		/search middleware adapter\.index must be a function/
	);
	const defineObjectPrototypeValue = (property: string, value: unknown) => {
		const descriptor = Object.create(null) as PropertyDescriptor;
		descriptor.value = value;
		descriptor.configurable = true;
		Object.defineProperty(Object.prototype, property, descriptor);
	};
	try {
		defineObjectPrototypeValue('kind', 'polluted-middleware');
		for (const property of ['get', 'getMany', 'query', 'create', 'update', 'delete', 'setMany', 'search', 'index']) {
			defineObjectPrototypeValue(property, async () => undefined);
		}
		assert.throws(
			() => createStoreMiddlewareAdapter({} as any, []),
			/store middleware adapter\.kind/
		);
		assert.throws(
			() => createCacheMiddlewareAdapter({} as any, []),
			/cache middleware adapter\.kind/
		);
		assert.throws(
			() => createSearchMiddlewareAdapter({} as any, []),
			/search middleware adapter\.kind/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).kind;
		for (const property of ['get', 'getMany', 'query', 'create', 'update', 'delete', 'setMany', 'search', 'index']) {
			delete (Object.prototype as Record<string, unknown>)[property];
		}
	}
	assert.throws(
		() => createStoreMiddlewareAdapter(new MemoryStoreAdapter(), [], 'bad\0kind'),
		/store middleware adapter kind must be a non-empty string/
	);
	assert.throws(
		() => createStoreMiddlewareAdapter(new MemoryStoreAdapter(), [null as any]),
		/store middleware\[0\] must be a function/
	);
	assert.throws(
		() => createCacheMiddlewareAdapter(new MemoryCacheAdapter(), null as any),
		/cache middleware must be an array/
	);
	assert.throws(
		() => createSearchMiddlewareAdapter(new MemorySearchAdapter(), [null as any]),
		/search middleware\[0\] must be a function/
	);
	const middleware = [async (_context: unknown, next: () => Promise<unknown>) => await next()] as any[];
	let iteratorCalls = 0;
	Object.defineProperty(middleware, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom middleware iterator should not run');
		}
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(new MemoryStoreAdapter(), middleware),
		/store middleware cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	const validatingCache = createCacheMiddlewareAdapter(new MemoryCacheAdapter(), [
		async () => {
			throw new Error('invalid cache middleware call should fail before middleware execution');
		}
	]);
	await assert.rejects(
		() => validatingCache.setMany(null as any),
		/cache middleware setMany entries must be an array/
	);
	await assert.rejects(
		() => validatingCache.setMany(['bad-entry'] as any),
		/cache middleware setMany entries\[0\] must be a \[key, value\] tuple/
	);
	await assert.rejects(
		() => validatingCache.setMany([['key', 'value', 'extra'] as any]),
		/cache middleware setMany entries\[0\] must be a \[key, value\] tuple/
	);
	await assert.rejects(
		() => validatingCache.setMany([['key', undefined]] as any),
		/Cache values cannot be undefined/
	);
	await assert.rejects(
		() => validatingCache.setMany([['key', { createdAt: new Date() }]] as any),
		/Cache values cannot contain Date/
	);
	await assert.rejects(
		() => validatingCache.setMany([['key', 'value']], { ttl: 0 }),
		/cache middleware setMany options\.ttl "0" must be a positive number/
	);
	let cacheOptionReads = 0;
	const accessorCacheOptions = Object.defineProperty({}, 'ttl', {
		enumerable: true,
		get() {
			cacheOptionReads++;
			return 30;
		}
	});
	await assert.rejects(
		() => validatingCache.setMany([['key', 'value']], accessorCacheOptions),
		/cache middleware setMany options\.ttl must be a data property/
	);
	assert.equal(cacheOptionReads, 0);
	await assert.rejects(
		() => validatingCache.getMany([{} as any]),
		/cache middleware getMany keys\[0\] must be a string/
	);
	const shortCache = createCacheMiddlewareAdapter(
		{
			kind: 'short-cache',
			getMany: async () => [],
			setMany: async () => {},
			deleteMany: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => shortCache.getMany(['key']),
		/cache middleware adapter "short-cache\+middleware" getMany result must be an array with 1 entries/
	);
	const sparseCache = createCacheMiddlewareAdapter(
		{
			kind: 'sparse-cache',
			getMany: async () => new Array(1) as any,
			setMany: async () => {},
			deleteMany: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => sparseCache.getMany(['key']),
		/cache middleware adapter "sparse-cache\+middleware" getMany result\[0\] is missing/
	);
	const unsafeCache = createCacheMiddlewareAdapter(
		{
			kind: 'unsafe-cache',
			getMany: async () => [{ createdAt: new Date('2026-05-18T00:00:00.000Z') }],
			setMany: async () => {},
			deleteMany: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => unsafeCache.getMany(['key']),
		/cache middleware adapter "unsafe-cache\+middleware" getMany result\[0\].createdAt/
	);
	const cachedObject = { nested: { value: 'cached' } };
	const cloningCache = createCacheMiddlewareAdapter(
		{
			kind: 'cloning-cache',
			getMany: async () => [cachedObject],
			setMany: async () => {},
			deleteMany: async () => {}
		},
		[]
	);
	const [cacheHit] = await cloningCache.getMany(['key']);
	(cacheHit as any).nested.value = 'mutated';
	assert.equal(cachedObject.nested.value, 'cached');
	const malformedSearch = createSearchMiddlewareAdapter(
		{
			kind: 'malformed-search',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: new Array(1) }) as any,
			index: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => malformedSearch.search(meta, 'query', {}),
		/search middleware adapter "malformed-search\+middleware" search result\.list\[0\] is missing/
	);
	const negativeTotalSearch = createSearchMiddlewareAdapter(
		{
			kind: 'negative-total-search',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [], total: -1 }),
			index: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => negativeTotalSearch.search(meta, 'query', {}),
		/search middleware adapter "negative-total-search\+middleware" search result\.total must be a non-negative safe integer/
	);
	const lowTotalSearch = createSearchMiddlewareAdapter(
		{
			kind: 'low-total-search',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [{ id: 1, name: 'one' }], total: 0 }),
			index: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => lowTotalSearch.search(meta, 'query', {}),
		/search middleware adapter "low-total-search\+middleware" search result\.total cannot be smaller than result\.list length/
	);
	const fractionalTotalSearch = createSearchMiddlewareAdapter(
		{
			kind: 'fractional-total-search',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [], total: 1.5 }),
			index: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => fractionalTotalSearch.search(meta, 'query', {}),
		/search middleware adapter "fractional-total-search\+middleware" search result\.total must be a non-negative safe integer/
	);
	const inputValidatingSearch = createSearchMiddlewareAdapter(new MemorySearchAdapter(), [
		() => {
			throw new Error('invalid search middleware input should fail before middleware execution');
		}
	]);
	await assert.rejects(
		() => inputValidatingSearch.search(meta, {} as any, {}),
		/search middleware query must be a string/
	);
	await assert.rejects(
		() => inputValidatingSearch.search(meta, 'query', { limit: -1 }),
		/search middleware options limit "-1" must be a positive safe integer/
	);
	let shortCircuitSearchCalls = 0;
	const shortCircuitSearch = createSearchMiddlewareAdapter(
		{
			kind: 'short-circuit-search',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [] }),
			index: async () => {},
			delete: async () => {}
		},
		[
			async () => {
				shortCircuitSearchCalls++;
				return { list: [] };
			}
		]
	);
	await assert.rejects(
		() => shortCircuitSearch.search(meta, 'query', { where: { id: 1 } }),
		/Search adapter "short-circuit-search\+middleware" does not support where\(\) filters/
	);
	await assert.rejects(
		() => shortCircuitSearch.search(meta, 'query', { cursor: 'next' }),
		/Search adapter "short-circuit-search\+middleware" does not support cursor pagination/
	);
	await assert.rejects(
		() => shortCircuitSearch.search(meta, 'query', { native: { query: { match_all: {} } } }),
		/Search adapter "short-circuit-search\+middleware" does not support native search options/
	);
	assert.equal(shortCircuitSearchCalls, 0);
	await assert.rejects(
		() => inputValidatingSearch.index(meta, {} as any, { id: 1 }),
		/search middleware index id must be a string or safe integer/
	);
	await assert.rejects(
		() => inputValidatingSearch.index(meta, 1, [] as any),
		/search middleware index data must be a plain object/
	);
	let shortCircuitIndexCalls = 0;
	const shortCircuitIndex = createSearchMiddlewareAdapter(new MemorySearchAdapter(), [
		async () => {
			shortCircuitIndexCalls++;
		}
	]);
	await assert.rejects(
		() => shortCircuitIndex.index(meta, 1, { id: 2, handle: 'mismatch' }),
		/account\.id search document id must match the indexed id/
	);
	assert.equal(shortCircuitIndexCalls, 0);
	await assert.rejects(
		() => inputValidatingSearch.delete(meta, Number.NaN as any),
		/search middleware delete id "NaN" must be a safe integer/
	);
	const malformedQueryStore = createStoreMiddlewareAdapter(
		{
			kind: 'malformed-query-store',
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: new Array(1) }) as any,
			create: async () => {},
			update: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => malformedQueryStore.query(meta, { where: [], or: [], sort: [], include: [] }),
		/store middleware adapter "malformed-query-store\+middleware" query result\.list\[0\] is missing/
	);
	const accessorQueryResultStore = createStoreMiddlewareAdapter(
		{
			kind: 'accessor-query-result-store',
			get: async () => null,
			getMany: async () => [],
			query: async () =>
				Object.defineProperty({ more: false }, 'list', {
					enumerable: true,
					get() {
						accessorReads++;
						return [];
					}
				}) as any,
			create: async () => {},
			update: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => accessorQueryResultStore.query(meta, { where: [], or: [], sort: [], include: [] }),
		/store middleware adapter "accessor-query-result-store\+middleware" query result\.list must be a data property/
	);
	assert.equal(accessorReads, 0);
	const malformedReadStore = createStoreMiddlewareAdapter(
		{
			kind: 'malformed-read-store',
			get: async () => [] as any,
			getMany: async () => new Array(1) as any,
			query: async () => ({ list: [] }),
			create: async () => {},
			update: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => malformedReadStore.get(meta, 1),
		/store middleware adapter "malformed-read-store\+middleware" get result/
	);
	await assert.rejects(
		() => malformedReadStore.getMany(meta, [1]),
		/store middleware adapter "malformed-read-store\+middleware" getMany result\[0\] is missing/
	);
	let inputValidatingStoreCalls = 0;
	const inputValidatingStore = createStoreMiddlewareAdapter(new MemoryStoreAdapter(), [
		() => {
			inputValidatingStoreCalls++;
			throw new Error('invalid store middleware input should fail before middleware execution');
		}
	]);
	await assert.rejects(
		() => inputValidatingStore.get(meta, {} as any),
		/store middleware get id must be a string or safe integer/
	);
	await assert.rejects(
		() => inputValidatingStore.getMany(meta, new Array(1) as any),
		/store middleware getMany ids\[0\] is missing/
	);
	await assert.rejects(
		() => inputValidatingStore.query(meta, null as any),
		/store middleware query plan must be a plain object/
	);
	await assert.rejects(
		() => inputValidatingStore.query(meta, { where: [], or: [], sort: [], include: [] }, { select: new Array(1) } as any),
		/store middleware query options\.select\[0\] is missing/
	);
	await assert.rejects(
		() =>
			inputValidatingStore.query(meta, { where: [], or: [], sort: [], include: [], select: ['id'] } as any, {
				select: ['handle']
			}),
		/store middleware query options\.select must match the query plan select fields/
	);
	await assert.rejects(
		() => inputValidatingStore.create(meta, 1, [] as any),
		/store middleware create data must be a plain object/
	);
	await assert.rejects(
		() => inputValidatingStore.create(meta, 1, { id: 1, createdAt: new Date() } as any),
		/Unsupported stored data date/
	);
	await assert.rejects(
		() => inputValidatingStore.create(meta, 1, { id: 2, handle: 'wrong-id' } as any),
		/store middleware create data id field "id" must match the operation id/
	);
	await assert.rejects(
		() => inputValidatingStore.update(meta, 1, { id: 2, handle: 'wrong-id' } as any),
		/store middleware update data id field "id" must match the operation id/
	);
	await assert.rejects(
		() => inputValidatingStore.update(meta, 1, { id: 1 }, { expectedVersion: -1 }),
		/store middleware update options\.expectedVersion must be a non-negative safe integer/
	);
	await assert.rejects(
		() => inputValidatingStore.delete(meta, Number.NaN as any),
		/store middleware delete id "NaN" must be a safe integer/
	);
	await assert.rejects(
		() => inputValidatingStore.aggregate!(meta, null as any),
		/store middleware aggregate plan must be a plain object/
	);
	assert.equal(inputValidatingStoreCalls, 0);
	let shortCircuitStoreCalls = 0;
	const shortCircuitStore = createStoreMiddlewareAdapter(
		{
			kind: 'short-circuit-store',
			capabilities: {},
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			aggregate: async () => ({ total: 0 }),
			create: async () => {},
			update: async () => {},
			delete: async () => {}
		},
		[
			async () => {
				shortCircuitStoreCalls++;
				return { list: [] };
			}
		]
	);
	await assert.rejects(
		() =>
			shortCircuitStore.query(meta, {
				where: [],
				or: [{ where: [{ field: 'id', op: '=', value: 1 }], or: [], sort: [], include: [] }],
				sort: [],
				include: []
			} as any),
		/Store adapter "short-circuit-store\+middleware" does not support orWhere/
	);
	await assert.rejects(
		() =>
			shortCircuitStore.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'total' }]
			}),
		/Store adapter "short-circuit-store\+middleware" does not support aggregate queries/
	);
	assert.equal(shortCircuitStoreCalls, 0);
	const malformedAggregateStore = createStoreMiddlewareAdapter(
		{
			kind: 'malformed-aggregate-store',
			capabilities: { aggregate: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			aggregate: async () => ({ total: Number.NaN }),
			create: async () => {},
			update: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => malformedAggregateStore.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'total' }]
		}),
		/store middleware adapter "malformed-aggregate-store\+middleware" aggregate "total" expected a finite numeric result/
	);
	const nullAggregateStore = createStoreMiddlewareAdapter(
		{
			kind: 'null-aggregate-store',
			capabilities: { aggregate: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			aggregate: async () => null as any,
			create: async () => {},
			update: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => nullAggregateStore.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'total' }]
		}),
		/store middleware adapter "null-aggregate-store\+middleware" aggregate result must be a plain object/
	);
	const inheritedAggregateStore = createStoreMiddlewareAdapter(
		{
			kind: 'inherited-aggregate-store',
			capabilities: { aggregate: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			aggregate: async () => Object.create({ total: 99 }) as any,
			create: async () => {},
			update: async () => {},
			delete: async () => {}
		},
		[]
	);
	await assert.rejects(
		() => inheritedAggregateStore.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'total' }]
		}),
		/store middleware adapter "inherited-aggregate-store\+middleware" aggregate result must be a plain object/
	);
	const throwingStore = createStoreMiddlewareAdapter(new MemoryStoreAdapter(), [
		() => {
			throw new Error('sync store middleware failure');
		}
	]);
	const throwingCache = createCacheMiddlewareAdapter(new MemoryCacheAdapter(), [
		() => {
			throw new Error('sync cache middleware failure');
		}
	]);
	const throwingSearch = createSearchMiddlewareAdapter(new MemorySearchAdapter(), [
		() => {
			throw new Error('sync search middleware failure');
		}
	]);
	await assert.rejects(() => throwingStore.get(meta, 1), /sync store middleware failure/);
	await assert.rejects(() => throwingCache.getMany(['key']), /sync cache middleware failure/);
	await assert.rejects(() => throwingSearch.search(meta, 'query', {}), /sync search middleware failure/);
});

test('query planner routes queries, aggregates, and searches to selected adapters', async () => {
	const primary = new MemoryStoreAdapter();
	const replica = new MemoryStoreAdapter();
	const searchA = new MemorySearchAdapter();
	const searchB = new MemorySearchAdapter();
	await primary.seed('account', [{ id: 1, handle: 'primary', score: 1 }]);
	await replica.seed('account', [{ id: 1, handle: 'replica', score: 5 }]);
	const context = createActiveTs({
		stores: { default: primary, replica },
		search: { memory: searchA, routed: searchB },
		defaultSearch: 'memory',
		queryPlanner: {
			routeQuery: () => 'replica',
			routeAggregate: () => 'replica',
			routeSearch: () => 'routed'
		}
	});
	setDefaultContext(context);
	await searchB.index(context.meta(Account), 1, { id: 1, handle: 'from-search' });

	const queried = await Account.query().load();
	assert.equal(queried.list[0].data.handle, 'replica');
	assert.equal(await Account.sum('score'), 5);
	const searched = await Account.search('from').load();
	assert.equal(searched.list[0].data.handle, 'from-search');
	assert.equal(primary.stats.query, 0);
	assert.equal(replica.stats.query, 1);
	assert.equal(replica.stats.aggregate, 1);
});

test('transactions rollback memory writes and outbox events publish after commit', async () => {
	const outbox = new MemoryOutboxAdapter();
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'event-1' })]
	});
	setDefaultContext(context);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await Account.create({ id: 201, handle: 'rollback' }, tx);
				throw new Error('rollback');
			}),
		/rollback/
	);
	assert.equal(await Account.find(201).load(), null);
	assert.deepEqual(await outbox.list(), []);

	await context.transaction(async (tx) => {
		await Account.create({ id: 202, handle: 'commit' }, tx);
	});
	const events = await outbox.list();
	assert.equal(events.length, 1);
	assert.equal(events[0].model, 'account');
	assert.equal(events[0].modelId, 202);
	assert.equal(events[0].operation, 'create');
	assert.equal(events[0].data.handle, 'commit');
});

test('transaction afterCommit callbacks run after the store commits', async () => {
	const events: string[] = [];
	const store = new OrderedTransactionStore(events);
	const context = createActiveTs({ stores: { default: store } });

	await context.transaction(async (tx) => {
		await tx.afterCommit(() => {
			events.push('afterCommit');
		});
		await Account.create({ id: 701, handle: 'after-commit' }, tx);
	});

	assert.deepEqual(events, ['begin', 'commit', 'afterCommit']);
});

test('outbox search sync worker indexes drained events', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'search-event' })]
	});
	setDefaultContext(context);

	await Account.create({ id: 301, handle: 'sync-search' });
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [Account], context }), 1);

	const result = await search.search(context.meta(Account), 'sync-search', {});
	assert.equal(result.list[0].handle, 'sync-search');
	assert.deepEqual(await outbox.list(), []);
});

test('outbox search sync worker uses resolved model metadata', async () => {
	const outbox = new MemoryOutboxAdapter();
	const seen: any[] = [];
	const search = new MemorySearchAdapter();
	const wrappedSearch = createSearchMiddlewareAdapter(search, [
		async (ctx, next) => {
			if (ctx.operation === 'index') seen.push(ctx.model);
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'slug-event' })]
	});
	setDefaultContext(context);

	await SlugSearchRecord.create({ slug: 'post-1', title: 'Resolved metadata', body: 'hidden body' });
	assert.equal(await runSearchSyncWorker({ outbox, search: wrappedSearch, models: [SlugSearchRecord], context }), 1);
	assert.equal(seen[0].idField, 'slug');
	assert.deepEqual(seen[0].searchIndexes.flatMap((index: any) => index.fields), ['title']);
	assert.equal((await search.search(context.meta(SlugSearchRecord), 'metadata', {})).list.length, 1);
	assert.equal((await search.search(context.meta(SlugSearchRecord), 'hidden', {})).list.length, 0);
});

test('outbox search sync worker requeues undelivered events on failure', async () => {
	const outbox = new MemoryOutboxAdapter();
	const store = new MemoryStoreAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'retry-event' })]
	});
	setDefaultContext(context);

	await Account.create({ id: 302, handle: 'retry-search' });
	let fail = true;
	const flakySearch = createSearchMiddlewareAdapter(search, [
		async (ctx, next) => {
			if (ctx.operation === 'index' && fail) {
				fail = false;
				throw new Error('search unavailable');
			}
			return await next();
		}
	]);
	const flakyContext = createActiveTs({
		stores: { default: store },
		search: { memory: flakySearch },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'retry-event' })]
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: flakySearch, models: [Account], context: flakyContext }),
		/search unavailable/
	);
	const requeued = await outbox.list();
	assert.equal(requeued.length, 1);
	assert.equal(requeued[0].modelId, 302);

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [Account], context }), 1);
	assert.deepEqual(await outbox.list(), []);
	const indexed = await search.search(context.meta(Account), 'retry', {});
	assert.deepEqual(indexed.list.map((item) => item.id), [302]);
});

test('function cache coalesces concurrent misses with singleflight', async () => {
	setup();
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const cache = createFunctionCache<number, string>({
		prefix: 'singleflight',
		factory: async (id) => {
			calls++;
			await gate;
			return `value:${id}`;
		}
	});

	const first = cache.get(1);
	const second = cache.get(1);
	release();
	assert.deepEqual(await Promise.all([first, second]), ['value:1', 'value:1']);
	assert.equal(calls, 1);
});

test('function cache default keys are stable for object property order', async () => {
	let calls = 0;
	const cache = createFunctionCache<Record<string, unknown>, string>({
		prefix: 'stable-object',
		cache: false,
		factory: async (input) => {
			calls++;
			return Object.keys(input).join(',');
		}
	});

	const first = await cache.get({ b: 2, a: 1 });
	const second = await cache.get({ a: 1, b: 2 });

	assert.equal(first, second);
	assert.equal(calls, 1);
});

test('cache policies support tenant key namespaces and stale refresh', async () => {
	const store = new CountingStore();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		cacheKey: ({ baseKey }) => `tenant-a:${baseKey}`
	});
	setDefaultContext(context);
	await store.seed('account', [{ id: 81, handle: 'tenant-cache' }]);
	await Account.find(81).load();
	assert.ok(Object.keys(cache.snapshot()).includes('tenant-a:account:number:81'));

	let now = 0;
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		let calls = 0;
		const lookup = createFunctionCache<number, string>({
			prefix: 'tenant-lookup',
			namespace: 'tenant-a',
			cache: false,
			ttl: 1,
			staleWhileRevalidate: 5,
			factory: async () => `value:${++calls}`
		});
		assert.equal(await lookup.get(1), 'value:1');
		now = 1500;
		assert.equal(await lookup.get(1), 'value:1');
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(await lookup.peek(1), 'value:2');
		assert.ok(Object.keys(lookup.snapshotMemory())[0].startsWith('tenant-lookup:tenant-a:'));
	} finally {
		Date.now = originalNow;
	}
});

test('soft delete plugin scopes queries and helper marks rows', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createSoftDeletePlugin({ models: ['soft_account'], now: () => '2026-05-12T00:00:00.000Z' })]
	});
	setDefaultContext(context);
	await SoftAccount.create({ id: 401, handle: 'live', deletedAt: null });
	await SoftAccount.create({ id: 402, handle: 'deleted', deletedAt: null });
	await softDelete(SoftAccount, 402, context, { now: () => '2026-05-12T00:00:00.000Z' });

	const result = await SoftAccount.query().load();
	assert.deepEqual(
		result.list.map((item) => item.data.handle),
		['live']
	);

	const orResult = await SoftAccount.query().whereAny({ handle: 'missing' }, { handle: 'deleted' }).load();
	assert.deepEqual(orResult.list, []);

	const deleted = await SoftAccount.onlyDeleted().load();
	assert.deepEqual(
		deleted.list.map((item) => item.data.handle),
		['deleted']
	);
	const all = await SoftAccount.withDeleted().orderBy('id').load();
	assert.deepEqual(
		all.list.map((item) => item.data.handle),
		['live', 'deleted']
	);
	await restore(SoftAccount, 402, context);
	const restored = await SoftAccount.query().orderBy('id').load();
	assert.deepEqual(
		restored.list.map((item) => item.data.handle),
		['live', 'deleted']
	);
});

test('version field enables optimistic locking on save', async () => {
	setup();
	const first = await VersionedRecord.create({ id: 1, value: 'first', version: 1 });
	const stale = await VersionedRecord.find(1).load();
	first.data.value = 'updated';
	await first.save();
	assert.equal(first.data.version, 2);

	stale!.data.value = 'stale';
	await assert.rejects(() => stale!.save(), /Optimistic lock failed/);

	await VersionedRecord.create({ id: 2, value: 'parallel', version: 1 });
	const left = await VersionedRecord.find(2).load();
	const right = await VersionedRecord.find(2).load();
	left!.data.value = 'left';
	right!.data.value = 'right';
	const results = await Promise.allSettled([left!.save(), right!.save()]);
	assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
	assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
	assert.equal((await VersionedRecord.find(2).load())?.data.version, 2);

	const ambiguousStore = new MemoryStoreAdapter();
	Object.assign(ambiguousStore.capabilities, { optimisticLock: undefined });
	const ambiguousContext = createActiveTs({ stores: { default: ambiguousStore } });
	const AmbiguousVersionedRecord = VersionedRecord.use(ambiguousContext) as unknown as typeof VersionedRecord;
	const ambiguous = await AmbiguousVersionedRecord.create({ id: 3, value: 'ambiguous', version: 1 });
	ambiguous.data.value = 'blocked';
	await assert.rejects(() => ambiguous.save(), /atomic optimistic locking/);

	const pruned = await VersionPruningRecord.create({ id: 4, value: 'pruned', version: 1 });
	pruned.data.value = 'changed';
	await assert.rejects(() => pruned.save(), /Cannot change version field/);
	assert.deepEqual((await VersionPruningRecord.find(4).load())?.data, {
		id: 4,
		value: 'pruned',
		version: 1
	});
});

test('save rejects optimistic version overflow before adapter update', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = VersionedRecord.use(context) as unknown as typeof VersionedRecord;
	const record = await Record.create({ id: 5, value: 'persisted', version: Number.MAX_SAFE_INTEGER });
	record.data.value = 'locally changed';
	const modelBeforeSave = { ...record.data };
	const storeBeforeSave = store.snapshot('versioned_record');
	const updateCallsBeforeSave = store.stats.update;

	await assert.rejects(
		() => record.save(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError && /Cannot increment version field/.test(error.message)
	);
	assert.equal(store.stats.update, updateCallsBeforeSave);
	assert.deepEqual(record.data, modelBeforeSave);
	assert.deepEqual(store.snapshot('versioned_record'), storeBeforeSave);
});

test('version field enables optimistic locking on delete', async () => {
	const store = new MemoryStoreAdapter();
	let raced = false;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'delete-race',
				hooks: {
					async beforeDelete(payload) {
						if (payload.model?.name !== 'versioned_record' || payload.id !== 5 || raced) return;
						raced = true;
						await store.update(
							payload.model,
							5,
							{ id: 5, value: 'newer', version: 2 },
							{ expectedVersion: 1 }
						);
					}
				}
			}
		]
	});
	const Record = VersionedRecord.use(context) as unknown as typeof VersionedRecord;
	await Record.create({ id: 5, value: 'delete-race', version: 1 });

	await assert.rejects(() => Record.delete(5), /Optimistic lock failed/);
	assert.deepEqual((await Record.find(5).load())?.data, {
		id: 5,
		value: 'newer',
		version: 2
	});
});

test('validation adapters normalize third-party parser shapes', () => {
	assert.throws(() => fromTypia(null as any), /fromTypia assertPrune must be a function/);
	assert.throws(() => fromZod(null as any), /fromZod requires a schema/);
	assert.throws(() => fromValibot({}, undefined as any), /fromValibot requires a valibot parse adapter/);
	assert.throws(() => fromValibot({}, { parse: null as any }), /fromValibot requires a valibot parse adapter/);
	assert.throws(() => fromArkType(null as any), /fromArkType schema must be a function/);
	assert.throws(() => fromArkType((input) => input as any, null as any), /fromArkType options must be a plain object/);
	assert.throws(
		() => fromArkType((input) => input as any, { isProblem: null as any }),
		/fromArkType options\.isProblem must be a function/
	);
	assert.throws(
		() => fromArkType((input) => input as any, { isProblem: () => false, typo: true } as any),
		/fromArkType options contains unknown option "typo"/
	);
	Object.defineProperty(Object.prototype, 'parse', {
		value: () => ({ id: 99 }),
		configurable: true
	});
	try {
		assert.throws(() => fromZod({} as any), /fromZod requires a schema/);
		assert.throws(() => fromValibot('schema', {} as any), /fromValibot requires a valibot parse adapter/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).parse;
	}
	let validationReads = 0;
	const accessorZod = Object.defineProperty({}, 'parse', {
		enumerable: true,
		get() {
			validationReads++;
			return () => ({ id: 1 });
		}
	});
	assert.throws(() => fromZod(accessorZod as any), /parse must be a data property/);
	assert.equal(validationReads, 0);
	const hiddenZod = Object.defineProperty({}, 'parse', {
		enumerable: false,
		value: () => ({ id: 1 })
	});
	assert.throws(() => fromZod(hiddenZod as any), /parse must be enumerable/);
	const accessorValibot = Object.defineProperty({}, 'parse', {
		enumerable: true,
		get() {
			validationReads++;
			return () => ({ id: 1 });
		}
	});
	assert.throws(() => fromValibot('schema', accessorValibot as any), /parse must be a data property/);
	assert.equal(validationReads, 0);
	const hiddenValibot = Object.defineProperty({}, 'parse', {
		enumerable: false,
		value: () => ({ id: 1 })
	});
	assert.throws(() => fromValibot('schema', hiddenValibot as any), /parse must be enumerable/);

	const zodSchema = {
		parse(input: unknown) {
			const data = input as { id?: unknown };
			if (typeof data.id !== 'number') throw new Error('bad id');
			return { id: data.id };
		}
	};
	const validator = fromZod<{ id: number }>(zodSchema);
	zodSchema.parse = () => {
		throw new Error('mutated zod parse should not run');
	};

	assert.deepEqual(validator({ id: 1 }), { id: 1 });
	assert.throws(() => validator({ id: '1' }), /bad id/);
	const typia = fromTypia((input: unknown) => input as { id: number });
	assert.deepEqual(typia({ id: 2 }), { id: 2 });
	const valibotAdapter = {
		parse(schema: unknown, input: unknown) {
			assert.equal(schema, 'schema');
			return input as { id: number };
		}
	};
	const valibot = fromValibot('schema', valibotAdapter);
	valibotAdapter.parse = () => {
		throw new Error('mutated valibot parse should not run');
	};
	assert.deepEqual(valibot({ id: 3 }), { id: 3 });
	const ark = fromArkType((input: unknown) => input as { id: number });
	assert.deepEqual(ark({ id: 4 }), { id: 4 });
	const arkDomainProblemField = fromArkType((input: unknown) => input as { id: number; problems: string });
	assert.deepEqual(arkDomainProblemField({ id: 41, problems: 'none' }), { id: 41, problems: 'none' });
	const inheritedProblemsArk = fromArkType(() => {
		const value = Object.create({ problems: 'inherited problem marker' }) as { id: number };
		value.id = 5;
		return value;
	});
	assert.equal(inheritedProblemsArk({ id: 5 }).id, 5);
	const accessorProblemsArk = fromArkType(() =>
		Object.defineProperty({}, 'problems', {
			enumerable: true,
			get() {
				validationReads++;
				return 'accessor ark value';
			}
		}) as any
	);
	assert.throws(
		() => accessorProblemsArk({ id: '4' }),
		/fromArkType result\.problems must be a data property/
	);
	assert.equal(validationReads, 0);
	const hiddenProblemsArk = fromArkType(() =>
		Object.defineProperty({}, 'problems', {
			enumerable: false,
			value: 'hidden ark value'
		}) as any
	);
	assert.throws(
		() => hiddenProblemsArk({ id: '4' }),
		/fromArkType result\.problems must be enumerable/
	);
	const failingArk = fromArkType(() => ({ problems: 'bad ark value' }));
	assert.throws(
		() => failingArk({ id: '4' }),
		(error: unknown) => error instanceof ActiveTsValidationError && /bad ark value/.test(error.message)
	);
	const predicateArk = fromArkType(
		() => ({ id: 6, problems: 'predicate failure', kind: 'ark-errors' }) as any,
		{ isProblem: (result) => (result as any).kind === 'ark-errors' }
	);
	assert.throws(
		() => predicateArk({ id: '6' }),
		(error: unknown) => error instanceof ActiveTsValidationError && /predicate failure/.test(error.message)
	);
	let problemToStringCalls = 0;
	let problemGetterCalls = 0;
	const objectProblemsArk = fromArkType(() => ({
		problems: Object.defineProperty(
			{
				toString() {
					problemToStringCalls++;
					throw new Error('problem toString should not run');
				}
			},
			'details',
			{
				enumerable: true,
				get() {
					problemGetterCalls++;
					throw new Error('problem getter should not run');
				}
			}
		)
	}));
	assert.throws(
		() => objectProblemsArk({ id: '4' }),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			error.message.includes('toString') &&
			error.message.includes('[Getter]')
	);
	assert.equal(problemToStringCalls, 0);
	assert.equal(problemGetterCalls, 0);
});

test('ArkType validation adapter allows domain problem fields through model create and read', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ArkProblemFieldRecord.use(context) as unknown as typeof ArkProblemFieldRecord;

	const created = await Record.create({ id: 1, problems: 'none' });
	assert.deepEqual(created.data, { id: 1, problems: 'none' });
	assert.deepEqual(store.dump('ark_problem_field_record'), [{ id: 1, problems: 'none' }]);

	const loaded = await Record.find(1).load();
	assert.deepEqual(loaded?.data, { id: 1, problems: 'none' });
});

test('schema migration snapshots schema plans without applying them', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	const migration = await context.schemaMigration([QuietAccount, Rank], 'init');

	assert.equal(migration.name, 'init');
	assert.equal(migration.empty, false);
	assert.deepEqual(
		migration.summary,
		['default:create-collection:quiet_account', 'default:create-collection:rank']
	);
	await assert.rejects(() => context.schemaMigration([Account], '../bad'), /migration name/);
});

test('enforces write validation', async () => {
	setup();
	await assert.rejects(
		() => Account.create({ id: 3 } as AccountData),
		/Write validation failed/
	);
});

test('supports decorator relation getter and static schema metadata', async () => {
	const { store } = setup();
	await store.seed('decorated_account', [{ id: 1, handle: 'seo' }]);
	await store.seed('decorated_rank', [{ id: 1, rank: 99, tier: 1 }]);

	const account = await DecoratedAccount.find(1).include('rank').load();
	const rank = await account?.rank;
	assert.equal(Array.isArray(rank) ? undefined : rank?.data.rank, 99);
});

test('decorator metadata helpers reject malformed field lists and preload shapes', () => {
	class BadDecoratorRecord extends Model<AccountData> {}

	assert.throws(
		() => field({ fields: null as any })(BadDecoratorRecord.prototype, 'handle'),
		/index fields must be a non-empty array/
	);
	assert.throws(
		() => field({ fields: [] as any })(BadDecoratorRecord.prototype, 'handle'),
		/index fields must be a non-empty array/
	);
	assert.throws(
		() => field(null as any)(BadDecoratorRecord.prototype, 'handle'),
		/field options must be a plain object/
	);
	assert.throws(
		() => field({ uniq: true } as any)(BadDecoratorRecord.prototype, 'handle'),
		/field options contains unknown option "uniq"/
	);
	let optionReads = 0;
	const accessorFieldOptions = {
		get name() {
			optionReads++;
			return 'handle';
		}
	};
	assert.throws(
		() => field(accessorFieldOptions as any)(BadDecoratorRecord.prototype, 'handle'),
		/field options property "name" must be a data property/
	);
	assert.equal(optionReads, 0);
	const hiddenFieldOptions = Object.defineProperty({}, 'name', {
		enumerable: false,
		value: 'handle'
	});
	assert.throws(
		() => field(hiddenFieldOptions as any)(BadDecoratorRecord.prototype, 'handle'),
		/field options property "name" must be enumerable/
	);
	assert.throws(
		() => field({ name: '' })(BadDecoratorRecord.prototype, 'handle'),
		/index name/
	);
	assert.throws(
		() => typedField('string', { fields: null as any })(BadDecoratorRecord.prototype, 'handle'),
		/index fields must be a non-empty array/
	);
	assert.throws(
		() => typedField('string', { name: '' })(BadDecoratorRecord.prototype, 'handle'),
		/index name/
	);
	assert.throws(
		() => typedField('string', null as any)(BadDecoratorRecord.prototype, 'handle'),
		/typed field options must be a plain object/
	);
	assert.throws(
		() => decoratorIndex(null as any)(BadDecoratorRecord),
		/index fields must be a non-empty array/
	);
	assert.throws(
		() => decoratorIndex(['handle'], null as any)(BadDecoratorRecord),
		/index options must be a plain object/
	);
	assert.throws(
		() => decoratorIndex(['handle'], { fields: ['other'] } as any)(BadDecoratorRecord),
		/index options contains unknown option "fields"/
	);
	assert.throws(
		() => decoratorIndex(['handle'], { [Symbol('index')]: true } as any)(BadDecoratorRecord),
		/index options cannot contain symbol fields/
	);
	assert.throws(
		() => searchIndex([])(BadDecoratorRecord),
		/search fields must be a non-empty array/
	);
	assert.throws(
		() => searchIndex(['handle'], null as any)(BadDecoratorRecord),
		/search index options must be a plain object/
	);
	assert.throws(
		() => searchIndex(['handle'], { adaptor: 'memory' } as any)(BadDecoratorRecord),
		/search index options contains unknown option "adaptor"/
	);
	let arrayMethodCalls = 0;
	const decoratorFields = ['handle'] as any[];
	Object.defineProperty(decoratorFields, 'map', {
		value() {
			arrayMethodCalls++;
			throw new Error('custom decorator map should not run');
		}
	});
	assert.doesNotThrow(() => decoratorIndex(decoratorFields)(BadDecoratorRecord));
	assert.equal(arrayMethodCalls, 0);
	assert.throws(
		() =>
			ref(() => DecoratedRank, { localKey: 'id', foreignKey: 'id', preload: null as any })(
				BadDecoratorRecord.prototype,
				'rank'
			),
		/relation preload must be an array/
	);
	assert.throws(
		() => ref(() => DecoratedRank, null as any)(BadDecoratorRecord.prototype, 'rank'),
		/relation options must be a plain object/
	);
	assert.throws(
		() => ref(() => DecoratedRank, { localKey: 'id', foreignKey: 'id', preloadFields: ['tier'] } as any)(
			BadDecoratorRecord.prototype,
			'rank'
		),
		/relation options contains unknown option "preloadFields"/
	);
	const accessorRelationOptions = {
		get localKey() {
			optionReads++;
			return 'id';
		},
		foreignKey: 'id'
	};
	assert.throws(
		() => ref(() => DecoratedRank, accessorRelationOptions as any)(BadDecoratorRecord.prototype, 'rank'),
		/relation options property "localKey" must be a data property/
	);
	assert.equal(optionReads, 0);
	const decoratorPreload = ['rank'] as any[];
	Object.defineProperty(decoratorPreload, 'map', {
		value() {
			arrayMethodCalls++;
			throw new Error('custom decorator preload map should not run');
		}
	});
	assert.doesNotThrow(() =>
		ref(() => DecoratedRank, { localKey: 'id', foreignKey: 'id', preload: decoratorPreload })(
			BadDecoratorRecord.prototype,
			'rankWithPreload'
		)
	);
	assert.equal(arrayMethodCalls, 0);
	assert.throws(
		() =>
			defineModel<any>({ name: 'bad_warn_relation' }).ref('rank', () => Rank, {
				localKey: 'id',
				foreignKey: 'id',
				warnOnLazy: 'no' as any
			}),
		/relation warnOnLazy must be a boolean/
	);
});

test('memory store satisfies store adapter contract', async () => {
	await runStoreAdapterContract(new MemoryStoreAdapter());
});

test('test context seeds, snapshots, captures stats, and restores default context', async () => {
	clearDefaultContext();
	const context = createTestContext();
	await withTestContext(context, async (ctx) => {
		await seed(Account, [{ id: 11, handle: 'ctx' }]);
		await fixture(Rank, { id: 11, rank: 2, tier: 4 });

		const account = await Account.find(11).include('rank').load();
		assert.equal(account?.data.handle, 'ctx');
		assert.deepEqual(snapshotStore(Account), [{ id: 11, handle: 'ctx' }]);
	assert.equal(ctx.stats().store?.getMany, 1);
	assert.equal(ctx.stats().store?.query, 1);
		assert.equal(ctx.warnings.length, 0);
	});

	assert.throws(() => Account.find(11), /No default active-ts context/);
});

test('test context supports async-local helpers without global installation', async () => {
	clearDefaultContext();
	const context = createTestContext();
	const AccountInContext = Account.use(context.context) as unknown as typeof Account;
	await withTestContext(
		context,
		async () => {
			await seed(AccountInContext, [{ id: 21, handle: 'local' }]);
			assert.equal((await AccountInContext.find(21).load())?.data.handle, 'local');
			assert.throws(() => Account.find(21), /No default active-ts context/);
			assert.deepEqual(snapshotStore(AccountInContext), [{ id: 21, handle: 'local' }]);
		},
		{ install: false }
	);
	assert.throws(() => Account.find(21), /No default active-ts context/);
});

test('test context global installation rejects overlapping contexts', () => {
	clearDefaultContext();
	const first = createTestContext();
	const second = createTestContext();
	first.install();
	try {
		assert.throws(() => second.install(), /cannot overlap/);
	} finally {
		first.restore();
	}
	assert.throws(() => Account.find(99), /No default active-ts context/);
});

test('test helpers assert lazy-load warning behavior', async () => {
	const context = createTestContext();
	await withTestContext(context, async (testContext) => {
		await seed(Account, [{ id: 12, handle: 'warn' }]);
		await seed(Rank, [{ id: 12, rank: 5, tier: 1 }]);
		const TestAccount = Account.use(testContext.context) as unknown as typeof Account;

		await expectNoLazyLoadWarnings(async () => {
			const account = await TestAccount.find(12).include('rank').load();
			await account?.ref<Rank>('rank');
		});
	}, { install: false });

	await withTestContext(context, async () => {
		const account = await Account.find(12).load();
		await account?.ref<Rank>('rank');
		assert.equal(context.warnings.length, 1);
	});
});

test('adapter contract suite and integration harness can run user-provided adapters', async () => {
	await createAdapterContractSuite({
		memory: () => new MemoryStoreAdapter()
	}).run();

	const harness = createIntegrationHarness({
		name: 'memory-harness',
		start: () => ({ stopped: 0 }),
		stop: (resource) => {
			if (resource) resource.stopped++;
		},
		createStore: () => new MemoryStoreAdapter()
	});
	const handle = await harness.createContext();
	assert.equal(handle.resource?.stopped, 0);
	await handle.close();
	await handle.dispose();
	assert.equal(handle.resource?.stopped, 1);
	await harness.withContext(async (ctx) => {
		await ctx.seed(Account, [{ id: 13, handle: 'harness' }]);
		assert.deepEqual(ctx.snapshotStore(Account), [{ id: 13, handle: 'harness' }]);
	});
	await harness.runStoreContract();
});

test('rejects reserved data and query keys before reaching adapters', async () => {
	const { context } = setup();
	await assert.rejects(
		() => Rank.create({ id: 30, rank: 1, tier: 2, __bad: true } as any),
		/Reserved data key/
	);
	assert.throws(
		() => context.instantiate(Account, { id: 31, handle: 'db', __fromDb: true }),
		/Reserved data key/
	);
	assert.throws(() => Account.where({ __key__: 1 } as any), /Reserved query field/);
	assert.throws(() => Account.query().where('', 1), /Empty query field/);
	assert.throws(() => Account.query().where('bad\0field', 1), /query field must not contain null bytes/);
	assert.throws(() => Account.query().where('profile..name', 1), /Empty query field segment/);
	assert.throws(() => Account.query().limit(Number.NaN), /query limit/);
	assert.throws(() => Account.query().limit(0), /positive safe integer/);
	assert.throws(() => Account.query().offset(-1), /non-negative safe integer/);
	assert.throws(() => Account.query().offset(1.5), /non-negative safe integer/);
	assert.throws(() => Account.query().offset(Number.NaN), /query offset/);
	let offsetCoercions = 0;
	assert.throws(
		() => Account.query().offset({ toString: () => `${++offsetCoercions}` } as any),
		/query offset must be a non-negative safe integer/
	);
	assert.equal(offsetCoercions, 0);
	assert.throws(() => Account.search('x').limit(-1), /search limit/);
	assert.throws(() => Account.search('x').limit(0), /positive safe integer/);
	assert.throws(() => defineModel<any>({ name: 'bad_id_type' }).id(1 as any), /id field must be a string/);
	assert.throws(
		() => defineModel<any>({ name: 'bad_search_field_type' }).search('memory', [1 as any]),
		/search field must be a string/
	);
	class BadEntityNameType extends Model<any> {}
	assert.throws(
		() => defineModel<any>({ name: false as any }).attach(BadEntityNameType),
		/entity name must be a string/
	);
	assert.throws(() => createFunctionCache({ prefix: {} as any, factory: async () => 'bad' }), /function cache prefix must be a string/);
	assert.throws(() => defineModel<any>({ name: 'bad' }).id('__id'), /Reserved id field/);
	assert.throws(() => defineModel<any>({ name: 'bad_nested_id' }).id('profile.id'), /top-level field/);
	assert.throws(
		() =>
			defineModel<any>({ name: 'bad_rel' }).ref('bad', () => Rank, {
				localKey: 'id',
				foreignKey: '__owner'
			}),
		/Reserved relation foreignKey/
	);
	assert.throws(
		() =>
			defineModel<any>({ name: 'bad_rel_name' }).ref('__owner', () => Rank, {
				localKey: 'id',
				foreignKey: 'id'
			}),
		/Reserved relation name/
	);
	assert.throws(
		() =>
			defineModel<any>({ name: 'bad_has_many_name' }).hasMany('constructor', () => Rank, {
				localKey: 'id',
				foreignKey: 'id'
			}),
		/Reserved relation name/
	);
	assert.throws(
		() =>
			defineModel<any>({ name: 'bad_dotted_rel_name' }).ref('profile.team', () => Rank, {
				localKey: 'id',
				foreignKey: 'id'
			}),
		/relation name .*must be a top-level field/
	);
	class BadDecoratedRelation extends Model<any> {}
	assert.throws(
		() => ref(() => Rank, { localKey: 'id', foreignKey: 'id' })(BadDecoratedRelation.prototype, '__rank'),
		/Reserved relation name/
	);
	assert.throws(
		() => ref(() => Rank, { localKey: 'id', foreignKey: 'id' })(BadDecoratedRelation.prototype, 'profile.team'),
		/relation name .*must be a top-level field/
	);
	assert.throws(
		() =>
			modelMeta.relation(BadDecoratedRelation, {
				name: '__rank',
				kind: 'one',
				target: () => Rank,
				localKey: 'id',
				foreignKey: 'id'
			}),
		/Reserved relation name/
	);
	assert.throws(
		() =>
			modelMeta.relation(BadDecoratedRelation, {
				name: 'profile.team',
				kind: 'one',
				target: () => Rank,
				localKey: 'id',
				foreignKey: 'id'
			}),
		/relation name .*must be a top-level field/
	);
});

test('datastore adapter rejects reserved keys and exposes datastore key as symbol metadata', async () => {
	const { Datastore } = await import('@google-cloud/datastore');
	const datastoreKey = { name: 'number:1', path: ['account', 'number:1'] };
	const saved: any[] = [];
	const queryCalls: any[] = [];
	let runInfo: any = { moreResults: 'NO_MORE_RESULTS' };
	const client = {
		key: (input: any) => input,
		get: async () => [{ id: 1, handle: 'ds', [Datastore.KEY]: datastoreKey }],
		save: async (entity: any) => saved.push(entity),
		update: async (entity: any) => saved.push(entity),
		delete: async () => undefined,
		createQuery: () => ({
			filter(...args: any[]) {
				queryCalls.push({ op: 'filter', args });
				return this;
			},
			order(...args: any[]) {
				queryCalls.push({ op: 'order', args });
				return this;
			},
			limit(limit: number) {
				queryCalls.push({ op: 'limit', limit });
				return this;
			},
			start(cursor: string) {
				queryCalls.push({ op: 'start', cursor });
				return this;
			},
			select(...args: any[]) {
				queryCalls.push({ op: 'select', args });
				return this;
			}
		}),
		runQuery: async () => [[{ id: 1, handle: 'ds', [Datastore.KEY]: datastoreKey }], runInfo]
	};
	const adapter = await createDatastoreStoreAdapter({ client, keySymbol: Datastore.KEY });
	const meta = setup().context.meta(Account);
	assert.equal(adapter.capabilities?.cursor, true);

	const loaded = await adapter.get(meta, 1);
	assert.equal(loaded?.handle, 'ds');
	assert.notEqual(loaded?.[ACTIVE_TS_ENTITY_KEY], datastoreKey);
	assert.deepEqual(loaded?.[ACTIVE_TS_ENTITY_KEY], datastoreKey);
	assert.equal(Object.getOwnPropertySymbols(loaded ?? {}).includes(Datastore.KEY), false);

	await assert.rejects(
		() => adapter.create(meta, 2, { id: 2, handle: 'bad', __key__: 'nope' }),
		/Reserved data key/
	);
	const safeDatastoreData = Object.defineProperty({ id: 3, handle: 'safe' }, ACTIVE_TS_ENTITY_KEY, {
		enumerable: false,
		value: datastoreKey
	});
	await adapter.update(meta, 3, safeDatastoreData);
	assert.deepEqual(saved[0].data, { id: 3, handle: 'safe' });
	assert.deepEqual(saved[0].key.path, ['account', 'number:3']);
	assert.equal('excludeFromIndexes' in saved[0], false);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: '__key__', op: '=', value: 1 }],
				or: [],
				sort: [],
				include: []
			}),
		/Reserved Datastore query field/
	);
	queryCalls.length = 0;
	await assert.rejects(
		() =>
			adapter.query({ ...meta, name: 'account' }, {
				where: [],
				or: [],
				sort: [],
				include: [],
				limit: 0
			}),
		/Datastore limit/
	);
	assert.deepEqual(queryCalls.filter((call) => call.op === 'limit'), []);
	runInfo = { moreResults: 'MORE_RESULTS_AFTER_CURSOR', endCursor: 'native/cursor' };
	const nativeCursorPage = await adapter.query({ ...meta, name: 'account' }, {
		where: [],
		or: [],
		sort: [],
		include: [],
		limit: 1
	});
	assert.equal(nativeCursorPage.more, true);
	assert.equal(typeof nativeCursorPage.cursor, 'string');
	assert.notEqual(nativeCursorPage.cursor, 'native/cursor');
	runInfo = { moreResults: 'NO_MORE_RESULTS' };
	const continuedPage = await adapter.query({ ...meta, name: 'account' }, {
		where: [],
		or: [],
		sort: [],
		include: [],
		limit: 1,
		cursor: nativeCursorPage.cursor
	});
	assert.equal(continuedPage.more, false);
	assert.equal(continuedPage.cursor, undefined);
	assert.equal(queryCalls.some((call) => call.op === 'start' && call.cursor === 'native/cursor'), true);
	runInfo = undefined;
	const noInfoPage = await adapter.query({ ...meta, name: 'account' }, {
		where: [],
		or: [],
		sort: [],
		include: []
	});
	assert.equal(noInfoPage.more, false);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				cursor: encodeURIComponent('cursor/1')
			}),
		/Invalid Datastore continuation cursor/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'handle', op: 'startsWith', value: 'd' }],
				or: [],
				sort: [],
				include: []
			}),
		/safe startsWith/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [{ where: [{ field: 'handle', op: '=', value: 'ds' }], or: [], sort: [], include: [] }],
				sort: [],
				include: []
			}),
		/orWhere/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { unsafe: true } }
			}),
		/Datastore native payload/
	);

	const rowIdClient = {
		key: (input: any) => input,
		get: async () => [[{ id: 1, handle: 'row-id' }]],
		save: async () => undefined,
		delete: async () => undefined,
		update: async () => undefined,
		createQuery: () => ({}),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	};
	const rowIdAdapter = await createDatastoreStoreAdapter({ client: rowIdClient, keySymbol: Symbol('datastore-key') });
	assert.deepEqual((await rowIdAdapter.getMany(meta, [1]))[0], { id: 1, handle: 'row-id' });

	const missingUpdateAdapter = await createDatastoreStoreAdapter({
		client: {
			key: (input: any) => input,
			get: async () => [undefined],
			update: async () => {
				throw Object.assign(new Error('not found'), { code: 5 });
			},
			save: async () => {
				throw new Error('save should not run for missing update');
			},
			delete: async () => undefined,
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		}
	});
	await assert.rejects(
		() => missingUpdateAdapter.update(meta, 404, { id: 404, handle: 'missing' }),
		/does not exist/
	);
	await assert.rejects(
		() => missingUpdateAdapter.update(meta, 404, { id: 404, handle: 'locked' }, { expectedVersion: 1 } as any),
		/Datastore store write options does not support expectedVersion/
	);
});

test('datastore create requires insert for atomic duplicate semantics', async () => {
	let getCalls = 0;
	let saveCalls = 0;
	const client = {
		key: (input: any) => input,
		get: async () => {
			getCalls++;
			return [undefined];
		},
		save: async () => {
			saveCalls++;
		},
		delete: async () => undefined,
		update: async () => undefined,
		createQuery: () => ({}),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	};
	const adapter = await createDatastoreStoreAdapter({ client });
	const meta = setup().context.meta(Account);

	await assert.rejects(
		() => adapter.create(meta, 1, { id: 1, handle: 'created' }),
		/Datastore adapter client\.insert is required for atomic create/
	);
	assert.equal(getCalls, 0);
	assert.equal(saveCalls, 0);

	const insertCalls: any[] = [];
	const insertAdapter = await createDatastoreStoreAdapter({
		client: {
			key: (input: any) => input,
			insert: async (entity: any) => insertCalls.push(entity),
			get: async () => {
				throw new Error('fallback get should not run when insert exists');
			},
			save: async () => undefined,
			delete: async () => undefined,
			update: async () => undefined,
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		}
	});
	await insertAdapter.create(meta, 2, { id: 2, handle: 'insert' });
	assert.deepEqual(insertCalls.map((call) => call.key.path), [['account', 'number:2']]);
});

test('datastore schema apply reports manual index deployment', async () => {
	const adapter = await createDatastoreStoreAdapter({
		client: {
			key: (input: any) => input,
			get: async () => [null],
			save: async () => undefined,
			delete: async () => undefined,
			update: async () => undefined,
			createQuery: () => ({}),
			runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
		}
	});
	const meta = setup().context.meta(Account);
	await assert.rejects(
		() => adapter.schema!.plan([meta]),
		/Datastore adapter does not support unique indexes/
	);
	const nonUniqueMeta = { ...meta, indexes: meta.indexes.map((index) => ({ ...index, unique: false })) };
	const applied = await adapter.schema!.apply([nonUniqueMeta], { mode: 'safe' });

	assert.equal(applied.adapter, 'datastore');
	assert.equal(applied.status, 'manual');
	assert.match(applied.note ?? '', /must be applied/);
	assert.deepEqual(applied.changes.map((change) => change.type), ['create-index']);
	assert.equal((await adapter.schema!.plan([nonUniqueMeta])).status, 'manual');
});

test('google store adapter factories validate option shapes', async () => {
	await assert.rejects(
		() => createDatastoreStoreAdapter(null as any),
		/Datastore adapter options must be an object/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter(Object.assign(Object.create({}), { client: { key: (input: any) => input } }) as any),
		/Datastore adapter options must be a plain object/
	);
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: {} } as any),
		/client.key must be a function/
	);
	await assert.rejects(
		() =>
			createDatastoreStoreAdapter({
				client: { key: (input: any) => input },
				namespace: 'bad\0namespace'
			}),
		/namespace must be a non-empty string/
	);
	await assert.rejects(
		() => createFirestoreStoreAdapter(null as any),
		/Firestore adapter options must be an object/
	);
	await assert.rejects(
		() =>
			createFirestoreStoreAdapter(Object.assign(Object.create({}), {
				client: { collection: () => ({}), getAll: async () => [] }
			}) as any),
		/Firestore adapter options must be a plain object/
	);
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client: {} } as any),
		/client.collection must be a function/
	);
	await assert.rejects(
		() =>
			createFirestoreStoreAdapter({
				client: {
					collection: () => ({}),
					getAll: async () => [],
					runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
						callback({
							get: async () => ({ exists: false }),
							set: async () => undefined
						})
				},
				aggregateField: { count: () => ({}) } as any
			}),
		/aggregateField.sum must be a function/
	);
});

test('postgres adapter parameterizes json paths and rejects unsafe field paths', async () => {
	const calls: Array<{ text: string; values: any[] }> = [];
	const pool = {
		query: async (text: string, values: any[] = []) => {
			calls.push({ text, values });
			const id = values[0] === 'string:1' ? '1' : 1;
			return { rows: [{ id: `${typeof id}:${String(id)}`, data: { id, handle: 'pg' } }], rowCount: 1 };
		},
		connect: async () => pool
	};
	const adapter = await createPostgresStoreAdapter({ pool });
	const meta = setup().context.meta(Account);

	await adapter.create(meta, 1, { id: 1, handle: 'pg' });
	assert.equal(calls[0].values[0], 'number:1');
	calls.length = 0;
	await adapter.get(meta, '1');
	assert.deepEqual(calls[0].values, ['string:1']);
	calls.length = 0;

	await adapter.query(meta, {
		where: [{ field: 'handle', op: '=', value: 'pg' }],
		or: [],
		sort: [{ field: 'name', direction: 'asc' }],
		include: [],
		limit: 5
	});

	assert.match(calls[0].text, /data #>> \$1::text\[\]/);
	assert.match(calls[0].text, /order by \(case when \(data #> \$3::text\[\]\) is null/);
	assert.match(calls[0].text, /jsonb_typeof\(\(data #> \$3::text\[\]\)\) = 'number'/);
	assert.match(calls[0].text, /\(data #>> \$3::text\[\]\) end\) asc/);
	assert.deepEqual(calls[0].values, [['handle'], 'pg', ['name'], ['id']]);

	calls.length = 0;
	await adapter.query(meta, {
		where: [{ field: 'profile.first-name', op: '=', value: 'Ada' }],
		or: [],
		sort: [{ field: 'profile.last-name', direction: 'asc' }],
		include: [],
		limit: 5
	});
	assert.match(calls[0].text, /data #>> \$1::text\[\]/);
	assert.match(calls[0].text, /order by \(case when \(data #> \$3::text\[\]\) is null/);
	assert.match(calls[0].text, /\(data #>> \$3::text\[\]\) end\) asc/);
	assert.deepEqual(calls[0].values, [['profile', 'first-name'], 'Ada', ['profile', 'last-name'], ['id']]);

	calls.length = 0;
	await adapter.query(meta, {
		where: [{ field: 'score', op: '>=', value: 10 }],
		or: [],
		sort: [{ field: 'score', direction: 'desc' }],
		include: []
	});
	assert.match(calls[0].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'number'/);
	assert.match(calls[0].text, /\(data #>> \$1::text\[\]\)::double precision >= \$2::double precision/);
	assert.match(calls[0].text, /order by \(case when \(data #> \$3::text\[\]\) is null/);
	assert.match(calls[0].text, /\(\(data #>> \$3::text\[\]\)\)::double precision desc/);
	assert.deepEqual(calls[0].values, [['score'], 10, ['score']]);

	calls.length = 0;
	await adapter.query(meta, {
		where: [{ field: 'handle', op: 'startsWith', value: 'a_%' }],
		or: [],
		sort: [],
		include: []
	});
	assert.match(calls[0].text, /like \$2 escape/);
	assert.deepEqual(calls[0].values, [['handle'], String.raw`a\_\%%`]);

	calls.length = 0;
	await adapter.query(meta, {
		where: [{ field: 'handle', op: 'startsWith', value: String.raw`a\b` }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(calls[0].values, [['handle'], String.raw`a\\b%`]);

	calls.length = 0;
	await adapter.query(meta, {
		where: [{ field: 'handle', op: '=', value: 'pg' }],
		or: [{ where: [{ field: 'name', op: '=', value: 'Postgres' }], or: [], sort: [], include: [] }],
		sort: [],
		include: []
	});
	assert.match(calls[0].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'string'/);
	assert.match(calls[0].text, /\(data #>> \$1::text\[\]\) = \$2::text/);
	assert.match(calls[0].text, /jsonb_typeof\(data #> \$3::text\[\]\) = 'string'/);
	assert.match(calls[0].text, /\(data #>> \$3::text\[\]\) = \$4::text/);
	assert.deepEqual(calls[0].values, [['handle'], 'pg', ['name'], 'Postgres']);

	calls.length = 0;
	await adapter.query(meta, {
		where: [],
		or: [
			{ where: [{ field: 'handle', op: 'startsWith', value: 'a_%' }], or: [], sort: [], include: [] },
			{ where: [{ field: 'name', op: 'startsWith', value: String.raw`b\c` }], or: [], sort: [], include: [] }
		],
		sort: [],
		include: []
	});
	assert.match(calls[0].text, /like \$2 escape/);
	assert.match(calls[0].text, /like \$4 escape/);
	assert.deepEqual(calls[0].values, [['handle'], String.raw`a\_\%%`, ['name'], String.raw`b\\c%`]);

	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'tags', op: 'contains', value: 'cat' }],
				or: [],
				sort: [],
				include: []
			}),
		/legacy contains/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: '__sql', op: '=', value: 'pg' }],
				or: [],
				sort: [],
				include: []
			}),
		/PostgreSQL JSON field/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				limit: Number.NaN
			}),
		/PostgreSQL limit/
	);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'bad', __sql: true }),
		/Reserved data key/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: false }
			}),
		/PostgreSQL native payload/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				native: { payload: { text: '', values: [] } },
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/native payload text/
	);
});

test('postgres adapter uses typed ids and conditional optimistic updates', async () => {
	const calls: Array<{ text: string; values: any[] }> = [];
	const pool = {
		query: async (text: string, values: any[] = []) => {
			calls.push({ text, values });
			return { rows: [], rowCount: text.startsWith('update') ? 1 : 0 };
		},
		connect: async () => pool
	};
	const adapter = await createPostgresStoreAdapter({ pool });
	const meta = setup().context.meta(Account);

	await adapter.update(meta, 1, { id: 1, handle: 'locked', version: 2 }, { expectedVersion: 1 });
	assert.match(calls[0].text, /where id = \$1 and jsonb_typeof\(data #> ARRAY\['version'\]\) = 'number'/);
	assert.match(calls[0].text, /\(data #>> ARRAY\['version'\]\)::double precision = \$3/);
	assert.deepEqual(calls[0].values, ['number:1', { id: 1, handle: 'locked', version: 2 }, 1]);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'bad-version', version: 2 }, { expectedVersion: 1.5 }),
		/PostgreSQL store write options\.expectedVersion/
	);

	const rejecting = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string) => text.startsWith('select 1 from')
				? { rows: [{}], rowCount: 1 }
				: { rows: [], rowCount: 0 },
			connect: async () => pool
		}
	});
	await assert.rejects(
		() => rejecting.update(meta, 1, { id: 1, handle: 'stale', version: 2 }, { expectedVersion: 1 }),
		/Optimistic lock failed/
	);
	const missingLock = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [], rowCount: 0 }),
			connect: async () => pool
		}
	});
	await assert.rejects(
		() => missingLock.update(meta, 1, { id: 1, handle: 'missing-lock', version: 2 }, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	await assert.rejects(
		() => missingLock.delete(meta, 1, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	await assert.rejects(
		() => rejecting.update(meta, 1, { id: 1, handle: 'missing' }),
		/does not exist/
	);
});

test('postgres schema apply escapes identifiers and rejects reserved index json paths', async () => {
	const calls: Array<{ text: string; values: any[] }> = [];
	const pool = {
		query: async (text: string, values: any[] = []) => {
			calls.push({ text, values });
			return { rows: [], rowCount: 0 };
		},
		connect: async () => pool
	};
	const adapter = await createPostgresStoreAdapter({ pool, schema: 'app"schema' });
	const meta = setup().context.meta(Account);

	await adapter.schema?.apply([meta], { mode: 'safe' });
	const createTableCall = calls.find((call) => call.text.startsWith('create table'));
	const createIndexCall = calls.find((call) => /^create (unique )?index/.test(call.text));
	assert.match(createTableCall?.text ?? '', /"app""schema"\.account/);
	assert.match(createIndexCall?.text ?? '', /account_handle/);
	assert.match(createIndexCall?.text ?? '', /ARRAY\['handle'\]/);

	calls.length = 0;
	await adapter.schema?.apply(
		[
			{ ...meta, name: 'first_account', indexes: [{ name: 'lookup', fields: ['handle'] }] },
			{ ...meta, name: 'second_account', indexes: [{ name: 'lookup', fields: ['handle'] }] }
		],
		{ mode: 'safe' }
	);
	const indexCalls = calls.filter((call) => /^create (unique )?index/.test(call.text));
	assert.match(indexCalls[0].text, /first_account_lookup/);
	assert.match(indexCalls[1].text, /second_account_lookup/);

	calls.length = 0;
	await assert.rejects(
		() => adapter.schema!.apply([{ ...meta, name: 'account"; drop table users; --' }], { mode: 'safe' }),
		/PostgreSQL schema models\[0\]\.name/
	);
	assert.equal(calls.some((call) => call.text.startsWith('create table')), false);

	const existingCalls: Array<{ text: string; values: any[] }> = [];
	const existingAdapter = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: any[] = []) => {
				existingCalls.push({ text, values });
				if (text.includes('information_schema.tables')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
				if (text.includes('information_schema.columns')) {
					return {
						rows: [
							{ column_name: 'id', udt_name: 'text', data_type: 'text', is_nullable: 'NO' },
							{ column_name: 'data', udt_name: 'jsonb', data_type: 'jsonb', is_nullable: 'NO' },
							{ column_name: 'created_at', udt_name: 'timestamptz', data_type: 'timestamp with time zone', is_nullable: 'NO' },
							{ column_name: 'updated_at', udt_name: 'timestamptz', data_type: 'timestamp with time zone', is_nullable: 'NO' }
						],
						rowCount: 4
					};
				}
				if (/\bfrom\s+pg_index\s/.test(text)) return { rows: [{ column_name: 'id' }], rowCount: 1 };
				if (text.includes('pg_indexes')) {
					return {
						rows: [
							{
								indexname: 'account_handle',
								indexdef: "CREATE UNIQUE INDEX account_handle ON public.account USING btree (((data #> ARRAY['handle'::text])))"
							}
						],
						rowCount: 1
					};
				}
				return { rows: [], rowCount: 0 };
			},
			connect: async () => pool
		}
	});
	assert.deepEqual((await existingAdapter.schema!.plan([meta])).changes, []);

	await assert.rejects(
		() =>
			adapter.schema!.apply(
				[
					{
						...meta,
						indexes: [{ name: 'bad', fields: ['__sql'] }]
					}
				],
				{ mode: 'safe' }
			),
		/PostgreSQL schema models\[0\]\.indexes\[0\]\.fields\[0\]/
	);
});

test('postgres aggregate uses native SQL aggregates and parameters', async () => {
	const calls: Array<{ text: string; values: any[] }> = [];
	const pool = {
		query: async (text: string, values: any[] = []) => {
			calls.push({ text, values });
			return { rows: [{ count: '2', total: 50, highest: 30 }], rowCount: 1 };
		},
		connect: async () => pool
	};
	const adapter = await createPostgresStoreAdapter({ pool });
	const meta = setup().context.meta(Account);

	const result = await adapter.aggregate!(meta, {
		where: [{ field: 'score', op: '>=', value: 20 }],
		or: [],
		aggregates: [
			{ op: 'count', as: 'count' },
			{ op: 'sum', field: 'score', as: 'total' },
			{ op: 'max', field: 'score', as: 'highest' }
		]
	});

	assert.deepEqual(result, { count: 2, total: 50, highest: 30 });
	assert.match(calls[0].text, /count\(\*\)::double precision as count/);
	assert.match(calls[0].text, /coalesce\(sum\(\(case when data #> \$1::text\[\] is null/);
	assert.match(calls[0].text, /jsonb_typeof\(data #> \$1::text\[\]\) = 'number'/);
	assert.match(calls[0].text, /active-ts-invalid-numeric-aggregate/);
	assert.match(calls[0].text, /max\(\(\(data #>> \$2::text\[\]\)\)::double precision\) as highest/);
	assert.match(calls[0].text, /where coalesce\(\(jsonb_typeof\(data #> \$3::text\[\]\) = 'number'/);
	assert.match(calls[0].text, /\(data #>> \$3::text\[\]\)::double precision >= \$4::double precision/);
	assert.deepEqual(calls[0].values, [['score'], ['score'], ['score'], 20]);
});

test('postgres min and max preserve nonnumeric field types', async () => {
	const calls: Array<{ text: string; values: any[] }> = [];
	const pool = {
		query: async (text: string, values: any[] = []) => {
			calls.push({ text, values });
			return { rows: [{ earliest: '2026-05-01T00:00:00.000Z', lastHandle: 'seo' }], rowCount: 1 };
		},
		connect: async () => pool
	};
	const adapter = await createPostgresStoreAdapter({ pool });
	const baseMeta = setup().context.meta(Account);
	const meta = {
		...baseMeta,
		fieldTypes: new Map([
			...baseMeta.fieldTypes,
			['createdAt', 'date' as const],
			['handle', 'string' as const]
		])
	};

	const result = await adapter.aggregate!(meta, {
		where: [],
		or: [],
		aggregates: [
			{ op: 'min', field: 'createdAt', as: 'earliest' },
			{ op: 'max', field: 'handle', as: 'lastHandle' }
		]
	});

	assert.deepEqual(result, { earliest: '2026-05-01T00:00:00.000Z', lastHandle: 'seo' });
	assert.match(calls[0].text, /min\(\(\(data #>> \$1::text\[\]\)\)::timestamptz\) as earliest/);
	assert.match(calls[0].text, /max\(\(data #>> \$2::text\[\]\)\) as "lastHandle"/);
	assert.deepEqual(calls[0].values, [['createdAt'], ['handle']]);
});

test('postgres transaction child adapters fail fast on nested transactions', async () => {
	const calls: string[] = [];
	const client = {
		query: async (text: string) => {
			calls.push(text);
			return { rows: [], rowCount: 0, command: text.toUpperCase() };
		},
		release: () => calls.push('release')
	};
	const pool = {
		query: async () => ({ rows: [], rowCount: 0 }),
		connect: async () => client
	};
	const adapter = await createPostgresStoreAdapter({ pool });

	await adapter.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.transaction, false);
		assert.equal(tx.transaction, undefined);
	});

	assert.deepEqual(calls, ['begin', 'commit', 'release']);
});

test('postgres and mongodb adapter factories validate option shapes', async () => {
	await assert.rejects(
		() => createPostgresStoreAdapter(null as any),
		/PostgreSQL adapter options must be an object/
	);
	await assert.rejects(
		() => createPostgresStoreAdapter(Object.assign(Object.create({}), {
			pool: { query: async () => ({ rows: [] }) }
		}) as any),
		/PostgreSQL adapter options must be a plain object/
	);
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: {} } as any),
		/pool.query must be a function/
	);
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: { query: async () => ({ rows: [] }) }, inTransaction: 'yes' as any }),
		/inTransaction must be a boolean/
	);
	await assert.rejects(
		() =>
			createPostgresStoreAdapter({
				pool: { query: async () => ({ rows: [], rowCount: 0 }) },
				connectionString: 'postgres://localhost/db'
			}),
		/PostgreSQL adapter options cannot combine pool and connectionString/
	);
	const queryOnlyPostgres = await createPostgresStoreAdapter({
		pool: { query: async () => ({ rows: [], rowCount: 0 }) }
	});
	assert.equal(queryOnlyPostgres.capabilities?.transaction, false);
	assert.equal(queryOnlyPostgres.transaction, undefined);

	await assert.rejects(
		() => createMongoStoreAdapter(null as any),
		/MongoDB adapter options must be an object/
	);
	await assert.rejects(
		() => createMongoStoreAdapter(Object.assign(Object.create({}), {
			client: { db: () => ({}) },
			dbName: 'test'
		}) as any),
		/MongoDB adapter options must be a plain object/
	);
	await assert.rejects(
		() => createMongoStoreAdapter({ client: {}, dbName: 'test' } as any),
		/client.db must be a function/
	);
	await assert.rejects(
		() => createMongoStoreAdapter({ client: { db: () => ({}) }, dbName: '' }),
		/dbName must be a non-empty string/
	);
	await assert.rejects(
		() =>
			createMongoStoreAdapter({
				client: { db: () => ({}) },
				url: 'mongodb://127.0.0.1:27017',
				dbName: 'test'
			}),
		/MongoDB adapter options cannot combine client and url/
	);
});

test('postgres rollback failure preserves the original transaction error', async () => {
	const client = {
		query: async (text: string) => {
			if (text === 'rollback') throw new Error('rollback failed');
			return { rows: [], rowCount: 0 };
		},
		release: () => undefined
	};
	const adapter = await createPostgresStoreAdapter({
		pool: { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => client }
	});

	await assert.rejects(
		() =>
			adapter.transaction!(async () => {
				throw new Error('work failed');
			}),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /work failed/);
			assert.deepEqual(
				error.errors.map((item: Error) => item.message),
				['work failed', 'rollback failed']
			);
			return true;
		}
	);
});

test('mongodb adapter rejects operator keys and escapes startsWith regex values', async () => {
	const calls: any[] = [];
	let findRows: any[] = [];
	const collection = {
		find: (filter: any, options?: any) => {
			calls.push({ op: 'find', filter, options });
			return {
				sort(sort: any) {
					calls.push({ op: 'sort', sort });
					return this;
				},
				limit(limit: number) {
					calls.push({ op: 'limit', limit });
					return this;
				},
				toArray: async () => findRows
			};
		},
			findOne: async () => ({ _id: 'number:1', id: 1, handle: 'locked', version: 2 }),
			insertOne: async (data: any) => {
				calls.push({ op: 'insertOne', data });
				if (data.handle === 'duplicate') {
					const error: any = new Error('duplicate key');
					error.code = 11000;
					throw error;
				}
		},
		replaceOne: async (filter: any, data: any, options?: any) => {
			calls.push({ op: 'replaceOne', filter, data, options });
			return { matchedCount: JSON.stringify(filter).includes('"$eq":1') ? 1 : 0 };
		},
		deleteOne: async () => undefined,
		aggregate: (pipeline: any[]) => {
			calls.push({ op: 'aggregate', pipeline });
			return { toArray: async () => [{ _id: null, count: 2, total: 50, highest: 30 }] };
		},
		indexes: async () => [],
		createIndex: async (keys: any, options: any) => calls.push({ op: 'createIndex', keys, options })
	};
	const db = {
		collection: () => collection,
		listCollections: () => ({ toArray: async () => [], map: () => ({ toArray: async () => [] }) }),
		createCollection: async () => undefined
	};
	const adapter = await createMongoStoreAdapter({
		client: { db: () => db },
		dbName: 'test',
		allowAggregateScanFallback: true
	});
	const meta = setup().context.meta(Account);
	const scalarFilter = (field: string, condition: unknown) => ({
		$and: [
			{ [field]: { $exists: true } },
			{ [field]: { $not: { $type: 'array' } } },
			{ [field]: condition }
		]
	});

	await adapter.create(meta, 1, { id: 1, handle: 'mongo' });
	assert.deepEqual(calls[0], { op: 'insertOne', data: { id: 1, handle: 'mongo', _id: 'number:1' } });
	await assert.rejects(() => adapter.create(meta, 1, { id: 1, handle: 'duplicate' }), /already exists/);
	calls.length = 0;

	await adapter.query(meta, {
		where: [{ field: 'handle', op: 'startsWith', value: 'a.b?' }],
		or: [],
		sort: [],
		include: []
	});
	assert.equal(String((calls[0] as any).filter.$and[2].handle.$regex), '/^a\\.b\\?/');
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'tags', op: 'contains', value: 'cat' }],
				or: [],
				sort: [],
				include: []
			}),
		/legacy contains/
	);

	calls.length = 0;
	await adapter.query(meta, {
		where: [
			{ field: 'score', op: '>=', value: 10 },
			{ field: 'score', op: '<=', value: 20 }
		],
		or: [{ where: [{ field: 'handle', op: '=', value: 'seo' }], or: [], sort: [], include: [] }],
		sort: [],
		include: []
	});
	assert.deepEqual((calls[0] as any).filter, {
		$or: [
			{
				$and: [
					scalarFilter('score', { $gte: 10 }),
					scalarFilter('score', { $lte: 20 }),
					scalarFilter('handle', { $eq: 'seo' })
				]
			}
		]
	});

	calls.length = 0;
	await adapter.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		select: ['handle']
	});
	assert.deepEqual((calls[0] as any).options.projection, { id: 1, handle: 1, _id: 1 });

	calls.length = 0;
	await adapter.update(meta, 1, { id: 1, handle: 'locked', version: 2 }, { expectedVersion: 1 });
	assert.deepEqual(calls[0], {
		op: 'replaceOne',
		filter: {
			$and: [
				{ _id: 'number:1' },
				{
					$and: [
						{ version: { $exists: true } },
						{ version: { $not: { $type: 'array' } } },
						{ version: { $eq: 1 } }
					]
				}
			]
		},
		data: { id: 1, handle: 'locked', version: 2, _id: 'number:1' },
		options: { upsert: false }
	});
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'bad-version', version: 2 }, { expectedVersion: -1 }),
		/MongoDB store write options\.expectedVersion/
	);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'stale', version: 3 }, { expectedVersion: 2 }),
		/Optimistic lock failed/
	);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'missing' }),
		/does not exist/
	);

	findRows = [
		{ _id: 'number:2', id: 2, score: 20 },
		{ _id: 'number:3', id: 3, score: 30 }
	];
	calls.length = 0;
	const noScanAdapter = await createMongoStoreAdapter({ client: { db: () => db }, dbName: 'test' });
	await assert.rejects(
		() =>
			noScanAdapter.aggregate!(meta, {
				where: [{ field: 'score', op: '>=', value: 20 }],
				or: [],
				aggregates: [{ op: 'max', field: 'score', as: 'highest' }]
			}),
		/MongoDB aggregate scan fallback requires allowAggregateScanFallback: true/
	);
	assert.equal(calls.some((call) => call.op === 'find' || call.op === 'aggregate'), false);
	calls.length = 0;
	const aggregate = await adapter.aggregate!(meta, {
		where: [{ field: 'score', op: '>=', value: 20 }],
		or: [],
		aggregates: [
			{ op: 'count', as: 'count' },
			{ op: 'sum', field: 'score', as: 'total' },
			{ op: 'max', field: 'score', as: 'highest' }
		]
	});
	assert.deepEqual(aggregate, { count: 2, total: 50, highest: 30 });
	const aggregateFindCall = calls.find((call) => call.op === 'find');
	assert.deepEqual(aggregateFindCall.filter, scalarFilter('score', { $gte: 20 }));
	assert.deepEqual(aggregateFindCall.options, { projection: { id: 1, score: 1, _id: 1 } });
	assert.equal(calls.some((call) => call.op === 'aggregate'), false);

	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: '$where', op: '=', value: 'this.password' }],
				or: [],
				sort: [],
				include: []
			}),
		/MongoDB field/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				limit: Number.POSITIVE_INFINITY
			}),
		/MongoDB limit/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { unsafe: true } }
			}),
		/MongoDB native payload/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				native: { payload: false },
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/MongoDB native payload/
	);
	await assert.rejects(
		() => adapter.getMany({ ...meta, idField: '$id' }, [1]),
		/MongoDB field/
	);
	await assert.rejects(
		() => adapter.schema!.apply([{ ...meta, indexes: [{ name: '$bad', fields: ['handle'] }] }], { mode: 'safe' }),
		/MongoDB schema models\[0\]\.indexes\[0\]\.name/
	);
	const existingIndexAdapter = await createMongoStoreAdapter({
		client: {
			db: () => ({
				collection: () => ({
					indexes: async () => [{ name: 'handle', key: { handle: 1 }, unique: true }]
				}),
				createCollection: async () => undefined,
				listCollections: () => ({ toArray: async () => [{ name: 'account' }], map: () => ({ toArray: async () => ['account'] }) })
			})
		},
		dbName: 'test'
	});
	assert.deepEqual((await existingIndexAdapter.schema!.plan([meta])).changes, []);
	await assert.rejects(
		() => adapter.create(meta, 1, { id: 1, handle: 'bad', __mongo: true }),
		/Reserved data key/
	);
});

test('firestore adapter validates field paths, document ids, and write payloads', async () => {
	const calls: any[] = [];
	const docRef = {
		get: async () => ({ exists: false }),
		create: async (data: any) => calls.push({ op: 'create', data }),
		update: async () => {
			throw Object.assign(new Error('not found'), { code: 5 });
		},
		delete: async () => undefined
	};
	const query = {
		where(field: string, op: string, value: any) {
			calls.push({ op: 'where', field, whereOp: op, value });
			return this;
		},
		orderBy(field: string, direction: string) {
			calls.push({ op: 'orderBy', field, direction });
			return this;
		},
		limit(limit: number) {
			calls.push({ op: 'limit', limit });
			return this;
		},
		select(...fields: string[]) {
			calls.push({ op: 'select', fields });
			return this;
		},
		aggregate(spec: any) {
			calls.push({ op: 'aggregate', spec });
			return {
				get: async () => ({
					data: () => ({ count: 2, total: 50, average: 25 })
				})
			};
		},
		get: async () => ({
			docs: [
				{ data: () => ({ id: 1, score: 20 }) },
				{ data: () => ({ id: 2, score: 30 }) }
			],
			size: 2
		})
	};
	const client = {
		collection: () => ({
			doc: (id: string) => {
				calls.push({ op: 'doc', id });
				return docRef;
			},
			where: query.where.bind(query),
			orderBy: query.orderBy.bind(query),
			limit: query.limit.bind(query),
			select: query.select.bind(query),
			aggregate: query.aggregate.bind(query),
			get: query.get
		}),
		getAll: async () => [],
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({
				get: async () => ({ exists: false }),
				set: async () => undefined
			})
	};
	const aggregateField = {
		count: () => ({ aggregateType: 'count' }),
		sum: (field: string) => ({ aggregateType: 'sum', field }),
		average: (field: string) => ({ aggregateType: 'average', field })
	};
	const adapter = await createFirestoreStoreAdapter({ client, aggregateField });
	const meta = setup().context.meta(Account);
	const sortableMeta = { ...meta, fieldTypes: new Map([...meta.fieldTypes, ['name', 'string' as const]]) };

	await adapter.get(meta, 1);
	assert.deepEqual(calls[0], { op: 'doc', id: 'number:1' });
	calls.length = 0;

	await adapter.query(sortableMeta, {
		where: [{ field: 'handle', op: '=', value: 'safe' }],
		or: [],
		sort: [{ field: 'name', direction: 'asc' }],
		include: [],
		select: ['handle']
	});
	assert.equal((calls[0] as any).field, 'handle');
	assert.equal((calls[1] as any).field, 'name');
	assert.deepEqual(calls[2], { op: 'select', fields: ['id', 'handle'] });
	calls.length = 0;

	const aggregate = await adapter.aggregate!(meta, {
		where: [{ field: 'handle', op: '=', value: 'safe' }],
		or: [],
		aggregates: [
			{ op: 'count', as: 'count' },
			{ op: 'sum', field: 'score', as: 'total' },
			{ op: 'avg', field: 'score', as: 'average' }
		]
	});
	assert.deepEqual(aggregate, { count: 2, total: 50, average: 25 });
	assert.deepEqual(calls.find((call) => call.op === 'aggregate'), {
		op: 'aggregate',
		spec: {
			count: { aggregateType: 'count' },
			total: { aggregateType: 'sum', field: 'score' },
			average: { aggregateType: 'average', field: 'score' }
		}
	});
	assert.equal(calls.some((call) => call.op === 'select'), false);
	calls.length = 0;
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'profile/score', as: 'bad' }]
			}),
		/Firestore sum aggregate field/
	);
	assert.equal(calls.some((call) => call.op === 'aggregate'), false);

	calls.length = 0;
	await adapter.create(meta, 'tenant/1', { id: 'tenant/1', handle: 'slash-id' } as any);
	assert.deepEqual(calls[0], {
		op: 'doc',
		id: `active-ts-id:${Buffer.from('string:tenant/1', 'utf8').toString('base64url')}`
	});
	assert.equal(calls[0].id.includes('/'), false);
	assert.deepEqual(calls[1], { op: 'create', data: { id: 'tenant/1', handle: 'slash-id' } });

	await assert.rejects(
		() => adapter.get({ ...meta, name: 'bad/path' }, 1),
		/Firestore model metadata\.name/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: '__name__', op: '=', value: 'x' }],
				or: [],
				sort: [],
				include: []
			}),
		/Reserved Firestore query field/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'profile/name', op: '=', value: 'x' }],
				or: [],
				sort: [],
				include: []
			}),
		/Firestore query field/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'handle', op: 'startsWith', value: 's' }],
				or: [],
				sort: [],
				include: []
			}),
		/safe startsWith/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: 'tags', op: 'contains', value: 'cat' }],
				or: [],
				sort: [],
				include: []
			}),
		/legacy contains/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [{ where: [{ field: 'handle', op: '=', value: 'safe' }], or: [], sort: [], include: [] }],
				sort: [],
				include: []
			}),
		/orWhere/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				limit: -1
			}),
		/Firestore limit/
	);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { unsafe: true } }
			}),
		/Firestore native payload/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				native: { payload: 0 },
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/Firestore native payload/
	);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'bad', constructor: 'pollute' } as any),
		/Reserved data key/
	);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'locked' }, { expectedVersion: 1 } as any),
		/Firestore store write options does not support expectedVersion/
	);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'missing' }),
		/does not exist/
	);

	await assert.rejects(
		() => adapter.schema!.plan([meta]),
		/Firestore adapter does not support unique indexes/
	);
	const nonUniqueMeta = { ...meta, indexes: meta.indexes.map((index) => ({ ...index, unique: false })) };
	const applied = await adapter.schema!.apply([nonUniqueMeta], { mode: 'safe' });
	assert.equal(applied.adapter, 'firestore');
	assert.equal(applied.status, 'manual');
	assert.match(applied.note ?? '', /must be applied/);
	assert.deepEqual(applied.changes.map((change) => change.type), ['create-index']);
	assert.equal((await adapter.schema!.plan([nonUniqueMeta])).status, 'manual');
});

test('firestore adapter can use injected clients without aggregate helpers', async () => {
	const docs = [
		{ data: () => ({ id: 1, handle: 'one', score: 10 }) },
		{ data: () => ({ id: 2, handle: 'two', score: 20 }) }
	];
	const client = {
		collection: () => ({
			where() {
				return this;
			},
			select() {
				return this;
			},
			get: async () => ({ docs, size: docs.length })
		}),
		getAll: async () => [],
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({
				get: async () => ({ exists: false }),
				set: async () => undefined
			})
	};
	const noScanAdapter = await createFirestoreStoreAdapter({ client });
	const meta = setup().context.meta(Account);

	await assert.rejects(
		() =>
			noScanAdapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
			}),
		/Firestore aggregate scan fallback requires allowAggregateScanFallback: true/
	);
	const adapter = await createFirestoreStoreAdapter({ client, allowAggregateScanFallback: true });

	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [
				{ op: 'count', as: 'count' },
				{ op: 'sum', field: 'score', as: 'total' }
			]
		}),
		{ count: 2, total: 30 }
	);
});

test('search adapters validate index names, fields, and indexed documents', async () => {
	const meta = setup().context.meta(Account);
	const algoliaCalls: any[] = [];
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 }),
			saveObject: async (payload: any) => algoliaCalls.push(payload),
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(
		() => algolia.index(meta, 1, { id: 1, handle: 'bad', __hit: true }),
		/Reserved data key/
	);
	await algolia.index(meta, 2, { id: 2, handle: 'safe' });
	assert.equal(algoliaCalls[0].body.objectID, 'account:number:2');
	const algoliaMeta = { ...meta, searchIndexes: [{ name: 'algolia_fields', adapter: 'algolia', fields: ['handle'] }] };
	const algoliaWithIdFallback = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ objectID: 'account:number:5', handle: 'fallback' }],
				nbHits: 1,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	assert.deepEqual((await algoliaWithIdFallback.search(algoliaMeta, 'fallback', {})).list, [
		{ id: 5, handle: 'fallback' }
	]);
	const algoliaMissingIdFallback = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ handle: 'fallback' }],
				nbHits: 1,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(
		() => algoliaMissingIdFallback.search(algoliaMeta, 'fallback', {}),
		/Algolia hit missing string objectID/
	);
	await assert.rejects(
		() => algolia.search({ ...meta, name: 'bad\nindex' }, 'safe', {}),
		/Algolia model metadata\.name/
	);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { limit: Number.NaN }),
		/Algolia limit/
	);
	await assert.rejects(
		() => algolia.syncSchema!([{ ...meta, searchIndexes: [{ name: 'bad', adapter: 'algolia', fields: ['profile..name'] }] }]),
		/Empty Algolia syncSchema models\[0\]\.searchIndexes\[0\]\.fields\[0\] segment/
	);
	const algoliaPlan = await algolia.syncSchema!([algoliaMeta]);
	assert.equal(algoliaPlan.status, 'manual');
	assert.match(algoliaPlan.note ?? '', /Algolia/);

	const elasticCalls: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (payload: any) => {
				elasticCalls.push({ op: 'search', payload });
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async (payload: any) => elasticCalls.push({ op: 'index', payload }),
			delete: async (payload: any) => elasticCalls.push({ op: 'delete', payload })
		}
	});
	const elasticMeta = {
		...meta,
		searchIndexes: [{ name: 'elastic_fields', adapter: 'elasticsearch', fields: ['handle', 'name'] }]
	};
	await elastic.search(elasticMeta, 'safe', {});
	assert.deepEqual(Array.from(elasticCalls[0].payload.body.query.multi_match.fields), ['handle', 'name']);
	const elasticPlan = await elastic.syncSchema!([elasticMeta]);
	assert.equal(elasticPlan.status, 'manual');
	assert.match(elasticPlan.note ?? '', /Elasticsearch/);
	assert.deepEqual(await elastic.search({ ...meta, searchIndexes: [] }, 'safe', {}), {
		list: [],
		more: false,
		count: 0
	});
	assert.equal(elasticCalls.length, 1);
	await elastic.search({ ...meta, searchIndexes: [] }, 'safe', { native: { query: { match_all: {} } } });
	assert.deepEqual(JSON.parse(JSON.stringify(elasticCalls[1].payload.body)), { query: { match_all: {} } });
	await assert.rejects(
		() =>
			elastic.search({ ...meta, name: 'Bad Index', searchIndexes: [] }, 'safe', {
				native: { query: { match_all: {} } }
			}),
		/Elasticsearch model metadata\.name/
	);
	await assert.rejects(
		() =>
			elastic.search({ ...meta, name: 'Account', searchIndexes: [] }, 'safe', {
				native: { query: { match_all: {} } }
			}),
		/Elasticsearch index name/
	);
	await elastic.index(elasticMeta, '1', { id: '1', handle: 'safe' });
	assert.equal(elasticCalls[2].payload.id, 'string:1');
	await elastic.delete(meta, 1);
	assert.equal(elasticCalls[3].payload.id, 'number:1');
	elasticCalls.length = 0;
	const elasticWithIdFallback = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [{ _id: 'number:7', _source: { handle: 'fallback' } }], total: 1 } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	assert.deepEqual((await elasticWithIdFallback.search(elasticMeta, 'fallback', {})).list, [{ id: 7, handle: 'fallback' }]);
	const elasticMissingIdFallback = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [{ _source: { handle: 'fallback' } }], total: 1 } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => elasticMissingIdFallback.search(elasticMeta, 'fallback', {}),
		/Elasticsearch hit missing string _id/
	);
	await assert.rejects(
		() => elastic.search(elasticMeta, 'safe', { limit: Number.POSITIVE_INFINITY }),
		/Elasticsearch limit/
	);
	await assert.rejects(
		() => elastic.index({ ...meta, name: 'Bad Index' }, 1, { id: 1, handle: 'safe' }),
		/Elasticsearch model metadata\.name/
	);
	await assert.rejects(
		() => elastic.index(meta, 1, { id: 1, handle: 'bad', prototype: true } as any),
		/Reserved data key/
	);

	const unsupportedStore = new MemoryStoreAdapter();
	Object.assign(unsupportedStore.capabilities, { textContains: false });
	const native = createNativeSearchAdapter(unsupportedStore);
	const nativeMeta = { ...meta, searchIndexes: [{ name: 'native_fields', adapter: 'native', fields: ['handle'] }] };
	await assert.rejects(() => native.search(nativeMeta, 'safe', {}), /native textContains search/);
	const noFieldNative = createNativeSearchAdapter(new MemoryStoreAdapter());
	assert.deepEqual(await noFieldNative.search({ ...meta, searchIndexes: [] }, 'safe', {}), {
		list: [],
		more: false,
		count: 0
	});
});
