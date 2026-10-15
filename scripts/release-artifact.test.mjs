import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { artifactDigest, verifyReleaseArtifact } from './release-artifact.mjs';

async function fixture(run) {
	const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-release-manifest-'));
	await mkdir(path.join(directory, 'package'));
	await writeFile(path.join(directory, 'package/package.json'), JSON.stringify({ name: 'active-ts', version: '0.1.0' }));
	await promisify(execFile)('tar', ['-czf', path.join(directory, 'active-ts-0.1.0.tgz'), '-C', directory, 'package']);
	const bytes = await readFile(path.join(directory, 'active-ts-0.1.0.tgz'));
	const manifest = {
		format: 'active-ts/release-artifact', version: 1,
		package: { name: 'active-ts', version: '0.1.0' },
		source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false },
		artifact: { filename: 'active-ts-0.1.0.tgz', ...artifactDigest(bytes) }
	};
	const save = () => writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest));
	try {
		await writeFile(path.join(directory, manifest.artifact.filename), bytes);
		await save();
		await run({ directory, manifest, save });
	} finally { await rm(directory, { recursive: true, force: true }); }
}

test('release artifacts preserve exact bytes, source revision and package identity', () => fixture(async ({ directory, manifest }) => {
	const result = await verifyReleaseArtifact(directory, { expectedCommit: manifest.source.commit, requireClean: true });
	assert.deepEqual(result.manifest, manifest);
	assert.equal(result.tarball, path.join(directory, manifest.artifact.filename));
}));

test('artifact byte changes fail verification even at the same version', () => fixture(async ({ directory, manifest }) => {
	await writeFile(path.join(directory, manifest.artifact.filename), 'deterministic tarball fixturE');
	await assert.rejects(verifyReleaseArtifact(directory), /does not match/);
}));

test('a manifest from another source revision cannot be promoted', () => fixture(async ({ directory }) => {
	await assert.rejects(verifyReleaseArtifact(directory, { expectedCommit: 'c'.repeat(40) }), /source commit/);
}));

test('clean release verification rejects dirty builds', () => fixture(async ({ directory, manifest, save }) => {
	manifest.source.dirty = true;
	await save();
	await assert.rejects(verifyReleaseArtifact(directory, { requireClean: true }), /must be clean/);
}));

test('manifest filenames cannot escape the artifact directory', () => fixture(async ({ directory, manifest, save }) => {
	manifest.artifact.filename = '../escape.tgz';
	await save();
	await assert.rejects(verifyReleaseArtifact(directory), /filename/);
}));

test('unknown manifest versions fail closed', () => fixture(async ({ directory, manifest, save }) => {
	manifest.version = 2;
	await save();
	await assert.rejects(verifyReleaseArtifact(directory), /format/);
}));

test('manifest package identity must match the actual tarball', () => fixture(async ({ directory, manifest, save }) => {
	manifest.package.version = '9.9.9';
	await save();
	await assert.rejects(verifyReleaseArtifact(directory), /package identity/);
}));


test('packing cannot label lifecycle-mutated source as a clean commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-mutating-prepack-'));
  const exec = promisify(execFile);
  try {
    await mkdir(path.join(directory, 'scripts'));
    await writeFile(path.join(directory, 'scripts/release-artifact.mjs'), await readFile(new URL('./release-artifact.mjs', import.meta.url)));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name: 'active-ts-artifact-fixture', version: '0.0.0', type: 'module',
      scripts: { prepack: 'node change.mjs' }, files: ['tracked.txt']
    }));
    await writeFile(path.join(directory, 'tracked.txt'), 'original');
    await writeFile(path.join(directory, 'change.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('tracked.txt', 'changed');");
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['add', '.'], { cwd: directory });
    await exec('git', ['-c', 'user.name=Artifact Fixture', '-c', 'user.email=artifact@example.invalid', 'commit', '-qm', 'fixture'], { cwd: directory });
    await assert.rejects(exec(process.execPath, ['scripts/release-artifact.mjs', 'create', path.join(directory, '..', path.basename(directory) + '-output'), '--require-clean'], { cwd: directory }), error => /Source files changed during packing/.test(error.stderr));
  } finally {
    await rm(path.join(directory, '..', path.basename(directory) + '-output'), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
