import { AsyncLocalStorage } from 'node:async_hooks';
import { optionalImport } from '../../core/optional-import.js';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsValidationError,
	safeErrorMessage
} from '../../core/errors.js';
import {
	clearSavepointRollbackUnconfirmed,
	markSavepointRollbackUnconfirmed,
	markTransactionRollbackSkipped,
	ownErrorValue
} from '../../core/error-classification.js';
import {
	assertDenseArrayItems,
	assertSafeEntityId,
	assertSafeEntityIdArray,
	assertSafeFieldPath,
	assertSafePhysicalIdentifierLength,
	assertSafeLimit,
	assertSafeOffset,
	assertSafeSchemaIdentifier,
	cloneSafeDataObject,
	clonePortableDataObject,
	defineDataProperty
} from '../../core/safe-keys.js';
import { assertAggregateSpecsCompatibleWithModel, defaultAggregateResult, normalizeAggregateRow } from '../../core/aggregate.js';
import { entityIdFromCanonicalKey, entityIdKey, limitWithLookahead, trimLookaheadRows } from '../../core/query-utils.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import {
	assertStoreDataMatchesId,
	assertStorePlanSupported,
	createCloseGuardedStoreAdapter,
	createTransactionOperationTracker,
	normalizeStoreAggregatePlan,
	normalizeStoreAggregateResult,
	normalizeStoreQueryResultForModel,
	normalizeStoreQueryPlan,
	normalizeStoreTransactionOptions,
	normalizeStoreWriteOptions,
	rejectUnsupportedStoreReadOptions,
	rejectUnsupportedStoreWriteMetadata,
	rejectUnsupportedStoreWriteOptions,
	trackAdapterSavepointOperation,
	validateStoreQueryReadOptions
} from '../../core/store-options.js';
import { normalizeSchemaModels } from '../../core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../../core/schema-options.js';
import { snapshotAdapterModel } from '../../core/adapter-model.js';
import { normalizeAggregatePlanFieldTypes, normalizeQueryPlanFieldTypes } from '../../core/field-types.js';
import { cloneDate, dateIsoString } from '../../core/date-intrinsics.js';
import {
	assertNoAggregateFieldCodecSpecs,
	encodeAggregatePlanFieldCodecs,
	encodeQueryPlanFieldCodecs
} from '../../core/field-codecs.js';
import {
	MAP_GET,
	MAP_HAS,
	MAP_SET,
	SET_ADD,
	SET_HAS,
	WEAKMAP_GET,
	WEAKMAP_HAS,
	WEAKMAP_SET,
	WEAKSET_ADD,
	WEAKSET_DELETE,
	WEAKSET_HAS
} from '../../core/collection-intrinsics.js';
import type {
	AggregatePlan,
	AggregateSpec,
	EntityId,
	FieldType,
	QueryPlan,
	QueryResult,
	ResolvedModelMeta,
	SchemaPlan,
	SortDirection,
	StoreAdapter,
	StoreTransactionOptions
} from '../../core/types.js';
import format from 'pg-format';
import { createHash } from 'node:crypto';

export type PostgresStoreOptions = {
	pool?: any;
	connectionString?: string;
	schema?: string;
	inTransaction?: boolean;
	cacheScope?: string;
};
const POSTGRES_OPTION_KEYS = ['pool', 'connectionString', 'schema', 'inTransaction', 'cacheScope'] as const;

const POSTGRES_OPERATORS = capturedSet(['=', '!=', '>', '>=', '<', '<=', 'in', 'between', 'isNull', 'isNotNull', 'startsWith']);
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const POSTGRES_NATIVE_SQL_KEYS = ['text', 'values'] as const;
const POSTGRES_CAST_ERROR_CODES = capturedSet(['22003', '22007', '22008', '22P02']);
const PROMISE_THEN = Promise.prototype.then;

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

const quote = (value: string) => format.ident(value);
const quoteLiteral = (value: string) => format.literal(value);

function tableName(options: PostgresStoreOptions, model: ResolvedModelMeta) {
	const name = assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(model.name, 'PostgreSQL table name'),
		'PostgreSQL table name',
		POSTGRES_IDENTIFIER_MAX_BYTES
	);
	return options.schema ? `${quote(options.schema)}.${quote(name)}` : quote(name);
}

function indexIdentifier(model: ResolvedModelMeta, indexName: string) {
	const table = assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(model.name, 'PostgreSQL table name'),
		'PostgreSQL table name',
		POSTGRES_IDENTIFIER_MAX_BYTES
	);
	const index = assertSafeSchemaIdentifier(indexName, 'PostgreSQL index name');
	return shortenPostgresIdentifier(`${table}_${index}`);
}

function shortenPostgresIdentifier(identifier: string) {
	if (Buffer.byteLength(identifier, 'utf8') <= POSTGRES_IDENTIFIER_MAX_BYTES) return identifier;
	const hash = createHash('sha256').update(identifier).digest('hex').slice(0, 12);
	const suffix = `_${hash}`;
	const maxPrefixBytes = POSTGRES_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix, 'utf8');
	let prefix = '';
	let bytes = 0;
	for (const char of identifier) {
		const nextBytes = Buffer.byteLength(char, 'utf8');
		if (bytes + nextBytes > maxPrefixBytes) break;
		prefix += char;
		bytes += nextBytes;
	}
	if (!prefix) {
		throw new ActiveTsValidationError('PostgreSQL identifier cannot be shortened safely.');
	}
	return `${prefix}${suffix}`;
}

async function tableExists(pool: any, options: PostgresStoreOptions, model: ResolvedModelMeta) {
	const res = await pool.query(
		'select 1 from information_schema.tables where table_schema = coalesce($1, current_schema()) and table_name = $2 limit 1',
		[options.schema ?? null, model.name]
	);
	return Boolean(postgresRows(res, 'PostgreSQL table lookup').length);
}

async function postgresRowExists(pool: any, options: PostgresStoreOptions, model: ResolvedModelMeta, storedId: string) {
	const res = await pool.query(`select 1 from ${tableName(options, model)} where id = $1 limit 1`, [storedId]);
	return Boolean(postgresRows(res, 'PostgreSQL row existence lookup').length);
}

async function assertPostgresTableShape(pool: any, options: PostgresStoreOptions, model: ResolvedModelMeta) {
	const columnsResult = await pool.query(
		'select column_name, udt_name, data_type, is_nullable from information_schema.columns where table_schema = coalesce($1, current_schema()) and table_name = $2',
		[options.schema ?? null, model.name]
	);
	const columns = new Map<string, { type: string; nullable: string }>();
	for (const row of postgresRows(columnsResult, 'PostgreSQL column lookup')) {
		const name = postgresOptionalString(
			postgresRequiredRowValue(row, 'column_name', 'PostgreSQL column row'),
			'PostgreSQL column row.column_name'
		);
		const typeValue =
			postgresRowValue(row, 'udt_name', 'PostgreSQL column row') ??
			postgresRequiredRowValue(row, 'data_type', 'PostgreSQL column row');
		const type = postgresOptionalString(typeValue, 'PostgreSQL column row.udt_name');
		const nullable = postgresOptionalString(
			postgresRequiredRowValue(row, 'is_nullable', 'PostgreSQL column row'),
			'PostgreSQL column row.is_nullable'
		);
		MAP_SET.call(columns, name, { type, nullable });
	}
	assertPostgresColumnShape(model, columns, 'id', 'text');
	assertPostgresColumnShape(model, columns, 'data', 'jsonb');
	assertPostgresColumnShape(model, columns, 'created_at', 'timestamptz');
	assertPostgresColumnShape(model, columns, 'updated_at', 'timestamptz');
	const primaryResult = await pool.query(
		`select a.attname as column_name
		 from pg_index i
		 join pg_class c on c.oid = i.indrelid
		 join pg_namespace n on n.oid = c.relnamespace
		 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
		 where i.indisprimary and n.nspname = coalesce($1, current_schema()) and c.relname = $2
		 order by array_position(i.indkey, a.attnum)`,
		[options.schema ?? null, model.name]
	);
	const primaryRows = postgresRows(primaryResult, 'PostgreSQL primary key lookup');
	if (primaryRows.length !== 1) {
		throw new ActiveTsConfigurationError(
			`PostgreSQL table "${model.name}" does not match the active-ts table shape: primary key must be exactly "id".`
		);
	}
	const primaryColumn = postgresOptionalString(
		postgresRequiredRowValue(primaryRows[0], 'column_name', 'PostgreSQL primary key row'),
		'PostgreSQL primary key row.column_name'
	);
	if (primaryColumn !== 'id') {
		throw new ActiveTsConfigurationError(
			`PostgreSQL table "${model.name}" does not match the active-ts table shape: primary key must be exactly "id".`
		);
	}
}

function assertPostgresColumnShape(
	model: ResolvedModelMeta,
	columns: Map<string, { type: string; nullable: string }>,
	name: string,
	type: string
) {
	const column = MAP_GET.call(columns, name) as { type: string; nullable: string } | undefined;
	if (!column) {
		throw new ActiveTsConfigurationError(
			`PostgreSQL table "${model.name}" does not match the active-ts table shape: missing column "${name}".`
		);
	}
	if (column.type !== type) {
		throw new ActiveTsConfigurationError(
			`PostgreSQL table "${model.name}" does not match the active-ts table shape: column "${name}" must be ${type}.`
		);
	}
	if (column.nullable !== 'NO') {
		throw new ActiveTsConfigurationError(
			`PostgreSQL table "${model.name}" does not match the active-ts table shape: column "${name}" must be not null.`
		);
	}
}

