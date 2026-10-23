const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;
const DATE_PARSE = Date.parse;

export function dateTime(value: Date) {
	return DATE_GET_TIME.call(value);
}

export function dateIsoString(value: Date) {
	return DATE_TO_ISO_STRING.call(value);
}

/** Four-digit UTC years retain chronological ordering in canonical ISO text. */
export function isPortableDate(value: Date) {
	const time = dateTime(value);
	return time >= -62_167_219_200_000 && time < 253_402_300_800_000;
}

export function dateParse(value: string) {
	return DATE_PARSE(value);
}

export function cloneDate(value: Date) {
	return new Date(dateTime(value));
}
