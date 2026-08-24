import test from 'node:test';
import assert from 'node:assert/strict';
import {
	Model,
	createActiveTs,
	defineModel,
	isPartialModel,
	MemoryStoreAdapter,
	normalizeIncludeSpecs,
	resetLazyLoadWarnings,
	type StoreAdapter
} from '../src/index.js';
import { PARTIAL_MODEL } from '../src/core/partial-model.js';
import { captureLazyLoadWarnings } from '../src/testing/index.js';

type ScopedRecordData = {
	id: number;
	tenantId: string;
	kind: 'invoice' | 'note';
	status: 'open' | 'pending' | 'closed';
	email: string;
};

type IncludeUserData = {
	id: number;
	name: string;
	profileId: number;
};

type OrderedIncludeUserData = IncludeUserData & {
	teamId: number;
	trace?: string;
};

type IncludeProfileData = {
	id: number;
	displayName: string;
	teamId: number;
};

type IncludeTeamData = {
	id: number;
	label: string;
};

type PartialOwnerData = {
	id: number;
	name: string;
};

type PartialArticleData = {
	id: number;
	title: string;
	ownerId: number;
	body?: string;
};

type ManyAuthorData = {
	id: number;
	name: string;
};

type ManyPostData = {
	id: number;
	authorId: number;
	title: string;
};

type ManyCommentData = {
	id: number;
	postId: number;
	authorId: number;
	body: string;
};

type ForeignAccountData = {
	id: number;
	handle: string;
};

type ForeignProfileData = {
	id: number;
	accountHandle: string;
	teamCode: string;
	bio: string;
};

type ForeignTeamData = {
	id: number;
	code: string;
	label: string;
};

type NestedLocalOwnerData = {
	id: number;
	profile: { accountId: number };
};

type NestedLocalProfileData = {
	id: number;
	accountId: number;
	label: string;
};

type HookSelectOwnerData = {
	id: number;
	name: string;
};

type HookSelectArticleData = {
	id: number;
	ownerId: number;
	title: string;
};

class ScopedRecord extends Model<ScopedRecordData> {}
class IncludeUser extends Model<IncludeUserData> {}
class OrderedIncludeUser extends Model<OrderedIncludeUserData> {}
class IncludeProfile extends Model<IncludeProfileData> {}
class IncludeTeam extends Model<IncludeTeamData> {}
class PartialOwner extends Model<PartialOwnerData> {}
class PartialArticle extends Model<PartialArticleData> {}
class ManyAuthor extends Model<ManyAuthorData> {}
class ManyPost extends Model<ManyPostData> {}
class ManyComment extends Model<ManyCommentData> {}
class ForeignAccount extends Model<ForeignAccountData> {}
class ForeignProfile extends Model<ForeignProfileData> {}
class ForeignTeam extends Model<ForeignTeamData> {}
class NestedLocalOwner extends Model<NestedLocalOwnerData> {}
class NestedLocalProfile extends Model<NestedLocalProfileData> {}
class HookSelectOwner extends Model<HookSelectOwnerData> {}
class HookSelectArticle extends Model<HookSelectArticleData> {}

defineModel<ScopedRecordData>('qr_scoped_record')
	.id('id')
	.validate((input) => input as ScopedRecordData)
	.scope('tenant', ({ viewer }) => ({ tenantId: (viewer as { tenantId: string }).tenantId }))
	.attach(ScopedRecord);

defineModel<IncludeUserData>('qr_include_user')
	.id('id')
	.validate((input) => input as IncludeUserData)
	.ref('profile', () => IncludeProfile, { localKey: 'profileId', foreignKey: 'id', preload: ['displayName'] })
	.attach(IncludeUser);

defineModel<OrderedIncludeUserData>('qr_ordered_include_user')
	.id('id')
	.validate((input) => input as OrderedIncludeUserData)
	.ref('profile', () => IncludeProfile, { localKey: 'profileId', foreignKey: 'id' })
	.ref('team', () => IncludeTeam, { localKey: 'teamId', foreignKey: 'id' })
	.attach(OrderedIncludeUser);

defineModel<IncludeProfileData>('qr_include_profile')
	.id('id')
	.validate((input) => input as IncludeProfileData)
	.ref('team', () => IncludeTeam, { localKey: 'teamId', foreignKey: 'id' })
	.attach(IncludeProfile);

defineModel<IncludeTeamData>('qr_include_team')
	.id('id')
	.validate((input) => input as IncludeTeamData)
	.attach(IncludeTeam);

defineModel<PartialOwnerData>('qr_partial_owner')
	.id('id')
	.validate((input) => input as PartialOwnerData)
	.attach(PartialOwner);

defineModel<PartialArticleData>('qr_partial_article')
	.id('id')
	.validate((input) => input as PartialArticleData)
	.ref('owner', () => PartialOwner, { localKey: 'ownerId', foreignKey: 'id' })
	.view('summary', ({ data }) => ({ id: data.id, title: data.title }))
	.policy('owned', ({ data, viewer }) => data.ownerId === (viewer as { id?: number } | undefined)?.id)
	.attach(PartialArticle);

defineModel<ManyAuthorData>('qr_many_author')
	.id('id')
	.validate((input) => input as ManyAuthorData)
	.hasMany('posts', () => ManyPost, { localKey: 'id', foreignKey: 'authorId', preload: ['title'] })
	.attach(ManyAuthor);

defineModel<ManyPostData>('qr_many_post')
	.id('id')
	.validate((input) => input as ManyPostData)
	.hasMany('comments', () => ManyComment, { localKey: 'id', foreignKey: 'postId', preload: ['body'] })
	.attach(ManyPost);

defineModel<ManyCommentData>('qr_many_comment')
	.id('id')
	.validate((input) => input as ManyCommentData)
	.ref('author', () => ManyAuthor, { localKey: 'authorId', foreignKey: 'id' })
	.attach(ManyComment);

defineModel<ForeignAccountData>('qr_foreign_account')
	.id('id')
	.validate((input) => input as ForeignAccountData)
	.ref('profile', () => ForeignProfile, { localKey: 'handle', foreignKey: 'accountHandle', preload: ['bio'] })
	.attach(ForeignAccount);

defineModel<ForeignProfileData>('qr_foreign_profile')
	.id('id')
	.validate((input) => input as ForeignProfileData)
	.ref('team', () => ForeignTeam, { localKey: 'teamCode', foreignKey: 'code' })
	.attach(ForeignProfile);

defineModel<ForeignTeamData>('qr_foreign_team')
	.id('id')
	.validate((input) => input as ForeignTeamData)
	.attach(ForeignTeam);

defineModel<NestedLocalOwnerData>('qr_nested_local_owner')
	.id('id')
	.validate((input) => input as NestedLocalOwnerData)
	.ref('profile', () => NestedLocalProfile, { localKey: 'profile.accountId', foreignKey: 'accountId' })
	.attach(NestedLocalOwner);

defineModel<NestedLocalProfileData>('qr_nested_local_profile')
	.id('id')
	.validate((input) => input as NestedLocalProfileData)
	.attach(NestedLocalProfile);

defineModel<HookSelectOwnerData>('qr_hook_select_owner')
	.id('id')
	.validate((input) => input as HookSelectOwnerData)
	.attach(HookSelectOwner);

defineModel<HookSelectArticleData>('qr_hook_select_article')
	.id('id')
	.validate((input) => input as HookSelectArticleData)
	.ref('owner', () => HookSelectOwner, { localKey: 'ownerId', foreignKey: 'id' })
	.hooks({
		beforeQuery(payload) {
			const plan = payload.plan as any;
			return {
				plan: {
					...plan,
					select: ['id', 'title'],
					include: ['owner']
				}
			};
		}
	})
	.attach(HookSelectArticle);

function setup() {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: true
	});
	return { store, context };
}

function forgePartialMarker(item: unknown) {
	Object.defineProperty(item as object, PARTIAL_MODEL, {
		value: true,
		enumerable: false,
		configurable: true
	});
}

