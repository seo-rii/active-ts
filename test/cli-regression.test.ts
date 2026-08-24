import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const cli = path.join(process.cwd(), 'build', 'src', 'cli.js');

test('schema CLI help flags exit successfully without loading config', async () => {
	for (const args of [
		['--help'],
		['-h'],
		['schema', '--help'],
		['schema', '-h'],
		['schema', 'diff', '--help'],
		['schema', 'generate', '-h'],
		['schema', 'apply', '--help']
	]) {
		const { stdout, stderr } = await exec(process.execPath, [cli, ...args]);
		assert.match(stdout, /Usage:/);
		assert.match(stdout, /schema diff/);
		assert.equal(stderr, '');
	}
});

test('schema CLI exits non-zero for unknown commands', async () => {
	await assert.rejects(
		() => exec(process.execPath, [cli, 'unknown']),
		(error: any) => {
			assert.match(error.stdout, /Usage:/);
			assert.match(error.stderr, /Unknown command "unknown"/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema']),
		(error: any) => {
			assert.match(error.stdout, /Usage:/);
			assert.match(error.stderr, /Schema subcommand is required/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'drop']),
		(error: any) => {
			assert.match(error.stdout, /Usage:/);
			assert.match(error.stderr, /Unknown schema subcommand "drop"/);
			return true;
		}
	);
});

test('schema CLI rejects missing option values clearly', async () => {
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config']),
		(error: any) => {
			assert.match(error.stderr, /--config requires a value/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'generate', '--name', '--config', './active-ts.config.js']),
		(error: any) => {
			assert.match(error.stderr, /--name requires a value/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--unknown', 'value']),
		(error: any) => {
			assert.match(error.stderr, /Unknown option "--unknown"/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', './a.mjs', '--config', './b.mjs']),
		(error: any) => {
			assert.match(error.stderr, /Duplicate option "--config"/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', 'extra']),
		(error: any) => {
			assert.match(error.stderr, /Unexpected argument "extra"/);
			return true;
		}
	);
});

test('schema CLI duplicate option tracking uses captured Set intrinsics', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-set-'));
	const preloader = path.join(dir, 'patch-set.mjs');
	const intrinsicsUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'core', 'collection-intrinsics.js')).href;
	await writeFile(
		preloader,
		`
await import(${JSON.stringify(intrinsicsUrl)});
Set.prototype.has = function () { throw new Error('patched Set.has'); };
Set.prototype.add = function () { throw new Error('patched Set.add'); };
`
	);
	await assert.rejects(
		() =>
			exec(process.execPath, [
				'--import',
				preloader,
				cli,
				'schema',
				'diff',
				'--config',
				'./a.mjs',
				'--config',
				'./b.mjs'
			]),
		(error: any) => {
			assert.match(error.stderr, /Duplicate option "--config"/);
			assert.doesNotMatch(error.stderr, /patched Set/);
			return true;
		}
	);
});

test('schema CLI argument parsing ignores patched Array helpers', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-array-'));
	const preloader = path.join(dir, 'patch-array.mjs');
	const config = path.join(dir, 'active-ts.config.mjs');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		preloader,
		`
Array.prototype.some = function () { throw new Error('patched Array.some'); };
Array.prototype.find = function () { throw new Error('patched Array.find'); };
Array.prototype.forEach = function () { throw new Error('patched Array.forEach'); };
Array.prototype.includes = function () { throw new Error('patched Array.includes'); };
`
	);
	await writeFile(
		config,
		`
import { createActiveTs, MemoryStoreAdapter, Model, defineModel } from ${JSON.stringify(packageUrl)};
export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
class CliArrayModel extends Model {}
defineModel('cli_array_model').id('id').validate((input) => input).attach(CliArrayModel);
export const models = [CliArrayModel];
`
	);

	const { stdout, stderr } = await exec(process.execPath, [
		'--import',
		preloader,
		cli,
		'schema',
		'diff',
		'--config',
		config,
		'--name',
		'cli-array'
	]);
	assert.match(stdout, /cli_array_model/);
	assert.equal(stderr, '');
});

test('schema CLI output ignores config patched JSON stringify', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-json-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		config,
		`
import { createActiveTs, MemoryStoreAdapter, Model, defineModel } from ${JSON.stringify(packageUrl)};
export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
class CliJsonModel extends Model {}
defineModel('cli_json_model').id('id').validate((input) => input).attach(CliJsonModel);
export const models = [CliJsonModel];
JSON.stringify = function () {
	throw new Error('patched JSON.stringify should not run for active-ts CLI output');
};
`
	);

	const generated = await exec(process.execPath, [
		cli,
		'schema',
		'generate',
		'--config',
		config,
		'--name',
		'cli_json_migration'
	]);
	const migration = JSON.parse(generated.stdout);
	assert.equal(migration.name, 'cli_json_migration');
	assert.deepEqual(migration.summary, ['default:create-collection:cli_json_model']);
	assert.equal(generated.stderr, '');
});

