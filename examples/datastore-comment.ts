import {
	Model,
	createActiveTs,
	datastoreKey,
	defineModel,
	setDefaultContext
} from '../src/index.js';
import {
	createDatastoreIndexYaml,
	createDatastoreStoreAdapter
} from '../src/adapters/store/datastore.js';

type CommentData = {
	id: number;
	postId: number;
	body: string;
	updatedAt: number;
};

class Comment extends Model<CommentData> {}

defineModel<CommentData>({ name: 'comment', store: 'datastore' })
	.id('id')
	.validate((input) => input as CommentData)
	.fieldType('updatedAt', 'number')
	.index('updatedAt', { name: 'by_updated_at', directions: ['desc'] })
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('post', data.postId) : undefined,
		ancestorFields: ['postId'],
		unindexed: ['body']
	})
	.attach(Comment);

const datastore = await createDatastoreStoreAdapter({
	namespace: process.env.DATASTORE_NAMESPACE,
	datastoreOptions: { projectId: process.env.GOOGLE_CLOUD_PROJECT }
});
const context = createActiveTs({
	defaultStore: 'datastore',
	stores: { datastore }
});
setDefaultContext(context);

const postKey = datastoreKey('post', 1);
const CommentForContext = Comment.use(context) as typeof Comment;

await CommentForContext.create({
	id: 1,
	postId: 1,
	body: 'hello from Datastore',
	updatedAt: Date.now()
});

const recent = await CommentForContext
	.under(postKey)
	.orderBy({ field: 'updatedAt', direction: 'desc' })
	.limit(10)
	.load();

console.log(recent.list.map((comment) => comment.data.body));
console.log(createDatastoreIndexYaml(context.meta(Comment)));
