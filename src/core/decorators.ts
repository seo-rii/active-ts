import {
	addIndexMeta,
	addFieldTypeMeta,
	addRelationMeta,
	addSearchIndexMeta,
	getModelMeta,
	sanitizeFieldType,
	setEntityMeta,
	setIdField
} from './metadata.js';
import {
	type EntityOptions,
	type FieldType,
	type IndexMeta,
	type ModelConstructor,
	type RelationMeta,
	type SearchIndexMeta
} from './types.js';
import {
	assertDenseArrayItems,
	assertSafeFieldPath,
	assertSafeSchemaIdentifier,
	assertSafeTopLevelField,
	defineGetterProperty
} from './safe-keys.js';
import { ActiveTsConfigurationError } from './errors.js';
import { assertGeneratedSchemaName, defaultSchemaName, markGeneratedSchemaName } from './schema-names.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function entity(options: EntityOptions): ClassDecorator {
	return (target) => setEntityMeta(target as unknown as ModelConstructor, options);
}

export function id(): PropertyDecorator {
	return (target, propertyKey) =>
		setIdField(
			target.constructor as ModelConstructor,
			assertSafeTopLevelField(propertyKey, 'id field')
		);
}

export function field(options: Partial<IndexMeta> = {}): PropertyDecorator {
	return (target, propertyKey) => {
		const optionRecord = normalizeDecoratorOptions(options, 'field options', ['fields', 'directions', 'unique', 'name']);
		const optionUnique = ownOptionValue(optionRecord, 'unique');
		const optionName = ownOptionValue(optionRecord, 'name');
		const optionFields = ownOptionValue(optionRecord, 'fields');
		const optionDirections = ownOptionValue(optionRecord, 'directions');
		if (optionUnique === undefined && optionName === undefined && optionFields === undefined && optionDirections === undefined) return;
		const propertyName = assertSafeFieldPath(propertyKey, 'index field');
		const indexMeta = decoratorIndexMeta(
			propertyName,
			optionFields === undefined ? [propertyName] : optionFields,
			'index fields',
			'index field',
			optionName,
			optionUnique,
			optionDirections
		);
		if (optionName === undefined) {
			assertGeneratedSchemaName('index', indexMeta.name, indexMeta.fields, getModelMeta(target.constructor as ModelConstructor).indexes);
			markGeneratedSchemaName(indexMeta);
		}
		addIndexMeta(target.constructor as ModelConstructor, indexMeta);
	};
}

export function typedField(type: FieldType, options: Partial<IndexMeta> = {}): PropertyDecorator {
	return (target, propertyKey) => {
		const fieldName = assertSafeFieldPath(propertyKey, 'typed field');
		const optionRecord = normalizeDecoratorOptions(options, 'typed field options', ['fields', 'directions', 'unique', 'name']);
		const safeType = sanitizeFieldType(type);
		const optionUnique = ownOptionValue(optionRecord, 'unique');
		const optionName = ownOptionValue(optionRecord, 'name');
		const optionFields = ownOptionValue(optionRecord, 'fields');
		const optionDirections = ownOptionValue(optionRecord, 'directions');
		const shouldIndex =
			optionUnique !== undefined ||
			optionName !== undefined ||
			optionFields !== undefined ||
			optionDirections !== undefined;
		const indexMeta = shouldIndex
			? decoratorIndexMeta(
					fieldName,
					optionFields === undefined ? [fieldName] : optionFields,
					'index fields',
					'index field',
					optionName,
					optionUnique,
					optionDirections
				)
			: undefined;
		if (indexMeta && optionName === undefined) {
			assertGeneratedSchemaName('index', indexMeta.name, indexMeta.fields, getModelMeta(target.constructor as ModelConstructor).indexes);
			markGeneratedSchemaName(indexMeta);
		}
		addFieldTypeMeta(target.constructor as ModelConstructor, fieldName, safeType);
		if (indexMeta) addIndexMeta(target.constructor as ModelConstructor, indexMeta);
	};
}

export function index(fields: string[], options: Partial<IndexMeta> = {}): ClassDecorator {
	return (target) => {
		const optionRecord = normalizeDecoratorOptions(options, 'index options', ['name', 'directions', 'unique']);
		const optionName = ownOptionValue(optionRecord, 'name');
		const optionDirections = ownOptionValue(optionRecord, 'directions');
		const optionUnique = ownOptionValue(optionRecord, 'unique');
		const safeFields = normalizeDecoratorFields(fields, 'index fields', 'index field');
		const directions = normalizeIndexDirections(optionDirections, safeFields.length, 'index directions');
		if (optionUnique !== undefined && typeof optionUnique !== 'boolean') {
			throw new ActiveTsConfigurationError('index unique must be a boolean.');
		}
		const name = optionName === undefined ? defaultSchemaName('index', safeFields) : assertSafeSchemaIdentifier(optionName, 'index name');
		if (optionName === undefined) {
			assertGeneratedSchemaName('index', name, safeFields, getModelMeta(target as unknown as ModelConstructor).indexes);
		}
		const indexMeta: IndexMeta = {
			name,
			fields: safeFields,
			...(directions === undefined ? {} : { directions }),
			unique: optionUnique as boolean | undefined
		};
		addIndexMeta(target as unknown as ModelConstructor, optionName === undefined ? markGeneratedSchemaName(indexMeta) : indexMeta);
	};
}

