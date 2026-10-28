import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, datastoreKey, defineModel, MemorySearchAdapter, MemoryStoreAdapter, Model, type WhereShape } from '../src/index.js';

type EventData = { id: number; tenant: number; at: Date };
for (const scoped of [false, true]) {
	async function setup() {
		class Event extends Model<EventData> {}
		class Child extends Model {}
		defineModel('search_date_child').attach(Child);
		const definition = defineModel<EventData>('search_date_event').fieldType('at', 'date')
			.search('memory', ['at', 'tenant'])
			.hasMany('children', () => Child, { localKey: 'id', foreignKey: 'eventId' });
		if (scoped) definition.datastore({ ancestorFields: ['tenant'], ancestor: ({ data }) => data ? datastoreKey('Tenant', data.tenant) : undefined });
		definition.attach(Event);
		const store = new MemoryStoreAdapter();
		if (scoped) {
			Object.assign(store.capabilities, { datastoreAncestor: true });
			const query = store.query.bind(store);
			store.query = async (meta, plan, options) => {
				if (meta.name !== 'search_date_event') return query(meta, plan, options);
				assert.deepEqual(plan.meta?.datastoreAncestor, datastoreKey('Tenant', 1));
				return query(meta, { ...plan, meta: undefined }, options ? { ...options, meta: undefined } : undefined);
			};
		}
		const search = new MemorySearchAdapter();
		const context = createActiveTs({ stores: { default: store }, search: { default: search }, lazyWarnings: false });
		const Events = Event.use(context);
		const at = new Date('2026-01-01');
		await store.seed(context.meta(Event), [{ id: 1, tenant: 1, at: at.toISOString() }]);
		await search.index(context.meta(Event), 1, { id: 1, tenant: 1, at });
		return { Events, at, store, meta: context.meta(Event) };
	}

	test(`search includes retain date filter matches (${scoped ? 'scoped' : 'unscoped'})`, async () => {
		const { Events, at } = await setup();
		const conditions: WhereShape[] = [{ at }, { at: ['>=', at] }, { at: ['in', [at]] }, { at: ['between', at, at] }];
		for (const where of conditions) {
			const partial = await Events.search('').where(where).load();
			const included = await Events.search('').where(where).include('children').load();
			assert.deepEqual(partial.list.map(item => item.id), [1]);
			assert.deepEqual(included.list.map(item => item.id), [1]);
			assert.ok(included.list[0].data.at instanceof Date);
			assert.equal(included.list[0].data.at.toISOString(), at.toISOString());
		}
	});

	test(`search includes exclude stale dates with != (${scoped ? 'scoped' : 'unscoped'})`, async () => {
		const { Events, store, meta } = await setup();
		const excludedAt = new Date('2026-02-01');
		await store.update(meta, 1, { id: 1, tenant: 1, at: excludedAt.toISOString() });
		const stale = await Events.search('').where({ at: ['!=', excludedAt] }).include('children').load();
		assert.deepEqual(stale.list, []);
		assert.equal(stale.total, undefined);
	});
}
