import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const file = 'test/pack-smoke.mjs';
let source = await readFile(file, 'utf8');
console.log('HEAD', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
console.log('pack blob', execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim());
const lines = source.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (/checkPackConfiguration|1\.14\.[45]|2\.1\.[47]|7\.29\.[01]/.test(lines[i])) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}
const workspace = await readFile('pnpm-workspace.yaml', 'utf8');
const changes = [['1.14.4', '1.14.5'], ['2.1.4', '2.1.7'], ['7.29.0', '7.29.1']];
let count = 0;
for (const [oldVersion, newVersion] of changes) {
  assert.ok(workspace.includes(newVersion), `Workspace must already contain reviewed patch ${newVersion}`);
  // Only update exact quoted version literals in the packaging test. Never remove
  // assertions, skip the smoke test, or make an expected value self-referential.
  const needle = `'${oldVersion}'`;
  const matches = source.split(needle).length - 1;
  assert.ok(matches <= 1, `Ambiguous packaging expectation for ${oldVersion}`);
  if (matches === 1) {
    source = source.replace(needle, `'${newVersion}'`);
    count++;
  }
}
if (count > 0) await writeFile(file, source);
console.log(`Updated ${count} existing exact packaging version expectations.`);
