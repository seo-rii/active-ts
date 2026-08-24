import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('Elasticsearch peer range and integration smoke client stay aligned', () => {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
		peerDependencies: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	const integrationWorkflow = readFileSync('.github/workflows/integration.yml', 'utf8');
	const adapterDocs = readFileSync('docs/adapters.md', 'utf8');
	const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');

	assert.equal(packageJson.peerDependencies['@elastic/elasticsearch'], '^8.0.0 || ^9.0.0');
	assert.equal(packageJson.devDependencies['@elastic/elasticsearch'], '^8.19.1');
	assert.match(integrationWorkflow, /image: docker\.elastic\.co\/elasticsearch\/elasticsearch:8\.15\.3/);
	assert.match(integrationWorkflow, /ACTIVE_TS_INTEGRATION_TARGETS: postgres,mongodb,redis,elasticsearch,datastore,firestore/);
	assert.match(adapterDocs, /@elastic\/elasticsearch`: `\^8\.0\.0 \|\| \^9\.0\.0`/);
	assert.match(lockfile, /devDependencies:\n\s+'@elastic\/elasticsearch':\n\s+specifier: \^8\.19\.1\n\s+version: 8\.19\.1/);
});

test('backend integration workflows use lockfile-installed optional peers', () => {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
		peerDependencies: Record<string, string>;
	};
	const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');
	const workflows = [
		readFileSync('.github/workflows/integration.yml', 'utf8'),
		readFileSync('.github/workflows/release.yml', 'utf8')
	];
	const optionalPeers = [
		['pg', packageJson.peerDependencies.pg],
		['mongodb', packageJson.peerDependencies.mongodb],
		['redis', packageJson.peerDependencies.redis],
		['@google-cloud/datastore', packageJson.peerDependencies['@google-cloud/datastore']],
		['@google-cloud/firestore', packageJson.peerDependencies['@google-cloud/firestore']]
	] as const;

	for (const workflow of workflows) {
		assert.match(workflow, /pnpm install --frozen-lockfile/);
		assert.doesNotMatch(workflow, /pnpm add -D/);
	}
	for (const [name, range] of optionalPeers) {
		assert.equal(packageJson.peerDependencies[name], range);
		assert.match(lockfile, new RegExp(`\\n\\s{6}'?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?:\\n\\s{8}specifier: ${range.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
	}
});

test('release workflow runs backend integration smoke before publish', () => {
	const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
	const publishIndex = releaseWorkflow.indexOf('npm publish --provenance --access public');
	const auditIndex = releaseWorkflow.indexOf('pnpm run audit');
	const integrationIndex = releaseWorkflow.indexOf('pnpm test:integration:backends');
	const packIndex = releaseWorkflow.indexOf('pnpm pack:smoke');

	assert.ok(auditIndex >= 0, 'release workflow must run dependency audit');
	assert.ok(integrationIndex >= 0, 'release workflow must run backend integration smoke');
	assert.ok(publishIndex >= 0, 'release workflow must publish through npm publish');
	assert.ok(packIndex >= 0, 'release workflow must run pack smoke');
	assert.ok(auditIndex < publishIndex, 'dependency audit must run before publish');
	assert.ok(integrationIndex < publishIndex, 'backend integration smoke must run before publish');
	assert.ok(integrationIndex < packIndex, 'backend integration smoke must run before pack smoke');
	assert.ok(packIndex < publishIndex, 'pack smoke must run before publish');
	assert.match(releaseWorkflow, /ACTIVE_TS_INTEGRATION_TARGETS: postgres,mongodb,redis,elasticsearch,datastore,firestore/);
	assert.doesNotMatch(releaseWorkflow, /git checkout -- package\.json pnpm-lock\.yaml/);
});

test('release publish is guarded to main and isolated from release checks', () => {
	const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
	const releaseJobStart = releaseWorkflow.indexOf('  release:');
	const publishJobStart = releaseWorkflow.indexOf('\n  publish:', releaseJobStart);

	assert.ok(releaseJobStart >= 0, 'release job must exist');
	assert.ok(publishJobStart > releaseJobStart, 'publish job must run after release checks job');

	const releaseJob = releaseWorkflow.slice(releaseJobStart, publishJobStart);
	const publishJob = releaseWorkflow.slice(publishJobStart);

	assert.ok(
		releaseWorkflow.includes("if: ${{ inputs.publish && github.ref != 'refs/heads/main' }}"),
		'manual publish from non-main refs must fail explicitly'
	);
	assert.ok(
		publishJob.includes("if: ${{ inputs.publish && github.ref == 'refs/heads/main' }}"),
		'publish job must run only for main ref dispatches'
	);
	assert.doesNotMatch(releaseJob, /id-token: write/);
	assert.doesNotMatch(releaseJob, /npm publish --provenance --access public/);
	assert.match(publishJob, /needs: release/);
	assert.match(publishJob, /id-token: write/);
	assert.match(publishJob, /npm publish --provenance --access public/);
});

test('read-only CI workflows declare least-privilege token permissions', () => {
	const workflows = [
		['ci', readFileSync('.github/workflows/ci.yml', 'utf8')],
		['integration', readFileSync('.github/workflows/integration.yml', 'utf8')]
	] as const;

	for (const [name, workflow] of workflows) {
		assert.match(
			workflow,
			/\npermissions:\n  contents: read\n\njobs:/,
			`${name} workflow must declare read-only GITHUB_TOKEN permissions`
		);
		assert.doesNotMatch(workflow, /id-token: write/, `${name} workflow must not request publish provenance permissions`);
	}
});

