import type { ActiveContext } from './context.js';

export type EntityId = string | number;
export type MaybePromise<T> = T | Promise<T>;
export type ValidationMode = 'off' | 'warn' | 'error';
export type SchemaSyncMode = 'off' | 'safe';

export type Constructor<T> = new (...args: any[]) => T;
export type ModelConstructor<TModel extends any = any> = Constructor<TModel> & {
	modelName?: string;
};

export type Operator =
	| '='
	| '!='
	| '>'
	| '>='
	| '<'
	| '<='
	| 'in'
	| 'between'
	| 'isNull'
	| 'isNotNull'
	| 'contains'
	| 'arrayContains'
	| 'textContains'
	| 'jsonContains'
	| 'startsWith';

export type WhereScalar = string | number | boolean | Date | null;
export type WhereRangeScalar = string | number | Date;
export type UnaryWhereOperator = 'isNull' | 'isNotNull';
export type RangeWhereOperator = '>' | '>=' | '<' | '<=';

export type WhereValue =
	| WhereScalar
	| readonly ['=', WhereScalar]
	| readonly ['!=', WhereScalar]
	| readonly ['in', readonly WhereScalar[]]
	| readonly ['between', WhereRangeScalar, WhereRangeScalar]
	| readonly [RangeWhereOperator, WhereRangeScalar]
	| readonly [UnaryWhereOperator]
	| readonly ['arrayContains', WhereScalar]
	| readonly ['textContains', string]
	| readonly ['jsonContains', unknown]
	| readonly ['startsWith', string];

export type WhereShape<TData extends Record<string, any> = Record<string, any>> = Partial<{
	[K in keyof TData | string]: WhereValue;
}>;

export type SortDirection = 'asc' | 'desc';
export type SortSpec<TData extends Record<string, any> = Record<string, any>> =
	| keyof TData
	| string
	| `-${string}`
	| { field: keyof TData | string; direction?: SortDirection };

export type QueryNative = {
	adapter?: string;
	payload: unknown;
};

export type QueryMeta = Record<string, unknown>;

export type QueryPlan<TData extends Record<string, any> = Record<string, any>> = {
	where: Array<{ field: string; op: Operator; value: unknown; value2?: unknown }>;
	or: QueryPlan<TData>[];
	sort: Array<{ field: string; direction: SortDirection }>;
	limit?: number;
	offset?: number;
	cursor?: string;
	select?: string[];
	include: string[];
	native?: QueryNative;
	meta?: QueryMeta;
};

export type QueryResult<TData = any> = {
	list: TData[];
	cursor?: string;
	more?: boolean;
	count?: number;
	total?: number;
};

export type AggregateOperator = 'count' | 'sum' | 'avg' | 'min' | 'max';

export type FieldAggregateOperator = Exclude<AggregateOperator, 'count'>;

export type AggregateSpec =
	| {
			op: 'count';
			field?: undefined;
			as: string;
		}
	| {
			op: FieldAggregateOperator;
			field: string;
			as: string;
		};

export type AggregatePlan<TData extends Record<string, any> = Record<string, any>> = {
	where: QueryPlan<TData>['where'];
	or: QueryPlan<TData>['or'];
	aggregates: AggregateSpec[];
	native?: QueryNative;
	meta?: QueryMeta;
};

export type AggregateResult = Record<string, number | string | Date | null>;

export type SchemaChange =
	| { type: 'create-collection'; target: string }
	| { type: 'create-index'; target: string; name: string; fields: string[]; directions?: SortDirection[]; unique?: boolean; ancestor?: boolean }
	| { type: 'create-search-index'; target: string; name: string; fields: string[] };

export type SchemaPlan = {
	adapter: string;
	route?: string;
	changes: SchemaChange[];
	status?: 'planned' | 'applied' | 'manual';
	note?: string;
};

export type StoreCapabilities = Partial<{
	or: boolean;
	contains: boolean;
	arrayContains: boolean;
	textContains: boolean;
	jsonContains: boolean;
	startsWith: boolean;
	cursor: boolean;
	offset: boolean;
	select: boolean;
	nestedFields: boolean;
	numericComparisons: boolean;
	aggregate: boolean;
	transaction: boolean;
	transactionConflictDetection: boolean;
	savepoint: boolean;
	uniqueIndex: boolean;
	optimisticLock: boolean;
	nullOperators: boolean;
	missingFieldNulls: boolean;
	native: boolean;
	datastoreAncestor: boolean;
	datastoreReadPolicy: boolean;
}>;

