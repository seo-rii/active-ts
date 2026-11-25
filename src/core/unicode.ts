import { ActiveTsValidationError } from './errors.js';

/** Reject strings that UTF-8 encoding would silently replace with U+FFFD. */
export function assertWellFormedUnicode(value: string, context: string): string {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit < 0xd800 || unit > 0xdfff) continue;
		const next = value.charCodeAt(index + 1);
		if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
			index++;
			continue;
		}
		throw new ActiveTsValidationError(`${context} must not contain unpaired UTF-16 surrogates.`);
	}
	return value;
}
