// In-memory outbox storage and queue mutation.
import { ActiveTsConflictError } from './errors.js';
import { snapshotArrayInput } from './array-input.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import type { OutboxAdapter, OutboxBatchOptions, OutboxDeliveryFailure, OutboxEvent } from './outbox-types.js';
import { normalizeOutboxBatchLimit, sanitizeOutboxDeliveryFailureBatch, sanitizeOutboxEvent } from './outbox-validation.js';
import { blockOutboxEntityOrderKeys, isOutboxDeliveryAvailable, outboxDeadLetterEvent, outboxEntityOrderBlockKeys, outboxEntityOrderCheckKeys, outboxEntityOrderKeysBlocked, outboxRetryEvent } from './outbox-protocol.js';

export class MemoryOutboxAdapter implements OutboxAdapter {
	private readonly events: OutboxEvent[] = [];
	private readonly deadLetters: OutboxEvent[] = [];

	async append(event: OutboxEvent): Promise<void | OutboxEvent> {
		const normalized = sanitizeOutboxEvent(event, { requireModelId: false });
		this.assertAvailableIds([normalized], 'memory outbox append event');
		this.events[this.events.length] = normalized;
		return sanitizeOutboxEvent(normalized, { requireModelId: false });
	}

	async list() {
		const list: OutboxEvent[] = [];
		for (let index = 0; index < this.events.length; index++) {
			list[index] = sanitizeOutboxEvent(this.events[index], { requireModelId: false });
		}
		return list;
	}

	async listDeadLetters() {
		const list: OutboxEvent[] = [];
		for (let index = 0; index < this.deadLetters.length; index++) {
			list[index] = sanitizeOutboxEvent(this.deadLetters[index], { requireModelId: false });
		}
		return list;
	}

	async drain(options?: OutboxBatchOptions) {
		const limit = normalizeOutboxBatchLimit(options, 'memory outbox drain options');
		const drained: OutboxEvent[] = [];
		const retained: OutboxEvent[] = [];
		const blockedEntityKeys = new Set<string>();
		const now = new Date();
		for (let index = 0; index < this.events.length; index++) {
			const event = sanitizeOutboxEvent(this.events[index], { requireModelId: false });
			if (event.deadLetteredAt !== undefined) {
				retained[retained.length] = event;
				continue;
			}
			const checkOrderKeys = outboxEntityOrderCheckKeys(event);
			const blockOrderKeys = outboxEntityOrderBlockKeys(event);
			if (
				(limit !== undefined && drained.length >= limit) ||
				outboxEntityOrderKeysBlocked(blockedEntityKeys, checkOrderKeys)
			) {
				retained[retained.length] = event;
				continue;
			}
			if (!isOutboxDeliveryAvailable(event, now)) {
				blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
				retained[retained.length] = event;
				continue;
			}
			drained[drained.length] = event;
		}
		replaceMemoryOutboxEvents(this.events, retained);
		return drained;
	}

	async requeue(events: OutboxEvent[]) {
		const safeEvents = snapshotArrayInput<OutboxEvent>(events, 'memory outbox requeue events');
		const normalized: OutboxEvent[] = [];
		for (let index = 0; index < safeEvents.length; index++) {
			normalized[index] = sanitizeOutboxEvent(safeEvents[index], { requireModelId: false });
		}
		this.assertAvailableIds(normalized, 'memory outbox requeue events');
		prependMemoryOutboxEvents(this.events, normalized);
	}

	async retry(failures: OutboxDeliveryFailure[]) {
		const normalized = sanitizeOutboxDeliveryFailureBatch(failures, 'memory outbox retry failures', true);
		const events: OutboxEvent[] = [];
		for (let index = 0; index < normalized.length; index++) {
			events[index] = outboxRetryEvent(normalized[index]);
		}
		this.assertAvailableIds(events, 'memory outbox retry failures');
		prependMemoryOutboxEvents(this.events, events);
	}

	async deadLetter(failures: OutboxDeliveryFailure[]) {
		const normalized = sanitizeOutboxDeliveryFailureBatch(failures, 'memory outbox dead-letter failures', true);
		const events: OutboxEvent[] = [];
		const existing = new Set<string>();
		for (const event of this.deadLetters) SET_ADD.call(existing, event.id);
		for (let index = 0; index < normalized.length; index++) {
			const event = outboxDeadLetterEvent(normalized[index]);
			if (SET_HAS.call(existing, event.id)) {
				throw new ActiveTsConflictError(`Memory outbox dead-letter event id "${event.id}" already exists.`);
			}
			SET_ADD.call(existing, event.id);
			events[events.length] = event;
		}
		for (const event of events) this.deadLetters[this.deadLetters.length] = event;
	}

	private assertAvailableIds(events: readonly OutboxEvent[], context: string) {
		const existing = new Set<string>();
		for (const event of this.events) SET_ADD.call(existing, event.id);
		const incoming = new Set<string>();
		for (const event of events) {
			if (SET_HAS.call(incoming, event.id)) {
				throw new ActiveTsConflictError(`${context} contains duplicate event id "${event.id}".`);
			}
			SET_ADD.call(incoming, event.id);
			if (SET_HAS.call(existing, event.id)) {
				throw new ActiveTsConflictError(`Memory outbox event id "${event.id}" already exists.`);
			}
		}
	}
}

export function replaceMemoryOutboxEvents(events: OutboxEvent[], next: readonly OutboxEvent[]) {
	events.length = 0;
	for (let index = 0; index < next.length; index++) events[index] = next[index];
}

export function prependMemoryOutboxEvents(events: OutboxEvent[], prefix: readonly OutboxEvent[]) {
	if (!prefix.length) return;
	const next: OutboxEvent[] = [];
	let write = 0;
	for (let index = 0; index < prefix.length; index++) {
		next[write] = prefix[index];
		write++;
	}
	for (let index = 0; index < events.length; index++) {
		next[write] = events[index];
		write++;
	}
	events.length = 0;
	for (let index = 0; index < next.length; index++) {
		events[index] = next[index];
	}
}