export type TransactionIsolationLevel = 'readCommitted' | 'repeatableRead' | 'serializable';
export type TransactionJoinMode = 'error' | 'reuse' | 'savepoint';

export type StoreTransactionOptions = {
	isolation?: TransactionIsolationLevel;
	readOnly?: boolean;
	timeoutMs?: number;
	native?: unknown;
};

export type TransactionOptions = StoreTransactionOptions & {
	store?: string;
	join?: TransactionJoinMode;
};

export type ModelTransactionOptions = Omit<TransactionOptions, 'store'>;

export type SearchCapabilities = Partial<{
	where: boolean;
	whereOperators: Partial<Record<Operator, boolean>>;
	nestedFields: boolean;
	numericComparisons: boolean;
	nullOperators: boolean;
	cursor: boolean;
	native: boolean;
	index: boolean;
}>;

export type StoreAdapter = {
	kind: string;
	capabilities?: StoreCapabilities;
	cacheScope?: string;
	datastoreNamespace?: string;
	/** Explicit Datastore project identity; `undefined` means the project is unknown. */
	datastoreProjectId?: string;
	/** `null` denotes the default Datastore database; `undefined` means the database is unknown. */
	datastoreDatabaseId?: string | null;
	datastoreKeyEncoding?: 'active-ts' | 'native';
	get: (model: ResolvedModelMeta, id: EntityId, options?: StoreReadOptions) => Promise<any | null>;
	getMany: (
		model: ResolvedModelMeta,
		ids: EntityId[],
		options?: StoreReadOptions
	) => Promise<Array<any | null>>;
	query: (model: ResolvedModelMeta, plan: QueryPlan, options?: StoreReadOptions) => Promise<QueryResult>;
	aggregate?: (model: ResolvedModelMeta, plan: AggregatePlan) => Promise<AggregateResult>;
	create: (model: ResolvedModelMeta, id: EntityId, data: any, options?: StoreWriteOptions) => Promise<void>;
	update: (model: ResolvedModelMeta, id: EntityId, data: any, options?: StoreWriteOptions) => Promise<void>;
	delete: (model: ResolvedModelMeta, id: EntityId, options?: StoreWriteOptions) => Promise<void>;
	transaction?: <T>(fn: (tx: StoreAdapter) => Promise<T>, options?: StoreTransactionOptions) => Promise<T>;
	savepoint?: <T>(fn: (tx: StoreAdapter) => Promise<T>) => Promise<T>;
	schema?: {
		plan: (models: ResolvedModelMeta[]) => Promise<SchemaPlan>;
		apply: (models: ResolvedModelMeta[], options: { mode: Exclude<SchemaSyncMode, 'off'> }) => Promise<SchemaPlan>;
	};
};

export type CacheAdapter = {
	kind: string;
	getMany: (keys: string[]) => Promise<Array<any | undefined>>;
	setMany: (entries: Array<[string, any]>, options?: CacheWriteOptions) => Promise<void>;
	deleteMany: (keys: string[]) => Promise<void>;
	codecKey?: (key: string) => string;
};

export type SearchAdapter = {
	kind: string;
	searchIndexKind?: string;
	capabilities?: SearchCapabilities;
	search: (model: ResolvedModelMeta, query: string, options: SearchOptions) => Promise<QueryResult>;
	index: (model: ResolvedModelMeta, id: EntityId, data: any) => Promise<void>;
	delete: (model: ResolvedModelMeta, id: EntityId) => Promise<void>;
	schema?: {
		plan: (models: ResolvedModelMeta[]) => Promise<SchemaPlan>;
		apply: (models: ResolvedModelMeta[], options: { mode: Exclude<SchemaSyncMode, 'off'> }) => Promise<SchemaPlan>;
	};
	syncSchema?: (models: ResolvedModelMeta[]) => Promise<SchemaPlan>;
};

export type StoreReadOptions = {
	select?: string[];
	native?: unknown;
	meta?: QueryMeta;
};

export type StoreWriteOptions = {
	expectedVersion?: number;
	meta?: QueryMeta;
};

export type CacheWriteOptions = {
	ttl?: number;
};

export type CacheCodecContext = {
	key: string;
	adapter?: string;
	operation: 'get' | 'set';
};

export type CacheCodec<TStored = any> = {
	name: string;
	encode: (value: any, context: CacheCodecContext) => MaybePromise<TStored>;
	decode: (value: TStored, context: CacheCodecContext) => MaybePromise<any>;
};

