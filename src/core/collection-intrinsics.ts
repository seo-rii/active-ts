export const MAP_CLEAR = Map.prototype.clear;
export const MAP_DELETE = Map.prototype.delete;
export const MAP_ENTRIES = Map.prototype.entries;
export const MAP_FOR_EACH = Map.prototype.forEach;
export const MAP_GET = Map.prototype.get;
export const MAP_HAS = Map.prototype.has;
export const MAP_KEYS = Map.prototype.keys;
export const MAP_SET = Map.prototype.set;
export const MAP_SIZE = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
export const MAP_VALUES = Map.prototype.values;
export const SET_ADD = Set.prototype.add;
export const SET_CLEAR = Set.prototype.clear;
export const SET_DELETE = Set.prototype.delete;
export const SET_FOR_EACH = Set.prototype.forEach;
export const SET_HAS = Set.prototype.has;
export const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
export const SET_VALUES = Set.prototype.values;
export const WEAKSET_ADD = WeakSet.prototype.add;
export const WEAKSET_DELETE = WeakSet.prototype.delete;
export const WEAKSET_HAS = WeakSet.prototype.has;
export const WEAKMAP_DELETE = WeakMap.prototype.delete;
export const WEAKMAP_GET = WeakMap.prototype.get;
export const WEAKMAP_HAS = WeakMap.prototype.has;
export const WEAKMAP_SET = WeakMap.prototype.set;

export function iterableToArray<T>(iterable: Iterable<T>): T[] {
	const result: T[] = [];
	for (const value of iterable) result[result.length] = value;
	return result;
}