class NoSelectMemoryStore extends MemoryStoreAdapter {
	override readonly capabilities = {
		or: true,
		contains: false,
		arrayContains: true,
		textContains: true,
		jsonContains: true,
		startsWith: true,
		cursor: true,
		offset: true,
		select: false,
		nestedFields: true,
		numericComparisons: true,
		aggregate: true,
		transaction: true,
		transactionConflictDetection: true,
		savepoint: false,
		uniqueIndex: false,
		optimisticLock: true,
		nullOperators: true,
		missingFieldNulls: true,
		native: false
	};
	seenSelects: Array<string[] | undefined> = [];

	override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
		this.seenSelects.push(args[1].select);
		return await super.query(...args);
	}
}

class TransientRelationFailureStore extends MemoryStoreAdapter {
	profileQueries = 0;

	override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
		if (args[0].name === 'qr_include_profile' && ++this.profileQueries === 1) {
			throw new Error('transient relation query failure');
		}
		return await super.query(...args);
	}
}

async function captureWarnings(fn: () => Promise<void>) {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		await fn();
	} finally {
		console.warn = originalWarn;
	}
	return warnings;
}

test('include specs reject invalid runtime shapes', () => {
	const { context } = setup();
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;

	assert.throws(() => User.query().include(null as any), /Include spec/);
	assert.throws(() => User.query().include(1 as any), /Include spec/);
	assert.throws(() => User.query().include(true as any), /Include true/);
	assert.throws(() => User.query().include({ profile: null as any }), /Include spec/);
	assert.throws(() => User.query().include({ [Symbol('profile')]: true } as any), /symbol relation names/);
	let getterCalls = 0;
	const accessorInclude = Object.defineProperty({}, 'profile', {
		enumerable: true,
		get() {
			getterCalls++;
			return true;
		}
	});
	assert.throws(() => User.query().include(accessorInclude as any), /Include spec "profile" must be a data property/);
	assert.equal(getterCalls, 0);
	const hiddenInclude = Object.defineProperty({}, 'profile', {
		enumerable: false,
		value: true
	});
	assert.throws(() => User.query().include(hiddenInclude as any), /Include spec "profile" must be enumerable/);
	assert.throws(() => User.find(1).include(null as any), /Include spec/);
	assert.throws(() => User.search('profile').include(null as any), /Include spec/);
	assert.throws(() => normalizeIncludeSpecs(new Array(1) as any), /include specs\[0\] is missing/);

	let forEachCalls = 0;
	const topLevel = ['profile'] as any[];
	Object.defineProperty(topLevel, 'forEach', {
		value() {
			forEachCalls++;
			throw new Error('custom forEach should not run');
		}
	});
	assert.deepEqual(normalizeIncludeSpecs(topLevel), ['profile']);
	assert.equal(forEachCalls, 0);

	let iteratorCalls = 0;
	const nested = ['team'] as any[];
	Object.defineProperty(nested, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom iterator should not run');
		}
	});
	assert.throws(
		() => normalizeIncludeSpecs([{ profile: nested } as any]),
		/include spec array cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);

	const symbolInclude = ['profile'] as any[];
	Object.defineProperty(symbolInclude, Symbol('include'), { value: true });
	assert.throws(() => normalizeIncludeSpecs(symbolInclude), /include specs cannot contain symbol fields/);
});

test('find builder snapshots include specs when load starts', async () => {
	class CountingStore extends MemoryStoreAdapter {
		profileReads = 0;

		override async getMany(...args: Parameters<MemoryStoreAdapter['getMany']>) {
			if (args[0].name === 'qr_include_profile') this.profileReads++;
			return await super.getMany(...args);
		}
	}
	const store = new CountingStore();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: true });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);

	const builder = User.find(1);
	const pending = builder.load();
	builder.include('profile');
	const loaded = await pending;

	assert.equal(loaded?.data.name, 'alice');
	assert.equal(store.profileReads, 0);
});

test('scoped whereAny keeps tenant and base constraints on every OR branch', async () => {
	const { store, context } = setup();
	const Scoped = ScopedRecord.use(context) as unknown as typeof ScopedRecord;
	await store.seed('qr_scoped_record', [
		{ id: 1, tenantId: 'tenant-a', kind: 'invoice', status: 'open', email: 'shared@example.com' },
		{ id: 2, tenantId: 'tenant-a', kind: 'invoice', status: 'pending', email: 'local@example.com' },
		{ id: 3, tenantId: 'tenant-b', kind: 'invoice', status: 'open', email: 'shared@example.com' },
		{ id: 4, tenantId: 'tenant-a', kind: 'note', status: 'pending', email: 'note@example.com' },
		{ id: 5, tenantId: 'tenant-b', kind: 'invoice', status: 'pending', email: 'remote@example.com' }
	]);

	const result = await Scoped.scope('tenant', { tenantId: 'tenant-a' })
		.where({ kind: 'invoice' })
		.whereAny([{ email: 'shared@example.com' }, { status: 'pending' }, { id: 5 }])
		.orderBy('id')
		.load();

	assert.deepEqual(
		result.list.map((item) => item.data.id),
		[1, 2]
	);
	assert.deepEqual(
		result.list.map((item) => `${item.data.tenantId}:${item.data.kind}`),
		['tenant-a:invoice', 'tenant-a:invoice']
	);
});

test('query scope resolver lookup uses captured Map intrinsics', async () => {
	let plannedFields: string[] = [];
	const store: StoreAdapter = {
		kind: 'scope-map-store',
		capabilities: {},
		get: async () => null,
		getMany: async (_meta, ids) => ids.map(() => null),
		query: async (_meta, plan) => {
			plannedFields = plan.where.map((entry) => entry.field);
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const Scoped = ScopedRecord.use(context) as unknown as typeof ScopedRecord;
	context.meta(ScopedRecord);
	const originalMapGet = Map.prototype.get;
	Object.defineProperty(Map.prototype, 'get', {
		configurable: true,
		value() {
			throw new Error('patched Map.get');
		}
	});
	try {
		await Scoped.query().scope('tenant', { tenantId: 'tenant-a' }).load();
	} finally {
		Object.defineProperty(Map.prototype, 'get', { configurable: true, value: originalMapGet });
	}
	assert.deepEqual(plannedFields, ['tenantId']);
});

test('nested include primes relation refs without unplanned lazy warnings', async () => {
	const { store, context } = setup();
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [
		{ id: 1, name: 'alice', profileId: 101 },
		{ id: 2, name: 'bob', profileId: 102 }
	]);
	await store.seed('qr_include_profile', [
		{ id: 101, displayName: 'Alice A.', teamId: 301 },
		{ id: 102, displayName: 'Bob B.', teamId: 302 }
	]);
	await store.seed('qr_include_team', [
		{ id: 301, label: 'Core' },
		{ id: 302, label: 'Edge' }
	]);

	const warnings = await captureWarnings(async () => {
		resetLazyLoadWarnings();
		const result = await User.query().orderBy('id').include('profile.team').load();
		const getManyAfterInclude = store.stats.getMany;

		const profiles = await Promise.all(result.list.map((user) => user.ref<IncludeProfile>('profile')));
		const teams = await Promise.all(
			profiles.map((profile) => (profile as IncludeProfile).ref<IncludeTeam>('team'))
		);

		assert.deepEqual(
			profiles.map((profile) => (profile as IncludeProfile).data.displayName),
			['Alice A.', 'Bob B.']
		);
		assert.deepEqual(
			teams.map((team) => (team as IncludeTeam).data.label),
			['Core', 'Edge']
		);
		assert.equal(isPartialModel(profiles[0] as IncludeProfile), false);
		assert.equal(store.stats.getMany, getManyAfterInclude);
	});

	assert.deepEqual(warnings, []);
});

test('instance include loads root relation hooks sequentially in requested order', async () => {
	const store = new MemoryStoreAdapter();
	const events: string[] = [];
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'ordered-root-include-hooks',
				hooks: {
					async beforeRelationLoad(payload) {
						if (payload.model?.name !== 'qr_ordered_include_user') return;
						const relation = String(payload.meta?.relation);
						events.push(`before:${relation}`);
						if (relation === 'profile') await new Promise((resolve) => setTimeout(resolve, 10));
					},
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'qr_ordered_include_user') return;
						const relation = String(payload.meta?.relation);
						const target = payload.target as OrderedIncludeUser;
						target.data.trace = target.data.trace ? `${target.data.trace},${relation}` : relation;
						events.push(`after:${relation}`);
					}
				}
			}
		]
	});
	const User = OrderedIncludeUser.use(context) as unknown as typeof OrderedIncludeUser;
	await store.seed('qr_ordered_include_user', [{ id: 1, name: 'ordered', profileId: 101, teamId: 301 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Ordered profile', teamId: 301 }]);
	await store.seed('qr_include_team', [{ id: 301, label: 'Ordered team' }]);

	const user = await User.find(1).load();
	await user!.include('profile', 'team');

	assert.deepEqual(events, ['before:profile', 'after:profile', 'before:team', 'after:team']);
	assert.equal(user!.data.trace, 'profile,team');
});

test('batched relation preloading resolves local keys after beforeRelationLoad hooks', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'relation-key-rewrite',
				hooks: {
					beforeRelationLoad(payload) {
						if (payload.model?.name === 'qr_include_user' && payload.meta?.relation === 'profile') {
							(payload.target as IncludeUser).data.profileId = 102;
						}
					}
				}
			}
		]
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await store.seed('qr_include_profile', [
		{ id: 101, displayName: 'Original profile', teamId: 301 },
		{ id: 102, displayName: 'Hook profile', teamId: 302 }
	]);

	const direct = await User.find(1).include('profile').load();
	const directProfile = await direct?.ref<IncludeProfile>('profile');
	const batched = await User.query().include('profile').first();
	const batchedProfile = await batched?.ref<IncludeProfile>('profile');

	assert.equal((directProfile as IncludeProfile).data.displayName, 'Hook profile');
	assert.equal((batchedProfile as IncludeProfile).data.displayName, 'Hook profile');
});

