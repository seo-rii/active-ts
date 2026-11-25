// Batch acknowledgement, release, and recovery of drained events.
import { ActiveTsConfigurationError } from './errors.js';
import { assertDenseArrayItems, defineDataProperty } from './safe-keys.js';
import { cloneDate, dateTime } from './date-intrinsics.js';
import { SET_ADD, SET_HAS, WEAKMAP_GET, WEAKMAP_HAS, WEAKMAP_SET } from './collection-intrinsics.js';
import { OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, OBJECT_GET_OWN_PROPERTY_NAMES, OBJECT_GET_OWN_PROPERTY_SYMBOLS, OBJECT_GET_PROTOTYPE_OF } from './object-intrinsics.js';
import type { OutboxAdapter, OutboxDrainRecoverySnapshot, OutboxEvent } from './outbox-types.js';
import { sanitizeOutboxDrainResult, sanitizeOutboxEvent } from './outbox-validation.js';
import { snapshotOutboxDeliveryIdentity } from './outbox-protocol.js';

export async function captureOutboxDrainRecoverySnapshot(outbox: OutboxAdapter): Promise<OutboxDrainRecoverySnapshot> {
	if (!outbox.list) return { captured: false };
	try {
		return { captured: true, value: await outbox.list() };
	} catch (error) {
		return { captured: false, error };
	}
}

export async function recoverFailedOutboxDrain(
	outbox: OutboxAdapter,
	snapshot: OutboxDrainRecoverySnapshot
) {
	if (!snapshot.captured) return snapshot.error === undefined ? [] : [snapshot.error];
	if (!outbox.list) return [];
	const errors: unknown[] = [];
	let before: OutboxEvent[];
	let after: OutboxEvent[];
	try {
		before = sanitizeOutboxDrainResult(snapshot.value);
	} catch (error) {
		return [error];
	}
	try {
		after = sanitizeOutboxDrainResult(await outbox.list());
	} catch (error) {
		return [error];
	}
	const currentIds = new Set<string>();
	for (const event of after) {
		try {
			SET_ADD.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length) return errors;
	const missing: OutboxEvent[] = [];
	let firstCurrentIndex = -1;
	let lastCurrentIndex = -1;
	for (let index = 0; index < before.length; index++) {
		const event = before[index];
		try {
			const id = sanitizeOutboxEvent(event, { requireModelId: false }).id;
			if (SET_HAS.call(currentIds, id)) {
				if (firstCurrentIndex < 0) firstCurrentIndex = index;
				lastCurrentIndex = index;
			} else {
				missing[missing.length] = event;
			}
		} catch {
			missing[missing.length] = event;
		}
	}
	if (firstCurrentIndex >= 0) {
		const prefix: OutboxEvent[] = [];
		for (let index = 0; index < firstCurrentIndex; index++) {
			const event = before[index];
			try {
				if (!SET_HAS.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id)) {
					prefix[prefix.length] = event;
				}
			} catch {
				prefix[prefix.length] = event;
			}
		}
		const suffix: OutboxEvent[] = [];
		for (let index = lastCurrentIndex + 1; index < before.length; index++) {
			const event = before[index];
			try {
				if (!SET_HAS.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id)) {
					suffix[suffix.length] = event;
				}
			} catch {
				suffix[suffix.length] = event;
			}
		}
		const middleMissing: OutboxEvent[] = [];
		for (let index = firstCurrentIndex + 1; index < lastCurrentIndex; index++) {
			const event = before[index];
			try {
				if (!SET_HAS.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id)) {
					middleMissing[middleMissing.length] = event;
				}
			} catch {
				middleMissing[middleMissing.length] = event;
			}
		}
		const recoveryErrors = await requeueOutboxEvents(outbox, [...prefix, ...middleMissing]);
		recoveryErrors.push(...await appendOutboxEvents(outbox, suffix));
		return recoveryErrors;
	}
	return await requeueOutboxEvents(outbox, missing);
}

export async function recoverOverflowedOutboxBatch(
	outbox: OutboxAdapter,
	events: OutboxEvent[],
	usesLease: boolean,
	snapshot: OutboxDrainRecoverySnapshot | undefined
) {
	if (usesLease) return await releaseOutboxEvents(outbox, events);
	if (snapshot) return await recoverFailedOutboxDrain(outbox, snapshot);
	return await requeueOutboxEvents(outbox, events);
}

