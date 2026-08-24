import { ActiveTsConfigurationError, ActiveTsValidationError, safeErrorMessage } from './errors.js';
import { cloneSafeData, defineDataProperty } from './safe-keys.js';
import { assertValidWhereOperand, setPath, valueFor } from './query-utils.js';
import { MAP_ENTRIES, SET_ADD, SET_HAS, WEAKSET_ADD, WEAKSET_HAS } from './collection-intrinsics.js';
import type { AggregatePlan, AggregateSpec, FieldCodec, Operator, QueryPlan, ResolvedModelMeta } from './types.js';

export const FIELD_CODEC_QUERY_OPERANDS_ENCODED = Symbol('active-ts.field-codec-query-operands-encoded');
const trustedFieldCodecQueryOperandMarkers = new WeakSet<object>();

type FieldCodecPathMatch = {
	field: string;
	codec: FieldCodec;
	relation: 'exact' | 'ancestor' | 'descendant';
};

const DEFAULT_FIELD_CODEC_QUERY_OPERATORS = capturedSet<Operator>(['=', '!=', 'in']);

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function applyFieldCodecs(meta: ResolvedModelMeta, data: any, operation: 'read' | 'write') {
	const next = cloneSafeData(data);
	for (const [field, codec] of meta.fieldCodecs) {
		applyFieldCodec(next, meta, field, codec, operation);
	}
	return cloneSafeData(next);
}

export function applyFieldCodecsForFields(
	meta: ResolvedModelMeta,
	data: any,
	fields: readonly string[],
	operation: 'read' | 'write'
) {
	const next = cloneSafeData(data);
	const applied = new Set<string>();
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		for (const [codecField, codec] of MAP_ENTRIES.call(meta.fieldCodecs)) {
			const relation = fieldCodecPathRelation(field, codecField);
			if (!relation || SET_HAS.call(applied, codecField)) continue;
			if (relation === 'ancestor' && valueFor(next, field) !== undefined) continue;
			SET_ADD.call(applied, codecField);
			applyFieldCodec(next, meta, codecField, codec, operation);
		}
	}
	return cloneSafeData(next);
}

function applyFieldCodec(
	target: Record<string, any>,
	meta: ResolvedModelMeta,
	field: string,
	codec: FieldCodec,
	operation: 'read' | 'write'
) {
	const current = valueFor(target, field);
	if (current === undefined) return;
	let value: unknown;
	try {
		value =
			operation === 'write'
				? codec.encode(current, { model: meta, field, operation })
				: codec.decode(current, { model: meta, field, operation });
	} catch (error) {
		throw new ActiveTsValidationError(
			`Field codec "${codec.name}" ${operation} failed for ${meta.name}.${field}: ${
				safeErrorMessage(error)
			}`
		);
	}
	assertDefinedFieldCodecResult(meta, field, codec.name, operation, value);
	setPath(target, field, value);
}

export function encodeFieldCodecQueryOperand(
	meta: ResolvedModelMeta,
	field: string,
	value: unknown,
	operator: Operator = '='
) {
	const match = findFieldCodecPathMatch(meta, field);
	if (!match) return value;
	assertExactFieldCodecPath(meta, field, match, 'query field');
	const codec = match.codec;
	if (!codec.encodeQuery) {
		throw new ActiveTsConfigurationError(
			`Field codec "${codec.name}" on ${meta.name}.${field} does not support portable query operands.`
		);
	}
	assertFieldCodecQueryOperatorSupported(meta, field, codec, operator);
	let encoded: unknown;
	try {
		encoded = codec.encodeQuery(value, { model: meta, field, operation: 'query', operator });
	} catch (error) {
		throw new ActiveTsValidationError(
			`Field codec "${codec.name}" query failed for ${meta.name}.${field}: ${
				safeErrorMessage(error)
			}`
		);
	}
	assertDefinedFieldCodecResult(meta, field, codec.name, 'query', encoded);
	return encoded;
}