async function existingIndexDefinitions(pool: any, options: PostgresStoreOptions, model: ResolvedModelMeta) {
	const res = await pool.query('select indexname, indexdef from pg_indexes where schemaname = coalesce($1, current_schema()) and tablename = $2', [
		options.schema ?? null,
		model.name
	]);
	const indexes = new Map<string, string | undefined>();
	for (const row of postgresRows(res, 'PostgreSQL index lookup')) {
		const indexName = postgresRowValue(row, 'indexname', 'PostgreSQL index row');
		if (indexName === undefined) continue;
		const indexDef = postgresRowValue(row, 'indexdef', 'PostgreSQL index row');
		MAP_SET.call(
			indexes,
			postgresOptionalString(indexName, 'PostgreSQL index row.indexname'),
			indexDef === undefined ? undefined : postgresOptionalString(indexDef, 'PostgreSQL index row.indexdef')
		);
	}
	return indexes;
}

function postgresOptionalString(value: unknown, context: string) {
	if (typeof value !== 'string') {
		throw new ActiveTsValidationError(`${context} must be a string.`);
	}
	return value;
}

function jsonPath(field: string) {
	assertSafeFieldPath(field, 'PostgreSQL JSON field');
	return field.split('.');
}

function jsonFieldParam(field: string, params: any[]) {
	params.push(jsonPath(field));
	return `(data #>> $${params.length}::text[])`;
}

function jsonValueParam(field: string, params: any[]) {
	params.push(jsonPath(field));
	return `(data #> $${params.length}::text[])`;
}

function jsonPathParam(field: string, params: any[]) {
	params.push(jsonPath(field));
	return `$${params.length}::text[]`;
}

function modelFieldType(model: ResolvedModelMeta, field: string) {
	return MAP_GET.call(model.fieldTypes, field) as FieldType | undefined;
}

function typedJsonFieldParam(model: ResolvedModelMeta, field: string, params: any[], numeric = false) {
	const raw = jsonFieldParam(field, params);
	const type = modelFieldType(model, field);
	if (numeric || type === 'number') return `(${raw})::double precision`;
	if (type === 'boolean') return `(${raw})::boolean`;
	if (type === 'date') return `(${raw})::timestamptz`;
	return raw;
}

function jsonSortExpressions(model: ResolvedModelMeta, field: string, direction: 'asc' | 'desc', params: any[]) {
	const path = jsonPathParam(field, params);
	const json = `(data #> ${path})`;
	const text = `(data #>> ${path})`;
	const type = modelFieldType(model, field);
	if (type !== undefined) {
		const value =
			type === 'number'
				? `(${text})::double precision`
				: type === 'boolean'
					? `(${text})::boolean`
					: type === 'date'
						? `(${text})::timestamptz`
						: text;
		return [
			`(case when ${json} is null or jsonb_typeof(${json}) = 'null' then 0 else 1 end) ${direction}`,
			`${value} ${direction}`
		];
	}
	return [
		`(case when ${json} is null or jsonb_typeof(${json}) = 'null' then 0 when jsonb_typeof(${json}) = 'boolean' then 1 when jsonb_typeof(${json}) = 'number' then 2 when jsonb_typeof(${json}) = 'string' then 3 else 4 end) ${direction}`,
		`(case when jsonb_typeof(${json}) = 'boolean' then (${text})::boolean end) ${direction}`,
		`(case when jsonb_typeof(${json}) = 'number' then (${text})::double precision end) ${direction}`,
		`(case when jsonb_typeof(${json}) = 'string' then ${text} end) ${direction}`,
	];
}

type JsonComparisonType = 'string' | 'number' | 'boolean' | 'date' | 'null';

function jsonComparisonType(model: ResolvedModelMeta, field: string, value: unknown): JsonComparisonType {
	if (value === null) return 'null';
	const type = modelFieldType(model, field);
	if (type === 'number' || type === 'boolean' || type === 'date') return type;
	if (value instanceof Date) {
		throw new ActiveTsValidationError(
			`PostgreSQL date query operands require field type "date" for "${field}".`
		);
	}
	if (typeof value === 'number') return 'number';
	if (typeof value === 'boolean') return 'boolean';
	return 'string';
}

function sqlOperand(value: unknown, type: JsonComparisonType) {
	return type === 'date' && value instanceof Date ? dateIsoString(value) : value;
}

function sqlParamCast(type: JsonComparisonType) {
	if (type === 'number') return '::double precision';
	if (type === 'boolean') return '::boolean';
	if (type === 'date') return '::timestamptz';
	if (type === 'string') return '::text';
	return '';
}

function sqlArrayParamCast(type: JsonComparisonType) {
	if (type === 'number') return '::double precision[]';
	if (type === 'boolean') return '::boolean[]';
	if (type === 'date') return '::timestamptz[]';
	if (type === 'string') return '::text[]';
	return '';
}

function jsonAccessForComparison(field: string, type: JsonComparisonType, params: any[]) {
	const path = jsonPathParam(field, params);
	const json = `data #> ${path}`;
	const text = `data #>> ${path}`;
	if (type === 'number') return { json, value: `(${text})::double precision`, guard: `jsonb_typeof(${json}) = 'number'` };
	if (type === 'boolean') return { json, value: `(${text})::boolean`, guard: `jsonb_typeof(${json}) = 'boolean'` };
	if (type === 'date') return { json, value: `(${text})::timestamptz`, guard: `jsonb_typeof(${json}) = 'string'` };
	return { json, value: `(${text})`, guard: `jsonb_typeof(${json}) = 'string'` };
}

function jsonNullPredicate(field: string, params: any[]) {
	const value = jsonValueParam(field, params);
	return `coalesce(${value} = 'null'::jsonb, false)`;
}

function jsonEqualityPredicate(model: ResolvedModelMeta, field: string, value: unknown, params: any[]) {
	const type = jsonComparisonType(model, field, value);
	if (type === 'null') return jsonNullPredicate(field, params);
	const access = jsonAccessForComparison(field, type, params);
	params.push(sqlOperand(value, type));
	return `coalesce((${access.guard} and ${access.value} = $${params.length}${sqlParamCast(type)}), false)`;
}

function jsonRangePredicate(
	model: ResolvedModelMeta,
	field: string,
	operator: '>' | '>=' | '<' | '<=',
	value: unknown,
	params: any[]
) {
	const type = jsonComparisonType(model, field, value);
	const access = jsonAccessForComparison(field, type, params);
	params.push(sqlOperand(value, type));
	return `coalesce((${access.guard} and ${access.value} ${operator} $${params.length}${sqlParamCast(type)}), false)`;
}

function jsonBetweenPredicate(model: ResolvedModelMeta, field: string, lower: unknown, upper: unknown, params: any[]) {
	const type = jsonComparisonType(model, field, lower);
	const access = jsonAccessForComparison(field, type, params);
	params.push(sqlOperand(lower, type), sqlOperand(upper, type));
	return `coalesce((${access.guard} and ${access.value} between $${params.length - 1}${sqlParamCast(type)} and $${params.length}${sqlParamCast(type)}), false)`;
}

function jsonInPredicate(model: ResolvedModelMeta, field: string, values: readonly unknown[], params: any[]) {
	const groups = new Map<JsonComparisonType, unknown[]>();
	for (const value of values) {
		const type = jsonComparisonType(model, field, value);
		const list = MAP_GET.call(groups, type) ?? [];
		list.push(sqlOperand(value, type));
		MAP_SET.call(groups, type, list);
	}
	const clauses: string[] = [];
	for (const [type, groupValues] of groups) {
		if (type === 'null') {
			clauses.push(jsonNullPredicate(field, params));
			continue;
		}
		const access = jsonAccessForComparison(field, type, params);
		params.push(groupValues);
		clauses.push(`coalesce((${access.guard} and ${access.value} = any($${params.length}${sqlArrayParamCast(type)})), false)`);
	}
	return clauses.length === 1 ? clauses[0] : `(${clauses.join(' or ')})`;
}

function jsonFieldLiteral(field: string, access: 'text' | 'json' = 'text') {
	const path = jsonPath(field);
	const quoted: string[] = [];
	for (let index = 0; index < path.length; index++) quoted[index] = quoteLiteral(path[index]);
	return `(data ${access === 'json' ? '#>' : '#>>'} ARRAY[${quoted.join(', ')}])`;
}

function jsonIndexFieldLiteral(index: ResolvedModelMeta['indexes'][number], field: string) {
	return jsonFieldLiteral(field, index.unique ? 'json' : 'text');
}

