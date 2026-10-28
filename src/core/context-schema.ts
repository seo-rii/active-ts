import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { searchCapability, storeCapability } from './capabilities.js';
import { assertSafeFieldPath, assertSafeSchemaIdentifier } from './safe-keys.js';
import { assertNoOverlappingFieldPaths } from './query-utils.js';
import { datastoreSchemaAncestorModes, normalizeSchemaPlan } from './schema-utils.js';
import { dateIsoString } from './date-intrinsics.js';
import type { ResolvedModelMeta, SchemaChange, SchemaPlan, SearchAdapter, SortDirection, StoreAdapter } from './types.js';

type SchemaGroups = Iterable<[string, ResolvedModelMeta[]]>;

/** Owns schema execution policy; the context retains routing and transaction lifetime guards. */
export async function executeSchemaGroups(
	stores: SchemaGroups,
	searchGroups: () => SchemaGroups,
	storeFor: (name: string) => StoreAdapter,
	searchFor: (name: string) => SearchAdapter,
	mode?: 'safe'
): Promise<SchemaPlan[]> {
	const plans: SchemaPlan[] = [];
	const action = mode === undefined ? 'schema plan' : 'schema apply plan';
	for (const [name, models] of stores) {
		const store = storeFor(name);
		assertStoreSchemaModelsSupported(store, models);
		const schema = store.schema;
		if (schema) {
			const result = mode === undefined ? await schema.plan(models) : await schema.apply(models, { mode });
			const plan = routeSchemaPlan(normalizeSchemaPlan(result, `Store adapter "${name}" ${action}`), name);
			assertStoreSchemaPlanSupported(store, plan);
			plans.push(plan);
		} else {
			const plan = manualStoreSchemaPlan(name, store, models);
			if (plan.changes.length) plans.push(plan);
		}
	}
	// Defer search grouping until store execution completes, preserving facade error ordering.
	for (const [name, models] of searchGroups()) {
		const adapter = searchFor(name);
		const schema = adapter.schema;
		if (schema || (mode !== undefined && adapter.syncSchema)) {
			const label = `Search adapter "${name}" ${schema ? action : 'legacy schema apply plan'}`;
			const result = schema
				? mode === undefined ? await schema.plan(models) : await schema.apply(models, { mode })
				: await adapter.syncSchema!(models);
			const plan = routeSchemaPlan(normalizeSchemaPlan(result, label), name);
			assertSearchSchemaPlanSupported(adapter, plan);
			assertSearchSchemaPlanModelInvariants(plan, models, label);
			plans.push(plan);
		} else {
			const plan = manualSearchSchemaPlan(name, adapter, models);
			if (plan.changes.length) plans.push(plan);
		}
	}
	return plans;
}

export function createSchemaMigration(name: string, plans: SchemaPlan[]) {
	const changes: Array<SchemaChange & { adapter: string }> = [];
	for (let planIndex = 0; planIndex < plans.length; planIndex++) {
		const plan = plans[planIndex];
		const adapter = plan.route ?? plan.adapter;
		for (let changeIndex = 0; changeIndex < plan.changes.length; changeIndex++) {
			changes[changes.length] = { adapter, ...plan.changes[changeIndex] };
		}
	}
	const summary: string[] = [];
	for (let index = 0; index < changes.length; index++) {
		const change = changes[index];
		summary[index] = `${change.adapter}:${change.type}:${change.target}`;
	}
	return { name, createdAt: dateIsoString(new Date()), plans, changes, empty: changes.length === 0, summary };
}

export function assertStoreSchemaPlanSupported(store: StoreAdapter, plan: SchemaPlan) {
	if (storeCapability(store.capabilities, 'uniqueIndex')) return;
	for (const change of plan.changes) {
		if (change.type !== 'create-index' || change.unique !== true) continue;
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" does not support unique indexes in schema plans. Unsupported index "${change.name}" on "${change.target}".`
		);
	}
}

export function assertStoreSchemaModelsSupported(store: StoreAdapter, models: ResolvedModelMeta[]) {
	const unique = firstUniqueIndexModel(models);
	if (!unique) return;
	if (!storeCapability(store.capabilities, 'uniqueIndex')) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" does not support unique indexes in schema plans. Unsupported index "${unique.index.name}" on "${unique.model.name}".`
		);
	}
	if (!store.schema) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" advertises unique indexes but does not expose schema planning. Unsupported index "${unique.index.name}" on "${unique.model.name}".`
		);
	}
}

