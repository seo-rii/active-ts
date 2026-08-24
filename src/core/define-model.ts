import {
	addFieldCodecMeta,
	addIndexMeta,
	addPolicyMeta,
	addRelationMeta,
	addSearchIndexMeta,
	addScopeMeta,
	addViewMeta,
	addFieldTypeMeta,
	applyModelMeta,
	setEntityMeta,
	setHooksMeta,
	setIdField,
	setReadValidation,
	snapshotModelMeta,
	setValidator,
	sanitizeFieldType,
	sanitizeValidationMode
} from './metadata.js';
import { assertDenseArrayItems, assertPlainDataObject, assertSafeFieldPath, assertSafeTopLevelField } from './safe-keys.js';
import { assertNoOverlappingFieldPaths } from './query-utils.js';
import { mergeHooks } from './hooks.js';
import { ActiveTsConfigurationError } from './errors.js';
import { MAP_SET, SET_ADD, SET_HAS } from './collection-intrinsics.js';
import {
	type ActiveTsHooks,
	type DatastoreModelMeta,
	type EntityOptions,
	type FieldCodec,
	type FieldType,
	type IndexMeta,
	type ModelConstructor,
	type ModelMeta,
	type PolicyResolver,
	type RelationMeta,
	type ScopeResolver,
	type SearchIndexMeta,
	type ValidationMode,
	type Validator,
	type ViewResolver
} from './types.js';

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function mapSet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue) {
	MAP_SET.call(map, key, value);
}