function assertPostgresIndexDefinitionMatches(model: ResolvedModelMeta, index: ResolvedModelMeta['indexes'][number], definition: string | undefined) {
	if (definition === undefined) {
		throw new ActiveTsConfigurationError(
			`PostgreSQL index "${index.name}" on "${model.name}" is missing definition metadata.`
		);
	}
	const canonical = canonicalPostgresIndexSql(definition);
	const unique = isPostgresUniqueIndexDefinition(definition);
	if (Boolean(index.unique) !== unique || hasUnsupportedPostgresIndexDefinitionOptions(definition, index.directions)) {
		throw new ActiveTsConfigurationError(
			`PostgreSQL index "${index.name}" on "${model.name}" does not match declared fields or uniqueness.`
		);
	}
	const jsonFieldCount = canonical.match(/data#>>array\[|data#>array\[/g)?.length ?? 0;
	if (jsonFieldCount !== index.fields.length) {
		throw new ActiveTsConfigurationError(
			`PostgreSQL index "${index.name}" on "${model.name}" does not match declared fields or uniqueness.`
		);
	}
	let position = 0;
	for (let fieldIndex = 0; fieldIndex < index.fields.length; fieldIndex++) {
		const expected = canonicalPostgresIndexSql(jsonIndexFieldLiteral(index, index.fields[fieldIndex]));
		const next = canonical.indexOf(expected, position);
		if (next < 0) {
			throw new ActiveTsConfigurationError(
				`PostgreSQL index "${index.name}" on "${model.name}" does not match declared fields or uniqueness.`
			);
		}
		const actual = postgresIndexDefinitionFieldDirection(canonical, next + expected.length);
		if (actual.direction !== (index.directions?.[fieldIndex] ?? 'asc')) {
			throw new ActiveTsConfigurationError(
				`PostgreSQL index "${index.name}" on "${model.name}" does not match declared fields or uniqueness.`
			);
		}
		position = actual.end;
	}
}

function hasUnsupportedPostgresIndexDefinitionOptions(definition: string, directions: readonly SortDirection[] | undefined) {
	if (!/\busing\s+btree\b/i.test(definition)) return true;
	if (/\bwhere\b/i.test(definition)) return true;
	if (/\bcollate\b/i.test(definition)) return true;
	if (/\bnulls\s+(first|last)\b/i.test(definition)) return true;
	if (/\bdesc\b/i.test(definition) && !indexDirectionsContainDesc(directions)) return true;
	if (/\b[a-z_][a-z0-9_]*_ops\b/i.test(definition)) return true;
	return false;
}

function indexDirectionsContainDesc(directions: readonly SortDirection[] | undefined) {
	if (directions === undefined) return false;
	for (let index = 0; index < directions.length; index++) {
		if (directions[index] === 'desc') return true;
	}
	return false;
}

function postgresIndexDefinitionFieldDirection(canonical: string, position: number): { direction: SortDirection; end: number } {
	let cursor = position;
	while (canonical[cursor] === ')') cursor++;
	if (canonical.startsWith('desc', cursor) && postgresIndexDirectionTokenBoundary(canonical[cursor + 4])) {
		return { direction: 'desc', end: cursor + 4 };
	}
	if (canonical.startsWith('asc', cursor) && postgresIndexDirectionTokenBoundary(canonical[cursor + 3])) {
		return { direction: 'asc', end: cursor + 3 };
	}
	return { direction: 'asc', end: cursor };
}

function postgresIndexDirectionTokenBoundary(char: string | undefined) {
	return char === undefined || !/[a-z0-9_]/i.test(char);
}

function canonicalPostgresIndexSql(value: string) {
	let canonical = '';
	for (let index = 0; index < value.length;) {
		const char = value[index];
		if (char === "'") {
			canonical += char;
			index++;
			while (index < value.length) {
				const quoted = value[index];
				canonical += quoted;
				index++;
				if (quoted !== "'") continue;
				if (value[index] === "'") {
					canonical += value[index];
					index++;
					continue;
				}
				break;
			}
			continue;
		}
		const cast = value.slice(index).match(/^::[a-z_][a-z0-9_]*/i);
		if (cast) {
			index += cast[0].length;
			continue;
		}
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		canonical += char.toLowerCase();
		index++;
	}
	return canonical;
}

function isPostgresUniqueIndexDefinition(value: string) {
	return /^\s*create\s+unique\s+index\b/i.test(value);
}

function escapeLikePrefix(value: unknown) {
	return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function whereCondition(model: ResolvedModelMeta, plan: Pick<QueryPlan, 'where' | 'or'>, params: any[]): string {
	const parts: string[] = [];
	for (const where of plan.where) {
		if (where.op === 'contains') {
			throw new ActiveTsConfigurationError(
				'PostgreSQL adapter does not support portable contains queries. Use native SQL for text/json contains.'
			);
		}
		if (where.op === 'arrayContains' || where.op === 'textContains' || where.op === 'jsonContains') {
			throw new ActiveTsConfigurationError(
				`PostgreSQL adapter does not support portable ${where.op} queries. Use native SQL for backend-specific containment.`
			);
		}
		if (!SET_HAS.call(POSTGRES_OPERATORS, where.op)) {
			throw new ActiveTsValidationError(`PostgreSQL operator "${where.op}" is not allowed.`);
		}
		const fieldType = modelFieldType(model, where.field);
		if (where.op === 'startsWith' && fieldType && fieldType !== 'string') {
			throw new ActiveTsValidationError('PostgreSQL startsWith queries require a string field type.');
		}
		if (where.op === 'isNull' || where.op === 'isNotNull') {
			const value = jsonValueParam(where.field, params);
			const condition = `(${value} is null or ${value} = 'null'::jsonb)`;
			parts.push(where.op === 'isNull' ? condition : `not ${condition}`);
			continue;
		}
		if (where.op === 'startsWith') {
			const path = jsonPathParam(where.field, params);
			params.push(`${escapeLikePrefix(where.value)}%`);
			parts.push(
				`jsonb_typeof(data #> ${path}) = 'string' and (data #>> ${path}) like $${params.length} escape ${quoteLiteral('\\')}`
			);
			continue;
		}
		if (where.op === 'between') {
			parts.push(jsonBetweenPredicate(model, where.field, where.value, where.value2, params));
		} else if (where.op === 'in') {
			parts.push(jsonInPredicate(model, where.field, where.value as readonly unknown[], params));
		} else if (where.op === '=') {
			parts.push(jsonEqualityPredicate(model, where.field, where.value, params));
		} else if (where.op === '!=') {
			const path = jsonPathParam(where.field, params);
			parts.push(`data #> ${path} is not null and not (${jsonEqualityPredicate(model, where.field, where.value, params)})`);
		} else {
			parts.push(jsonRangePredicate(model, where.field, where.op, where.value, params));
		}
	}
	const andCondition = parts.length ? parts.join(' and ') : '';
	const orConditions: string[] = [];
	for (let index = 0; index < plan.or.length; index++) {
		const condition = whereCondition(model, plan.or[index], params);
		if (condition) orConditions[orConditions.length] = condition;
	}
	if (!andCondition) return orConditions.join(' or ');
	if (!orConditions.length) return andCondition;
	const grouped = [`(${andCondition})`];
	for (let index = 0; index < orConditions.length; index++) grouped[grouped.length] = `(${orConditions[index]})`;
	return grouped.join(' or ');
}

function whereSql(model: ResolvedModelMeta, plan: Pick<QueryPlan, 'where' | 'or'>, params: any[]) {
	const condition = whereCondition(model, plan, params);
	return condition ? `where ${condition}` : '';
}

function limitSql(limit: number | undefined) {
	if (limit === undefined) return '';
	assertSafeLimit(limit, 'PostgreSQL limit');
	return ` limit ${limit}`;
}

function offsetSql(offset: number | undefined) {
	if (offset === undefined) return '';
	assertSafeOffset(offset, 'PostgreSQL offset');
	return ` offset ${offset}`;
}

function numericAggregateSql(field: string, params: any[]) {
	const path = jsonPathParam(field, params);
	const json = `data #> ${path}`;
	const text = `data #>> ${path}`;
	return `(case when ${json} is null or jsonb_typeof(${json}) = 'null' then null when jsonb_typeof(${json}) = 'number' then ${text} else 'active-ts-invalid-numeric-aggregate' end)::double precision`;
}

function aggregateSql(model: ResolvedModelMeta, spec: AggregateSpec, params: any[]) {
	const alias = quote(spec.as);
	if (spec.op === 'count') return `count(*)::double precision as ${alias}`;
	if (spec.op === 'sum' || spec.op === 'avg') {
		const numericValue = numericAggregateSql(spec.field!, params);
		if (spec.op === 'sum') return `coalesce(sum(${numericValue}), 0)::double precision as ${alias}`;
		return `avg(${numericValue})::double precision as ${alias}`;
	}
	const comparableValue = typedJsonFieldParam(model, spec.field!, params);
	return `${spec.op}(${comparableValue}) as ${alias}`;
}

function assertTypedMinMaxAggregates(model: ResolvedModelMeta, specs: AggregateSpec[]) {
	for (const spec of specs) {
		if ((spec.op !== 'min' && spec.op !== 'max') || !spec.field) continue;
		if (modelFieldType(model, spec.field) !== undefined) continue;
		throw new ActiveTsConfigurationError(
			`PostgreSQL aggregate "${spec.as}" requires field type metadata for min/max field "${spec.field}".`
		);
	}
}

function postgresNativeSql(payload: unknown) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new ActiveTsValidationError('PostgreSQL native payload must be a function or { text, values }.');
	}
	const prototype = Object.getPrototypeOf(payload);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('PostgreSQL native payload must be a plain object.');
	}
	const native = payload as Record<string, unknown>;
	assertNoSymbolNativePayload(native, 'PostgreSQL native payload');
	assertKnownPostgresNativeKeys(native, 'PostgreSQL native payload');
	const text = ownOptionValue(native, 'text');
	const values = ownOptionValue(native, 'values');
	if (typeof text !== 'string' || !text) {
		throw new ActiveTsValidationError('PostgreSQL native payload text must be a non-empty string.');
	}
	if (values !== undefined && !Array.isArray(values)) {
		throw new ActiveTsValidationError('PostgreSQL native payload values must be an array.');
	}
	return {
		text,
		values: values === undefined ? [] : postgresNativeValues(values, 'PostgreSQL native payload values')
	};
}

