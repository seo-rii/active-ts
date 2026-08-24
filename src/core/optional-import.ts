import { ActiveTsConfigurationError, safeErrorMessage } from './errors.js';

const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export async function optionalImport(specifier: string, adapterName: string) {
	if (typeof specifier !== 'string' || !specifier || specifier.includes('\0') || !PACKAGE_SPECIFIER.test(specifier)) {
		throw new ActiveTsConfigurationError('optional import specifier must be a package name without paths, URLs, or null bytes.');
	}
	if (typeof adapterName !== 'string' || !adapterName || adapterName.includes('\0')) {
		throw new ActiveTsConfigurationError('optional import adapter name must be a non-empty string without null bytes.');
	}
	try {
		return await import(specifier);
	} catch (error) {
		const cause = safeErrorMessage(error);
		throw new ActiveTsConfigurationError(
			`${adapterName} requires optional peer dependency "${specifier}". Install it before using this adapter. Cause: ${cause}`
		);
	}
}
