import type { SearchAdapter } from '../../core/types.js';
import {
	createElasticsearchCompatibleSearchAdapter,
	type ElasticsearchOptions
} from './elasticsearch-shared.js';

export type OpenSearchOptions = ElasticsearchOptions;

/** Uses @opensearch-project/opensearch, including its body-based API responses. */
export async function createOpenSearchSearchAdapter(options: OpenSearchOptions = {}): Promise<SearchAdapter> {
	return createElasticsearchCompatibleSearchAdapter(options, 'opensearch');
}