test('pack smoke compiles installed TypeScript declarations', () => {
	const smoke = readFileSync('test/pack-smoke.mjs', 'utf8');
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };

	assert.match(smoke, /smoke\.ts/);
	assert.match(smoke, /tsconfig\.json/);
	assert.match(smoke, /node_modules', '\.bin', 'tsc'/);
	assert.match(smoke, /skipLibCheck: false/);
	assert.match(smoke, /from 'active-ts\/testing'/);
	assert.match(smoke, /from 'active-ts\/adapters\/store\/postgresql'/);
	assert.match(smoke, /MongoStoreOptions/);
	assert.match(smoke, /RedisValkeyOptions/);
	assert.match(smoke, /ElasticsearchOptions/);
	assert.match(smoke, /schema', 'diff', '--config'/);
	assert.match(smoke, /packed_cli_record/);
	assert.match(smoke, /pack_smoke_cli/);
	assert.equal(packageJson.files.includes('docs'), false);
	assert.equal(packageJson.files.includes('docs/risk-register.md'), false);
	assert.equal(packageJson.files.includes('docs/risk-register-archive.md'), false);
	assert.ok(packageJson.files.includes('docs/quickstart.md'));
	assert.match(smoke, /docs\/risk-register\.md/);
	assert.match(smoke, /docs\/risk-register-archive\.md/);
	assert.match(smoke, /assertPackedPackageTargetsExist/);
	assert.match(smoke, /publicSubpaths/);
	assert.match(smoke, /active-ts\/adapters\/store\/datastore/);
	assert.match(smoke, /active-ts\/adapters\/search\/algolia/);
	assert.match(smoke, /requireAncestorTransactionQueries:\s*true/);
	assert.match(smoke, /assertPackedFilesAvoidSecrets/);
	assert.match(smoke, /assertPackageExportsAreStable/);
	assert.match(smoke, /assertPackedPathsStayInAllowedSurface/);
	assert.match(smoke, /assertPackedSourceMapsResolve/);
	assert.match(smoke, /peerDependenciesMeta/);
	assert.match(smoke, /must not be installed in the consumer package/);
	assert.doesNotMatch(smoke, /import\.meta\.resolve\(peer\)/);
	assert.match(smoke, /noPeerFactoryValidationCases/);
	assert.match(smoke, /noInternalStore/);
	assert.match(smoke, /noInternalCache/);
	assert.match(smoke, /noInternalSearch/);
});

test('npm package metadata and prepack publish guard are present', () => {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
		scripts: Record<string, string>;
		repository?: { type?: string; url?: string };
		bugs?: { url?: string };
		homepage?: string;
	};

	assert.equal(packageJson.scripts.prepack, 'pnpm build');
	assert.equal(packageJson.repository?.type, 'git');
	assert.equal(packageJson.repository?.url, 'git+https://github.com/seo-rii/active-ts.git');
	assert.equal(packageJson.bugs?.url, 'https://github.com/seo-rii/active-ts/issues');
	assert.equal(packageJson.homepage, 'https://github.com/seo-rii/active-ts#readme');
});

test('backend integration workflow runs for adapter pull requests and main pushes', () => {
	const integrationWorkflow = readFileSync('.github/workflows/integration.yml', 'utf8');

	assert.match(integrationWorkflow, /push:\s*\n\s+branches:\s*\[main\]/);
	assert.match(integrationWorkflow, /pull_request:/);
	assert.match(integrationWorkflow, /branches:\s*\[main\]/);
	assert.match(integrationWorkflow, /'src\/adapters\/\*\*'/);
	assert.match(integrationWorkflow, /'src\/core\/\*\*'/);
	assert.match(integrationWorkflow, /'src\/testing\/\*\*'/);
	assert.match(integrationWorkflow, /'pnpm-workspace\.yaml'/);
	assert.match(integrationWorkflow, /'\.github\/workflows\/release\.yml'/);
	assert.match(integrationWorkflow, /pnpm test:integration:backends/);
	assert.match(integrationWorkflow, /ACTIVE_TS_INTEGRATION_TARGETS: postgres,mongodb,redis,elasticsearch,datastore,firestore/);
	assert.match(integrationWorkflow, /DATASTORE_EMULATOR_HOST: 127\.0\.0\.1:8081/);
	assert.match(integrationWorkflow, /FIRESTORE_EMULATOR_HOST: 127\.0\.0\.1:8082/);
});

test('CI and package scripts keep dependency audit enabled', () => {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
		scripts: Record<string, string>;
		pnpm?: unknown;
	};
	const pnpmWorkspace = readFileSync('pnpm-workspace.yaml', 'utf8');
	const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
	const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
	const ciAuditIndex = ciWorkflow.indexOf('pnpm run audit');
	const ciTypecheckIndex = ciWorkflow.indexOf('pnpm typecheck');
	const releaseAuditIndex = releaseWorkflow.indexOf('pnpm run audit');
	const releaseTypecheckIndex = releaseWorkflow.indexOf('pnpm typecheck');

	assert.equal(packageJson.scripts.audit, 'pnpm audit --audit-level moderate');
	assert.equal(packageJson.pnpm, undefined);
	assert.match(pnpmWorkspace, /^allowBuilds:\n(?:  [^\n]+\n)*  protobufjs: true$/m);
	assert.match(pnpmWorkspace, /^overrides:\n(?:  [^\n]+\n)*  '@grpc\/grpc-js': 1\.14\.4$/m);
	assert.match(pnpmWorkspace, /^overrides:\n(?:  [^\n]+\n)*  '@opentelemetry\/core': 2\.8\.0$/m);
	assert.match(pnpmWorkspace, /^overrides:\n(?:  [^\n]+\n)*  brace-expansion: 2\.1\.4$/m);
	assert.match(pnpmWorkspace, /^overrides:\n(?:  [^\n]+\n)*  protobufjs: 7\.6\.5$/m);
	assert.match(pnpmWorkspace, /^overrides:\n(?:  [^\n]+\n)*  undici: 7\.29\.0$/m);
	assert.ok(ciAuditIndex >= 0, 'CI workflow must run dependency audit');
	assert.ok(ciAuditIndex < ciTypecheckIndex, 'CI dependency audit must run before typecheck');
	assert.ok(releaseAuditIndex >= 0, 'release workflow must run dependency audit');
	assert.ok(releaseAuditIndex < releaseTypecheckIndex, 'release dependency audit must run before typecheck');
	assert.doesNotMatch(ciWorkflow, /run: pnpm audit\b/);
	assert.doesNotMatch(releaseWorkflow, /run: pnpm audit\b/);
});

