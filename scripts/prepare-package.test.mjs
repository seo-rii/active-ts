import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { preparePackage } from './prepare-package.mjs';

test('package preparation removes outputs for deleted source files before packing', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'active-ts-clean-package-'));
	try {
		await mkdir(path.join(directory, 'src'));
		await writeFile(path.join(directory, 'package.json'), JSON.stringify({
			name: 'active-ts-clean-package-fixture', version: '0.0.0', type: 'module', files: ['build/src']
		}));
		await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({
			compilerOptions: {
				target: 'ES2023', module: 'NodeNext', rootDir: '.', outDir: 'build',
				declaration: true, sourceMap: true, declarationMap: true, types: []
			},
			include: ['src/**/*.ts']
		}));
		await writeFile(path.join(directory, 'src/removed.ts'), 'export const removed = true;\n');
		await preparePackage(directory);
		await access(path.join(directory, 'build/src/removed.js'));
		await rm(path.join(directory, 'src/removed.ts'));
		await writeFile(path.join(directory, 'src/current.ts'), 'export const current = true;\n');
		await preparePackage(directory);
		for (const suffix of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
			await assert.rejects(access(path.join(directory, 'build/src/removed.' + suffix)), { code: 'ENOENT' });
		}
		assert.match(await readFile(path.join(directory, 'build/src/current.js'), 'utf8'), /current/);
		const artifacts = path.join(directory, 'artifacts');
		await mkdir(artifacts);
		const { stdout } = await promisify(execFile)('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', artifacts], {
			cwd: directory,
			env: { ...process.env, npm_config_cache: path.join(directory, 'npm-cache') }
		});
		const [{ filename }] = JSON.parse(stdout);
		const { stdout: members } = await promisify(execFile)('tar', ['-tf', path.join(artifacts, filename)]);
		assert.match(members, /package\/build\/src\/current\.js/);
		assert.doesNotMatch(members, /removed\./);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
