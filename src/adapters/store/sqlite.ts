import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AggregatePlan, QueryPlan, ResolvedModelMeta, SchemaPlan, StoreAdapter, StoreCapabilities } from '../../core/types.js';
import { ActiveTsConfigurationError, ActiveTsConflictError, ActiveTsNotFoundError, ActiveTsUnknownTransactionOutcomeError, ActiveTsValidationError } from '../../core/errors.js';
import { confirmTransactionRollback, markSavepointRollbackUnconfirmed, markTransactionRollbackSkipped, ownErrorValue } from '../../core/error-classification.js';
import { assertSafeEntityId, assertSafeEntityIdArray, assertSafeFieldPath, assertSafeSchemaIdentifier, clonePortableDataObject, defineDataProperty } from '../../core/safe-keys.js';
import { snapshotAdapterModel } from '../../core/adapter-model.js';
import { normalizeSchemaModels } from '../../core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../../core/schema-options.js';
import { assertAggregateSpecsCompatibleWithModel, normalizeAggregateRow } from '../../core/aggregate.js';
import { assertStoreDataMatchesId, assertStorePlanSupported, createCloseGuardedStoreAdapter, normalizeStoreAggregatePlan, normalizeStoreQueryPlan, normalizeStoreTransactionOptions, normalizeStoreWriteOptions, rejectUnsupportedStoreReadOptions, rejectUnsupportedStoreWriteMetadata, rejectUnsupportedStoreWriteOptions, validateStoreQueryReadOptions } from '../../core/store-options.js';
import { normalizeAggregatePlanFieldTypes, normalizeQueryPlanFieldTypes } from '../../core/field-types.js';
import { assertNoAggregateFieldCodecSpecs, encodeAggregatePlanFieldCodecs, encodeQueryPlanFieldCodecs } from '../../core/field-codecs.js';
import { entityIdFromCanonicalKey, entityIdKey, limitWithLookahead, pickFields, trimLookaheadRows, valueFor } from '../../core/query-utils.js';
import { sortWithStableId } from '../../core/cursor.js';
import { MAP_GET } from '../../core/collection-intrinsics.js';
import { JSON_PARSE, JSON_STRINGIFY } from '../../core/json-intrinsics.js';

export type SqliteStoreOptions = {
	filename?: string;
	database?: DatabaseSync;
	cacheScope?: string;
};

export type SqliteStoreAdapter = StoreAdapter & { close(): Promise<void> };

type ConnectionState = {
	tail: Promise<void>;
	scope: AsyncLocalStorage<object>;
	cacheScope: string;
	unavailable?: string;
};
const connections = new WeakMap<DatabaseSync, ConnectionState>();
const capabilities: Readonly<StoreCapabilities> = Object.freeze({
	or: true, contains: false, arrayContains: false, textContains: false, jsonContains: false,
	startsWith: true, cursor: false, offset: true, select: true, nestedFields: true,
	numericComparisons: true, aggregate: true, transaction: true, transactionConflictDetection: false,
	savepoint: false, uniqueIndex: true, optimisticLock: true, nullOperators: true,
	missingFieldNulls: true, native: false, datastoreAncestor: false, datastoreReadPolicy: false
});