test('workflow actions and service images use immutable references', () => {
	for (const file of readdirSync('.github/workflows').filter((name) => name.endsWith('.yml'))) {
		const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');

		for (const match of workflow.matchAll(/uses:\s*([^\s]+@([^\s#]+))/g)) {
			assert.match(match[2], /^[0-9a-f]{40}$/i, `${file} uses mutable action reference ${match[1]}`);
		}

		for (const match of workflow.matchAll(/image:\s*([^\s]+)/g)) {
			assert.match(
				match[1],
				/@sha256:[0-9a-f]{64}$/i,
				`${file} uses mutable service image reference ${match[1]}`
			);
		}
	}
});

test('workflow actions use approved Node 24-compatible releases', () => {
	const approvedActions = new Map<string, readonly [sha: string, release: string]>([
		['actions/checkout', ['9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0', 'v7.0.0']],
		['actions/setup-node', ['820762786026740c76f36085b0efc47a31fe5020', 'v7.0.0']],
		['pnpm/action-setup', ['0ebf47130e4866e96fce0953f49152a61190b271', 'v6.0.9']],
		['google-github-actions/setup-gcloud', ['aa5489c8933f4cc7a4f7d45035b3b1440c9c10db', 'v3.0.1']]
	]);

	for (const file of readdirSync('.github/workflows').filter((name) => name.endsWith('.yml'))) {
		const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');

		for (const match of workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s+([^\s]+))?/g)) {
			const approved = approvedActions.get(match[1]);
			assert.ok(approved, `${file} uses unreviewed action ${match[1]}`);
			assert.equal(match[2], approved[0], `${file} uses an unapproved ${match[1]} commit`);
			assert.equal(match[3], approved[1], `${file} must document the reviewed ${match[1]} release`);
		}
	}
});

test('workflow jobs declare bounded timeouts', () => {
	const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
	const integrationWorkflow = readFileSync('.github/workflows/integration.yml', 'utf8');
	const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');

	assert.match(ciWorkflow, /test:\s*\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 20/);
	assert.match(integrationWorkflow, /backend-smoke:\s*\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 45/);
	assert.match(releaseWorkflow, /reject-publish-ref:\s*\n\s+if: \$\{\{ inputs\.publish && github\.ref != 'refs\/heads\/main' \}\}\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 5/);
	assert.match(releaseWorkflow, /release:\s*\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 60/);
	assert.match(releaseWorkflow, /publish:\s*\n\s+needs: release\n\s+if: \$\{\{ inputs\.publish && github\.ref == 'refs\/heads\/main' \}\}\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 15/);
});

test('workflow toolchain versions match package metadata', () => {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
		packageManager: string;
		engines: { node: string };
	};
	const pnpmVersion = /^pnpm@(.+)$/.exec(packageJson.packageManager)?.[1];
	const nodeMajor = /^>=(\d+)$/.exec(packageJson.engines.node)?.[1];

	assert.ok(pnpmVersion, 'packageManager must declare a pnpm version');
	assert.ok(nodeMajor, 'engines.node must declare a >= major version');

	for (const file of readdirSync('.github/workflows').filter((name) => name.endsWith('.yml'))) {
		const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');

		for (const match of workflow.matchAll(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version:\s*([^\s]+)/g)) {
			assert.equal(match[1], pnpmVersion, `${file} pnpm/action-setup version must match packageManager`);
		}
		for (const match of workflow.matchAll(/actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version:\s*([^\s]+)/g)) {
			assert.equal(match[1], nodeMajor, `${file} setup-node major must match engines.node lower bound`);
		}
	}
});

test('backend integration smoke runs real cache and search contracts', () => {
	const smoke = readFileSync('test/integration/backend-smoke.mjs', 'utf8');

	assert.match(smoke, /runStoreAdapterContract/);
	assert.match(smoke, /integration_postgres_native_/);
	assert.match(smoke, /active_ts_smoke_\$\{randomUUID\(\)\.replace/);
	assert.match(smoke, /await pool\.query\(`create schema \$\{postgresSchemaSql\}`\)/);
	assert.match(smoke, /createPostgresStoreAdapter\(\{\s*pool,\s*schema: postgresSchemaName\s*\}\)/);
	assert.match(smoke, /select data from \$\{nativeTableSql\} where data->>'handle' = \$1/);
	assert.match(smoke, /values: \['native-one'\]/);
	assert.match(smoke, /PostgreSQL native SQL query payload cannot be combined with portable query clauses/);
	assert.match(smoke, /drop schema if exists \$\{postgresSchemaSql\} cascade/);
	assert.match(smoke, /let postgresSmokeError/);
	assert.match(smoke, /let postgresCleanupError/);
	assert.match(smoke, /let postgresSchemaCreated = false/);
	assert.match(smoke, /postgresSchemaCreated = true/);
	assert.match(smoke, /if \(postgresSchemaCreated\) \{\s*try \{\s*await pool\.query\(`drop schema if exists \$\{postgresSchemaSql\} cascade`\)/);
	assert.match(smoke, /new AggregateError\(\s*\[\s*postgresSmokeError,\s*postgresCleanupError\s*\]/);
	assert.doesNotMatch(smoke, /drop schema if exists \$\{postgresSchemaSql\} cascade`\)\.catch\(\(\) => undefined\)/);
	assert.match(smoke, /createMongoStoreAdapter\(\{\s*client,\s*dbName,\s*allowAggregateScanFallback: true\s*\}\)/);
	assert.match(smoke, /runCacheAdapterContract\(cache\)/);
	assert.match(smoke, /runSearchAdapterContract\(search,\s*\{/);
	assert.match(smoke, /settleMs: 10000/);
	assert.match(smoke, /pollIntervalMs: 500/);
	assert.match(smoke, /nativeProbe: async \(\{ adapter, model \}\) =>/);
	assert.match(smoke, /title: 'native probe needle'/);
	assert.match(smoke, /const nativeOnlyModel = \{ \.\.\.model, searchIndexes: \[\] \}/);
	assert.match(smoke, /native: \{ query: \{ match: \{ title: 'native probe needle' \} \} \}/);
	assert.match(smoke, /assert\.deepEqual\(result\.list\.map\(\(item\) => item\.id\), \[900\]\)/);
	assert.match(smoke, /integration_mongodb_native_/);
	assert.match(smoke, /collection\s*}\) => \(\{\s*list: await collection\s*\n\s*\.find\(\{ handle: 'native-one' \}/);
	assert.match(
		smoke,
		/const namespaceStoreFactory = await createDatastoreNamespaceStoreFactory\(\{/
	);
	assert.match(smoke, /datastoreOptions: \{ projectId: googleProjectId \}/);
	assert.match(smoke, /cacheScopePrefix: `datastore\|project=\$\{googleProjectId\}\|database=-`/);
	assert.match(smoke, /allowAggregateScanFallback: true/);
	assert.match(smoke, /allowQueryScanFallback: true/);
	assert.match(smoke, /const adapter = await namespaceStoreFactory\.forNamespace\(namespace\)/);
	assert.match(smoke, /const alternateNamespaceAdapter = await namespaceStoreFactory\.forNamespace\(alternateNamespace\)/);
	assert.match(smoke, /await adapter\.create\(nativeMeta, 9001, \{ id: 9001, handle: 'primary-namespace' \}\)/);
	assert.match(smoke, /await alternateNamespaceAdapter\.transaction\(async \(transaction\) =>/);
	assert.match(smoke, /integration_datastore_native_/);
	assert.match(smoke, /client\.createQuery\(namespace, model\.name\)\.filter\('handle', '=', 'native-one'\)/);
	assert.match(smoke, /integration_datastore_aggregate_/);
	assert.match(smoke, /totalScore: 40/);
	assert.match(smoke, /averageScore: 20/);
	assert.match(smoke, /minScore: 10/);
	assert.match(smoke, /maxScore: 30/);
	assert.match(smoke, /targets\.has\('datastore'\) && targets\.has\('elasticsearch'\)/);
	assert.match(smoke, /StoreOutboxAdapter/);
	assert.match(smoke, /createOutboxPlugin/);
	assert.match(smoke, /runSearchSyncWorker/);
	assert.match(smoke, /datastoreSearchDocumentIdentity/);
	assert.match(smoke, /integration_datastore_outbox_search_/);
	assert.match(smoke, /modelDatastoreAncestor: leftAncestor/);
	assert.match(smoke, /modelDatastoreAncestor: rightAncestor/);
	assert.match(smoke, /hasData: false/);
	assert.match(smoke, /Record\.ancestor\(datastoreKey\(parentKind, 10\)\)\.find\(1\)\.delete\(\)/);
	assert.match(smoke, /afterDelete\.list\.map\(\(item\) => `\$\{item\.id\}:\$\{item\.parentId\}`\)\.sort\(\)/);
	assert.match(smoke, /createFirestoreStoreAdapter/);
	assert.match(smoke, /const \{ Firestore, AggregateField \} = await import\('@google-cloud\/firestore'\)/);
	assert.match(smoke, /createFirestoreStoreAdapter\(\{\s*client,\s*aggregateField: AggregateField,\s*allowAggregateScanFallback: true\s*\}\)/);
	assert.match(smoke, /integration_firestore_native_/);
	assert.match(smoke, /client\.collection\(model\.name\)\.where\('handle', '==', 'native-one'\)\.get\(\)/);
	assert.match(smoke, /integration_firestore_aggregate_/);
	assert.match(smoke, /aggregates: \[\{ op: 'count', as: 'count' \}\]/);
	assert.match(smoke, /aggregates: \[\{ op: 'min', field: 'score', as: 'minScore' \}\]/);
	assert.match(smoke, /aggregates: \[\{ op: 'max', field: 'score', as: 'maxScore' \}\]/);
	assert.match(smoke, /targets\.has\('datastore'\)/);
	assert.match(smoke, /targets\.has\('firestore'\)/);
	assert.match(smoke, /Unknown active-ts integration target/);
	assert.match(smoke, /Every requested active-ts integration target must run/);
	assert.match(smoke, /client\.terminate\(\)/);
	assert.doesNotMatch(smoke, /cache\.setMany\(\[\['one'/);
});

test('Google backend integration smoke requires emulator env unless explicitly opted into real GCP', () => {
	const smoke = readFileSync('test/integration/backend-smoke.mjs', 'utf8');
	const datastoreGuardIndex = smoke.indexOf("assertGoogleBackendSmokeSafety('Datastore', 'DATASTORE_EMULATOR_HOST')");
	const datastoreImportIndex = smoke.indexOf("await import('@google-cloud/datastore')");
	const firestoreGuardIndex = smoke.indexOf("assertGoogleBackendSmokeSafety('Firestore', 'FIRESTORE_EMULATOR_HOST')");
	const firestoreImportIndex = smoke.indexOf("await import('@google-cloud/firestore')");

	assert.match(smoke, /process\.env\.ACTIVE_TS_ALLOW_REAL_GCP_BACKEND_SMOKE === 'true'/);
	assert.match(smoke, /process\.env\.ACTIVE_TS_REAL_GCP_BACKEND_PROJECTS/);
	assert.match(smoke, /allowedRealGoogleBackendProjects\.has\(googleProjectId\)/);
	assert.match(smoke, /process\.env\[emulatorEnvName\]/);
	assert.ok(datastoreGuardIndex >= 0, 'Datastore smoke must fail fast without DATASTORE_EMULATOR_HOST');
	assert.ok(firestoreGuardIndex >= 0, 'Firestore smoke must fail fast without FIRESTORE_EMULATOR_HOST');
	assert.ok(
		datastoreImportIndex > datastoreGuardIndex,
		'Datastore smoke must check DATASTORE_EMULATOR_HOST before importing the SDK'
	);
	assert.ok(
		firestoreImportIndex > firestoreGuardIndex,
		'Firestore smoke must check FIRESTORE_EMULATOR_HOST before importing the SDK'
	);
});

test('backend integration workflows start Google emulators before smoke tests', () => {
	for (const file of ['.github/workflows/integration.yml', '.github/workflows/release.yml']) {
		const workflow = readFileSync(file, 'utf8');

		assert.match(workflow, /google-github-actions\/setup-gcloud@[0-9a-f]{40}/);
		assert.match(workflow, /version: 505\.0\.0/);
		assert.doesNotMatch(workflow, /version: ['"]?>=/);
		assert.match(workflow, /install_components: beta,cloud-datastore-emulator,cloud-firestore-emulator/);
		assert.match(workflow, /gcloud beta emulators datastore start/);
		assert.match(workflow, /--consistency=1\.0/);
		assert.match(workflow, /gcloud emulators firestore start/);
		assert.match(workflow, /import \{ Datastore \} from '@google-cloud\/datastore'/);
		assert.match(workflow, /import \{ Firestore \} from '@google-cloud\/firestore'/);
		assert.match(workflow, /Datastore probe read failed/);
		assert.match(workflow, /Firestore probe read failed/);
		assert.doesNotMatch(workflow, /\/dev\/tcp/);
		assert.ok(
			workflow.indexOf('Start Google Cloud emulators') < workflow.indexOf('pnpm test:integration:backends'),
			`${file} must start Google emulators before backend smoke tests`
		);
	}
});

test('testing docs describe pull request backend integration triggers', () => {
	const testingDocs = readFileSync('docs/testing.md', 'utf8');

	assert.match(testingDocs, /main pushes, and pull requests/);
	assert.match(testingDocs, /pull requests that touch adapter, core, testing harness,\s+integration, package, or workflow files/);
	assert.match(testingDocs, /schedule, manual\s+dispatch, main pushes, and pull requests/);
	assert.match(testingDocs, /Datastore and\s+Firestore emulators/);
	assert.match(testingDocs, /ACTIVE_TS_INTEGRATION_TARGETS=datastore,firestore/);
});

test('testing docs import lazy-load warning helpers used in examples', () => {
	const testingDocs = readFileSync('docs/testing.md', 'utf8');

	assert.match(testingDocs, /expectNoLazyLoadWarnings,[\s\S]*from 'active-ts\/testing'/);
	assert.match(testingDocs, /await expectNoLazyLoadWarnings/);
});

test('quickstart OR example uses fields declared in the quickstart model', () => {
	const quickstart = readFileSync('docs/quickstart.md', 'utf8');

	assert.doesNotMatch(quickstart, /where\(\{ tenantId \}\)/);
	assert.doesNotMatch(quickstart, /\{ role: 'owner' \}/);
	assert.match(
		quickstart,
		/\.where\('handle', 'startsWith', 'seo'\)\s+\.whereAny\(\{ name: 'Seorii' \}, \{ name: 'SEO Rii' \}\)/
	);
});

test('aggregate examples use fields declared in the example model', () => {
	const readme = readFileSync('README.md', 'utf8');
	const quickstart = readFileSync('docs/quickstart.md', 'utf8');
	const accountDataWithScore = /type AccountData = \{[\s\S]*?score\?: number;[\s\S]*?\};/;

	assert.match(readme, accountDataWithScore);
	assert.match(quickstart, accountDataWithScore);
	assert.match(readme, /Account\.query\(\)\.sum\('score'\)/);
	assert.match(quickstart, /Account\.query\(\)\.sum\('score'\)/);
	assert.match(quickstart, /Account\.query\(\)\.avg\('score'\)/);
	assert.match(quickstart, /field: 'score'/);
});

test('aggregate docs describe query fallback as explicit opt-in', () => {
	const quickstart = readFileSync('docs/quickstart.md', 'utf8');
	const concepts = readFileSync('docs/concepts.md', 'utf8');
	const adapters = readFileSync('docs/adapters.md', 'utf8');

	assert.doesNotMatch(quickstart, /Otherwise active-ts falls back to a filtered query/);
	assert.match(quickstart, /aggregate\.allowQueryFallback: true/);
	assert.match(adapters, /aggregate\.allowQueryFallback: true/);
	assert.match(concepts, /allowAggregateScanFallback: true/);
	assert.match(adapters, /allowAggregateScanFallback: true/);
	assert.match(concepts, /allowQueryScanFallback: true/);
	assert.match(adapters, /allowQueryScanFallback: true/);
	assert.match(adapters, /separate from the context-level\s+`aggregate\.allowQueryFallback: true`/);
});

test('adapter testing docs describe cache duplicate-key contract', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');
	const testing = readFileSync('docs/testing.md', 'utf8');
	const duplicateKeyContract = /duplicate-key\s+`setMany\(\)` rejection/;

	assert.match(adapters, duplicateKeyContract);
	assert.match(testing, duplicateKeyContract);
});

test('adapter testing docs use the public native payload shape', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');
	const testing = readFileSync('docs/testing.md', 'utf8');

	assert.match(adapters, /payload:\s+\(input: \{ model: \{ name: string \}; plan: \{ native\?: unknown \} \}\) =>/);
	assert.match(adapters, /const \{ model: nativeModel, plan \} = input/);
	assert.match(adapters, /payload:\s+\(input: \{ model: \{ name: string \} \}\) => input\.model\.name/);
	assert.match(testing, /runStoreContract\(\{\s+nativeProbe: async \(\{ adapter, model \}\) =>/);
	assert.match(testing, /native:\s+\{\s+payload:\s+\{ text:/);
	assert.match(testing, /runSearchContract\(\{\s+settleMs: 5_000,\s+pollIntervalMs: 100,\s+nativeProbe: async \(\{ adapter, model \}\) =>/);
	assert.match(testing, /native:\s+\{ query: \{ match: \{ title: 'alpha' \} \} \}/);
	assert.doesNotMatch(adapters, /native:\s+\(\{ model: nativeModel/);
});

test('adapter docs distinguish PostgreSQL schema option from portable model identifiers', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');

	assert.match(adapters, /PostgreSQL model and index identifiers still use active-ts portable schema\s+identifier rules/);
	assert.match(adapters, /`schema` option is a PostgreSQL schema\s+identifier and is SQL-quoted/);
	assert.match(adapters, /non-empty, has no null bytes, and fits the\s+PostgreSQL identifier byte limit/);
});

test('adapter docs describe Google limited inequality ordering contract', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');

	assert.match(adapters, /Firestore and Datastore also reject\s+`limit\(\)` queries that have inequality filters/);
	assert.match(adapters, /explicit first\s+`orderBy\(\)`\/`order\(\)` on an inequality field/);
});

test('adapter docs describe Datastore namespace search identity behavior', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');

	assert.match(adapters, /createDatastoreStoreAdapter\(\{ namespace \}\)/);
	assert.match(adapters, /adapter\s+namespace is part of the effective Datastore key/);
	assert.match(adapters, /ancestor-scoped search document identities and outbox metadata/);
	assert.match(adapters, /share a search\s+adapter without overwriting each other's ancestor-backed search documents/);
	assert.match(adapters, /explicit namespace, it must match the adapter\s+namespace/);
});

test('adapter docs describe operation-scoped Datastore namespace stores', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');
	const testing = readFileSync('docs/testing.md', 'utf8');

	assert.match(adapters, /createDatastoreNamespaceStoreFactory/);
	assert.match(adapters, /await namespaceStores\.forNamespace\(namespace\)/);
	assert.match(adapters, /complete `StoreAdapter`, including transaction\s+support/);
	assert.match(adapters, /never mutates `client\.namespace`/);
	assert.match(adapters, /does\s+not retain adapters in an unbounded tenant map/);
	assert.match(adapters, /length-prefixes that identity,\s+the key encoding, and the namespace/);
	assert.match(adapters, /Native query callbacks deliberately receive the shared raw SDK client/);
	assert.match(testing, /same kind and id remain isolated across namespaces/);
});

test('adapter docs describe Datastore historical read boundaries', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');
	const readme = readFileSync('README.md', 'utf8');

	assert.match(adapters, /`readAt\(\)` accepts an epoch-millisecond number or `Date`/);
	assert.match(adapters, /`readConsistency\(\)` accepts `strong` or `eventual`/);
	assert.match(adapters, /bypasses active-ts entity caches and does not\s+backfill them/);
	assert.match(adapters, /datastoreReadOptions\(\{ readTime, ancestor: parentKey \}\)/);
	assert.match(adapters, /cannot\s+force a callback's SDK calls to use it/);
	assert.match(readme, /\.readAt\(readTime\)/);
});

test('adapter docs describe safe Datastore id-only key projection', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');
	const smoke = readFileSync('test/integration/backend-smoke.mjs', 'utf8');

	assert.match(adapters, /An exact\s+`\.select\(idField\)` is the safe exception/);
	assert.match(adapters, /SDK\s+`select\('__key__'\)`/);
	assert.match(adapters, /injected client does not expose a reliable SDK key symbol/);
	assert.match(adapters, /Transaction overlay queries also keep full rows/);
	assert.match(smoke, /select: \['id'\]/);
	assert.match(smoke, /NestedRecord\.ancestor\(nestedParent\)\.select\('id'\)/);
});

test('adapter docs describe Datastore legacy transaction ancestor mode', () => {
	const adapters = readFileSync('docs/adapters.md', 'utf8');

	assert.match(adapters, /OPTIMISTIC_WITH_ENTITY_GROUPS/);
	assert.match(adapters, /requireAncestorTransactionQueries:\s+true/);
	assert.match(adapters, /reject transaction `query\(\)` and `aggregate\(\)` calls/);
	assert.match(adapters, /including native callback\s+plans/);
	assert.match(adapters, /meta\.datastoreAncestor/);
});

test('README function-cache example caches plain DTO data', () => {
	const readme = readFileSync('README.md', 'utf8');

	assert.match(readme, /const rankRow = await Rank\.find\(id\)\.load\(\);/);
	assert.match(readme, /rankRow \? \{ rank: rankRow\.data\.rank, tier: rankRow\.data\.tier \} : null/);
	assert.doesNotMatch(readme, /rank: await Rank\.find\(id\)\.load\(\)/);
});

test('search docs describe projected partial hits and include reloads', () => {
	const concepts = readFileSync('docs/concepts.md', 'utf8');
	const adapters = readFileSync('docs/adapters.md', 'utf8');

	assert.match(concepts, /projected search documents/);
	assert.match(concepts, /partial model instances/);
	assert.match(concepts, /case-insensitive text matching/);
	assert.match(concepts, /string-array elements/);
	assert.match(concepts, /Use `include\(\.\.\.\)` on the search builder/);
	assert.match(concepts, /Stale search hits that\s+no longer exist in the store are dropped/);
	assert.match(concepts, /`total` is cleared when stale hits were pruned/);
	assert.doesNotMatch(concepts, /Search adapters return rows that are instantiated as models, so read validation\s+and relation loading still apply/);
	assert.match(adapters, /Native search wraps a store adapter/);
	assert.match(adapters, /field codec.*`encodeQuery`/s);
});

test('security docs describe validation before clone boundaries', () => {
	const security = readFileSync('docs/security.md', 'utf8');

	assert.match(security, /validates supported value types, reserved keys, accessor\s+properties, and symbol metadata before it calls the platform `structuredClone`/);
	assert.match(security, /non-enumerable\s+`ACTIVE_TS_ENTITY_KEY`/);
	assert.match(security, /Enumerable caller-supplied symbol fields are rejected/);
	assert.doesNotMatch(security, /`structuredClone` implementation before\s+checking reserved keys/);
});

test('risk register dashboard matches archived rows', () => {
	const dashboard = readFileSync('docs/risk-register.md', 'utf8');
	const archive = readFileSync('docs/risk-register-archive.md', 'utf8');
	const rows: Array<{ id: number; status: string }> = [];
	const activeRows: Array<{ id: string; status: string }> = [];
	let previousId = 0;

	for (const line of archive.split('\n')) {
		const row = /^\| R-(\d{3,4}) \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| ([^|]+) \|$/.exec(line);
		if (row) {
			const id = Number(row[1]);
			assert.ok(id > previousId, `Risk register id R-${row[1]} must be greater than the previous row`);
			rows.push({ id, status: row[2].trim() });
			previousId = id;
		}
	}

	for (const line of dashboard.split('\n')) {
		const row = /^\| ((?:BUG|DOC|ARCH|TEST)-\d{3}) \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| ([^|]+) \|$/.exec(line);
		if (row) activeRows.push({ id: row[1], status: row[2].trim() });
	}

	const historicalStatusCounts = rows.reduce<Record<string, number>>((counts, row) => {
		counts[row.status] = (counts[row.status] ?? 0) + 1;
		return counts;
	}, {});
	const activeStatusCounts = activeRows.reduce<Record<string, number>>((counts, row) => {
		counts[row.status] = (counts[row.status] ?? 0) + 1;
		return counts;
	}, {});
	const dashboardMetrics = new Map(
		[...dashboard.matchAll(/^\| ([A-Za-z ]+) \| ([0-9,]+|R-\d{4}) \|$/gm)].map((match) => [
			match[1],
			match[2]
		])
	);

	assert.equal(rows.length, Number(dashboardMetrics.get('Total historical risks')?.replaceAll(',', '')));
	assert.equal(historicalStatusCounts.Mitigated, Number(dashboardMetrics.get('Mitigated historical risks')?.replaceAll(',', '')));
	assert.equal(activeStatusCounts.Open ?? 0, Number(dashboardMetrics.get('Open risks')?.replaceAll(',', '')));
	assert.equal(activeStatusCounts['In Progress'] ?? 0, Number(dashboardMetrics.get('In progress risks')?.replaceAll(',', '')));
	assert.equal(activeStatusCounts.Accepted ?? 0, Number(dashboardMetrics.get('Accepted risks')?.replaceAll(',', '')));
	assert.equal(`R-${String(Math.max(...rows.map((row) => row.id))).padStart(4, '0')}`, dashboardMetrics.get('Latest historical risk id'));
	assert.match(dashboard, /\[risk-register-archive\.md\]\(risk-register-archive\.md\)/);
	assert.match(archive, /\[risk-register\.md\]\(risk-register\.md\)/);
	if (activeRows.length === 0) {
		assert.match(dashboard, /\| _None_ \| - \| No open risks at this time\./);
	} else {
		assert.doesNotMatch(dashboard, /\| _None_ \| - \| No open risks at this time\./);
	}
});

test('package root export keeps internal helpers out of the public surface', async () => {
	const activeTs = await import('../src/index.js');
	const expectedRootExports = [
		'ACTIVE_TS_ENTITY_KEY',
		'ActiveContext',
		'ActiveFunctionCache',
		'ActiveTsCommittedTransactionError',
		'ActiveTsCommittedWriteError',
		'ActiveTsConfigurationError',
		'ActiveTsConflictError',
		'ActiveTsError',
		'ActiveTsNotFoundError',
		'ActiveTsValidationError',
		'FindBuilder',
		'LazyRef',
		'MemoryCacheAdapter',
		'MemoryOutboxAdapter',
		'MemorySearchAdapter',
		'MemoryStoreAdapter',
		'Model',
		'ModelBuilder',
		'QueryBuilder',
		'SearchBuilder',
		'StoreOutboxAdapter',
		'aggregateRows',
		'applyFieldTypeTransforms',
		'applyModelMeta',
		'assertAggregateSpecsCompatibleWithModel',
		'assertContextBoundCacheAdapter',
		'assertContextBoundSearchAdapter',
		'assertContextBoundStoreAdapter',
		'assertCursorMatchesSort',
		'assertOutsideActiveTransaction',
		'assertSafeAggregateAlias',
		'attachModelMeta',
		'clearDefaultContext',
		'compareRowToCursor',
		'compareRowsBySort',
		'createActiveTs',
		'createActiveTsAsync',
		'createAesGcmCacheCodec',
		'createCacheMiddlewareAdapter',
		'createCodecCacheAdapter',
		'createFunctionCache',
		'createOutboxPlugin',
		'createSearchMiddlewareAdapter',
		'createSoftDeletePlugin',
		'createStoreMiddlewareAdapter',
		'cursorValues',
		'datastoreAncestorOptions',
		'datastoreKey',
		'datastoreReadOptions',
		'datastoreSearchDocumentIdentity',
		'decodeCursor',
		'defaultAggregateResult',
		'defaultAggregateValue',
		'defineModel',
		'encodeCursor',
		'entity',
		'field',
		'fromArkType',
		'fromTypia',
		'fromValibot',
		'fromZod',
		'getCurrentDefaultContext',
		'getDefaultContext',
		'getFunctionCacheDiagnostics',
		'getModelMeta',
		'getRelation',
		'hasMany',
		'id',
		'index',
		'isContextBoundCacheAdapter',
		'isContextBoundSearchAdapter',
		'isContextBoundStoreAdapter',
		'isPartialModel',
		'markSearchDocumentIdentity',
		'mergeHooks',
		'modelMeta',
		'normalizeAggregateFieldTypes',
		'normalizeAggregatePlanFieldTypes',
		'normalizeAggregateResult',
		'normalizeAggregateRow',
		'normalizeIncludeSpecs',
		'normalizeOutboxEvent',
		'normalizeQueryPlanFieldTypes',
		'normalizeWhereFieldTypes',
		'normalizeWhereShapeFieldTypes',
		'ref',
		'relation',
		'relationPreloadSelectFields',
		'resetLazyLoadWarnings',
		'restore',
		'runHookList',
		'runSearchSyncWorker',
		'safeErrorMessage',
		'sanitizeHooks',
		'searchIndex',
		'setDefaultContext',
		'softDelete',
		'sortWithStableId',
		'toHookList',
		'trackStoreTransactionWork',
		'typedField',
		'validateAggregateSpecs'
	];

	for (const name of [
		'addIndexMeta',
		'assertSafeCacheKey',
		'assertSafeDataKeys',
		'assertSafeEntityId',
		'attachEntityKey',
		'cloneSafeData',
		'defineDataProperty',
		'isReservedFieldName',
		'markPartialModel',
		'optionalImport',
		'PARTIAL_MODEL',
		'resolveModelMeta',
		'setEntityMeta',
		'setIdField',
		'setValidator',
		'snapshotModelMeta'
	]) {
		assert.equal(name in activeTs, false, `${name} should not be exported from active-ts root`);
	}

	for (const name of [
		'ACTIVE_TS_ENTITY_KEY',
		'applyModelMeta',
		'attachModelMeta',
		'getModelMeta',
		'getRelation',
		'isPartialModel',
		'modelMeta'
	]) {
		assert.equal(name in activeTs, true, `${name} should remain exported from active-ts root`);
	}
	assert.deepEqual(Object.keys(activeTs).sort(), expectedRootExports);
});

test('package adapter exports expose only documented public subpaths', async () => {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
	const adapterDocs = readFileSync('docs/adapters.md', 'utf8');
	const exportNames = Object.keys(packageJson.exports);
	const expectedExportNames = [
		'.',
		'./adapters/cache/memory',
		'./adapters/cache/redis-valkey',
		'./adapters/search/algolia',
		'./adapters/search/elasticsearch',
		'./adapters/search/memory',
		'./adapters/search/native',
		'./adapters/store/datastore',
		'./adapters/store/firestore',
		'./adapters/store/memory',
		'./adapters/store/mongodb',
		'./adapters/store/postgresql',
		'./testing'
	];

	assert.equal(exportNames.some((name) => name.includes('*')), false);
	assert.equal(exportNames.includes('./adapters/store/google-query-constraints'), false);
	assert.deepEqual(exportNames.sort(), expectedExportNames);
	const documentedAdapterImports = new Set(
		[...adapterDocs.matchAll(/`(active-ts\/adapters\/[^`]+)`/g)].map((match) => match[1])
	);
	for (const name of [
		'./adapters/store/datastore',
		'./adapters/store/firestore',
		'./adapters/store/memory',
		'./adapters/store/mongodb',
		'./adapters/store/postgresql',
		'./adapters/cache/memory',
		'./adapters/cache/redis-valkey',
		'./adapters/search/algolia',
		'./adapters/search/elasticsearch',
		'./adapters/search/memory',
		'./adapters/search/native',
		'./testing'
	]) {
		assert.equal(exportNames.includes(name), true, `${name} should remain exported`);
		if (name.startsWith('./adapters/')) {
			assert.equal(
				documentedAdapterImports.has(`active-ts/${name.slice(2)}`),
				true,
				`${name} should be documented in docs/adapters.md`
			);
		}
	}
	for (const [subpath, value] of Object.entries(packageJson.exports) as Array<[string, Record<string, string>]>) {
		assert.deepEqual(Object.keys(value).sort(), ['import', 'types'], `${subpath} export conditions`);
		assert.match(value.import, /^\.\/build\/src\/.+\.js$/, `${subpath} import target`);
		assert.match(value.types, /^\.\/build\/src\/.+\.d\.ts$/, `${subpath} types target`);
		assert.equal(value.import.slice(0, -'.js'.length), value.types.slice(0, -'.d.ts'.length), `${subpath} paired target stem`);
	}
});
