import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsConfigurationError,
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	Model,
	attachModelMeta,
	createActiveTs,
	defineModel,
	datastoreKey,
	getModelMeta,
	index as decoratorIndex,
	modelMeta,
	relation,
	sanitizeHooks,
	searchIndex as decoratorSearchIndex,
	typedField,
	type CacheAdapter,
	type EntityId,
	type QueryResult,
	type ResolvedModelMeta,
	type StoreAdapter
} from '../src/index.js';
import { BatchLoader } from '../src/core/batch-loader.js';
import { getModelMetaVersion, resolveModelMeta } from '../src/core/metadata.js';
import { assertNoOverlappingFieldPaths, entityIdKey } from '../src/core/query-utils.js';

type MetadataData = {
	id: number;
	name: string;
	ownerId?: number;
};

type BatchData = {
	id: number;
	value: string;
};

class MetadataRecord extends Model<MetadataData> {}
class MetadataOwner extends Model<MetadataData> {}
class BatchRecordA extends Model<BatchData> {}
class BatchRecordB extends Model<BatchData> {}
class LimitedBatchRecord extends Model<BatchData> {}
class CacheLoadRecord extends Model<BatchData> {}

defineModel<MetadataData>('metadata_regression_record')
	.id('id')
	.validate((input) => input as MetadataData)
	.index('name', { name: 'name_lookup' })
	.attach(MetadataRecord);

defineModel<MetadataData>('metadata_regression_owner')
	.id('id')
	.validate((input) => input as MetadataData)
	.attach(MetadataOwner);

defineModel<BatchData>({ name: 'batch_regression_a', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as BatchData)
	.attach(BatchRecordA);

defineModel<BatchData>({ name: 'batch_regression_b', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as BatchData)
	.attach(BatchRecordB);

defineModel<BatchData>({ name: 'batch_regression_limited', cache: false })
	.id('id')
	.validate((input) => input as BatchData)
	.attach(LimitedBatchRecord);

defineModel<BatchData>({ name: 'cache_load_regression', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as BatchData)
	.attach(CacheLoadRecord);

class LoopStore implements StoreAdapter {
	kind = 'loop-store';
	private readonly rows = new Map<string, Record<string, unknown>>();

	seed(model: string, rows: BatchData[]) {
		for (let index = 0; index < rows.length; index++) {
			const row = rows[index];
			this.rows.set(`${model}:${entityIdKey(row.id)}`, structuredClone(row));
		}
	}

	async get(model: ResolvedModelMeta, id: EntityId) {
		const values = await this.getMany(model, [id]);
		return values[0] ?? null;
	}

	async getMany(model: ResolvedModelMeta, ids: EntityId[]) {
		const result: Array<Record<string, unknown> | null> = [];
		for (let index = 0; index < ids.length; index++) {
			const row = this.rows.get(`${model.name}:${entityIdKey(ids[index])}`);
			result[index] = row ? structuredClone(row) : null;
		}
		return result;
	}

	async query(): Promise<QueryResult> {
		return { list: [] };
	}

	async create(model: ResolvedModelMeta, id: EntityId, data: Record<string, unknown>) {
		this.rows.set(`${model.name}:${entityIdKey(id)}`, structuredClone(data));
	}

	async update(model: ResolvedModelMeta, id: EntityId, data: Record<string, unknown>) {
		this.rows.set(`${model.name}:${entityIdKey(id)}`, structuredClone(data));
	}

	async delete(model: ResolvedModelMeta, id: EntityId) {
		this.rows.delete(`${model.name}:${entityIdKey(id)}`);
	}
}

class LoopCache implements CacheAdapter {
	kind = 'loop-cache';
	readonly setKeys: string[] = [];
	private readonly rows = new Map<string, unknown>();

	seed(key: string, value: unknown) {
		this.rows.set(key, structuredClone(value));
	}

	async getMany(keys: string[]) {
		const result: unknown[] = [];
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			result[index] = this.rows.has(key) ? structuredClone(this.rows.get(key)) : undefined;
		}
		return result;
	}

	async setMany(entries: Array<[string, unknown]>) {
		for (let index = 0; index < entries.length; index++) {
			const [key, value] = entries[index];
			this.rows.set(key, structuredClone(value));
			this.setKeys[this.setKeys.length] = key;
		}
	}

	async deleteMany(keys: string[]) {
		for (let index = 0; index < keys.length; index++) {
			this.rows.delete(keys[index]);
		}
	}
}

test('metadata cache refreshes after attach and dedupes named schema entries', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const before = context.meta(MetadataRecord);
	assert.deepEqual(before.indexes.map((index) => index.name), ['name_lookup']);
	assert.equal(before.relations.has('owner'), false);

	defineModel<MetadataData>('metadata_regression_record')
		.id('id')
		.validate((input) => input as MetadataData)
		.index('name', { name: 'name_lookup', fields: ['name'] })
		.index('ownerId', { name: 'owner_lookup', fields: ['ownerId'] })
		.search('memory', ['name'], { name: 'name_search' })
		.search('memory', ['name'], { name: 'name_search' })
		.ref('owner', () => MetadataOwner, { localKey: 'ownerId', foreignKey: 'id' })
		.attach(MetadataRecord);

	const after = context.meta(MetadataRecord);
	assert.deepEqual(after.indexes.map((index) => index.name), ['name_lookup', 'owner_lookup']);
	assert.deepEqual(after.searchIndexes.map((index) => index.name), ['name_search']);
	assert.equal(after.relations.has('owner'), true);
});

test('search index dedupe is scoped by adapter name', () => {
	class MultiAdapterSearchIndexRecord extends Model<MetadataData> {}
	defineModel<MetadataData>('multi_adapter_search_index_record')
		.id('id')
		.search('memory', ['name'])
		.search('native', ['name'])
		.search('memory', ['name'])
		.attach(MultiAdapterSearchIndexRecord);

	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(MultiAdapterSearchIndexRecord);
	assert.deepEqual(meta.searchIndexes.map((index) => [index.name, index.adapter]), [
		['name', 'memory'],
		['name', 'native']
	]);
});

test('direct metadata schema registration replaces same-name entries', () => {
	class DirectMetadataReplaceRecord extends Model<MetadataData> {}
	defineModel<MetadataData>('metadata_direct_replace')
		.id('id')
		.attach(DirectMetadataReplaceRecord);

	modelMeta.index(DirectMetadataReplaceRecord, { name: 'direct_lookup', fields: ['name'] });
	modelMeta.index(DirectMetadataReplaceRecord, { name: 'direct_lookup', fields: ['ownerId'], unique: true });
	modelMeta.searchIndex(DirectMetadataReplaceRecord, { name: 'direct_search', adapter: 'memory', fields: ['name'] });
	modelMeta.searchIndex(DirectMetadataReplaceRecord, { name: 'direct_search', adapter: 'memory', fields: ['ownerId'] });

	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DirectMetadataReplaceRecord);
	assert.deepEqual(meta.indexes.map((index) => ({ name: index.name, fields: index.fields, unique: index.unique })), [
		{ name: 'direct_lookup', fields: ['ownerId'], unique: true }
	]);
	assert.deepEqual(meta.searchIndexes.map((index) => ({ name: index.name, adapter: index.adapter, fields: index.fields })), [
		{ name: 'direct_search', adapter: 'memory', fields: ['ownerId'] }
	]);
});

test('store index metadata preserves declared field directions', () => {
	class DirectionRecord extends Model<MetadataData> {}
	class StaticDirectionRecord extends Model<MetadataData> {
		static schema = defineModel<MetadataData>('metadata_static_direction_record')
			.index('name', {
				name: 'static_direction',
				fields: ['ownerId', 'name'],
				directions: ['asc', 'desc']
			})
			.build();
	}
	class DirectDirectionRecord extends Model<MetadataData> {}

	defineModel<MetadataData>('metadata_direction_record')
		.index('name', {
			name: 'builder_direction',
			fields: ['ownerId', 'name'],
			directions: ['asc', 'desc']
		})
		.attach(DirectionRecord);
	defineModel<MetadataData>('metadata_direct_direction_record').attach(DirectDirectionRecord);
	modelMeta.index(DirectDirectionRecord, {
		name: 'direct_direction',
		fields: ['ownerId', 'name'],
		directions: ['desc', 'asc']
	});

	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	assert.deepEqual(context.meta(DirectionRecord).indexes[0]?.directions, ['asc', 'desc']);
	assert.deepEqual(context.meta(StaticDirectionRecord).indexes[0]?.directions, ['asc', 'desc']);
	assert.deepEqual(context.meta(DirectDirectionRecord).indexes[0]?.directions, ['desc', 'asc']);
});

