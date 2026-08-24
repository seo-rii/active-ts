const ACTIVE_TS_TRANSACTION_ROLLBACK_SKIPPED = Symbol('active-ts.transaction-rollback-skipped');
const ACTIVE_TS_SAVEPOINT_ROLLBACK_UNCONFIRMED = Symbol('active-ts.savepoint-rollback-unconfirmed');

export function ownErrorValue(error: unknown, key: string) {
	if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
	if (!Object.prototype.hasOwnProperty.call(error, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(error, key);
	if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
	return descriptor.value;
}

export function isPlainErrorObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function markTransactionRollbackSkipped<T>(error: T): T {
	if (error && (typeof error === 'object' || typeof error === 'function')) {
		try {
			Object.defineProperty(error, ACTIVE_TS_TRANSACTION_ROLLBACK_SKIPPED, {
				value: true,
				enumerable: false,
				configurable: true
			});
		} catch {
			// Keep the original transaction failure authoritative even for non-extensible errors.
		}
	}
	return error;
}

export function transactionRollbackSkipped(error: unknown): boolean {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
	const descriptor = Object.getOwnPropertyDescriptor(error, ACTIVE_TS_TRANSACTION_ROLLBACK_SKIPPED);
	return descriptor !== undefined && 'value' in descriptor && descriptor.value === true;
}

export function markSavepointRollbackUnconfirmed<T>(error: T): T {
	if (error && (typeof error === 'object' || typeof error === 'function')) {
		try {
			Object.defineProperty(error, ACTIVE_TS_SAVEPOINT_ROLLBACK_UNCONFIRMED, {
				value: true,
				enumerable: false,
				configurable: true
			});
		} catch {
			// Keep the original savepoint failure authoritative even for non-extensible errors.
		}
	}
	return error;
}

export function savepointRollbackUnconfirmed(error: unknown): boolean {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
	const descriptor = Object.getOwnPropertyDescriptor(error, ACTIVE_TS_SAVEPOINT_ROLLBACK_UNCONFIRMED);
	return descriptor !== undefined && 'value' in descriptor && descriptor.value === true;
}

export function clearSavepointRollbackUnconfirmed<T>(error: T): T {
	if (error && (typeof error === 'object' || typeof error === 'function')) {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(error, ACTIVE_TS_SAVEPOINT_ROLLBACK_UNCONFIRMED);
			if (descriptor && 'value' in descriptor && descriptor.value === true) {
				Object.defineProperty(error, ACTIVE_TS_SAVEPOINT_ROLLBACK_UNCONFIRMED, {
					value: false,
					enumerable: false,
					configurable: true
				});
			}
		} catch {
			// Preserve the original error when rollback classification cannot be updated.
		}
	}
	return error;
}
