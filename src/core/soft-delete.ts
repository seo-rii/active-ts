import { ActiveContext, getDefaultContext } from './context.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { BOUND_CONTEXT, staticMarkerValue } from './model-markers.js';
import { setPath, valueFor } from './query-utils.js';
import { markSoftDeletePlanGuard } from './soft-delete-guard.js';
import {
	assertDenseArrayItems,
	assertSafeCacheKey,
	assertSafeFieldPath,
	assertSafeSchemaIdentifier,
	cloneSafeDataObject,
	defineDataProperty
} from './safe-keys.js';
import { snapshotArrayInput } from './array-input.js';
import { dateIsoString, dateParse } from './date-intrinsics.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import type { ActiveTsHookPayload, ActiveTsPlugin, EntityId, ModelConstructor } from './types.js';

type HookPlan = NonNullable<ActiveTsHookPayload['plan']>;
type SoftDeleteConstraint =
	| { op: '='; value: null }
	| { op: 'isNull' | 'isNotNull'; value: undefined };

export type SoftDeleteOptions = {
	field?: string;
	models?: string[];
	now?: () => string;
	materializedNulls?: boolean;
};
const SOFT_DELETE_OPTION_KEYS = ['field', 'models', 'now', 'materializedNulls'] as const;

export function createSoftDeletePlugin(options: SoftDeleteOptions = {}): ActiveTsPlugin {
	options = validateSoftDeleteOptions(options);
	const field = assertSafeFieldPath(options.field ?? 'deletedAt', 'soft-delete field');
	const models = options.models ? stringSet(options.models) : undefined;
	const apply = (payload: ActiveTsHookPayload) => {
		if (!payload.model || !payload.plan) return;
		const modelName = hookModelName(payload.model);
		if (models && !SET_HAS.call(models, modelName)) return;
		const plan = hookPlan(payload.plan, 'soft-delete hook plan');
		const meta = hookPlanMeta(plan, 'soft-delete hook plan');
		const mode = meta ? hookDataProperty(meta, 'softDelete', 'soft-delete hook plan.meta') : undefined;
		if (mode === 'with') return;
		const constraint: SoftDeleteConstraint =
			mode === 'only'
				? { op: 'isNotNull', value: undefined }
				: options.materializedNulls
					? { op: '=', value: null }
					: { op: 'isNull', value: undefined };
		if (constraint.op === 'isNull') {
			setHookPlanMeta(plan, materializePlanMeta(meta, 'soft-delete hook plan.meta'));
		}
		constrainPlan(plan, field, constraint, 'soft-delete hook plan');
	};
	return {
		name: 'soft-delete',
		hooks: {
			beforeValidate(payload) {
				if (!payload.model || !payload.data || payload.operation !== 'create') return;
				const modelName = hookModelName(payload.model);
				if (models && !SET_HAS.call(models, modelName)) return;
				if (valueFor(payload.data, field) !== undefined) return;
				const data = materializeSoftDeleteNull(payload.data, field, `${modelName} soft-delete create data`);
				return data === undefined ? undefined : { data };
			},
			beforeQuery: markSoftDeletePlanGuard(apply),
			beforeAggregate: markSoftDeletePlanGuard(apply)
		}
	};
}

export async function softDelete<TModel extends { data: any }>(
	model: ModelConstructor<TModel>,
	id: EntityId,
	context?: ActiveContext,
	options: SoftDeleteOptions = {}
) {
	options = validateSoftDeleteOptions(options);
	const activeContext = contextForModel(model, context);
	const field = assertSafeFieldPath(options.field ?? 'deletedAt', 'soft-delete field');
	const loaded = await activeContext.loadByIdFresh(model, id);
	if (!loaded) return null;
	setPath((loaded as any).data, field, softDeleteTimestamp(options));
	await (loaded as any).save();
	return loaded;
}