export function encodeQueryPlanFieldCodecs<TPlan extends QueryPlan>(
	meta: ResolvedModelMeta,
	plan: TPlan
): TPlan {
	if (hasFieldCodecQueryOperandsEncoded(plan)) return plan;
	const encoded = {
		...plan,
		where: encodeWhereFieldCodecs(meta, plan.where),
		or: encodeQueryPlanBranches(meta, plan.or)
	};
	return markFieldCodecQueryOperandsEncoded(encoded as TPlan);
}

export function encodeAggregatePlanFieldCodecs<TPlan extends AggregatePlan>(
	meta: ResolvedModelMeta,
	plan: TPlan
): TPlan {
	if (hasFieldCodecQueryOperandsEncoded(plan)) return plan;
	const encoded = {
		...plan,
		where: encodeWhereFieldCodecs(meta, plan.where),
		or: encodeQueryPlanBranches(meta, plan.or)
	};
	return markFieldCodecQueryOperandsEncoded(encoded as TPlan);
}

export function assertNoAggregateFieldCodecSpecs(
	meta: ResolvedModelMeta,
	specs: AggregateSpec[],
	context: string
) {
	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index];
		if (!spec.field) continue;
		const match = findFieldCodecPathMatch(meta, spec.field);
		if (!match) continue;
		throw new ActiveTsConfigurationError(
			`${context} cannot aggregate field "${spec.field}" because it overlaps field-codec field "${match.field}". Use QueryBuilder aggregate fallback so active-ts can decode stored values before aggregating.`
		);
	}
}

export function hasFieldCodecPathOverlap(meta: ResolvedModelMeta, field: string) {
	return !!findFieldCodecPathMatch(meta, field);
}

export function markFieldCodecQueryOperandsEncoded<TPlan extends object>(plan: TPlan): TPlan {
	const descriptor = Object.getOwnPropertyDescriptor(plan, FIELD_CODEC_QUERY_OPERANDS_ENCODED);
	if (descriptor && !WEAKSET_HAS.call(trustedFieldCodecQueryOperandMarkers, plan)) {
		throw new ActiveTsValidationError('field codec query operand marker is not trusted.');
	}
	defineDataProperty(plan, FIELD_CODEC_QUERY_OPERANDS_ENCODED, true, {
		enumerable: false,
		configurable: false,
		writable: false
	});
	WEAKSET_ADD.call(trustedFieldCodecQueryOperandMarkers, plan);
	return plan;
}

export function hasFieldCodecQueryOperandsEncoded(plan: unknown) {
	if (!plan || typeof plan !== 'object') return false;
	const descriptor = Object.getOwnPropertyDescriptor(plan, FIELD_CODEC_QUERY_OPERANDS_ENCODED);
	if (!descriptor) return false;
	if (!('value' in descriptor)) {
		throw new ActiveTsValidationError('field codec query operand marker must be a data property.');
	}
	if (descriptor.enumerable) {
		throw new ActiveTsValidationError('field codec query operand marker must be non-enumerable.');
	}
	if (descriptor.value !== true) {
		throw new ActiveTsValidationError('field codec query operand marker must be true.');
	}
	if (!WEAKSET_HAS.call(trustedFieldCodecQueryOperandMarkers, plan)) {
		throw new ActiveTsValidationError('field codec query operand marker is not trusted.');
	}
	return descriptor.value === true;
}

export function copyFieldCodecQueryOperandMarker<TPlan extends object>(source: unknown, target: TPlan): TPlan {
	if (hasFieldCodecQueryOperandsEncoded(source)) return markFieldCodecQueryOperandsEncoded(target);
	return target;
}

export function stripFieldCodecQueryOperandMarker<TPlan extends Pick<QueryPlan, 'where' | 'or'>>(plan: TPlan): TPlan {
	const or: QueryPlan['or'] = [];
	for (let index = 0; index < plan.or.length; index++) {
		or[index] = stripFieldCodecQueryOperandMarker(plan.or[index]);
	}
	return {
		...plan,
		or
	} as TPlan;
}

