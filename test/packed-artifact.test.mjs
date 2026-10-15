import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { forbiddenFixtureLiterals } from '../build/test/secret-scan-rules.js';
import { verifyPackedArtifact } from './pack-smoke.mjs';

const exec = promisify(execFile);
const packageJsonUrl = new URL('../package.json', import.meta.url);

async function withPackedFixture(run, mutate = () => {}) {
	const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-packed-artifact-'));
	try {
		const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));
		const members = new Map([
			['README.md', '# Packed artifact fixture\n\n[Quickstart](docs/quickstart.md)\n'],
			['docs/quickstart.md', '# Quickstart\n\n[README](../README.md)\n'],
			['src/index.ts', 'export {};\n'],
			['build/src/index.js.map', JSON.stringify({
				version: 3, file: 'index.js', sources: ['../../src/index.ts'], names: [], mappings: ''
			})]
		]);
		function addTargets(value) {
			if (typeof value === 'string') {
				members.set(value.replace(/^\.\//, ''), 'export {};\n');
			} else if (value && typeof value === 'object') {
				for (const target of Object.values(value)) addTargets(target);
			}
		}
		addTargets(packageJson.main);
		addTargets(packageJson.types);
		addTargets(packageJson.bin);
		addTargets(packageJson.exports);
		mutate({ members, packageJson });
		members.set('package.json', JSON.stringify(packageJson));
		for (const [file, content] of members) {
			const filename = path.join(directory, 'package', file);
			await mkdir(path.dirname(filename), { recursive: true });
			await writeFile(filename, content);
		}
		const tarball = path.join(directory, 'active-ts-fixture.tgz');
		await exec('tar', ['-czf', tarball, '-C', directory, 'package']);
		const files = [...members.keys()].map((file) => ({ path: file }));
		await run({
			tarball,
			files,
			extractionDirectory: path.join(directory, 'extracted'),
			packageJson,
			members
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test('packed artifact static checks accept an archive independently of the checkout', () => withPackedFixture(async ({ tarball, files, extractionDirectory, packageJson, members }) => {
	const verified = await verifyPackedArtifact(tarball, files, extractionDirectory);
	assert.deepEqual(verified.packageJson, packageJson);
	assert.deepEqual(verified.packedPaths, new Set(members.keys()));
	assert.equal(await readFile(path.join(verified.root, 'README.md'), 'utf8'), members.get('README.md'));
	assert.notEqual(await readFile(new URL('../README.md', import.meta.url), 'utf8'), members.get('README.md'));
}));

test('a secret present only in the packed README fails static checks', () => withPackedFixture(async ({ tarball, files, extractionDirectory }) => {
	await assert.rejects(
		verifyPackedArtifact(tarball, files, extractionDirectory),
		/README\.md: forbidden fixture literal/
	);
}, ({ members }) => {
	members.set('README.md', `# Artifact-only fixture\n${forbiddenFixtureLiterals[0]}\n`);
}));

test('a private export present only in packed package metadata fails static checks', () => withPackedFixture(async ({ tarball, files, extractionDirectory }) => {
	await assert.rejects(verifyPackedArtifact(tarball, files, extractionDirectory), /\.\/private/);
}, ({ packageJson }) => {
	packageJson.exports['./private'] = { ...packageJson.exports['.'] };
}));

test('sourcesContent present only in a packed source map fails static checks', () => withPackedFixture(async ({ tarball, files, extractionDirectory }) => {
	await assert.rejects(verifyPackedArtifact(tarball, files, extractionDirectory), /must not embed sourcesContent/);
}, ({ members }) => {
	const sourceMap = JSON.parse(members.get('build/src/index.js.map'));
	sourceMap.sourcesContent = ['export {};'];
	members.set('build/src/index.js.map', JSON.stringify(sourceMap));
}));

test('an absolute source path present only in a packed source map fails static checks', () => withPackedFixture(async ({ tarball, files, extractionDirectory }) => {
	await assert.rejects(verifyPackedArtifact(tarball, files, extractionDirectory), /must be relative/);
}, ({ members }) => {
	const sourceMap = JSON.parse(members.get('build/src/index.js.map'));
	sourceMap.sources = ['/private/build/src/index.ts'];
	members.set('build/src/index.js.map', JSON.stringify(sourceMap));
}));

test('a broken Markdown link present only in the packed README fails static checks', () => withPackedFixture(async ({ tarball, files, extractionDirectory }) => {
	await assert.rejects(verifyPackedArtifact(tarball, files, extractionDirectory), /README\.md -> docs\/missing-fixture\.md/);
}, ({ members }) => {
	members.set('README.md', '# Artifact-only fixture\n\n[Missing guide](docs/missing-fixture.md)\n');
}));

test('a broken Markdown link present only in a packed guide fails static checks', () => withPackedFixture(async ({ tarball, files, extractionDirectory }) => {
	await assert.rejects(verifyPackedArtifact(tarball, files, extractionDirectory), /docs\/quickstart\.md -> missing-fixture\.md/);
}, ({ members }) => {
	members.set('docs/quickstart.md', '# Artifact-only guide\n\n[Missing guide](missing-fixture.md)\n');
}));
