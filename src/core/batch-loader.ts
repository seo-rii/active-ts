import type { EntityId } from './types.js';
import { MAP_CLEAR, MAP_GET, MAP_SET, MAP_VALUES } from './collection-intrinsics.js';
import { entityIdKey } from './query-utils.js';

type LoadMany<T> = (ids: EntityId[]) => Promise<Array<T | null>>;
type PendingBatch<T> = {
	id: EntityId;
	waiters: Array<{
		resolve: (value: T | null) => void;
		reject: (error: unknown) => void;
	}>;
};

export class BatchLoader<T> {
	private pending = new Map<string, PendingBatch<T>>();
	private scheduled = false;

	constructor(
		private readonly loadMany: LoadMany<T>,
		private readonly maxSize: number
	) {}

	load(id: EntityId) {
		const key = entityIdKey(id);
		let existing = MAP_GET.call(this.pending, key) as PendingBatch<T> | undefined;
		const promise = new Promise<T | null>((resolve, reject) => {
			if (!existing) {
				existing = { id, waiters: [] };
				MAP_SET.call(this.pending, key, existing);
			}
			existing.waiters[existing.waiters.length] = { resolve, reject };
		});
		this.schedule();
		return promise;
	}

	private schedule() {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => void this.flush());
	}

	private async flush() {
		this.scheduled = false;
		const batch = pendingBatches(this.pending);
		MAP_CLEAR.call(this.pending);
		if (!batch.length) return;
		for (const chunk of chunkItems(batch, this.maxSize)) {
			try {
				const values = await this.loadMany(chunkIds(chunk));
				for (let index = 0; index < chunk.length; index++) {
					const item = chunk[index];
					const value = values[index] ?? null;
					for (let waiterIndex = 0; waiterIndex < item.waiters.length; waiterIndex++) {
						item.waiters[waiterIndex].resolve(value);
					}
				}
			} catch (error) {
				for (let index = 0; index < chunk.length; index++) {
					const item = chunk[index];
					for (let waiterIndex = 0; waiterIndex < item.waiters.length; waiterIndex++) {
						item.waiters[waiterIndex].reject(error);
					}
				}
			}
		}
	}
}

function pendingBatches<T>(pending: Map<string, PendingBatch<T>>) {
	const batch: Array<PendingBatch<T>> = [];
	for (const item of MAP_VALUES.call(pending) as Iterable<PendingBatch<T>>) {
		batch[batch.length] = item;
	}
	return batch;
}

function chunkItems<T>(items: T[], size: number) {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		const chunk: T[] = [];
		const end = Math.min(index + size, items.length);
		for (let itemIndex = index; itemIndex < end; itemIndex++) {
			chunk[chunk.length] = items[itemIndex];
		}
		chunks[chunks.length] = chunk;
	}
	return chunks;
}

function chunkIds<T>(chunk: Array<PendingBatch<T>>) {
	const ids: EntityId[] = [];
	for (let index = 0; index < chunk.length; index++) {
		ids[ids.length] = chunk[index].id;
	}
	return ids;
}
