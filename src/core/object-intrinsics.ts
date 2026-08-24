const HAS_OWN_PROPERTY = Object.prototype.hasOwnProperty;

export const OBJECT_ENTRIES = Object.entries.bind(Object) as typeof Object.entries;
export const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor.bind(
	Object
) as typeof Object.getOwnPropertyDescriptor;
export const OBJECT_GET_OWN_PROPERTY_NAMES = Object.getOwnPropertyNames.bind(
	Object
) as typeof Object.getOwnPropertyNames;
export const OBJECT_GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols.bind(
	Object
) as typeof Object.getOwnPropertySymbols;
export const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf.bind(Object) as typeof Object.getPrototypeOf;
export const OBJECT_IS_EXTENSIBLE = Object.isExtensible.bind(Object) as typeof Object.isExtensible;
export const OBJECT_KEYS = Object.keys.bind(Object) as typeof Object.keys;

export function OBJECT_HAS_OWN(value: object, property: PropertyKey) {
	return HAS_OWN_PROPERTY.call(value, property);
}