function assertPostgresNativeSqlTransactionSafe(text: string, context: string) {
	const standard = stripPostgresSqlLiteralsAndComments(text, false).toLowerCase();
	const legacy = stripPostgresSqlLiteralsAndComments(text, true).toLowerCase();
	const transactionControl = /(^|;)\s*(?:begin|commit|end|rollback|abort|savepoint|release(?:\s+savepoint)?|prepare\s+transaction|start\s+transaction|set\s+(?:session\s+characteristics\s+as\s+)?transaction)(?=$|[;\s(])/;
	if (transactionControl.test(standard) || transactionControl.test(legacy)) {
		throw new ActiveTsConfigurationError(
			`${context} cannot execute transaction control statements inside an active transaction.`
		);
	}
}

function stripPostgresSqlLiteralsAndComments(text: string, legacyBackslashEscapes: boolean) {
	let stripped = '';
	for (let index = 0; index < text.length;) {
		const char = text[index];
		const next = text[index + 1];
		if (char === '-' && next === '-') {
			stripped += '  ';
			index += 2;
			while (index < text.length && text[index] !== '\n' && text[index] !== '\r') {
				stripped += ' ';
				index++;
			}
			continue;
		}
		if (char === '/' && next === '*') {
			stripped += '  ';
			index += 2;
			let depth = 1;
			while (index < text.length && depth > 0) {
				if (text[index] === '/' && text[index + 1] === '*') {
					stripped += '  ';
					index += 2;
					depth++;
					continue;
				}
				if (text[index] === '*' && text[index + 1] === '/') {
					stripped += '  ';
					index += 2;
					depth--;
					continue;
				}
				stripped += text[index] === '\n' ? '\n' : ' ';
				index++;
			}
			continue;
		}
		if (char === '\'' || char === '"') {
			const quote = char;
			const escapeStringPrefix =
				index > 0 &&
				(text[index - 1] === 'E' || text[index - 1] === 'e') &&
				(index === 1 || !/[A-Za-z0-9_$\u0080-\uFFFF]/.test(text[index - 2]));
			const escapeBackslashes = quote === '\'' && (
				legacyBackslashEscapes || escapeStringPrefix
			);
			stripped += ' ';
			index++;
			while (index < text.length) {
				const current = text[index];
				stripped += current === '\n' ? '\n' : ' ';
				index++;
				if (escapeBackslashes && current === '\\' && index < text.length) {
					stripped += text[index] === '\n' ? '\n' : ' ';
					index++;
					continue;
				}
				if (current !== quote) continue;
				if (text[index] === quote) {
					stripped += ' ';
					index++;
					continue;
				}
				break;
			}
			continue;
		}
		if (char === '$') {
			const tag = postgresDollarQuoteTag(text, index);
			if (tag) {
				stripped += repeatSqlWhitespace(tag.length);
				index += tag.length;
				const end = text.indexOf(tag, index);
				const endIndex = end < 0 ? text.length : end + tag.length;
				while (index < endIndex) {
					stripped += text[index] === '\n' ? '\n' : ' ';
					index++;
				}
				continue;
			}
		}
		stripped += char;
		index++;
	}
	return stripped;
}

function postgresDollarQuoteTag(text: string, start: number) {
	if (start > 0 && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(text[start - 1])) return undefined;
	if (text[start + 1] === '$') return '$$';
	if (!/[A-Za-z_\u0080-\uFFFF]/.test(text[start + 1] ?? '')) return undefined;
	let end = start + 1;
	while (end < text.length && /[A-Za-z0-9_\u0080-\uFFFF]/.test(text[end])) end++;
	if (text[end] !== '$') return undefined;
	return text.slice(start, end + 1);
}

function repeatSqlWhitespace(length: number) {
	let value = '';
	for (let index = 0; index < length; index++) value += ' ';
	return value;
}

type PostgresTransactionNativeQuery = (
	query: unknown,
	values?: unknown[],
	isPayloadActive?: () => boolean,
	transactionScope?: unknown
) => Promise<unknown>;
type PostgresTransactionNativeOperationTracker = <T>(
	run: () => Promise<T>,
	isPayloadActive?: () => boolean,
	transactionScope?: unknown
) => Promise<T>;
type PostgresTransactionStatementScope = {
	statementFailed: boolean;
	firstStatementError?: unknown;
	closed?: string;
	parent?: PostgresTransactionStatementScope;
	nativeOperations: ReturnType<typeof createTransactionOperationTracker>;
	adapter?: StoreAdapter;
};

type PostgresNativePayloadScope = { active: boolean };
const postgresNativePayloadStorage = new AsyncLocalStorage<PostgresNativePayloadScope>();

async function runPostgresNativePayload<T>(
	run: (isPayloadActive: () => boolean) => Promise<T>
): Promise<T> {
	const scope: PostgresNativePayloadScope = { active: true };
	try {
		return await postgresNativePayloadStorage.run(
			scope,
			() => run(() => scope.active && postgresNativePayloadStorage.getStore() === scope)
		);
	} finally {
		scope.active = false;
	}
}

function postgresTransactionNativePool(
	pool: ReturnType<typeof normalizePostgresPool>,
	transactionQuery?: PostgresTransactionNativeQuery,
	isPayloadActive?: () => boolean,
	trackOperation?: PostgresTransactionNativeOperationTracker,
	transactionScope?: unknown
) {
	return Object.freeze({
		query: (...args: unknown[]) => {
			const run = async () => {
				if (args.length > 2 || typeof args[1] === 'function') {
					throw new ActiveTsConfigurationError(
						'PostgreSQL native transaction queries do not support callback arguments. Await the returned Promise instead.'
					);
				}
				const nativeQuery = postgresTransactionNativeQuery(args[0]);
				const values = args[1] as unknown[] | undefined;
				assertPostgresNativeSqlTransactionSafe(nativeQuery.text, 'PostgreSQL native function query');
				return await (transactionQuery
					? transactionQuery(nativeQuery.query, values, isPayloadActive, transactionScope)
					: pool.query(nativeQuery.query, values));
			};
			const operation = trackOperation ? trackOperation(run, isPayloadActive, transactionScope) : run();
			void PROMISE_THEN.call(
				operation,
				() => undefined,
				() => undefined
			);
			return operation;
		}
	});
}

function postgresTransactionNativeQuery(query: unknown): { query: unknown; text: string } {
	if (typeof query === 'string') return { query, text: query };
	if (!query || typeof query !== 'object' || Array.isArray(query)) {
		throw new ActiveTsConfigurationError('PostgreSQL native function query must be SQL text inside an active transaction.');
	}
	const safeQuery = Object.create(null) as Record<string, unknown>;
	for (const property of Object.getOwnPropertyNames(query)) {
		const propertyDescriptor = Object.getOwnPropertyDescriptor(query, property);
		if (property === 'callback' && (!propertyDescriptor || !('value' in propertyDescriptor) || propertyDescriptor.value !== undefined)) {
			throw new ActiveTsConfigurationError(
				'PostgreSQL native transaction queries do not support callback arguments. Await the returned Promise instead.'
			);
		}
		if (property === 'submit' && (!propertyDescriptor || !('value' in propertyDescriptor) || propertyDescriptor.value !== undefined)) {
			throw new ActiveTsConfigurationError(
				'PostgreSQL native transaction query objects are not supported. Pass SQL text or a plain pg query configuration object.'
			);
		}
		if (!propertyDescriptor || !('value' in propertyDescriptor)) {
			throw new ActiveTsConfigurationError(
				`PostgreSQL native transaction query configuration property "${property}" must be a data property.`
			);
		}
		defineDataProperty(safeQuery, property, propertyDescriptor.value, {
			enumerable: propertyDescriptor.enumerable,
			configurable: true,
			writable: true
		});
	}
	const prototype = Object.getPrototypeOf(query);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(
			'PostgreSQL native transaction query objects are not supported. Pass SQL text or a plain pg query configuration object.'
		);
	}
	if (prototype === Object.prototype) {
		const inheritedCallback = Object.getOwnPropertyDescriptor(Object.prototype, 'callback');
		if (inheritedCallback && (!('value' in inheritedCallback) || inheritedCallback.value !== undefined)) {
			throw new ActiveTsConfigurationError(
				'PostgreSQL native transaction queries do not support callback arguments. Await the returned Promise instead.'
			);
		}
	}
	const descriptor = Object.getOwnPropertyDescriptor(safeQuery, 'text');
	if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
		throw new ActiveTsConfigurationError('PostgreSQL native function query must be SQL text inside an active transaction.');
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError('PostgreSQL native function query.text must be enumerable.');
	}
	return { query: safeQuery, text: descriptor.value };
}

function postgresNativeValues(values: unknown[], context: string) {
	if (Object.getOwnPropertySymbols(values).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(values, context);
	const safeValues: unknown[] = [];
	for (let index = 0; index < values.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		assertPostgresNativeValue(descriptor.value, `${context}[${index}]`);
		safeValues.push(clonePostgresNativeValue(descriptor.value, `${context}[${index}]`));
	}
	return safeValues;
}

function clonePostgresNativeValue(value: unknown, context: string, seen = new WeakMap<object, unknown>()): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Date) {
		assertNoInheritedPostgresSerializer(value, context);
		return cloneDate(value);
	}
	if (value instanceof RegExp) {
		assertNoInheritedPostgresSerializer(value, context);
		const clone = new RegExp(value.source, value.flags);
		clone.lastIndex = value.lastIndex;
		return clone;
	}
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		assertNoInheritedPostgresSerializer(value, context);
		return structuredClone(value);
	}
	if (WEAKMAP_HAS.call(seen, value)) return WEAKMAP_GET.call(seen, value);
	if (Array.isArray(value)) {
		const clone: unknown[] = [];
		WEAKMAP_SET.call(seen, value, clone);
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
			}
			defineDataProperty(clone, String(index), clonePostgresNativeValue(descriptor.value, `${context}[${index}]`, seen), {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
		Object.setPrototypeOf(clone, null);
		return clone;
	}
	const clone = Object.create(null) as Record<string, unknown>;
	WEAKMAP_SET.call(seen, value, clone);
	for (const property of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		defineDataProperty(clone, property, clonePostgresNativeValue(descriptor.value, `${context}.${property}`, seen), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return clone;
}

function assertNoInheritedPostgresSerializer(value: object, context: string) {
	let current: object | null = value;
	while (current) {
		if (Object.prototype.hasOwnProperty.call(current, 'toPostgres')) {
			throw new ActiveTsValidationError(`${context}.toPostgres is not allowed in PostgreSQL native bind values.`);
		}
		current = Object.getPrototypeOf(current);
	}
}

function assertPostgresNativeValue(value: unknown, context: string, seen = new WeakSet<object>()) {
	if (value === undefined) {
		throw new ActiveTsValidationError(`${context} must not be undefined. Use null for SQL NULL parameters.`);
	}
	if (typeof value === 'function') {
		throw new ActiveTsValidationError(`${context} must not be a function.`);
	}
	if (typeof value === 'symbol') {
		throw new ActiveTsValidationError(`${context} must not be a symbol.`);
	}
	if (value === null || typeof value !== 'object') return;
	if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
	if (WEAKSET_HAS.call(seen, value)) {
		throw new ActiveTsValidationError(`${context} must not contain circular references.`);
	}
	WEAKSET_ADD.call(seen, value);
	try {
		if (Array.isArray(value)) {
			if (Object.getOwnPropertySymbols(value).length) {
				throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
			}
			assertDenseArrayItems(value, context);
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !('value' in descriptor)) {
					throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
				}
				assertPostgresNativeValue(descriptor.value, `${context}[${index}]`, seen);
			}
			return;
		}
		if (Object.getOwnPropertySymbols(value).length) {
			throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
		}
		for (const property of Object.getOwnPropertyNames(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
			}
			assertPostgresNativeValue(descriptor.value, `${context}.${property}`, seen);
		}
	} finally {
		WEAKSET_DELETE.call(seen, value);
	}
}