test('batched relation hooks receive owner-local target instances', async () => {
	const store = new MemoryStoreAdapter();
	const instantiatedProfiles = new WeakSet<object>();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'owner-local-relation-results',
				hooks: {
					afterInstantiate(payload) {
						if (payload.model?.name === 'qr_include_profile') {
							instantiatedProfiles.add(payload.target as object);
						}
					},
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'qr_include_user' || payload.meta?.relation !== 'profile') return;
						const owner = payload.target as IncludeUser;
						const profile = payload.result as IncludeProfile;
						assert.equal(instantiatedProfiles.has(profile), true);
						profile.data.displayName = `${profile.data.displayName}:${owner.data.id}`;
					}
				}
			}
		]
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [
		{ id: 1, name: 'first', profileId: 101 },
		{ id: 2, name: 'second', profileId: 101 }
	]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Shared', teamId: 301 }]);

	const users = (await User.query().orderBy('id').include('profile').load()).list;
	const first = await users[0].ref<IncludeProfile>('profile');
	const second = await users[1].ref<IncludeProfile>('profile');

	assert.notEqual(first, second);
	assert.equal((first as IncludeProfile).data.displayName, 'Shared:1');
	assert.equal((second as IncludeProfile).data.displayName, 'Shared:2');
});

test('batched relation preloading does not reconstruct unshared target instances', async () => {
	type OwnerData = { id: number; targetId: number };
	type TargetData = { id: number; label: string };
	let targetConstructions = 0;
	class Owner extends Model<OwnerData> {}
	class Target extends Model<TargetData> {
		constructor(data: TargetData, context?: any, options?: any) {
			super(data, context, options);
			targetConstructions++;
		}
	}
	defineModel<OwnerData>('qr_unshared_relation_owner')
		.id('id')
		.validate((input) => input as OwnerData)
		.ref('target', () => Target, { localKey: 'targetId', foreignKey: 'id' })
		.attach(Owner);
	defineModel<TargetData>('qr_unshared_relation_target')
		.id('id')
		.validate((input) => input as TargetData)
		.attach(Target);
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const BoundOwner = Owner.use(context) as unknown as typeof Owner;
	await store.seed('qr_unshared_relation_owner', [
		{ id: 1, targetId: 101 },
		{ id: 2, targetId: 102 }
	]);
	await store.seed('qr_unshared_relation_target', [
		{ id: 101, label: 'first' },
		{ id: 102, label: 'second' }
	]);

	await BoundOwner.query().orderBy('id').include('target').load();

	assert.equal(targetConstructions, 2);
});

test('shared relation clones replay constructors from pre-construction data', async () => {
	type OwnerData = { id: number; targetId: number };
	type TargetData = { id: number; label: string };
	let targetConstructions = 0;
	class Owner extends Model<OwnerData> {}
	class Target extends Model<TargetData> {
		constructor(data: TargetData, context?: any, options?: any) {
			data.label = `${data.label}:ctor`;
			super(data, context, options);
			targetConstructions++;
		}
	}
	defineModel<OwnerData>('qr_shared_constructor_owner')
		.id('id')
		.validate((input) => input as OwnerData)
		.ref('target', () => Target, { localKey: 'targetId', foreignKey: 'id', preload: ['label'] })
		.attach(Owner);
	defineModel<TargetData>('qr_shared_constructor_target')
		.id('id')
		.validate((input) => input as TargetData)
		.attach(Target);
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const BoundOwner = Owner.use(context) as unknown as typeof Owner;
	await store.seed('qr_shared_constructor_owner', [
		{ id: 1, targetId: 101 },
		{ id: 2, targetId: 101 }
	]);
	await store.seed('qr_shared_constructor_target', [{ id: 101, label: 'shared' }]);

	const owners = (await BoundOwner.query().orderBy('id').include('target').load()).list;
	const first = await owners[0].ref<Target>('target');
	const second = await owners[1].ref<Target>('target');

	assert.equal(targetConstructions, 2);
	assert.equal((first as Target).data.label, 'shared:ctor');
	assert.equal((second as Target).data.label, 'shared:ctor');
});

test('relation after hooks cannot stale-prime refs by changing owner local keys', async () => {
	const store = new MemoryStoreAdapter();
	let lazyMutations = 0;
	let includeMutations = 0;
	let batchedMutations = 0;
	let afterQueryCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'relation-local-key-after-mutation',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'qr_include_user' || payload.meta?.relation !== 'profile') return;
						const target = payload.target as IncludeUser;
						if (target.data.id === 1 && lazyMutations++ === 0) target.data.profileId = 102;
						if (target.data.id === 2 && includeMutations++ === 0) target.data.profileId = 102;
						if (target.data.id === 3 && batchedMutations++ === 0) target.data.profileId = 102;
					},
					afterQuery(payload) {
						if (payload.model?.name === 'qr_include_user') afterQueryCalls++;
					}
				}
			}
		]
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [
		{ id: 1, name: 'lazy', profileId: 101 },
		{ id: 2, name: 'instance', profileId: 101 },
		{ id: 3, name: 'batched', profileId: 101 }
	]);
	await store.seed('qr_include_profile', [
		{ id: 101, displayName: 'Original profile', teamId: 301 },
		{ id: 102, displayName: 'Hook profile', teamId: 302 }
	]);

	const lazy = await User.find(1).load();
	await assert.rejects(
		() => lazy!.ref<IncludeProfile>('profile').load(),
		/afterRelationLoad qr_include_user\.profile target cannot change qr_include_user\.profileId/
	);
	const lazyReloaded = await lazy!.ref<IncludeProfile>('profile').load();
	assert.equal((lazyReloaded as IncludeProfile).data.displayName, 'Hook profile');

	const included = await User.find(2).load();
	await assert.rejects(
		() => included!.include('profile'),
		/afterRelationLoad qr_include_user\.profile target cannot change qr_include_user\.profileId/
	);
	const includeReloaded = await included!.ref<IncludeProfile>('profile').load();
	assert.equal((includeReloaded as IncludeProfile).data.displayName, 'Hook profile');

	await assert.rejects(
		() => User.query().where({ id: 3 }).include('profile').load(),
		/afterRelationLoad qr_include_user\.profile target item cannot change qr_include_user\.profileId/
	);
	assert.equal(afterQueryCalls, 0);
});

