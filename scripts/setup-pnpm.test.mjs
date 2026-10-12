import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateBootstrap, validateMetadata, validateAudit, setupPnpm } from './setup-pnpm.mjs';
const manifest = JSON.parse(readFileSync(new URL('../tools/ci-pnpm/package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../tools/ci-pnpm/package-lock.json', import.meta.url), 'utf8'));
const project = { packageManager: `pnpm@${manifest.dependencies.pnpm}` };
const pin = validateBootstrap(project, manifest, lock);
const clean = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
const metadata = () => ({ version: pin.version, 'dist.integrity': pin.integrity });
const clone = value => structuredClone(value);

test('reviewed project, single-package lock and exact pnpm pin agree', () => {
  assert.equal(pin.version, '11.28.2');
  assert.match(pin.integrity, /^sha512-/);
});
test('a version range, mismatch or competing project selector is rejected before installation', () => {
  for (const manager of ['pnpm@11.13.0', 'pnpm@^11.28.2', undefined]) assert.throws(() => validateBootstrap({ packageManager: manager }, manifest, lock));
  assert.throws(() => validateBootstrap({ ...project, devEngines: { packageManager: { name: 'pnpm', version: '11.13.0' } } }, manifest, lock));
  assert.throws(() => validateBootstrap(project, { ...manifest, dependencies: { pnpm: '^11.28.2' } }, lock));
});
test('unreviewed tarball location, missing integrity, extra packages or lifecycle scripts fail closed', () => {
  for (const edit of [l => { l.packages['node_modules/pnpm'].resolved = 'https://untrusted.invalid/pnpm.tgz'; },
    l => { delete l.packages['node_modules/pnpm'].integrity; },
    l => { l.packages['node_modules/pnpm'].hasInstallScript = true; },
    l => { l.packages['node_modules/extra'] = { version: '1.0.0' }; }]) {
    const changed = clone(lock); edit(changed); assert.throws(() => validateBootstrap(project, manifest, changed));
  }
  assert.throws(() => validateBootstrap(project, { ...manifest, scripts: { postinstall: 'exit 0' } }, lock));
});
test('deprecated metadata, wrong version and registry integrity drift are rejected', () => {
  const value = { version: pin.version, dist: { integrity: pin.integrity } };
  validateMetadata(value, pin);
  for (const bad of [{ ...value, deprecated: 'broken' }, { ...value, version: '11.13.0' }, { ...value, dist: {} }]) assert.throws(() => validateMetadata(bad, pin));
});
test('audit requires completed zero-finding output rather than only a zero exit status', () => {
  validateAudit(clean(), 0);
  for (const value of [{}, { ...clean(), error: { code: 'EAI_AGAIN' } }, { ...clean(), vulnerabilities: { pnpm: {} } }, { ...clean(), auditReportVersion: 1 }]) assert.throws(() => validateAudit(value, 0));
  for (const status of [1, 2, null]) assert.throws(() => validateAudit(clean(), status));
});
test('every severity and contradictory or malformed totals are checked', () => {
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    const report = clean(); report.metadata.vulnerabilities[severity] = 1; report.metadata.vulnerabilities.total = 1;
    assert.throws(() => validateAudit(report, 1));
  }
  for (const value of [-1, undefined, '0', NaN]) { const report = clean(); report.metadata.vulnerabilities.total = value; assert.throws(() => validateAudit(report, 0)); }
});

