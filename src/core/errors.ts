import { inspect } from 'node:util';

export class ActiveTsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

export class ActiveTsConfigurationError extends ActiveTsError {}
export class ActiveTsValidationError extends ActiveTsError {}
export class ActiveTsNotFoundError extends ActiveTsError {}
export class ActiveTsConflictError extends ActiveTsError {}

export class ActiveTsUnknownTransactionOutcomeError extends ActiveTsError {
	readonly outcome = 'unknown' as const;

	constructor(
		message: string,
		readonly phase: 'commit' | 'abort',
		readonly cause: unknown
	) {
		super(message);
	}
}

export class ActiveTsCommittedWriteError extends ActiveTsError {
	readonly committed = true;

	constructor(
		message: string,
		readonly cause: unknown,
		readonly details: { model: string; operation: 'create' | 'update' | 'delete'; id?: unknown }
	) {
		super(message);
	}
}

export class ActiveTsCommittedTransactionError<T = unknown> extends ActiveTsError {
	readonly committed = true;

	constructor(
		message: string,
		readonly cause: unknown,
		readonly result: T
	) {
		super(message);
	}
}

export function safeErrorMessage(error: unknown) {
	if (error instanceof Error) {
		try {
			return typeof error.message === 'string' ? error.message : '<unprintable error message>';
		} catch {
			return '<unprintable error message>';
		}
	}
	if (error === null) return 'null';
	const type = typeof error;
	if (type !== 'object' && type !== 'function') return String(error);
	try {
		return inspect(error, { breakLength: Infinity, customInspect: false, getters: false });
	} catch {
		return '<unprintable thrown value>';
	}
}
