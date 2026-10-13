import type { EntityId, QueryResult, ResolvedModelMeta, SchemaPlan, SearchAdapter, SearchOptions } from '../../core/types.js';
import { optionalImport } from '../../core/optional-import.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from '../../core/errors.js';
import { assertPlainDataObject, assertSafeCacheKey, assertSafeEntityId, assertSafeFieldPath, assertSafeSchemaIdentifier, cloneSafeData } from '../../core/safe-keys.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { snapshotSearchAdapterModel } from '../../core/adapter-model.js';
import { normalizeSchemaModels } from '../../core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../../core/schema-options.js';
import { cloneJsonTransportPayload } from '../../core/native-payload.js';
import { JSON_PARSE, JSON_STRINGIFY } from '../../core/json-intrinsics.js';
import { assertSafeSearchQuery, markProjectingSearchAdapter, markSearchDocumentIdentity, normalizeSearchAdapterOptions, normalizeSearchWriteOptions, projectSearchDocument, rejectUnsupportedSearchOption, searchDocumentIdentity, searchFieldsForAdapter, searchIndexesForAdapter, searchProjectionFieldsForAdapter } from '../../core/search-utils.js';

export type MeilisearchOptions = {
	client?: unknown;
	host?: string;
	apiKey?: string;
	indexPrefix?: string;
	/** Maximum time to wait for an accepted write task; timing out does not cancel it. */
	taskTimeoutMs?: number;
	taskIntervalMs?: number;
};

const PRIMARY_KEY = 'active_ts_id';
const RESERVED_FIELDS = new Set([PRIMARY_KEY, '_formatted', '_matchesPosition', '_rankingScore', '_rankingScoreDetails', '_geoDistance', '_geo', '_vectors', '_federation']);
const OWNED_SEARCH_PARAMS = new Set(['q', 'limit', 'offset', 'page', 'hitsPerPage', 'attributesToRetrieve', 'attributesToSearchOn']);
const OPTION_KEYS = new Set(['client', 'host', 'apiKey', 'indexPrefix', 'taskTimeoutMs', 'taskIntervalMs']);
const CAPABILITIES = Object.freeze({ where: false, cursor: true, native: true, index: true, revisionWrites: false });

function own(record: object, key: string, context: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined) return undefined;
	if (!('value' in descriptor) || !descriptor.enumerable) throw new ActiveTsValidationError(`${context}.${key} must be an enumerable data property.`);
	return descriptor.value;
}

