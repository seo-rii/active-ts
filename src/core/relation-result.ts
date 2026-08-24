import type { ActiveContext } from './context.js';
import { ActiveTsValidationError } from './errors.js';
import { isPartialModel } from './partial-model.js';
import { entityIdKey, portableScalarKey, valueFor } from './query-utils.js';
import { snapshotArrayInput } from './array-input.js';
import { MAP_ENTRIES, MAP_GET, MAP_SET, MAP_VALUES } from './collection-intrinsics.js';
import { assertSafeEntityId } from './safe-keys.js';
import { datastoreKeyIdentity, normalizeDatastoreKey } from './datastore-key.js';
import { MODEL_DATASTORE_WRITE_ANCESTOR } from './model-internal.js';
import { relationAncestorForOwner, relationTargetJoinKeys } from './relation-ancestor.js';
import { datastorePayloadCanResolveAncestor } from './store-options.js';
import type { DatastoreKey, EntityId, RelationMeta, ResolvedModelMeta } from './types.js';

type RelationItemSnapshot = {
	id: EntityId;
	foreignKey: string;
	partial: boolean;
	datastoreAncestor?: DatastoreKey;
};

export type RelationResultSnapshot = {
	relation: RelationMeta;
	targetMeta: ResolvedModelMeta;
	items: Map<object, RelationItemSnapshot>;
	counts: Map<object, number>;
	empty: boolean;
};

export type RelationOwnerLocalKeySnapshot = {
	ownerMeta: ResolvedModelMeta;
	targetMeta: ResolvedModelMeta;
	relation: RelationMeta;
	key: string;
	targetJoinKey?: string;
	datastoreAncestor?: DatastoreKey;
};

const MISSING_RELATION_LOCAL_KEY = 'missing:';

export function snapshotRelationResult(
	context: ActiveContext,
	relation: RelationMeta,
	result: unknown,
	label: string
): RelationResultSnapshot {
	const targetMeta = context.meta(relation.target());
	const items = new Map<object, RelationItemSnapshot>();
	const counts = new Map<object, number>();
	const list = relationResultItems(relation, result, label);
	for (const item of list) {
		const clean = context.validateModelInstance(targetMeta, item, `${label} result item`, {
			partial: isPartialModel(item as object)
		});
		const objectItem = item as object;
		MAP_SET.call(items, objectItem, {
			id: valueFor(clean, targetMeta.idField) as EntityId,
			foreignKey: relationForeignKey(clean, relation, targetMeta, label),
			partial: isPartialModel(item as object),
			datastoreAncestor: relationDatastoreAncestor(targetMeta, item, clean, label)
		});
		MAP_SET.call(counts, objectItem, (MAP_GET.call(counts, objectItem) ?? 0) + 1);
	}
	return { relation, targetMeta, items, counts, empty: list.length === 0 };
}