export type FieldCodecContext = {
	model: ResolvedModelMeta;
	field: string;
	operation: 'read' | 'write' | 'query';
	operator?: Operator;
};

export type FieldCodecQueryOperator = Exclude<Operator, 'contains' | 'isNull' | 'isNotNull'>;

export type FieldCodec = {
	name: string;
	encode: (value: any, context: FieldCodecContext) => any;
	decode: (value: any, context: FieldCodecContext) => any;
	encodeQuery?: (value: any, context: FieldCodecContext) => any;
	queryOperators?: readonly FieldCodecQueryOperator[];
};

export type FieldType = 'string' | 'number' | 'boolean' | 'date';

export type SearchOptions = {
	where?: WhereShape;
	limit?: number;
	cursor?: string;
	native?: unknown;
};

export type QueryPlannerRouteInput = {
	context: ActiveContext;
	model: ResolvedModelMeta;
	plan: QueryPlan;
};

export type AggregatePlannerRouteInput = {
	context: ActiveContext;
	model: ResolvedModelMeta;
	plan: AggregatePlan;
};

export type SearchPlannerRouteInput = {
	context: ActiveContext;
	model: ResolvedModelMeta;
	query: string;
	options: SearchOptions;
	requested?: string;
};

export type SearchPlannerSchemaInput = {
	context: ActiveContext;
	model: ResolvedModelMeta;
};

export type QueryPlanner = {
	routeQuery?: (input: QueryPlannerRouteInput) => string | undefined;
	routeAggregate?: (input: AggregatePlannerRouteInput) => string | undefined;
	routeSearch?: (input: SearchPlannerRouteInput) => string | undefined;
	schemaSearchAdapters?: readonly string[] | ((input: SearchPlannerSchemaInput) => readonly string[]);
};

export type ActiveTsHookName =
	| 'beforeValidate'
	| 'afterValidate'
	| 'beforeRead'
	| 'afterRead'
	| 'afterInstantiate'
	| 'beforeCreate'
	| 'afterCreate'
	| 'beforeUpdate'
	| 'afterUpdate'
	| 'beforeDelete'
	| 'afterDelete'
	| 'afterStoreWrite'
	| 'beforeQuery'
	| 'afterQuery'
	| 'beforeAggregate'
	| 'afterAggregate'
	| 'beforeSearch'
	| 'afterSearch'
	| 'beforeIndex'
	| 'afterIndex'
	| 'beforeCacheGet'
	| 'afterCacheGet'
	| 'beforeCacheSet'
	| 'afterCacheSet'
	| 'beforeCacheInvalidate'
	| 'afterCacheInvalidate'
	| 'beforeRelationLoad'
	| 'afterRelationLoad';

export type ActiveTsHookPayload = {
	context: ActiveContext;
	model?: ResolvedModelMeta;
	target?: unknown;
	id?: EntityId;
	ids?: EntityId[];
	data?: any;
	patch?: any;
	plan?: QueryPlan | AggregatePlan;
	query?: string;
	options?: unknown;
	result?: any;
	error?: unknown;
	operation?: string;
	meta?: Record<string, unknown>;
};

export type ActiveTsHook = (
	payload: ActiveTsHookPayload
) => MaybePromise<void | ActiveTsHookPayload | Partial<ActiveTsHookPayload>>;

export type ActiveTsHooks = Partial<Record<ActiveTsHookName, ActiveTsHook | ActiveTsHook[]>>;

export type ActiveTsPlugin = {
	name: string;
	hooks?: ActiveTsHooks;
	setup?: (context: ActiveContext) => MaybePromise<void>;
};

export type ViewInput<TModel = any, TData = any> = {
	context: ActiveContext;
	model: TModel;
	data: TData;
	viewer?: unknown;
	name: string;
};

export type ViewResolver<TData = any, TModel = any> = (
	input: ViewInput<TModel, TData>
) => MaybePromise<unknown>;

export type PolicyInput<TModel = any, TData = any> = {
	context: ActiveContext;
	model: TModel;
	data: TData;
	viewer?: unknown;
	policy: string;
};

export type PolicyResolver<TData = any, TModel = any> = (
	input: PolicyInput<TModel, TData>
) => MaybePromise<boolean>;

export type ScopeInput<TData = any> = {
	context: ActiveContext;
	model: ResolvedModelMeta<TData>;
	viewer?: unknown;
	args?: unknown;
	scope: string;
};