test('schema CLI validates config shape before running schema commands', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-config-'));
	const structuralContextConfig = path.join(dir, 'structural-context.config.mjs');
	const badModelsConfig = path.join(dir, 'bad-models.config.mjs');
	const badModelConfig = path.join(dir, 'bad-model.config.mjs');
	const sparseModelsConfig = path.join(dir, 'sparse-models.config.mjs');
	const customModelsConfig = path.join(dir, 'custom-models.config.mjs');
	const pollutedContextConfig = path.join(dir, 'polluted-context.config.mjs');
	const namedNullConfig = path.join(dir, 'named-null.config.mjs');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	const activeContext = `
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(packageUrl)};
export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
`;
	await writeFile(
		structuralContextConfig,
		'export const context = { schemaApply: async () => [], schemaMigration: async () => ({ plans: [] }) }; export const models = [];'
	);
	await writeFile(
		badModelsConfig,
		`${activeContext} export const models = "bad";`
	);
	await writeFile(
		badModelConfig,
		`${activeContext} export const models = [null];`
	);
	await writeFile(
		sparseModelsConfig,
		`${activeContext} export const models = new Array(1);`
	);
	await writeFile(
		customModelsConfig,
		`
import { createActiveTs, MemoryStoreAdapter, Model, defineModel } from ${JSON.stringify(packageUrl)};
export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
class CliCustomModel extends Model {}
defineModel('cli_custom_model').id('id').validate((input) => input).attach(CliCustomModel);
export const models = [CliCustomModel];
Object.defineProperty(models, 'forEach', {
	value() {
		throw new Error('custom CLI models forEach should not run');
	}
});
`
	);
	await writeFile(
		pollutedContextConfig,
		`
Object.defineProperties(Object.prototype, {
	schemaApply: { value: async () => [], configurable: true },
	schemaMigration: { value: async () => ({ plans: [{ polluted: true }] }), configurable: true }
});
export const context = {};
export const models = [];
`
	);
	await writeFile(
		namedNullConfig,
		`
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(packageUrl)};
export const context = null;
export const models = null;
export default {
	context: createActiveTs({ stores: { default: new MemoryStoreAdapter() } }),
	models: []
};
`
	);

	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', structuralContextConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config context must be an ActiveContext instance/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', badModelsConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config models must be an array/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', badModelConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config models\[0\] must be a model constructor/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', sparseModelsConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config models\[0\] is missing/);
			return true;
		}
	);
	await exec(process.execPath, [cli, 'schema', 'diff', '--config', customModelsConfig]);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', pollutedContextConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config context must be an ActiveContext instance/);
			return true;
		}
	);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', namedNullConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config context must be an ActiveContext instance/);
			return true;
		}
	);
});