function responseObject(value: unknown, context: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} must be a plain object without symbol fields.`);
	}
	for (const key of Object.getOwnPropertyNames(value)) own(value, key, context);
}

function method(receiver: unknown, name: string, context: string, nonEnumerableOwn = false): (...args: any[]) => any {
	if (!receiver || typeof receiver !== 'object' || Array.isArray(receiver)) throw new ActiveTsConfigurationError(`${context} must be an object.`);
	let current: object | null = receiver;
	while (current && current !== Object.prototype) {
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor) {
			if (!('value' in descriptor) || typeof descriptor.value !== 'function' ||
				(current === receiver && !descriptor.enumerable && !nonEnumerableOwn)) {
				throw new ActiveTsConfigurationError(`${context}.${name} must be a data method.`);
			}
			return descriptor.value.bind(receiver);
		}
		current = Object.getPrototypeOf(current);
	}
	throw new ActiveTsConfigurationError(`${context}.${name} must be a function.`);
}

function optionsSnapshot(input: MeilisearchOptions): MeilisearchOptions {
	try { responseObject(input, 'Meilisearch options'); }
	catch { throw new ActiveTsConfigurationError('Meilisearch options must be a plain object with enumerable data properties.'); }
	const options: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(input)) {
		if (!OPTION_KEYS.has(key)) throw new ActiveTsConfigurationError(`Meilisearch options contains unknown option "${key}".`);
		options[key] = own(input, key, 'Meilisearch options');
	}
	if (options.client !== undefined && (options.host !== undefined || options.apiKey !== undefined)) {
		throw new ActiveTsConfigurationError('Meilisearch client cannot be combined with host or apiKey.');
	}
	if (options.client === undefined) {
		if (typeof options.host !== 'string' || !options.host) throw new ActiveTsConfigurationError('Meilisearch host is required without a client.');
		let url: URL;
		try { url = new URL(options.host); } catch { throw new ActiveTsConfigurationError('Meilisearch host must be an HTTP(S) URL.'); }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
			throw new ActiveTsConfigurationError('Meilisearch host must be an HTTP(S) URL without credentials, query, or fragment.');
		}
	}
	if (options.apiKey !== undefined && (typeof options.apiKey !== 'string' || !options.apiKey || /[\0\r\n]/.test(options.apiKey))) {
		throw new ActiveTsConfigurationError('Meilisearch apiKey must be a non-empty string without NUL or line breaks.');
	}
	if (options.indexPrefix !== undefined && (typeof options.indexPrefix !== 'string' || !/^[A-Za-z0-9_-]*$/.test(options.indexPrefix))) {
		throw new ActiveTsConfigurationError('Meilisearch indexPrefix may only contain ASCII letters, digits, underscores, or hyphens.');
	}
	for (const key of ['taskTimeoutMs', 'taskIntervalMs']) {
		const value = options[key];
		if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) {
			throw new ActiveTsConfigurationError(`Meilisearch ${key} must be a positive safe timer interval.`);
		}
	}
	if (options.taskIntervalMs !== undefined && (options.taskIntervalMs as number) > ((options.taskTimeoutMs as number | undefined) ?? 5_000)) {
		throw new ActiveTsConfigurationError('Meilisearch taskIntervalMs cannot exceed taskTimeoutMs.');
	}
	return options as MeilisearchOptions;
}

function projectionField(field: unknown) {
	const safe = assertSafeFieldPath(field, 'Meilisearch projection field');
	if (RESERVED_FIELDS.has(safe.split('.')[0])) throw new ActiveTsValidationError(`Meilisearch projection field "${safe}" is reserved.`);
	return safe;
}

function projection(model: ResolvedModelMeta) {
	projectionField(model.idField);
	const fields = searchFieldsForAdapter(model, 'meilisearch').map(projectionField);
	const projected = searchProjectionFieldsForAdapter(model, 'meilisearch').map(projectionField);
	return { fields, retrieve: [...new Set([PRIMARY_KEY, model.idField, ...projected])] };
}

function documentId(model: ResolvedModelMeta, identity: string) {
	// JSON escapes lone UTF-16 surrogates before UTF-8 encoding, retaining distinct string IDs.
	const encoded = Buffer.from(JSON_STRINGIFY([model.name, assertSafeCacheKey(identity, 'Meilisearch document identity')]), 'utf8').toString('base64url');
	if (encoded.length > 511) throw new ActiveTsValidationError('Meilisearch encoded document id exceeds 511 bytes.');
	return encoded;
}

function hitIdentity(value: unknown, model: ResolvedModelMeta): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 511) {
		throw new ActiveTsValidationError('Meilisearch hit must include a valid active_ts_id.');
	}
	let decoded: unknown;
	try { decoded = JSON_PARSE(Buffer.from(value, 'base64url').toString('utf8')); }
	catch { throw new ActiveTsValidationError('Meilisearch hit active_ts_id is not a canonical identity.'); }
	if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== model.name || typeof decoded[1] !== 'string' || documentId(model, decoded[1]) !== value) {
		throw new ActiveTsValidationError('Meilisearch hit active_ts_id does not match the model and canonical identity.');
	}
	return decoded[1];
}

function hitDocument(hit: unknown, model: ResolvedModelMeta) {
	responseObject(hit, 'Meilisearch hit');
	const identity = hitIdentity(own(hit, PRIMARY_KEY, 'Meilisearch hit'), model);
	const logicalId = own(hit, model.idField, 'Meilisearch hit');
	assertSafeEntityId(logicalId, `Meilisearch hit ${model.idField}`);
	const clean = cloneSafeData(hit);
	for (const key of RESERVED_FIELDS) delete clean[key];
	const expected = searchDocumentIdentity(model, logicalId, 'Meilisearch hit identity', clean, { trustDatastoreEntityKey: false });
	if (expected !== identity) throw new ActiveTsValidationError('Meilisearch hit identity does not match its logical id or ancestor fields.');
	return markSearchDocumentIdentity(projectSearchDocument(model, 'meilisearch', logicalId, clean, { trustDatastoreEntityKey: false }), identity);
}

function unsigned(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ActiveTsValidationError(`${context} must be a non-negative safe integer.`);
	return value;
}

function pageFromCursor(cursor: string | undefined) {
	if (cursor === undefined) return 1;
	if (!/^[1-9][0-9]*$/.test(cursor)) throw new ActiveTsValidationError('Meilisearch cursor must be a positive decimal page number.');
	return unsigned(Number(cursor), 'Meilisearch cursor');
}

function nativeOptions(value: unknown) {
	if (value === undefined) return {};
	assertPlainDataObject(value, 'Meilisearch native payload');
	for (const key of Object.getOwnPropertyNames(value)) {
		if (OWNED_SEARCH_PARAMS.has(key)) throw new ActiveTsConfigurationError(`Meilisearch native parameter "${key}" conflicts with active-ts query, projection, or pagination.`);
	}
	return value;
}

/** The configured indexes must already exist with primaryKey: "active_ts_id". */
export async function createMeilisearchSearchAdapter(input: MeilisearchOptions = {}): Promise<SearchAdapter> {
	const options = optionsSnapshot(input);
	const sdk = options.client === undefined ? await optionalImport('meilisearch', 'MeilisearchSearchAdapter') : undefined;
	const rawClient = options.client === undefined
		? new sdk!.Meilisearch({ host: options.host, ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }) })
		: options.client;
	const getIndex = method(rawClient, 'index', 'Meilisearch client');
	const getRawIndex = method(rawClient, 'getRawIndex', 'Meilisearch client');
	const indexName = (model: ResolvedModelMeta) => {
		const name = `${options.indexPrefix ?? ''}${assertSafeSchemaIdentifier(model.name, 'Meilisearch model name')}`;
		if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ActiveTsValidationError('Meilisearch index names must contain only ASCII letters, digits, underscores, or hyphens.');
		return name;
	};
	const indexMethods = (name: string) => {
		const index = getIndex(name);
		return { search: method(index, 'search', 'Meilisearch index'), addDocuments: method(index, 'addDocuments', 'Meilisearch index'), deleteDocument: method(index, 'deleteDocument', 'Meilisearch index') };
	};
	const assertPrimaryKey = async (name: string) => {
		const info = await getRawIndex(name);
		responseObject(info, 'Meilisearch index metadata');
		if (own(info, 'uid', 'Meilisearch index metadata') !== name || own(info, 'primaryKey', 'Meilisearch index metadata') !== PRIMARY_KEY) {
			throw new ActiveTsConfigurationError(`Meilisearch index "${name}" must already exist with primaryKey "${PRIMARY_KEY}".`);
		}
	};
	const finishWrite = async (pending: unknown, name: string) => {
		const queued = await pending;
		responseObject(queued, 'Meilisearch enqueued task');
		const uid = unsigned(own(queued, 'taskUid', 'Meilisearch enqueued task'), 'Meilisearch taskUid');
		const queuedIndex = own(queued, 'indexUid', 'Meilisearch enqueued task');
		if (queuedIndex !== null && queuedIndex !== name) throw new ActiveTsValidationError('Meilisearch enqueued task indexUid does not match the requested index.');
		// SDK 0.62 attaches this own, non-enumerable data method to the returned Promise.
		const wait = method(pending, 'waitTask', 'Meilisearch enqueued task promise', true);
		const timeout = options.taskTimeoutMs ?? 5_000;
		const task = await wait({ timeout, interval: options.taskIntervalMs ?? Math.min(50, timeout) });
		responseObject(task, 'Meilisearch completed task');
		if (own(task, 'uid', 'Meilisearch completed task') !== uid || own(task, 'indexUid', 'Meilisearch completed task') !== name) {
			throw new ActiveTsValidationError('Meilisearch completed task identity does not match the submitted write.');
		}
		const status = own(task, 'status', 'Meilisearch completed task');
		const error = own(task, 'error', 'Meilisearch completed task');
		if (status !== 'succeeded' || (error !== null && error !== undefined)) {
			let code = '';
			if (error !== null && error !== undefined) {
				responseObject(error, 'Meilisearch task error');
				const value = own(error, 'code', 'Meilisearch task error');
				if (typeof value === 'string' && /^[a-z_]{1,100}$/.test(value)) code = `, code: ${value}`;
			}
			throw new ActiveTsValidationError(`Meilisearch task ${uid} did not succeed (status: ${typeof status === 'string' ? status : 'invalid'}${code}).`);
		}
	};
	const schemaPlan = async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => {
		models = normalizeSchemaModels(models, 'Meilisearch schema models');
		const changes: SchemaPlan['changes'] = [];
		for (const model of models) {
			indexName(model); projectionField(model.idField);
			for (const index of searchIndexesForAdapter(model, 'meilisearch')) {
				changes.push({ type: 'create-search-index', target: model.name, name: index.name, fields: index.fields.map(projectionField) });
			}
		}
		return { adapter: 'meilisearch', status: 'manual', changes,
			note: 'Create indexes with primaryKey active_ts_id using Meilisearch tooling. Configure searchableAttributes from declared search fields and displayedAttributes with active_ts_id, the model id, and projection fields. Review filterable/sortable attributes separately; wait for every settings task to succeed.' };
	};
	return markProjectingSearchAdapter({
		kind: 'meilisearch', capabilities: CAPABILITIES,
		async search(model, query: string, searchOptions: SearchOptions = {}): Promise<QueryResult> {
			model = snapshotSearchAdapterModel(model, 'Meilisearch model metadata', 'meilisearch');
			searchOptions = normalizeSearchAdapterOptions(searchOptions, 'Meilisearch search options');
			rejectUnsupportedSearchOption(searchOptions.where, 'where filters', 'Meilisearch search adapter');
			const safeQuery = assertSafeSearchQuery(query, 'Meilisearch search query');
			const { fields, retrieve } = projection(model);
			const native = nativeOptions(searchOptions.native);
			const page = pageFromCursor(searchOptions.cursor);
			const hitsPerPage = searchOptions.limit ?? 20;
			const name = indexName(model);
			const request = cloneJsonTransportPayload({ ...native, page, hitsPerPage,
				...(fields.length ? { attributesToSearchOn: fields } : {}), attributesToRetrieve: retrieve }, 'Meilisearch search request');
			if (!fields.length && searchOptions.native === undefined) return { list: [], more: false, count: 0 };
			const index = indexMethods(name);
			await assertPrimaryKey(name);
			const response = await index.search(safeQuery, request);
			responseObject(response, 'Meilisearch search response');
			const responsePage = unsigned(own(response, 'page', 'Meilisearch search response'), 'Meilisearch response page');
			const responseLimit = unsigned(own(response, 'hitsPerPage', 'Meilisearch search response'), 'Meilisearch response hitsPerPage');
			const totalPages = unsigned(own(response, 'totalPages', 'Meilisearch search response'), 'Meilisearch response totalPages');
			if (responsePage !== page || responseLimit !== hitsPerPage) throw new ActiveTsValidationError('Meilisearch pagination response does not match the requested page and limit.');
			const hits = snapshotArrayInput<unknown>(own(response, 'hits', 'Meilisearch search response'), 'Meilisearch search hits');
			if (hits.length > hitsPerPage || (hits.length && (totalPages === 0 || page > totalPages))) {
				throw new ActiveTsValidationError('Meilisearch search hits disagree with pagination metadata.');
			}
			const identities = new Set<string>();
			const list = hits.map((hit) => {
				const document = hitDocument(hit, model);
				const key = own(hit as object, PRIMARY_KEY, 'Meilisearch hit') as string;
				if (identities.has(key)) throw new ActiveTsValidationError('Meilisearch returned a duplicate document identity.');
				identities.add(key);
				return document;
			});
			const more = hitsPerPage > 0 && page < totalPages;
			if (more && !list.length) throw new ActiveTsValidationError('Meilisearch returned an empty page before its final page.');
			// estimatedTotalHits is approximate; even page-mode totals are bounded by maxTotalHits.
			return { list, count: list.length, more, ...(more ? { cursor: String(page + 1) } : {}) };
		},
		async index(model, id: EntityId, data: unknown, writeOptions = {}) {
			model = snapshotSearchAdapterModel(model, 'Meilisearch model metadata', 'meilisearch');
			writeOptions = normalizeSearchWriteOptions(writeOptions, 'Meilisearch index options');
			rejectUnsupportedSearchOption(writeOptions.revision, 'revision-ordered writes', 'Meilisearch search adapter');
			projection(model);
			const identity = searchDocumentIdentity(model, id, 'Meilisearch document id', data, { trustDatastoreEntityKey: false });
			const documents = cloneJsonTransportPayload([{ ...projectSearchDocument(model, 'meilisearch', id, data, { trustDatastoreEntityKey: false }),
				[PRIMARY_KEY]: documentId(model, identity) }], 'Meilisearch index request');
			const name = indexName(model); const index = indexMethods(name);
			await assertPrimaryKey(name);
			await finishWrite(index.addDocuments(documents, { primaryKey: PRIMARY_KEY }), name);
		},
		async delete(model, id: EntityId, writeOptions = {}) {
			model = snapshotSearchAdapterModel(model, 'Meilisearch model metadata', 'meilisearch');
			writeOptions = normalizeSearchWriteOptions(writeOptions, 'Meilisearch delete options');
			rejectUnsupportedSearchOption(writeOptions.revision, 'revision-ordered writes', 'Meilisearch search adapter');
			projection(model); assertSafeEntityId(id, 'Meilisearch delete id');
			const key = documentId(model, searchDocumentIdentity(model, id, 'Meilisearch delete id'));
			const name = indexName(model); const index = indexMethods(name);
			await assertPrimaryKey(name);
			await finishWrite(index.deleteDocument(key), name);
		},
		schema: { plan: schemaPlan, apply: async (models, applyOptions) => {
			normalizeStoreSchemaApplyOptions(applyOptions, 'Meilisearch schema apply options');
			return schemaPlan(models);
		} },
		syncSchema: schemaPlan
	});
}
