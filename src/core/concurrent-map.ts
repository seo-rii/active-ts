/** Bound configured work per collection; preserve the default Promise.all behavior. */
export async function mapConcurrent<T, TResult>(
	items: readonly T[],
	concurrency: number | undefined,
	operation: (item: T, index: number) => Promise<TResult> | TResult
): Promise<TResult[]> {
	if (concurrency === undefined) {
		const tasks: Array<Promise<TResult> | TResult> = [];
		for (let index = 0; index < items.length; index++) tasks[index] = operation(items[index], index);
		return await Promise.all(tasks);
	}
	const results: TResult[] = new Array(items.length);
	let nextIndex = 0;
	let failed = false;
	let firstError: unknown;
	const worker = async () => {
		while (!failed && nextIndex < items.length) {
			const index = nextIndex++;
			try {
				results[index] = await operation(items[index], index);
			} catch (error) {
				if (!failed) { failed = true; firstError = error; }
			}
		}
	};
	const workers: Array<Promise<void>> = [];
	const limit = Math.min(concurrency, items.length);
	for (let index = 0; index < limit; index++) workers[index] = worker();
	await Promise.all(workers);
	if (failed) throw firstError;
	return results;
}