export type ScopeResolver<TData = any> = (input: ScopeInput<TData>) => WhereShape | void;

export type Validator<TData = any> = (input: unknown) => TData;

export type IndexMeta = {
	name: string;
	fields: string[];
	directions?: SortDirection[];
	unique?: boolean;
};

export type SearchIndexMeta = {
	name: string;
	adapter?: string;
	fields: string[];
};

export type DatastoreKeyPart = {
	kind: string;
	id: EntityId;
};

export type DatastoreKey = {
	path: DatastoreKeyPart[];
	namespace?: string;
};

export type DatastoreAncestorInput<TData = any> = {
	model: Pick<ResolvedModelMeta<TData>, 'name' | 'idField'>;
	id: EntityId;
	data?: TData;
};

export type DatastoreAncestorResolver<TData = any> = (
	input: DatastoreAncestorInput<TData>
) => DatastoreKey | undefined;

export type DatastoreModelMeta<TData = any> = {
	ancestor?: DatastoreAncestorResolver<TData>;
	ancestorFields?: string[];
	unindexed?: string[];
};

export type EntityOptions = {
	name: string;
	store?: string;
	cache?: false | { adapter?: string; ttl?: number; negativeTtl?: number };
	search?: string;
};

export type RelationKind = 'one' | 'many';

export type RelationAncestorInput<TData = any> = {
	context: ActiveContext;
	owner: any;
	data: TData;
	ownerModel: ResolvedModelMeta<TData>;
	targetModel: ResolvedModelMeta;
	relation: Pick<RelationMeta, 'name' | 'kind' | 'localKey' | 'foreignKey'>;
};

export type RelationAncestorResolver<TData = any> = (
	input: RelationAncestorInput<TData>
) => DatastoreKey | undefined;

export type RelationMeta = {
	name: string;
	kind: RelationKind;
	target: () => ModelConstructor;
	localKey: string;
	foreignKey: string;
	preload?: string[];
	warnOnLazy?: boolean;
	ancestor?: RelationAncestorResolver;
};

export type IncludeSpec = string | IncludeMap;

export interface IncludeMap {
	[relation: string]: IncludeSpec | IncludeSpec[] | true;
}

export type ModelMeta<TData = any> = {
	entity?: EntityOptions;
	idField?: string;
	validator?: Validator<TData>;
	readValidation?: ValidationMode;
	indexes: IndexMeta[];
	searchIndexes: SearchIndexMeta[];
	relations: Map<string, RelationMeta>;
	hooks?: ActiveTsHooks;
	views?: Map<string, ViewResolver<TData>>;
	policies?: Map<string, PolicyResolver<TData>>;
	scopes?: Map<string, ScopeResolver<TData>>;
	fieldCodecs?: Map<string, FieldCodec>;
	fieldTypes?: Map<string, FieldType>;
	datastore?: DatastoreModelMeta<TData>;
};

export type ResolvedModelMeta<TData = any> = {
	model: ModelConstructor;
	name: string;
	store: string;
	cache?: { adapter: string; ttl?: number; negativeTtl?: number };
	search?: string;
	searchDocumentIdentity?: string;
	idField: string;
	validator?: Validator<TData>;
	readValidation: ValidationMode;
	indexes: IndexMeta[];
	searchIndexes: SearchIndexMeta[];
	relations: Map<string, RelationMeta>;
	hooks: ActiveTsHooks;
	views: Map<string, ViewResolver<TData>>;
	policies: Map<string, PolicyResolver<TData>>;
	scopes: Map<string, ScopeResolver<TData>>;
	fieldCodecs: Map<string, FieldCodec>;
	fieldTypes: Map<string, FieldType>;
	datastore?: DatastoreModelMeta<TData>;
};

export type CacheKeyInput = {
	model: ResolvedModelMeta;
	id: EntityId;
	baseKey: string;
};

export type CacheKeyResolver = (input: CacheKeyInput) => string;

export type ActiveTsConfig = {
	defaultStore?: string;
	defaultCache?: string;
	defaultSearch?: string;
	lazyWarnings?: boolean;
	schema?: { autoSync?: SchemaSyncMode };
	batch?: { maxSize?: number };
	aggregate?: { allowQueryFallback?: boolean };
	stores: Record<string, StoreAdapter>;
	caches?: Record<string, CacheAdapter>;
	search?: Record<string, SearchAdapter>;
	plugins?: ActiveTsPlugin[];
	queryPlanner?: QueryPlanner;
	cacheKey?: CacheKeyResolver;
};
