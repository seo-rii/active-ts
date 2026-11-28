import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Datastore } from '@google-cloud/datastore';
import { ActiveTsConfigurationError, type ResolvedModelMeta } from '../src/index.js';
import {
	applyDatastoreIdRepairManifest,
	createDatastoreIdRepairManifest,
	createDatastoreStoreAdapter,
	type DatastoreIdInventoryIssue,
	type DatastoreIdRepairPolicy
} from '../src/adapters/store/datastore.js';

// The SDK decodes integers and doubles to the same JavaScript number and
// writes an integer-valued number back as an integer, so an ID repair that
// copies an SDK entity would turn the double 10 into the integer 10, 1e21
// into the integer 1, and 2 ** 60 into an integer the SDK cannot read. The
// fake client below stores entity protos and runs the SDK's own decoder and
// encoder on every read and write, as the real client does.
const sdkEntityModule = '@google-cloud/datastore/build/src/entity.js';
const { entity: sdkEntity } = await import(sdkEntityModule);

const KIND = 'repair_numbers';
const TARGET = 'gcp:active-ts-test/(default)';
const INVENTORY_ID = '123e4567-e89b-42d3-a456-426614174000';
const meta: ResolvedModelMeta = { model: class {}, name: KIND, store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
	fieldTypes: new Map([['price', 'number'], ['metrics.score', 'number']]) };

type ValueProto = Record<string, any>;
type Properties = Record<string, ValueProto>;

const VALUE_TYPES = ['nullValue', 'booleanValue', 'integerValue', 'doubleValue', 'timestampValue', 'keyValue',
	'stringValue', 'blobValue', 'geoPointValue', 'entityValue', 'arrayValue'];

// The service returns every value with its oneof name, which the SDK decoder reads.
function storedValue(value: ValueProto): ValueProto {
	const valueType = VALUE_TYPES.find((type) => Object.hasOwn(value, type))!;
	if (valueType === 'arrayValue') return { valueType, arrayValue: { values: value.arrayValue.values.map(storedValue) } };
	if (valueType === 'entityValue') {
		return { valueType, entityValue: { properties: storedProperties(value.entityValue.properties) } };
	}
	return { valueType, [valueType]: value[valueType] };
}

function storedProperties(properties: Properties): Properties {
	return Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, storedValue(value)]));
}

// What the adapter with typedNumbers: 'double' stores for an entity.
async function adapterStoredProperties(id: number, data: Record<string, unknown>) {
	const saved: any[] = [];
	const record = async (entity: unknown) => { saved.push(entity); };
	const client = { KEY: Symbol('key'), key: (input: unknown) => input, get: async () => [undefined],
		insert: record, update: record, upsert: record, save: record, delete: async () => undefined,
		createQuery: () => ({}), runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		double: (value: number) => Datastore.double(value) };
	const store = await createDatastoreStoreAdapter({ client, keyEncoding: 'native', typedNumbers: 'double' });
	await store.create(meta, id, { id, ...data });
	assert.equal(saved.length, 1);
	return storedProperties(sdkEntity.entityToEntityProto(saved[0]).properties);
}

function storedEntityClient(rows: Map<string, Properties>, overrides: Record<string, unknown> = {}) {
	const reads: unknown[] = [];
	const transactions: number[] = [];
	const identity = (key: { path: unknown[] }) => JSON.stringify(key.path);
	const read = async (key: { path: unknown[] }, options?: { wrapNumbers?: unknown }) => {
		reads.push(options);
		const properties = rows.get(identity(key));
		// The decoder annotates the protos it reads, so decode a copy.
		return [properties === undefined
			? undefined
			: sdkEntity.entityFromEntityProto({ properties: structuredClone(properties) }, options?.wrapNumbers)];
	};
	const write = ({ key, data, excludeFromIndexes }: any) => {
		rows.set(identity(key), storedProperties(sdkEntity.entityToEntityProto({ data, excludeFromIndexes }).properties));
	};
	const client = {
		key: (input: { path: unknown[] }) => ({ path: [...input.path] }),
		double: (value: number) => Datastore.double(value),
		get: read,
		transaction: () => {
			transactions.push(transactions.length);
			return {
				run: async () => undefined,
				commit: async () => undefined,
				rollback: async () => undefined,
				get: read,
				update: write,
				insert: write,
				delete: (key: { path: unknown[] }) => { rows.delete(identity(key)); }
			};
		},
		...overrides
	};
	return { client, reads, transactions };
}

function manifestFor(ids: number[], policy: DatastoreIdRepairPolicy) {
	const issues: DatastoreIdInventoryIssue[] = ids.map((id, issueIndex) => ({
		inventoryId: INVENTORY_ID,
		issueIndex,
		classification: 'type-mismatch',
		key: { path: [{ kind: KIND, storage: 'id', value: String(id) }] },
		payload: { type: 'string', value: String(id) },
		reason: 'Physical key and payload have matching text but different ID types.'
	}));
	const hash = createHash('sha256');
	for (const issue of issues) hash.update(`${JSON.stringify(issue)}\n`);
	return createDatastoreIdRepairManifest({
		report: {
			inventoryId: INVENTORY_ID,
			issueDigest: `sha256:${hash.digest('hex')}`,
			kind: KIND,
			idField: 'id',
			scanned: ids.length,
			pages: 1,
			counts: { match: 0, 'type-mismatch': ids.length, 'value-mismatch': 0, 'missing-payload-id': 0,
				'invalid-payload-id': 0, 'unsupported-key': 0 }
		},
		issues,
		target: TARGET,
		policy,
		excludeFromIndexes: [],
		...(policy === 'payload-wins' ? { allowKeyMoves: true as const, descendantPolicy: 'verified-none' as const } : {})
	});
}

