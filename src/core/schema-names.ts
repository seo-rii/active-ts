import { ActiveTsConfigurationError } from './errors.js';
import type { IndexMeta, SearchIndexMeta } from './types.js';
import { WEAKSET_ADD, WEAKSET_HAS } from './collection-intrinsics.js';

const generatedSchemaNames = new WeakSet<object>();

export function markGeneratedSchemaName<T extends IndexMeta | SearchIndexMeta>(index: T): T {
	WEAKSET_ADD.call(generatedSchemaNames, index);
	return index;
}

export function copySchemaNameOrigin<T extends IndexMeta | SearchIndexMeta>(source: object, copy: T): T {
	if (WEAKSET_HAS.call(generatedSchemaNames, source)) markGeneratedSchemaName(copy);
	return copy;
}

export function assertSchemaNameOrigin(
	kind: 'index' | 'search index', index: IndexMeta | SearchIndexMeta, existing: readonly (IndexMeta | SearchIndexMeta)[]
) {
	if (WEAKSET_HAS.call(generatedSchemaNames, index)) {
		assertGeneratedSchemaName(kind, index.name, index.fields, existing, (index as SearchIndexMeta).adapter);
	}
}

export function defaultSchemaName(prefix: string, fields: string[]) {
	let joined = '';
	for (let index = 0; index < fields.length; index++) {
		if (index > 0) joined += '_';
		joined += fields[index].replace(/[^A-Za-z0-9_-]/g, '_');
	}
	const name = joined.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
	if (/^[A-Za-z]/.test(name)) return name;
	return `${prefix}_${name || 'field'}`;
}

export function assertGeneratedSchemaName(
	kind: 'index' | 'search index',
	name: string,
	fields: string[],
	existing: readonly (IndexMeta | SearchIndexMeta)[],
	adapter?: string
) {
	for (const index of existing) {
		if (index.name !== name) continue;
		if (kind === 'search index' && (index as SearchIndexMeta).adapter !== adapter) continue;
		let sameFields = index.fields.length === fields.length;
		for (let position = 0; sameFields && position < fields.length; position++) {
			if (index.fields[position] !== fields[position]) sameFields = false;
		}
		if (!sameFields) {
			throw new ActiveTsConfigurationError(
				`Generated ${kind} name "${name}" conflicts with different fields. Declare distinct explicit names for these indexes.`
			);
		}
	}
}