function assertNoSymbolNativePayload(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownPostgresNativeKeys(record: Record<string, unknown>, context: string) {
	const allowed = capturedSet<string>(POSTGRES_NATIVE_SQL_KEYS);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function hasWhereClauses(plan: Pick<QueryPlan, 'where' | 'or'>) {
	if (plan.where.length > 0) return true;
	for (let index = 0; index < plan.or.length; index++) {
		if (hasWhereClauses(plan.or[index])) return true;
	}
	return false;
}

function assertStandaloneNativeSqlQuery(plan: QueryPlan) {
	const clauses: string[] = [];
	if (hasWhereClauses(plan)) clauses.push('where');
	if (plan.sort.length) clauses.push('sort');
	if (plan.limit !== undefined) clauses.push('limit');
	if (plan.offset !== undefined) clauses.push('offset');
	if (plan.cursor !== undefined) clauses.push('cursor');
	if (plan.select?.length) clauses.push('select');
	if (!clauses.length) return;
	throw new ActiveTsConfigurationError(
		`PostgreSQL native SQL query payload cannot be combined with portable query clauses (${clauses.join(', ')}). Use a native function payload or move the clauses into SQL.`
	);
}

function assertStandaloneNativeSqlAggregate(plan: AggregatePlan) {
	if (!hasWhereClauses(plan)) return;
	throw new ActiveTsConfigurationError(
		'PostgreSQL native SQL aggregate payload cannot be combined with portable aggregate where clauses. Use a native function payload or move the clauses into SQL.'
	);
}

function postgresRows(result: unknown, context: string) {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		throw new ActiveTsValidationError(`${context} result must be an object.`);
	}
	const rows = ownOptionValue(result as Record<string, unknown>, 'rows');
	if (rows === undefined) {
		throw new ActiveTsValidationError(`${context} result.rows is required.`);
	}
	if (!Array.isArray(rows)) {
		throw new ActiveTsValidationError(`${context} result.rows must be an array.`);
	}
	return snapshotArrayInput(rows, `${context} result.rows`);
}

function entityIdKeyArray(ids: readonly EntityId[]) {
	const keys: string[] = [];
	for (let index = 0; index < ids.length; index++) keys[index] = entityIdKey(ids[index]);
	return keys;
}

function postgresGetManyRows(ids: readonly EntityId[], byId: Map<string, any>) {
	const rows: Array<Record<string, unknown> | null> = [];
	for (let index = 0; index < ids.length; index++) {
		const row = MAP_GET.call(byId, entityIdKey(ids[index]));
		rows[index] = row === undefined ? null : cloneSafeDataObject(row, 'PostgreSQL getMany row data');
	}
	return rows;
}

function postgresNativeQueryRows(rows: readonly unknown[], model: ResolvedModelMeta) {
	const list: any[] = [];
	for (let index = 0; index < rows.length; index++) list[index] = postgresNativeQueryRowData(rows[index], model);
	return list;
}

function postgresQueryRows(rows: readonly unknown[], model: ResolvedModelMeta) {
	const list: any[] = [];
	for (let index = 0; index < rows.length; index++) list[index] = postgresQueryRowData(rows[index], model);
	return list;
}

function orderSql(model: ResolvedModelMeta, plan: Pick<QueryPlan, 'sort'>, params: any[]) {
	if (!plan.sort.length) return '';
	const expressions: string[] = [];
	for (let index = 0; index < plan.sort.length; index++) {
		const sort = plan.sort[index];
		const sortExpressions = jsonSortExpressions(model, sort.field, sort.direction, params);
		for (let sortIndex = 0; sortIndex < sortExpressions.length; sortIndex++) {
			expressions[expressions.length] = sortExpressions[sortIndex];
		}
	}
	return ` order by ${expressions.join(', ')}`;
}

function aggregateSelectSql(model: ResolvedModelMeta, specs: readonly AggregateSpec[], params: any[]) {
	const parts: string[] = [];
	for (let index = 0; index < specs.length; index++) parts[index] = aggregateSql(model, specs[index], params);
	return parts.join(', ');
}

function postgresIndexFieldsSql(index: ResolvedModelMeta['indexes'][number]) {
	const parts: string[] = [];
	for (let fieldIndex = 0; fieldIndex < index.fields.length; fieldIndex++) {
		parts[fieldIndex] = postgresIndexFieldSql(index, fieldIndex);
	}
	return parts.join(', ');
}

function postgresIndexFieldSql(index: ResolvedModelMeta['indexes'][number], fieldIndex: number) {
	const field = jsonIndexFieldLiteral(index, index.fields[fieldIndex]);
	return index.directions?.[fieldIndex] === 'desc' ? `${field} desc` : field;
}

function postgresRowCount(result: unknown, context: string) {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		throw new ActiveTsValidationError(`${context} result must be an object.`);
	}
	const rowCount = ownOptionValue(result as Record<string, unknown>, 'rowCount');
	if (rowCount === undefined) {
		throw new ActiveTsValidationError(`${context} result.rowCount is required.`);
	}
	if (typeof rowCount !== 'number' || !Number.isSafeInteger(rowCount) || rowCount < 0) {
		throw new ActiveTsValidationError(`${context} result.rowCount must be a non-negative safe integer.`);
	}
	return rowCount;
}

function postgresRowValue(row: unknown, key: string, context: string) {
	if (!row || typeof row !== 'object' || Array.isArray(row)) {
		throw new ActiveTsValidationError(`${context} must be an object.`);
	}
	return ownOptionValue(row as Record<string, unknown>, key);
}

function postgresRequiredRowValue(row: unknown, key: string, context: string) {
	const value = postgresRowValue(row, key, context);
	if (value === undefined) {
		throw new ActiveTsValidationError(`${context}.${key} is required.`);
	}
	return value;
}

function postgresRowDataForExpectedId(
	row: unknown,
	model: ResolvedModelMeta,
	expectedId: EntityId,
	context: string
) {
	const storageKey = postgresRowStorageKey(row, 'id', context);
	if (storageKey !== entityIdKey(expectedId)) {
		throw new ActiveTsValidationError(`${context}.id must match the requested id.`);
	}
	return postgresRowDataFromStorageKey(row, model, storageKey, context, `${context} data`);
}

function postgresQueryRowData(row: unknown, model: ResolvedModelMeta) {
	const storageKey = postgresRowStorageKey(row, 'id', 'PostgreSQL query row');
	return postgresRowDataFromStorageKey(row, model, storageKey, 'PostgreSQL query row', 'PostgreSQL query row data');
}

function postgresNativeQueryRowData(row: unknown, model: ResolvedModelMeta) {
	if (!row || typeof row !== 'object' || Array.isArray(row)) {
		throw new ActiveTsValidationError('PostgreSQL native query row must be an object.');
	}
	const hasData = Object.prototype.hasOwnProperty.call(row, 'data');
	if (!hasData) return cloneSafeDataObject(row, 'PostgreSQL native query row data');
	const data = cloneSafeDataObject(
		postgresRowValue(row, 'data', 'PostgreSQL native query row'),
		'PostgreSQL native query row data'
	);
	if (Object.prototype.hasOwnProperty.call(row, 'id')) {
		const storageKey = postgresRowStorageKey(row, 'id', 'PostgreSQL native query row');
		const rowId = entityIdFromCanonicalKey(storageKey, 'PostgreSQL native query row.id');
		assertStoreDataMatchesId(model, rowId, data, 'PostgreSQL native query row data');
	}
	return data;
}

function postgresRowDataFromStorageKey(
	row: unknown,
	model: ResolvedModelMeta,
	storageKey: string,
	rowContext: string,
	dataContext: string
) {
	const rowId = entityIdFromCanonicalKey(storageKey, `${rowContext}.id`);
	const data = cloneSafeDataObject(
		postgresRequiredRowValue(row, 'data', rowContext),
		dataContext
	);
	assertStoreDataMatchesId(model, rowId, data, dataContext);
	return data;
}

function postgresRowStorageKey(row: unknown, key: string, context: string) {
	const value = postgresRequiredRowValue(row, key, context);
	if (typeof value !== 'string') {
		throw new ActiveTsValidationError(`${context}.${key} must be a string.`);
	}
	entityIdFromCanonicalKey(value, `${context}.${key}`);
	return value;
}

function postgresErrorCode(error: unknown) {
	const code = ownErrorValue(error, 'code');
	return typeof code === 'string' ? code : undefined;
}

function mapPostgresTypedJsonCastError(error: unknown, context: string): never {
	if (SET_HAS.call(POSTGRES_CAST_ERROR_CODES, postgresErrorCode(error) ?? '')) {
		throw new ActiveTsValidationError(
			`${context} failed because stored JSON field data could not be cast to the declared field type.`
		);
	}
	throw error;
}

async function queryPostgresTypedJson(pool: any, text: string, values: unknown[], context: string) {
	try {
		return await pool.query(text, values);
	} catch (error) {
		mapPostgresTypedJsonCastError(error, context);
	}
}

export async function createPostgresStoreAdapter(options: PostgresStoreOptions = {}): Promise<StoreAdapter> {
	return createPostgresStoreAdapterInternal(options);
}