test('entity and schema identifiers are validated and entity options are cloned', () => {
	class BadEntity extends Model<MetadataData> {}
	assert.throws(() => defineModel<MetadataData>(false as any).attach(BadEntity), /entity options must be a plain object/);
	assert.throws(() => defineModel<MetadataData>(null as any).attach(BadEntity), /entity options must be a plain object/);
	assert.throws(() => defineModel<MetadataData>([] as any).attach(BadEntity), /entity options must be a plain object/);
	assert.throws(() => defineModel<MetadataData>('bad/name').attach(BadEntity), /entity name/);
	assert.throws(() => defineModel<MetadataData>('a'.repeat(64)).attach(BadEntity), /entity name .*too long/);
	assert.throws(() => defineModel<MetadataData>('bad_index_record').index('name', { name: '$bad' }).attach(BadEntity), /index name/);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_options').index('name', null as any),
		/index options must be a plain object/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_option_typo').index('name', { uniq: true } as any),
		/index options contains unknown option "uniq"/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_fields_null').index('name', { fields: null as any }).attach(BadEntity),
		/index fields must be a non-empty array/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_fields_empty').index('name', { fields: [] as any }).attach(BadEntity),
		/index fields must be a non-empty array/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_fields_sparse').index('name', { fields: new Array(1) as any }).attach(BadEntity),
		/index fields\[0\] is missing/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_directions_length').index('name', { directions: [] as any }).attach(BadEntity),
		/index directions must be an array with one direction per index field/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_direction_value').index('name', { directions: ['down'] as any }).attach(BadEntity),
		/index directions\[0\] must be "asc" or "desc"/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_index_unique').index('name', { unique: 'yes' as any }).attach(BadEntity),
		/index unique must be a boolean/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_search_record').search('memory', ['name'], { name: 'bad.name' }).attach(BadEntity),
		/search index name/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_search_options').search('memory', ['name'], null as any),
		/search options must be a plain object/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_search_option_typo').search('memory', ['name'], { adaptor: 'memory' } as any),
		/search options contains unknown option "adaptor"/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_search_fields_null').search('memory', null as any).attach(BadEntity),
		/search fields must be a non-empty array/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_search_fields_empty').search('memory', []).attach(BadEntity),
		/search fields must be a non-empty array/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_search_fields_sparse').search('memory', new Array(1) as any).attach(BadEntity),
		/search fields\[0\] is missing/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_store_adapter', store: '__proto__' }).attach(BadEntity),
		/store adapter name/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_cache_adapter', cache: { adapter: '__proto__' } }).attach(BadEntity),
		/cache adapter name/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_cache_true', cache: true as any }).attach(BadEntity),
		/cache options must be a plain object/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_cache_null', cache: null as any }).attach(BadEntity),
		/cache options must be a plain object/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_cache_array', cache: [] as any }).attach(BadEntity),
		/cache options must be a plain object/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_entity_option', ttl: 60 } as any).attach(BadEntity),
		/entity options contains unknown option "ttl"/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_cache_option', cache: { negativeTTL: 60 } as any }).attach(BadEntity),
		/bad_cache_option cache options contains unknown option "negativeTTL"/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_search_adapter', search: '__proto__' }).attach(BadEntity),
		/search adapter name/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_search_index_adapter').search('__proto__', ['name']).attach(BadEntity),
		/search adapter name/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_relation_target')
				.ref('owner', null as any, { localKey: 'ownerId', foreignKey: 'id' })
				.attach(BadEntity),
		/relation target must be a function/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_relation_options')
				.ref('owner', () => MetadataOwner, null as any),
		/relation options must be a plain object/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_relation_option_typo')
				.ref('owner', () => MetadataOwner, { localKey: 'ownerId', foreignKey: 'id', preloadFields: ['name'] } as any),
		/relation options contains unknown option "preloadFields"/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_has_many_options')
				.hasMany('owners', () => MetadataOwner, null as any),
		/relation options must be a plain object/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_relation_preload')
				.ref('owner', () => MetadataOwner, { localKey: 'ownerId', foreignKey: 'id', preload: {} as any })
				.attach(BadEntity),
		/relation preload must be an array/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_relation_preload_sparse')
				.ref('owner', () => MetadataOwner, { localKey: 'ownerId', foreignKey: 'id', preload: new Array(1) as any })
				.attach(BadEntity),
		/relation preload\[0\] is missing/
	);
	assert.throws(
		() => modelMeta.index(BadEntity, { name: 'by_name', fields: ['name'], uniq: true } as any),
		/index metadata contains unknown option "uniq"/
	);
	assert.throws(
		() => modelMeta.index(BadEntity, { name: 'by_name', fields: ['name'], directions: ['bad'] as any }),
		/index directions\[0\] must be "asc" or "desc"/
	);
	assert.throws(
		() => modelMeta.searchIndex(BadEntity, { name: 'by_name', fields: ['name'], adaptor: 'memory' } as any),
		/search index metadata contains unknown option "adaptor"/
	);
	assert.throws(
		() =>
			modelMeta.relation(BadEntity, {
				name: 'owner',
				kind: 'one',
				target: () => MetadataOwner,
				localKey: 'ownerId',
				foreignKey: 'id',
				preloadFields: ['name']
			} as any),
		/relation metadata contains unknown option "preloadFields"/
	);
	{
		class BadRelationKind extends Model<MetadataData> {
			static schema = {
				entity: { name: 'bad_relation_kind' },
				relations: new Map([
					[
						'owner',
						{
							name: 'owner',
							kind: 'through',
							target: () => MetadataOwner,
							localKey: 'ownerId',
							foreignKey: 'id'
						}
					]
				])
			} as any;
		}
		assert.throws(
			() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(BadRelationKind),
			/Relation kind "through" is not allowed/
		);
	}
	{
		class BadRelationContainer extends Model<MetadataData> {
			static schema = {
				entity: { name: 'bad_relation_container' },
				relations: null
			} as any;
		}
		assert.throws(
			() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(BadRelationContainer),
			/relations metadata must be a Map or plain object/
		);
	}
	assert.throws(
		() => modelMeta.relation(BadEntity, null as any),
		/relation metadata must be an object/
	);
	{
		class BadStaticIndexFields extends Model<MetadataData> {
			static schema = {
				entity: { name: 'bad_static_index_fields' },
				indexes: [{ name: 'bad_static_index', fields: null }]
			} as any;
		}
		assert.throws(
			() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(BadStaticIndexFields),
			/index fields must be a non-empty array/
		);
	}
	{
		class BadStaticSearchFields extends Model<MetadataData> {
			static schema = {
				entity: { name: 'bad_static_search_fields' },
				searchIndexes: [{ name: 'bad_static_search', adapter: 'memory', fields: [] }]
			} as any;
		}
		assert.throws(
			() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(BadStaticSearchFields),
			/search index fields must be a non-empty array/
		);
	}
	assert.throws(
		() => defineModel<MetadataData>('bad_read_validation').readValidation('loud' as any),
		/Read validation mode/
	);
	assert.throws(
		() => modelMeta.validate(BadEntity, (input) => input as MetadataData, '' as any),
		/Read validation mode/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_validator').validate(null as any).attach(BadEntity),
		/model validator must be a function/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_model_hook_name').hooks({ nope: () => undefined } as any),
		/hooks contains unknown hook "nope"/
	);
	let hookReads = 0;
	const accessorHooks = Object.defineProperty({}, 'beforeQuery', {
		enumerable: true,
		get() {
			hookReads++;
			return () => undefined;
		}
	});
	assert.throws(
		() => defineModel<MetadataData>('bad_model_hook_accessor').hooks(accessorHooks as any),
		/hooks\.beforeQuery must be a data property/
	);
	assert.equal(hookReads, 0);
	const hiddenHooks = Object.defineProperty({}, 'beforeQuery', {
		enumerable: false,
		value: () => undefined
	});
	assert.throws(
		() => defineModel<MetadataData>('bad_model_hook_hidden').hooks(hiddenHooks as any),
		/hooks\.beforeQuery must be enumerable/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_model_hook_value').hooks({ beforeQuery: [() => undefined, null] as any }),
		/hooks\.beforeQuery\[1\] must be a function/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_field_type').fieldType('name', 'money' as any),
		/Field type/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_name')
				.fieldCodec('name', { name: '__codec', encode: (value) => value, decode: (value) => value })
				.attach(BadEntity),
		/field codec name/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_encode')
				.fieldCodec('name', { name: 'bad-codec', encode: null as any, decode: (value) => value })
				.attach(BadEntity),
		/field codec encode must be a function/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_query')
				.fieldCodec('name', {
					name: 'bad-codec-query',
					encode: (value) => value,
					decode: (value) => value,
					encodeQuery: null as any
				})
				.attach(BadEntity),
		/field codec encodeQuery must be a function/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_query_operator')
				.fieldCodec('name', {
					name: 'bad-codec-query-operator',
					encode: (value) => value,
					decode: (value) => value,
					encodeQuery: (value) => value,
					queryOperators: ['contains'] as any
				})
				.attach(BadEntity),
		/Field codec query operator "contains" is not allowed/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_query_operator_without_encoder')
				.fieldCodec('name', {
					name: 'bad-codec-query-operator-without-encoder',
					encode: (value) => value,
					decode: (value) => value,
					queryOperators: ['startsWith'] as any
				})
				.attach(BadEntity),
		/field codec queryOperators require encodeQuery/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_unknown')
				.fieldCodec('name', {
					name: 'bad-codec-unknown',
					encode: (value: unknown) => value,
					decode: (value: unknown) => value,
					decod: (value: unknown) => value
				} as any)
				.attach(BadEntity),
		/field codec contains unknown option "decod"/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_symbol')
				.fieldCodec('name', {
					name: 'bad-codec-symbol',
					encode: (value: unknown) => value,
					decode: (value: unknown) => value,
					[Symbol('extra')]: true
				} as any)
				.attach(BadEntity),
		/field codec cannot contain symbol fields/
	);
	let codecReads = 0;
	const accessorCodec = Object.defineProperty(
		{
			name: 'bad-codec-accessor',
			encode: (value: unknown) => value,
			decode: (value: unknown) => value
		},
		'extra',
		{
			enumerable: true,
			get() {
				codecReads++;
				return true;
			}
		}
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_field_codec_accessor').fieldCodec('name', accessorCodec as any).attach(BadEntity),
		/field codec\.extra must be a data property/
	);
	assert.equal(codecReads, 0);
	assert.throws(
		() =>
			defineModel<MetadataData>('bad_field_codec_class')
				.fieldCodec('name', Object.assign(Object.create({}), {
					name: 'bad-codec-class',
					encode: (value: unknown) => value,
					decode: (value: unknown) => value
				}) as any)
				.attach(BadEntity),
		/field codec must be a plain object/
	);
	Object.defineProperty(Object.prototype, 'encode', {
		value: (value: unknown) => value,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'decode', {
		value: (value: unknown) => value,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'name', {
		value: 'inherited-codec',
		configurable: true
	});
	try {
		assert.throws(
			() => defineModel<MetadataData>('bad_field_codec_inherited').fieldCodec('name', {} as any).attach(BadEntity),
			/field codec encode must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).encode;
		delete (Object.prototype as Record<string, unknown>).decode;
		delete (Object.prototype as Record<string, unknown>).name;
	}
	assert.throws(
		() => defineModel<MetadataData>('bad_view_resolver').view('public', null as any).attach(BadEntity),
		/view resolver must be a function/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_policy_resolver').policy('read', null as any).attach(BadEntity),
		/policy resolver must be a function/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_scope_resolver').scope('tenant', null as any).attach(BadEntity),
		/scope resolver must be a function/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_cache_ttl', cache: { ttl: 0 } }).attach(BadEntity),
		/cache ttl/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_fractional_cache_ttl', cache: { ttl: 0.5 } }).attach(BadEntity),
		/cache ttl/
	);
	assert.throws(
		() => defineModel<MetadataData>({ name: 'bad_cache_negative_ttl', cache: { negativeTtl: -1 } }).attach(BadEntity),
		/cache negativeTtl/
	);

	let coercionCalls = 0;
	const hostileValue = {
		toString() {
			coercionCalls++;
			throw new Error('metadata value coercion should not run');
		}
	};
	assert.throws(
		() =>
			attachModelMeta(BadEntity, {
				entity: { name: 'bad_relation_kind_coercion' },
				relations: new Map([
					[
						'owner',
						{
							kind: hostileValue,
							target: () => MetadataOwner,
							localKey: 'ownerId',
							foreignKey: 'id'
						}
					]
				])
			} as any),
		/Relation kind is not allowed/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_read_validation_coercion').readValidation(hostileValue as any),
		/Read validation mode is not allowed/
	);
	assert.throws(
		() => defineModel<MetadataData>('bad_field_type_coercion').fieldType('name', hostileValue as any),
		/Field type is not allowed/
	);
	assert.equal(coercionCalls, 0);

	class ClonedEntity extends Model<BatchData> {}
	const entity = { name: 'metadata_cloned_entity', cache: { ttl: 10 } };
	defineModel<BatchData>(entity).id('id').attach(ClonedEntity);
	entity.name = 'metadata_mutated_entity';
	entity.cache.ttl = 99;

	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, caches: { default: new MemoryCacheAdapter() } });
	const meta = context.meta(ClonedEntity);
	assert.equal(meta.name, 'metadata_cloned_entity');
	assert.equal(meta.cache?.ttl, 10);
});

