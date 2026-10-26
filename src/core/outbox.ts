// Stable public facade for outbox adapters, events, and search synchronization.
export type { OutboxOperation } from './outbox-types.js';
export type { OutboxEvent } from './outbox-types.js';
export type { OutboxEventIdentity } from './outbox-types.js';
export type { OutboxDeliveryFailure } from './outbox-types.js';
export type { OutboxAdapter } from './outbox-types.js';
export type { OutboxBatchOptions } from './outbox-types.js';
export { MemoryOutboxAdapter } from './outbox-memory.js';
export type { StoreOutboxAdapterOptions } from './outbox-types.js';
export type { StoreOutboxSchemaApplyOptions } from './outbox-types.js';
export { StoreOutboxAdapter } from './outbox-store.js';
export type { OutboxPluginOptions } from './outbox-types.js';
export { createOutboxPlugin } from './outbox-plugin.js';
export type { SearchSyncWorkerOptions } from './outbox-types.js';
export { runSearchSyncWorker } from './outbox-worker.js';
export { normalizeOutboxEvent } from './outbox-validation.js';