async function createPostgresStoreAdapterInternal(
	options: PostgresStoreOptions,
	transactionNativeQuery?: PostgresTransactionNativeQuery,
	trackTransactionNativeOperation?: PostgresTransactionNativeOperationTracker,
	transactionNativeScope?: () => unknown
): Promise<StoreAdapter> {
	options = validatePostgresOptions(options);
	const mod = options.pool ? undefined : await optionalImport('pg', 'PostgresStoreAdapter');
	const Pool = mod?.Pool;
	const pool = normalizePostgresPool(options.pool ?? new Pool({ connectionString: options.connectionString }));
	const supportsTransaction = !options.inTransaction && pool.connect !== undefined;

	const adapter: StoreAdapter = {
		kind: 'postgresql',
		cacheScope: options.cacheScope,
		capabilities: {
			or: true,
			contains: false,
			arrayContains: false,
			textContains: false,
			jsonContains: false,
			startsWith: true,
			cursor: false,
			offset: true,
			select: false,
			nestedFields: true,
			numericComparisons: true,
			aggregate: true,
			transaction: supportsTransaction,
			transactionConflictDetection: false,
			savepoint: false,
			uniqueIndex: true,
			optimisticLock: true,
			nullOperators: true,
			missingFieldNulls: true,
			native: true
		},
		async get(model, id, readOptions) {
			model = snapshotAdapterModel(model, 'PostgreSQL model metadata');
			rejectUnsupportedStoreReadOptions(readOptions, 'PostgreSQL store read options');
			assertSafeEntityId(id, `${model.name} store id`);
			const res = await pool.query(`select id, data from ${tableName(options, model)} where id = $1`, [entityIdKey(id)]);
			const row = postgresRows(res, 'PostgreSQL get')[0];
			if (row === undefined) return null;
			return postgresRowDataForExpectedId(row, model, id, 'PostgreSQL get row');
		},
		async getMany(model, ids, readOptions) {
			model = snapshotAdapterModel(model, 'PostgreSQL model metadata');
			rejectUnsupportedStoreReadOptions(readOptions, 'PostgreSQL store read options');
			ids = assertSafeEntityIdArray(ids, 'PostgreSQL store ids');
			if (!ids.length) return [];
			const res = await pool.query(`select id, data from ${tableName(options, model)} where id = any($1)`, [
				entityIdKeyArray(ids)
			]);
			const requested = new Set<string>();
			for (const id of ids) SET_ADD.call(requested, entityIdKey(id));
			const byId = new Map<string, any>();
			for (const row of postgresRows(res, 'PostgreSQL getMany')) {
				const storageKey = postgresRowStorageKey(row, 'id', 'PostgreSQL getMany row');
				if (!SET_HAS.call(requested, storageKey)) {
					throw new ActiveTsValidationError('PostgreSQL getMany row id was not requested.');
				}
				if (MAP_HAS.call(byId, storageKey)) {
					throw new ActiveTsValidationError('PostgreSQL getMany returned duplicate row ids.');
				}
				const rowId = entityIdFromCanonicalKey(storageKey, 'PostgreSQL getMany row.id');
				const data = cloneSafeDataObject(
					postgresRequiredRowValue(row, 'data', 'PostgreSQL getMany row'),
					'PostgreSQL getMany row data'
				);
				assertStoreDataMatchesId(model, rowId, data, 'PostgreSQL getMany row data');
				MAP_SET.call(byId, storageKey, data);
			}
			return postgresGetManyRows(ids, byId);
		},
		async query(model, plan, readOptions): Promise<QueryResult> {
			model = snapshotAdapterModel(model, 'PostgreSQL model metadata');
			plan = normalizeStoreQueryPlan(plan, model.idField, 'PostgreSQL query plan', {
				limit: 'PostgreSQL limit',
				offset: 'PostgreSQL offset',
				whereField: 'PostgreSQL JSON field',
				selectField: 'PostgreSQL JSON field',
				sortField: 'PostgreSQL JSON field'
			});
			plan = normalizeQueryPlanFieldTypes(model, plan);
			plan = encodeQueryPlanFieldCodecs(model, plan);
			assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
			validateStoreQueryReadOptions(readOptions, plan, 'PostgreSQL store read options');
			if (plan.native !== undefined && typeof plan.native.payload === 'function') {
				const payload = plan.native.payload;
				return await runPostgresNativePayload(async (isPayloadActive) => {
					return normalizeStoreQueryResultForModel(
						model,
						await payload({
							pool: options.inTransaction
								? postgresTransactionNativePool(
									pool,
									transactionNativeQuery,
									isPayloadActive,
									trackTransactionNativeOperation,
									transactionNativeScope?.()
								)
								: pool,
							model,
							plan,
							table: tableName(options, model)
						}),
						'PostgreSQL native function query',
						{ cursor: adapter.capabilities?.cursor, adapterKind: adapter.kind }
					);
				});
			}
			if (plan.native !== undefined) {
				assertStandaloneNativeSqlQuery(plan);
				const native = postgresNativeSql(plan.native.payload);
				if (options.inTransaction) {
					assertPostgresNativeSqlTransactionSafe(native.text, 'PostgreSQL native query');
				}
				const res = await pool.query(native.text, native.values ?? []);
				const list = postgresNativeQueryRows(postgresRows(res, 'PostgreSQL native query'), model);
				return normalizeStoreQueryResultForModel(
					model,
					{ list, more: false, count: list.length },
					'PostgreSQL native query',
					{ cursor: adapter.capabilities?.cursor, adapterKind: adapter.kind }
				);
			}
			const params: any[] = [];
			const where = whereSql(model, plan, params);
			const order = orderSql(model, plan, params);
			const limit = limitSql(limitWithLookahead(plan.limit, 'PostgreSQL limit'));
			const offset = offsetSql(plan.offset);
			const res = await queryPostgresTypedJson(
				pool,
				`select id, data from ${tableName(options, model)} ${where}${order}${limit}${offset}`,
				params,
				'PostgreSQL query'
			);
			const rows = postgresRows(res, 'PostgreSQL query');
			const { rows: list, more } = trimLookaheadRows(postgresQueryRows(rows, model), plan.limit, 'PostgreSQL limit');
			const result: QueryResult = { list, count: list.length, more };
			return result;
		},
		async aggregate(model, plan: AggregatePlan) {
			model = snapshotAdapterModel(model, 'PostgreSQL model metadata');
			plan = normalizeStoreAggregatePlan(plan, 'PostgreSQL aggregate plan');
			plan = normalizeAggregatePlanFieldTypes(model, plan);
			plan = encodeAggregatePlanFieldCodecs(model, plan);
			assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
			const specs = assertAggregateSpecsCompatibleWithModel(model, plan.aggregates, 'PostgreSQL aggregate');
			assertNoAggregateFieldCodecSpecs(model, specs, 'PostgreSQL aggregate');
			if (plan.native !== undefined && typeof plan.native.payload === 'function') {
				const payload = plan.native.payload;
				return await runPostgresNativePayload(async (isPayloadActive) => {
					return normalizeStoreAggregateResult(
						await payload({
							pool: options.inTransaction
								? postgresTransactionNativePool(
									pool,
									transactionNativeQuery,
									isPayloadActive,
									trackTransactionNativeOperation,
									transactionNativeScope?.()
								)
								: pool,
							model,
							plan,
							table: tableName(options, model)
						}),
						specs,
						'PostgreSQL native function aggregate'
					);
				});
			}
			if (plan.native !== undefined) {
				assertStandaloneNativeSqlAggregate(plan);
				const native = postgresNativeSql(plan.native.payload);
				if (options.inTransaction) {
					assertPostgresNativeSqlTransactionSafe(native.text, 'PostgreSQL native aggregate');
				}
				const res = await pool.query(native.text, native.values ?? []);
				return normalizeAggregateRow(postgresRows(res, 'PostgreSQL native aggregate')[0], specs, 'PostgreSQL native aggregate');
			}
			assertTypedMinMaxAggregates(model, specs);
			const params: any[] = [];
			const select = aggregateSelectSql(model, specs, params);
			const where = whereSql(model, plan, params);
			const res = await queryPostgresTypedJson(
				pool,
				`select ${select} from ${tableName(options, model)} ${where}`,
				params,
				'PostgreSQL aggregate'
			);
			const row = postgresRows(res, 'PostgreSQL aggregate')[0];
			return normalizeAggregateRow(row === undefined ? defaultAggregateResult(specs) : row, specs, 'PostgreSQL aggregate');
		},
		async create(model, id, data, writeOptions = {}) {
			model = snapshotAdapterModel(model, 'PostgreSQL model metadata');
			rejectUnsupportedStoreWriteOptions(writeOptions, 'PostgreSQL store create options');
			assertSafeEntityId(id, `${model.name} store id`);
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			try {
				await pool.query(`insert into ${tableName(options, model)} (id, data) values ($1, $2)`, [
					entityIdKey(id),
					clean
				]);
			} catch (error) {
				if (postgresErrorCode(error) === '23505') {
					throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
				}
				throw error;
			}
		},
		async update(model, id, data, writeOptions = {}) {
			model = snapshotAdapterModel(model, 'PostgreSQL model metadata');
			assertSafeEntityId(id, `${model.name} store id`);
			writeOptions = rejectUnsupportedStoreWriteMetadata(
				normalizeStoreWriteOptions(writeOptions, 'PostgreSQL store write options'),
				'PostgreSQL store write options'
			);
			const storedId = entityIdKey(id);
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			if (writeOptions.expectedVersion !== undefined) {
				const res = await pool.query(
					`update ${tableName(options, model)} set data = $2, updated_at = now() where id = $1 and jsonb_typeof(data #> ARRAY['version']) = 'number' and (data #>> ARRAY['version'])::double precision = $3`,
					[storedId, clean, writeOptions.expectedVersion]
				);
				if (postgresRowCount(res, 'PostgreSQL update') === 0) {
					if (!await postgresRowExists(pool, options, model, storedId)) {
						throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
					}
					throw new ActiveTsConflictError(
						`Optimistic lock failed for ${model.name}:${String(id)}. Expected version ${writeOptions.expectedVersion}.`
					);
				}
				return;
			}
			const res = await pool.query(
				`update ${tableName(options, model)} set data = $2, updated_at = now() where id = $1`,
				[storedId, clean]
			);
			if (postgresRowCount(res, 'PostgreSQL update') === 0) {
				throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
			}
		},
		async delete(model, id, writeOptions = {}) {
			model = snapshotAdapterModel(model, 'PostgreSQL model metadata');
			assertSafeEntityId(id, `${model.name} store id`);
			writeOptions = rejectUnsupportedStoreWriteMetadata(
				normalizeStoreWriteOptions(writeOptions, 'PostgreSQL store delete options'),
				'PostgreSQL store delete options'
			);
			const storedId = entityIdKey(id);
			if (writeOptions.expectedVersion !== undefined) {
				const res = await pool.query(
					`delete from ${tableName(options, model)} where id = $1 and jsonb_typeof(data #> ARRAY['version']) = 'number' and (data #>> ARRAY['version'])::double precision = $2`,
					[storedId, writeOptions.expectedVersion]
				);
				if (postgresRowCount(res, 'PostgreSQL delete') === 0) {
					if (!await postgresRowExists(pool, options, model, storedId)) {
						throw new ActiveTsNotFoundError(`Cannot delete ${model.name}:${String(id)} because it does not exist.`);
					}
					throw new ActiveTsConflictError(
						`Optimistic lock failed for ${model.name}:${String(id)}. Expected version ${writeOptions.expectedVersion}.`
					);
				}
				return;
			}
			await pool.query(`delete from ${tableName(options, model)} where id = $1`, [storedId]);
		},
		transaction: supportsTransaction ? async (fn, transactionOptions?: StoreTransactionOptions) => {
			if (typeof fn !== 'function') {
				throw new ActiveTsConfigurationError('PostgreSQL transaction callback must be a function.');
			}
			const txOptions = normalizeStoreTransactionOptions(transactionOptions, 'PostgreSQL transaction options');
			if (txOptions.native !== undefined) {
				throw new ActiveTsConfigurationError('PostgreSQL transaction options.native is not supported.');
			}
			const client = normalizePostgresTransactionClient(await pool.connect!());
			let result: Awaited<ReturnType<typeof fn>>;
			let hasResult = false;
			let primaryError: unknown;
			let commitDispatched = false;
			let rollbackConfirmed = false;
			let discardClient = false;
			try {
				const begin: string[] = ['begin'];
				if (txOptions.isolation !== undefined) {
					begin.push(
						'isolation level',
						txOptions.isolation === 'readCommitted'
							? 'read committed'
							: txOptions.isolation === 'repeatableRead'
								? 'repeatable read'
								: 'serializable'
					);
				}
				if (txOptions.readOnly === true) begin.push('read only');
				else if (txOptions.readOnly === false) begin.push('read write');
				await client.query(begin.join(' '));
				if (txOptions.timeoutMs !== undefined) {
					await client.query('select set_config($1, $2, true)', [
						'statement_timeout',
						`${txOptions.timeoutMs}ms`
					]);
				}
				let closed: string | undefined;
				const statementScopeStorage = new AsyncLocalStorage<PostgresTransactionStatementScope>();
				const createStatementScope = (
					context: string,
					parent?: PostgresTransactionStatementScope
				): PostgresTransactionStatementScope => {
					let scope!: PostgresTransactionStatementScope;
					scope = {
						statementFailed: false,
						parent,
						nativeOperations: createTransactionOperationTracker(
							() => scope.closed ?? closed,
							context
						)
					};
					return scope;
				};
				const rootStatementScope = createStatementScope('PostgreSQL native query');
				const statementScopeFor = (transactionScope: unknown, includeClosedAmbient = true) => {
					const captured = transactionScope as PostgresTransactionStatementScope | undefined;
					const ambient = statementScopeStorage.getStore();
					if (!captured) return ambient ?? rootStatementScope;
					let current = ambient;
					while (current) {
						if (current === captured) {
							return includeClosedAmbient || ambient?.closed === undefined ? ambient! : captured;
						}
						current = current.parent;
					}
					return captured;
				};
				const runInStatementScope = <T>(
					captured: PostgresTransactionStatementScope,
					run: () => T
				): T => statementScopeStorage.run(statementScopeFor(captured), run);
				const markStatementFailure = (scope: PostgresTransactionStatementScope, error: unknown) => {
					if (scope.statementFailed) return;
					scope.statementFailed = true;
					scope.firstStatementError = error;
				};
				const executeTransactionQuery = async (
					query: unknown,
					values: unknown[] | undefined,
					scope: PostgresTransactionStatementScope
				) => {
					try {
						return await client.query(query, values);
					} catch (error) {
						markStatementFailure(scope, error);
						throw error;
					}
				};
				const transactionPool = Object.freeze({
					query: (query: unknown, values?: unknown[]) => executeTransactionQuery(
						query,
						values,
						statementScopeStorage.getStore() ?? rootStatementScope
					)
				});
				const transactionNativeQuery: PostgresTransactionNativeQuery = async (
					query,
					values,
					isPayloadActive,
					transactionScope
				) => {
					const scope = statementScopeFor(transactionScope);
					const scopeClosed = scope.closed ?? closed;
					if (scopeClosed !== undefined && isPayloadActive?.() !== true) {
						throw new ActiveTsConfigurationError(
							`Cannot use closed PostgreSQL native transaction query handle after ${scopeClosed}.`
						);
					}
					return await executeTransactionQuery(query, values, scope);
				};
				const trackTransactionNativeOperation: PostgresTransactionNativeOperationTracker = (
					run,
					isPayloadActive,
					transactionScope
				) => {
					const scope = statementScopeFor(transactionScope, false);
					const payloadActive = isPayloadActive?.() === true;
					if ((scope.closed ?? closed) !== undefined && !payloadActive) return run();
					const track = () => scope.nativeOperations.track(run, undefined, payloadActive);
					return scope.adapter ? trackAdapterSavepointOperation(scope.adapter, track) : track();
				};
				const baseTx = await createPostgresStoreAdapterInternal(
					{
						pool: transactionPool,
						schema: options.schema,
						inTransaction: true,
						cacheScope: options.cacheScope
					},
					transactionNativeQuery,
					trackTransactionNativeOperation,
					() => statementScopeStorage.getStore() ?? rootStatementScope
				);
				let savepointSequence = 0;
				let tx!: StoreAdapter;
				tx = {
					...baseTx,
					capabilities: Object.freeze({ ...(baseTx.capabilities ?? {}), transaction: false, savepoint: true }),
					savepoint: async (savepointFn) => {
						if (typeof savepointFn !== 'function') {
							throw new ActiveTsConfigurationError('PostgreSQL savepoint callback must be a function.');
						}
						const savepointName = quote(`active_ts_savepoint_${++savepointSequence}`);
						const scope = createStatementScope(
							'PostgreSQL savepoint native query',
							statementScopeStorage.getStore() ?? rootStatementScope
						);
						let active = false;
						try {
							await client.query(`savepoint ${savepointName}`);
							active = true;
							const scopedTx: StoreAdapter = {
								...tx,
								get: (model, id, readOptions) =>
									runInStatementScope(scope, () => tx.get(model, id, readOptions)),
								getMany: (model, ids, readOptions) =>
									runInStatementScope(scope, () => tx.getMany(model, ids, readOptions)),
								query: (model, plan, readOptions) =>
									runInStatementScope(scope, () => tx.query(model, plan, readOptions)),
								aggregate: tx.aggregate
									? (model, plan) => runInStatementScope(scope, () => tx.aggregate!(model, plan))
									: undefined,
								create: (model, id, data, writeOptions) =>
									runInStatementScope(scope, () => tx.create(model, id, data, writeOptions)),
								update: (model, id, data, writeOptions) =>
									runInStatementScope(scope, () => tx.update(model, id, data, writeOptions)),
								delete: (model, id, writeOptions) =>
									runInStatementScope(scope, () => tx.delete(model, id, writeOptions)),
								savepoint: (fn) => runInStatementScope(scope, () => tx.savepoint!(fn))
							};
							scope.adapter = scopedTx;
							const savepointResult = await statementScopeStorage.run(scope, () => savepointFn(scopedTx));
							scope.closed = 'callback finished';
							await scope.nativeOperations.waitForPendingOperations();
							if (scope.statementFailed) {
								const aborted = new ActiveTsConfigurationError(
									`PostgreSQL savepoint cannot be released after a statement failed: ${safeErrorMessage(scope.firstStatementError)}`
								);
								defineDataProperty(aborted, 'cause', scope.firstStatementError, {
									enumerable: false,
									configurable: true
								});
								throw aborted;
							}
							await client.query(`release savepoint ${savepointName}`);
							active = false;
							scope.closed = 'released';
							return savepointResult;
						} catch (error) {
							scope.closed = 'rollback';
							try {
								await scope.nativeOperations.waitForPendingOperations();
							} catch {
								// Preserve the callback or operation error that triggered rollback.
							}
							const recoveryScope = scope.parent ?? rootStatementScope;
							if (!active) {
								markStatementFailure(recoveryScope, error);
								throw error;
							}
							try {
								await client.query(`rollback to savepoint ${savepointName}`);
								await client.query(`release savepoint ${savepointName}`);
								active = false;
							} catch (recoveryError) {
								markStatementFailure(recoveryScope, recoveryError);
								throw markSavepointRollbackUnconfirmed(new AggregateError(
									[error, recoveryError],
									`PostgreSQL savepoint failed and recovery failed: ${safeErrorMessage(error)}`
								));
							}
							throw clearSavepointRollbackUnconfirmed(error);
						}
					}
				};
				rootStatementScope.adapter = tx;
				const guardedTx = createCloseGuardedStoreAdapter(tx, () => closed, 'PostgreSQL store');
				try {
					result = await fn(guardedTx.adapter);
					closed = 'callback finished';
					await guardedTx.waitForPendingOperations();
					let nativeOperationFailed = false;
					let nativeOperationError: unknown;
					try {
						await rootStatementScope.nativeOperations.waitForPendingOperations();
					} catch (error) {
						nativeOperationFailed = true;
						nativeOperationError = error;
					}
					if (rootStatementScope.statementFailed) {
						const aborted = new ActiveTsConfigurationError(
							`PostgreSQL transaction cannot commit after a statement failed: ${safeErrorMessage(rootStatementScope.firstStatementError)}`
						);
						defineDataProperty(aborted, 'cause', rootStatementScope.firstStatementError, {
							enumerable: false,
							configurable: true
						});
						throw aborted;
					}
					if (nativeOperationFailed) throw nativeOperationError;
				} catch (error) {
					closed = 'rollback';
					try {
						await guardedTx.waitForPendingOperations();
					} catch {
						// Preserve the callback or operation error that triggered rollback.
					}
					try {
						await rootStatementScope.nativeOperations.waitForPendingOperations();
					} catch {
						// Preserve the callback or operation error that triggered rollback.
					}
					throw error;
				}
				commitDispatched = true;
				const commitResult = await client.query('commit');
				if (!commitResult || typeof commitResult !== 'object' || Array.isArray(commitResult)) {
					throw new ActiveTsConfigurationError('PostgreSQL transaction commit result must be an object.');
				}
				const command = Object.getOwnPropertyDescriptor(commitResult, 'command');
				if (!command || !('value' in command) || typeof command.value !== 'string') {
					throw new ActiveTsConfigurationError(
						'PostgreSQL transaction commit result.command must be an own string data property.'
					);
				}
				const commitCommand = command.value.toUpperCase();
				if (commitCommand !== 'COMMIT') {
					rollbackConfirmed = commitCommand === 'ROLLBACK';
					throw new ActiveTsConfigurationError(
						`PostgreSQL transaction commit returned command "${command.value}" instead of "COMMIT".`
					);
				}
				hasResult = true;
			} catch (error) {
				if (commitDispatched && !rollbackConfirmed) {
					const uncertain = new ActiveTsConfigurationError(
						`PostgreSQL transaction commit outcome is unknown: ${safeErrorMessage(error)}`
					);
					defineDataProperty(uncertain, 'cause', error, {
						enumerable: false,
						configurable: true
					});
					primaryError = markTransactionRollbackSkipped(uncertain);
					discardClient = true;
				} else {
					try {
						await client.query('rollback');
					} catch (rollbackError) {
						primaryError = markTransactionRollbackSkipped(new AggregateError(
							[error, rollbackError],
							`PostgreSQL transaction failed and rollback failed: ${safeErrorMessage(error)}`
						));
						discardClient = true;
					}
				}
				primaryError ??= error;
			}
			try {
				if (discardClient) client.release?.(primaryError);
				else client.release?.();
			} catch (releaseError) {
				if (primaryError !== undefined) {
					attachPostgresReleaseError(primaryError, releaseError);
				} else {
					throw new ActiveTsCommittedTransactionError(
						`PostgreSQL transaction committed but release failed: ${safeErrorMessage(releaseError)}`,
						releaseError,
						result!
					);
				}
			}
			if (primaryError !== undefined) throw primaryError;
			if (!hasResult) {
				throw new ActiveTsConfigurationError('PostgreSQL transaction completed without a result.');
			}
			return result!;
		} : undefined,
		schema: options.inTransaction ? undefined : {
			async plan(models): Promise<SchemaPlan> {
				models = normalizeSchemaModels(models, 'PostgreSQL schema models');
				const changes: SchemaPlan['changes'] = [];
				for (const model of models) {
					const exists = await tableExists(pool, options, model);
					if (!exists) changes.push({ type: 'create-collection', target: model.name });
					if (exists) await assertPostgresTableShape(pool, options, model);
					const existingIndexes = exists ? await existingIndexDefinitions(pool, options, model) : new Map<string, string | undefined>();
					for (const index of model.indexes) {
						const existingIndex = MAP_GET.call(existingIndexes, indexIdentifier(model, index.name));
						if (MAP_HAS.call(existingIndexes, indexIdentifier(model, index.name))) {
							assertPostgresIndexDefinitionMatches(model, index, existingIndex);
							continue;
						}
						changes.push({
							type: 'create-index',
							target: model.name,
							name: index.name,
							fields: index.fields,
							...(index.directions === undefined ? {} : { directions: index.directions }),
							unique: index.unique
						});
					}
				}
				return {
					adapter: 'postgresql',
					changes
				};
			},
			async apply(models, applyOptions): Promise<SchemaPlan> {
				normalizeStoreSchemaApplyOptions(applyOptions, 'PostgreSQL schema apply options');
				const safeModels = normalizeSchemaModels(models, 'PostgreSQL schema models');
				const plan = await adapter.schema!.plan(safeModels);
				for (const model of safeModels) {
					await pool.query(
						`create table if not exists ${tableName(options, model)} (id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`
					);
					for (const index of model.indexes) {
						const unique = index.unique ? 'unique ' : '';
						await pool.query(
							`create ${unique}index if not exists ${quote(indexIdentifier(model, index.name))} on ${tableName(options, model)} (${postgresIndexFieldsSql(index)})`
						);
					}
				}
				return plan;
			}
		}
	};
	return adapter;
}