test('relation hooks cannot mutate owner ids before query or search result hooks', async () => {
	const store = new MemoryStoreAdapter();
	let afterQueryCalls = 0;
	let afterSearchCalls = 0;
	const search = {
		kind: 'memory',
		search: async (_model: unknown, _query: string, _options: unknown) => ({ list: [{ id: 1 }], more: false, count: 1 }),
		index: async (_model: unknown, _id: unknown, _data: unknown) => undefined,
		delete: async (_model: unknown, _id: unknown) => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory',
		lazyWarnings: false,
		plugins: [
			{
				name: 'relation-owner-id-mutation',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name === 'qr_include_user' && payload.meta?.relation === 'profile') {
							(payload.target as IncludeUser).data.id = 999;
						}
					},
					afterQuery(payload) {
						if (payload.model?.name === 'qr_include_user') afterQueryCalls++;
					},
					afterSearch(payload) {
						if (payload.model?.name === 'qr_include_user') afterSearchCalls++;
					}
				}
			}
		]
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);

	await assert.rejects(
		() => User.query().include('profile').load(),
		/afterRelationLoad qr_include_user\.profile target item cannot change qr_include_user\.id/
	);
	assert.equal(afterQueryCalls, 0);

	await assert.rejects(
		() => User.search('alice').include('profile').load(),
		/afterRelationLoad qr_include_user\.profile target cannot change qr_include_user\.id/
	);
	assert.equal(afterSearchCalls, 0);
});

test('relation hooks cannot mutate loaded relation ids', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'relation-result-id-mutation',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'qr_include_user' || payload.meta?.relation !== 'profile') return;
						(payload.result as IncludeProfile).data.id = 999;
					}
				}
			}
		]
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [
		{ id: 1, name: 'lazy', profileId: 101 },
		{ id: 2, name: 'find', profileId: 102 },
		{ id: 3, name: 'query', profileId: 103 }
	]);
	await store.seed('qr_include_profile', [
		{ id: 101, displayName: 'Lazy profile', teamId: 301 },
		{ id: 102, displayName: 'Find profile', teamId: 302 },
		{ id: 103, displayName: 'Query profile', teamId: 303 }
	]);

	const lazy = await User.find(1).load();
	await assert.rejects(
		() => lazy!.ref<IncludeProfile>('profile').load(),
		/afterRelationLoad qr_include_user\.profile result item cannot change qr_include_profile\.id/
	);
	await assert.rejects(
		() => User.find(2).include('profile').load(),
		/afterRelationLoad qr_include_user\.profile result item cannot change qr_include_profile\.id/
	);
	await assert.rejects(
		() => User.query().where({ id: 3 }).include('profile').load(),
		/afterRelationLoad qr_include_user\.profile result item cannot change qr_include_profile\.id/
	);
});

test('relation hooks cannot replace loaded relation results through returned payloads', async () => {
	const makeContext = async () => {
		const store = new MemoryStoreAdapter();
		const context = createActiveTs({
			stores: { default: store },
			lazyWarnings: false,
			plugins: [
				{
					name: 'relation-returned-result-removal',
					hooks: {
						afterRelationLoad(payload) {
							if (payload.model?.name !== 'qr_include_user' || payload.meta?.relation !== 'profile') return;
							return { result: null };
						}
					}
				}
			]
		});
		await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
		await store.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);
		return { User: IncludeUser.use(context) as unknown as typeof IncludeUser };
	};
	const rejection = /afterRelationLoad qr_include_user\.profile result cannot remove loaded relation models/;

	const lazy = await makeContext();
	const lazyUser = await lazy.User.find(1).load();
	await assert.rejects(() => lazyUser!.ref<IncludeProfile>('profile').load(), rejection);

	const instance = await makeContext();
	const instanceUser = await instance.User.find(1).load();
	await assert.rejects(() => instanceUser!.include('profile'), rejection);

	const batched = await makeContext();
	await assert.rejects(() => batched.User.query().include('profile').load(), rejection);
});

test('nested relation hooks cannot invalidate parent relation results', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'nested-parent-relation-result-mutation',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'qr_many_post' || payload.meta?.relation !== 'comments') return;
						(payload.target as ManyPost).data.authorId = 999;
					}
				}
			}
		]
	});
	const Author = ManyAuthor.use(context) as unknown as typeof ManyAuthor;
	await store.seed('qr_many_author', [{ id: 1, name: 'Author' }]);
	await store.seed('qr_many_post', [{ id: 10, authorId: 1, title: 'Post' }]);
	await store.seed('qr_many_comment', [{ id: 100, postId: 10, authorId: 1, body: 'Comment' }]);

	await assert.rejects(
		() => Author.query().include('posts.comments').load(),
		/afterRelationLoad qr_many_author\.posts result item cannot change qr_many_post\.authorId/
	);
});

test('relation hooks cannot mutate loaded relation foreign keys', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'relation-result-foreign-key-mutation',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name === 'qr_many_author' && payload.meta?.relation === 'posts') {
							(payload.result as ManyPost[])[0].data.authorId = 999;
						}
						if (payload.model?.name === 'qr_foreign_account' && payload.meta?.relation === 'profile') {
							(payload.result as ForeignProfile).data.accountHandle = 'other';
						}
					}
				}
			}
		]
	});
	const Author = ManyAuthor.use(context) as unknown as typeof ManyAuthor;
	const Account = ForeignAccount.use(context) as unknown as typeof ForeignAccount;
	await store.seed('qr_many_author', [{ id: 1, name: 'Author' }]);
	await store.seed('qr_many_post', [{ id: 10, authorId: 1, title: 'Post' }]);
	await store.seed('qr_foreign_account', [{ id: 2, handle: 'seo' }]);
	await store.seed('qr_foreign_profile', [{ id: 20, accountHandle: 'seo', teamCode: 'core', bio: 'profile' }]);

	await assert.rejects(
		() => Author.query().include('posts').load(),
		/afterRelationLoad qr_many_author\.posts result item cannot change qr_many_post\.authorId/
	);
	const account = await Account.find(2).load();
	await assert.rejects(
		() => account!.ref<ForeignProfile>('profile').load(),
		/afterRelationLoad qr_foreign_account\.profile result item cannot change qr_foreign_profile\.accountHandle/
	);
});

test('relation hooks cannot remove or duplicate loaded relation list items', async () => {
	const makeContext = (mode: 'remove' | 'duplicate') => {
		const store = new MemoryStoreAdapter();
		const context = createActiveTs({
			stores: { default: store },
			lazyWarnings: false,
			plugins: [
				{
					name: `relation-result-${mode}`,
					hooks: {
						afterRelationLoad(payload) {
							if (payload.model?.name !== 'qr_many_author' || payload.meta?.relation !== 'posts') return;
							const result = payload.result as ManyPost[];
							if (mode === 'remove') result.pop();
							else result[1] = result[0];
						}
					}
				}
			]
		});
		return { store, Author: ManyAuthor.use(context) as unknown as typeof ManyAuthor };
	};
	const seed = async (store: MemoryStoreAdapter) => {
		await store.seed('qr_many_author', [{ id: 1, name: 'Author' }]);
		await store.seed('qr_many_post', [
			{ id: 10, authorId: 1, title: 'First' },
			{ id: 11, authorId: 1, title: 'Second' }
		]);
	};

	const remove = makeContext('remove');
	await seed(remove.store);
	const author = await remove.Author.find(1).load();
	await assert.rejects(
		() => author!.ref<ManyPost[]>('posts').load(),
		/afterRelationLoad qr_many_author\.posts result cannot remove loaded relation models/
	);

	const duplicate = makeContext('duplicate');
	await seed(duplicate.store);
	await assert.rejects(
		() => duplicate.Author.query().include('posts').load(),
		/afterRelationLoad qr_many_author\.posts result cannot duplicate loaded relation models/
	);
});

