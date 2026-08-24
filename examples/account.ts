import {
	Model,
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	createActiveTs,
	defineModel,
	setDefaultContext
} from '../src/index.js';

type AccountData = {
	id: number;
	handle: string;
};

type RankData = {
	id: number;
	rank: number;
	tier: number;
};

class Account extends Model<AccountData> {}
class Rank extends Model<RankData> {}

defineModel<AccountData>({ name: 'account', cache: { ttl: 86_400 }, search: 'memory' })
	.id('id')
	.index('handle', { unique: true })
	.search('memory', ['handle'])
	.ref('rank', () => Rank, { localKey: 'id', foreignKey: 'id', preload: ['rank', 'tier'] })
	.attach(Account);

defineModel<RankData>({ name: 'rank', cache: { ttl: 21_600 } }).id('id').attach(Rank);

const store = new MemoryStoreAdapter();
const context = createActiveTs({
	stores: { default: store },
	caches: { default: new MemoryCacheAdapter() },
	search: { memory: new MemorySearchAdapter() },
	defaultSearch: 'memory'
});
setDefaultContext(context);

await store.seed('account', [{ id: 1, handle: 'seo' }]);
await store.seed('rank', [{ id: 1, rank: 1, tier: 10 }]);

const account = await Account.find(1).include('rank').load();
const rank = await account?.ref<Rank>('rank');

console.log(account?.data.handle, Array.isArray(rank) ? undefined : rank?.data.rank);