test('Datastore unindexed metadata rejects identity and index overlaps', () => {
	class UnindexedIdRecord extends Model<MetadataData> {}
	class UnindexedIndexRecord extends Model<MetadataData> {}
	class UnindexedNestedIndexRecord extends Model<MetadataData & { profile?: { city?: string } }> {}
	class StaticUnindexedIndexRecord extends Model<MetadataData> {
		static schema = defineModel<MetadataData>('metadata_datastore_unindexed_static')
			.id('id')
			.index('name', { name: 'static_name_lookup' })
			.datastore({ unindexed: ['name'] })
			.build();
	}

	assert.throws(
		() => defineModel<MetadataData>('metadata_datastore_unindexed_id')
			.id('id')
			.datastore({ unindexed: ['id'] })
			.attach(UnindexedIdRecord),
		/Datastore unindexed field "id" for metadata_datastore_unindexed_id cannot overlap id field "id"/
	);
	assert.throws(
		() => defineModel<MetadataData>('metadata_datastore_unindexed_index')
			.id('id')
			.index('name', { name: 'name_lookup' })
			.datastore({ unindexed: ['name'] })
			.attach(UnindexedIndexRecord),
		/Datastore unindexed field "name" for metadata_datastore_unindexed_index overlaps indexed field "name" in index "name_lookup"/
	);
	assert.throws(
		() => defineModel<MetadataData & { profile?: { city?: string } }>('metadata_datastore_unindexed_nested')
			.id('id')
			.index('profile.city', { name: 'profile_city_lookup' })
			.datastore({ unindexed: ['profile'] })
			.attach(UnindexedNestedIndexRecord),
		/Datastore unindexed field "profile" for metadata_datastore_unindexed_nested overlaps indexed field "profile\.city" in index "profile_city_lookup"/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(StaticUnindexedIndexRecord),
		/Datastore unindexed field "name" for metadata_datastore_unindexed_static overlaps indexed field "name" in index "static_name_lookup"/
	);
});

test('Datastore ancestor search indexes require explicit ancestorFields projection metadata', () => {
	class MissingAncestorFieldsRecord extends Model<MetadataData> {}
	class AncestorFieldRecord extends Model<MetadataData> {}
	class EmptyAncestorFieldsRecord extends Model<MetadataData> {}
	class OverlappingAncestorFieldsRecord extends Model<MetadataData> {}

	assert.throws(
		() =>
			defineModel<MetadataData>('metadata_datastore_search_missing_ancestor_fields')
				.id('id')
				.datastore({ ancestor: ({ data }) => data ? datastoreKey('owner', data.ownerId ?? 0) : undefined })
				.search('memory', ['name'])
				.attach(MissingAncestorFieldsRecord),
		/Datastore ancestor model search index "name" must declare datastore\.ancestorFields/
	);

	defineModel<MetadataData>('metadata_datastore_search_ancestor_fields')
		.id('id')
		.datastore({
			ancestor: ({ data }) => data ? datastoreKey('owner', data.ownerId ?? 0) : undefined,
			ancestorFields: ['ownerId']
		})
		.search('memory', ['name'])
		.attach(AncestorFieldRecord);
	assert.deepEqual(
		createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(AncestorFieldRecord).datastore?.ancestorFields,
		['ownerId']
	);

	defineModel<MetadataData>('metadata_datastore_search_empty_ancestor_fields')
		.id('id')
		.datastore({
			ancestor: () => datastoreKey('constant_owner', 1),
			ancestorFields: []
		})
		.search('memory', ['name'])
		.attach(EmptyAncestorFieldsRecord);
	assert.deepEqual(
		createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(EmptyAncestorFieldsRecord).datastore?.ancestorFields,
		[]
	);

	assert.throws(
		() =>
			defineModel<MetadataData>('metadata_datastore_search_overlapping_ancestor_fields')
				.id('id')
				.datastore({
					ancestor: ({ data }) => data ? datastoreKey('owner', data.ownerId ?? 0) : undefined,
					ancestorFields: ['profile']
				})
				.search('memory', ['profile.city'])
				.attach(OverlappingAncestorFieldsRecord),
		/search index "profile_city" projection fields cannot include both "profile" and nested field "profile\.city"/
	);
});

test('typedField decorator option failures do not leave partial metadata', () => {
	class TypedFieldOptionFailure extends Model<MetadataData> {}

	assert.throws(
		() => typedField('date', null as any)(TypedFieldOptionFailure.prototype, 'createdAt'),
		/typed field options must be a plain object/
	);
	assert.equal(getModelMeta(TypedFieldOptionFailure).fieldTypes?.has('createdAt'), false);

	assert.throws(
		() => typedField('date', { unique: 'yes' as any })(TypedFieldOptionFailure.prototype, 'createdAt'),
		/index unique must be a boolean/
	);
	assert.equal(getModelMeta(TypedFieldOptionFailure).fieldTypes?.has('createdAt'), false);

	assert.throws(
		() => typedField('date', { name: 'bad.name' })(TypedFieldOptionFailure.prototype, 'createdAt'),
		/index name/
	);
	assert.equal(getModelMeta(TypedFieldOptionFailure).fieldTypes?.has('createdAt'), false);

	assert.throws(
		() => typedField('date', { fields: new Array(1) as any })(TypedFieldOptionFailure.prototype, 'createdAt'),
		/index fields\[0\] is missing/
	);
	assert.equal(getModelMeta(TypedFieldOptionFailure).fieldTypes?.has('createdAt'), false);

	assert.throws(
		() => typedField('money' as any, { unique: true })(TypedFieldOptionFailure.prototype, 'createdAt'),
		/Field type/
	);
	assert.equal(getModelMeta(TypedFieldOptionFailure).fieldTypes?.has('createdAt'), false);
	assert.deepEqual(getModelMeta(TypedFieldOptionFailure).indexes, []);
});