test('lazy relation hooks cannot forge partial markers on full owners', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'lazy-owner-partial-marker',
				hooks: {
					beforeRelationLoad(payload) {
						if (payload.model?.name === 'qr_ordered_include_user' && payload.meta?.relation === 'profile') {
							forgePartialMarker(payload.target);
						}
					}
				}
			}
		]
	});
	const User = OrderedIncludeUser.use(context) as unknown as typeof OrderedIncludeUser;
	await store.seed('qr_ordered_include_user', [{ id: 1, name: 'owner', profileId: 101, teamId: 301 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Profile', teamId: 301 }]);

	const user = await User.find(1).load();
	await assert.rejects(
		() => user!.ref<IncludeProfile>('profile').load(),
		/partial marker state/
	);
});

test('relation result hooks cannot forge partial markers on full relation results', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'lazy-result-partial-marker',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name === 'qr_ordered_include_user' && payload.meta?.relation === 'profile') {
							forgePartialMarker(payload.result);
						}
					}
				}
			}
		]
	});
	const User = OrderedIncludeUser.use(context) as unknown as typeof OrderedIncludeUser;
	await store.seed('qr_ordered_include_user', [{ id: 1, name: 'owner', profileId: 101, teamId: 301 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Profile', teamId: 301 }]);

	const user = await User.find(1).load();
	await assert.rejects(
		() => user!.ref<IncludeProfile>('profile').load(),
		/partial marker state/
	);
});

test('relation refs are instance-local snapshots while fresh owners can reload updated targets', async () => {
	const { store, context } = setup();
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	const Profile = IncludeProfile.use(context) as unknown as typeof IncludeProfile;
	await store.seed('qr_include_user', [{ id: 1, name: 'User', profileId: 10 }]);
	await store.seed('qr_include_profile', [{ id: 10, displayName: 'Before', teamId: 20 }]);

	const user = await User.find(1).include('profile').load();
	const firstProfile = await user?.ref<IncludeProfile>('profile');
	assert.equal((firstProfile as IncludeProfile).data.displayName, 'Before');

	await Profile.update(10, { displayName: 'After' } as any);
	const sameOwnerProfile = await user?.ref<IncludeProfile>('profile');
	const freshOwner = await User.find(1).include('profile').load();
	const freshProfile = await freshOwner?.ref<IncludeProfile>('profile');

	assert.equal(sameOwnerProfile, firstProfile);
	assert.equal((sameOwnerProfile as IncludeProfile).data.displayName, 'Before');
	assert.equal((freshProfile as IncludeProfile).data.displayName, 'After');
});

test('cached relation refs reload when an ambient transaction changes context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	const Profile = IncludeProfile.use(context) as unknown as typeof IncludeProfile;
	await store.seed('qr_include_user', [{ id: 1, name: 'User', profileId: 10 }]);
	await store.seed('qr_include_profile', [{ id: 10, displayName: 'Before', teamId: 20 }]);

	const user = await User.find(1).load();
	const firstProfile = await user?.ref<IncludeProfile>('profile');
	assert.equal((firstProfile as IncludeProfile).data.displayName, 'Before');

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxProfile = Profile.use(tx) as unknown as typeof IncludeProfile;
				await TxProfile.update(10, { displayName: 'Inside transaction' } as any);
				const txProfile = await user?.ref<IncludeProfile>('profile');
				assert.equal((txProfile as IncludeProfile).data.displayName, 'Inside transaction');
				throw new Error('rollback relation reload');
			}),
		/rollback relation reload/
	);

	assert.equal((await Profile.find(10).load())?.data.displayName, 'Before');
});

test('preloaded relation includes reload when an ambient transaction changes context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	const Profile = IncludeProfile.use(context) as unknown as typeof IncludeProfile;
	await store.seed('qr_include_user', [{ id: 2, name: 'User', profileId: 11 }]);
	await store.seed('qr_include_profile', [{ id: 11, displayName: 'Before include', teamId: 21 }]);

	const user = await User.find(2).include('profile').load();
	const firstProfile = await user?.ref<IncludeProfile>('profile');
	assert.equal((firstProfile as IncludeProfile).data.displayName, 'Before include');

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxProfile = Profile.use(tx) as unknown as typeof IncludeProfile;
				await TxProfile.update(11, { displayName: 'Inside include transaction' } as any);
				const txProfile = await user?.ref<IncludeProfile>('profile');
				assert.equal((txProfile as IncludeProfile).data.displayName, 'Inside include transaction');
				throw new Error('rollback preloaded relation');
			}),
		/rollback preloaded relation/
	);

	assert.equal((await Profile.find(11).load())?.data.displayName, 'Before include');
});

test('lazy relation warnings are tracked per context', async () => {
	const firstStore = new MemoryStoreAdapter();
	const secondStore = new MemoryStoreAdapter();
	const firstContext = createActiveTs({ stores: { default: firstStore }, lazyWarnings: true });
	const secondContext = createActiveTs({ stores: { default: secondStore }, lazyWarnings: true });
	const FirstUser = IncludeUser.use(firstContext) as unknown as typeof IncludeUser;
	const SecondUser = IncludeUser.use(secondContext) as unknown as typeof IncludeUser;
	for (const store of [firstStore, secondStore]) {
		await store.seed('qr_include_user', [{ id: 1, name: 'User', profileId: 10 }]);
		await store.seed('qr_include_profile', [{ id: 10, displayName: 'Profile', teamId: 20 }]);
	}

	const warnings = await captureWarnings(async () => {
		resetLazyLoadWarnings();
		const first = await FirstUser.find(1).load();
		await first?.ref<IncludeProfile>('profile');
		const second = await SecondUser.find(1).load();
		await second?.ref<IncludeProfile>('profile');
	});

	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /qr_include_user:profile/);
	assert.match(warnings[1], /qr_include_user:profile/);
});

test('lazy relation planning and warning dedupe use captured collection intrinsics', async () => {
	const { store, context } = setup();
	const User = OrderedIncludeUser.use(context) as unknown as typeof OrderedIncludeUser;
	await store.seed('qr_ordered_include_user', [{ id: 1, name: 'User', profileId: 10, teamId: 20 }]);
	await store.seed('qr_include_profile', [{ id: 10, displayName: 'Profile', teamId: 20 }]);

	const originalHas = Set.prototype.has;
	const originalAdd = Set.prototype.add;
	const originalWeakMapGet = WeakMap.prototype.get;
	const originalWeakMapSet = WeakMap.prototype.set;
	Object.defineProperty(Set.prototype, 'has', {
		configurable: true,
		value() {
			throw new Error('patched Set.has');
		}
	});
	Object.defineProperty(Set.prototype, 'add', {
		configurable: true,
		value() {
			throw new Error('patched Set.add');
		}
	});
	Object.defineProperty(WeakMap.prototype, 'get', {
		configurable: true,
		value() {
			throw new Error('patched WeakMap.get');
		}
	});
	Object.defineProperty(WeakMap.prototype, 'set', {
		configurable: true,
		value() {
			throw new Error('patched WeakMap.set');
		}
	});
	try {
		const warnings = await captureWarnings(async () => {
			resetLazyLoadWarnings();
			const lazy = await User.find(1).load();
			await lazy?.ref<IncludeProfile>('profile');
			await lazy?.ref<IncludeProfile>('profile');

			const planned = await User.find(1).include('profile').load();
			await planned?.ref<IncludeProfile>('profile');
		});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /qr_ordered_include_user:profile/);
	} finally {
		Object.defineProperty(Set.prototype, 'has', { configurable: true, value: originalHas });
		Object.defineProperty(Set.prototype, 'add', { configurable: true, value: originalAdd });
		Object.defineProperty(WeakMap.prototype, 'get', { configurable: true, value: originalWeakMapGet });
		Object.defineProperty(WeakMap.prototype, 'set', { configurable: true, value: originalWeakMapSet });
	}
});

