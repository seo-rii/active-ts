import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

type DocSnippet = {
	file: string;
	line: number;
	code: string;
	mode: 'typecheck' | 'fragment';
};
type PackageJson = {
	exports?: Record<string, string | { types?: string; import?: string }>;
};

const DOC_TEST_MODES = ['typecheck', 'fragment'] as const;

test('TypeScript documentation snippets are classified and standalone examples typecheck', () => {
	const snippets = readDocumentationSnippets();
	const typecheckSnippets = snippets.filter((snippet) => snippet.mode === 'typecheck');

	assert.ok(typecheckSnippets.length > 0, 'at least one documentation snippet must be typechecked');
	assert.deepEqual(findUnexportedActiveTsImports(snippets), []);
	typecheckDocumentationSnippets(typecheckSnippets);
});

test('documentation snippet package import checks reject private active-ts subpaths', () => {
	assert.deepEqual(
		findUnexportedActiveTsImports(
			[
				{
					file: 'docs/example.md',
					line: 10,
					code: "import { helper } from 'active-ts/core/search-utils';\nawait import('active-ts/adapters/store/google-query-constraints');",
					mode: 'typecheck'
				}
			],
			new Set(['active-ts', 'active-ts/testing'])
		),
		[
			'docs/example.md:11 imports "active-ts/core/search-utils", but package.json does not export it.',
			'docs/example.md:12 imports "active-ts/adapters/store/google-query-constraints", but package.json does not export it.'
		]
	);
});

function readDocumentationSnippets() {
	const docs = [
		'README.md',
		...readdirSync('docs')
			.filter((file) => file.endsWith('.md'))
			.map((file) => path.posix.join('docs', file))
	].sort();
	const snippets: DocSnippet[] = [];
	const unclassified: string[] = [];
	const invalidModes: string[] = [];
	const fencePattern = /^```(ts|typescript|js|javascript)([^\n]*)\n([\s\S]*?)^```/gm;

	for (const file of docs) {
		const content = readFileSync(file, 'utf8');
		for (const match of content.matchAll(fencePattern)) {
			const line = content.slice(0, match.index).split('\n').length;
			const info = match[2] ?? '';
			const modeMatch = /\bdoc-test=(\w+)\b/.exec(info);
			if (!modeMatch) {
				unclassified.push(`${file}:${line}`);
				continue;
			}
			if (!DOC_TEST_MODES.includes(modeMatch[1] as (typeof DOC_TEST_MODES)[number])) {
				invalidModes.push(`${file}:${line}: ${modeMatch[1]}`);
				continue;
			}
			snippets.push({
				file,
				line,
				code: match[3],
				mode: modeMatch[1] as DocSnippet['mode']
			});
		}
	}

	assert.deepEqual(unclassified, [], 'every TS/JS documentation fence must declare doc-test=typecheck or doc-test=fragment');
	assert.deepEqual(invalidModes, []);
	return snippets;
}