function manualStoreSchemaPlan(route: string, store: StoreAdapter, models: ResolvedModelMeta[]): SchemaPlan {
	const changes: SchemaPlan['changes'] = [];
	const datastoreIndexes = storeCapability(store.capabilities, 'datastoreAncestor');
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		const ancestorModes: readonly (boolean | undefined)[] = datastoreIndexes
			? datastoreSchemaAncestorModes(model.datastore?.ancestor !== undefined)
			: [undefined];
		for (let modeIndex = 0; modeIndex < ancestorModes.length; modeIndex++) {
			const ancestor = ancestorModes[modeIndex];
			for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
				const index = model.indexes[indexIndex];
				const runtimeIndex = datastoreIndexes
					? datastoreRuntimeSchemaIndex(model, index.fields, index.directions)
					: { fields: index.fields, directions: index.directions };
				changes[changes.length] = {
					type: 'create-index' as const,
					target: model.name,
					name: index.name,
					fields: runtimeIndex.fields,
					...(runtimeIndex.directions === undefined ? {} : { directions: runtimeIndex.directions }),
					...(ancestor === undefined ? {} : { ancestor }),
					unique: index.unique
				};
			}
		}
	}
	return routeSchemaPlan(
		normalizeSchemaPlan(
			{
				adapter: store.kind,
				status: 'manual',
				note: `Store adapter "${route}" does not expose schema planning. Apply declared indexes manually or use an adapter with schema hooks.`,
				changes
			},
			`Store adapter "${route}" manual schema plan`
		),
		route
	);
}

function datastoreRuntimeSchemaIndex(
	model: ResolvedModelMeta,
	rawFields: readonly string[],
	rawDirections: readonly SortDirection[] | undefined
) {
	const fields: string[] = [];
	for (let index = 0; index < rawFields.length; index++) {
		fields[index] = assertSafeDatastoreSchemaField(rawFields[index], 'Datastore schema index field');
	}
	const directions = schemaIndexDirections(rawDirections, fields.length);
	let hasIdField = false;
	for (let index = 0; index < fields.length; index++) {
		if (fields[index] !== model.idField) continue;
		hasIdField = true;
		break;
	}
	if (!hasIdField) {
		fields[fields.length] = assertSafeDatastoreSchemaField(model.idField, 'Datastore schema index field');
		directions[directions.length] = 'asc';
	}
	return { fields, directions };
}

function assertSafeDatastoreSchemaField(field: unknown, context: string) {
	const safeField = assertSafeFieldPath(field, context);
	if (safeField.includes('/')) throw new ActiveTsValidationError(`${context} "${safeField}" cannot contain "/".`);
	return safeField;
}

function schemaIndexDirections(directions: readonly SortDirection[] | undefined, fieldCount: number) {
	const safeDirections: SortDirection[] = [];
	for (let index = 0; index < fieldCount; index++) safeDirections[index] = directions?.[index] ?? 'asc';
	return safeDirections;
}

function manualSearchSchemaPlan(route: string, adapter: SearchAdapter, models: ResolvedModelMeta[]): SchemaPlan {
	const changes: SchemaPlan['changes'] = [];
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		for (let indexIndex = 0; indexIndex < model.searchIndexes.length; indexIndex++) {
			const index = model.searchIndexes[indexIndex];
			changes[changes.length] = {
				type: 'create-search-index' as const,
				target: model.name,
				name: index.name,
				fields: index.fields
			};
		}
	}
	assertSearchSchemaIndexingSupported(adapter, changes, route);
	return routeSchemaPlan(
		normalizeSchemaPlan(
			{
				adapter: adapter.kind,
				status: 'manual',
				note: `Search adapter "${route}" does not expose schema planning. Apply declared search indexes manually or use an adapter with schema hooks.`,
				changes
			},
			`Search adapter "${route}" manual schema plan`
		),
		route
	);
}

function firstUniqueIndexModel(models: ResolvedModelMeta[]) {
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
			const index = model.indexes[indexIndex];
			if (index.unique === true) return { model, index };
		}
	}
	return undefined;
}

export function assertSearchSchemaPlanSupported(adapter: SearchAdapter, plan: SchemaPlan) {
	assertSearchSchemaIndexingSupported(adapter, plan.changes, plan.route ?? adapter.kind);
}

export function assertSearchSchemaPlanModelInvariants(plan: SchemaPlan, models: ResolvedModelMeta[], context: string) {
	for (let index = 0; index < plan.changes.length; index++) {
		const change = plan.changes[index];
		if (change.type !== 'create-search-index') continue;
		const model = schemaPlanTargetModel(models, change.target);
		if (!model) continue;
		assertNoOverlappingFieldPaths(
			[model.idField, ...change.fields, ...(model.datastore?.ancestorFields ?? [])],
			`${context}.changes[${index}].fields`
		);
	}
}

function schemaPlanTargetModel(models: ResolvedModelMeta[], target: string) {
	for (let index = 0; index < models.length; index++) {
		if (models[index].name === target) return models[index];
	}
	return undefined;
}

function assertSearchSchemaIndexingSupported(
	adapter: SearchAdapter,
	changes: SchemaPlan['changes'],
	route: string
) {
	if (!hasCreateSearchIndexChange(changes)) return;
	if (searchCapability(adapter.capabilities, 'index')) return;
	throw new ActiveTsConfigurationError(
		`Search adapter "${route}" does not support indexing and cannot plan search indexes.`
	);
}

function hasCreateSearchIndexChange(changes: SchemaPlan['changes']) {
	for (let index = 0; index < changes.length; index++) {
		if (changes[index].type === 'create-search-index') return true;
	}
	return false;
}

function routeSchemaPlan(plan: SchemaPlan, route: string): SchemaPlan {
	return {
		...plan,
		route: assertSafeSchemaIdentifier(route, 'schema adapter route')
	};
}
