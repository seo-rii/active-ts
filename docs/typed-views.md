# Typed views and bound model constructors

This is an additive experimental contract. Existing `view('name')` and `view<T>('name')` calls remain source-compatible; the latter remains a caller assertion, not proof of the serialized shape.

## Bound models

`Account.use(context)` preserves the concrete constructor type, static members, instance methods and data shape. The previous `as typeof Account` workaround is no longer required. Runtime context selection is unchanged. Rebinding remains explicit: applications must not change a global default context per request.

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

`dto` is inferred from `parse`. The registered wrapper always awaits the parser, including legacy string reads. A typed read checks the exact registered resolver identity, so another same-name descriptor or replaced metadata cannot silently change the contract.

Callbacks are captured when the frozen descriptor is created. Configuration accepts only `name`, `resolve`, and `parse` as enumerable own data properties; getters, symbols, hidden or inherited properties are rejected. Callback-bearing configuration is not passed to the ORM's stored-data validator. A dedicated fresh-process test covers this boundary independently of the rest of the test suite.

`parse` is public so a transport layer can reuse the output contract. Calling it alone does not load or authorize a model. If a parser transforms rather than merely validates, do not apply it twice; a transport integration must choose an explicit validation/serialization boundary.

## Boundaries that remain unchanged

Views do not authorize reads. Perform request-level checks, tenant-scoped lookup and record policies before exposing data. Partial projected models cannot run views. Both callbacks remain inside the existing tracked view operation. An awaited parser rejection inside a transaction rolls back surrounding writes. Models returned after successful commit intentionally rebind to their root context and can be read or saved afterward; they are not expired transaction handles.

The ORM does not introduce a JSON-only DTO restriction; transport adapters may restrict types further. Typed descriptors are server metadata, not browser data. Field selection, nested graph planning, client caches, mutation automation and default-context request scoping are not implemented here.

## Verification

Run `pnpm typecheck`, `pnpm test`, and `pnpm pack:smoke` using the repository lockfile. New runtime cases are in `test/typed-view-regression.test.ts` and `test/typed-view-options-regression.test.ts`. Positive/negative type contracts are in `test/typed-view-types.ts`. Use actual PR CI results rather than an isolated constructor-inference reproduction as evidence of complete-package compatibility.
