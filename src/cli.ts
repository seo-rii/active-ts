#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { ActiveContext } from './core/context.js';
import { ActiveTsConfigurationError, safeErrorMessage } from './core/errors.js';
import { snapshotArrayInput } from './core/array-input.js';
import { dateIsoString } from './core/date-intrinsics.js';
import { SET_ADD, SET_HAS } from './core/collection-intrinsics.js';
import { JSON_STRINGIFY } from './core/json-intrinsics.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_PROTOTYPE_OF,
	OBJECT_HAS_OWN
} from './core/object-intrinsics.js';

type ConfigModule = {
	context?: any;
	models?: any[];
	dispose?: any;
	close?: any;
	default?:
		| { context?: any; models?: any[]; dispose?: any; close?: any }
		| Promise<{ context?: any; models?: any[]; dispose?: any; close?: any }>;
};

async function main() {
	const rawArgs = cliArgs(process.argv, 2);
	const command = rawArgs[0];
	const subcommand = rawArgs[1];
	const args = cliArgs(rawArgs, 2);
	if (!command) {
		help();
		return;
	}
	if (isHelpFlag(command)) {
		help();
		return;
	}
	if (command !== 'schema') {
		help();
		throw new ActiveTsConfigurationError(`Unknown command "${command}".`);
	}
	if (isHelpFlag(subcommand)) {
		help();
		return;
	}
	if (!subcommand || !isSchemaSubcommand(subcommand)) {
		help();
		throw new ActiveTsConfigurationError(
			subcommand
				? `Unknown schema subcommand "${subcommand}".`
				: 'Schema subcommand is required.'
		);
	}
	if (hasHelpFlag(args)) {
		help();
		return;
	}
	const options = parseOptions(args);
	const configPath = options.config ?? './active-ts.config.js';
	const name = options.name ?? `migration-${dateIsoString(new Date()).replace(/[:.]/g, '-')}`;
	const mod = (await import(pathToFileURL(configPath).href)) as ConfigModule;
	let dispose: (() => Promise<void> | void) | undefined;
	let commandError: unknown;
	try {
		const namedCleanup = firstDefined(
			cliConfigValue(mod, 'dispose', 'Config module'),
			cliConfigValue(mod, 'close', 'Config module')
		);
		dispose = cliOptionalConfigFunction(namedCleanup, 'Config dispose/close must be a function.');
		const defaultExport = await resolveCliDefaultExport(cliConfigValue(mod, 'default', 'Config module'));
		const cleanup = firstDefined(
			dispose,
			cliConfigValue(defaultExport, 'dispose', 'Config default export'),
			cliConfigValue(defaultExport, 'close', 'Config default export')
		);
		dispose = cliOptionalConfigFunction(cleanup, 'Config dispose/close must be a function.');
		const namedContext = cliConfigEntry(mod, 'context', 'Config module');
		const context = namedContext.exists
			? namedContext.value
			: cliConfigValue(defaultExport, 'context', 'Config default export');
		dispose = resolveCliCleanup(context, dispose);
		const namedModels = cliConfigEntry(mod, 'models', 'Config module');
		const models = namedModels.exists
			? namedModels.value
			: cliConfigValue(defaultExport, 'models', 'Config default export');
		const config = normalizeCliConfig(context, models, dispose);
		dispose = config.dispose;
		if (config.ready) await config.ready();
		if (subcommand === 'apply') {
			printJson(await config.schemaApply(config.models, { mode: 'safe' }));
			return;
		}
		const migration = await config.schemaMigration(config.models, name);
		if (subcommand === 'diff') printJson(migration.plans);
		else printJson(migration);
	} catch (error) {
		commandError = error;
		throw error;
	} finally {
		await runCliCleanup(dispose, commandError);
	}
}

function printJson(value: unknown) {
	console.log(JSON_STRINGIFY(value, null, 2));
}

function isHelpFlag(value: string | undefined) {
	return value === '--help' || value === '-h';
}

function isSchemaSubcommand(value: string) {
	return value === 'diff' || value === 'generate' || value === 'apply';
}

function hasHelpFlag(args: string[]) {
	for (let index = 0; index < args.length; index++) {
		if (isHelpFlag(args[index])) return true;
	}
	return false;
}

function cliArgs(args: readonly string[], start: number) {
	const next: string[] = [];
	for (let index = start; index < args.length; index++) {
		next[next.length] = args[index];
	}
	return next;
}

function parseOptions(args: string[]) {
	const options: { config?: string; name?: string } = {};
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg !== '--config' && arg !== '--name') {
			if (arg.startsWith('--')) throw new ActiveTsConfigurationError(`Unknown option "${arg}".`);
			throw new ActiveTsConfigurationError(`Unexpected argument "${arg}".`);
		}
		if (SET_HAS.call(seen, arg)) throw new ActiveTsConfigurationError(`Duplicate option "${arg}".`);
		SET_ADD.call(seen, arg);
		const value = args[++index];
		if (!value || value.startsWith('--')) throw new ActiveTsConfigurationError(`${arg} requires a value.`);
		if (arg === '--config') options.config = value;
		else options.name = value;
	}
	return options;
}