test('schema CLI rejects config accessors and ignores shadowed schema method accessors', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-accessor-'));
	const defaultAccessorConfig = path.join(dir, 'default-accessor.config.mjs');
	const defaultHiddenConfig = path.join(dir, 'default-hidden.config.mjs');
	const methodAccessorConfig = path.join(dir, 'method-accessor.config.mjs');
	const methodHiddenConfig = path.join(dir, 'method-hidden.config.mjs');
	const defaultMarker = path.join(dir, 'default-getter-ran');
	const methodMarker = path.join(dir, 'method-getter-ran');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		defaultAccessorConfig,
		`
import { writeFileSync } from 'node:fs';
export default Object.defineProperty({}, 'context', {
	enumerable: true,
	get() {
		writeFileSync(${JSON.stringify(defaultMarker)}, 'ran');
		return {};
	}
});
	`
	);
	await writeFile(
		defaultHiddenConfig,
		`
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(packageUrl)};
const hidden = {};
Object.defineProperty(hidden, 'context', {
	enumerable: false,
	value: createActiveTs({ stores: { default: new MemoryStoreAdapter() } })
});
export default hidden;
export const models = [];
`
	);
	await writeFile(
		methodAccessorConfig,
		`
import { writeFileSync } from 'node:fs';
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(packageUrl)};
export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
Object.defineProperty(context, 'schemaApply', {
	configurable: true,
	get() {
		writeFileSync(${JSON.stringify(methodMarker)}, 'ran');
		return async () => [];
	}
});
export const models = [];
`
	);
	await writeFile(
		methodHiddenConfig,
		`
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(packageUrl)};
export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
Object.defineProperty(context, 'schemaApply', {
	configurable: true,
	enumerable: false,
	value: async () => []
});
export const models = [];
`
	);

	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', defaultAccessorConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config default export\.context must be a data property/);
			return true;
		}
	);
	await assert.rejects(() => access(defaultMarker), /ENOENT/);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', defaultHiddenConfig]),
		(error: any) => {
			assert.match(error.stderr, /Config default export\.context must be enumerable/);
			return true;
		}
	);
	await exec(process.execPath, [cli, 'schema', 'diff', '--config', methodAccessorConfig]);
	await assert.rejects(() => access(methodMarker), /ENOENT/);
	await exec(process.execPath, [cli, 'schema', 'diff', '--config', methodHiddenConfig]);
});

test('schema CLI formats thrown config values without invoking coercion hooks', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-error-'));
	const config = path.join(dir, 'throwing-config.mjs');
	await writeFile(
		config,
		`
throw {
	message: 'bad config value',
	toString() {
		throw new Error('toString invoked');
	}
};
`
	);

	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', config]),
		(error: any) => {
			assert.match(error.stderr, /bad config value/);
			assert.doesNotMatch(error.stderr, /toString invoked/);
			return true;
		}
	);
});

test('schema CLI awaits async default config exports before reading fields', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-async-default-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const disposeMarker = path.join(dir, 'async-default-disposed');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		config,
		`
import { writeFileSync } from 'node:fs';
import { Model, createActiveTs, defineModel } from ${JSON.stringify(packageUrl)};

class CliAsyncDefaultRecord extends Model {}
defineModel('cli_async_default_record').attach(CliAsyncDefaultRecord);

const context = createActiveTs({ stores: { default: {
	kind: 'cli-async-default-store',
	capabilities: {},
	get: async () => null,
	getMany: async (_model, ids) => ids.map(() => null),
	query: async () => ({ list: [], more: false }),
	create: async () => {},
	update: async () => {},
	delete: async () => {},
	schema: {
		plan: async () => ({
			adapter: 'cli-async-default-store',
			changes: [{
				type: 'create-index',
				target: 'async_default_config',
				name: 'async_default_idx',
				fields: ['id']
			}]
		}),
		apply: async () => ({ adapter: 'cli-async-default-store', changes: [] })
	}
} } });

export default new Promise((resolve) => {
	setTimeout(() => resolve({
		context,
		models: [CliAsyncDefaultRecord],
		dispose() {
			writeFileSync(${JSON.stringify(disposeMarker)}, 'disposed');
		}
	}), 20);
});
`
	);

	const { stdout, stderr } = await exec(process.execPath, [cli, 'schema', 'diff', '--config', config]);

	assert.equal(stderr, '');
	assert.match(stdout, /"target": "async_default_config"/);
	await access(disposeMarker);
});

test('schema CLI disposes named cleanup when async default config rejects', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-async-default-reject-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const disposeMarker = path.join(dir, 'async-default-reject-disposed');
	await writeFile(
		config,
		`
import { writeFileSync } from 'node:fs';
export function dispose() {
	writeFileSync(${JSON.stringify(disposeMarker)}, 'disposed');
}
export default new Promise((_resolve, reject) => {
	setTimeout(() => reject(new Error('async default config failed')), 20);
});
`
	);

	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', config]),
		(error: any) => {
			assert.match(error.stderr, /async default config failed/);
			return true;
		}
	);
	await access(disposeMarker);
});