test('relation decorator failures do not leave prototype getters', () => {
	class RelationDecoratorTarget extends Model<MetadataData> {}
	class BadRelationTarget extends Model<MetadataData> {}
	class BadRelationKind extends Model<MetadataData> {}

	assert.throws(
		() => relation(null as any, { kind: 'one', localKey: 'ownerId', foreignKey: 'id' })(
			BadRelationTarget.prototype,
			'owner'
		),
		/relation target must be a function/
	);
	assert.equal(Object.getOwnPropertyDescriptor(BadRelationTarget.prototype, 'owner'), undefined);
	assert.equal(getModelMeta(BadRelationTarget).relations.has('owner'), false);

	assert.throws(
		() => relation(() => RelationDecoratorTarget, {
			kind: 'through' as any,
			localKey: 'ownerId',
			foreignKey: 'id'
		})(BadRelationKind.prototype, 'owner'),
		/Relation kind "through" is not allowed/
	);
	assert.equal(Object.getOwnPropertyDescriptor(BadRelationKind.prototype, 'owner'), undefined);
	assert.equal(getModelMeta(BadRelationKind).relations.has('owner'), false);
});

test('metadata helpers reject malformed model constructors', () => {
	const schema = defineModel<MetadataData>('metadata_bad_constructor_target').id('id').build();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	assert.throws(
		() => attachModelMeta(null as any, schema),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/model constructor must be a model constructor/.test(error.message)
	);
	assert.throws(
		() => getModelMeta({} as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/model constructor must be a model constructor/.test(error.message)
	);
	assert.throws(
		() => context.meta({} as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/model constructor must be a model constructor/.test(error.message)
	);
	assert.throws(
		() => modelMeta.entity({} as any, { name: 'metadata_bad_constructor_entity' }),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
		/model constructor must be a model constructor/.test(error.message)
	);
});

test('ModelBuilder.build returns a frozen snapshot detached from later builder changes', () => {
	const builder = defineModel<MetadataData>({ name: 'metadata_builder_snapshot', cache: { ttl: 30 } })
		.id('id')
		.validate((input) => input as MetadataData)
		.fieldType('name', 'string')
		.index('name', { name: 'builder_name' });
	const snapshot = builder.build();

	builder.fieldType('ownerId', 'number').index('ownerId', { name: 'builder_owner' });

	assert.deepEqual(snapshot.indexes.map((index) => index.name), ['builder_name']);
	assert.deepEqual([...snapshot.fieldTypes!.keys()], ['name']);
	assert.throws(
		() => snapshot.fieldTypes!.set('ownerId', 'number'),
		/Cannot mutate model builder metadata collection/
	);
	assert.throws(
		() => snapshot.indexes.push({ name: 'late_index', fields: ['ownerId'] }),
		/Cannot add property|read only|not extensible/
	);
	assert.throws(
		() => snapshot.indexes[0].fields.push('ownerId'),
		/Cannot add property|read only|not extensible/
	);
	assert.throws(
		() => {
			(snapshot.entity!.cache as { ttl: number }).ttl = 99;
		},
		/read only|Cannot assign/
	);
});

test('getModelMeta returns a frozen snapshot instead of live metadata', () => {
	class PublicSnapshotRecord extends Model<MetadataData> {}
	defineModel<MetadataData>({ name: 'metadata_public_snapshot', cache: { ttl: 30 } })
		.id('id')
		.validate((input) => input as MetadataData)
		.fieldType('name', 'string')
		.index('name', { name: 'snapshot_name' })
		.attach(PublicSnapshotRecord);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	context.meta(PublicSnapshotRecord);

	const snapshot = getModelMeta(PublicSnapshotRecord);
	assert.throws(
		() => snapshot.fieldTypes!.set('ownerId', 'number'),
		/Cannot mutate model metadata snapshot collection/
	);
	assert.throws(
		() => snapshot.fieldCodecs!.set('ownerId', { name: 'bad_codec', encode: null as any, decode: null as any }),
		/Cannot mutate model metadata snapshot collection/
	);
	assert.throws(
		() => snapshot.indexes.push({ name: 'late_index', fields: ['ownerId'] }),
		/Cannot add property|read only|not extensible/
	);
	assert.throws(
		() => snapshot.indexes[0].fields.push('ownerId'),
		/Cannot add property|read only|not extensible/
	);
	assert.throws(
		() => {
			(snapshot.entity!.cache as { ttl: number }).ttl = 99;
		},
		/read only|Cannot assign/
	);

	const resolved = context.meta(PublicSnapshotRecord);
	assert.equal(resolved.fieldTypes.has('ownerId'), false);
	assert.equal(resolved.fieldCodecs.has('ownerId'), false);
	assert.deepEqual(resolved.indexes.map((index) => index.name), ['snapshot_name']);
	assert.equal(resolved.cache?.ttl, 30);
});

test('metadata application ignores inherited top-level schema fields', () => {
	class InheritedTopLevelSchema extends Model<MetadataData> {}
	Object.defineProperty(Object.prototype, 'entity', {
		value: { name: 'metadata_inherited_schema_entity' },
		configurable: true
	});
	try {
		attachModelMeta(InheritedTopLevelSchema, {} as any);
		assert.throws(
			() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(InheritedTopLevelSchema),
			/missing entity metadata/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).entity;
	}
});

test('metadata object maps reject symbol and accessor entries', () => {
	class SymbolViewMetadata extends Model<MetadataData> {}
	assert.throws(
		() =>
			attachModelMeta(SymbolViewMetadata, {
				entity: { name: 'metadata_symbol_view' },
				views: { [Symbol('public')]: () => ({}) } as any
			} as any),
		/views metadata cannot contain symbol fields/
	);

	class AccessorViewMetadata extends Model<MetadataData> {}
	let getterCalls = 0;
	const views: Record<string, unknown> = {};
	Object.defineProperty(views, 'public', {
		enumerable: true,
		get() {
			getterCalls++;
			return () => ({});
		}
	});
	assert.throws(
		() =>
			attachModelMeta(AccessorViewMetadata, {
				entity: { name: 'metadata_accessor_view' },
				views: views as any
			} as any),
		/views metadata\.public must be a data property/
	);
	assert.equal(getterCalls, 0);

	class HiddenViewMetadata extends Model<MetadataData> {}
	const hiddenViews = Object.defineProperty({}, 'public', {
		enumerable: false,
		value: () => ({})
	});
	assert.throws(
		() =>
			attachModelMeta(HiddenViewMetadata, {
				entity: { name: 'metadata_hidden_view' },
				views: hiddenViews as any
			} as any),
		/views metadata\.public must be enumerable/
	);

	class CustomEntriesViewMetadata extends Model<MetadataData> {}
	let entriesCalls = 0;
	const mapViews = new Map<string, () => object>([['public', () => ({})]]);
	Object.defineProperty(mapViews, 'entries', {
		value() {
			entriesCalls++;
			throw new Error('custom metadata map entries should not run');
		}
	});
	attachModelMeta(CustomEntriesViewMetadata, {
		entity: { name: 'metadata_custom_entries_view' },
		views: mapViews as any
	} as any);
	assert.equal(entriesCalls, 0);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	assert.deepEqual(Array.from(context.meta(CustomEntriesViewMetadata).views.keys()), ['public']);

	let iteratorCalls = 0;
	const relations = new Map<string, unknown>([
		[
			'owner',
			{
				kind: 'one',
				target: () => MetadataOwner,
				localKey: 'ownerId',
				foreignKey: 'id'
			}
		]
	]);
	Object.defineProperty(relations, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom metadata map iterator should not run');
		}
	});
	class SymbolIteratorRelationMetadata extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_symbol_iterator_relation' },
			relations
		};
	}
	assert.throws(
		() => context.meta(SymbolIteratorRelationMetadata),
		/relations metadata cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
});

test('map relation metadata values reject accessors before copying', () => {
	let kindCalls = 0;
	const relationValue = {
		get kind() {
			kindCalls++;
			return 'one';
		},
		target: () => MetadataOwner,
		localKey: 'ownerId',
		foreignKey: 'id'
	};
	class MapRelationAccessorMetadata extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_map_relation_accessor' },
			relations: new Map([['owner', relationValue]])
		};
	}

	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(MapRelationAccessorMetadata),
		/relation metadata\.kind must be a data property/
	);
	assert.equal(kindCalls, 0);
});

test('metadata static schema field arrays reject sparse and unsafe entries', () => {
	{
		class SparseStaticSchema extends Model<MetadataData> {
			static schema = {
				entity: { name: 'bad_sparse_static_schema' },
				indexes: [{ name: 'sparse_index', fields: new Array(1) }],
				searchIndexes: [{ name: 'sparse_search', fields: ['name'] }],
				relations: new Map()
			};
		}
		class SparseStaticSearchSchema extends Model<MetadataData> {
			static schema = {
				entity: { name: 'bad_sparse_static_search_schema' },
				searchIndexes: [{ name: 'sparse_search', fields: new Array(1) }]
			};
		}
		class SparseStaticRelationSchema extends Model<MetadataData> {
			static schema = {
				entity: { name: 'bad_sparse_static_relation_schema' },
				relations: new Map([
					[
						'owner',
						{
							name: 'owner',
							kind: 'one',
							target: () => MetadataOwner,
							localKey: 'ownerId',
							foreignKey: 'id',
							preload: new Array(1)
						}
					]
				])
			};
		}
		const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
		assert.throws(() => context.meta(SparseStaticSchema), /index fields\[0\] is missing/);
		assert.throws(() => context.meta(SparseStaticSearchSchema), /search index fields\[0\] is missing/);
		assert.throws(() => context.meta(SparseStaticRelationSchema), /relation preload\[0\] is missing/);
	}
});

