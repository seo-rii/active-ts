import {
	type ActiveTsHooks,
	type DatastoreModelMeta,
	type EntityOptions,
	type FieldCodec,
	type FieldCodecQueryOperator,
	type FieldType,
	type IndexMeta,
	type ModelConstructor,
	type ModelMeta,
	type PolicyResolver,
	type RelationMeta,
	type ResolvedModelMeta,
	type ScopeResolver,
	type SearchIndexMeta,
	type ValidationMode,
	type Validator,
	type ViewResolver
} from './types.js';
import { ActiveTsConfigurationError } from './errors.js';
import {
	MAP_ENTRIES,
	MAP_SET,
	MAP_VALUES,
	SET_ADD,
	SET_HAS,
	SET_VALUES,
	WEAKMAP_GET,
	WEAKMAP_SET,
	WEAKSET_ADD,
	WEAKSET_HAS
} from './collection-intrinsics.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF
} from './object-intrinsics.js';
import { mergeHooks } from './hooks.js';
import {
	assertDenseArrayItems,
	assertPlainDataObject,
	assertSafeFieldPath,
	assertSafePhysicalIdentifierLength,
	assertSafeSchemaIdentifier,
	assertSafeTopLevelField,
	assertSafeTtl,
	defineDataProperty
} from './safe-keys.js';
import { assertNoOverlappingFieldPaths } from './query-utils.js';
import {
	validateDatastoreUnindexedMetadata,
	validateModelFieldTransformMetadata,
	validateSearchIndexProjectionWithDatastoreAncestorFields
} from './model-metadata-invariants.js';
import { OBJECT_ENTRIES } from './object-intrinsics.js';

const metadata = new WeakMap<ModelConstructor, ModelMeta>();
const appliedStaticSchemas = new WeakMap<ModelConstructor, ModelMeta>();
const metadataVersions = new WeakMap<ModelConstructor, number>();
const VALIDATION_MODES = capturedSet<ValidationMode>(['off', 'warn', 'error']);
const FIELD_TYPES = capturedSet<FieldType>(['string', 'number', 'boolean', 'date']);
const FIELD_CODEC_KEYS = ['name', 'encode', 'decode', 'encodeQuery', 'queryOperators'] as const;
const FIELD_CODEC_QUERY_OPERATORS = capturedSet<FieldCodecQueryOperator>([
	'=',
	'!=',
	'>',
	'>=',
	'<',
	'<=',
	'in',
	'between',
	'arrayContains',
	'textContains',
	'jsonContains',
	'startsWith'
]);
const MODEL_META_KEYS = [
	'entity',
	'idField',
	'validator',
	'readValidation',
	'indexes',
	'searchIndexes',
	'relations',
	'hooks',
	'views',
	'policies',
	'scopes',
	'fieldCodecs',
	'fieldTypes',
	'datastore'
] as const;

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function mapSet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue) {
	MAP_SET.call(map, key, value);
}

function cloneMap<TKey, TValue>(
	source: Iterable<readonly [TKey, TValue]> | undefined
) {
	const clone = new Map<TKey, TValue>();
	if (!source) return clone;
	for (const [key, value] of source) mapSet(clone, key, value);
	return clone;
}