export async function restore<TModel extends { data: any }>(
	model: ModelConstructor<TModel>,
	id: EntityId,
	context?: ActiveContext,
	options: SoftDeleteOptions = {}
) {
	options = validateSoftDeleteOptions(options);
	const activeContext = contextForModel(model, context);
	const field = assertSafeFieldPath(options.field ?? 'deletedAt', 'soft-delete field');
	const loaded = await activeContext.loadByIdFresh(model, id);
	if (!loaded) return null;
	setPath((loaded as any).data, field, null);
	await (loaded as any).save();
	return loaded;
}

function constrainWhere(where: HookPlan['where'], field: string, constraint: SoftDeleteConstraint, context: string) {
	assertDenseArrayItems(where, context);
	for (let index = 0; index < where.length; index++) {
		const item = hookArrayItem(where, index, context);
		const entry = hookPlan(item, `${context}[${index}]`);
		if (
			hookDataProperty(entry, 'field', `${context}[${index}]`) === field &&
			hookDataProperty(entry, 'op', `${context}[${index}]`) === constraint.op &&
			(constraint.op !== '=' || hookDataProperty(entry, 'value', `${context}[${index}]`) === null)
		) {
			return;
		}
	}
	if (!Object.isExtensible(where)) {
		throw new ActiveTsValidationError(`${context} must be extensible for soft-delete constraints.`);
	}
	assertHookArrayAppendable(where, context);
	Array.prototype.push.call(where, { field, op: constraint.op, value: constraint.value });
}

function constrainPlan(plan: HookPlan, field: string, constraint: SoftDeleteConstraint, context: string) {
	const where = hookPlanArray(plan, 'where', `${context}.where`) as HookPlan['where'];
	const or = hookPlanArray(plan, 'or', `${context}.or`) as HookPlan['or'];
	if (where.length || !or.length) constrainWhere(where, field, constraint, `${context}.where`);
	for (let index = 0; index < or.length; index++) {
		constrainPlan(
			hookPlan(hookArrayItem(or, index, `${context}.or`), `${context}.or[${index}]`),
			field,
			constraint,
			`${context}.or[${index}]`
		);
	}
}

function materializeSoftDeleteNull(data: unknown, field: string, context: string) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
	if (Object.getOwnPropertySymbols(data).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertOwnEnumerableDataProperties(data, context);
	const next: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(data)) {
		const descriptor = Object.getOwnPropertyDescriptor(data, key);
		if (!descriptor || !('value' in descriptor)) throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
		defineDataProperty(next, key, descriptor.value, { enumerable: true, configurable: true, writable: true });
	}
	const clean = cloneSafeDataObject(next, context);
	setPath(clean, field, null);
	return clean;
}

function hookModelName(model: unknown) {
	return assertSafeSchemaIdentifier(
		hookDataProperty(hookPlan(model, 'soft-delete hook model'), 'name', 'soft-delete hook model'),
		'soft-delete hook model name'
	);
}

function hookPlan(value: unknown, context: string): HookPlan {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertOwnEnumerableDataProperties(value, context);
	return value as HookPlan;
}

function hookPlanArray(plan: HookPlan, key: 'where' | 'or', context: string) {
	const value = hookDataProperty(plan, key, 'soft-delete hook plan');
	if (!Array.isArray(value)) throw new ActiveTsValidationError(`${context} must be an array.`);
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	return value;
}

function hookPlanMeta(plan: HookPlan, context: string) {
	const meta = hookDataProperty(plan, 'meta', context);
	if (meta === undefined) return undefined;
	return hookPlainRecord(meta, `${context}.meta`);
}

function hookPlainRecord(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertOwnEnumerableDataProperties(value, context);
	return value as Record<string, unknown>;
}

function hookArrayItem(array: readonly unknown[], index: number, context: string) {
	const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
	}
	return descriptor.value;
}

function assertHookArrayAppendable(array: readonly unknown[], context: string) {
	const descriptor = Object.getOwnPropertyDescriptor(array, 'length');
	if (!descriptor || !('value' in descriptor) || descriptor.writable === false) {
		throw new ActiveTsValidationError(`${context}.length must be writable for soft-delete constraints.`);
	}
}