const apply = (client: object, manifest: ReturnType<typeof manifestFor>) =>
	applyDatastoreIdRepairManifest({ client, manifest, target: TARGET, confirm: manifest.digest });

const numbers = { price: 10, metrics: { score: 10, raw: 10 }, exponent: 1e21, power: 2 ** 60,
	maximum: Number.MAX_VALUE, nested: { values: [2 ** 53, 7, 1e21] }, count: 7, ratio: 0.5 };
const key = (id: number | string) => JSON.stringify([KIND, id]);
const stringId = (id: number): ValueProto => ({ valueType: 'stringValue', stringValue: String(id) });
const integerId = (id: number): ValueProto => ({ valueType: 'integerValue', integerValue: String(id) });

test('Datastore ID repair keeps adapter-written doubles as doubles', async () => {
	const written = await adapterStoredProperties(23, numbers);
	assert.deepEqual(written.price, { valueType: 'doubleValue', doubleValue: 10 });
	assert.deepEqual(written.exponent, { valueType: 'doubleValue', doubleValue: 1e21 });
	assert.deepEqual(written.metrics.entityValue.properties.raw, integerId(10));
	assert.deepEqual(written.count, integerId(7));
	for (const policy of ['key-wins', 'payload-wins'] as const) {
		const drifted = { ...written, id: stringId(23) };
		const rows = new Map<string, Properties>([[key(23), drifted]]);
		const { client, reads } = storedEntityClient(rows);
		assert.deepEqual(await apply(client, manifestFor([23], policy)),
			{ total: 1, processed: 1, repaired: 1, alreadyRepaired: 0, indeterminate: 0 });
		if (policy === 'key-wins') {
			assert.deepEqual([...rows.keys()], [key(23)]);
			assert.deepEqual(rows.get(key(23)), { ...written, id: integerId(23) }, policy);
			assert.deepEqual(await apply(client, manifestFor([23], policy)),
				{ total: 1, processed: 1, repaired: 0, alreadyRepaired: 1, indeterminate: 0 });
		} else {
			assert.deepEqual([...rows.keys()], [key('23')]);
			assert.deepEqual(rows.get(key('23')), drifted, policy);
		}
		assert.ok(reads.length > 0);
		for (const options of reads) assert.deepEqual(options, { wrapNumbers: true });
	}
});

test('Datastore ID repair keeps wide integers and negative zero in their stored types', async () => {
	const legacy: Properties = {
		id: stringId(41),
		wide: { valueType: 'integerValue', integerValue: '9223372036854775807' },
		narrow: { valueType: 'integerValue', integerValue: '-9223372036854775808' },
		negativeZero: { valueType: 'doubleValue', doubleValue: -0 },
		list: { valueType: 'arrayValue', arrayValue: { values: [
			{ valueType: 'integerValue', integerValue: '9007199254740993' },
			{ valueType: 'doubleValue', doubleValue: 3 },
			{ valueType: 'entityValue', entityValue: { properties: {
				deep: { valueType: 'doubleValue', doubleValue: 4 },
				deepInteger: { valueType: 'integerValue', integerValue: '4' }
			} } }
		] } },
		infinity: { valueType: 'doubleValue', doubleValue: Infinity }
	};
	const rows = new Map<string, Properties>([[key(41), legacy]]);
	const { client } = storedEntityClient(rows);
	await apply(client, manifestFor([41], 'key-wins'));
	const repaired = rows.get(key(41))!;
	assert.equal(Object.is(repaired.negativeZero.doubleValue, -0), true);
	assert.deepEqual(repaired, { ...legacy, id: integerId(41) });
});

test('Datastore ID repair needs client.double() only to rewrite integer-valued doubles', async () => {
	const written = await adapterStoredProperties(51, numbers);
	const drifted = { ...written, id: stringId(51) };
	const rows = new Map<string, Properties>([[key(51), drifted], [key(52), { id: stringId(52), count: integerId(7),
		ratio: { valueType: 'doubleValue', doubleValue: 0.5 } }]]);
	const { client, transactions } = storedEntityClient(rows, { double: undefined });
	await assert.rejects(apply(client, manifestFor([52, 51], 'key-wins')), (error: unknown) => {
		assert.ok(error instanceof ActiveTsConfigurationError);
		assert.match(error.message, /preflight 1 source\.price .*client\.double/);
		return true;
	});
	assert.deepEqual(transactions, [], 'preflight fails before any repair transaction');
	assert.deepEqual(rows.get(key(51)), drifted);

	rows.delete(key(51));
	await apply(client, manifestFor([52], 'key-wins'));
	assert.deepEqual(rows.get(key(52)), { id: integerId(52), count: integerId(7),
		ratio: { valueType: 'doubleValue', doubleValue: 0.5 } });
});