function typecheckDocumentationSnippets(snippets: DocSnippet[]) {
	const rootDir = process.cwd();
	const tempDir = mkdtempSync(path.join(tmpdir(), 'active-ts-doc-snippets-'));
	try {
		writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
		const rootNames = [
			writeTypiaShim(tempDir),
			...snippets.map((snippet, index) => writeSnippet(tempDir, snippet, index))
		];
		const options: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2023,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			noEmit: true,
			types: ['node'],
			typeRoots: [path.join(rootDir, 'node_modules', '@types')],
			baseUrl: rootDir,
			paths: packageExportCompilerPaths()
		};
		const program = ts.createProgram(rootNames, options);
		const diagnostics = ts.getPreEmitDiagnostics(program);

		assert.deepEqual(formatDiagnostics(diagnostics), []);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function writeTypiaShim(tempDir: string) {
	const file = path.join(tempDir, 'typia-shim.d.ts');
	writeFileSync(
		file,
		`declare module 'typia' {
	const typia: {
		misc: {
			createAssertPrune<T>(): (input: unknown) => T;
		};
	};
	export default typia;
}
`,
		'utf8'
	);
	return file;
}

function writeSnippet(tempDir: string, snippet: DocSnippet, index: number) {
	const file = path.join(tempDir, `snippet-${index + 1}.ts`);
	writeFileSync(
		file,
		`// Source: ${snippet.file}:${snippet.line}
${snippet.code}
`,
		'utf8'
	);
	return file;
}

function findUnexportedActiveTsImports(snippets: DocSnippet[], allowedSpecifiers = packageExportSpecifiers()) {
	const errors: string[] = [];
	for (const snippet of snippets) {
		for (const imported of activeTsImportsForSnippet(snippet)) {
			if (!isActiveTsPackageSpecifier(imported.specifier)) continue;
			if (allowedSpecifiers.has(imported.specifier)) continue;
			errors.push(
				`${snippet.file}:${imported.line} imports "${imported.specifier}", but package.json does not export it.`
			);
		}
	}
	return errors;
}

function activeTsImportsForSnippet(snippet: DocSnippet) {
	const imports: Array<{ specifier: string; line: number }> = [];
	const source = ts.createSourceFile(`${snippet.file}.snippet.ts`, snippet.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const pushSpecifier = (literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) => {
		const location = source.getLineAndCharacterOfPosition(literal.getStart(source));
		imports.push({ specifier: literal.text, line: snippet.line + location.line + 1 });
	};
	const visit = (node: ts.Node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			isStringLiteralLike(node.moduleSpecifier)
		) {
			pushSpecifier(node.moduleSpecifier);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			isStringLiteralLike(node.moduleReference.expression)
		) {
			pushSpecifier(node.moduleReference.expression);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
			node.arguments.length > 0 &&
			isStringLiteralLike(node.arguments[0])
		) {
			pushSpecifier(node.arguments[0]);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			isStringLiteralLike(node.argument.literal)
		) {
			pushSpecifier(node.argument.literal);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return imports;
}

function isStringLiteralLike(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isActiveTsPackageSpecifier(specifier: string) {
	return specifier === 'active-ts' || specifier.startsWith('active-ts/');
}

function packageExportSpecifiers() {
	return new Set(Object.keys(readPackageJson().exports ?? {}).map(packageSpecifierForExportSubpath));
}

function packageExportCompilerPaths() {
	const paths: Record<string, string[]> = {};
	for (const [subpath, value] of Object.entries(readPackageJson().exports ?? {})) {
		paths[packageSpecifierForExportSubpath(subpath)] = [sourcePathForPackageExport(value)];
	}
	return paths;
}

function packageSpecifierForExportSubpath(subpath: string) {
	if (subpath === '.') return 'active-ts';
	if (!subpath.startsWith('./')) throw new Error(`Unsupported package export subpath: ${subpath}`);
	return `active-ts/${subpath.slice(2)}`;
}

function sourcePathForPackageExport(value: string | { types?: string; import?: string }) {
	const target = typeof value === 'string' ? value : value.types ?? value.import;
	if (typeof target !== 'string') throw new Error('Package export must declare a string target.');
	let sourcePath = target.startsWith('./') ? target.slice(2) : target;
	if (sourcePath.startsWith('build/src/')) sourcePath = `src/${sourcePath.slice('build/src/'.length)}`;
	if (sourcePath.endsWith('.d.ts')) return `${sourcePath.slice(0, -'.d.ts'.length)}.ts`;
	if (sourcePath.endsWith('.js')) return `${sourcePath.slice(0, -'.js'.length)}.ts`;
	return sourcePath;
}

function readPackageJson(): PackageJson {
	return JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
	return diagnostics.map((diagnostic) => {
		if (diagnostic.file && typeof diagnostic.start === 'number') {
			const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			return `${diagnostic.file.fileName}:${location.line + 1}:${location.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
		}
		return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
	});
}