test('lazy warning capture resets relation warning dedupe around callback', async () => {
	const { store, context } = setup();
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'User', profileId: 10 }]);
	await store.seed('qr_include_profile', [{ id: 10, displayName: 'Profile', teamId: 20 }]);

	const primingWarnings = await captureWarnings(async () => {
		resetLazyLoadWarnings();
		const first = await User.find(1).load();
		await first?.ref<IncludeProfile>('profile');
	});
	assert.equal(primingWarnings.length, 1);

	const second = await User.find(1).load();
	const captured = await captureLazyLoadWarnings(async () => {
		await second?.ref<IncludeProfile>('profile');
	});
	assert.equal(captured.warnings.length, 1);
	assert.match(captured.warnings[0], /qr_include_user:profile/);

	const after = await User.find(1).load();
	const afterWarnings = await captureWarnings(async () => {
		await after?.ref<IncludeProfile>('profile');
	});
	assert.equal(afterWarnings.length, 1);
});

test('failed lazy relation loads can be retried on the same instance', async () => {
	const store = new TransientRelationFailureStore();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'User', profileId: 10 }]);
	await store.seed('qr_include_profile', [{ id: 10, displayName: 'Profile', teamId: 20 }]);

	const user = await User.find(1).load();
	await assert.rejects(
		() => user!.ref<IncludeProfile>('profile').load(),
		/transient relation query failure/
	);
	const profile = await user!.ref<IncludeProfile>('profile').load();

	assert.equal((profile as IncludeProfile).data.displayName, 'Profile');
	assert.equal(store.profileQueries, 2);
});

test('failed include hooks do not leave relation refs primed', async () => {
	const store = new MemoryStoreAdapter();
	let afterRelationCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'first-include-fails',
				hooks: {
					afterRelationLoad(payload) {
						if (payload.model?.name !== 'qr_include_user' || payload.meta?.relation !== 'profile') return;
						afterRelationCalls++;
						if (afterRelationCalls === 1) throw new Error('relation authorization failed');
					}
				}
			}
		]
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'User', profileId: 10 }]);
	await store.seed('qr_include_profile', [{ id: 10, displayName: 'Profile', teamId: 20 }]);

	const user = await User.find(1).load();
	await assert.rejects(() => user!.include('profile'), /relation authorization failed/);
	const profile = await user!.ref<IncludeProfile>('profile').load();

	assert.equal((profile as IncludeProfile).data.displayName, 'Profile');
	assert.equal(afterRelationCalls, 2);
});

test('find include loads full targets when a preloaded relation has nested includes', async () => {
	const { store, context } = setup();
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);
	await store.seed('qr_include_team', [{ id: 301, label: 'Core' }]);

	const user = await User.find(1).include('profile.team').load();
	const profile = await user?.ref<IncludeProfile>('profile');
	const team = await (profile as IncludeProfile).ref<IncludeTeam>('team');

	assert.equal(isPartialModel(profile as IncludeProfile), false);
	assert.equal((team as IncludeTeam).data.label, 'Core');
});

test('find include groups overlapping root and nested relation paths', async () => {
	const store = new MemoryStoreAdapter();
	const relationLoads: string[] = [];
	const context = createActiveTs({
		stores: { default: store },
		lazyWarnings: false,
		plugins: [
			{
				name: 'relation-load-counter',
				hooks: {
					beforeRelationLoad(payload) {
						relationLoads.push(`${payload.model?.name}:${payload.meta?.relation}`);
					}
				}
			}
		]
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);
	await store.seed('qr_include_team', [{ id: 301, label: 'Core' }]);

	const user = await User.find(1).include('profile', 'profile.team').load();
	const profile = await user?.ref<IncludeProfile>('profile');
	const team = await (profile as IncludeProfile).ref<IncludeTeam>('team');

	assert.equal(isPartialModel(profile as IncludeProfile), false);
	assert.equal((profile as IncludeProfile).data.teamId, 301);
	assert.equal((team as IncludeTeam).data.label, 'Core');
	assert.deepEqual(relationLoads, ['qr_include_user:profile', 'qr_include_profile:team']);
});

test('preloaded partial relation can be upgraded to full for later nested include', async () => {
	const { store, context } = setup();
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);
	await store.seed('qr_include_team', [{ id: 301, label: 'Core' }]);

	const user = await User.find(1).include('profile').load();
	const preloadedProfile = await user?.ref<IncludeProfile>('profile');
	assert.equal(isPartialModel(preloadedProfile as IncludeProfile), true);
	assert.equal((preloadedProfile as IncludeProfile).data.teamId, undefined);

	await user?.include('profile.team');
	const fullProfile = await user?.ref<IncludeProfile>('profile');
	const team = await (fullProfile as IncludeProfile).ref<IncludeTeam>('team');

	assert.equal(isPartialModel(fullProfile as IncludeProfile), false);
	assert.equal((fullProfile as IncludeProfile).data.teamId, 301);
	assert.equal((team as IncludeTeam).data.label, 'Core');
});

test('relation preload falls back to full rows when target store does not support select', async () => {
	const store = new NoSelectMemoryStore();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await store.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await store.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);

	const user = await User.find(1).include('profile').load();
	const profile = await user?.ref<IncludeProfile>('profile');

	assert.equal(isPartialModel(profile as IncludeProfile), false);
	assert.equal((profile as IncludeProfile).data.teamId, 301);
	assert.deepEqual(store.seenSelects, [undefined]);
});

test('relation preload checks routed target store select capability', async () => {
	const defaultStore = new MemoryStoreAdapter();
	const routedStore = new NoSelectMemoryStore();
	const context = createActiveTs({
		stores: { default: defaultStore, routed: routedStore },
		lazyWarnings: false,
		queryPlanner: {
			routeQuery({ model }) {
				if (model.name === 'qr_include_profile') return 'routed';
				return undefined;
			}
		}
	});
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	await defaultStore.seed('qr_include_user', [{ id: 1, name: 'alice', profileId: 101 }]);
	await routedStore.seed('qr_include_profile', [{ id: 101, displayName: 'Alice A.', teamId: 301 }]);

	const user = await User.find(1).include('profile').load();
	const profile = await user?.ref<IncludeProfile>('profile');

	assert.equal(isPartialModel(profile as IncludeProfile), false);
	assert.equal((profile as IncludeProfile).data.teamId, 301);
	assert.deepEqual(routedStore.seenSelects, [undefined]);
});

test('relation keys reject non-portable runtime values before adapter queries', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	const Account = ForeignAccount.use(context) as unknown as typeof ForeignAccount;
	await store.seed('qr_include_user', [{ id: 1, name: 'bad', profileId: { object: true } as any }]);
	await store.seed('qr_foreign_account', [{ id: 2, handle: { object: true } as any }]);

	await assert.rejects(() => User.find(1).include('profile').load(), /relation key.*string or safe integer/);
	const account = await Account.find(2).load();
	await assert.rejects(
		async () => await account!.ref<ForeignProfile>('profile'),
		/relation key.*string, number, boolean, Date, or null/
	);
});

test('hasMany relations with preload load full targets when nested includes are requested', async () => {
	const { store, context } = setup();
	const Author = ManyAuthor.use(context) as unknown as typeof ManyAuthor;
	await store.seed('qr_many_author', [
		{ id: 1, name: 'Author' },
		{ id: 2, name: 'Commenter' }
	]);
	await store.seed('qr_many_post', [{ id: 10, authorId: 1, title: 'Post' }]);
	await store.seed('qr_many_comment', [{ id: 100, postId: 10, authorId: 2, body: 'Comment' }]);

	const author = await Author.find(1).include('posts.comments.author').load();
	const posts = await author?.ref<ManyPost>('posts');
	const comments = await (posts as ManyPost[])[0].ref<ManyComment>('comments');
	const commenter = await (comments as ManyComment[])[0].ref<ManyAuthor>('author');

	assert.equal(isPartialModel((posts as ManyPost[])[0]), false);
	assert.equal(isPartialModel((comments as ManyComment[])[0]), false);
	assert.equal((comments as ManyComment[])[0].data.authorId, 2);
	assert.equal((commenter as ManyAuthor).data.name, 'Commenter');
});

