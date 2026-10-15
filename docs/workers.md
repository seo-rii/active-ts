# Static Datastore clients and Workers

Use `active-ts/adapters/store/datastore-injected` when the runtime cannot resolve
optional packages dynamically. This entry shares the Datastore implementation
with the convenience entry and has no optional SDK loader in its import graph.
It requires a client. Import the SDK from a statically bundled, runtime-compatible
module and pass its actual `Datastore.KEY` symbol:

```ts doc-test=fragment
import { Datastore } from './validated-datastore-sdk.js';
import { createDatastoreStoreAdapter } from 'active-ts/adapters/store/datastore-injected';

const client = new Datastore({ projectId: 'example', databaseId: 'records' });
const store = await createDatastoreStoreAdapter({
  client,
  keySymbol: Datastore.KEY,
  keyEncoding: 'native'
});
```

The example SDK module is supplied by the application. The standard SDK and its
gRPC transport are not made Workers-compatible merely by injecting them. The
library peer contract remains Datastore `^10.0.0` and typia `^12.0.0`; Datastore 11
and typia 11 are not claimed as supported by this fixture. A typia parser must be
compiled with the matching transformer; runtime injection does not run it.

`pnpm pack:smoke` installs the actual package tarball without optional peers, checks
its public ESM declarations, bundles a typed read/page/mutation consumer with
esbuild, and executes it in workerd with `nodejs_compat`. The Workers fixture uses
a deterministic SDK-shaped client and denies outbound network connections. It
checks native key metadata, aggregation, transactions, Typed Views and provider
error identity. A separate unit test uses Datastore 10.1.0's real key implementation
with its network lookup replaced. These checks establish library portability and
the injection boundary; they do not establish real Datastore RPC support in Workers.

The package is ESM-only, targets Node 22+ with TypeScript 5.9/NodeNext declarations,
and requires Node compatibility APIs in Workers. See the
[Workers Node compatibility documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).
The package's CLI and unrelated database drivers must not enter the static bundle.
The fixture rejects dynamic imports and checks the actual bundle dependency graph.

Keep model definitions, credentials, adapters and Typed View resolvers in server
modules. Export DTO types to browser code using `import type`; do not export a
server model or View descriptor through a shared browser entry. The library does
not enforce a framework-specific server-only module convention.

A client can be shared when its transport supports that lifecycle. Bind models
to an explicit request context with `Model.use(context)`; transaction handles,
viewer state and request I/O belong to their own request. Do not update a global
default context for concurrent requests.