test('schema CLI waits for async context readiness before planning', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		config,
		`
import { Model, createActiveTs, defineModel } from ${JSON.stringify(packageUrl)};

class CliReadyRecord extends Model {}
defineModel('cli_ready_record').attach(CliReadyRecord);

let ready = false;
const store = {
	kind: 'cli-ready-store',
	capabilities: {},
	get: async () => null,
	getMany: async (model, ids) => ids.map(() => null),
	query: async () => ({ list: [], more: false }),
	create: async () => {},
	update: async () => {},
	delete: async () => {},
	schema: {
		plan: async () => ({
			adapter: 'cli-ready-store',
			changes: [{
				type: 'create-index',
				target: ready ? 'ready' : 'not_ready',
				name: 'ready_idx',
				fields: ['id']
			}]
		}),
		apply: async () => ({ adapter: 'cli-ready-store', changes: [] })
	}
};

export const models = [CliReadyRecord];
export const context = createActiveTs({
	stores: { default: store },
	plugins: [{
		name: 'delayed-ready',
		setup: async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			ready = true;
		}
	}]
});
`
	);

	const { stdout } = await exec(process.execPath, [cli, 'schema', 'diff', '--config', config]);

	assert.match(stdout, /"target": "ready"/);
	assert.doesNotMatch(stdout, /not_ready/);
});

test('schema CLI disposes config resources on success and schema failures', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-dispose-'));
	const successConfig = path.join(dir, 'success.config.mjs');
	const failureConfig = path.join(dir, 'failure.config.mjs');
	const successMarker = path.join(dir, 'success-disposed');
	const failureMarker = path.join(dir, 'failure-disposed');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	const base = `
import { writeFileSync } from 'node:fs';
import { Model, createActiveTs, defineModel } from ${JSON.stringify(packageUrl)};
class CliDisposeRecord extends Model {}
defineModel('cli_dispose_record').attach(CliDisposeRecord);
export const models = [CliDisposeRecord];
`;
	await writeFile(
		successConfig,
		`${base}
export const context = createActiveTs({ stores: { default: {
	kind: 'cli-dispose-store',
	capabilities: {},
	get: async () => null,
	getMany: async (_model, ids) => ids.map(() => null),
	query: async () => ({ list: [], more: false }),
	create: async () => {},
	update: async () => {},
	delete: async () => {},
	schema: {
		plan: async () => ({ adapter: 'cli-dispose-store', changes: [] }),
		apply: async () => ({ adapter: 'cli-dispose-store', changes: [] })
	}
} } });
export function dispose() {
	writeFileSync(${JSON.stringify(successMarker)}, 'disposed');
}
`
	);
	await writeFile(
		failureConfig,
		`${base}
export const context = createActiveTs({ stores: { default: {
	kind: 'cli-dispose-failure-store',
	capabilities: {},
	get: async () => null,
	getMany: async (_model, ids) => ids.map(() => null),
	query: async () => ({ list: [], more: false }),
	create: async () => {},
	update: async () => {},
	delete: async () => {},
	schema: {
		plan: async () => { throw new Error('schema failed before cleanup'); },
		apply: async () => ({ adapter: 'cli-dispose-failure-store', changes: [] })
	}
} } });
export default {
	context,
	models,
	close() {
		writeFileSync(${JSON.stringify(failureMarker)}, 'disposed');
	}
};
`
	);

	await exec(process.execPath, [cli, 'schema', 'diff', '--config', successConfig]);
	await access(successMarker);
	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', failureConfig]),
		(error: any) => {
			assert.match(error.stderr, /schema failed before cleanup/);
			return true;
		}
	);
	await access(failureMarker);
});

test('schema CLI disposes config resources on config normalization failures', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-normalize-dispose-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const marker = path.join(dir, 'normalize-disposed');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		config,
		`
import { writeFileSync } from 'node:fs';
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(packageUrl)};
export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
export const models = "bad";
export function dispose() {
	writeFileSync(${JSON.stringify(marker)}, 'disposed');
}
`
	);

	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', config]),
		(error: any) => {
			assert.match(error.stderr, /Config models must be an array/);
			return true;
		}
	);
	await access(marker);
});