export function assertModelConstructor(model: unknown, context = 'model constructor'): asserts model is ModelConstructor {
	if (typeof model !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a model constructor.`);
	}
}

function touch(model: ModelConstructor) {
	assertModelConstructor(model);
	WEAKMAP_SET.call(metadataVersions, model, (WEAKMAP_GET.call(metadataVersions, model) ?? 0) + 1);
}

export function getModelMetaVersion(model: ModelConstructor) {
	assertModelConstructor(model);
	const staticSchema = ownStaticSchema(model);
	const appliedStaticSchema = WEAKMAP_GET.call(appliedStaticSchemas, model);
	const pendingStaticSchema = staticSchema && staticSchema !== appliedStaticSchema ? 1 : 0;
	return (WEAKMAP_GET.call(metadataVersions, model) ?? 0) + pendingStaticSchema;
}

export function getModelMeta<TData = any>(model: ModelConstructor): ModelMeta<TData> {
	return deepFreeze(
		cloneModelMeta(ensureModelMeta<TData>(model)),
		new WeakSet<object>(),
		'Cannot mutate model metadata snapshot collection.'
	);
}

function ensureModelMeta<TData = any>(model: ModelConstructor): ModelMeta<TData> {
	assertModelConstructor(model);
	let meta = WEAKMAP_GET.call(metadata, model);
	if (!meta) {
		meta = {
			indexes: [],
			searchIndexes: [],
			relations: new Map(),
			hooks: {},
			views: new Map(),
			policies: new Map(),
			scopes: new Map(),
			fieldCodecs: new Map(),
			fieldTypes: new Map()
		};
		WEAKMAP_SET.call(metadata, model, meta);
	}
	return meta as ModelMeta<TData>;
}

export function setEntityMeta(model: ModelConstructor, entity: EntityOptions) {
	assertModelConstructor(model);
	const safeEntity = sanitizeEntity(entity);
	assertStaticModelNameWritable(model);
	ensureModelMeta(model).entity = safeEntity;
	defineStaticModelName(model, safeEntity.name);
	touch(model);
}

export function setIdField(model: ModelConstructor, field: string) {
	assertModelConstructor(model);
	ensureModelMeta(model).idField = assertSafeTopLevelField(field, 'id field');
	touch(model);
}

export function setValidator<TData>(
	model: ModelConstructor,
	validator: Validator<TData>,
	mode?: ValidationMode
) {
	assertModelConstructor(model);
	const meta = ensureModelMeta<TData>(model);
	meta.validator = sanitizeValidator(validator);
	if (mode !== undefined) meta.readValidation = sanitizeValidationMode(mode);
	touch(model);
}

export function setReadValidation(model: ModelConstructor, mode: ValidationMode) {
	assertModelConstructor(model);
	ensureModelMeta(model).readValidation = sanitizeValidationMode(mode);
	touch(model);
}

export function addIndexMeta(model: ModelConstructor, index: IndexMeta) {
	assertModelConstructor(model);
	const meta = ensureModelMeta(model);
	const safeIndex = sanitizeIndex(index);
	const existing = meta.indexes.findIndex((item) => item.name === safeIndex.name);
	if (existing >= 0) meta.indexes[existing] = safeIndex;
	else meta.indexes.push(safeIndex);
	touch(model);
}

export function addSearchIndexMeta(model: ModelConstructor, index: SearchIndexMeta) {
	assertModelConstructor(model);
	const meta = ensureModelMeta(model);
	const safeIndex = sanitizeSearchIndex(index);
	const existing = meta.searchIndexes.findIndex((item) => searchIndexKey(item) === searchIndexKey(safeIndex));
	if (existing >= 0) meta.searchIndexes[existing] = safeIndex;
	else meta.searchIndexes.push(safeIndex);
	touch(model);
}

export function addRelationMeta(model: ModelConstructor, relation: RelationMeta) {
	assertModelConstructor(model);
	const safeRelation = sanitizeRelation(relation);
	mapSet(ensureModelMeta(model).relations, safeRelation.name, safeRelation);
	touch(model);
}

export function setHooksMeta(model: ModelConstructor, hooks: ActiveTsHooks) {
	assertModelConstructor(model);
	const meta = ensureModelMeta(model);
	meta.hooks = mergeHooks(meta.hooks, hooks);
	touch(model);
}

export function addViewMeta<TData>(model: ModelConstructor, name: string, resolver: ViewResolver<TData>) {
	assertModelConstructor(model);
	const meta = ensureModelMeta<TData>(model);
	mapSet(meta.views ??= new Map(), assertSafeFieldPath(name, 'view name'), sanitizeResolver(resolver, 'view resolver'));
	touch(model);
}

export function addPolicyMeta<TData>(model: ModelConstructor, name: string, resolver: PolicyResolver<TData>) {
	assertModelConstructor(model);
	const meta = ensureModelMeta<TData>(model);
	mapSet(meta.policies ??= new Map(), assertSafeFieldPath(name, 'policy name'), sanitizeResolver(resolver, 'policy resolver'));
	touch(model);
}

export function addScopeMeta<TData>(model: ModelConstructor, name: string, resolver: ScopeResolver<TData>) {
	assertModelConstructor(model);
	const meta = ensureModelMeta<TData>(model);
	mapSet(meta.scopes ??= new Map(), assertSafeFieldPath(name, 'scope name'), sanitizeResolver(resolver, 'scope resolver'));
	touch(model);
}

export function addFieldCodecMeta(model: ModelConstructor, field: string, codec: FieldCodec) {
	assertModelConstructor(model);
	const meta = ensureModelMeta(model);
	mapSet(meta.fieldCodecs ??= new Map(), assertSafeFieldPath(field, 'field codec path'), sanitizeFieldCodec(codec));
	touch(model);
}

export function addFieldTypeMeta(model: ModelConstructor, field: string, type: FieldType) {
	assertModelConstructor(model);
	const meta = ensureModelMeta(model);
	mapSet(meta.fieldTypes ??= new Map(), assertSafeFieldPath(field, 'field type path'), sanitizeFieldType(type));
	touch(model);
}

export function applyModelMeta(model: ModelConstructor, next: Partial<ModelMeta>) {
	assertModelConstructor(model);
	if (!next || typeof next !== 'object' || Array.isArray(next)) {
		throw new ActiveTsConfigurationError('model metadata must be an object.');
	}
	assertKnownModelMetaKeys(next as Record<string, unknown>, 'model metadata');
	const meta = ensureModelMeta(model);
	const draft = cloneModelMeta(meta);
	const entity = ownMetaValue<EntityOptions>(next, 'entity');
	const idField = ownMetaValue<string>(next, 'idField');
	const validator = ownMetaValue<Validator>(next, 'validator');
	const readValidation = ownMetaValue<ValidationMode>(next, 'readValidation');
	const indexes = ownMetaValue<IndexMeta[]>(next, 'indexes');
	const searchIndexes = ownMetaValue<SearchIndexMeta[]>(next, 'searchIndexes');
	const relations = ownMetaValue<ModelMeta['relations']>(next, 'relations');
	const hooks = ownMetaValue<ActiveTsHooks>(next, 'hooks');
	const views = ownMetaValue<ModelMeta['views']>(next, 'views');
	const policies = ownMetaValue<ModelMeta['policies']>(next, 'policies');
	const scopes = ownMetaValue<ModelMeta['scopes']>(next, 'scopes');
	const fieldCodecs = ownMetaValue<ModelMeta['fieldCodecs']>(next, 'fieldCodecs');
	const fieldTypes = ownMetaValue<ModelMeta['fieldTypes']>(next, 'fieldTypes');
	const datastore = ownMetaValue<ModelMeta['datastore']>(next, 'datastore');
	if (entity !== undefined) {
		draft.entity = sanitizeEntity(entity);
	}
	if (idField !== undefined) draft.idField = assertSafeTopLevelField(idField, 'id field');
	if (validator !== undefined) draft.validator = sanitizeValidator(validator);
	if (readValidation !== undefined) draft.readValidation = sanitizeValidationMode(readValidation);
	if (indexes !== undefined) {
		const safeIndexes = snapshotMetadataArray(indexes, 'model metadata.indexes') as IndexMeta[];
		for (const index of safeIndexes) {
			const safeIndex = sanitizeIndex(index);
			const existing = draft.indexes.findIndex((item) => item.name === safeIndex.name);
			if (existing >= 0) draft.indexes[existing] = safeIndex;
			else draft.indexes.push(safeIndex);
		}
	}
	if (searchIndexes !== undefined) {
		const safeSearchIndexes = snapshotMetadataArray(searchIndexes, 'model metadata.searchIndexes') as SearchIndexMeta[];
		for (const index of safeSearchIndexes) {
			const safeIndex = sanitizeSearchIndex(index);
			const existing = draft.searchIndexes.findIndex((item) => searchIndexKey(item) === searchIndexKey(safeIndex));
			if (existing >= 0) draft.searchIndexes[existing] = safeIndex;
			else draft.searchIndexes.push(safeIndex);
		}
	}
	if (relations !== undefined) {
		const entries = metadataEntries(relations, 'relations metadata');
		for (const [name, relation] of entries) {
			const safeRelation = sanitizeRelation(relation as RelationMeta, name);
			mapSet(draft.relations, safeRelation.name, safeRelation);
		}
	}
	if (hooks !== undefined) draft.hooks = mergeHooks(draft.hooks, hooks);
	if (views !== undefined) {
		const entries = metadataEntries(views, 'views metadata');
		for (const [name, resolver] of entries)
			mapSet(draft.views ??= new Map(), assertSafeFieldPath(name, 'view name'), sanitizeResolver(resolver as ViewResolver, 'view resolver'));
	}
	if (policies !== undefined) {
		const entries = metadataEntries(policies, 'policies metadata');
		for (const [name, resolver] of entries)
			mapSet(draft.policies ??= new Map(), assertSafeFieldPath(name, 'policy name'), sanitizeResolver(resolver as PolicyResolver, 'policy resolver'));
	}
	if (scopes !== undefined) {
		const entries = metadataEntries(scopes, 'scopes metadata');
		for (const [name, resolver] of entries)
			mapSet(draft.scopes ??= new Map(), assertSafeFieldPath(name, 'scope name'), sanitizeResolver(resolver as ScopeResolver, 'scope resolver'));
	}
	if (fieldCodecs !== undefined) {
		const entries = metadataEntries(fieldCodecs, 'field codec metadata');
		for (const [field, codec] of entries)
			mapSet(draft.fieldCodecs ??= new Map(), assertSafeFieldPath(field, 'field codec path'), sanitizeFieldCodec(codec as FieldCodec));
	}
	if (fieldTypes !== undefined) {
		const entries = metadataEntries(fieldTypes, 'field type metadata');
		for (const [field, type] of entries)
			mapSet(draft.fieldTypes ??= new Map(), assertSafeFieldPath(field, 'field type path'), sanitizeFieldType(type as FieldType));
	}
	if (datastore !== undefined) draft.datastore = sanitizeDatastoreMeta(datastore);
	validateModelMetaDraft(model, draft);
	if (draft.entity) assertStaticModelNameWritable(model);
	commitModelMeta(meta, draft);
	if (draft.entity) defineStaticModelName(model, draft.entity.name);
	touch(model);
}

function defineStaticModelName(model: ModelConstructor, name: string) {
	assertStaticModelNameWritable(model);
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(model, 'modelName');
	if (descriptor && 'value' in descriptor && !descriptor.configurable) {
		defineDataProperty(model, 'modelName', name, {
			enumerable: descriptor.enumerable,
			configurable: false,
			writable: descriptor.writable
		});
		return;
	}
	defineDataProperty(model, 'modelName', name, { enumerable: false, configurable: true, writable: true });
}

function searchIndexKey(index: SearchIndexMeta) {
	return `${index.adapter ?? ''}\0${index.name}`;
}

function assertStaticModelNameWritable(model: ModelConstructor) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(model, 'modelName');
	if (descriptor && !('value' in descriptor) && !descriptor.configurable) {
		throw new ActiveTsConfigurationError('Static modelName must be a configurable data property.');
	}
	if (descriptor && 'value' in descriptor && !descriptor.configurable && !descriptor.writable) {
		throw new ActiveTsConfigurationError('Static modelName must be writable.');
	}
}

function cloneModelMeta<TData>(meta: ModelMeta<TData>): ModelMeta<TData> {
	const entity = ownMetaValue<EntityOptions>(meta, 'entity');
	return {
		entity: entity
			? {
					...entity,
					cache: entity.cache && typeof entity.cache === 'object' ? { ...entity.cache } : entity.cache
				}
			: undefined,
		idField: ownMetaValue<string>(meta, 'idField'),
		validator: ownMetaValue<Validator<TData>>(meta, 'validator'),
		readValidation: ownMetaValue<ValidationMode>(meta, 'readValidation'),
		indexes: cloneIndexesMeta(meta.indexes),
		searchIndexes: cloneSearchIndexesMeta(meta.searchIndexes),
		relations: cloneRelationsMeta(meta.relations),
		hooks: cloneHooksMeta(meta.hooks ?? {}),
		views: cloneMap(meta.views),
		policies: cloneMap(meta.policies),
		scopes: cloneMap(meta.scopes),
		fieldCodecs: cloneFieldCodecsMeta(meta.fieldCodecs),
		fieldTypes: cloneMap(meta.fieldTypes),
		datastore: cloneDatastoreMeta(meta.datastore)
	};
}

export function snapshotModelMeta<TData>(
	meta: ModelMeta<TData>,
	collectionMessage = 'Cannot mutate model metadata snapshot collection.'
): ModelMeta<TData> {
	return deepFreeze(cloneModelMeta(meta), new WeakSet<object>(), collectionMessage);
}

function cloneHooksMeta(hooks: ActiveTsHooks): ActiveTsHooks {
	const clone: ActiveTsHooks = {};
	for (const [name, hook] of OBJECT_ENTRIES(hooks) as Array<[keyof ActiveTsHooks, ActiveTsHooks[keyof ActiveTsHooks]]>) {
		clone[name] = Array.isArray(hook) ? [...hook] as any : hook as any;
	}
	return clone;
}

function cloneIndexesMeta(indexes: IndexMeta[]) {
	const clone: IndexMeta[] = [];
	for (let index = 0; index < indexes.length; index++) {
		const item = indexes[index];
		clone[index] = {
			...item,
			fields: [...item.fields],
			...(item.directions === undefined ? {} : { directions: [...item.directions] })
		};
	}
	return clone;
}

function cloneSearchIndexesMeta(indexes: SearchIndexMeta[]) {
	const clone: SearchIndexMeta[] = [];
	for (let index = 0; index < indexes.length; index++) {
		const item = indexes[index];
		clone[index] = {
			...item,
			fields: [...item.fields]
		};
	}
	return clone;
}

function cloneRelationsMeta(relations: Map<string, RelationMeta>) {
	const clone = new Map<string, RelationMeta>();
	for (const [name, relation] of MAP_ENTRIES.call(relations)) {
		mapSet(clone, name, {
			...relation,
			preload: relation.preload ? [...relation.preload] : undefined
		});
	}
	return clone;
}

function cloneFieldCodecsMeta(fieldCodecs: Map<string, FieldCodec> | undefined) {
	const clone = new Map<string, FieldCodec>();
	if (!fieldCodecs) return clone;
	for (const [field, codec] of MAP_ENTRIES.call(fieldCodecs)) {
		mapSet(clone, field, { ...codec });
	}
	return clone;
}

function cloneDatastoreMeta<TData>(datastore: DatastoreModelMeta<TData> | undefined): DatastoreModelMeta<TData> | undefined {
	if (!datastore) return undefined;
	return {
		ancestor: datastore.ancestor,
		ancestorFields: datastore.ancestorFields ? [...datastore.ancestorFields] : undefined,
		unindexed: datastore.unindexed ? [...datastore.unindexed] : undefined
	};
}

function commitModelMeta<TData>(meta: ModelMeta<TData>, draft: ModelMeta<TData>) {
	setOwnMetaValue(meta, 'entity', draft.entity);
	setOwnMetaValue(meta, 'idField', draft.idField);
	setOwnMetaValue(meta, 'validator', draft.validator);
	setOwnMetaValue(meta, 'readValidation', draft.readValidation);
	setOwnMetaValue(meta, 'indexes', draft.indexes);
	setOwnMetaValue(meta, 'searchIndexes', draft.searchIndexes);
	setOwnMetaValue(meta, 'relations', draft.relations);
	setOwnMetaValue(meta, 'hooks', draft.hooks);
	setOwnMetaValue(meta, 'views', draft.views);
	setOwnMetaValue(meta, 'policies', draft.policies);
	setOwnMetaValue(meta, 'scopes', draft.scopes);
	setOwnMetaValue(meta, 'fieldCodecs', draft.fieldCodecs);
	setOwnMetaValue(meta, 'fieldTypes', draft.fieldTypes);
	setOwnMetaValue(meta, 'datastore', draft.datastore);
}

function setOwnMetaValue<TKey extends keyof ModelMeta>(
	meta: ModelMeta,
	key: TKey,
	value: ModelMeta[TKey]
) {
	defineDataProperty(meta, key, value, { writable: true, enumerable: true, configurable: true });
}

function validateModelMetaDraft<TData>(model: ModelConstructor, draft: ModelMeta<TData>) {
	const idField = draft.idField ?? 'id';
	const modelName = draft.entity?.name ?? modelDisplayName(model);
	validateModelFieldTransformMetadata(modelName, idField, draft.fieldCodecs ?? new Map(), draft.fieldTypes ?? new Map());
	draft.datastore = validateDatastoreUnindexedMetadata(modelName, idField, draft.indexes, draft.datastore);
	draft.searchIndexes = validateSearchIndexProjections(draft.searchIndexes, idField, draft.datastore);
}

export function resolveModelMeta(
	model: ModelConstructor,
	defaults: { store: string; cache?: string; search?: string }
): ResolvedModelMeta {
	assertModelConstructor(model);
	const staticSchema = ownStaticSchema(model);
	const appliedStaticSchema = WEAKMAP_GET.call(appliedStaticSchemas, model);
	if (staticSchema && appliedStaticSchema && staticSchema !== appliedStaticSchema) {
		throw new ActiveTsConfigurationError(
			`Static schema for model ${modelDisplayName(model)} was replaced after it was applied. Define static schema before resolving metadata.`
		);
	}
	if (staticSchema && !appliedStaticSchema) {
		applyModelMeta(model, staticSchema);
		deepFreeze(staticSchema);
		WEAKMAP_SET.call(appliedStaticSchemas, model, staticSchema);
	}
	const meta = ensureModelMeta(model);
	const entity = ownMetaValue<EntityOptions>(meta, 'entity');
	if (!entity?.name) {
		throw new ActiveTsConfigurationError(
			`Model ${modelDisplayName(model)} is missing entity metadata. Use @entity(...) or defineModel(...).attach(...).`
		);
	}
	const idField = ownMetaValue<string>(meta, 'idField') ?? 'id';
	const fieldCodecs = cloneFieldCodecsMeta(meta.fieldCodecs);
	const fieldTypes = cloneMap(meta.fieldTypes);
	validateModelFieldTransformMetadata(entity.name, idField, fieldCodecs, fieldTypes);
	const datastore = validateDatastoreUnindexedMetadata(entity.name, idField, meta.indexes, cloneDatastoreMeta(meta.datastore));
	const searchIndexes = validateSearchIndexProjections(meta.searchIndexes, idField, datastore);
	const cache =
		entity.cache === false
			? undefined
			: {
					adapter: entity.cache?.adapter ?? defaults.cache ?? 'default',
					ttl: entity.cache?.ttl,
					negativeTtl: entity.cache?.negativeTtl
				};
	return freezeResolvedModelMeta({
		model,
		name: entity.name,
		store: entity.store ?? defaults.store,
		cache,
		search: entity.search ?? defaults.search,
		idField,
		validator: ownMetaValue<Validator>(meta, 'validator'),
		readValidation: ownMetaValue<ValidationMode>(meta, 'readValidation') ?? 'off',
		indexes: [...meta.indexes],
		searchIndexes,
		relations: cloneRelationsMeta(meta.relations),
		hooks: mergeHooks(meta.hooks),
		views: cloneMap(meta.views),
		policies: cloneMap(meta.policies),
		scopes: cloneMap(meta.scopes),
		fieldCodecs,
		fieldTypes,
		datastore
	});
}

function freezeResolvedModelMeta<TData>(meta: ResolvedModelMeta<TData>): ResolvedModelMeta<TData> {
	if (meta.cache) Object.freeze(meta.cache);
	if (meta.datastore?.ancestorFields) Object.freeze(meta.datastore.ancestorFields);
	if (meta.datastore?.unindexed) Object.freeze(meta.datastore.unindexed);
	if (meta.datastore) Object.freeze(meta.datastore);
	freezeMetadataArray(meta.indexes, freezeIndexMeta);
	freezeMetadataArray(meta.searchIndexes, freezeSearchIndexMeta);
	freezeMetadataMap(meta.relations, freezeRelationMeta);
	freezeMetadataMap(meta.views);
	freezeMetadataMap(meta.policies);
	freezeMetadataMap(meta.scopes);
	freezeMetadataMap(meta.fieldCodecs);
	freezeMetadataMap(meta.fieldTypes);
	freezeHooksContainer(meta.hooks);
	return Object.freeze(meta);
}

function freezeMetadataArray<T>(items: T[], freezeItem: (item: T) => void) {
	for (let index = 0; index < items.length; index++) freezeItem(items[index]);
	return Object.freeze(items);
}

function freezeIndexMeta(index: IndexMeta) {
	Object.freeze(index.fields);
	if (index.directions) Object.freeze(index.directions);
	Object.freeze(index);
}

function freezeSearchIndexMeta(index: SearchIndexMeta) {
	Object.freeze(index.fields);
	Object.freeze(index);
}

function freezeRelationMeta(relation: RelationMeta) {
	if (relation.preload) Object.freeze(relation.preload);
	Object.freeze(relation);
}

function freezeMetadataMap<K, V>(map: Map<K, V>, freezeValue?: (value: V) => void) {
	if (freezeValue) {
		for (const value of MAP_VALUES.call(map)) freezeValue(value);
	}
	freezeCollectionMutators(map, ['set', 'delete', 'clear'], 'Cannot mutate resolved model metadata collection.');
	return Object.freeze(map);
}

function freezeHooksContainer(hooks: ActiveTsHooks) {
	for (const value of Object.values(hooks)) {
		if (Array.isArray(value)) Object.freeze(value);
	}
	Object.freeze(hooks);
}

function sanitizeIndex(index: IndexMeta): IndexMeta {
	if (!index || typeof index !== 'object' || Array.isArray(index)) {
		throw new ActiveTsConfigurationError('index metadata must be an object.');
	}
	const record = index as Record<string, unknown>;
	assertKnownMetadataKeys(record, ['name', 'fields', 'directions', 'unique'], 'index metadata');
	const name = ownOptionValue(record, 'name');
	const fields = ownOptionValue(record, 'fields');
	const directions = ownOptionValue(record, 'directions');
	const unique = ownOptionValue(record, 'unique');
	if (!Array.isArray(fields) || !fields.length) {
		throw new ActiveTsConfigurationError('index fields must be a non-empty array.');
	}
	const safeFields = snapshotMetadataArray(fields, 'index fields');
	const safeDirections = sanitizeIndexDirections(directions, safeFields.length, 'index directions');
	if (unique !== undefined && typeof unique !== 'boolean') {
		throw new ActiveTsConfigurationError('index unique must be a boolean.');
	}
	return {
		name: assertSafeSchemaIdentifier(name, 'index name'),
		fields: sanitizeFieldPathList(safeFields, 'index field'),
		...(safeDirections === undefined ? {} : { directions: safeDirections }),
		unique: unique as boolean | undefined
	};
}

function sanitizeSearchIndex(index: SearchIndexMeta): SearchIndexMeta {
	if (!index || typeof index !== 'object' || Array.isArray(index)) {
		throw new ActiveTsConfigurationError('search index metadata must be an object.');
	}
	const record = index as Record<string, unknown>;
	assertKnownMetadataKeys(record, ['name', 'adapter', 'fields'], 'search index metadata');
	const name = ownOptionValue(record, 'name');
	const adapter = ownOptionValue(record, 'adapter');
	const rawFields = ownOptionValue(record, 'fields');
	if (!Array.isArray(rawFields) || !rawFields.length) {
		throw new ActiveTsConfigurationError('search index fields must be a non-empty array.');
	}
	const safeFields = snapshotMetadataArray(rawFields, 'search index fields');
	const fields = assertNoOverlappingFieldPaths(
		sanitizeFieldPathList(safeFields, 'search field'),
		'search fields'
	);
	return {
		adapter: sanitizeAdapterName(adapter as string | undefined, 'search adapter name'),
		name: assertSafeSchemaIdentifier(name, 'search index name'),
		fields: fields
	};
}

function sanitizeRelation(relation: RelationMeta, overrideName?: string): RelationMeta {
	if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
		throw new ActiveTsConfigurationError('relation metadata must be an object.');
	}
	const record = relation as unknown as Record<string, unknown>;
	assertKnownMetadataKeys(record, ['name', 'kind', 'target', 'localKey', 'foreignKey', 'preload', 'warnOnLazy', 'ancestor'], 'relation metadata');
	const kind = ownOptionValue(record, 'kind');
	const target = ownOptionValue(record, 'target');
	const preload = ownOptionValue(record, 'preload');
	const warnOnLazy = ownOptionValue(record, 'warnOnLazy');
	const ancestor = ownOptionValue(record, 'ancestor');
	if (kind !== 'one' && kind !== 'many') {
		throw new ActiveTsConfigurationError(invalidValueMessage('Relation kind', kind));
	}
	if (typeof target !== 'function') {
		throw new ActiveTsConfigurationError('relation target must be a function.');
	}
	if (preload !== undefined && !Array.isArray(preload)) {
		throw new ActiveTsConfigurationError('relation preload must be an array.');
	}
	const preloadFields = preload === undefined ? undefined : snapshotMetadataArray(preload, 'relation preload');
	const safePreload = preload === undefined
		? undefined
		: sanitizeFieldPathList(preloadFields!, 'relation preload');
	if (warnOnLazy !== undefined && typeof warnOnLazy !== 'boolean') {
		throw new ActiveTsConfigurationError('relation warnOnLazy must be a boolean.');
	}
	if (ancestor !== undefined && typeof ancestor !== 'function') {
		throw new ActiveTsConfigurationError('relation ancestor must be a function.');
	}
	return {
		name: assertSafeTopLevelField(overrideName ?? ownOptionValue(record, 'name'), 'relation name'),
		kind,
		target: target as () => ModelConstructor,
		localKey: assertSafeFieldPath(ownOptionValue(record, 'localKey'), 'relation localKey'),
		foreignKey: assertSafeFieldPath(ownOptionValue(record, 'foreignKey'), 'relation foreignKey'),
		preload: safePreload,
		warnOnLazy: warnOnLazy as boolean | undefined,
		ancestor: ancestor as RelationMeta['ancestor']
	};
}

function sanitizeDatastoreMeta<TData>(datastore: DatastoreModelMeta<TData>): DatastoreModelMeta<TData> {
	if (!datastore || typeof datastore !== 'object' || Array.isArray(datastore)) {
		throw new ActiveTsConfigurationError('datastore metadata must be an object.');
	}
	const record = datastore as Record<string, unknown>;
	assertKnownMetadataKeys(record, ['ancestor', 'ancestorFields', 'unindexed'], 'datastore metadata');
	const ancestor = ownOptionValue(record, 'ancestor');
	const ancestorFields = ownOptionValue(record, 'ancestorFields');
	const unindexed = ownOptionValue(record, 'unindexed');
	if (ancestor !== undefined && typeof ancestor !== 'function') {
		throw new ActiveTsConfigurationError('datastore metadata ancestor must be a function.');
	}
	let safeAncestorFields: string[] | undefined;
	if (ancestorFields !== undefined) {
		if (!Array.isArray(ancestorFields)) {
			throw new ActiveTsConfigurationError('datastore metadata ancestorFields must be an array.');
		}
		safeAncestorFields = sanitizeFieldPathList(
			snapshotMetadataArray(ancestorFields, 'datastore metadata ancestorFields'),
			'datastore ancestor field'
		);
	}
	let safeUnindexed: string[] | undefined;
	if (unindexed !== undefined) {
		if (!Array.isArray(unindexed) || !unindexed.length) {
			throw new ActiveTsConfigurationError('datastore metadata unindexed must be a non-empty array.');
		}
		safeUnindexed = sanitizeFieldPathList(snapshotMetadataArray(unindexed, 'datastore metadata unindexed'), 'datastore unindexed field');
	}
	return {
		ancestor: ancestor as DatastoreModelMeta<TData>['ancestor'],
		ancestorFields: safeAncestorFields,
		unindexed: safeUnindexed
	};
}

function metadataEntries(value: unknown, context: string): Iterable<[string, unknown]> {
	if (value instanceof Map) {
		if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
			throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
		}
		return MAP_ENTRIES.call(value) as Iterable<[string, unknown]>;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a Map or plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a Map or plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const entries: Array<[string, unknown]> = [];
	const keys = OBJECT_GET_OWN_PROPERTY_NAMES(value);
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
		entries[index] = [key, descriptor.value];
	}
	return entries;
}

function validateSearchIndexProjections(indexes: SearchIndexMeta[], idField: string, datastore: DatastoreModelMeta | undefined) {
	const validated: SearchIndexMeta[] = [];
	for (let index = 0; index < indexes.length; index++) {
		validated[index] = validateSearchIndexProjectionWithDatastoreAncestorFields(indexes[index], idField, datastore);
	}
	return validated;
}

function sanitizeFieldPathList(fields: readonly unknown[], context: string) {
	const safeFields: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		safeFields[index] = assertSafeFieldPath(fields[index], context);
	}
	return safeFields;
}

function sanitizeIndexDirections(directions: unknown, fieldCount: number, context: string) {
	if (directions === undefined) return undefined;
	if (!Array.isArray(directions) || directions.length !== fieldCount) {
		throw new ActiveTsConfigurationError(`${context} must be an array with one direction per index field.`);
	}
	const values = snapshotMetadataArray(directions, context);
	const safeDirections: Array<'asc' | 'desc'> = [];
	for (let index = 0; index < values.length; index++) {
		const direction = values[index];
		if (direction !== 'asc' && direction !== 'desc') {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be "asc" or "desc".`);
		}
		safeDirections[index] = direction;
	}
	return safeDirections;
}

