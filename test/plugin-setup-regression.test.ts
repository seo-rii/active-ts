import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter, Model, createActiveTs, createActiveTsAsync, defineModel } from '../src/index.js';

class PluginPollutionRecord extends Model<{ id: number; label: string }> {}

defineModel<{ id: number; label: string }>('plugin_pollution_record')
	.id('id')
	.validate((input) => input as { id: number; label: string })
	.attach(PluginPollutionRecord);

test('context.ready waits for async plugin setup', async () => {
	let initialized = false;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'async-ready',
				async setup() {
					await Promise.resolve();
					initialized = true;
				}
			}
		]
	});

	assert.equal(initialized, false);
	await context.ready();
	assert.equal(initialized, true);
});

test('context.ready waits for setup thenables without catch methods', async () => {
	let initialized = false;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'thenable-ready',
				setup() {
					return {
						then(resolve: () => void) {
							queueMicrotask(() => {
								initialized = true;
								resolve();
							});
						}
					} as any;
				}
			}
		]
	});

	assert.equal(initialized, false);
	await context.ready();
	assert.equal(initialized, true);
});

test('createActiveTsAsync fails fast on async plugin setup errors', async () => {
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (message?: unknown) => {
		warnings.push(String(message));
	};
	try {
		await assert.rejects(
			() =>
				createActiveTsAsync({
					stores: { default: new MemoryStoreAdapter() },
					plugins: [
						{
							name: 'async-fail',
							async setup() {
								throw new Error('boom');
							}
						}
					]
				}),
			/Plugin "async-fail" setup failed: boom/
		);
	} finally {
		console.warn = originalWarn;
	}

	assert.deepEqual(warnings, ['active-ts Plugin "async-fail" setup failed: boom']);
});

test('createActiveTsAsync wraps rejecting setup thenables without catch methods', async () => {
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (message?: unknown) => {
		warnings.push(String(message));
	};
	try {
		await assert.rejects(
			() =>
				createActiveTsAsync({
					stores: { default: new MemoryStoreAdapter() },
					plugins: [
						{
							name: 'thenable-fail',
							setup() {
								return {
									then(_resolve: () => void, reject: (error: unknown) => void) {
										queueMicrotask(() => reject(new Error('thenable boom')));
									}
								} as any;
							}
						}
					]
				}),
			/Plugin "thenable-fail" setup failed: thenable boom/
		);
	} finally {
		console.warn = originalWarn;
	}

	assert.deepEqual(warnings, ['active-ts Plugin "thenable-fail" setup failed: thenable boom']);
});

test('createActiveTs wraps sync plugin setup errors with plugin names', () => {
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				plugins: [
					{
						name: 'sync-fail',
						setup() {
							throw new Error('sync boom');
						}
					}
				]
			}),
		/Plugin "sync-fail" setup failed: sync boom/
	);
});