export function validateRelationResultSnapshot(
	context: ActiveContext,
	snapshot: RelationResultSnapshot,
	result: unknown,
	label: string
) {
	const list = relationResultItems(snapshot.relation, result, label);
	if (!list.length) {
		if (!snapshot.empty) throw new ActiveTsValidationError(`${label} result cannot remove loaded relation models.`);
		return;
	}
	const remaining = new Map<object, number>();
	for (const [item, count] of MAP_ENTRIES.call(snapshot.counts)) {
		MAP_SET.call(remaining, item, count);
	}
	for (const item of list) {
		const objectItem = item as object;
		const expected = MAP_GET.call(snapshot.items, objectItem);
		if (!expected) {
			throw new ActiveTsValidationError(`${label} result cannot contain model instances outside the loaded relation.`);
		}
		const remainingCount = MAP_GET.call(remaining, objectItem) ?? 0;
		if (remainingCount <= 0) {
			throw new ActiveTsValidationError(`${label} result cannot duplicate loaded relation models.`);
		}
		MAP_SET.call(remaining, objectItem, remainingCount - 1);
		const clean = context.validateModelInstance(snapshot.targetMeta, item, `${label} result item`, {
			expectedId: expected.id,
			partial: expected.partial
		});
		const foreignKey = relationForeignKey(clean, snapshot.relation, snapshot.targetMeta, label);
		if (foreignKey !== expected.foreignKey) {
			throw new ActiveTsValidationError(
				`${label} result item cannot change ${snapshot.targetMeta.name}.${snapshot.relation.foreignKey}.`
			);
		}
		if (expected.datastoreAncestor !== undefined && snapshot.targetMeta.datastore?.ancestor) {
			const retainedDatastoreAncestor = (item as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
			let canResolveDatastoreAncestor = true;
			if (expected.partial && retainedDatastoreAncestor !== undefined) {
				canResolveDatastoreAncestor = datastorePayloadCanResolveAncestor(
					snapshot.targetMeta,
					expected.id,
					clean,
					`${label} result item`
				);
			}
			const actualDatastoreAncestor = canResolveDatastoreAncestor
				? snapshot.targetMeta.datastore.ancestor({
						model: snapshot.targetMeta,
						id: expected.id,
						data: clean
					})
				: retainedDatastoreAncestor;
			if (!datastoreAncestorIdentitiesEqual(actualDatastoreAncestor, expected.datastoreAncestor)) {
				throw new ActiveTsValidationError(
					`${label} result item cannot move ${snapshot.targetMeta.name}:${String(expected.id)} outside the scoped Datastore ancestor.`
				);
			}
		}
	}
	for (const count of MAP_VALUES.call(remaining)) {
		if (count > 0) throw new ActiveTsValidationError(`${label} result cannot remove loaded relation models.`);
	}
}

function datastoreAncestorIdentitiesEqual(actual: DatastoreKey | undefined, expected: DatastoreKey) {
	return actual !== undefined && datastoreKeyIdentity(normalizeDatastoreKey(actual)) === datastoreKeyIdentity(expected);
}

export function snapshotRelationOwnerLocalKey(
	context: ActiveContext,
	ownerMeta: ResolvedModelMeta,
	owner: { data: Record<string, any> },
	relation: RelationMeta,
	label: string
): RelationOwnerLocalKeySnapshot {
	const targetMeta = context.meta(relation.target());
	const key = relationLocalKey(context, owner.data, relation, label);
	return {
		ownerMeta,
		targetMeta,
		relation,
		key,
		targetJoinKey: relationOwnerTargetJoinKey(targetMeta, owner.data, relation, key, label),
		datastoreAncestor: relationOwnerDatastoreAncestor(context, ownerMeta, targetMeta, owner, relation, key, label)
	};
}

export function validateRelationOwnerLocalKeySnapshot(
	context: ActiveContext,
	snapshot: RelationOwnerLocalKeySnapshot,
	owner: { data: Record<string, any> },
	label: string
) {
	const current = relationLocalKey(context, owner.data, snapshot.relation, label);
	if (current !== snapshot.key) {
		throw new ActiveTsValidationError(
			`${label} cannot change ${snapshot.ownerMeta.name}.${snapshot.relation.localKey}.`
		);
	}
	if (snapshot.targetJoinKey !== undefined) {
		const currentTargetJoinKey = relationOwnerTargetJoinKey(
			snapshot.targetMeta,
			owner.data,
			snapshot.relation,
			current,
			label
		);
		if (currentTargetJoinKey !== snapshot.targetJoinKey) {
			throw new ActiveTsValidationError(`${label} cannot change relation Datastore target join key.`);
		}
	}
	if (snapshot.datastoreAncestor !== undefined) {
		const currentAncestor = relationOwnerDatastoreAncestor(
			context,
			snapshot.ownerMeta,
			snapshot.targetMeta,
			owner,
			snapshot.relation,
			current,
			label
		);
		if (currentAncestor === undefined || datastoreKeyIdentity(currentAncestor) !== datastoreKeyIdentity(snapshot.datastoreAncestor)) {
			throw new ActiveTsValidationError(`${label} cannot change relation Datastore ancestor.`);
		}
	}
}

function relationOwnerTargetJoinKey(
	targetMeta: ResolvedModelMeta,
	data: Record<string, any>,
	relation: RelationMeta,
	key: string,
	label: string
) {
	if (!targetMeta.datastore?.ancestorFields?.length || key === MISSING_RELATION_LOCAL_KEY) return undefined;
	const localValue = valueFor(data, relation.localKey);
	if (localValue === undefined || localValue === null) return undefined;
	return relationTargetJoinKeys(
		targetMeta,
		relation,
		localValue,
		data,
		`${label} relation target`
	).targetJoinKey;
}

function relationResultItems(
	relation: RelationMeta,
	result: unknown,
	label: string
): Array<{ data: Record<string, any> }> {
	if (relation.kind === 'many') {
		if (!Array.isArray(result)) throw new ActiveTsValidationError(`${label} result must be an array.`);
		return snapshotArrayInput(result, `${label} result`) as Array<{ data: Record<string, any> }>;
	}
	if (result === null || result === undefined) return [];
	if (Array.isArray(result)) throw new ActiveTsValidationError(`${label} result must be a model instance or null.`);
	return [result as { data: Record<string, any> }];
}

function relationForeignKey(
	data: Record<string, any>,
	relation: RelationMeta,
	targetMeta: ResolvedModelMeta,
	label: string
) {
	const value = valueFor(data, relation.foreignKey);
	if (value === undefined || value === null) {
		throw new ActiveTsValidationError(`${label} result item is missing relation field "${relation.foreignKey}".`);
	}
	return relation.foreignKey === targetMeta.idField
		? entityIdKey(value as EntityId)
		: portableScalarKey(value, `${targetMeta.name}.${relation.foreignKey} relation key`);
}

function relationDatastoreAncestor(
	targetMeta: ResolvedModelMeta,
	item: { data: Record<string, any> },
	data: Record<string, any>,
	label: string
) {
	if (!targetMeta.datastore?.ancestor) return undefined;
	const id = valueFor(data, targetMeta.idField) as EntityId;
	const scoped = (item as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
	if (scoped !== undefined) return normalizeDatastoreKey(scoped, `${label} result item Datastore ancestor`);
	const ancestor = targetMeta.datastore.ancestor({ model: targetMeta, id, data });
	if (ancestor === undefined) {
		throw new ActiveTsValidationError(`${label} result item is missing Datastore ancestor metadata.`);
	}
	return normalizeDatastoreKey(ancestor, `${label} result item Datastore ancestor`);
}

function relationOwnerDatastoreAncestor(
	context: ActiveContext,
	ownerMeta: ResolvedModelMeta,
	targetMeta: ResolvedModelMeta,
	owner: { data: Record<string, any> },
	relation: RelationMeta,
	key: string,
	label: string
) {
	if (key === MISSING_RELATION_LOCAL_KEY) return undefined;
	const ancestor = relationAncestorForOwner(context, ownerMeta, targetMeta, relation, owner);
	return ancestor === undefined ? undefined : normalizeDatastoreKey(ancestor, `${label} relation Datastore ancestor`);
}

function relationLocalKey(
	context: ActiveContext,
	data: Record<string, any>,
	relation: RelationMeta,
	label: string
) {
	const value = valueFor(data, relation.localKey);
	if (value === undefined || value === null) return MISSING_RELATION_LOCAL_KEY;
	const targetMeta = context.meta(relation.target());
	if (relation.foreignKey === targetMeta.idField) {
		assertSafeEntityId(value, `${label} local relation key`);
		return entityIdKey(value as EntityId);
	}
	return portableScalarKey(value, `${label} local relation key`);
}
