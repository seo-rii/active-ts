import type { QueryResult, ResolvedModelMeta, SearchAdapter, SearchOptions } from '../../core/types.js';
import { assertSafeEntityId, assertSafeSchemaIdentifier, cloneSafeData, defineDataProperty } from '../../core/safe-keys.js';
import { snapshotSearchAdapterModel } from '../../core/adapter-model.js';
import { MAP_CLEAR, MAP_DELETE, MAP_ENTRIES, MAP_GET, MAP_SET, MAP_VALUES } from '../../core/collection-intrinsics.js';
import { normalizeWhereShapeFieldTypes } from '../../core/field-types.js';
import { filterRows, valueFor, whereShapeToPlan } from '../../core/query-utils.js';
import {
	assertSearchOptionsSupported,
	assertSafeSearchQuery,
	markProjectingSearchAdapter,
	normalizeSearchAdapterOptions,
	projectSearchDocument,
	rejectUnsupportedSearchOption,
	searchHitDocumentIdentity,
	markSearchDocumentIdentity,
	searchDocumentIdentity,
	searchFieldsForAdapter
} from '../../core/search-utils.js';

export class MemorySearchAdapter implements SearchAdapter {
	readonly kind = 'memory';
	readonly capabilities = {
		where: true,
		whereOperators: {
			'=': true,
			'!=': true,
			'>': true,
			'>=': true,
			'<': true,
			'<=': true,
			in: true,
			between: true,
			isNull: true,
			isNotNull: true,
			arrayContains: true,
			textContains: true,
			jsonContains: true,
			startsWith: true
		},
		nestedFields: true,
		numericComparisons: true,
		nullOperators: true,
		cursor: false,
		native: false,
		index: true
	};
	private readonly indexes = new Map<string, Map<string, any>>();
	readonly stats = {
		search: 0,
		index: 0,
		delete: 0
	};

	constructor() {
		markProjectingSearchAdapter(this);
	}

	async search(model: ResolvedModelMeta, query: string, options: SearchOptions = {}): Promise<QueryResult> {
		model = snapshotSearchAdapterModel(model, 'memory search model metadata', this.kind);
		options = normalizeSearchAdapterOptions(options, 'memory search options');
		rejectUnsupportedSearchOption(options.cursor, 'cursors', 'Memory search adapter');
		rejectUnsupportedSearchOption(options.native, 'native payloads', 'Memory search adapter');
		assertSearchOptionsSupported(this, options);
		options = { ...options, where: normalizeWhereShapeFieldTypes(model, options.where) };
		const q = assertSafeSearchQuery(query, 'memory search query').toLowerCase();
		this.stats.search++;
		const fields = searchFieldsForAdapter(model, this.kind);
		if (!fields.length) return { list: [], more: false, count: 0 };
		let list: any[] = [];
		for (const item of MAP_VALUES.call(this.existingCollectionIndex(model.name)) as Iterable<any>) {
			if (searchDocumentMatches(item, fields, q)) {
				list[list.length] = item;
			}
		}
		list = filterRows(list, whereShapeToPlan(options.where), model.idField);
		const total = list.length;
		const limited = options.limit === undefined ? list : limitSearchResults(list, options.limit);
		const results: any[] = [];
		for (let index = 0; index < limited.length; index++) {
			results[index] = markSearchDocumentIdentity(
				cloneSafeData(limited[index]),
				searchHitDocumentIdentity(limited[index])
			);
		}
		return {
			list: results,
			more: options.limit !== undefined && total > options.limit,
			count: limited.length,
			total
		};
	}

	async index(model: ResolvedModelMeta, id: string | number, data: any) {
		model = snapshotSearchAdapterModel(model, 'memory search model metadata', this.kind);
		const key = searchDocumentIdentity(model, id, `${model.name} search document id`, data, {
			trustDatastoreEntityKey: false
		});
		const document = projectSearchDocument(model, this.kind, id, data, {
			trustDatastoreEntityKey: false
		});
		this.stats.index++;
		MAP_SET.call(this.collectionIndex(model.name), key, document);
	}

	async delete(model: ResolvedModelMeta, id: string | number) {
		model = snapshotSearchAdapterModel(model, 'memory search model metadata', this.kind);
		assertSafeEntityId(id, `${model.name} search delete id`);
		this.stats.delete++;
		MAP_DELETE.call(
			this.existingCollectionIndex(model.name),
			searchDocumentIdentity(model, id, `${model.name} search delete id`)
		);
	}

	clear(modelName?: string) {
		if (modelName) MAP_DELETE.call(this.indexes, assertSafeSchemaIdentifier(modelName, 'memory search model name'));
		else MAP_CLEAR.call(this.indexes);
		this.resetStats();
	}

	snapshot(modelName: string): any[];
	snapshot(): Record<string, any[]>;
	snapshot(modelName?: string) {
		if (modelName) {
			const safeName = assertSafeSchemaIdentifier(modelName, 'memory search model name');
			const index = MAP_GET.call(this.indexes, safeName);
			return cloneSearchIndexValues(index);
		}
		const snapshot = {} as Record<string, any[]>;
		for (const [name, index] of MAP_ENTRIES.call(this.indexes) as Iterable<[string, Map<string, any>]>) {
			defineDataProperty(snapshot, name, cloneSearchIndexValues(index), {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
		return snapshot;
	}

	resetStats() {
		this.stats.search = 0;
		this.stats.index = 0;
		this.stats.delete = 0;
	}

	private collectionIndex(name: string) {
		const safeName = assertSafeSchemaIdentifier(name, 'memory search model name');
		let index = MAP_GET.call(this.indexes, safeName);
		if (!index) {
			index = new Map();
			MAP_SET.call(this.indexes, safeName, index);
		}
		return index;
	}

	private existingCollectionIndex(name: string) {
		const safeName = assertSafeSchemaIdentifier(name, 'memory search model name');
		return MAP_GET.call(this.indexes, safeName) ?? new Map<string, any>();
	}
}

function searchDocumentMatches(item: unknown, fields: readonly string[], query: string) {
	for (let index = 0; index < fields.length; index++) {
		const value = valueFor(item, fields[index]);
		if (searchValueContains(value, query)) return true;
	}
	return false;
}

function limitSearchResults<T>(items: readonly T[], limit: number) {
	const limited: T[] = [];
	const length = Math.min(items.length, limit);
	for (let index = 0; index < length; index++) {
		limited[index] = items[index];
	}
	return limited;
}

function cloneSearchIndexValues(index: Map<string, any> | undefined) {
	const values: any[] = [];
	if (!index) return values;
	let position = 0;
	for (const item of MAP_VALUES.call(index) as Iterable<any>) {
		values[position] = cloneSafeData(item);
		position++;
	}
	return values;
}

function searchValueContains(value: unknown, query: string) {
	if (typeof value === 'string') return value.toLowerCase().includes(query);
	if (!Array.isArray(value)) return false;
	for (let index = 0; index < value.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) continue;
		const item = value[index];
		if (typeof item === 'string' && item.toLowerCase().includes(query)) return true;
	}
	return false;
}
