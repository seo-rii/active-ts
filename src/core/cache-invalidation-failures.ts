import { ActiveTsConfigurationError } from './errors.js';
import {
	MAP_CLEAR, MAP_DELETE, MAP_GET, MAP_KEYS, MAP_SET, MAP_SIZE,
	SET_ADD, SET_CLEAR, SET_DELETE, SET_HAS, SET_SIZE,
	WEAKMAP_DELETE, WEAKMAP_GET, WEAKMAP_SET
} from './collection-intrinsics.js';

type FailureState = {
	failures: Set<string>;
	generation: number;
	recovered: Map<string, number>;
};

/** Bounded failure protection. Evicting a failed key must never make stale data readable. */
export class CacheInvalidationFailures {
	private readonly sources = new WeakMap<object, FailureState>();

	constructor(private readonly limit = 4096) {
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new ActiveTsConfigurationError('Cache invalidation failure limit must be a positive safe integer.');
		}
	}

	has(source: object, key: string) {
		const state = WEAKMAP_GET.call(this.sources, source) as FailureState | undefined;
		return state !== undefined && (SET_HAS.call(state.failures, key) ||
			(state.generation > 0 && MAP_GET.call(state.recovered, key) !== state.generation));
	}

	mark(source: object, key: string) {
		let state = WEAKMAP_GET.call(this.sources, source) as FailureState | undefined;
		if (!state) {
			state = { failures: new Set(), generation: 0, recovered: new Map() };
			WEAKMAP_SET.call(this.sources, source, state);
		}
		SET_ADD.call(state.failures, key);
		MAP_DELETE.call(state.recovered, key);
		if (SET_SIZE.call(state.failures) <= this.limit) return;
		if (!Number.isSafeInteger(state.generation) || state.generation >= Number.MAX_SAFE_INTEGER) {
			throw new ActiveTsConfigurationError('Cache invalidation failure generation is exhausted.');
		}
		// Collapse the failed-key set into an adapter-wide generation, then remember
		// only bounded successful recoveries. Unknown keys remain protected.
		state.generation++;
		SET_CLEAR.call(state.failures);
		MAP_CLEAR.call(state.recovered);
	}

	clear(source: object, key: string) {
		const state = WEAKMAP_GET.call(this.sources, source) as FailureState | undefined;
		if (!state) return;
		SET_DELETE.call(state.failures, key);
		if (state.generation === 0) {
			if (!SET_SIZE.call(state.failures)) WEAKMAP_DELETE.call(this.sources, source);
			return;
		}
		MAP_DELETE.call(state.recovered, key);
		MAP_SET.call(state.recovered, key, state.generation);
		while (MAP_SIZE.call(state.recovered) > this.limit) {
			const oldest = (MAP_KEYS.call(state.recovered) as IterableIterator<string>).next();
			if (oldest.done) break;
			MAP_DELETE.call(state.recovered, oldest.value);
		}
	}
}
