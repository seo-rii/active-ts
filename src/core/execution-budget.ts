import { ActiveTsConfigurationError, ActiveTsError } from './errors.js';

export type ExecutionBudgetOptions = {
	/** The original request signal. Provider cancellation requires explicit SDK support. */
	signal?: AbortSignal;
	/** Absolute Unix time in milliseconds, shared by all attempts and adapters. */
	deadline?: number;
};

export type ExecutionBudgetState = Readonly<ExecutionBudgetOptions & {
	/** Milliseconds remaining when the operation was dispatched. */
	remainingMs?: number;
}>;

export class ActiveTsExecutionBudgetError extends ActiveTsError {
	constructor(
		readonly reason: 'aborted' | 'deadline',
		readonly phase: 'before-dispatch' | 'backoff',
		readonly cause?: unknown
	) {
		super(reason === 'aborted' ? 'Execution budget was aborted.' : 'Execution deadline cannot accommodate this operation.');
	}
}

/** A request-local, cooperative budget. In-flight operations retain their actual results. */
export class ExecutionBudget {
	readonly signal?: AbortSignal;
	readonly deadline?: number;

	constructor(options: ExecutionBudgetOptions = {}) {
		if (!options || typeof options !== 'object' || Array.isArray(options) ||
			(Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
			throw new ActiveTsConfigurationError('Execution budget options must be a plain object.');
		}
		if (Object.getOwnPropertySymbols(options).length) {
			throw new ActiveTsConfigurationError('Execution budget options cannot contain symbol fields.');
		}
		for (const key of Object.getOwnPropertyNames(options)) {
			const descriptor = Object.getOwnPropertyDescriptor(options, key)!;
			if ((key !== 'signal' && key !== 'deadline') || !('value' in descriptor) || !descriptor.enumerable) {
				throw new ActiveTsConfigurationError(`Invalid execution budget option "${key}".`);
			}
		}
		const signal = Object.getOwnPropertyDescriptor(options, 'signal')?.value;
		const deadline = Object.getOwnPropertyDescriptor(options, 'deadline')?.value;
		if (signal !== undefined && !(signal instanceof AbortSignal)) {
			throw new ActiveTsConfigurationError('Execution budget signal must be an AbortSignal.');
		}
		if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline < 0)) {
			throw new ActiveTsConfigurationError('Execution budget deadline must be a non-negative safe integer Unix timestamp.');
		}
		this.signal = signal;
		this.deadline = deadline;
	}

	get remainingMs(): number | undefined {
		return this.deadline === undefined ? undefined : Math.max(0, this.deadline - Date.now());
	}

	assertActive(phase: ActiveTsExecutionBudgetError['phase'] = 'before-dispatch'): void {
		if (this.signal?.aborted) throw new ActiveTsExecutionBudgetError('aborted', phase, this.signal.reason);
		if (this.remainingMs === 0) throw new ActiveTsExecutionBudgetError('deadline', phase);
	}

	/** Dispatch once. This does not race the result against abort/deadline or retry it. */
	async run<T>(operation: (state: ExecutionBudgetState) => Promise<T>): Promise<T> {
		if (typeof operation !== 'function') {
			throw new ActiveTsConfigurationError('Execution budget operation must be a function.');
		}
		this.assertActive();
		return await operation(Object.freeze({ signal: this.signal, deadline: this.deadline, remainingMs: this.remainingMs }));
	}

	/** Wait before an application-owned retry; reject if the full delay cannot fit. */
	async backoff(milliseconds: number): Promise<void> {
		if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
			throw new ActiveTsConfigurationError('Execution budget backoff must be a non-negative safe integer.');
		}
		this.assertActive('backoff');
		const remaining = this.remainingMs;
		if (remaining !== undefined && milliseconds >= remaining) {
			throw new ActiveTsExecutionBudgetError('deadline', 'backoff');
		}
		if (milliseconds === 0) return;
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			let left = milliseconds;
			const cleanup = () => {
				clearTimeout(timer);
				this.signal?.removeEventListener('abort', abort);
			};
			const abort = () => {
				cleanup();
				reject(new ActiveTsExecutionBudgetError('aborted', 'backoff', this.signal?.reason));
			};
			const tick = () => {
				try {
					this.assertActive('backoff');
				} catch (error) {
					cleanup();
					reject(error);
					return;
				}
				if (left === 0) {
					cleanup();
					resolve();
					return;
				}
				// Node and Workers timers use signed 32-bit delays.
				const delay = Math.min(left, 2_147_483_647);
				left -= delay;
				timer = setTimeout(tick, delay);
			};
			this.signal?.addEventListener('abort', abort, { once: true });
			tick();
		});
	}
}

export function createExecutionBudget(options: ExecutionBudgetOptions = {}): ExecutionBudget {
	return new ExecutionBudget(options);
}