test('plugin hook definitions are validated when the context is created', () => {
	const stores = { default: new MemoryStoreAdapter() };
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: '' as any }] }),
		/plugins\[0\]\.name must be a non-empty string/
	);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'bad-setup', setup: 'run' as any }] }),
		/plugins\[0\]\.setup must be a function/
	);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'typo-plugin', hook: {} } as any] }),
		/plugins\[0\] contains unknown option "hook"/
	);
	let pluginReads = 0;
	const accessorPlugin = Object.defineProperty({}, 'name', {
		enumerable: true,
		get() {
			pluginReads++;
			return 'accessor-plugin';
		}
	});
	assert.throws(
		() => createActiveTs({ stores, plugins: [accessorPlugin as any] }),
		/plugins\[0\]\.name must be a data property/
	);
	assert.equal(pluginReads, 0);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'bad-hooks', hooks: [] as any }] }),
		/plugin "bad-hooks" hooks must be a plain object/
	);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'null-hooks', hooks: null as any }] }),
		/plugin "null-hooks" hooks must be a plain object/
	);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'empty-hooks', hooks: '' as any }] }),
		/plugin "empty-hooks" hooks must be a plain object/
	);
	assert.throws(
		() =>
			createActiveTs({
				stores,
				plugins: [{ name: 'symbol-hooks', hooks: { [Symbol('beforeQuery')]: () => undefined } as any }]
			}),
		/plugin "symbol-hooks" hooks cannot contain symbol hook names/
	);
	let hookReads = 0;
	const accessorHooks = Object.defineProperty({}, 'beforeQuery', {
		enumerable: true,
		get() {
			hookReads++;
			return () => undefined;
		}
	});
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'accessor-hooks', hooks: accessorHooks as any }] }),
		/plugin "accessor-hooks" hooks\.beforeQuery must be a data property/
	);
	assert.equal(hookReads, 0);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'unknown-hook', hooks: { nope: () => undefined } as any }] }),
		/plugin "unknown-hook" hooks contains unknown hook "nope"/
	);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'bad-hook-value', hooks: { beforeQuery: null as any } }] }),
		/plugin "bad-hook-value" hooks\.beforeQuery must be a function/
	);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'bad-hook-array', hooks: { beforeQuery: [() => undefined, null] as any } }] }),
		/plugin "bad-hook-array" hooks\.beforeQuery\[1\] must be a function/
	);
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'sparse-hook-array', hooks: { beforeQuery: new Array(1) as any } }] }),
		/plugin "sparse-hook-array" hooks\.beforeQuery\[0\] is missing/
	);

	const plugins = [{ name: 'custom-map-plugin' }] as any[];
	let pluginMapCalls = 0;
	Object.defineProperty(plugins, 'map', {
		value() {
			pluginMapCalls++;
			throw new Error('custom plugins.map should not run');
		}
	});
	createActiveTs({ stores, plugins });
	assert.equal(pluginMapCalls, 0);

	const hiddenPlugins = [{ name: 'hidden-plugin' }] as any[];
	Object.defineProperty(hiddenPlugins, '0', {
		enumerable: false,
		value: { name: 'hidden-plugin' }
	});
	assert.throws(
		() => createActiveTs({ stores, plugins: hiddenPlugins }),
		/plugins\[0\] must be enumerable/
	);

	const hookArray = [() => undefined] as any[];
	let hookForEachCalls = 0;
	Object.defineProperty(hookArray, 'forEach', {
		value() {
			hookForEachCalls++;
			throw new Error('custom hook forEach should not run');
		}
	});
	createActiveTs({ stores, plugins: [{ name: 'custom-hook-array', hooks: { beforeQuery: hookArray } }] });
	assert.equal(hookForEachCalls, 0);

	const iteratorHookArray = [() => undefined] as any[];
	let hookIteratorCalls = 0;
	Object.defineProperty(iteratorHookArray, Symbol.iterator, {
		value() {
			hookIteratorCalls++;
			throw new Error('custom hook iterator should not run');
		}
	});
	assert.throws(
		() => createActiveTs({ stores, plugins: [{ name: 'iterator-hook-array', hooks: { beforeQuery: iteratorHookArray } }] }),
		/plugin "iterator-hook-array" hooks\.beforeQuery cannot contain symbol fields/
	);
	assert.equal(hookIteratorCalls, 0);
});

test('hook dispatch ignores inherited lifecycle hook properties', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [{ name: 'empty-hooks', hooks: {} }]
	});
	const Record = PluginPollutionRecord.use(context) as unknown as typeof PluginPollutionRecord;
	let called = false;
	Object.defineProperty(Object.prototype, 'beforeCreate', {
		value(payload: any) {
			called = true;
			payload.data.label = 'polluted';
		},
		configurable: true
	});
	try {
		await Record.create({ id: 1, label: 'clean' });
		assert.equal(called, false);
		assert.deepEqual(await store.get(context.meta(PluginPollutionRecord), 1), { id: 1, label: 'clean' });
	} finally {
		delete (Object.prototype as Record<string, unknown>).beforeCreate;
	}
});
