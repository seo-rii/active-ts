import { ActiveTsConfigurationError } from './errors.js';
import type { QueryBuilder } from './query.js';

/** Relation arrays have no pagination metadata, so they must represent complete results. */
export async function loadCompleteRelationQuery<TModel extends { data: any }>(query: QueryBuilder<TModel>) {
	const result = await query.load();
	if (result.more === true) {
		throw new ActiveTsConfigurationError(
			'Relation loading requires a complete query result. Load the related model with an explicitly paginated query instead.'
		);
	}
	return result.list;
}