export async function requeueOutboxEvents(outbox: OutboxAdapter, events: unknown[]) {
	const errors: unknown[] = [];
	const snapshots: OutboxEvent[] = [];
	for (const event of events) {
		try {
			snapshots.push(snapshotOutboxEventForRequeue(event));
		} catch (error) {
			errors.push(error);
		}
	}
	if (!snapshots.length) return errors;
	if (outbox.requeue) {
		try {
			await outbox.requeue(snapshots);
		} catch (error) {
			errors.push(error);
		}
		return errors;
	}
	for (const event of snapshots) {
		try {
			await outbox.append(event);
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

export async function appendOutboxEvents(outbox: OutboxAdapter, events: OutboxEvent[]) {
	const errors: unknown[] = [];
	for (const event of events) {
		try {
			await outbox.append(snapshotOutboxEventForRequeue(event));
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

export async function ackOutboxEvents(outbox: OutboxAdapter, events: OutboxEvent[]) {
	return await ackOutboxSnapshots(outbox, events);
}

export async function ackOutboxSnapshots(outbox: OutboxAdapter, events: unknown[]) {
	if (!outbox.ack) {
		throw new ActiveTsConfigurationError('Outbox adapter does not support ack().');
	}
	const snapshots: OutboxEvent[] = [];
	for (let index = 0; index < events.length; index++) {
		try {
			snapshots[snapshots.length] = sanitizeOutboxEvent(events[index], { requireModelId: false });
		} catch (error) {
			const identity = snapshotOutboxDeliveryIdentity(events[index], index);
			if (!identity.releaseSnapshot) throw error;
			snapshots[snapshots.length] = identity.releaseSnapshot;
		}
	}
	return (await outbox.ack(snapshots)) !== false;
}

export async function releaseOutboxEvents(outbox: OutboxAdapter, events: unknown[]) {
	if (!outbox.release) return [];
	const errors: unknown[] = [];
	const snapshots: OutboxEvent[] = [];
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		try {
			snapshots.push(sanitizeOutboxEvent(event, { requireModelId: false }));
		} catch (error) {
			const identity = snapshotOutboxDeliveryIdentity(event, index);
			if (identity.releaseSnapshot) snapshots.push(identity.releaseSnapshot);
			else errors.push(error);
		}
	}
	if (!snapshots.length) return errors;
	try {
		await outbox.release(snapshots);
	} catch (error) {
		errors.push(error);
	}
	return errors;
}

export function snapshotOutboxEventForRequeue(event: unknown): OutboxEvent {
	try {
		return sanitizeOutboxEvent(event, { requireModelId: false });
	} catch {
		return snapshotRequeueValue(event, new WeakMap(), 'Outbox requeue event') as OutboxEvent;
	}
}

export function snapshotRequeueValue(value: unknown, seen: WeakMap<object, unknown>, context: string): unknown {
	if (!value || typeof value !== 'object') return snapshotRequeuePrimitive(value, context);
	if (value instanceof Date) {
		if (!Number.isFinite(dateTime(value))) {
			throw new ActiveTsConfigurationError(`${context} must contain valid Date values for requeue snapshotting.`);
		}
		assertNoRequeueBuiltInCustomProperties(value, context);
		return cloneDate(value);
	}
	if (value instanceof Uint8Array) {
		assertNoRequeueBuiltInCustomProperties(value, context, value.length);
		return new Uint8Array(value);
	}
	if (WEAKMAP_HAS.call(seen, value)) return WEAKMAP_GET.call(seen, value);
	if (Array.isArray(value)) {
		assertRequeueArrayShape(value, context);
		const clone: unknown[] = [];
		WEAKMAP_SET.call(seen, value, clone);
		for (let index = 0; index < value.length; index++) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index))!;
			clone[index] = snapshotRequeueValue(descriptor.value, seen, `${context}[${index}]`);
		}
		return clone;
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be plain data for requeue snapshotting.`);
	}
	const clone = Object.create(prototype) as Record<string, unknown>;
	WEAKMAP_SET.call(seen, value, clone);
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
		defineDataProperty(clone, key, snapshotRequeueValue(descriptor.value, seen, `${context}.${key}`), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return clone;
}

export function snapshotRequeuePrimitive(value: unknown, context: string) {
	if (
		value === undefined ||
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new ActiveTsConfigurationError(`${context} must contain finite numbers for requeue snapshotting.`);
		}
		return value;
	}
	throw new ActiveTsConfigurationError(`${context} must contain plain data for requeue snapshotting.`);
}

export function assertNoRequeueBuiltInCustomProperties(value: object, context: string, allowedIndexLength?: number) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		if (allowedIndexLength !== undefined && isArrayIndexProperty(property, allowedIndexLength)) continue;
		throw new ActiveTsConfigurationError(`${context} cannot contain custom built-in property "${property}".`);
	}
}

export function assertRequeueArrayShape(value: unknown[], context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, value.length)) {
			throw new ActiveTsConfigurationError(`${context} cannot contain non-index array property "${property}".`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}[${property}] must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}[${property}] must be enumerable.`);
		}
	}
}

export function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}