function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'active-ts-pnpm-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools/ci-pnpm');
  mkdirSync(path.join(tools, 'node_modules/pnpm/bin'), { recursive: true });
  mkdirSync(path.join(tools, 'node_modules/.bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(project));
  writeFileSync(path.join(tools, 'package.json'), JSON.stringify(manifest));
  writeFileSync(path.join(tools, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(path.join(tools, 'node_modules/pnpm/package.json'), JSON.stringify({ version: pin.version }));
  writeFileSync(path.join(tools, 'node_modules/pnpm/bin/pnpm.mjs'), '// Synthetic fixture: never executed.');
  symlinkSync('../pnpm/bin/pnpm.mjs', path.join(tools, 'node_modules/.bin/pnpm'));
  const githubPath = path.join(root, 'github-path'); writeFileSync(githubPath, '');
  const calls = [];
  const run = (command, args, cwd) => {
    const step = command === 'npm' ? args[0] : 'execute'; calls.push(step);
    if (overrides[step]) return overrides[step]({ command, args, cwd, tools });
    if (step === 'view') return { status: 0, stdout: JSON.stringify(metadata()) };
    if (step === 'ci') { assert.ok(args.includes('--ignore-scripts')); return { status: 0, stdout: '' }; }
    if (step === 'audit') return { status: 0, stdout: JSON.stringify(clean()) };
    assert.equal(cwd, root); assert.deepEqual(args, [path.join(tools, 'node_modules/pnpm/bin/pnpm.mjs'), '--version']);
    return { status: 0, stdout: pin.version + '\n' };
  };
  return { root, tools, calls, githubPath, execute: () => setupPnpm({ root, env: { RUNNER_TEMP: root, GITHUB_PATH: githubPath }, run }) };
}
test('install and audit precede CLI execution; PATH is exported only for the verified command', t => {
  const f = fixture(t); const result = f.execute();
  assert.deepEqual(f.calls, ['view', 'ci', 'audit', 'execute']);
  assert.equal(readFileSync(f.githubPath, 'utf8'), result.bin + '\n');
  assert.deepEqual(JSON.parse(readFileSync(result.evidence, 'utf8')), clean());
});
test('registry failures and deprecation prevent installation, execution and PATH changes', t => {
  for (const data of [{ status: 1, stdout: '' }, { status: 0, stdout: JSON.stringify({ ...metadata(), deprecated: 'broken' }) }]) {
    const f = fixture(t, { view: () => data }); assert.throws(f.execute);
    assert.deepEqual(f.calls, ['view']); assert.equal(readFileSync(f.githubPath, 'utf8'), '');
  }
});
test('bootstrap findings retain evidence but never execute pnpm or export PATH', t => {
  const report = clean(); report.metadata.vulnerabilities.high = report.metadata.vulnerabilities.total = 1;
  const f = fixture(t, { audit: () => ({ status: 1, stdout: JSON.stringify(report) }) }); assert.throws(f.execute);
  assert.deepEqual(f.calls, ['view', 'ci', 'audit']); assert.equal(readFileSync(f.githubPath, 'utf8'), '');
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, 'active-ts-pnpm-audit.json'), 'utf8')), report);
});
test('installation failure and lockfile mutation stop before CLI execution', t => {
  for (const operation of [() => ({ status: 1, stdout: '' }), ({ tools }) => {
    writeFileSync(path.join(tools, 'package-lock.json'), '{}'); return { status: 0, stdout: '' };
  }]) {
    const f = fixture(t, { ci: operation }); assert.throws(f.execute); assert.deepEqual(f.calls, ['view', 'ci']);
    assert.equal(readFileSync(f.githubPath, 'utf8'), '');
  }
});
test('actual project CLI version must match rather than silently selecting the former pin', t => {
  const f = fixture(t, { execute: () => ({ status: 0, stdout: '11.13.0\n' }) }); assert.throws(f.execute);
  assert.equal(readFileSync(f.githubPath, 'utf8'), '');
});
test('malformed audit responses and network failures do not become clean installations', t => {
  for (const result of [{ status: 0, stdout: '{}' }, { status: 1, stdout: 'not json' }, { status: 2, stdout: JSON.stringify(clean()) }]) {
    const f = fixture(t, { audit: () => result }); assert.throws(f.execute);
    assert.ok(!f.calls.includes('execute')); assert.equal(readFileSync(f.githubPath, 'utf8'), '');
  }
});


test('all repository workflows install Node before the audited bootstrap and never invoke the old action', () => {
  for (const file of ['ci.yml', 'integration.yml', 'release.yml']) {
    const workflow = readFileSync(new URL('../.github/workflows/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(workflow, /pnpm\/action-setup@/);
    const setup = workflow.indexOf('node scripts/setup-pnpm.mjs');
    assert.ok(setup > workflow.indexOf('actions/setup-node@'));
    assert.ok(setup < workflow.indexOf('pnpm install --frozen-lockfile'));
    assert.match(workflow, /node --test scripts\/setup-pnpm\.test\.mjs/);
  }
});