function snapshotMetadataArray(value: unknown[], context: string): unknown[] {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const items: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be a data property.`);
		}
		items.push(descriptor.value);
	}
	return items;
}

function sanitizeEntity(entity: EntityOptions): EntityOptions {
	assertPlainDataObject(entity, 'entity options');
	assertKnownMetadataKeys(entity as unknown as Record<string, unknown>, ['name', 'store', 'cache', 'search'], 'entity options');
	const record = entity as Record<string, unknown>;
	const name = assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(ownOptionValue(record, 'name'), 'entity name'),
		'entity name'
	);
	const cache = sanitizeCacheOptions(entity, name);
	const safe: EntityOptions = {
		name,
		store: sanitizeAdapterName(ownOptionValue(record, 'store') as string | undefined, 'store adapter name'),
		cache
	};
	safe.search = sanitizeAdapterName(ownOptionValue(record, 'search') as string | undefined, 'search adapter name');
	if (safe.cache) Object.freeze(safe.cache);
	return Object.freeze(safe);
}

function sanitizeCacheOptions(entity: EntityOptions, entityName: string) {
	const entityRecord = entity as Record<string, unknown>;
	const cache = ownOptionValue(entityRecord, 'cache') as EntityOptions['cache'];
	if (cache === undefined || cache === false) return cache;
	assertPlainDataObject(cache, `${entityName} cache options`);
	const cacheRecord = cache as Record<string, unknown>;
	assertKnownMetadataKeys(cacheRecord, ['adapter', 'ttl', 'negativeTtl'], `${entityName} cache options`);
	return {
		adapter: sanitizeAdapterName(ownOptionValue(cacheRecord, 'adapter') as string | undefined, 'cache adapter name'),
		ttl: assertSafeTtl(ownOptionValue(cacheRecord, 'ttl') as number | undefined, `${entityName} cache ttl`),
		negativeTtl: assertSafeTtl(
			ownOptionValue(cacheRecord, 'negativeTtl') as number | undefined,
			`${entityName} cache negativeTtl`
		)
	};
}

function sanitizeAdapterName(name: string | undefined, context: string) {
	return name === undefined ? undefined : assertSafeSchemaIdentifier(name, context);
}

function assertKnownMetadataKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const allowedKeys = capturedSet(allowed);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
		}
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function assertKnownModelMetaKeys(record: Record<string, unknown>, context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const allowedKeys = capturedSet<string>(MODEL_META_KEYS);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function sanitizeValidator<TData>(validator: Validator<TData>) {
	if (typeof validator !== 'function') {
		throw new ActiveTsConfigurationError('model validator must be a function.');
	}
	return validator;
}

function sanitizeResolver<TResolver extends (...args: any[]) => any>(resolver: TResolver, context: string): TResolver {
	if (typeof resolver !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return resolver;
}

function sanitizeFieldCodec(codec: FieldCodec): FieldCodec {
	if (!codec || typeof codec !== 'object' || Array.isArray(codec)) {
		throw new ActiveTsConfigurationError('field codec must be an object.');
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(codec);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError('field codec must be a plain object.');
	}
	const record = codec as unknown as Record<string, unknown>;
	assertKnownMetadataKeys(record, FIELD_CODEC_KEYS, 'field codec');
	const encode = ownOptionValue(record, 'encode');
	const decode = ownOptionValue(record, 'decode');
	const encodeQuery = ownOptionValue(record, 'encodeQuery');
	const queryOperators = ownOptionValue(record, 'queryOperators');
	const name = ownOptionValue(record, 'name');
	if (typeof encode !== 'function') throw new ActiveTsConfigurationError('field codec encode must be a function.');
	if (typeof decode !== 'function') throw new ActiveTsConfigurationError('field codec decode must be a function.');
	if (encodeQuery !== undefined && typeof encodeQuery !== 'function') {
		throw new ActiveTsConfigurationError('field codec encodeQuery must be a function.');
	}
	const safeQueryOperators = sanitizeFieldCodecQueryOperators(queryOperators, 'field codec queryOperators');
	if (safeQueryOperators !== undefined && encodeQuery === undefined) {
		throw new ActiveTsConfigurationError('field codec queryOperators require encodeQuery.');
	}
	return Object.freeze({
		name: assertSafeSchemaIdentifier(name, 'field codec name'),
		encode: encode as FieldCodec['encode'],
		decode: decode as FieldCodec['decode'],
		encodeQuery: encodeQuery as FieldCodec['encodeQuery'],
		queryOperators: safeQueryOperators
	});
}

function sanitizeFieldCodecQueryOperators(value: unknown, context: string) {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an array.`);
	}
	const operators = snapshotMetadataArray(value, context);
	const safe: FieldCodecQueryOperator[] = [];
	const seen = new Set<string>();
	for (const operator of operators) {
		if (typeof operator !== 'string' || !SET_HAS.call(FIELD_CODEC_QUERY_OPERATORS, operator as FieldCodecQueryOperator)) {
			throw new ActiveTsConfigurationError(invalidValueMessage('Field codec query operator', operator));
		}
		if (SET_HAS.call(seen, operator)) {
			throw new ActiveTsConfigurationError(`field codec queryOperators contains duplicate operator "${operator}".`);
		}
		SET_ADD.call(seen, operator);
		safe.push(operator as FieldCodecQueryOperator);
	}
	return Object.freeze(safe);
}