test('relation preload chunks portable in queries when owner batches exceed the operand limit', async () => {
	const { store, context } = setup();
	const Author = ManyAuthor.use(context) as unknown as typeof ManyAuthor;
	const authors = Array.from({ length: 35 }, (_, index) => ({ id: index + 1, name: `Author ${index + 1}` }));
	const posts = authors.map((author) => ({
		id: author.id + 100,
		authorId: author.id,
		title: `Post ${author.id}`
	}));
	await store.seed('qr_many_author', authors);
	await store.seed('qr_many_post', posts);

	const originalSlice = Array.prototype.slice;
	const originalSort = Array.prototype.sort;
	const originalReverse = Array.prototype.reverse;
	let result: any;
	let loadedPosts: any[] = [];
	Object.defineProperty(Array.prototype, 'slice', {
		configurable: true,
		value() {
			throw new Error('patched Array.slice');
		}
	});
	Object.defineProperty(Array.prototype, 'sort', {
		configurable: true,
		value() {
			throw new Error('patched Array.sort');
		}
	});
	Object.defineProperty(Array.prototype, 'reverse', {
		configurable: true,
		value() {
			throw new Error('patched Array.reverse');
		}
	});
	try {
		result = await Author.query().orderBy('id').include('posts').load();
		const tasks: any[] = [];
		for (let index = 0; index < result.list.length; index++) {
			tasks[index] = (result.list[index] as ManyAuthor).ref<ManyPost>('posts');
		}
		loadedPosts = await Promise.all(tasks);
	} finally {
		Object.defineProperty(Array.prototype, 'slice', { configurable: true, value: originalSlice });
		Object.defineProperty(Array.prototype, 'sort', { configurable: true, value: originalSort });
		Object.defineProperty(Array.prototype, 'reverse', { configurable: true, value: originalReverse });
	}

	assert.equal(result.list.length, 35);
	assert.deepEqual(
		loadedPosts.map((items) => (items as ManyPost[]).map((post) => post.data.title)),
		authors.map((author) => [`Post ${author.id}`])
	);
	assert.equal(store.stats.query, 3);
});

test('non-id foreignKey relations with preload load full targets for nested includes', async () => {
	const { store, context } = setup();
	const Account = ForeignAccount.use(context) as unknown as typeof ForeignAccount;
	await store.seed('qr_foreign_account', [{ id: 1, handle: 'seo' }]);
	await store.seed('qr_foreign_profile', [{ id: 10, accountHandle: 'seo', teamCode: 'core', bio: 'profile' }]);
	await store.seed('qr_foreign_team', [{ id: 20, code: 'core', label: 'Core' }]);

	const account = await Account.find(1).include('profile.team').load();
	const profile = await account?.ref<ForeignProfile>('profile');
	const team = await (profile as ForeignProfile).ref<ForeignTeam>('team');

	assert.equal(isPartialModel(profile as ForeignProfile), false);
	assert.equal((profile as ForeignProfile).data.teamCode, 'core');
	assert.equal((team as ForeignTeam).data.label, 'Core');
});

test('non-id foreignKey relation preload includes the foreign key for find and query paths', async () => {
	const { store, context } = setup();
	const Account = ForeignAccount.use(context) as unknown as typeof ForeignAccount;
	await store.seed('qr_foreign_account', [{ id: 1, handle: 'seo' }]);
	await store.seed('qr_foreign_profile', [{ id: 10, accountHandle: 'seo', teamCode: 'core', bio: 'profile' }]);

	const direct = await Account.find(1).include('profile').load();
	const directProfile = await direct?.ref<ForeignProfile>('profile');
	const batched = await Account.query().include('profile').first();
	const batchedProfile = await batched?.ref<ForeignProfile>('profile');

	assert.equal(isPartialModel(directProfile as ForeignProfile), true);
	assert.equal((directProfile as ForeignProfile).data.accountHandle, 'seo');
	assert.equal((directProfile as ForeignProfile).data.bio, 'profile');
	assert.equal((directProfile as ForeignProfile).data.teamCode, undefined);
	assert.equal(isPartialModel(batchedProfile as ForeignProfile), true);
	assert.equal((batchedProfile as ForeignProfile).data.accountHandle, 'seo');
	assert.equal((batchedProfile as ForeignProfile).data.bio, 'profile');
	assert.equal((batchedProfile as ForeignProfile).data.teamCode, undefined);
});

test('lazy relation loading resolves nested localKey paths', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const Owner = NestedLocalOwner.use(context) as unknown as typeof NestedLocalOwner;
	await store.seed('qr_nested_local_owner', [{ id: 1, profile: { accountId: 7 } }]);
	await store.seed('qr_nested_local_profile', [{ id: 10, accountId: 7, label: 'nested' }]);

	const owner = await Owner.find(1).load();
	const profile = await owner?.ref<NestedLocalProfile>('profile');

	assert.equal((profile as NestedLocalProfile).data.label, 'nested');
});

test('beforeQuery hooks cannot smuggle select and include together', async () => {
	const { store, context } = setup();
	const Article = HookSelectArticle.use(context) as unknown as typeof HookSelectArticle;
	await store.seed('qr_hook_select_owner', [{ id: 1, name: 'Owner' }]);
	await store.seed('qr_hook_select_article', [{ id: 1, ownerId: 1, title: 'Article' }]);

	await assert.rejects(
		() => Article.query().load(),
		/select\(\) cannot be combined with include\(\)/
	);
});

test('select queries reject include before returning partial relation hosts', async () => {
	const { store, context } = setup();
	const Article = PartialArticle.use(context) as unknown as typeof PartialArticle;
	await store.seed('qr_partial_owner', [{ id: 7, name: 'owner' }]);
	await store.seed('qr_partial_article', [{ id: 1, title: 'Original', ownerId: 7, body: 'hidden' }]);

	await assert.rejects(
		() => Article.query().select('title', 'ownerId').include('owner').load(),
		/select\(\) cannot be combined with include\(\)/
	);
});

test('partial select instances reject full-model operations beyond save and relation load', async () => {
	const { store, context } = setup();
	const Article = PartialArticle.use(context) as unknown as typeof PartialArticle;
	await store.seed('qr_partial_owner', [{ id: 7, name: 'owner' }]);
	await store.seed('qr_partial_article', [{ id: 1, title: 'Original', ownerId: 7, body: 'hidden' }]);

	const article = await Article.query().select('title', 'ownerId').first();
	assert.ok(article);
	assert.equal(isPartialModel(article), true);
	assert.deepEqual(article.data, { id: 1, title: 'Original', ownerId: 7 });

	await assert.rejects(() => (article as any).view('summary'), /partial qr_partial_article instance/);
	await assert.rejects(() => (article as any).can('owned', { id: 7 }), /partial qr_partial_article instance/);
	assert.throws(() => (article as any).ref('owner'), /partial qr_partial_article instance/);
	await assert.rejects(() => (article as any).include('owner'), /partial qr_partial_article instance/);

	article.data.title = 'Changed';
	await assert.rejects(() => (article as any).save(), /partial qr_partial_article instance/);

	const full = await Article.find(1).load();
	assert.equal(full?.data.title, 'Original');
	assert.equal(full?.data.body, 'hidden');
});