function attachPostgresReleaseError(primaryError: unknown, releaseError: unknown) {
	if (!primaryError || (typeof primaryError !== 'object' && typeof primaryError !== 'function')) return;
	try {
		defineDataProperty(primaryError, 'releaseError', releaseError, {
			enumerable: false,
			configurable: true
		});
	} catch {
		// Preserve the primary transaction outcome even when the error object is not extensible.
	}
}

function validatePostgresOptions(options: PostgresStoreOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('PostgreSQL adapter options must be an object.');
	}
	assertPlainFactoryOptions(options, 'PostgreSQL adapter options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'PostgreSQL adapter options');
	assertKnownOptions(record, POSTGRES_OPTION_KEYS, 'PostgreSQL adapter options');
	const connectionString = ownFactoryOptionValue(record, 'connectionString', 'PostgreSQL adapter option');
	const schema = ownFactoryOptionValue(record, 'schema', 'PostgreSQL adapter option');
	const inTransaction = ownFactoryOptionValue(record, 'inTransaction', 'PostgreSQL adapter option');
	const pool = ownFactoryOptionValue(record, 'pool', 'PostgreSQL adapter option');
	const cacheScope = ownFactoryOptionValue(record, 'cacheScope', 'PostgreSQL adapter option');
	if (connectionString !== undefined && typeof connectionString !== 'string') {
		throw new ActiveTsConfigurationError('PostgreSQL adapter connectionString must be a string.');
	}
	if (pool !== undefined && connectionString !== undefined) {
		throw new ActiveTsConfigurationError('PostgreSQL adapter options cannot combine pool and connectionString.');
	}
	if (schema !== undefined) {
		if (typeof schema !== 'string' || !schema || schema.includes('\0')) {
			throw new ActiveTsConfigurationError('PostgreSQL adapter schema must be a non-empty string without null bytes.');
		}
		if (Buffer.byteLength(schema, 'utf8') > POSTGRES_IDENTIFIER_MAX_BYTES) {
			throw new ActiveTsConfigurationError(`PostgreSQL adapter schema "${schema}" is too long.`);
		}
	}
	if (inTransaction !== undefined && typeof inTransaction !== 'boolean') {
		throw new ActiveTsConfigurationError('PostgreSQL adapter inTransaction must be a boolean.');
	}
	if (cacheScope !== undefined && (typeof cacheScope !== 'string' || !cacheScope || cacheScope.includes('\0'))) {
		throw new ActiveTsConfigurationError(
			'PostgreSQL adapter cacheScope must be a non-empty string without null bytes.'
		);
	}
	if (pool !== undefined) {
		normalizePostgresPool(pool);
	}
	return { connectionString, schema, inTransaction, pool, cacheScope } as PostgresStoreOptions;
}

