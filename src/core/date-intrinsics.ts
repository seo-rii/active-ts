const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;
const DATE_PARSE = Date.parse;

export function dateTime(value: Date) {
	return DATE_GET_TIME.call(value);
}

export function dateIsoString(value: Date) {
	return DATE_TO_ISO_STRING.call(value);
}

export function dateParse(value: string) {
	return DATE_PARSE(value);
}

export function cloneDate(value: Date) {
	return new Date(dateTime(value));
}