export class ModelBuilder<TData extends Record<string, any>> {
	private readonly meta: ModelMeta<TData> = {
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

	constructor(name?: string | EntityOptions) {
		if (typeof name === 'string') this.meta.entity = { name };
		else if (name !== undefined) {
			assertPlainDataObject(name, 'entity options');
			this.meta.entity = name;
		}
	}

	entity(options: EntityOptions) {
		this.meta.entity = options;
		return this;
	}

	id(field: keyof TData | string) {
		this.meta.idField = assertSafeTopLevelField(field, 'id field');
		return this;
	}

	validate(validator: Validator<TData>) {
		this.meta.validator = validator;
		return this;
	}

	readValidation(mode: ValidationMode) {
		this.meta.readValidation = sanitizeValidationMode(mode);
		return this;
	}

	index(nameOrField: keyof TData | string, options: Partial<IndexMeta> = {}) {
		const optionRecord = normalizeBuilderOptions(options, 'index options', ['fields', 'directions', 'unique', 'name']);
		const optionFields = ownOptionValue(optionRecord, 'fields');
		const optionDirections = ownOptionValue(optionRecord, 'directions');
		const optionUnique = ownOptionValue(optionRecord, 'unique');
		const optionName = ownOptionValue(optionRecord, 'name');
		const fields = normalizeSchemaFields(
			optionFields === undefined ? [nameOrField] : optionFields,
			'index fields',
			'index field'
		);
		const directions = normalizeIndexDirections(optionDirections, fields.length, 'index directions');
		if (optionUnique !== undefined && typeof optionUnique !== 'boolean') {
			throw new ActiveTsConfigurationError('index unique must be a boolean.');
		}
		this.meta.indexes.push({
			name: optionName === undefined ? defaultSchemaName('index', fields) : optionName as string,
			fields,
			...(directions === undefined ? {} : { directions }),
			unique: optionUnique as boolean | undefined
		});
		return this;
	}

	search(adapterOrName: string, fields: Array<keyof TData | string>, options: Partial<SearchIndexMeta> = {}) {
		const optionRecord = normalizeBuilderOptions(options, 'search options', ['name']);
		const optionName = ownOptionValue(optionRecord, 'name');
		const safeFields = assertNoOverlappingFieldPaths(
			normalizeSchemaFields(fields, 'search fields', 'search field'),
			'search fields'
		);
		this.meta.searchIndexes.push({
			name: optionName === undefined ? defaultSchemaName('search', safeFields) : optionName as string,
			adapter: adapterOrName,
			fields: safeFields
		});
		return this;
	}

	hooks(hooks: ActiveTsHooks) {
		this.meta.hooks = mergeHooks(this.meta.hooks, hooks);
		return this;
	}

	view(name: string, resolver: ViewResolver<TData>) {
		mapSet(this.meta.views!, assertSafeFieldPath(name, 'view name'), resolver);
		return this;
	}

	policy(name: string, resolver: PolicyResolver<TData>) {
		mapSet(this.meta.policies!, assertSafeFieldPath(name, 'policy name'), resolver);
		return this;
	}

	scope(name: string, resolver: ScopeResolver<TData>) {
		mapSet(this.meta.scopes!, assertSafeFieldPath(name, 'scope name'), resolver);
		return this;
	}

	fieldCodec(field: keyof TData | string, codec: FieldCodec) {
		mapSet(this.meta.fieldCodecs!, assertSafeFieldPath(field, 'field codec path'), codec);
		return this;
	}

	fieldType(field: keyof TData | string, type: FieldType) {
		mapSet(this.meta.fieldTypes!, assertSafeFieldPath(field, 'field type path'), sanitizeFieldType(type));
		return this;
	}

	datastore(options: DatastoreModelMeta<TData>) {
		this.meta.datastore = normalizeDatastoreOptions(options);
		return this;
	}

	ref(name: string, target: () => ModelConstructor, options: Omit<RelationMeta, 'name' | 'kind' | 'target'>) {
		const safeName = assertSafeTopLevelField(name, 'relation name');
		const relation = normalizeRelationOptions(options);
		mapSet(this.meta.relations, safeName, {
			name: safeName,
			kind: 'one',
			target,
			...relation
		});
		return this;
	}

	hasMany(
		name: string,
		target: () => ModelConstructor,
		options: Omit<RelationMeta, 'name' | 'kind' | 'target'>
	) {
		const safeName = assertSafeTopLevelField(name, 'relation name');
		const relation = normalizeRelationOptions(options);
		mapSet(this.meta.relations, safeName, {
			name: safeName,
			kind: 'many',
			target,
			...relation
		});
		return this;
	}

	build() {
		return snapshotModelMeta(this.meta, 'Cannot mutate model builder metadata collection.');
	}

	attach(model: ModelConstructor) {
		applyModelMeta(model, this.meta);
		return model;
	}
}

export function defineModel<TData extends Record<string, any>>(name?: string | EntityOptions) {
	return new ModelBuilder<TData>(name);
}

function normalizeRelationPreload(preload: string[] | undefined) {
	if (preload === undefined) return undefined;
	const fields = snapshotBuilderArray(preload, 'relation preload');
	const normalized: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		normalized[index] = assertSafeFieldPath(fields[index], 'relation preload');
	}
	return normalized;
}

function normalizeRelationOptions(options: Omit<RelationMeta, 'name' | 'kind' | 'target'>) {
	const record = normalizeBuilderOptions(options, 'relation options', ['localKey', 'foreignKey', 'preload', 'warnOnLazy', 'ancestor']);
	const warnOnLazy = ownOptionValue(record, 'warnOnLazy');
	const ancestor = ownOptionValue(record, 'ancestor');
	if (warnOnLazy !== undefined && typeof warnOnLazy !== 'boolean') {
		throw new ActiveTsConfigurationError('relation warnOnLazy must be a boolean.');
	}
	if (ancestor !== undefined && typeof ancestor !== 'function') {
		throw new ActiveTsConfigurationError('relation ancestor must be a function.');
	}
	return {
		localKey: assertSafeFieldPath(ownOptionValue(record, 'localKey'), 'relation localKey'),
		foreignKey: assertSafeFieldPath(ownOptionValue(record, 'foreignKey'), 'relation foreignKey'),
		preload: normalizeRelationPreload(ownOptionValue(record, 'preload') as string[] | undefined),
		warnOnLazy: warnOnLazy as boolean | undefined,
		ancestor: ancestor as RelationMeta['ancestor']
	};
}

