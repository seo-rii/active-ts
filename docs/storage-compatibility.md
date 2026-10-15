# Datastore storage compatibility

Existing datasets need an explicit key and indexing contract before enabling
writes. Use `keyEncoding: 'native'` for native Datastore numeric IDs and names;
numeric `17` and name `"17"` remain different keys. Use `datastoreInt64Id()` for
numeric IDs outside JavaScript's safe integer range. Inventory and reviewed
repair manifests are separate maintenance operations; normal reads do not
rewrite keys or repair payload IDs.

## Configure index exclusions before saving

`datastore.unindexed` uses the Datastore SDK's exclusion notation:

```ts doc-test=fragment
defineModel<RecordData>('record')
	.id('id')
	.datastore({
		unindexed: [
			'body',             // scalar property
			'profile.note',     // nested property
			'tags[]',           // every array element
			'details[].note',   // a property of each entity in an array
			'private.*',        // recursively exclude an embedded entity's fields
			'attachments[].*'   // recursively exclude each array element's fields
		]
	})
	.attach(RecordModel);
```

The same exclusions apply to single-row writes, buffered transaction writes,
and bulk upserts. Exclusion paths are validated before SDK I/O. Array notation
cannot bypass reserved-property checks or overlap the indexed ID field or any
declared index. For example, `id[]`, an index on `details.note` alongside
`details[].note`, and an index on `private.email` alongside `private.*` fail
explicitly.

Use dotted property names, optional `[]` after an array property, and an
optional final `.*`. Numeric array indexes, repeated array markers, and
wildcards in the middle of a path are unsupported. The supported SDK 10 path
walker also cannot apply a recursive wildcard below an array child:
`details[].private.*` would silently leave fields indexed. Active-ts rejects
that form; enumerate exact paths such as `details[].private.note`, or exclude
the complete element with `details[].*`.

The SDK returns property values without their original `excludeFromIndexes`
metadata. Active-ts therefore cannot infer or preserve a different exclusion
list for each legacy entity. Configure the existing writer's complete exclusion
policy before a read-save migration. ID repair manifests likewise require an
explicit reviewed `excludeFromIndexes` list and enforce the same path rules.
An empty repair exclusion list explicitly means that no properties are excluded.

## Preserve the complete stored entity

Low-level adapter reads retain unknown safe payload fields, nested arrays, and
explicit `null`. Passing that complete portable row back to `update()`
preserves those values and its native key identity. Adapter `update()` and bulk
upsert write complete entity payloads; they do not fetch and merge omitted
fields. Undefined object properties are omitted, while explicit `null` is stored.
Raw binary values are rejected by the portable write contract; configure a
field codec before saving entities containing blobs. A readable legacy entity
is not automatically writable under the portable contract.

Model validators and pruning remain application-controlled transformations.
Review validators before adopting a shared dataset, including fields written by
other services. Keep public View DTOs separate from the stored entity; a public
projection is not a complete replacement payload. Historical `readAt()` model
instances and projected model instances already reject persistence.

The regression suite checks native numeric/name identity, namespace, unknown
payload fields, configured exclusions, exclusion guards, and SDK protobuf
encoding without contacting a backend. These checks do not claim emulator or
production validation of pre-existing entity metadata.

SDK exclusion behavior reference:
[Datastore 10 entity encoder](https://github.com/googleapis/nodejs-datastore/blob/v10.0.0/src/entity.ts).
