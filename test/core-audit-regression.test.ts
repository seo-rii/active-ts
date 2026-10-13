import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter, MemoryCacheAdapter } from '../src/index.js';

class EncodedProfile extends Model<{ id: number; profile: { score: number; label: string }; other: string }> {}
defineModel<EncodedProfile['data']>('audit_encoded_profile').id('id').validate((data) => data as EncodedProfile['data'])
	.fieldCodec('profile', { name: 'json', encode: (value) => JSON.stringify(value), decode: (value) => JSON.parse(value as string) })
	.attach(EncodedProfile);

for (const fields of [['profile.score'], ['profile.score', 'profile.label'], ['profile']] as const) {
	test(`codec parent is decoded before selecting ${fields.join(',')}`, async () => {
		const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
		const Records = EncodedProfile.use(context);
		await Records.create({ id: 1, profile: { score: 3, label: 'visible' }, other: 'unselected' });
		const result = await Records.query().select(...fields).load();
		assert.deepEqual(result.list[0].data, {
			id: 1,
			profile: fields.length === 1 && fields[0] === 'profile.score' ? { score: 3 } : { score: 3, label: 'visible' }
		});
	});
}

test('aggregate fallback decodes a selected codec parent before reading child values', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, aggregate: { allowQueryFallback: true } });
	const Records = EncodedProfile.use(context);
	await Records.createMany([
		{ id: 1, profile: { score: 3, label: 'a' }, other: 'a' },
		{ id: 2, profile: { score: 5, label: 'b' }, other: 'b' }
	]);
	assert.equal(await Records.query().sum('profile.score'), 8);
	assert.deepEqual(await Records.query().aggregate({ sum: { op: 'sum', field: 'profile.score' }, count: 'count' }), { sum: 8, count: 2 });
});