function normalizeDatastoreOptions<TData>(options: DatastoreModelMeta<TData>): DatastoreModelMeta<TData> {
	const record = normalizeBuilderOptions(options, 'datastore options', ['ancestor', 'ancestorFields', 'unindexed']);
	const ancestor = ownOptionValue(record, 'ancestor');
	const ancestorFields = ownOptionValue(record, 'ancestorFields');
	const unindexed = ownOptionValue(record, 'unindexed');
	if (ancestor !== undefined && typeof ancestor !== 'function') {
		throw new ActiveTsConfigurationError('datastore ancestor must be a function.');
	}
	return {
		ancestor: ancestor as DatastoreModelMeta<TData>['ancestor'],
		ancestorFields: ancestorFields === undefined
			? undefined
			: normalizeSchemaFields(ancestorFields, 'datastore ancestorFields', 'datastore ancestor field', { allowEmpty: true }),
		unindexed: unindexed === undefined
			? undefined
			: normalizeSchemaFields(unindexed, 'datastore unindexed fields', 'datastore unindexed field')
	};
}

function normalizeSchemaFields(
	fields: unknown,
	listContext: string,
	fieldContext: string,
	options: { allowEmpty?: boolean } = {}
) {
	if (!Array.isArray(fields)) {
		throw new ActiveTsConfigurationError(`${listContext} must be ${options.allowEmpty ? 'an array' : 'a non-empty array'}.`);
	}
	if (!options.allowEmpty && !fields.length) {
		throw new ActiveTsConfigurationError(`${listContext} must be a non-empty array.`);
	}
	const values = snapshotBuilderArray(fields, listContext);
	const normalized: string[] = [];
	for (let index = 0; index < values.length; index++) {
		normalized[index] = assertSafeFieldPath(values[index], fieldContext);
	}
	return normalized;
}

function normalizeIndexDirections(directions: unknown, fieldCount: number, context: string) {
	if (directions === undefined) return undefined;
	if (!Array.isArray(directions) || directions.length !== fieldCount) {
		throw new ActiveTsConfigurationError(`${context} must be an array with one direction per index field.`);
	}
	const values = snapshotBuilderArray(directions, context);
	const normalized: Array<'asc' | 'desc'> = [];
	for (let index = 0; index < values.length; index++) {
		const direction = values[index];
		if (direction !== 'asc' && direction !== 'desc') {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be "asc" or "desc".`);
		}
		normalized[index] = direction;
	}
	return normalized;
}

function normalizeBuilderOptions(options: unknown, context: string, allowed: readonly string[]) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(options).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const allowedKeys = stringSet(allowed);
	for (const property of Object.getOwnPropertyNames(options)) {
		const descriptor = Object.getOwnPropertyDescriptor(options, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context} property "${property}" must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context} property "${property}" must be enumerable.`);
		}
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
	return options as Record<string, unknown>;
}

function defaultSchemaName(prefix: string, fields: string[]) {
	let joined = '';
	for (let index = 0; index < fields.length; index++) {
		if (index > 0) joined += '_';
		joined += fields[index].replace(/[^A-Za-z0-9_-]/g, '_');
	}
	const name = joined
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (/^[A-Za-z]/.test(name)) return name;
	return `${prefix}_${name || 'field'}`;
}

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`builder option "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`builder option "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function snapshotBuilderArray(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) throw new ActiveTsConfigurationError(`${context} must be an array.`);
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const items: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be a data property.`);
		}
		items.push(descriptor.value);
	}
	return items;
}

export function attachModelMeta(model: ModelConstructor, meta: ModelMeta) {
	applyModelMeta(model, meta);
}

export const modelMeta = {
	entity: setEntityMeta,
	id: setIdField,
	validate: setValidator,
	readValidation: setReadValidation,
	index: addIndexMeta,
	searchIndex: addSearchIndexMeta,
	relation: addRelationMeta,
	hooks: setHooksMeta,
	view: addViewMeta,
	policy: addPolicyMeta,
	scope: addScopeMeta,
	fieldCodec: addFieldCodecMeta,
	fieldType: addFieldTypeMeta
};