function encodeWhereFieldCodecs(meta: ResolvedModelMeta, wheres: QueryPlan['where']) {
	const encodedWheres: QueryPlan['where'] = [];
	for (let index = 0; index < wheres.length; index++) {
		const where = wheres[index];
		const match = findFieldCodecPathMatch(meta, where.field);
		if (!match) {
			encodedWheres[index] = where;
			continue;
		}
		assertExactFieldCodecPath(meta, where.field, match, 'query field');
		const codec = match.codec;
		if (where.op === 'isNull' || where.op === 'isNotNull') {
			throw new ActiveTsConfigurationError(
				`Field codec "${codec.name}" on ${meta.name}.${where.field} does not support portable null operators. Use an explicit sentinel field or a non-codec nullable column.`
			);
		}
		const encoded =
			where.op === 'in'
				? {
						...where,
						value: encodeFieldCodecInOperands(meta, where.field, where.value as unknown[], where.op)
					}
				: where.op === 'between'
					? {
							...where,
							value: encodeFieldCodecQueryOperand(meta, where.field, where.value, where.op),
							value2: encodeFieldCodecQueryOperand(meta, where.field, where.value2, where.op)
						}
					: { ...where, value: encodeFieldCodecQueryOperand(meta, where.field, where.value, where.op) };
		assertValidWhereOperand(encoded.op, encoded.value, encoded.value2, encoded.field);
		encodedWheres[index] = encoded;
	}
	return encodedWheres;
}

function encodeQueryPlanBranches(meta: ResolvedModelMeta, branches: QueryPlan['or']) {
	const encodedBranches: QueryPlan['or'] = [];
	for (let index = 0; index < branches.length; index++) {
		encodedBranches[index] = encodeQueryPlanFieldCodecs(meta, branches[index]);
	}
	return encodedBranches;
}

function encodeFieldCodecInOperands(meta: ResolvedModelMeta, field: string, values: unknown[], operator: Operator) {
	const encoded: unknown[] = [];
	for (let index = 0; index < values.length; index++) {
		encoded[index] = encodeFieldCodecQueryOperand(meta, field, values[index], operator);
	}
	return encoded;
}

function findFieldCodecPathMatch(meta: ResolvedModelMeta, field: string): FieldCodecPathMatch | undefined {
	for (const [codecField, codec] of meta.fieldCodecs) {
		const relation = fieldCodecPathRelation(field, codecField);
		if (relation) return { field: codecField, codec, relation };
	}
	return undefined;
}

function fieldCodecPathRelation(field: string, codecField: string): FieldCodecPathMatch['relation'] | undefined {
	if (field === codecField) return 'exact';
	if (field.startsWith(`${codecField}.`)) return 'ancestor';
	if (codecField.startsWith(`${field}.`)) return 'descendant';
	return undefined;
}

function assertExactFieldCodecPath(
	meta: ResolvedModelMeta,
	field: string,
	match: FieldCodecPathMatch,
	context: string
) {
	if (match.relation === 'exact') return;
	throw new ActiveTsConfigurationError(
		`Field codec "${match.codec.name}" on ${meta.name}.${match.field} overlaps ${context} "${field}". Portable codec queries must target the exact codec field.`
	);
}

function assertFieldCodecQueryOperatorSupported(
	meta: ResolvedModelMeta,
	field: string,
	codec: FieldCodec,
	operator: Operator
) {
	if (fieldCodecSupportsOperator(codec, operator)) return;
	if (!codec.queryOperators && SET_HAS.call(DEFAULT_FIELD_CODEC_QUERY_OPERATORS, operator)) return;
	throw new ActiveTsConfigurationError(
		`Field codec "${codec.name}" on ${meta.name}.${field} does not support portable query operator "${operator}". Add queryOperators only for operators whose stored encoding preserves the operator semantics.`
	);
}

function fieldCodecSupportsOperator(codec: FieldCodec, operator: Operator) {
	const operators = codec.queryOperators;
	if (!operators) return false;
	for (let index = 0; index < operators.length; index++) {
		if (operators[index] === operator) return true;
	}
	return false;
}

function assertDefinedFieldCodecResult(
	meta: ResolvedModelMeta,
	field: string,
	codecName: string,
	operation: 'read' | 'write' | 'query',
	value: unknown
) {
	if (value === undefined) {
		throw new ActiveTsValidationError(
			`Field codec "${codecName}" ${operation} returned undefined for ${meta.name}.${field}. Use null or omit the source field explicitly.`
		);
	}
}
