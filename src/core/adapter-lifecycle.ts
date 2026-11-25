/** Share concurrent closes and allow retry after a failed owned-resource close. */
export function createAdapterCloser(dispose?: () => unknown): () => Promise<void> {
	let completed = false;
	let pending: Promise<void> | undefined;
	return async () => {
		if (!dispose || completed) return;
		const attempt = pending ??= (async () => {
			await dispose();
			completed = true;
		})();
		try {
			await attempt;
		} finally {
			if (!completed && pending === attempt) pending = undefined;
		}
	};
}
