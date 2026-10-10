import { Model, defineModel, defineTypedView, type ActiveContext } from '../src/index.js';
type Row = { id: number; name: string; secret: string };
class Account extends Model<Row> { static category = 'account' as const; label() { return this.data.name; } }
const summary = defineTypedView<Row>()({
	name: 'summary', resolve: ({ data, model }) => ({ id: data.id, name: model.data.name }),
	parse: (value: unknown) => {
		if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'number') throw new TypeError();
		return { id: value.id };
	}
});
const other = defineTypedView<{ unrelated: boolean }>()({ name: 'other', resolve: () => null, parse: () => true });
defineModel<Row>({ name: 'account' }).id('id').view(summary).attach(Account);
function constructorChecks(context: ActiveContext) {
	const Bound = Account.use(context);
	const Same: typeof Account = Bound;
	const Rebound: typeof Account = Bound.use(context);
	const category: 'account' = Rebound.category;
	const instance: Account = new Same({ id: 1, name: 'x', secret: 'y' });
	// @ts-expect-error preserve constructor data type
	new Bound({ id: 'wrong', name: 'x', secret: 'y' });
	return { instance, category };
}
async function viewChecks(context: ActiveContext) {
	const Bound = Account.use(context);
	const item = await Bound.find(1).load();
	if (!item) return;
	const label: string = item.label();
	const dto = await item.view(summary);
	const id: number = dto.id;
	// @ts-expect-error output is inferred from parser, not full model data
	dto.secret;
	// @ts-expect-error cannot substitute a made-up output shape for a typed descriptor
	await item.view<{ secret: string }>(summary);
	// @ts-expect-error wrong input model contract
	await item.view(other);
	// @ts-expect-error descriptor must be constructed by defineTypedView
	await item.view({ name: 'summary', parse: () => 1 });
	const unknownView: unknown = await item.view('legacy');
	const projected = await Bound.query().select('id').load();
	// @ts-expect-error partial models cannot run views
	await projected.list[0]!.view(summary);
	return { label, id, unknownView };
}
void constructorChecks;
void viewChecks;
