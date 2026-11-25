import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createActiveTs, defineModel, field, index, MemoryStoreAdapter, Model, modelMeta, searchIndex, typedField
} from '../src/index.js';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';

type Data = { id: number; profile: { email: string }; profile_email: string };
const collision = /Generated (?:search )?index name.*conflicts with different fields.*explicit names/;

for (const [first, second] of [['profile.email', 'profile_email'], ['profile_email', 'profile.email']]) {
	test(`builder rejects colliding generated indexes: ${first} then ${second}`, () => {
		const builder = defineModel<Data>('generated_index_collision').id('id').index(first, { unique: true });
		assert.throws(() => builder.index(second), collision);
		assert.deepEqual(builder.build().indexes, [{ name: 'profile_email', fields: [first], unique: true }]);
	});

	test(`builder rejects colliding generated search indexes: ${first} then ${second}`, () => {
		const builder = defineModel<Data>('generated_search_collision').id('id').search('memory', [first]);
		assert.throws(() => builder.search('memory', [second]), collision);
		assert.deepEqual(builder.build().searchIndexes, [{ name: 'profile_email', adapter: 'memory', fields: [first] }]);
	});
}

test('composite and repeated-underscore names cannot silently replace another shape', () => {
	const composite = defineModel('composite_collision').index('ignored', { fields: ['first', 'second'] });
	assert.throws(() => composite.index('first_second'), collision);
	const underscores = defineModel('underscore_collision').index('first__second');
	assert.throws(() => underscores.index('first_second'), collision);
});

test('class decorators reject generated collisions before replacing existing metadata', () => {
	class Record extends Model<Data> {}
	defineModel<Data>('decorator_collision').id('id').attach(Record);
	index(['profile.email'], { unique: true })(Record);
	searchIndex(['profile.email'], { adapter: 'memory' })(Record);
	assert.throws(() => index(['profile_email'])(Record), collision);
	assert.throws(() => searchIndex(['profile_email'], { adapter: 'memory' })(Record), collision);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	assert.deepEqual(context.meta(Record).indexes[0].fields, ['profile.email']);
	assert.equal(context.meta(Record).indexes[0].unique, true);
	assert.deepEqual(context.meta(Record).searchIndexes[0].fields, ['profile.email']);
});

test('field and typedField collisions leave existing index and field metadata intact', () => {
	for (const decorate of [field({ fields: ['profile_email'], unique: false }), typedField('string', { fields: ['profile_email'], unique: false })]) {
		class Record extends Model<Data> {}
		defineModel<Data>('property_collision').id('id').index('profile.email', { unique: true }).attach(Record);
		assert.throws(() => decorate(Record.prototype, 'profile_email'), collision);
		const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(Record);
		assert.deepEqual(meta.indexes[0].fields, ['profile.email']);
		assert.equal(meta.indexes[0].unique, true);
		assert.equal(meta.fieldTypes.has('profile_email'), false);
	}
});

test('same generated fields, distinct search adapters and explicit replacements remain supported', () => {
	class Record extends Model<Data> {}
	defineModel<Data>('intentional_replacement').id('id')
		.index('profile.email').index('profile.email', { unique: true })
		.search('first', ['profile.email']).search('second', ['profile_email']).attach(Record);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	assert.equal(context.meta(Record).indexes.length, 1);
	assert.equal(context.meta(Record).indexes[0].unique, true);
	assert.equal(context.meta(Record).searchIndexes.length, 2);
	modelMeta.index(Record, { name: 'profile_email', fields: ['id'] });
	assert.deepEqual(context.meta(Record).indexes[0].fields, ['id']);
});

test('explicit distinct names retain both SQLite indexes and enforce the unique field', async (t) => {
	const store = await createSqliteStoreAdapter();
	t.after(() => store.close());
	class Record extends Model<Data> {}
	defineModel<Data>('explicit_collision_recovery').id('id')
		.index('profile.email', { unique: true })
		.index('profile_email', { name: 'flat_profile_email' }).attach(Record);
	const context = createActiveTs({ stores: { default: store } });
	await context.schemaApply([Record], { mode: 'safe' });
	const Bound = Record.use(context);
	await Bound.create({ id: 1, profile: { email: 'same@example.test' }, profile_email: 'first' });
	await assert.rejects(() => Bound.create({ id: 2, profile: { email: 'same@example.test' }, profile_email: 'second' }));
	assert.equal((await Bound.query().load()).list.length, 1);
	assert.equal(context.meta(Record).indexes.length, 2);
});

test('separate builders reject incoming generated collisions without changing attached metadata', () => {
	class Record extends Model<Data> {}
	defineModel<Data>('cross_builder_collision').id('id')
		.index('profile.email', { unique: true }).search('memory', ['profile.email']).attach(Record);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const before = context.meta(Record);
	assert.throws(() => defineModel<Data>('rejected_name').index('profile_email').attach(Record), collision);
	assert.throws(() => defineModel<Data>('rejected_search_name').search('memory', ['profile_email']).attach(Record), collision);
	const after = context.meta(Record);
	assert.equal(after.name, before.name);
	assert.deepEqual(after.indexes, before.indexes);
	assert.deepEqual(after.searchIndexes, before.searchIndexes);
});

for (const kind of ['index', 'search'] as const) {
	test(`pending static ${kind} generated names reject collisions with decorators on resolution`, () => {
		class Record extends Model<Data> {
			static schema = kind === 'index'
				? defineModel<Data>('static_index_collision').id('id').index('profile.email', { unique: true }).build()
				: defineModel<Data>('static_search_collision').id('id').search('memory', ['profile.email']).build();
		}
		if (kind === 'index') index(['profile_email'])(Record);
		else searchIndex(['profile_email'], { adapter: 'memory' })(Record);
		const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
		assert.throws(() => context.meta(Record), collision);
		assert.throws(() => context.meta(Record), collision);
	});
}

test('explicit cross-builder replacements remain intentional and supported', () => {
	class Record extends Model<Data> {}
	defineModel<Data>('explicit_cross_builder').id('id')
		.index('profile.email', { unique: true }).search('memory', ['profile.email']).attach(Record);
	defineModel<Data>('explicit_cross_builder')
		.index('profile_email', { name: 'profile_email' })
		.search('memory', ['profile_email'], { name: 'profile_email' }).attach(Record);
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(Record);
	assert.deepEqual(meta.indexes[0].fields, ['profile_email']);
	assert.deepEqual(meta.searchIndexes[0].fields, ['profile_email']);
});