function assertPlainFactoryOptions(options: object, context: string) {
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
}

function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownOptions(record: Record<string, unknown>, allowedKeys: readonly string[], context: string) {
	const allowed = capturedSet<string>(allowedKeys);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function ownFactoryOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function normalizePostgresPool(pool: unknown) {
	if (!pool || typeof pool !== 'object' || Array.isArray(pool)) {
		throw new ActiveTsConfigurationError('PostgreSQL adapter pool must be an object.');
	}
	const query = postgresMethod(pool, 'query', 'PostgreSQL adapter pool.query');
	const connectValue = postgresMember(pool, 'connect', 'PostgreSQL adapter pool.connect', { requireEnumerableOwn: true });
	if (connectValue !== undefined && typeof connectValue !== 'function') {
		throw new ActiveTsConfigurationError('PostgreSQL adapter pool.connect must be a function.');
	}
	const connect = typeof connectValue === 'function' ? connectValue.bind(pool) : undefined;
	return Object.freeze(connect === undefined ? { query } : { query, connect });
}

function normalizePostgresTransactionClient(client: unknown) {
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsConfigurationError('PostgreSQL transaction client must be an object.');
	}
	const query = postgresMethod(client, 'query', 'PostgreSQL transaction client.query');
	const releaseValue = postgresMember(client, 'release', 'PostgreSQL transaction client.release', { requireEnumerableOwn: true });
	if (releaseValue !== undefined && typeof releaseValue !== 'function') {
		throw new ActiveTsConfigurationError('PostgreSQL transaction client.release must be a function.');
	}
	const release = typeof releaseValue === 'function' ? releaseValue.bind(client) : undefined;
	return Object.freeze(release === undefined ? { query } : { query, release });
}

function postgresMethod(client: object, method: string, context: string) {
	const value = postgresMember(client, method, context, { requireEnumerableOwn: true });
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(client);
}

function postgresMember(
	client: object,
	property: string,
	context: string,
	options: { requireEnumerableOwn?: boolean } = {}
) {
	let current: object | null = client;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context} must be a data property.`);
			}
			if (options.requireEnumerableOwn && current === client && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${context} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${key} must be enumerable.`);
	}
	return descriptor.value;
}
