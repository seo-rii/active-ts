import { ActiveTsConfigurationError } from '../../core/errors.js';
import { MAP_HAS, SET_ADD, SET_HAS } from '../../core/collection-intrinsics.js';
import type { AggregateSpec, QueryPlan, ResolvedModelMeta } from '../../core/types.js';

type GooglePlan = Pick<QueryPlan, 'where' | 'sort' | 'limit'>;
const GOOGLE_MAX_INEQUALITY_FIELDS = 10;
const FIRESTORE_MAX_DNF_DISJUNCTIONS = 30;

function isGoogleInequalityOperator(op: QueryPlan['where'][number]['op']) {
	return op === '!=' || op === '>' || op === '>=' || op === '<' || op === '<=' || op === 'between' || op === 'isNotNull';
}

function isGoogleNegativeInequalityOperator(op: QueryPlan['where'][number]['op']) {
	return op === '!=' || op === 'isNotNull';
}

function inequalityFields(plan: Pick<QueryPlan, 'where'>) {
	const seen = new Set<string>();
	const fields: string[] = [];
	for (const where of plan.where) {
		if (!isGoogleInequalityOperator(where.op) || SET_HAS.call(seen, where.field)) continue;
		SET_ADD.call(seen, where.field);
		fields[fields.length] = where.field;
	}
	return fields;
}

export function assertGoogleInequalityLimits(adapterKind: string, plan: Pick<QueryPlan, 'where'>) {
	const fields = inequalityFields(plan);
	if (fields.length > GOOGLE_MAX_INEQUALITY_FIELDS) {
		throw new ActiveTsConfigurationError(
			`${adapterKind} adapter supports at most ${GOOGLE_MAX_INEQUALITY_FIELDS} inequality filter fields per query.`
		);
	}
	let negativeFilters = 0;
	for (let index = 0; index < plan.where.length; index++) {
		if (isGoogleNegativeInequalityOperator(plan.where[index].op)) negativeFilters++;
	}
	if (negativeFilters > 1) {
		throw new ActiveTsConfigurationError(
			`${adapterKind} adapter supports at most one != or isNotNull filter per query.`
		);
	}
}

export function assertFirestoreDisjunctionLimit(plan: Pick<QueryPlan, 'where'>) {
	let disjunctions = 1;
	for (let index = 0; index < plan.where.length; index++) {
		const where = plan.where[index];
		if (where.op !== 'in' || !Array.isArray(where.value)) continue;
		disjunctions *= where.value.length;
		if (disjunctions > FIRESTORE_MAX_DNF_DISJUNCTIONS) {
			throw new ActiveTsConfigurationError(
				`Firestore adapter supports at most ${FIRESTORE_MAX_DNF_DISJUNCTIONS} disjunctions per query after in-filter expansion.`
			);
		}
	}
}

export function assertFirestoreQueryLimits(plan: Pick<QueryPlan, 'where'>) {
	assertGoogleInequalityLimits('Firestore', plan);
	assertFirestoreDisjunctionLimit(plan);
}

export function assertDatastoreQueryLimits(plan: Pick<QueryPlan, 'where'>) {
	assertGoogleInequalityLimits('Datastore', plan);
}

export function assertGoogleInequalitySortOrder(adapterKind: string, plan: GooglePlan, orderMethod: 'order' | 'orderBy') {
	const fields = inequalityFields(plan);
	if (!fields.length) return;
	const [firstSort] = plan.sort;
	if (!firstSort) {
		if (plan.limit !== undefined) {
			throw new ActiveTsConfigurationError(
				`${adapterKind} adapter requires an explicit ${orderMethod} on an inequality filter field (${fields.join(', ')}) before limit().`
			);
		}
		return;
	}
	if (!fieldListHas(fields, firstSort.field)) {
		throw new ActiveTsConfigurationError(
			`${adapterKind} adapter requires the first ${orderMethod} field "${firstSort.field}" to match an inequality filter field (${fields.join(', ')}).`
		);
	}
}

export function assertGoogleSortableFieldsDeclared(
	adapterKind: string,
	model: ResolvedModelMeta,
	plan: Pick<QueryPlan, 'sort'>,
	orderMethod: 'order' | 'orderBy'
) {
	for (const sort of plan.sort) {
		if (sort.field === model.idField || MAP_HAS.call(model.fieldTypes, sort.field)) continue;
		throw new ActiveTsConfigurationError(
			`${adapterKind} adapter requires fieldType metadata for portable ${orderMethod}("${sort.field}") because the backend excludes rows where the sorted field is missing.`
		);
	}
}

export function assertGoogleMinMaxInequalityOrder(adapterKind: string, plan: Pick<QueryPlan, 'where'>, spec: AggregateSpec) {
	if (spec.op !== 'min' && spec.op !== 'max') return;
	const fields = inequalityFields(plan);
	if (!fields.length) return;
	if (!fieldListHas(fields, spec.field)) {
		throw new ActiveTsConfigurationError(
			`${adapterKind} adapter cannot optimize ${spec.op}(${spec.field}) with inequality filters on ${fields.join(', ')} because the backend first order field would differ.`
		);
	}
}

function fieldListHas(fields: readonly string[], field: string | undefined) {
	if (field === undefined) return false;
	for (let index = 0; index < fields.length; index++) {
		if (fields[index] === field) return true;
	}
	return false;
}
