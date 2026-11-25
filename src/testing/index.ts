// Stable public facade; implementations are separated by responsibility.
export {
	ActiveTestContext,
	createTestContext,
	withTestContext,
	getCurrentTestContext,
	resetTestContext,
	seed,
	fixture,
	snapshotStore,
	captureLazyLoadWarnings,
	expectNoLazyLoadWarnings
} from './context.js';
export type { TestContextOptions, TestContextSnapshot } from './context.js';
export {
	runStoreAdapterContract,
	runCacheAdapterContract,
	runSearchAdapterContract,
	createAdapterContractSuite,
	createCacheAdapterContractSuite,
	createSearchAdapterContractSuite
} from './contracts.js';
export type {
	StoreContractModel,
	StoreContractCustomIdModel,
	StoreContractDatastoreAncestorModel,
	SearchContractCustomIdModel,
	SearchContractDatastoreAncestorModel,
	StoreAdapterContractOptions,
	SearchAdapterContractOptions,
	AdapterContractSuite,
	CacheAdapterContractSuite,
	SearchAdapterContractSuite
} from './contracts.js';
export { createIntegrationHarness } from './integration-harness.js';
export type {
	IntegrationHarness,
	IntegrationHarnessContextHandle,
	IntegrationHarnessApi
} from './integration-harness.js';
export type { LazyWarningMode } from './shared.js';

export {
	createStoreParityFixture,
	runStoreAdapterDifferentialContract,
	type StoreParityFixture,
	type StoreAdapterDifferentialOptions
} from './store-parity.js';