test('metadata field arrays are snapshotted without caller-controlled array methods', () => {
	let builderMapCalls = 0;
	const builderFields = ['name'] as any[];
	Object.defineProperty(builderFields, 'map', {
		value() {
			builderMapCalls++;
			throw new Error('custom builder map should not run');
		}
	});
	class BuilderArrayRecord extends Model<MetadataData> {}
	defineModel<MetadataData>('metadata_builder_array_method')
		.id('id')
		.validate((input) => input as MetadataData)
		.search('memory', builderFields)
		.attach(BuilderArrayRecord);
	assert.equal(builderMapCalls, 0);

	let staticMapCalls = 0;
	const staticFields = ['name'] as any[];
	Object.defineProperty(staticFields, 'map', {
		value() {
			staticMapCalls++;
			throw new Error('custom static map should not run');
		}
	});
	class StaticArrayRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_static_array_method' },
			idField: 'id',
			searchIndexes: [{ name: 'search_name', fields: staticFields }]
		};
	}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	assert.deepEqual(context.meta(StaticArrayRecord).searchIndexes[0].fields, ['name']);
	assert.equal(staticMapCalls, 0);

	let iteratorCalls = 0;
	const preload = ['name'] as any[];
	Object.defineProperty(preload, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom iterator should not run');
		}
	});
	class StaticSymbolPreloadRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_static_symbol_preload' },
			idField: 'id',
			relations: new Map([
				[
					'owner',
					{
						name: 'owner',
						kind: 'one',
						target: () => MetadataOwner,
						localKey: 'ownerId',
						foreignKey: 'id',
						preload
					}
				]
			])
		};
	}
	assert.throws(() => context.meta(StaticSymbolPreloadRecord), /relation preload cannot contain symbol fields/);
	assert.equal(iteratorCalls, 0);

	let topLevelIndexIteratorCalls = 0;
	const staticIndexes = [{ name: 'name_index', fields: ['name'] }] as any[];
	Object.defineProperty(staticIndexes, Symbol.iterator, {
		value() {
			topLevelIndexIteratorCalls++;
			throw new Error('custom static indexes iterator should not run');
		}
	});
	class StaticIndexArrayRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_static_index_array_method' },
			idField: 'id',
			indexes: staticIndexes
		};
	}
	assert.throws(() => context.meta(StaticIndexArrayRecord), /model metadata\.indexes cannot contain symbol fields/);
	assert.equal(topLevelIndexIteratorCalls, 0);
});

test('model definition and decorator metadata ignore patched Array map', () => {
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	let builderIndexName;
	let builderSearchName;
	let builderPreload;
	let decoratorIndexName;
	let decoratorSearchName;
	let decoratorPreload;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	try {
		class BuilderMapTarget extends Model<MetadataData> {}
		class BuilderMapOwner extends Model<MetadataData & { ownerId: number }> {}
		defineModel<MetadataData>('metadata_builder_global_map_target')
			.id('id')
			.validate((input) => input as MetadataData)
			.attach(BuilderMapTarget);
		defineModel<MetadataData & { ownerId: number }>('metadata_builder_global_map_owner')
			.id('id')
			.validate((input) => input as MetadataData & { ownerId: number })
			.index('owner.id' as any)
			.search('memory', ['owner.id' as any])
			.ref('owner', () => BuilderMapTarget, { localKey: 'ownerId', foreignKey: 'id', preload: ['name'] })
			.attach(BuilderMapOwner);

		class DecoratorMapTarget extends Model<MetadataData> {}
		class DecoratorMapOwner extends Model<MetadataData & { ownerId: number }> {}
		defineModel<MetadataData>('metadata_decorator_global_map_target')
			.id('id')
			.validate((input) => input as MetadataData)
			.attach(DecoratorMapTarget);
		defineModel<MetadataData & { ownerId: number }>('metadata_decorator_global_map_owner')
			.id('id')
			.validate((input) => input as MetadataData & { ownerId: number })
			.attach(DecoratorMapOwner);
		decoratorIndex(['owner.id' as any])(DecoratorMapOwner);
		decoratorSearchIndex(['owner.id' as any], { adapter: 'memory' })(DecoratorMapOwner);
		relation(() => DecoratorMapTarget, {
			kind: 'one',
			localKey: 'ownerId',
			foreignKey: 'id',
			preload: ['name']
		})(DecoratorMapOwner.prototype, 'owner');

		const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
		const builderMeta = context.meta(BuilderMapOwner);
		const decoratorMeta = context.meta(DecoratorMapOwner);
		builderIndexName = builderMeta.indexes[0].name;
		builderSearchName = builderMeta.searchIndexes[0].name;
		builderPreload = builderMeta.relations.get('owner')?.preload;
		decoratorIndexName = decoratorMeta.indexes[0].name;
		decoratorSearchName = decoratorMeta.searchIndexes[0].name;
		decoratorPreload = decoratorMeta.relations.get('owner')?.preload;
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
	}
	assert.equal(builderIndexName, 'owner_id');
	assert.equal(builderSearchName, 'owner_id');
	assert.deepEqual(builderPreload, ['name']);
	assert.equal(decoratorIndexName, 'owner_id');
	assert.equal(decoratorSearchName, 'owner_id');
	assert.deepEqual(decoratorPreload, ['name']);
});

test('field overlap validation ignores patched Array sort and slice', () => {
	const sort = Object.getOwnPropertyDescriptor(Array.prototype, 'sort')!;
	const slice = Object.getOwnPropertyDescriptor(Array.prototype, 'slice')!;
	Object.defineProperty(Array.prototype, 'sort', {
		configurable: true,
		value() {
			throw new Error('patched Array.sort');
		}
	});
	Object.defineProperty(Array.prototype, 'slice', {
		configurable: true,
		value() {
			throw new Error('patched Array.slice');
		}
	});
	let error: unknown;
	try {
		try {
			assertNoOverlappingFieldPaths(['profile.name', 'profile'], 'test fields');
		} catch (caught) {
			error = caught;
		}
	} finally {
		Object.defineProperty(Array.prototype, 'sort', sort);
		Object.defineProperty(Array.prototype, 'slice', slice);
	}

	assert.match(String((error as Error | undefined)?.message), /test fields cannot include both "profile" and nested field "profile\.name"/);
});

test('failed metadata application does not leave partial model metadata', () => {
	class FailedApplyRecord extends Model<MetadataData> {}
	assert.throws(
		() =>
			attachModelMeta(FailedApplyRecord, {
				entity: { name: 'metadata_failed_apply' },
				idField: 'id',
				indexes: [{ name: 'bad_index', fields: null as any }]
			} as any),
		/index fields must be a non-empty array/
	);

	const raw = getModelMeta(FailedApplyRecord);
	assert.equal(raw.entity, undefined);
	assert.equal(raw.idField, undefined);
	assert.deepEqual(raw.indexes, []);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(FailedApplyRecord),
		/missing entity metadata/
	);

	defineModel<MetadataData>('metadata_failed_apply_recovered')
		.id('id')
		.index('name', { name: 'recovered_name' })
		.attach(FailedApplyRecord);
	const recovered = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(FailedApplyRecord);
	assert.equal(recovered.name, 'metadata_failed_apply_recovered');
	assert.deepEqual(recovered.indexes.map((index) => index.name), ['recovered_name']);
});

test('static modelName failures do not leave partial entity metadata', () => {
	class LockedDirectEntity extends Model<MetadataData> {}
	Object.defineProperty(LockedDirectEntity, 'modelName', {
		value: 'locked_direct',
		configurable: false,
		writable: false
	});
	assert.throws(
		() => modelMeta.entity(LockedDirectEntity, { name: 'metadata_locked_direct' }),
		/Static modelName must be writable/
	);
	assert.equal(getModelMeta(LockedDirectEntity).entity, undefined);

	class LockedAttachEntity extends Model<MetadataData> {}
	Object.defineProperty(LockedAttachEntity, 'modelName', {
		value: 'locked_attach',
		configurable: false,
		writable: false
	});
	assert.throws(
		() => defineModel<MetadataData>('metadata_locked_attach').id('id').attach(LockedAttachEntity),
		/Static modelName must be writable/
	);
	const raw = getModelMeta(LockedAttachEntity);
	assert.equal(raw.entity, undefined);
	assert.equal(raw.idField, undefined);

	class WritableLockedEntity extends Model<MetadataData> {}
	Object.defineProperty(WritableLockedEntity, 'modelName', {
		value: 'locked_writable_before',
		configurable: false,
		writable: true,
		enumerable: true
	});
	modelMeta.entity(WritableLockedEntity, { name: 'metadata_locked_writable_one' });
	let descriptor = Object.getOwnPropertyDescriptor(WritableLockedEntity, 'modelName');
	assert.equal(descriptor?.value, 'metadata_locked_writable_one');
	assert.equal(descriptor?.configurable, false);
	assert.equal(descriptor?.writable, true);
	assert.equal(descriptor?.enumerable, true);

	modelMeta.entity(WritableLockedEntity, { name: 'metadata_locked_writable_two' });
	descriptor = Object.getOwnPropertyDescriptor(WritableLockedEntity, 'modelName');
	assert.equal(descriptor?.value, 'metadata_locked_writable_two');
	assert.equal(descriptor?.configurable, false);
	assert.equal(descriptor?.writable, true);
	assert.equal(descriptor?.enumerable, true);
});