test('saved models clear cached relation refs after local key changes', async () => {
	const { store, context } = setup();
	const Article = PartialArticle.use(context) as unknown as typeof PartialArticle;
	await store.seed('qr_partial_owner', [
		{ id: 1, name: 'first owner' },
		{ id: 2, name: 'second owner' }
	]);
	await store.seed('qr_partial_article', [{ id: 1, title: 'Article', ownerId: 1, body: 'body' }]);

	const article = (await Article.find(1).load())!;
	const firstOwner = await article.ref<PartialOwner>('owner').load();
	assert.ok(firstOwner && !Array.isArray(firstOwner));
	assert.equal(firstOwner.data.name, 'first owner');

	article.data.ownerId = 2;
	await article.save();

	const secondOwner = await article.ref<PartialOwner>('owner').load();
	assert.ok(secondOwner && !Array.isArray(secondOwner));
	assert.equal(secondOwner.data.name, 'second owner');
	assert.equal((await Article.find(1).load())?.data.ownerId, 2);
});

test('model relation view and policy helpers use captured Map intrinsics', async () => {
	const { store, context } = setup();
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	const Article = PartialArticle.use(context) as unknown as typeof PartialArticle;
	await store.seed('qr_include_profile', [{ id: 201, displayName: 'Map Safe', teamId: 1 }]);
	await store.seed('qr_include_user', [{ id: 101, name: 'Map User', profileId: 201 }]);
	await store.seed('qr_partial_article', [{ id: 301, title: 'Map Article', ownerId: 7 }]);
	const user = (await User.find(101).load())!;
	const article = (await Article.find(301).load())!;
	await user.ref('profile').load();
	context.meta(IncludeUser);
	context.meta(PartialArticle);

	const originalMapGet = Map.prototype.get;
	const originalMapSet = Map.prototype.set;
	Object.defineProperty(Map.prototype, 'get', {
		configurable: true,
		value() {
			throw new Error('patched Map.get');
		}
	});
	Object.defineProperty(Map.prototype, 'set', {
		configurable: true,
		value() {
			throw new Error('patched Map.set');
		}
	});
	try {
		const profile = await user.ref('profile').load();
		assert.equal(profile?.data.displayName, 'Map Safe');
		await user.include('profile');
		assert.deepEqual(await article.view('summary'), { id: 301, title: 'Map Article' });
		assert.equal(await article.can('owned', { id: 7 }), true);
	} finally {
		Object.defineProperty(Map.prototype, 'get', { configurable: true, value: originalMapGet });
		Object.defineProperty(Map.prototype, 'set', { configurable: true, value: originalMapSet });
	}
});

test('query include preloader uses captured Map intrinsics', async () => {
	const users = [{ id: 101, name: 'Map Query User', profileId: 201 }];
	const profiles = [{ id: 201, displayName: 'Map Query Profile', teamId: 1 }];
	const store: StoreAdapter = {
		kind: 'query-map-store',
		capabilities: { select: true },
		get: async (meta, id) => {
			const rows = meta.name === 'qr_include_user' ? users : profiles;
			return rows.find((row) => row.id === id) ?? null;
		},
		getMany: async (meta, ids) => {
			const rows = meta.name === 'qr_include_user' ? users : profiles;
			return ids.map((id) => rows.find((row) => row.id === id) ?? null);
		},
		query: async (meta) => ({
			list: meta.name === 'qr_include_user' ? users.map((row) => ({ ...row })) : profiles.map((row) => ({ ...row })),
			more: false
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;
	context.meta(IncludeUser);
	context.meta(IncludeProfile);

	const originalMapGet = Map.prototype.get;
	const originalMapSet = Map.prototype.set;
	Object.defineProperty(Map.prototype, 'get', {
		configurable: true,
		value() {
			throw new Error('patched Map.get');
		}
	});
	Object.defineProperty(Map.prototype, 'set', {
		configurable: true,
		value() {
			throw new Error('patched Map.set');
		}
	});
	try {
		const result = await User.query().include('profile').load();
		assert.equal(result.list.length, 1);
		const profile = await result.list[0].ref<IncludeProfile>('profile').load();
		assert.ok(profile && !Array.isArray(profile));
		assert.equal(profile?.data.displayName, 'Map Query Profile');
	} finally {
		Object.defineProperty(Map.prototype, 'get', { configurable: true, value: originalMapGet });
		Object.defineProperty(Map.prototype, 'set', { configurable: true, value: originalMapSet });
	}
});

test('query include preloader ignores patched Array transforms', async () => {
	const { store, context } = setup();
	await store.create(context.meta(IncludeUser), 201, { id: 201, name: 'Array User', profileId: 301 });
	await store.create(context.meta(IncludeProfile), 301, { id: 301, displayName: 'Array Profile', teamId: 1 });
	const User = IncludeUser.use(context) as unknown as typeof IncludeUser;

	const originalMap = Array.prototype.map;
	const originalFilter = Array.prototype.filter;
	const originalForEach = Array.prototype.forEach;
	const originalFrom = Array.from;
	const originalSlice = Array.prototype.slice;
	const originalSort = Array.prototype.sort;
	const originalReverse = Array.prototype.reverse;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'filter', {
		configurable: true,
		value() {
			throw new Error('patched Array.filter');
		}
	});
	Object.defineProperty(Array.prototype, 'forEach', {
		configurable: true,
		value() {
			throw new Error('patched Array.forEach');
		}
	});
	Object.defineProperty(Array, 'from', {
		configurable: true,
		value() {
			throw new Error('patched Array.from');
		}
	});
	Object.defineProperty(Array.prototype, 'slice', {
		configurable: true,
		value() {
			throw new Error('patched Array.slice');
		}
	});
	Object.defineProperty(Array.prototype, 'sort', {
		configurable: true,
		value() {
			throw new Error('patched Array.sort');
		}
	});
	Object.defineProperty(Array.prototype, 'reverse', {
		configurable: true,
		value() {
			throw new Error('patched Array.reverse');
		}
	});
	try {
		const result = await User.query().orderBy('id').limit(1).include('profile').load();
		assert.equal(result.list.length, 1);
		const profile = await result.list[0].ref<IncludeProfile>('profile').load();
		assert.ok(profile && !Array.isArray(profile));
		assert.equal(profile?.data.displayName, 'Array Profile');
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: originalMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: originalFilter });
		Object.defineProperty(Array.prototype, 'forEach', { configurable: true, value: originalForEach });
		Object.defineProperty(Array, 'from', { configurable: true, value: originalFrom });
		Object.defineProperty(Array.prototype, 'slice', { configurable: true, value: originalSlice });
		Object.defineProperty(Array.prototype, 'sort', { configurable: true, value: originalSort });
		Object.defineProperty(Array.prototype, 'reverse', { configurable: true, value: originalReverse });
	}
});

test('direct model include ignores patched Array transforms for nested has-many relations', async () => {
	const { store, context } = setup();
	const Author = ManyAuthor.use(context) as unknown as typeof ManyAuthor;
	await store.seed('qr_many_author', [{ id: 1, name: 'Author' }]);
	await store.seed('qr_many_post', [
		{ id: 10, authorId: 1, title: 'First' },
		{ id: 11, authorId: 1, title: 'Second' }
	]);
	await store.seed('qr_many_comment', [
		{ id: 100, postId: 10, authorId: 1, body: 'First comment' },
		{ id: 101, postId: 11, authorId: 1, body: 'Second comment' }
	]);
	const author = await Author.find(1).load();

	const originalMap = Array.prototype.map;
	const originalFilter = Array.prototype.filter;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'filter', {
		configurable: true,
		value() {
			throw new Error('patched Array.filter');
		}
	});
	try {
		await author!.include('posts.comments');
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: originalMap });
		Object.defineProperty(Array.prototype, 'filter', { configurable: true, value: originalFilter });
	}

	const posts = await author!.ref<ManyPost>('posts');
	const firstComments = await (posts as ManyPost[])[0].ref<ManyComment>('comments');
	const secondComments = await (posts as ManyPost[])[1].ref<ManyComment>('comments');
	assert.equal((firstComments as ManyComment[])[0].data.body, 'First comment');
	assert.equal((secondComments as ManyComment[])[0].data.body, 'Second comment');
});
