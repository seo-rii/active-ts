import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestName = 'release-manifest.json';
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function artifactDigest(bytes) {
	return {
		bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
	};
}

export async function verifyReleaseArtifact(directory, { expectedCommit, requireClean = false } = {}) {
	const manifest = JSON.parse(await readFile(path.join(directory, manifestName), 'utf8'));
	if (manifest.format !== 'active-ts/release-artifact' || manifest.version !== 1) throw new Error('Unsupported release manifest format.');
	if (!sha(manifest.source?.commit) || !sha(manifest.source?.tree) || typeof manifest.source?.dirty !== 'boolean') throw new Error('Invalid release source identity.');
	if (expectedCommit !== undefined && (!sha(expectedCommit) || manifest.source.commit !== expectedCommit)) throw new Error('Release source commit does not match the expected commit.');
	if (requireClean && manifest.source.dirty) throw new Error('Release source must be clean.');
	if (typeof manifest.package?.name !== 'string' || !manifest.package.name || typeof manifest.package?.version !== 'string' || !manifest.package.version) throw new Error('Invalid release package identity.');
	const filename = manifest.artifact?.filename;
	if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(filename)) throw new Error('Invalid release artifact filename.');
	const tarball = path.join(directory, filename);
	if (!(await stat(tarball)).isFile()) throw new Error('Release artifact must be a file.');
	const actual = artifactDigest(await readFile(tarball));
	for (const field of ['bytes', 'sha256', 'integrity']) {
		if (manifest.artifact[field] !== actual[field]) throw new Error(`Release artifact ${field} does not match the manifest.`);
	}
	const { stdout } = await exec('tar', ['-xOf', tarball, 'package/package.json'], { maxBuffer: 1024 * 1024 });
	const packedPackage = JSON.parse(stdout);
	if (packedPackage.name !== manifest.package.name || packedPackage.version !== manifest.package.version) throw new Error('Packed package identity does not match the release manifest.');
	return { manifest, tarball };
}

export async function createReleaseArtifact(directory, { requireClean = false, expectedCommit } = {}) {
	const git = async args => (await exec('git', args, { cwd: root })).stdout.trim();
	const commit = await git(['rev-parse', 'HEAD']);
	const tree = await git(['rev-parse', 'HEAD^{tree}']);
	// Local risk/bookkeeping files do not enter the published package.
	const dirty = Boolean(await git(['status', '--porcelain', '--untracked-files=normal', '--', '.', ':!RISK_REGISTER.md', ':!STAGING.md', ':!DONE.md', ':!MISTAKES.md']));
	if (requireClean && dirty) throw new Error('Release source must be clean before packing.');
	await mkdir(directory, { recursive: true });
	const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
	const start = stdout.lastIndexOf('\n[');
	const [packed] = JSON.parse(start >= 0 ? stdout.slice(start + 1) : stdout.trim());
	if (await git(['rev-parse', 'HEAD']) !== commit || await git(['rev-parse', 'HEAD^{tree}']) !== tree) throw new Error('Source commit changed during packing.');
	const dirtyAfter = Boolean(await git(['status', '--porcelain', '--untracked-files=normal', '--', '.', ':!RISK_REGISTER.md', ':!STAGING.md', ':!DONE.md', ':!MISTAKES.md']));
	if (!dirty && dirtyAfter) throw new Error('Source files changed during packing.');
	const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
	const filename = packed.filename;
	if (path.basename(filename) !== filename) throw new Error('npm returned an invalid artifact filename.');
	const compiler = JSON.parse(await readFile(require.resolve('typescript/package.json'), 'utf8'));
	const manifest = {
		format: 'active-ts/release-artifact', version: 1,
		package: { name: packageJson.name, version: packageJson.version },
		source: { commit, tree, dirty },
		artifact: { filename, ...artifactDigest(await readFile(path.join(directory, filename))) },
		toolchain: { node: process.version, packageManager: packageJson.packageManager, typescript: compiler.version, module: packageJson.type },
		peers: packageJson.peerDependencies
	};
	await writeFile(path.join(directory, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
	return verifyReleaseArtifact(directory, { expectedCommit: expectedCommit ?? commit, requireClean });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [command, directory, ...flags] = process.argv.slice(2);
		if (!['create', 'verify'].includes(command) || !directory || flags.some(flag => flag !== '--require-clean')) throw new Error('Usage: node scripts/release-artifact.mjs create|verify DIRECTORY [--require-clean]');
		const options = { requireClean: flags.includes('--require-clean'), expectedCommit: process.env.GITHUB_SHA };
		const result = command === 'create'
			? await createReleaseArtifact(path.resolve(directory), options)
			: await verifyReleaseArtifact(path.resolve(directory), options);
		console.log(JSON.stringify({ tarball: result.tarball, ...result.manifest }, null, 2));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
