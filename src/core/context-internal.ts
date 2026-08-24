import { AsyncLocalStorage } from 'node:async_hooks';
import { ActiveTsConfigurationError } from './errors.js';
import type { ActiveContext } from './context.js';
import type { CacheAdapter, SearchAdapter, StoreAdapter } from './types.js';

export type ActiveContextInternalAccess = {
	store(name: string): StoreAdapter;
	cache(name: string): CacheAdapter | undefined;
	searchAdapter(name: string): SearchAdapter;
	assertWritable(operation: string): void;
	markRollbackOnly(error: unknown): void;
	trackOperation<T>(run: () => Promise<T>): Promise<T>;
};

export const ACTIVE_CONTEXT_INTERNALS = Symbol('active-ts.context-internals');
export const transactionContextStorage = new AsyncLocalStorage<ActiveContext>();
const SAFE_PROMISE = Promise;
const SAFE_PROMISE_REJECT = SAFE_PROMISE.reject.bind(SAFE_PROMISE);

type ActiveContextWithInternals = {
	[ACTIVE_CONTEXT_INTERNALS]?: () => ActiveContextInternalAccess;
};

function activeContextInternals(context: ActiveContext) {
	const access = (context as unknown as ActiveContextWithInternals)[ACTIVE_CONTEXT_INTERNALS];
	if (typeof access !== 'function') {
		throw new ActiveTsConfigurationError('ActiveContext internal adapter access is unavailable.');
	}
	return access.call(context);
}

export function contextInternalStore(context: ActiveContext, name: string) {
	return activeContextInternals(context).store(name);
}

export function contextInternalCache(context: ActiveContext, name: string) {
	return activeContextInternals(context).cache(name);
}

export function contextInternalSearchAdapter(context: ActiveContext, name: string) {
	return activeContextInternals(context).searchAdapter(name);
}

export function assertContextTransactionWritable(context: ActiveContext, operation: string) {
	activeContextInternals(context).assertWritable(operation);
}

export function markContextTransactionRollbackOnly(context: ActiveContext, error: unknown) {
	activeContextInternals(context).markRollbackOnly(error);
}

export function trackContextOperation<T>(context: ActiveContext, run: () => Promise<T>): Promise<T> {
	return activeContextInternals(context).trackOperation(run);
}

export function runTrackedContextOperation<T>(
	resolveContext: () => ActiveContext,
	run: (context: ActiveContext) => Promise<T>
): Promise<T> {
	let context: ActiveContext;
	try {
		context = resolveContext();
	} catch (error) {
		return SAFE_PROMISE_REJECT(error);
	}
	try {
		return trackContextOperation(context, () => run(context));
	} catch (error) {
		return SAFE_PROMISE_REJECT(error);
	}
}

export function currentTransactionContext() {
	return transactionContextStorage.getStore();
}
