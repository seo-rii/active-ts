import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

async function edit(file, edits, expectedBlob) {
  let text = await readFile(file, 'utf8');
  if (expectedBlob) {
    const bytes = Buffer.from(text);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(sha, expectedBlob, `Refusing changed source: ${file}`);
  }
  for (const [before, after] of edits) {
    assert.equal(text.split(before).length - 1, 1, `Patch must match once: ${file}: ${before}`);
    text = text.replace(before, after);
  }
  await writeFile(file, text);
}

await edit('src/core/model.ts', [
  ["import { isPartialModel } from './partial-model.js';", "import { isPartialModel } from './partial-model.js';\nimport { typedViewDetails, type TypedView } from './typed-view.js';"],
  ['\tstatic use(context: ActiveContext): typeof this {', '\tstatic use<TConstructor extends abstract new (...args: any[]) => Model>(\n\t\tthis: TConstructor, context: ActiveContext\n\t): TConstructor {'],
  ['return BoundModel as unknown as typeof this;', 'return BoundModel as unknown as TConstructor;'],
  ["\tview<TView = unknown>(name = 'default', viewer?: unknown) {", "\tview<Output>(view: TypedView<TData, Output>, viewer?: unknown): Promise<Output>;\n\tview<TView = unknown>(name?: string, viewer?: unknown): Promise<TView>;\n\tview(name: string | TypedView<TData, unknown> = 'default', viewer?: unknown): Promise<unknown> {"],
  ["\t\t\t\tconst safeName = assertSafeFieldPath(name, 'view name');", "\t\t\t\tconst contract = typeof name === 'string' ? undefined : typedViewDetails(name);\n\t\t\t\tconst safeName = assertSafeFieldPath(contract?.name ?? name, 'view name');"],
  ["\t\t\t\treturn (await resolver({", "\t\t\t\tif (contract && resolver !== contract.resolver) {\n\t\t\t\t\tthrow new ActiveTsConfigurationError(`Typed view \"${safeName}\" is not the registered contract on ${meta.name}.`);\n\t\t\t\t}\n\t\t\t\treturn await resolver({"],
  ['\t\t\t\t})) as TView;', '\t\t\t\t});']
], 'dd5f55bde5507d268f7c7ef9ffad555bb61cdf06');

await edit('src/core/define-model.ts', [
  ["import { ActiveTsConfigurationError } from './errors.js';", "import { ActiveTsConfigurationError } from './errors.js';\nimport { typedViewDetails, type TypedView } from './typed-view.js';"],
  ["\tview(name: string, resolver: ViewResolver<TData>) {\n\t\tmapSet(this.meta.views!, assertSafeFieldPath(name, 'view name'), resolver);\n\t\treturn this;\n\t}", "\tview<Output>(view: TypedView<TData, Output>): this;\n\tview(name: string, resolver: ViewResolver<TData>): this;\n\tview(name: string | TypedView<TData, unknown>, resolver?: ViewResolver<TData>): this {\n\t\tconst contract = typeof name === 'string' ? undefined : typedViewDetails(name);\n\t\tconst selected = contract?.resolver ?? resolver;\n\t\tif (typeof selected !== 'function') throw new ActiveTsConfigurationError('View resolver must be a function.');\n\t\tmapSet(this.meta.views!, assertSafeFieldPath(contract?.name ?? name, 'view name'), selected);\n\t\treturn this;\n\t}"]
], '337a286652ba1635336905192cbb897bd7c19f8a');

await edit('src/index.ts', [["export * from './core/define-model.js';", "export * from './core/define-model.js';\nexport { defineTypedView, type TypedView } from './core/typed-view.js';"]]);
for (const file of ['test/package-ci-regression.test.ts', 'test/pack-smoke.mjs']) {
  await edit(file, [["'defineModel',", "'defineModel',\n" + (file.endsWith('.ts') ? '\t\t' : '\t') + "'defineTypedView',"]]);
}
console.log('Applied only the reviewed type/view and public-export snapshot changes.');
