/** Repository-owned, locked CI bootstrap. It never runs an older pnpm to install a newer one. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repository = fileURLToPath(new URL('../', import.meta.url));
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

export function validateBootstrap(project, manifest, lock) {
  const version = manifest?.dependencies?.pnpm;
  assert.match(version ?? '', /^11\.\d+\.\d+$/, 'Bootstrap must pin an exact stable pnpm 11 release');
  assert.equal(project.packageManager, `pnpm@${version}`, 'Project and bootstrap pins must match');
  assert.equal(project.devEngines?.packageManager, undefined, 'A second package-manager selector is not supported');
  assert.equal(manifest.private, true, 'Bootstrap must remain private');
  assert.deepEqual(Object.keys(manifest.dependencies), ['pnpm'], 'Bootstrap must contain only pnpm');
  assert.equal(manifest.scripts, undefined, 'Bootstrap must not define lifecycle scripts');
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/pnpm']);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  const entry = lock.packages['node_modules/pnpm'];
  assert.equal(entry.version, version);
  assert.equal(entry.resolved, `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`);
  assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/, 'A locked SHA-512 integrity is required');
  assert.equal(entry.hasInstallScript, undefined, 'No bootstrap install scripts are allowed');
  assert.equal(entry.bin?.pnpm, 'bin/pnpm.mjs');
  return { version, integrity: entry.integrity };
}

export function validateMetadata(metadata, pin) {
  assert.equal(metadata.version, pin.version, 'Registry did not return the exact pin');
  assert.ok(!metadata.deprecated, 'The pinned package manager is deprecated');
  assert.equal(metadata.dist?.integrity, pin.integrity, 'Registry and reviewed lock integrity differ');
}

export function validateAudit(report, status) {
  assert.ok(status === 0 || status === 1, 'Audit command did not complete');
  assert.equal(report.auditReportVersion, 2, 'Unknown audit schema');
  assert.equal(report.error, undefined, 'Registry/audit errors must not look like a clean report');
  const counts = report.metadata?.vulnerabilities;
  assert.ok(counts && typeof counts === 'object', 'Audit totals are required');
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  for (const severity of [...severities, 'total']) assert.ok(Number.isSafeInteger(counts[severity]) && counts[severity] >= 0);
  assert.equal(severities.reduce((sum, severity) => sum + counts[severity], 0), counts.total);
  assert.equal(counts.total, 0, 'Bootstrap dependency audit contains findings');
  assert.deepEqual(report.vulnerabilities, {}, 'Audit findings conflict with its total');
  assert.equal(status, 0, 'Audit process failed');
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 10_000_000 });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Bootstrap command terminated: ${result.signal}`);
  // Preserve installation warnings; no grep/filter that hides findings.
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

export function setupPnpm({ root = repository, env = process.env, run = runCommand } = {}) {
  const tools = path.join(root, 'tools/ci-pnpm');
  const manifestPath = path.join(tools, 'package.json'), lockPath = path.join(tools, 'package-lock.json');
  const manifestText = readFileSync(manifestPath, 'utf8'), lockText = readFileSync(lockPath, 'utf8');
  const pin = validateBootstrap(readJson(path.join(root, 'package.json')), JSON.parse(manifestText), JSON.parse(lockText));
  const metadata = run('npm', ['view', `pnpm@${pin.version}`, 'version', 'deprecated', 'dist.integrity', '--json'], tools);
  assert.equal(metadata.status, 0, 'Cannot verify pinned registry metadata');
  const data = JSON.parse(metadata.stdout);
  // npm view emits dotted selectors as dotted JSON keys.
  validateMetadata({ ...data, dist: data.dist ?? { integrity: data['dist.integrity'] } }, pin);
  const installed = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], tools);
  if (installed.stdout) process.stdout.write(installed.stdout);
  assert.equal(installed.status, 0, 'Locked bootstrap installation failed');
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestText, 'Bootstrap changed its manifest');
  assert.equal(readFileSync(lockPath, 'utf8'), lockText, 'Bootstrap changed its lockfile');
  const audit = run('npm', ['audit', '--json'], tools);
  const evidence = path.join(env.RUNNER_TEMP ?? tmpdir(), 'active-ts-pnpm-audit.json');
  writeFileSync(evidence, audit.stdout || '{}');
  console.log('PNPM_BOOTSTRAP_AUDIT', audit.stdout);
  validateAudit(JSON.parse(audit.stdout), audit.status); // No pnpm has executed before this point.
  assert.equal(readJson(path.join(tools, 'node_modules/pnpm/package.json')).version, pin.version);
  const executable = path.join(tools, 'node_modules/pnpm/bin/pnpm.mjs');
  const bin = path.join(tools, 'node_modules/.bin');
  assert.equal(realpathSync(path.join(bin, 'pnpm')), realpathSync(executable), 'Unexpected pnpm command target');
  const executed = run(process.execPath, [executable, '--version'], root);
  assert.equal(executed.status, 0, 'Pinned pnpm could not execute in the project');
  assert.equal(executed.stdout.trim(), pin.version, 'Project silently selected another package manager');
  if (env.GITHUB_PATH) appendFileSync(env.GITHUB_PATH, bin + '\n');
  console.log(JSON.stringify({ event: 'PINNED_PNPM_READY', version: pin.version, auditFindings: 0, bin, evidence }));
  return { version: pin.version, bin, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { setupPnpm(); } catch (error) { console.error(error); process.exitCode = 1; }
}
