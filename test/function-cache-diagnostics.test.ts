import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionCache, getFunctionCacheDiagnostics } from '../src/core/function-cache.js';
import type { CacheAdapter } from '../src/core/types.js';

function versioned(overrides: Partial<CacheAdapter> = {}): CacheAdapter {
	return { kind: 'diagnostics', getMany: async () => [undefined], setMany: async () => {}, deleteMany: async () => {},
		getManyVersioned: async () => [{ value: undefined, version: '1' }], setManyVersioned: async () => [true], invalidateMany: async () => {}, ...overrides };
}

test('diagnostics distinguish rejected version and epoch backfills without exposing keys', async () => {
	const remote = createFunctionCache({ prefix: 'diagnostics_conflict', cache: versioned({ setManyVersioned: async () => [false] }), consistency: 'distributed', factory: () => 'value' });
	assert.equal(await remote.get('key'), 'value');
	assert.equal(remote.diagnostics().backfillVersionConflicts, 1);
	let started!: () => void, resume!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const local = createFunctionCache({ prefix: 'diagnostics_epoch', cache: false, factory: async () => { started(); await gate; return 'value'; } });
	const pending = local.get('key'); await ready;
	assert.equal(local.diagnostics().inFlightEntries, 1);
	await local.invalidate('key'); resume(); await pending;
	assert.equal(local.diagnostics().backfillEpochConflicts, 1);
	assert.equal(local.diagnostics().memoryEntries, 0);
	assert.equal(local.diagnostics().inFlightEntries, 0);
	const copy = local.diagnostics(); copy.backfillEpochConflicts = 999;
	assert.equal(local.diagnostics().backfillEpochConflicts, 1);
});

test('diagnostics report missing fences during pending invalidation', async () => {
	let started!: () => void, resume!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const cache = createFunctionCache({ prefix: 'diagnostics_missing', cache: versioned({ invalidateMany: async () => { started(); await gate; } }), consistency: 'distributed', factory: () => 'value' });
	const before = getFunctionCacheDiagnostics().pendingInvalidationKeys;
	const pending = cache.invalidate('key'); await ready;
	try {
		assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before + 1);
		assert.equal(await cache.get('key'), 'value');
		assert.equal(cache.diagnostics().backfillMissingVersions, 1);
	} finally { resume(); await pending; }
	assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before);
});

test('failed-key bypass and recovery diagnostics reflect adapter protection', async () => {
	let outage = true;
	const adapter = versioned({ invalidateMany: async () => { if (outage) throw new Error('offline'); } });
	const cache = createFunctionCache({ prefix: 'diagnostics_recovery', cache: adapter, consistency: 'distributed', factory: () => 'fresh' });
	await assert.rejects(cache.invalidate('key'), /offline/);
	assert.equal(cache.diagnostics().adapterFailedKeys, 1);
	await assert.rejects(cache.get('key'), /offline/);
	assert.equal(cache.diagnostics().recoveryAttempts, 1);
	outage = false; await cache.get('key');
	assert.equal(cache.diagnostics().recoveryAttempts, 2);
	assert.equal(cache.diagnostics().adapterFailedKeys, 0);
	const local = createFunctionCache({ prefix: 'diagnostics_bypass', cache: { kind: 'local', getMany: async () => ['stale'], setMany: async () => {}, deleteMany: async () => { throw new Error('offline'); } }, factory: () => 'fresh' });
	await assert.rejects(local.invalidate('key'), /offline/);
	assert.equal(await local.get('key'), 'fresh');
	assert.equal(local.diagnostics().failedKeyBypasses, 1);
});