export function searchIndex(fields: string[], options: Partial<SearchIndexMeta> = {}): ClassDecorator {
	return (target) => {
		const optionRecord = normalizeDecoratorOptions(options, 'search index options', ['name', 'adapter']);
		const optionName = ownOptionValue(optionRecord, 'name');
		const adapter = ownOptionValue(optionRecord, 'adapter');
		const safeFields = normalizeDecoratorFields(fields, 'search fields', 'search field');
		const name = optionName === undefined ? defaultSchemaName('search', safeFields) : optionName as string;
		if (optionName === undefined) {
			assertGeneratedSchemaName('search index', name, safeFields, getModelMeta(target as unknown as ModelConstructor).searchIndexes, adapter as string | undefined);
		}
		const indexMeta: SearchIndexMeta = {
			name,
			adapter: adapter as string | undefined,
			fields: safeFields
		};
		addSearchIndexMeta(target as unknown as ModelConstructor, optionName === undefined ? markGeneratedSchemaName(indexMeta) : indexMeta);
	};
}

export function relation(
	targetModel: () => ModelConstructor,
	options: Omit<RelationMeta, 'name' | 'target'>
): PropertyDecorator {
	return (target, propertyKey) => {
		const name = assertSafeTopLevelField(propertyKey, 'relation name');
		const relationOptions = normalizeRelationOptions(options);
		if (typeof targetModel !== 'function') {
			throw new ActiveTsConfigurationError('relation target must be a function.');
		}
		defineGetterProperty(target, propertyKey, function (this: any) {
			return this.ref(name);
		}, { enumerable: false, configurable: true });
		addRelationMeta(target.constructor as ModelConstructor, {
			name,
			target: targetModel,
			...relationOptions
		});
	};
}

export function ref(
	targetModel: () => ModelConstructor,
	options: Omit<RelationMeta, 'name' | 'kind' | 'target'>
) {
	const relationOptions = normalizeDecoratorOptions(options, 'relation options', ['localKey', 'foreignKey', 'preload', 'warnOnLazy', 'ancestor']);
	return relation(targetModel, { kind: 'one', ...relationOptions } as Omit<RelationMeta, 'name' | 'target'>);
}

export function hasMany(
	targetModel: () => ModelConstructor,
	options: Omit<RelationMeta, 'name' | 'kind' | 'target'>
) {
	const relationOptions = normalizeDecoratorOptions(options, 'relation options', ['localKey', 'foreignKey', 'preload', 'warnOnLazy', 'ancestor']);
	return relation(targetModel, { kind: 'many', ...relationOptions } as Omit<RelationMeta, 'name' | 'target'>);
}

function normalizeDecoratorFields(fields: unknown, listContext: string, fieldContext: string) {
	if (!Array.isArray(fields) || !fields.length) {
		throw new ActiveTsConfigurationError(`${listContext} must be a non-empty array.`);
	}
	const values = snapshotDecoratorArray(fields, listContext);
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
	const values = snapshotDecoratorArray(directions, context);
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

function decoratorIndexMeta(
	defaultName: string,
	fields: unknown,
	listContext: string,
	fieldContext: string,
	name: unknown,
	unique: unknown,
	directions: unknown
): IndexMeta {
	if (unique !== undefined && typeof unique !== 'boolean') {
		throw new ActiveTsConfigurationError('index unique must be a boolean.');
	}
	const safeFields = normalizeDecoratorFields(fields, listContext, fieldContext);
	const safeDirections = normalizeIndexDirections(directions, safeFields.length, 'index directions');
	return {
		name: name === undefined ? defaultName : assertSafeSchemaIdentifier(name, 'index name'),
		fields: safeFields,
		...(safeDirections === undefined ? {} : { directions: safeDirections }),
		unique: unique as boolean | undefined
	};
}

function normalizeRelationPreload(preload: string[] | undefined) {
	if (preload === undefined) return undefined;
	const values = snapshotDecoratorArray(preload, 'relation preload');
	const normalized: string[] = [];
	for (let index = 0; index < values.length; index++) {
		normalized[index] = assertSafeFieldPath(values[index], 'relation preload');
	}
	return normalized;
}

function normalizeRelationOptions(options: Omit<RelationMeta, 'name' | 'target'>) {
	const record = normalizeDecoratorOptions(options, 'relation options', ['kind', 'localKey', 'foreignKey', 'preload', 'warnOnLazy', 'ancestor']);
	const kind = ownOptionValue(record, 'kind');
	const warnOnLazy = ownOptionValue(record, 'warnOnLazy');
	const ancestor = ownOptionValue(record, 'ancestor');
	if (kind !== 'one' && kind !== 'many') {
		const detail = typeof kind === 'string' ? ` "${kind}"` : '';
		throw new ActiveTsConfigurationError(`Relation kind${detail} is not allowed.`);
	}
	if (warnOnLazy !== undefined && typeof warnOnLazy !== 'boolean') {
		throw new ActiveTsConfigurationError('relation warnOnLazy must be a boolean.');
	}
	if (ancestor !== undefined && typeof ancestor !== 'function') {
		throw new ActiveTsConfigurationError('relation ancestor must be a function.');
	}
	return {
		kind: kind as RelationMeta['kind'],
		localKey: assertSafeFieldPath(ownOptionValue(record, 'localKey'), 'relation localKey'),
		foreignKey: assertSafeFieldPath(ownOptionValue(record, 'foreignKey'), 'relation foreignKey'),
		preload: normalizeRelationPreload(ownOptionValue(record, 'preload') as string[] | undefined),
		warnOnLazy: warnOnLazy as boolean | undefined,
		ancestor: ancestor as RelationMeta['ancestor']
	};
}

function normalizeDecoratorOptions(options: unknown, context: string, allowed: readonly string[]) {
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

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`decorator option "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`decorator option "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function snapshotDecoratorArray(value: unknown, context: string): unknown[] {
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