test('failed metadata updates keep existing model metadata intact', () => {
	class ExistingApplyRecord extends Model<MetadataData> {}
	defineModel<MetadataData>('metadata_existing_apply')
		.id('id')
		.index('name', { name: 'existing_name' })
		.attach(ExistingApplyRecord);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const before = context.meta(ExistingApplyRecord);

	assert.throws(
		() =>
			attachModelMeta(ExistingApplyRecord, {
				entity: { name: 'metadata_existing_apply_replaced' },
				idField: 'ownerId',
				indexes: [{ name: 'bad_index', fields: new Array(1) as any }]
			} as any),
		/index fields\[0\] is missing/
	);

	const after = context.meta(ExistingApplyRecord);
	assert.equal(after.name, before.name);
	assert.equal(after.idField, before.idField);
	assert.deepEqual(after.indexes.map((index) => index.name), ['existing_name']);
});

test('generated index names are portable for dotted fields', () => {
	class DottedMetadataRecord extends Model<MetadataData> {}
	class DottedDecoratorRecord extends Model<MetadataData> {}
	defineModel<MetadataData>('metadata_dotted_names')
		.id('id')
		.index('owner.id' as any)
		.search('memory', ['owner.id' as any])
		.attach(DottedMetadataRecord);
	defineModel<MetadataData>('metadata_dotted_decorator_names').id('id').attach(DottedDecoratorRecord);
	decoratorIndex(['owner.id' as any])(DottedDecoratorRecord);
	decoratorSearchIndex(['owner.id' as any], { adapter: 'memory' })(DottedDecoratorRecord);

	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DottedMetadataRecord);
	const decoratorMeta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(DottedDecoratorRecord);
	assert.deepEqual(meta.indexes.map((index) => index.name), ['owner_id']);
	assert.deepEqual(meta.searchIndexes.map((index) => index.name), ['owner_id']);
	assert.deepEqual(decoratorMeta.indexes.map((index) => index.name), ['owner_id']);
	assert.deepEqual(decoratorMeta.searchIndexes.map((index) => index.name), ['owner_id']);
});

test('model definition metadata ignores inherited option fields', () => {
	class MetadataOwnOptionsTarget extends Model<MetadataData> {}
	class MetadataOwnOptionsOwner extends Model<MetadataData & { targetId: number }> {}
	defineModel<MetadataData>('metadata_own_options_target').id('id').attach(MetadataOwnOptionsTarget);

	Object.defineProperty(Object.prototype, 'fields', {
		value: ['__proto__'],
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'name', {
		value: 'bad\0name',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'adapter', {
		value: '__proto__',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'preload', {
		value: ['__proto__'],
		configurable: true
	});
	try {
		defineModel<MetadataData & { targetId: number }>('metadata_own_options_owner')
			.id('id')
			.index('name')
			.search('memory', ['name'])
			.ref('target', () => MetadataOwnOptionsTarget, { localKey: 'targetId', foreignKey: 'id' })
			.attach(MetadataOwnOptionsOwner);
	} finally {
		delete (Object.prototype as Record<string, unknown>).fields;
		delete (Object.prototype as Record<string, unknown>).name;
		delete (Object.prototype as Record<string, unknown>).adapter;
		delete (Object.prototype as Record<string, unknown>).preload;
	}

	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(MetadataOwnOptionsOwner);
	assert.deepEqual(meta.indexes.map((index) => index.name), ['name']);
	assert.deepEqual(meta.searchIndexes.map((index) => [index.name, index.adapter]), [['name', 'memory']]);
	assert.deepEqual(meta.relations.get('target')?.preload, undefined);

	class MetadataInheritedEntity extends Model<MetadataData> {}
	Object.defineProperty(Object.prototype, 'name', {
		value: 'metadata_inherited_entity',
		configurable: true
	});
	try {
		assert.throws(() => defineModel<MetadataData>({} as any).attach(MetadataInheritedEntity), /entity name/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).name;
	}

	let getterCalls = 0;
	const accessorIndexOptions = Object.defineProperty({}, 'name', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'by_name';
		}
	});
	assert.throws(
		() => defineModel<MetadataData>('metadata_builder_accessor_option').index('name', accessorIndexOptions as any),
		/index options property "name" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenIndexOptions = Object.defineProperty({}, 'name', {
		enumerable: false,
		value: 'by_name'
	});
	assert.throws(
		() => defineModel<MetadataData>('metadata_builder_hidden_option').index('name', hiddenIndexOptions as any),
		/index options property "name" must be enumerable/
	);

	assert.throws(
		() => defineModel<MetadataData>('metadata_builder_symbol_option').index('name', { [Symbol('name')]: 'by_name' } as any),
		/index options cannot contain symbol fields/
	);
});

test('metadata definition allowlists use captured collection intrinsics', () => {
	class SetIntrinsicRecord extends Model<MetadataData> {}
	class DecoratorSetIntrinsicRecord extends Model<MetadataData> {}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let metaName: unknown;
	let snapshotName: unknown;
	let directMetadataError: unknown;
	let builderError: unknown;
	let decoratorError: unknown;
	let hookError: unknown;
	let validationModeError: unknown;
	let fieldTypeError: unknown;
	const mapGet = Object.getOwnPropertyDescriptor(Map.prototype, 'get')!;
	const mapSet = Object.getOwnPropertyDescriptor(Map.prototype, 'set')!;
	const setHas = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!;
	const setAdd = Object.getOwnPropertyDescriptor(Set.prototype, 'add')!;
	const weakSetHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'has')!;
	const weakSetAdd = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'add')!;
	Object.defineProperties(Map.prototype, {
		get: {
			configurable: true,
			value() {
				throw new Error('patched Map.get');
			}
		},
		set: {
			configurable: true,
			value() {
				throw new Error('patched Map.set');
			}
		}
	});
	Object.defineProperties(Set.prototype, {
		has: {
			configurable: true,
			value() {
				throw new Error('patched Set.has');
			}
		},
		add: {
			configurable: true,
			value() {
				throw new Error('patched Set.add');
			}
		}
	});
	Object.defineProperties(WeakSet.prototype, {
		has: {
			configurable: true,
			value() {
				throw new Error('patched WeakSet.has');
			}
		},
		add: {
			configurable: true,
			value() {
				throw new Error('patched WeakSet.add');
			}
		}
	});
	try {
		defineModel<MetadataData>('metadata_set_intrinsic_record')
			.id('id')
			.readValidation('warn')
			.fieldType('name', 'string')
			.fieldCodec('ownerId', {
				name: 'metadata_owner_codec',
				encode: (value) => value,
				decode: (value) => value,
				encodeQuery: (value) => value,
				queryOperators: ['=']
			})
			.hooks({ beforeCreate: () => undefined })
			.attach(SetIntrinsicRecord);
		const meta = context.meta(SetIntrinsicRecord);
		metaName = meta.name;
		snapshotName = getModelMeta(SetIntrinsicRecord).entity?.name;
		try {
			modelMeta.index(SetIntrinsicRecord, { name: 'bad_direct_index', fields: ['name'], uniq: true } as any);
		} catch (error) {
			directMetadataError = error;
		}
		try {
			defineModel<MetadataData>('metadata_builder_set_option').index('name', { uniq: true } as any);
		} catch (error) {
			builderError = error;
		}
		try {
			decoratorIndex(['name'], { uniq: true } as any)(DecoratorSetIntrinsicRecord);
		} catch (error) {
			decoratorError = error;
		}
		try {
			sanitizeHooks({ beforCreate: () => undefined } as any);
		} catch (error) {
			hookError = error;
		}
		try {
			modelMeta.readValidation(SetIntrinsicRecord, 'strict' as any);
		} catch (error) {
			validationModeError = error;
		}
		try {
			modelMeta.fieldType(SetIntrinsicRecord, 'name', 'money' as any);
		} catch (error) {
			fieldTypeError = error;
		}
	} finally {
		Object.defineProperty(Map.prototype, 'get', mapGet);
		Object.defineProperty(Map.prototype, 'set', mapSet);
		Object.defineProperty(Set.prototype, 'has', setHas);
		Object.defineProperty(Set.prototype, 'add', setAdd);
		Object.defineProperty(WeakSet.prototype, 'has', weakSetHas);
		Object.defineProperty(WeakSet.prototype, 'add', weakSetAdd);
	}

	assert.equal(metaName, 'metadata_set_intrinsic_record');
	assert.equal(snapshotName, 'metadata_set_intrinsic_record');
	assert.match((directMetadataError as Error).message, /index metadata contains unknown option "uniq"/);
	assert.match((builderError as Error).message, /index options contains unknown option "uniq"/);
	assert.match((decoratorError as Error).message, /index options contains unknown option "uniq"/);
	assert.match((hookError as Error).message, /hooks contains unknown hook "beforCreate"/);
	assert.match((validationModeError as Error).message, /Read validation mode "strict" is not allowed/);
	assert.match((fieldTypeError as Error).message, /Field type "money" is not allowed/);
});

