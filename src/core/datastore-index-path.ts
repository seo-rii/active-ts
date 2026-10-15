import { ActiveTsValidationError } from './errors.js';
import { assertSafeFieldPath } from './safe-keys.js';

/** Datastore SDK exclusion paths support array traversal and a terminal recursive wildcard. */
export function assertSafeDatastoreIndexExclusionPath(value: unknown, context: string): string {
	const path = assertSafeFieldPath(value, context);
	if (path.includes('/')) throw new ActiveTsValidationError(`${context} "${path}" cannot contain "/".`);
	const parts = path.split('.');
	const recursiveWildcard = parts[parts.length - 1] === '*';
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part === '*' && index > 0 && index === parts.length - 1) continue;
		const field = part.endsWith('[]') ? part.slice(0, -2) : part;
		if (!field || /[\[\]*]/.test(field)) {
			throw new ActiveTsValidationError(
				`${context} "${path}" must use dotted fields, optional [] array traversal, and an optional terminal .* wildcard.`
			);
		}
		// Validate the underlying property, so [] cannot disguise a reserved name.
		assertSafeFieldPath(field, context);
		if (recursiveWildcard && part.endsWith('[]') && index < parts.length - 2) {
			throw new ActiveTsValidationError(
				`${context} "${path}" cannot put a recursive wildcard below an array child. Use an exact path or terminate the array with [].*.`
			);
		}
	}
	return path;
}

/** Compare the properties affected by an exclusion with a portable query/index field. */
export function datastoreIndexExclusionOverlapsField(exclusion: string, field: string): boolean {
	const propertyPath = exclusion.replaceAll('[]', '').replace(/\.\*$/, '');
	return propertyPath === field || propertyPath.startsWith(`${field}.`) || field.startsWith(`${propertyPath}.`);
}
