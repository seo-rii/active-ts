import { createHash } from 'node:crypto';
import { ActiveTsValidationError } from './errors.js';
import { JSON_PARSE, JSON_STRINGIFY } from './json-intrinsics.js';
import { cloneJsonTransportPayload } from './native-payload.js';

type PageCursorKind = 'algolia' | 'meilisearch';

/** Both adapters retain their existing v1 wire format and page numbering. */
export function searchPageFromCursor(cursor: string | undefined, fingerprint: string, kind: PageCursorKind): number | undefined {
	if (cursor === undefined) return undefined;
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
		const decoded = JSON_PARSE(Buffer.from(cursor, 'base64url').toString('utf8'));
		const own = (key: string) => Object.getOwnPropertyDescriptor(decoded, key)?.value;
		const page = own('page');
		if (own('v') !== 1 || own('kind') !== kind || own('fingerprint') !== fingerprint ||
			typeof page !== 'number' || !Number.isSafeInteger(page) || page < (kind === 'algolia' ? 0 : 1)) throw new Error();
		return page;
	} catch {
		throw new ActiveTsValidationError(`${kind === 'algolia' ? 'Algolia' : 'Meilisearch'} cursor is invalid or belongs to a different search.`);
	}
}

export function searchCursorForPage(page: number, fingerprint: string, kind: PageCursorKind): string {
	return Buffer.from(JSON_STRINGIFY(cloneJsonTransportPayload({ v: 1, kind, page, fingerprint })), 'utf8').toString('base64url');
}

// Callers provide an owned JSON transport snapshot. Array order is significant;
// object property order is not part of the search identity.
export function searchCursorFingerprint(value: unknown): string {
	function canonical(input: any): string {
		if (input === null || typeof input === 'string' || typeof input === 'boolean' ||
			(typeof input === 'number' && Number.isFinite(input))) return JSON_STRINGIFY(input);
		if (Array.isArray(input)) {
			const entries: string[] = [];
			for (let index = 0; index < input.length; index++) entries.push(canonical(input[index]));
			return `[${entries.join(',')}]`;
		}
		if (input && typeof input === 'object') {
			let entries = '';
			for (const key of Object.keys(input).sort()) {
				if (entries) entries += ',';
				entries += `${JSON_STRINGIFY(key)}:${canonical(input[key])}`;
			}
			return `{${entries}}`;
		}
		throw new ActiveTsValidationError('Search cursor parameters must be JSON data.');
	}
	return createHash('sha256').update(canonical(value)).digest('base64url');
}