test('metadata WeakMap stores use captured collection intrinsics', () => {
	class WeakMapIntrinsicRecord extends Model<MetadataData> {}
	class StaticWeakMapIntrinsicRecord extends Model<MetadataData> {
		static schema = defineModel<MetadataData>('metadata_static_weakmap_intrinsic')
			.id('id')
			.index('name', { name: 'static_weakmap_name' })
			.build();
	}
	let version: number | undefined;
	let snapshotName: string | undefined;
	let resolvedName: string | undefined;
	const weakMapGet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')!;
	const weakMapSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')!;
	Object.defineProperties(WeakMap.prototype, {
		get: {
			configurable: true,
			value() {
				throw new Error('patched WeakMap.get');
			}
		},
		set: {
			configurable: true,
			value() {
				throw new Error('patched WeakMap.set');
			}
		}
	});
	try {
		defineModel<MetadataData>('metadata_weakmap_intrinsic_record')
			.id('id')
			.index('name', { name: 'weakmap_name' })
			.attach(WeakMapIntrinsicRecord);
		version = getModelMetaVersion(WeakMapIntrinsicRecord);
		snapshotName = getModelMeta(WeakMapIntrinsicRecord).entity?.name;
		resolvedName = resolveModelMeta(StaticWeakMapIntrinsicRecord, { store: 'default' }).name;
	} finally {
		Object.defineProperty(WeakMap.prototype, 'get', weakMapGet);
		Object.defineProperty(WeakMap.prototype, 'set', weakMapSet);
	}

	assert.equal(typeof version, 'number');
	assert.equal(snapshotName, 'metadata_weakmap_intrinsic_record');
	assert.equal(resolvedName, 'metadata_static_weakmap_intrinsic');
});

test('static schema is applied deterministically and cannot be replaced silently', () => {
	class StaticSchemaRecord extends Model<MetadataData> {
		static schema = defineModel<MetadataData>('metadata_static_schema')
			.id('id')
			.index('name', { name: 'static_name' })
			.build();
	}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(StaticSchemaRecord);
	assert.equal(meta.name, 'metadata_static_schema');
	assert.deepEqual(meta.indexes.map((index) => index.name), ['static_name']);
	assert.throws(
		() => StaticSchemaRecord.schema.indexes.push({ name: 'late_index', fields: ['name'] }),
		/(read only|not extensible|Cannot add property)/
	);

	StaticSchemaRecord.schema = defineModel<MetadataData>('metadata_static_replaced').id('id').build();
	assert.throws(() => context.meta(StaticSchemaRecord), /Static schema .* replaced/);
});

test('static schema resolution ignores inherited function schema fields', () => {
	class FunctionPrototypeSchemaRecord extends Model<MetadataData> {}
	Object.defineProperty(Function.prototype, 'schema', {
		value: defineModel<MetadataData>('metadata_function_prototype_schema').id('id').build(),
		configurable: true
	});
	try {
		assert.throws(
			() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(FunctionPrototypeSchemaRecord),
			/missing entity metadata/
		);
	} finally {
		delete (Function.prototype as any).schema;
	}

	class StaticSchemaParent extends Model<MetadataData> {
		static schema = defineModel<MetadataData>('metadata_static_parent').id('id').build();
	}
	class StaticSchemaChild extends StaticSchemaParent {}
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(StaticSchemaChild),
		/missing entity metadata/
	);
});

test('static schema and metadata options reject accessor properties', () => {
	let getterCalls = 0;
	class AccessorStaticSchemaRecord extends Model<MetadataData> {
		static get schema() {
			getterCalls++;
			return defineModel<MetadataData>('metadata_accessor_static').id('id').build();
		}
	}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	assert.throws(() => context.meta(AccessorStaticSchemaRecord), /Static schema.*must be a data property/);
	assert.equal(getterCalls, 0);

	class HiddenStaticSchemaRecord extends Model<MetadataData> {}
	Object.defineProperty(HiddenStaticSchemaRecord, 'schema', {
		enumerable: false,
		value: defineModel<MetadataData>('metadata_hidden_static_schema').id('id').build()
	});
	assert.throws(() => context.meta(HiddenStaticSchemaRecord), /Static schema.*must be enumerable/);

	class AccessorIndexOptionRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_accessor_index_option' },
			idField: 'id',
			indexes: [
				Object.defineProperty({ name: 'by_name' }, 'fields', {
					enumerable: true,
					get() {
						getterCalls++;
						return ['name'];
					}
				})
			]
		} as any;
	}
	assert.throws(() => context.meta(AccessorIndexOptionRecord), /index metadata\.fields must be a data property/);
	assert.equal(getterCalls, 0);

	class HiddenIndexOptionRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_hidden_index_option' },
			idField: 'id',
			indexes: [
				Object.defineProperty({ name: 'by_name' }, 'fields', {
					enumerable: false,
					value: ['name']
				})
			]
		} as any;
	}
	assert.throws(() => context.meta(HiddenIndexOptionRecord), /index metadata\.fields must be enumerable/);

	class HiddenTopLevelMetadataRecord extends Model<MetadataData> {}
	const hiddenTopLevelMetadata = Object.defineProperty(
		{ entity: { name: 'metadata_hidden_top_level' } },
		'idField',
		{
			enumerable: false,
			value: 'id'
		}
	);
	assert.throws(
		() => attachModelMeta(HiddenTopLevelMetadataRecord, hiddenTopLevelMetadata as any),
		/model metadata\.idField must be enumerable/
	);

	class UnknownAccessorStaticSchemaRecord extends Model<MetadataData> {
		static schema = Object.defineProperty({
			entity: { name: 'metadata_unknown_accessor_static' },
			idField: 'id'
		}, 'ignored', {
			enumerable: true,
			get() {
				getterCalls++;
				return { nested: true };
			}
		}) as any;
	}
	assert.throws(
		() => context.meta(UnknownAccessorStaticSchemaRecord),
		/model metadata contains unknown option "ignored"/
	);
	assert.equal(getterCalls, 0);

	class UnknownTopLevelMetadataRecord extends Model<MetadataData> {}
	assert.throws(
		() =>
			attachModelMeta(UnknownTopLevelMetadataRecord, {
				entity: { name: 'metadata_unknown_top_level' },
				indexess: []
			} as any),
		/model metadata contains unknown option "indexess"/
	);
	assert.throws(
		() =>
			attachModelMeta(UnknownTopLevelMetadataRecord, {
				entity: { name: 'metadata_symbol_top_level' },
				[Symbol('indexes')]: []
			} as any),
		/model metadata cannot contain symbol fields/
	);
});

test('static schema rejects nested id fields before metadata is resolved', () => {
	class BadNestedIdSchemaRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_bad_nested_id' },
			idField: 'profile.id'
		} as any;
	}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	assert.throws(() => context.meta(BadNestedIdSchemaRecord), /id field "profile\.id" must be a top-level field/);
});

test('model metadata rejects field codecs on identity field paths', () => {
	class IdCodecRecord extends Model<MetadataData> {}
	class NestedIdCodecRecord extends Model<MetadataData> {}
	const codec = {
		name: 'identity-codec',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};
	assert.throws(
		() =>
			defineModel<MetadataData>('metadata_id_codec')
				.id('id')
				.fieldCodec('id', codec)
				.attach(IdCodecRecord),
		/Field codec cannot be registered on id field "id" for metadata_id_codec/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('metadata_nested_id_codec')
				.id('id')
				.fieldCodec('id.value', codec)
				.attach(NestedIdCodecRecord),
		/field codec paths for metadata_nested_id_codec cannot include both "id" and nested field "id\.value"/
	);
});

test('model metadata rejects field types on identity field paths', () => {
	class IdFieldTypeRecord extends Model<MetadataData> {}
	class NestedIdFieldTypeRecord extends Model<MetadataData> {}
	assert.throws(
		() =>
			defineModel<MetadataData>('metadata_id_field_type')
				.id('id')
				.fieldType('id', 'date')
				.attach(IdFieldTypeRecord),
		/Field type cannot be registered on id field "id" for metadata_id_field_type/
	);
	assert.throws(
		() =>
			defineModel<MetadataData>('metadata_nested_id_field_type')
				.id('id')
				.fieldType('id.value', 'string')
				.attach(NestedIdFieldTypeRecord),
		/field type paths for metadata_nested_id_field_type cannot include both "id" and nested field "id\.value"/
	);
});

test('model metadata rejects overlapping field transform paths', () => {
	class OverlappingTransformRecord extends Model<MetadataData & { profile?: { seenAt?: Date } }> {}
	class SameFieldTransformRecord extends Model<MetadataData> {}
	const codec = {
		name: 'identity-codec',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};
	assert.throws(
		() =>
			defineModel<MetadataData & { profile?: { seenAt?: Date } }>('metadata_overlapping_transforms')
				.id('id')
				.fieldCodec('profile', codec)
				.fieldType('profile.seenAt', 'date')
				.attach(OverlappingTransformRecord),
		/field transform paths for metadata_overlapping_transforms cannot include both "profile" and nested field "profile\.seenAt"/
	);
	defineModel<MetadataData>('metadata_same_field_transform')
		.id('id')
		.fieldCodec('name', codec)
		.fieldType('name', 'string')
		.attach(SameFieldTransformRecord);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	assert.equal(context.meta(SameFieldTransformRecord).fieldCodecs.has('name'), true);
	assert.equal(context.meta(SameFieldTransformRecord).fieldTypes.get('name'), 'string');
});

