/** Stable sorted copy for materialized Datastore fallback/overlay rows. */
export function stableSortedCopy<T>(items: readonly T[], compare: (left: T, right: T) => number): T[] {
	let source: T[] = [];
	for (let index = 0; index < items.length; index++) source[index] = items[index];
	// Bottom-up merge sort bounds comparisons to O(n log n) and does not rely
	// on mutable Array.prototype.sort/slice methods used by application code.
	for (let width = 1; width < source.length; width *= 2) {
		const target: T[] = [];
		for (let start = 0; start < source.length; start += width * 2) {
			const middle = Math.min(start + width, source.length);
			const end = Math.min(start + width * 2, source.length);
			let left = start;
			let right = middle;
			for (let position = start; position < end; position++) {
				if (left < middle && (right >= end || compare(source[left], source[right]) <= 0)) {
					target[position] = source[left++];
				} else {
					target[position] = source[right++];
				}
			}
		}
		source = target;
	}
	return source;
}