function ownStaticSchema(model: ModelConstructor) {
	if (!Object.prototype.hasOwnProperty.call(model, 'schema')) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(model, 'schema');
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`Static schema for model ${modelDisplayName(model)} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`Static schema for model ${modelDisplayName(model)} must be enumerable.`);
	}
	return descriptor.value as ModelMeta | undefined;
}

function modelDisplayName(model: ModelConstructor) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(model, 'name');
	if (!descriptor) return '<anonymous>';
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('Static model name must be a data property.');
	}
	return typeof descriptor.value === 'string' && descriptor.value ? descriptor.value : '<anonymous>';
}

function ownMetaValue<T>(record: Partial<ModelMeta>, key: keyof ModelMeta) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`model metadata.${String(key)} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`model metadata.${String(key)} must be enumerable.`);
	}
	return descriptor.value as T;
}

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`metadata option "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`metadata option "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

export function sanitizeValidationMode(mode: ValidationMode) {
	if (!SET_HAS.call(VALIDATION_MODES, mode)) {
		throw new ActiveTsConfigurationError(invalidValueMessage('Read validation mode', mode));
	}
	return mode;
}

export function sanitizeFieldType(type: FieldType) {
	if (!SET_HAS.call(FIELD_TYPES, type)) {
		throw new ActiveTsConfigurationError(invalidValueMessage('Field type', type));
	}
	return type;
}

