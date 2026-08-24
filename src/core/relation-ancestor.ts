import type { ActiveContext } from './context.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { normalizeDatastoreKey } from './datastore-key.js';
import { assertSafeEntityId } from './safe-keys.js';
import { portableScalarKey, valueFor } from './query-utils.js';
import type { DatastoreKey, EntityId, RelationMeta, ResolvedModelMeta } from './types.js';

export function relationAncestorForOwner(
	context: ActiveContext,
	ownerModel: ResolvedModelMeta,
	targetModel: ResolvedModelMeta,
	relation: RelationMeta,
	item: any
): DatastoreKey | undefined {
	if (!relation.ancestor) {
		return inferRelationDatastoreAncestor(ownerModel, targetModel, relation, item);
	}
	const ancestor = relation.ancestor({
		context,
		owner: item,
		data: item.data,
		ownerModel,
		targetModel,
		relation
	});
	if (ancestor === undefined && targetModel.datastore?.ancestor) {
		throw new ActiveTsConfigurationError(
			`Relation ${ownerModel.name}.${relation.name} targets Datastore model "${targetModel.name}", so its ancestor resolver must return a Datastore key.`
		);
	}
	return ancestor === undefined
		? undefined
		: normalizeDatastoreKey(ancestor, `relation ${ownerModel.name}.${relation.name} ancestor`);
}

export function relationTargetJoinKeys(
	targetModel: ResolvedModelMeta,
	relation: RelationMeta,
	foreignValue: unknown,
	data: Record<string, any>,
	context: string
) {
	const joinKey = portableScalarKey(foreignValue, `${context} relation key`);
	let targetJoinKey = joinKey;
	const ancestorFields = targetModel.datastore?.ancestorFields;
	if (ancestorFields?.length) {
		let scopedJoinKey = `${joinKey}:datastore`;
		let hasAncestorFields = true;
		for (let fieldIndex = 0; fieldIndex < ancestorFields.length; fieldIndex++) {
			const field = ancestorFields[fieldIndex];
			const value = field === relation.foreignKey ? foreignValue : valueFor(data, field);
			if (value === undefined) {
				hasAncestorFields = false;
				break;
			}
			const fieldKey = `${field.length}:${field}`;
			const valueKey = portableScalarKey(value, `${context} relation key Datastore ancestor field "${field}"`);
			scopedJoinKey += `:${fieldKey}:${valueKey.length}:${valueKey}`;
		}
		if (hasAncestorFields) targetJoinKey = scopedJoinKey;
	}
	return { joinKey, targetJoinKey };
}

export function assertUnambiguousDatastoreRelationFallback(
	ownerModel: ResolvedModelMeta,
	targetModel: ResolvedModelMeta,
	relation: RelationMeta,
	ownerJoinKeys: { joinKey: string; targetJoinKey: string },
	matches: readonly unknown[]
) {
	if (relation.kind !== 'one') return;
	if (ownerJoinKeys.targetJoinKey !== ownerJoinKeys.joinKey) return;
	if (!targetModel.datastore?.ancestor) return;
	if (matches.length <= 1) return;
	const missing = targetModel.datastore.ancestorFields?.length ? 'fields' : 'metadata';
	throw new ActiveTsValidationError(
		`Relation ${ownerModel.name}.${relation.name} cannot choose one ${targetModel.name} result because owner data lacks target Datastore ancestor ${missing} and ${matches.length} candidates matched the relation key.`
	);
}

function inferRelationDatastoreAncestor(
	ownerModel: ResolvedModelMeta,
	targetModel: ResolvedModelMeta,
	relation: RelationMeta,
	item: any
) {
	const resolver = targetModel.datastore?.ancestor;
	if (!resolver) return undefined;
	const ancestorFields = targetModel.datastore?.ancestorFields;
	if (ancestorFields === undefined) {
		throw new ActiveTsConfigurationError(
			`Relation ${ownerModel.name}.${relation.name} targets Datastore model "${targetModel.name}", so declare relation.ancestor or datastore.ancestorFields for automatic ancestor inference.`
		);
	}
	const ownerData = item?.data;
	const localValue = valueFor(ownerData, relation.localKey);
	if (localValue === undefined || localValue === null) return undefined;
	const data: Record<string, unknown> = {};
	for (let index = 0; index < ancestorFields.length; index++) {
		const field = ancestorFields[index];
		const value = field === relation.foreignKey ? localValue : valueFor(ownerData, field);
		if (value === undefined) {
			throw new ActiveTsConfigurationError(
				`Relation ${ownerModel.name}.${relation.name} cannot infer Datastore ancestor field "${field}" for "${targetModel.name}". Declare relation.ancestor explicitly.`
			);
		}
		setInferredDataField(data, field, value);
	}
	const input = {
		model: targetModel,
		data
	} as { model: ResolvedModelMeta; data: Record<string, unknown>; id?: EntityId };
	if (relation.foreignKey === targetModel.idField) {
		assertSafeEntityId(localValue, `${ownerModel.name}.${relation.name} relation key`);
		input.id = localValue as EntityId;
	} else {
		Object.defineProperty(input, 'id', {
			enumerable: true,
			configurable: true,
			get() {
				throw new ActiveTsConfigurationError(
					`Relation ${ownerModel.name}.${relation.name} cannot infer target id for Datastore ancestor resolver on "${targetModel.name}". Declare relation.ancestor explicitly.`
				);
			}
		});
	}
	const ancestor = resolver(input as any);
	if (ancestor === undefined) {
		throw new ActiveTsConfigurationError(
			`Relation ${ownerModel.name}.${relation.name} targets Datastore model "${targetModel.name}", so its inferred ancestor resolver must return a Datastore key.`
		);
	}
	return normalizeDatastoreKey(ancestor, `relation ${ownerModel.name}.${relation.name} ancestor`);
}

function setInferredDataField(data: Record<string, unknown>, field: string, value: unknown) {
	const parts = field.split('.');
	let target = data;
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index];
		const existing = target[part];
		if (existing === undefined) {
			const next: Record<string, unknown> = {};
			target[part] = next;
			target = next;
			continue;
		}
		if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
			throw new ActiveTsConfigurationError(`Cannot infer overlapping Datastore ancestor field "${field}".`);
		}
		target = existing as Record<string, unknown>;
	}
	target[parts[parts.length - 1]] = value;
}
