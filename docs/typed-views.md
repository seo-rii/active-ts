# Typed views and bound model constructors

This is an additive experimental contract. Existing `view('name')` and `view<T>('name')` calls remain source-compatible; the latter is still a caller assertion, not proof of the serialized shape.

## Bound models

`Account.use(context)` now preserves the concrete constructor type, its static members, instance methods and data shape. The previous `as typeof Account` workaround is no longer required. Runtime context selection is unchanged. Rebinding remains explicit; this is not an automatic per-request context provider, and applications must not change a global default context per request.

## Define and register a typed view

```ts doc-test=fragment
const summary = defineTypedView<AccountData>()({
  name: 'summary',
  resolve: ({ data }) => ({ id: data.id, handle: data.handle }),
  parse: (value) => summarySchema.parse(value)
});

defineModel<AccountData>({ name: 'account' })
  .id('id')
  .view(summary)
  .attach(Account);

const BoundAccount = Account.use(requestContext);
const account = await BoundAccount.find(id).load();
if (!account || !(await account.can('read', viewer))) throw new Error('Denied');
const dto = await account.view(summary, viewer);
```

`dto` is inferred from `parse`. The resolver may return unknown data, but the registered wrapper always awaits the parser. String reads of the same registered view also use that wrapper. A typed read checks the exact registered resolver identity, so another descriptor with the same name or replaced metadata cannot silently change the contract.

The contract object is frozen and callbacks are captured at definition. Forged descriptor-shaped objects are rejected. `parse` is public to let a separate transport layer reuse the same output contract; calling `parse` alone does not load or authorize a model.

## Boundaries that remain unchanged

Views do not authorize reads. Perform request-level checks, tenant-scoped lookup and record policies before exposing data. Partial projected models cannot run views. Both the resolver and parser run inside the existing tracked view operation, preserving transaction-lifetime checks. The ORM does not introduce a JSON-only DTO restriction; individual transport adapters may restrict types further.

The typed descriptor is server metadata, not something to serialize or import into a browser. Field selection, nested graph planning, client caches, mutation automation and default-context request scoping are not implemented here.

## Verification

`pnpm typecheck`, `pnpm test`, and `pnpm pack:smoke` cover the package. New runtime cases are in `test/typed-view-regression.test.ts`, and positive/negative type contracts are in `test/typed-view-types.ts`. Runtime and complete-package results must be taken from the PR's actual CI run; an isolated TypeScript reproduction of the constructor fix alone is not full-package verification.
