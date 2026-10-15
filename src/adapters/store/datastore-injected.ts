/** Datastore entry without runtime SDK loading. Supply client and the SDK's KEY symbol. */
import {
  createDatastoreStoreAdapter as createAdapter,
  createDatastoreNamespaceStoreFactory as createFactory,
  inventoryDatastoreIds as inventory,
  type DatastoreStoreOptions,
  type DatastoreNamespaceStoreFactoryOptions,
  type DatastoreIdInventoryOptions
} from './datastore-runtime.js';
export * from './datastore-runtime.js';

export type InjectedDatastoreStoreOptions = Omit<DatastoreStoreOptions, 'client' | 'datastoreOptions'> & {
  client: object;
  datastoreOptions?: never;
};
export type InjectedDatastoreNamespaceStoreFactoryOptions = Omit<DatastoreNamespaceStoreFactoryOptions, 'client' | 'datastoreOptions'> & {
  client: object;
  datastoreOptions?: never;
};

export function createDatastoreStoreAdapter(options: InjectedDatastoreStoreOptions) {
  return createAdapter(options);
}
export function createDatastoreNamespaceStoreFactory(options: InjectedDatastoreNamespaceStoreFactoryOptions) {
  return createFactory(options);
}
export function inventoryDatastoreIds(options: DatastoreIdInventoryOptions) {
  return inventory(options);
}