function materializePlanMeta(meta: Record<string, unknown> | undefined, context: string) {
	const next: Record<string, unknown> = {};
	if (meta) {
		assertOwnEnumerableDataProperties(meta, context);
		for (const key of Object.getOwnPropertyNames(meta)) {
			defineDataProperty(next, key, hookDataProperty(meta, key, context), {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
	}
	defineDataProperty(next, 'requiresMissingFieldNulls', true, { enumerable: true, configurable: true, writable: true });
	return next;
}

function assertOwnEnumerableDataProperties(record: object, context: string) {
	for (const key of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
		}
	}
}

function setHookPlanMeta(plan: HookPlan, meta: Record<string, unknown>) {
	const descriptor = Object.getOwnPropertyDescriptor(plan, 'meta');
	if (descriptor && (!('value' in descriptor) || descriptor.writable === false)) {
		throw new ActiveTsValidationError('soft-delete hook plan.meta must be a writable data property.');
	}
	if (!descriptor && !Object.isExtensible(plan)) {
		throw new ActiveTsValidationError('soft-delete hook plan must be extensible for soft-delete metadata.');
	}
	defineDataProperty(plan, 'meta', meta, { enumerable: true, configurable: true, writable: true });
}

function hookDataProperty(record: object, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
	}
	return descriptor.value;
}

function validateSoftDeleteOptions(options: SoftDeleteOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Soft-delete options must be an object.');
	}
	assertPlainOptions(options, 'Soft-delete options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Soft-delete options');
	assertKnownOptions(record, SOFT_DELETE_OPTION_KEYS, 'Soft-delete options');
	const field = ownOptionValue(record, 'field', 'Soft-delete options');
	const models = ownOptionValue(record, 'models', 'Soft-delete options');
	const now = ownOptionValue(record, 'now', 'Soft-delete options');
	const materializedNulls = ownOptionValue(record, 'materializedNulls', 'Soft-delete options');
	if (models !== undefined) {
		if (!Array.isArray(models)) {
			throw new ActiveTsConfigurationError('Soft-delete models must be an array.');
		}
		for (const model of snapshotArrayInput(models, 'Soft-delete models')) {
			assertSafeSchemaIdentifier(model, 'soft-delete model name');
		}
	}
	if (now !== undefined && typeof now !== 'function') {
		throw new ActiveTsConfigurationError('Soft-delete now must be a function.');
	}
	if (materializedNulls !== undefined && typeof materializedNulls !== 'boolean') {
		throw new ActiveTsConfigurationError('Soft-delete materializedNulls must be a boolean.');
	}
	return {
		field: field as string | undefined,
		models: models === undefined ? undefined : snapshotArrayInput<string>(models, 'Soft-delete models'),
		now: now as (() => string) | undefined,
		materializedNulls: materializedNulls as boolean | undefined
	};
}

function softDeleteTimestamp(options: SoftDeleteOptions) {
	validateSoftDeleteOptions(options);
	const timestamp = (options.now ?? (() => dateIsoString(new Date())))();
	return assertCanonicalSoftDeleteTimestamp(timestamp);
}

function assertCanonicalSoftDeleteTimestamp(value: unknown) {
	const text = assertSafeCacheKey(value, 'soft-delete timestamp');
	const timestamp = dateParse(text);
	if (!Number.isFinite(timestamp) || dateIsoString(new Date(timestamp)) !== text) {
		throw new ActiveTsValidationError('soft-delete timestamp must be a canonical ISO timestamp.');
	}
	return text;
}

function contextForModel(model: ModelConstructor, explicit?: ActiveContext) {
	const context = staticMarkerValue(model, BOUND_CONTEXT);
	if (context !== undefined && !(context instanceof ActiveContext)) {
		throw new ActiveTsConfigurationError('Model bound context marker must be an ActiveContext.');
	}
	return (explicit ?? (context as ActiveContext | undefined) ?? getDefaultContext()).transactionScopedContext('soft-delete models');
}

function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

function assertPlainOptions(value: object, context: string) {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
}

function assertKnownOptions(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = stringSet(allowed);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function ownOptionValue(record: Record<string, unknown>, key: string, context: string) {
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
