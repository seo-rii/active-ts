import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const file = 'pnpm-workspace.yaml';
let source = await readFile(file, 'utf8');
for (const [before, after] of [
  ["'@grpc/grpc-js': 1.14.4", "'@grpc/grpc-js': 1.14.5"],
  ['brace-expansion: 2.1.4', 'brace-expansion: 2.1.7'],
  ['undici: 7.29.0', 'undici: 7.29.1']
]) {
  assert.equal(source.split(before).length - 1, 1, `Expected exactly one reviewed override: ${before}`);
  source = source.replace(before, after);
}
await writeFile(file, source);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.ok(Array.isArray(pkg.files));
if (!pkg.files.includes('docs/typed-views.md')) pkg.files.push('docs/typed-views.md');
await writeFile('package.json', JSON.stringify(pkg, null, '\t') + '\n');
