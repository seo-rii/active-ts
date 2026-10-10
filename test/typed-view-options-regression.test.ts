import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTypedView, ActiveTsConfigurationError } from '../src/index.js';

const execute = promisify(execFile);
const valid = () => ({ name: 'summary', resolve: () => ({ id: 1 }), parse: (value: unknown) => value });

test('typed view callbacks work in a fresh native ESM process with untouched intrinsics', async () => {
	const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { Model, defineModel, defineTypedView, createActiveTs, MemoryStoreAdapter } from './build/src/index.js';
class Account extends Model {}
const summary = defineTypedView()({ name: 'summary', resolve: ({ data }) => data,
 parse: value => { if (typeof value?.id !== 'number') throw new Error('id'); return { id: value.id }; } });
defineModel({ name: 'isolated_typed_account' }).id('id').validate(value => value).view(summary).attach(Account);
const Bound = Account.use(createActiveTs({ stores: { default: new MemoryStoreAdapter() } }));
const row = await Bound.create({ id: 1, secret: 'private' });
assert.deepEqual(await row.view(summary), { id: 1 });
assert.deepEqual(await row.view('summary'), { id: 1 });
console.log('ISOLATED_TYPED_VIEW_PASS');
`], { cwd: process.cwd() });
	assert.match(stdout, /ISOLATED_TYPED_VIEW_PASS/);
});

test('configuration getters are rejected without executing them', () => {
	let calls = 0;
	for (const key of ['name', 'resolve', 'parse']) {
		const options = valid();
		Object.defineProperty(options, key, { enumerable: true, get() { calls++; throw new Error('must not run'); } });
		assert.throws(() => defineTypedView()(options), ActiveTsConfigurationError);
	}
	assert.equal(calls, 0);
});

test('unknown, hidden and symbol configuration properties fail closed', () => {
	assert.throws(() => defineTypedView()({ ...valid(), extra: true } as any), ActiveTsConfigurationError);
	assert.throws(() => defineTypedView()({ ...valid(), [Symbol('hidden')]: true } as any), ActiveTsConfigurationError);
	const hidden = valid();
	Object.defineProperty(hidden, 'parse', { value: hidden.parse, enumerable: false });
	assert.throws(() => defineTypedView()(hidden), ActiveTsConfigurationError);
});

test('inherited fields do not satisfy required configuration, null-prototype records do', () => {
	assert.throws(() => defineTypedView()(Object.create(valid())), ActiveTsConfigurationError);
	const options = Object.assign(Object.create(null), valid());
	assert.equal(defineTypedView()(options).name, 'summary');
});
