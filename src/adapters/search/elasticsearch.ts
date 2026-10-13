import type { SearchAdapter } from '../../core/types.js';
import { createElasticsearchCompatibleSearchAdapter, type ElasticsearchOptions } from './elasticsearch-shared.js';

export type { ElasticsearchOptions } from './elasticsearch-shared.js';

export async function createElasticsearchSearchAdapter(options: ElasticsearchOptions = {}): Promise<SearchAdapter> {
	return createElasticsearchCompatibleSearchAdapter(options, 'elasticsearch');
}
