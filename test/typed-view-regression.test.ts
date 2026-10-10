import test from 'node:test';
import assert from 'node:assert/strict';
import {
	Model, createActiveTs, defineModel, defineTypedView,
	MemoryStoreAdapter, MemoryCacheAdapter, ActiveTsConfigurationError
} from '../src/index.js';

type Row = { id: number; name: string; secret: string };
function parseSummary(value: unknown): { id: number; name: string } {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid summary');
	const row = value as Record<string, unknown>;
	if (typeof row.id !== 'number' || typeof row.name !== 'string') throw new TypeError('Invalid summary');
	return { id: row.id, name: row.name };
}
function fixture() {
	class Account extends Model<Row> {
		static category = 'account' as const;
		label() { return this.data.name.toUpperCase(); }
	}
	const summary = defineTypedView<Row>()({ name: 'summary', resolve: ({ data }) => data, parse: parseSummary });
	defineModel<Row>({ name: 'typed_account', cache: { ttl: 60 } }).id('id').view(summary).attach(Account);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, caches: { default: new MemoryCacheAdapter() } });
	return { Account, Bound: Account.use(context), context, summary };
}

test('use preserves constructor, instance methods, statics and repeated context binding', async () => {
	const { Account, Bound, context } = fixture();
	assert.equal(Bound.category, 'account');
	const item = await Bound.create({ id: 1, name: 'first', secret: 'hidden' });
	assert.ok(item instanceof Account);
	assert.equal(item.label(), 'FIRST');
	assert.equal((await Bound.find(1).load())?.label(), 'FIRST');
	const other = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Rebound = Bound.use(other);
	assert.equal(await Rebound.find(1).load(), null);
	await Rebound.create({ id: 1, name: 'second', secret: 'different' });
	assert.equal((await Rebound.find(1).load())?.label(), 'SECOND');
	assert.equal((await Bound.use(context).find(1).load())?.label(), 'FIRST');
});

test('typed and legacy string reads both execute the registered output parser', async () => {
	const { Bound, summary } = fixture();
	const account = await Bound.create({ id: 1, name: 'public', secret: 'hidden' });
	const typed = await account.view(summary);
	assert.equal(typed.name.toUpperCase(), 'PUBLIC');
	assert.deepEqual(typed, { id: 1, name: 'public' });
	assert.deepEqual(await account.view('summary'), typed);
	assert.equal('secret' in typed, false);
});

test('typed views keep legacy arbitrary named views source-compatible', async () => {
	const { Account, Bound } = fixture();
	defineModel<Row>({ name: 'typed_account' }).id('id').view('default', ({ data }) => data.name).attach(Account);
	const account = await Bound.create({ id: 1, name: 'legacy', secret: 'hidden' });
	assert.equal(await account.view<string>(), 'legacy');
});

test('an unregistered same-name typed descriptor cannot select a different contract', async () => {
	const { Bound } = fixture();
	const account = await Bound.create({ id: 1, name: 'public', secret: 'hidden' });
	const impostor = defineTypedView<Row>()({ name: 'summary', resolve: () => 'wrong', parse: () => 42 });
	await assert.rejects(account.view(impostor), ActiveTsConfigurationError);
	await assert.rejects(account.view({ name: 'summary', parse: parseSummary } as any), ActiveTsConfigurationError);
});

test('typed descriptor identity remains enforced after metadata replacement', async () => {
	const { Account, Bound, summary } = fixture();
	const account = await Bound.create({ id: 1, name: 'public', secret: 'hidden' });
	defineModel<Row>({ name: 'typed_account' }).id('id').view('summary', () => 123).attach(Account);
	await assert.rejects(account.view(summary), ActiveTsConfigurationError);
	assert.equal(await account.view('summary'), 123);
});

test('invalid resolver output rejects both typed and string reads', async () => {
	const { Account, Bound } = fixture();
	const bad = defineTypedView<Row>()({ name: 'bad', resolve: () => ({ id: 'not a number' }), parse: parseSummary });
	defineModel<Row>({ name: 'typed_account' }).id('id').view(bad).attach(Account);
	const account = await Bound.create({ id: 1, name: 'public', secret: 'hidden' });
	await assert.rejects(account.view(bad), /Invalid summary/);
	await assert.rejects(account.view('bad'), /Invalid summary/);
});

test('partial models remain unable to execute typed views', async () => {
	const { Bound, summary } = fixture();
	await Bound.create({ id: 1, name: 'public', secret: 'hidden' });
	const page = await Bound.query().select('id', 'name').load();
	assert.equal(page.list.length, 1);
	await assert.rejects(async () => (page.list[0] as any).view(summary), /partial/i);
});

test('async parsers stay inside the view operation and preserve per-read viewers', async () => {
	const { Account, Bound } = fixture();
	const view = defineTypedView<Row>()({
		name: 'viewer', resolve: ({ viewer }) => viewer,
		parse: async (value) => { await Promise.resolve(); if (typeof value !== 'string') throw new TypeError('viewer'); return { viewer: value }; }
	});
	defineModel<Row>({ name: 'typed_account' }).id('id').view(view).attach(Account);
	const account = await Bound.create({ id: 1, name: 'public', secret: 'hidden' });
	assert.deepEqual(await Promise.all([account.view(view, 'a'), account.view(view, 'b')]), [{ viewer: 'a' }, { viewer: 'b' }]);
});

test('typed views do not bypass an ended transaction context', async () => {
	const { Bound, context, summary } = fixture();
	await Bound.create({ id: 1, name: 'public', secret: 'hidden' });
	const account = await context.transaction(async tx => {
		const item = await Bound.use(tx).find(1).load();
		assert.ok(item);
		assert.deepEqual(await item.view(summary), { id: 1, name: 'public' });
		return item;
	});
	await assert.rejects(account.view(summary));
});

test('definitions capture callbacks and reject unsafe names or missing parsers', async () => {
	const options = { name: 'summary', resolve: ({ data }: { data: Row }) => data, parse: parseSummary };
	const summary = defineTypedView<Row>()(options);
	options.parse = () => { throw new Error('mutated options'); };
	assert.equal(Object.isFrozen(summary), true);
	assert.deepEqual(await summary.parse({ id: 1, name: 'public', secret: 'hidden' }), { id: 1, name: 'public' });
	assert.throws(() => defineTypedView<Row>()({ ...options, name: '__proto__' }));
	assert.throws(() => defineTypedView<Row>()({ ...options, parse: undefined } as any));
});