test('schema CLI disposes config resources when later config fields are malformed', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-early-dispose-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const cleanupMarker = path.join(dir, 'early-disposed');
	const getterMarker = path.join(dir, 'models-getter-ran');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		config,
		`
import { writeFileSync } from 'node:fs';
import { createActiveTs, MemoryStoreAdapter } from ${JSON.stringify(packageUrl)};
const activeTsConfig = {
	context: createActiveTs({ stores: { default: new MemoryStoreAdapter() } }),
	dispose() {
		writeFileSync(${JSON.stringify(cleanupMarker)}, 'disposed');
	}
};
Object.defineProperty(activeTsConfig, 'models', {
	enumerable: true,
	get() {
		writeFileSync(${JSON.stringify(getterMarker)}, 'ran');
		return [];
	}
});
export default activeTsConfig;
`
	);

	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', config]),
		(error: any) => {
			assert.match(error.stderr, /Config default export\.models must be a data property/);
			return true;
		}
	);
	await access(cleanupMarker);
	await assert.rejects(() => access(getterMarker), /ENOENT/);
});

test('schema CLI reports cleanup failures after successful schema commands', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-dispose-failure-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		config,
		`
import { Model, createActiveTs, defineModel } from ${JSON.stringify(packageUrl)};
class CliCleanupFailureRecord extends Model {}
defineModel('cli_cleanup_failure_record').attach(CliCleanupFailureRecord);
export const models = [CliCleanupFailureRecord];
export const context = createActiveTs({ stores: { default: {
	kind: 'cli-cleanup-failure-store',
	capabilities: {},
	get: async () => null,
	getMany: async (_model, ids) => ids.map(() => null),
	query: async () => ({ list: [], more: false }),
	create: async () => {},
	update: async () => {},
	delete: async () => {},
	schema: {
		plan: async () => ({ adapter: 'cli-cleanup-failure-store', changes: [] }),
		apply: async () => ({ adapter: 'cli-cleanup-failure-store', changes: [] })
	}
} } });
export function dispose() {
	throw new Error('cleanup failed after schema success');
}
`
	);

	await assert.rejects(
		() => exec(process.execPath, [cli, 'schema', 'diff', '--config', config]),
		(error: any) => {
			assert.match(error.stderr, /cleanup failed after schema success/);
			return true;
		}
	);
});

test('schema CLI ignores own shadowed ActiveContext schema methods', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'active-ts-cli-shadow-'));
	const config = path.join(dir, 'active-ts.config.mjs');
	const packageUrl = pathToFileURL(path.join(process.cwd(), 'build', 'src', 'index.js')).href;
	await writeFile(
		config,
		`
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from ${JSON.stringify(packageUrl)};

class CliShadowRecord extends Model {}

defineModel('cli_shadow_record')
	.id('id')
	.validate((input) => input)
	.attach(CliShadowRecord);

export const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
Object.defineProperty(context, 'schemaMigration', {
	enumerable: true,
	configurable: true,
	value: async () => {
		throw new Error('shadowed schemaMigration called');
	}
});
Object.defineProperty(context, 'schemaApply', {
	enumerable: true,
	configurable: true,
	value: async () => {
		throw new Error('shadowed schemaApply called');
	}
});

export const models = [CliShadowRecord];
`
	);

	const generated = await exec(process.execPath, [
		cli,
		'schema',
		'generate',
		'--config',
		config,
		'--name',
		'shadow_migration'
	]);
	const migration = JSON.parse(generated.stdout);
	assert.equal(migration.name, 'shadow_migration');
	assert.deepEqual(migration.summary, ['default:create-collection:cli_shadow_record']);

	const applied = await exec(process.execPath, [
		cli,
		'schema',
		'apply',
		'--config',
		config
	]);
	const plans = JSON.parse(applied.stdout);
	assert.equal(plans[0].route, 'default');
	assert.deepEqual(plans[0].changes, [
		{ type: 'create-collection', target: 'cli_shadow_record' }
	]);
});
