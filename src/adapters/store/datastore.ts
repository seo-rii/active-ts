// The convenience entry can load the optional SDK. The injected entry has no loader dependency.
import { optionalImport } from '../../core/optional-import.js';
import {
  createDatastoreStoreAdapter as createAdapter,
  createDatastoreNamespaceStoreFactory as createFactory,
  inventoryDatastoreIds as inventory,
  type DatastoreStoreOptions,
  type DatastoreNamespaceStoreFactoryOptions,
  type DatastoreIdInventoryOptions
} from './datastore-runtime.js';
export * from './datastore-runtime.js';

const loadSdk = () => optionalImport('@google-cloud/datastore', 'DatastoreStoreAdapter');

export function createDatastoreStoreAdapter(options: DatastoreStoreOptions = {}) {
  return createAdapter(options, loadSdk);
}
export function createDatastoreNamespaceStoreFactory(options: DatastoreNamespaceStoreFactoryOptions = {}) {
  return createFactory(options, loadSdk);
}
export function inventoryDatastoreIds(options: DatastoreIdInventoryOptions) {
  return inventory(options, loadSdk);
}