function invalidValueMessage(label: string, value: unknown) {
	return typeof value === 'string' ? `${label} "${value}" is not allowed.` : `${label} is not allowed.`;
}

function deepFreeze<T>(
	value: T,
	seen = new WeakSet<object>(),
	collectionMessage = 'Cannot mutate frozen static schema collection.'
): T {
	if (!value || typeof value !== 'object') return value;
	const object = value as object;
	if (WEAKSET_HAS.call(seen, object)) return value;
	WEAKSET_ADD.call(seen, object);
	if (value instanceof Map) {
		for (const [key, item] of MAP_ENTRIES.call(value)) {
			deepFreeze(key, seen, collectionMessage);
			deepFreeze(item, seen, collectionMessage);
		}
		freezeCollectionMutators(value, ['set', 'delete', 'clear'], collectionMessage);
	} else if (value instanceof Set) {
		for (const item of SET_VALUES.call(value)) deepFreeze(item, seen, collectionMessage);
		freezeCollectionMutators(value, ['add', 'delete', 'clear'], collectionMessage);
	} else {
		for (const key of Object.keys(value as Record<string, unknown>)) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
			if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen, collectionMessage);
		}
	}
	return Object.freeze(value);
}

function freezeCollectionMutators(
	value: object,
	methods: string[],
	message = 'Cannot mutate frozen static schema collection.'
) {
	for (const method of methods) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, method);
		if (descriptor && !descriptor.configurable) continue;
		defineDataProperty(
			value,
			method,
			() => {
				throw new TypeError(message);
			},
			{ configurable: false }
		);
	}
}
