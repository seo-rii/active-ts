import type { ActiveTsHook, ActiveTsHookName } from './types.js';
import { WEAKSET_ADD, WEAKSET_HAS } from './collection-intrinsics.js';

const softDeletePlanGuards = new WeakSet<ActiveTsHook>();

export function markSoftDeletePlanGuard<T extends ActiveTsHook>(hook: T): T {
	WEAKSET_ADD.call(softDeletePlanGuards, hook);
	return hook;
}

export function isSoftDeletePlanGuardHook(name: ActiveTsHookName, hook: ActiveTsHook) {
	return (name === 'beforeQuery' || name === 'beforeAggregate') && WEAKSET_HAS.call(softDeletePlanGuards, hook);
}