test('static schema identity validation failures remain recoverable', () => {
	const codec = {
		name: 'identity-codec',
		encode: (value: unknown) => value,
		decode: (value: unknown) => value
	};
	class RecoverableIdentityStaticSchemaRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_recoverable_identity_static' },
			idField: 'id',
			fieldCodecs: new Map([['id', codec]])
		};
	}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	assert.throws(
		() => context.meta(RecoverableIdentityStaticSchemaRecord),
		/Field codec cannot be registered on id field "id" for metadata_recoverable_identity_static/
	);
	RecoverableIdentityStaticSchemaRecord.schema.fieldCodecs!.delete('id');

	const meta = context.meta(RecoverableIdentityStaticSchemaRecord);
	assert.equal(meta.name, 'metadata_recoverable_identity_static');
	assert.equal(meta.fieldCodecs.size, 0);
	assert.throws(
		() => RecoverableIdentityStaticSchemaRecord.schema.fieldCodecs!.set('name', codec),
		/frozen static schema collection/
	);
});

test('invalid static schema is not frozen before a successful application', () => {
	class RecoverableStaticSchemaRecord extends Model<MetadataData> {
		static schema = {
			entity: { name: 'metadata_recoverable_static' },
			idField: 'profile.id'
		} as any;
	}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	assert.throws(() => context.meta(RecoverableStaticSchemaRecord), /id field "profile\.id" must be a top-level field/);
	RecoverableStaticSchemaRecord.schema.idField = 'id';

	const meta = context.meta(RecoverableStaticSchemaRecord);
	assert.equal(meta.idField, 'id');
	assert.throws(
		() => {
			RecoverableStaticSchemaRecord.schema.idField = 'nextId';
		},
		/(read only|Cannot assign)/
	);
});

test('static schema map collections cannot be mutated after metadata resolution', () => {
	class StaticMapSchemaRecord extends Model<MetadataData> {
		static schema = defineModel<MetadataData>('metadata_static_map_schema')
			.id('id')
			.scope('named', () => ({ name: 'Ada' }))
			.fieldType('ownerId', 'number')
			.build();
	}
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	context.meta(StaticMapSchemaRecord);

	assert.throws(
		() => StaticMapSchemaRecord.schema.scopes!.set('late', () => ({ name: 'late' })),
		/(model builder metadata|frozen static schema) collection/
	);
	assert.throws(
		() => StaticMapSchemaRecord.schema.fieldTypes!.set('name', 'date'),
		/(model builder metadata|frozen static schema) collection/
	);
});

test('batch loader resolves many duplicate waiters without recursive resolver chains', async () => {
	let calls = 0;
	const loader = new BatchLoader<{ id: number }>(async (ids) => {
		calls++;
		assert.deepEqual(ids, [1]);
		return ids.map((id) => ({ id: Number(id) }));
	}, 100);

	const loads = Array.from({ length: 12000 }, () => loader.load(1));
	const results = await Promise.all(loads);

	assert.equal(calls, 1);
	assert.equal(results.length, 12000);
	assert.deepEqual(results[0], { id: 1 });
	assert.deepEqual(results.at(-1), { id: 1 });
});

test('batch loader ignores patched Array transform helpers', async () => {
	let seenIds: unknown[] = [];
	const loader = new BatchLoader<{ id: number }>(async (ids) => {
		seenIds = [ids[0], ids[1]];
		return [{ id: Number(ids[0]) }, { id: Number(ids[1]) }];
	}, 100);
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const forEach = Object.getOwnPropertyDescriptor(Array.prototype, 'forEach')!;
	const slice = Object.getOwnPropertyDescriptor(Array.prototype, 'slice')!;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'forEach', {
		configurable: true,
		value() {
			throw new Error('patched Array.forEach');
		}
	});
	Object.defineProperty(Array.prototype, 'slice', {
		configurable: true,
		value() {
			throw new Error('patched Array.slice');
		}
	});
	let results: Array<{ id: number } | null> = [];
	try {
		const first = loader.load(1);
		const second = loader.load(2);
		results = await Promise.all([first, second]);
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
		Object.defineProperty(Array.prototype, 'forEach', forEach);
		Object.defineProperty(Array.prototype, 'slice', slice);
	}

	assert.deepEqual(seenIds, [1, 2]);
	assert.deepEqual(results, [{ id: 1 }, { id: 2 }]);
});

test('cache-backed loadManyNow ignores patched Array transform helpers', async () => {
	const store = new LoopStore();
	const cache = new LoopCache();
	const modelName = 'cache_load_regression';
	store.seed(modelName, [
		{ id: 1, value: 'one-store' },
		{ id: 3, value: 'three-store' }
	]);
	cache.seed(`${modelName}:${entityIdKey(2)}`, { id: 2, value: 'two-cache' });
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		batch: { maxSize: 2 }
	});
	context.meta(CacheLoadRecord);
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const filter = Object.getOwnPropertyDescriptor(Array.prototype, 'filter')!;
	const forEach = Object.getOwnPropertyDescriptor(Array.prototype, 'forEach')!;
	const flatMap = Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap')!;
	const slice = Object.getOwnPropertyDescriptor(Array.prototype, 'slice')!;
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
	Object.defineProperty(Array.prototype, 'flatMap', {
		configurable: true,
		value() {
			throw new Error('patched Array.flatMap');
		}
	});
	Object.defineProperty(Array.prototype, 'slice', {
		configurable: true,
		value() {
			throw new Error('patched Array.slice');
		}
	});
	let loaded: Array<CacheLoadRecord | null> = [];
	try {
		loaded = await context.loadManyNow(CacheLoadRecord, [1, 2, 3]) as Array<CacheLoadRecord | null>;
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
		Object.defineProperty(Array.prototype, 'filter', filter);
		Object.defineProperty(Array.prototype, 'forEach', forEach);
		Object.defineProperty(Array.prototype, 'flatMap', flatMap);
		Object.defineProperty(Array.prototype, 'slice', slice);
	}

	assert.deepEqual([loaded[0]?.data.value, loaded[1]?.data.value, loaded[2]?.data.value], [
		'one-store',
		'two-cache',
		'three-store'
	]);
	assert.deepEqual(cache.setKeys, [
		`${modelName}:${entityIdKey(1)}`,
		`${modelName}:${entityIdKey(3)}`
	]);
});

test('batch loader dedupes duplicate ids and isolates same ids across models with cache hits', async () => {
	const store = new TrackingBatchStore();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new MemoryCacheAdapter() }
	});
	const A = BatchRecordA.use(context) as unknown as typeof BatchRecordA;
	const B = BatchRecordB.use(context) as unknown as typeof BatchRecordB;
	await store.seed('batch_regression_a', [
		{ id: 1, value: 'a-one' },
		{ id: 2, value: 'a-two' }
	]);
	await store.seed('batch_regression_b', [{ id: 2, value: 'b-two' }]);

	assert.equal((await A.find(1).load())?.data.value, 'a-one');
	store.batches.length = 0;

	const [cachedA, missA, duplicateMissA, sameIdOtherModel] = await Promise.all([
		A.find(1).load(),
		A.find(2).load(),
		A.find(2).load(),
		B.find(2).load()
	]);

	assert.equal(cachedA?.data.value, 'a-one');
	assert.equal(missA?.data.value, 'a-two');
	assert.equal(duplicateMissA?.data.value, 'a-two');
	assert.equal(sameIdOtherModel?.data.value, 'b-two');
	assert.deepEqual(store.batches, [
		{ model: 'batch_regression_a', ids: [2] },
		{ model: 'batch_regression_b', ids: [2] }
	]);
});

test('batch loader chunks large pending loads by context max size', async () => {
	const store = new TrackingBatchStore();
	const context = createActiveTs({
		stores: { default: store },
		batch: { maxSize: 2 }
	});
	const Record = LimitedBatchRecord.use(context) as unknown as typeof LimitedBatchRecord;
	await store.seed('batch_regression_limited', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' },
		{ id: 3, value: 'three' },
		{ id: 4, value: 'four' },
		{ id: 5, value: 'five' }
	]);
	store.batches.length = 0;

	const loaded = await Promise.all([1, 2, 3, 4, 5].map((id) => Record.find(id).load()));

	assert.deepEqual(loaded.map((item) => item?.data.value), ['one', 'two', 'three', 'four', 'five']);
	assert.deepEqual(store.batches, [
		{ model: 'batch_regression_limited', ids: [1, 2] },
		{ model: 'batch_regression_limited', ids: [3, 4] },
		{ model: 'batch_regression_limited', ids: [5] }
	]);
	store.batches.length = 0;
	await context.loadManyNow(LimitedBatchRecord, [1, 2, 3, 4, 5]);
	assert.deepEqual(store.batches, [
		{ model: 'batch_regression_limited', ids: [1, 2] },
		{ model: 'batch_regression_limited', ids: [3, 4] },
		{ model: 'batch_regression_limited', ids: [5] }
	]);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, batch: { maxSize: 0 } }),
		/batch.maxSize/
	);
});

class TrackingBatchStore extends MemoryStoreAdapter {
	readonly batches: Array<{ model: string; ids: unknown[] }> = [];

	override async getMany(model: any, ids: any[]) {
		this.batches.push({ model: model.name, ids: [...ids] });
		return await super.getMany(model, ids);
	}
}