function normalizeOptions(options: SqliteStoreOptions): SqliteStoreOptions {
	if (!options || typeof options !== 'object' || Array.isArray(options) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.getOwnPropertySymbols(options).length) {
		throw new ActiveTsConfigurationError('SQLite options must be a plain object without symbol fields.');
	}
	const result: SqliteStoreOptions = {};
	for (const key of Object.getOwnPropertyNames(options)) {
		if (key !== 'filename' && key !== 'database' && key !== 'cacheScope') {
			throw new ActiveTsConfigurationError(`SQLite options contains unknown option "${key}".`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(options, key)!;
		if (!('value' in descriptor) || !descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`SQLite options.${key} must be an enumerable data property.`);
		}
		defineDataProperty(result, key, descriptor.value, { enumerable: true, writable: true, configurable: true });
	}
	for (const key of ['filename', 'cacheScope'] as const) {
		if (result[key] !== undefined && (typeof result[key] !== 'string' || !result[key] || result[key]!.includes('\0'))) {
			throw new ActiveTsConfigurationError(`SQLite options.${key} must be a non-empty string without NUL.`);
		}
	}
	if (result.database !== undefined && result.filename !== undefined) {
		throw new ActiveTsConfigurationError('SQLite options.filename and options.database are mutually exclusive.');
	}
	return result;
}

function quote(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function table(model: ResolvedModelMeta) {
	const name = assertSafeSchemaIdentifier(model.name, 'SQLite table');
	if (/^sqlite_/i.test(name)) throw new ActiveTsConfigurationError('SQLite table names cannot start with sqlite_.');
	return quote(name);
}
function tableDefinition(model: ResolvedModelMeta) {
	return `CREATE TABLE ${table(model)} (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT`;
}

// Use SQL literals only after escaping; values never enter SQL source text.
function fieldSql(field: string) {
	assertSafeFieldPath(field, 'SQLite JSON field');
	const segments = field.split('.');
	for (const segment of segments) {
		if (/["\\\u0000-\u001f]/.test(segment) || /^(?:0|[1-9][0-9]*)$/.test(segment)) {
			throw new ActiveTsConfigurationError('SQLite field paths do not support numeric, quote, backslash, or control-character segments.');
		}
	}
	const path = literal('$' + segments.map((segment) => `.${JSON_STRINGIFY(segment)}`).join(''));
	return { type: `json_type(data, ${path})`, value: `json_extract(data, ${path})`, jsonValue: `data -> ${path}` };
}

function scalarCondition(field: ReturnType<typeof fieldSql>, value: unknown, params: SQLInputValue[], operator = '=') {
	if (value === null && operator === '=') return `${field.type} = 'null'`;
	let kind: string;
	let bound: SQLInputValue;
	if (typeof value === 'number' && Number.isFinite(value)) {
		kind = `${field.type} in ('integer', 'real')`; bound = value;
	} else if (typeof value === 'string') {
		kind = `${field.type} = 'text'`; bound = sqliteStringOrderKey(value);
	} else if (typeof value === 'boolean') {
		kind = `${field.type} = '${value ? 'true' : 'false'}'`; bound = Number(value);
	} else {
		throw new ActiveTsValidationError('SQLite predicates require portable scalar operands.');
	}
	params.push(bound);
	const comparable = typeof value === 'string' ? `active_ts_string_order_key(${field.jsonValue})` : field.value;
	return `(${kind} and ${comparable} ${operator} ?)`;
}

// SQLite compares BLOB bytes in order; big-endian UTF-16 preserves the exact
// JavaScript code-unit order, including supplementary characters and prefixes.
function sqliteStringOrderKey(value: unknown): Buffer | null {
	// SQL may evaluate an operand before its adjacent type guard.
	if (typeof value !== 'string') return null;
	return Buffer.from(value, 'utf16le').swap16();
}

// node:sqlite passes TEXT function arguments through a NUL-terminated API.
// Raw JSON text preserves escaped NULs and lone surrogates until after that boundary.
function sqliteJsonStringOrderKey(value: unknown): Buffer | null {
	return typeof value === 'string' ? sqliteStringOrderKey(JSON_PARSE(value)) : null;
}

function sqliteSortRank(type: unknown) {
	if (type === null || type === 'null') return 0;
	if (type === 'false' || type === 'true') return 1;
	if (type === 'integer' || type === 'real') return 2;
	if (type === 'text') return 3;
	throw new ActiveTsValidationError('SQLite sort values must be scalar, null, or missing.');
}

function whereSql(plan: Pick<QueryPlan, 'where' | 'or'>, params: SQLInputValue[]): string {
	const and = plan.where.map((where) => {
		const field = fieldSql(where.field);
		switch (where.op) {
			case '=': return `coalesce(${scalarCondition(field, where.value, params)}, 0)`;
			case '!=': return `(${field.type} is not null and not coalesce(${scalarCondition(field, where.value, params)}, 0))`;
			case '>': case '>=': case '<': case '<=': return scalarCondition(field, where.value, params, where.op);
			case 'between': return `(${scalarCondition(field, where.value, params, '>=')} and ${scalarCondition(field, where.value2, params, '<=')})`;
			case 'in': {
				const values = where.value as unknown[];
				return values.length ? `(${values.map((value) => scalarCondition(field, value, params)).join(' or ')})` : '0';
			}
			case 'isNull': return `(${field.type} is null or ${field.type} = 'null')`;
			case 'isNotNull': return `(${field.type} is not null and ${field.type} != 'null')`;
			case 'startsWith':
				params.push(where.value as string);
				return `(${field.type} = 'text' and instr(${field.value}, ?) = 1)`;
			default: throw new ActiveTsConfigurationError(`SQLite does not support query operator "${where.op}".`);
		}
	});
	// An empty root is only a disjunction container, not an always-true alternative.
	const alternatives = and.length ? [`(${and.join(' and ')})`] : [];
	for (const child of plan.or) alternatives.push(`(${whereSql(child, params)})`);
	return alternatives.length ? alternatives.join(' or ') : '1';
}

function indexDefinition(model: ResolvedModelMeta, index: ResolvedModelMeta['indexes'][number]) {
	const name = `active_ts_${createHash('sha256').update(JSON_STRINGIFY([model.name, index.name])).digest('hex').slice(0, 32)}`;
	const keys: string[] = [];
	for (let i = 0; i < index.fields.length; i++) {
		const field = fieldSql(index.fields[i]);
		const direction = index.directions?.[i] === 'desc' ? ' desc' : ' asc';
		keys.push(`(case ${field.type} when 'integer' then 'number' when 'real' then 'number' else ${field.type} end)${direction}`);
		keys.push(`coalesce(${field.value}, 'null')${direction}`);
	}
	return { name, sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(name)} ON ${table(model)} (${keys.join(', ')})` };
}

function sqliteError(error: unknown): unknown {
	const code = ownErrorValue(error, 'errcode');
	if (code === 1555 || code === 2067) return new ActiveTsConflictError('SQLite primary key or unique index conflict.');
	if (typeof code === 'number' && ((code & 255) === 5 || (code & 255) === 6)) {
		return new ActiveTsConflictError('SQLite database is busy or locked.');
	}
	return error;
}

function rowData(row: Record<string, unknown> | undefined, model: ResolvedModelMeta) {
	if (row === undefined) return null;
	if (typeof row.id !== 'string' || typeof row.data !== 'string') {
		throw new ActiveTsValidationError('SQLite returned an invalid stored row.');
	}
	let parsed: unknown;
	try { parsed = JSON_PARSE(row.data); }
	catch { throw new ActiveTsValidationError('SQLite stored data must be valid JSON.'); }
	const data = clonePortableDataObject(parsed, 'SQLite stored data');
	assertStoreDataMatchesId(model, entityIdFromCanonicalKey(row.id, 'SQLite stored id'), data);
	return data;
}

/** Requires Node.js 22.13+; node:sqlite is imported only when the factory is called. */
export async function createSqliteStoreAdapter(input: SqliteStoreOptions = {}): Promise<SqliteStoreAdapter> {
	const options = normalizeOptions(input);
	const { DatabaseSync } = await import('node:sqlite');
	if (options.database !== undefined && !(options.database instanceof DatabaseSync)) {
		throw new ActiveTsConfigurationError('SQLite options.database must be a node:sqlite DatabaseSync.');
	}
	const owned = options.database === undefined;
	const database = options.database ?? new DatabaseSync(options.filename ?? ':memory:');
	// Bind the genuine native methods, rather than executing caller-provided own getters/methods.
	const exec = (sql: string) => DatabaseSync.prototype.exec.call(database, sql);
	const prepare = (sql: string) => DatabaseSync.prototype.prepare.call(database, sql);
	try { prepare('select 1').get(); }
	catch {
		if (owned) DatabaseSync.prototype.close.call(database);
		throw new ActiveTsConfigurationError('SQLite options.database must be an open node:sqlite DatabaseSync.');
	}
	Reflect.apply(DatabaseSync.prototype.function, database, ['active_ts_sort_rank', { deterministic: true }, sqliteSortRank]);
	Reflect.apply(DatabaseSync.prototype.function, database, ['active_ts_string_order_key', { deterministic: true }, sqliteJsonStringOrderKey]);
	let state = connections.get(database);
	if (!state) {
		let scope = `sqlite:connection:${randomUUID()}`;
		if (owned && options.filename && options.filename !== ':memory:') {
			try {
				const file = await stat(options.filename, { bigint: true });
				scope = `sqlite:file:${JSON_STRINGIFY([hostname(), String(file.dev), String(file.ino)])}`;
			} catch (error) {
				DatabaseSync.prototype.close.call(database);
				throw error;
			}
		}
		state = { tail: Promise.resolve(), scope: new AsyncLocalStorage(), cacheScope: scope };
		connections.set(database, state);
	}
	const connection = state;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const assertAvailable = () => {
		if (connection.unavailable) throw new ActiveTsConfigurationError(`SQLite connection is unavailable after ${connection.unavailable}.`);
	};
	const enqueue = <T>(run: () => T | Promise<T>): Promise<T> => {
		if (closed) return Promise.reject(new ActiveTsConfigurationError('SQLite adapter is closed.'));
		if (connection.scope.getStore()) {
			return Promise.reject(new ActiveTsConfigurationError('Use the scoped SQLite transaction adapter inside its callback, not a root adapter sharing its connection.'));
		}
		const execution = connection.tail.then(async () => {
			assertAvailable();
			try { return await run(); } catch (error) { throw sqliteError(error); }
		});
		connection.tail = execution.then(() => {}, () => {});
		return execution;
	};
	const all = (sql: string, params: SQLInputValue[] = []) => prepare(sql).all(...params);
	const get = (sql: string, params: SQLInputValue[] = []) => prepare(sql).get(...params);
	const run = (sql: string, params: SQLInputValue[] = []) => prepare(sql).run(...params);
	const rollback = (cause: unknown, callback?: object): never => {
		try { exec('ROLLBACK'); }
		catch (rollbackError) {
			connection.unavailable = 'an unconfirmed rollback';
			throw markTransactionRollbackSkipped(new ActiveTsUnknownTransactionOutcomeError(
				'SQLite rollback failed; the connection cannot be reused.', 'abort',
				new AggregateError([cause, rollbackError], 'SQLite operation and rollback failed.')
			));
		}
		if (callback) confirmTransactionRollback(callback);
		throw cause;
	};

	function planSchema(models: ResolvedModelMeta[]): SchemaPlan {
		const changes: SchemaPlan['changes'] = [];
		const names = new Set<string>();
		for (const model of models) {
			table(model);
			const normalizedName = model.name.toLowerCase();
			if (names.has(normalizedName)) throw new ActiveTsConfigurationError('SQLite schema contains duplicate case-insensitive table names.');
			names.add(normalizedName);
			const existing = get('select type, name, sql from sqlite_schema where name = ? collate nocase', [model.name]);
			if (existing === undefined) changes.push({ type: 'create-collection', target: model.name });
			else {
				const columns = all(`PRAGMA table_info(${table(model)})`);
				if (existing.type !== 'table' || existing.name !== model.name || existing.sql !== tableDefinition(model) || columns.length !== 2 ||
					columns[0].name !== 'id' || columns[0].type !== 'TEXT' || columns[0].pk !== 1 || columns[0].notnull !== 1 ||
					columns[1].name !== 'data' || columns[1].type !== 'TEXT' || columns[1].notnull !== 1 || columns[1].pk !== 0) {
					throw new ActiveTsConfigurationError(`SQLite existing table "${model.name}" is incompatible with the id/data layout.`);
				}
			}
			for (const index of model.indexes) {
				const physical = indexDefinition(model, index);
				const found = get('select type, tbl_name, sql from sqlite_schema where name = ? collate nocase', [physical.name]);
				if (found === undefined) {
					changes.push({ type: 'create-index', target: model.name, name: index.name, fields: [...index.fields],
						...(index.directions ? { directions: [...index.directions] } : {}), ...(index.unique !== undefined ? { unique: index.unique } : {}) });
				} else if (found.type !== 'index' || found.tbl_name !== model.name || found.sql !== physical.sql) {
					throw new ActiveTsConfigurationError(`SQLite existing index "${physical.name}" has an incompatible owner or definition.`);
				}
			}
		}
		return { adapter: 'sqlite', changes };
	}

	function makeAdapter(scoped: boolean, readOnly = false): StoreAdapter {
		const execute = <T>(work: () => T): Promise<T> => scoped
			? Promise.resolve().then(() => { assertAvailable(); try { return work(); } catch (error) { throw sqliteError(error); } })
			: enqueue(work);
		const writable = () => { if (readOnly) throw new ActiveTsConfigurationError('SQLite read-only transactions cannot write.'); };
		const cleanData = (model: ResolvedModelMeta, id: Parameters<StoreAdapter['create']>[1], data: unknown) => {
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			for (const index of model.indexes) {
				if (!index.unique) continue;
				for (const field of index.fields) {
					fieldSql(field);
					const value = valueFor(clean, field);
					if (value !== null && typeof value === 'object') throw new ActiveTsValidationError('SQLite unique indexes require scalar field values.');
				}
			}
			return JSON_STRINGIFY(clean);
		};
		const adapter: StoreAdapter = {
			kind: 'sqlite', cacheScope: options.cacheScope ?? connection.cacheScope,
			capabilities: scoped ? Object.freeze({ ...capabilities, transaction: false, savepoint: true }) : capabilities,
			async get(model, id, readOptions) {
				model = snapshotAdapterModel(model, 'SQLite model metadata');
				assertSafeEntityId(id, 'SQLite store id');
				rejectUnsupportedStoreReadOptions(readOptions, 'SQLite get options');
				const sql = `select id, data from ${table(model)} where id = ?`;
				return execute(() => rowData(get(sql, [entityIdKey(id)]), model));
			},
			async getMany(model, ids, readOptions) {
				model = snapshotAdapterModel(model, 'SQLite model metadata');
				ids = assertSafeEntityIdArray(ids, 'SQLite getMany ids');
				rejectUnsupportedStoreReadOptions(readOptions, 'SQLite getMany options');
				const sql = `select id, data from ${table(model)} where id = ?`;
				return execute(() => {
					const statement = prepare(sql);
					return ids.map((id) => rowData(statement.get(entityIdKey(id)), model));
				});
			},
			async query(model, plan, readOptions) {
				model = snapshotAdapterModel(model, 'SQLite model metadata');
				plan = normalizeStoreQueryPlan(plan, model.idField, 'SQLite query plan');
				plan = encodeQueryPlanFieldCodecs(model, normalizeQueryPlanFieldTypes(model, plan));
				assertStorePlanSupported('sqlite', capabilities, plan);
				validateStoreQueryReadOptions(readOptions, plan, 'SQLite query options');
				const params: SQLInputValue[] = [];
				const where = whereSql(plan, params);
				const order = sortWithStableId(plan, model.idField).map((sort) => {
					const field = fieldSql(sort.field);
					const direction = sort.direction === 'desc' ? 'desc' : 'asc';
					const value = `case when ${field.type} = 'text' then active_ts_string_order_key(${field.jsonValue}) else ${field.value} end`;
					return `active_ts_sort_rank(${field.type}) ${direction}, (${value}) ${direction}`;
				}).join(', ');
				for (const field of plan.select ?? []) fieldSql(field);
				const limit = limitWithLookahead(plan.limit, 'SQLite limit');
				const sql = `select id, data from ${table(model)} where ${where} order by ${order} limit ? offset ?`;
				params.push(limit ?? -1, plan.offset ?? 0);
				return execute(() => {
					const { rows, more } = trimLookaheadRows(all(sql, params).map((row) => rowData(row, model)), plan.limit, 'SQLite limit');
					const select = plan.select;
					const list = select ? rows.map((row) => pickFields(row, select, model.idField)) : rows;
					return { list, count: list.length, more };
				});
			},
			async aggregate(model, plan: AggregatePlan) {
				model = snapshotAdapterModel(model, 'SQLite model metadata');
				plan = encodeAggregatePlanFieldCodecs(model, normalizeAggregatePlanFieldTypes(model, normalizeStoreAggregatePlan(plan, 'SQLite aggregate plan')));
				assertStorePlanSupported('sqlite', capabilities, plan);
				const specs = assertAggregateSpecsCompatibleWithModel(model, plan.aggregates, 'SQLite aggregate');
				assertNoAggregateFieldCodecSpecs(model, specs, 'SQLite aggregate');
				const columns: string[] = [];
				const hasAverage = specs.some((spec) => spec.op === 'avg');
				for (let i = 0; i < specs.length; i++) {
					const spec = specs[i];
					if (spec.op === 'count') { columns.push(`count(*) as ${quote(`v${i}`)}`); continue; }
					const field = fieldSql(spec.field);
					const type = MAP_GET.call(model.fieldTypes, spec.field);
					if ((spec.op === 'min' || spec.op === 'max') && type !== 'number' && type !== 'string' && type !== 'date') {
						throw new ActiveTsConfigurationError('SQLite min/max aggregates require number, string, or date field type metadata.');
					}
					const numeric = spec.op === 'sum' || spec.op === 'avg' || type === 'number';
					const valid = numeric ? `${field.type} in ('integer', 'real')` : `${field.type} = 'text'`;
					// REAL arithmetic follows the portable JS-number contract and avoids SQLite's
					// integer overflow / node:sqlite's rejection of integers outside the safe range.
					const scalar = numeric ? `cast(${field.value} as real)` : type === 'string'
						? `active_ts_string_order_key(${field.jsonValue})` : field.value;
					const value = `case when ${valid} then ${scalar} end`;
					if (spec.op === 'avg') {
						// Bound the accumulated sum by dividing every input by a power
						// of two at least as large as the row count. Retain subnormal
						// rounding residues in original units, as the portable reducer does.
						columns.push(`total((${value}) / scale) as ${quote(`v${i}`)}`);
						columns.push(`total((${value}) - ((${value}) / scale) * scale) as ${quote(`r${i}`)}`);
						columns.push(`count(${value}) as ${quote(`n${i}`)}`);
						columns.push(`max(scale) as ${quote(`s${i}`)}`);
					} else columns.push(`${spec.op}(${value}) as ${quote(`v${i}`)}`);
					columns.push(`count(case when ${field.type} is not null and ${field.type} != 'null' and not (${valid}) then 1 end) as ${quote(`e${i}`)}`);
				}
				const params: SQLInputValue[] = [];
				const source = `select data from main.${table(model)} where ${whereSql(plan, params)}`;
				// Keep the row scan and the average's count in one SQLite statement
				// and snapshot. Recursive doubling needs at most 64 small scale rows.
				const prefix = hasAverage
					? `with recursive active_ts_rows as materialized (${source}), active_ts_scales(value) as (select 1.0 union all select value * 2 from active_ts_scales where value < (select count(*) from active_ts_rows)), active_ts_scale as (select max(value) as scale from active_ts_scales) `
					: '';
				const from = hasAverage ? 'active_ts_rows cross join active_ts_scale' : `(${source})`;
				const sql = `${prefix}select ${columns.length ? columns.join(', ') : 'count(*)'} from ${from}`;
				return execute(() => {
					const row = get(sql, params)!;
					const result: Record<string, unknown> = {};
					for (let i = 0; i < specs.length; i++) {
						if (Number(row[`e${i}`] ?? 0) > 0) throw new ActiveTsValidationError(`SQLite aggregate "${specs[i].as}" requires numeric values for number aggregates or text values for string/date min/max.`);
						let value = row[`v${i}`];
						if (value instanceof Uint8Array && MAP_GET.call(model.fieldTypes, specs[i].field) === 'string') {
							value = Buffer.from(value).swap16().toString('utf16le');
						}
						if (specs[i].op === 'avg') {
							const count = Number(row[`n${i}`]);
							const normalized = Number(value);
							const scale = Number(row[`s${i}`]);
							const remainder = Number(row[`r${i}`]);
							const sum = normalized * scale;
							value = count === 0 ? null : Number.isFinite(sum)
								? (sum + remainder) / count
								: (normalized / count) * scale + remainder / count;
						}
						defineDataProperty(result, specs[i].as, value, { enumerable: true, configurable: true, writable: true });
					}
					return normalizeAggregateRow(result, specs, 'SQLite aggregate');
				});
			},
			async create(model, id, data, writeOptions) {
				model = snapshotAdapterModel(model, 'SQLite model metadata'); writable();
				assertSafeEntityId(id, 'SQLite store id');
				rejectUnsupportedStoreWriteOptions(writeOptions, 'SQLite create options');
				const clean = cleanData(model, id, data);
				const sql = `insert into ${table(model)} (id, data) values (?, ?)`;
				await execute(() => { run(sql, [entityIdKey(id), clean]); });
			},
			async update(model, id, data, writeOptions) {
				model = snapshotAdapterModel(model, 'SQLite model metadata'); writable();
				assertSafeEntityId(id, 'SQLite store id');
				const normalized = rejectUnsupportedStoreWriteMetadata(normalizeStoreWriteOptions(writeOptions, 'SQLite update options'), 'SQLite update options');
				const clean = cleanData(model, id, data);
				const expected = normalized.expectedVersion;
				const version = fieldSql('version');
				const sql = `update ${table(model)} set data = ? where id = ?${expected === undefined ? '' : ` and ${version.type} in ('integer', 'real') and ${version.value} = ?`}`;
				await execute(() => {
					const params: SQLInputValue[] = [clean, entityIdKey(id)];
					if (expected !== undefined) params.push(expected);
					if (run(sql, params).changes === 0) {
						if (get(`select id from ${table(model)} where id = ?`, [entityIdKey(id)]) === undefined) {
							throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
						}
						throw new ActiveTsConflictError(`Optimistic lock failed for ${model.name}:${String(id)}.`);
					}
				});
			},
			async delete(model, id, writeOptions) {
				model = snapshotAdapterModel(model, 'SQLite model metadata'); writable();
				assertSafeEntityId(id, 'SQLite store id');
				const normalized = rejectUnsupportedStoreWriteMetadata(normalizeStoreWriteOptions(writeOptions, 'SQLite delete options'), 'SQLite delete options');
				const expected = normalized.expectedVersion;
				const version = fieldSql('version');
				const sql = `delete from ${table(model)} where id = ?${expected === undefined ? '' : ` and ${version.type} in ('integer', 'real') and ${version.value} = ?`}`;
				await execute(() => {
					const params: SQLInputValue[] = [entityIdKey(id)];
					if (expected !== undefined) params.push(expected);
					if (run(sql, params).changes === 0 && expected !== undefined) {
						if (get(`select id from ${table(model)} where id = ?`, [entityIdKey(id)]) === undefined) {
							throw new ActiveTsNotFoundError(`Cannot delete ${model.name}:${String(id)} because it does not exist.`);
						}
						throw new ActiveTsConflictError(`Optimistic lock failed for ${model.name}:${String(id)}.`);
					}
				});
			}
		};
		return adapter;
	}

	const adapter = makeAdapter(false) as SqliteStoreAdapter;
	adapter.schema = {
		async plan(inputModels) {
			const models = normalizeSchemaModels(inputModels, 'SQLite schema models');
			return enqueue(() => planSchema(models));
		},
		async apply(inputModels, applyOptions) {
			const models = normalizeSchemaModels(inputModels, 'SQLite schema models');
			normalizeStoreSchemaApplyOptions(applyOptions, 'SQLite schema apply options');
			return enqueue(() => {
				exec('BEGIN IMMEDIATE');
				try {
					const plan = planSchema(models);
					for (const change of plan.changes) {
						const model = models.find((candidate) => candidate.name === change.target)!;
						if (change.type === 'create-collection') exec(tableDefinition(model));
						else if (change.type === 'create-index') {
							const index = model.indexes.find((index) => index.name === change.name)!;
							if (index.unique) {
								const invalid = index.fields.map((field) => `${fieldSql(field).type} in ('object', 'array')`).join(' or ');
								if (get(`select 1 from ${table(model)} where ${invalid} limit 1`)) {
									throw new ActiveTsValidationError('SQLite unique indexes require scalar field values.');
								}
							}
							exec(indexDefinition(model, index).sql);
						}
					}
					exec('COMMIT');
					return plan;
				} catch (error) { return rollback(error); }
			});
		}
	};
	adapter.transaction = async (fn, transactionOptions) => {
		if (typeof fn !== 'function') throw new ActiveTsConfigurationError('SQLite transaction callback must be a function.');
		const normalized = normalizeStoreTransactionOptions(transactionOptions, 'SQLite transaction options');
		if ((normalized.isolation !== undefined && normalized.isolation !== 'serializable') || normalized.timeoutMs !== undefined || normalized.native !== undefined) {
			throw new ActiveTsConfigurationError('SQLite transactions support only serializable isolation and readOnly; timeoutMs/native are unsupported.');
		}
		return enqueue(() => connection.scope.run({}, async () => {
			exec('BEGIN IMMEDIATE');
			let ended: string | undefined;
			let sequence = 0;
			let savepointFailure: unknown;
			const base = makeAdapter(true, normalized.readOnly === true);
			base.savepoint = async (callback) => {
				const name = quote(`active_ts_savepoint_${++sequence}`);
				exec(`SAVEPOINT ${name}`);
				try {
					const result = await callback(base);
					exec(`RELEASE SAVEPOINT ${name}`);
					return result;
				} catch (error) {
					try { exec(`ROLLBACK TO SAVEPOINT ${name}`); exec(`RELEASE SAVEPOINT ${name}`); }
					catch (failure) {
						savepointFailure = new ActiveTsUnknownTransactionOutcomeError('SQLite savepoint rollback failed.', 'abort', failure);
						throw markSavepointRollbackUnconfirmed(savepointFailure);
					}
					throw error;
				}
			};
			const guard = createCloseGuardedStoreAdapter(base, () => ended, 'SQLite');
			try {
				const result = await fn(guard.adapter);
				ended = 'callback completion';
				await guard.waitForPendingOperations();
				if (savepointFailure) throw savepointFailure;
				exec('COMMIT');
				return result;
			} catch (error) {
				ended = 'callback failure';
				try { await guard.waitForPendingOperations(); } catch { /* Preserve the original callback failure. */ }
				return rollback(error, fn);
			} finally { ended = 'transaction completion'; }
		}));
	};
	adapter.close = () => {
		if (connection.scope.getStore()) return Promise.reject(new ActiveTsConfigurationError('Cannot close SQLite from inside its transaction callback.'));
		if (closePromise) return closePromise;
		closed = true;
		closePromise = connection.tail.then(() => {
			if (owned) {
				DatabaseSync.prototype.close.call(database);
				connection.unavailable = 'close';
			}
		});
		connection.tail = closePromise.then(() => {}, () => {});
		return closePromise;
	};
	return adapter;
}
