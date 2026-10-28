import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/** Compile a package from source without retaining files from removed sources. */
export async function preparePackage(root = packageRoot) {
	await rm(path.join(root, 'build'), { recursive: true, force: true });
	await new Promise((resolve, reject) => {
		const compiler = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
			cwd: root,
			stdio: 'inherit'
		});
		compiler.once('error', reject);
		compiler.once('exit', (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`Package compilation failed (${signal ?? code}).`));
		});
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await preparePackage();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
