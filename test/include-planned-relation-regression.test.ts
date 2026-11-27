import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';
import { captureLazyLoadWarnings } from '../src/testing/index.js';

class PlannedMaker extends Model<{ id: number }> {}
class PlannedToy extends Model<{ id: number; makerId: number }> {}
class PlannedKid extends Model<{ id: number; parentId: number; toyId: number }> {}
class PlannedParent extends Model<{ id: number }> {}
defineModel('planned_include_maker').id('id').attach(PlannedMaker);
defineModel('planned_include_toy').id('id')
	.ref('maker', () => PlannedMaker, { localKey: 'makerId', foreignKey: 'id' }).attach(PlannedToy);
defineModel('planned_include_kid').id('id')
	.ref('toy', () => PlannedToy, { localKey: 'toyId', foreignKey: 'id' }).attach(PlannedKid);
defineModel('planned_include_parent').id('id')
	.hasMany('kids', () => PlannedKid, { localKey: 'id', foreignKey: 'parentId' }).attach(PlannedParent);

test('nested instance includes keep nested relations planned after related models are saved', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Maker = PlannedMaker.use(context), Toy = PlannedToy.use(context);
	const Kid = PlannedKid.use(context), Parent = PlannedParent.use(context);
	await Parent.create({ id: 1 });
	for (let id = 1; id <= 2; id++) {
		await Maker.create({ id });
		await Toy.create({ id, makerId: id });
		await Kid.create({ id, parentId: 1, toyId: id });
	}
	const parent = (await Parent.find(1).load())!;
	await parent.include('kids.toy.maker');
	const [kid] = await parent.ref('kids') as PlannedKid[];
	const toy = await kid.ref('toy') as PlannedToy;

	// A save resets the relation cache; the include() plan must survive it, as it
	// does for the model include() was called on.
	kid.data.toyId = 2;
	await kid.save();
	toy.data.makerId = 2;
	await toy.save();
	const { warnings, result } = await captureLazyLoadWarnings(async () => [
		await kid.ref('toy') as PlannedToy,
		await toy.ref('maker') as PlannedMaker
	]);
	assert.deepEqual(result.map(item => item.data.id), [2, 2]);
	assert.deepEqual(warnings, []);
});