function normalizeCliConfig(context: unknown, models: unknown, cleanup: unknown): {
	ready?: () => Promise<void> | void;
	dispose?: () => Promise<void> | void;
	schemaApply: (...args: any[]) => Promise<unknown>;
	schemaMigration: (...args: any[]) => Promise<{ plans: unknown }>;
	models: any[];
} {
	if (!(context instanceof ActiveContext)) {
		throw new ActiveTsConfigurationError('Config context must be an ActiveContext instance.');
	}
	if (!Array.isArray(models)) {
		throw new ActiveTsConfigurationError('Config models must be an array.');
	}
	const safeModels = snapshotArrayInput(models, 'Config models');
	for (let index = 0; index < safeModels.length; index++) {
		const model = safeModels[index];
		if (typeof model !== 'function') {
			throw new ActiveTsConfigurationError(`Config models[${index}] must be a model constructor.`);
		}
	}
	const ready = cliOptionalMethod(context, 'ready', 'Config context.ready must be a function.');
	const dispose =
		cliOptionalConfigFunction(cleanup, 'Config dispose/close must be a function.') ??
		cliOptionalMethod(context, 'dispose', 'Config context.dispose must be a function.') ??
		cliOptionalMethod(context, 'close', 'Config context.close must be a function.');
	const schemaApply = activeContextMethod(context, 'schemaApply', 'Config context.schemaApply must be a function.');
	const schemaMigration = activeContextMethod(context, 'schemaMigration', 'Config context.schemaMigration must be a function.');
	return { ready, dispose, schemaApply, schemaMigration, models: safeModels };
}

function firstDefined(...values: unknown[]) {
	for (let index = 0; index < values.length; index++) {
		if (values[index] !== undefined) return values[index];
	}
	return undefined;
}

async function resolveCliDefaultExport(value: unknown) {
	if (value instanceof Promise) return await value;
	return value;
}

function resolveCliCleanup(context: unknown, cleanup: unknown) {
	const configCleanup = cliOptionalConfigFunction(cleanup, 'Config dispose/close must be a function.');
	if (configCleanup) return configCleanup;
	if (context instanceof ActiveContext) {
		return (
			cliOptionalMethod(context, 'dispose', 'Config context.dispose must be a function.') ??
			cliOptionalMethod(context, 'close', 'Config context.close must be a function.')
		);
	}
	return undefined;
}

async function runCliCleanup(dispose: (() => Promise<void> | void) | undefined, commandError: unknown) {
	if (!dispose) return;
	try {
		await dispose();
	} catch (error) {
		if (commandError !== undefined) {
			console.error(`active-ts cleanup failed after command error: ${safeErrorMessage(error)}`);
			return;
		}
		throw error;
	}
}

function cliOptionalConfigFunction(value: unknown, errorMessage: string) {
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(errorMessage);
	}
	return value as () => Promise<void> | void;
}

function cliOptionalMethod(target: object, method: string, errorMessage: string) {
	const value = cliMember(target, method);
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(errorMessage);
	}
	return value.bind(target);
}

function activeContextMethod(context: ActiveContext, method: 'schemaApply' | 'schemaMigration', errorMessage: string) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(ActiveContext.prototype, method);
	if (!descriptor || typeof descriptor.value !== 'function') {
		throw new ActiveTsConfigurationError(errorMessage);
	}
	return descriptor.value.bind(context);
}

function cliMember(target: object, property: string) {
	let current: object | null = target;
	while (current && current !== Object.prototype) {
		if (OBJECT_HAS_OWN(current, property)) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`Config context.${property} must be a data property.`);
			}
			if (current === target && !descriptor.enumerable) {
				throw new ActiveTsConfigurationError(`Config context.${property} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = OBJECT_GET_PROTOTYPE_OF(current);
	}
	return undefined;
}

function cliConfigValue(target: unknown, property: string, context: string) {
	const entry = cliConfigEntry(target, property, context);
	return entry.exists ? entry.value : undefined;
}

function cliConfigEntry(target: unknown, property: string, context: string): { exists: false } | { exists: true; value: unknown } {
	if (!target || (typeof target !== 'object' && typeof target !== 'function')) return { exists: false };
	if (!OBJECT_HAS_OWN(target, property)) return { exists: false };
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, property);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
	}
	return { exists: true, value: descriptor.value };
}

function help() {
	console.log(`active-ts

Usage:
  active-ts schema diff --config ./active-ts.config.js
  active-ts schema generate --config ./active-ts.config.js --name add-index
  active-ts schema apply --config ./active-ts.config.js
`);
}

main().catch((error) => {
	console.error(safeErrorMessage(error));
	process.exitCode = 1;
});
