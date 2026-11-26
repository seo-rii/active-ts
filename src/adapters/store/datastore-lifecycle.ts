import { ActiveTsConfigurationError } from '../../core/errors.js';
import { datastoreMember } from './datastore-client-properties.js';

const MAP_VALUES = Map.prototype.values;

/**
 * Close the gRPC clients that an SDK-created Datastore instance opened.
 *
 * `@google-cloud/datastore` has no top-level close(). It creates one GAPIC
 * client per service on first use, caches it on the public `clients_` map,
 * and each GAPIC client exposes close(). The map is deliberately left in
 * place: closed GAPIC clients reject later calls, while an emptied map would
 * let the SDK silently open a new channel on the next request.
 *
 * Only call this for a client the adapter constructed itself.
 */
export async function closeOwnedDatastoreClient(client: object): Promise<void> {
	const clients = datastoreMember(client, 'clients_', 'Datastore client.clients_');
	if (clients === undefined) return;
	if (!(clients instanceof Map)) {
		throw new ActiveTsConfigurationError('Datastore client.clients_ must be a Map.');
	}
	const closing: Promise<unknown>[] = [];
	for (const gapic of MAP_VALUES.call(clients) as IterableIterator<unknown>) {
		if (gapic === null || typeof gapic !== 'object') continue;
		const close = datastoreMember(gapic, 'close', 'Datastore GAPIC client.close');
		if (close === undefined) continue;
		if (typeof close !== 'function') {
			throw new ActiveTsConfigurationError('Datastore GAPIC client.close must be a function.');
		}
		closing[closing.length] = Promise.resolve().then(() => close.call(gapic));
	}
	const failures: unknown[] = [];
	for (const result of await Promise.allSettled(closing)) {
		if (result.status === 'rejected') failures[failures.length] = result.reason;
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, 'Datastore client close failed.');
}
