import { readdir, readFile } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';

import ts from 'typescript';

export const TEST_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
const VITEST_TEST_FILE = /\.test\.(?:cts|mts|ts|tsx)$/;

/**
 * Mirrors the `paths` aliases of the root `tsconfig.json` so alias imports resolve to repository paths during direct
 * import discovery. The colocated contract test asserts this map stays in sync with `tsconfig.json`.
 */
export const IMPORT_PATH_ALIASES: ReadonlyArray<{ prefix: string; target: string }> = [
    { prefix: '@/', target: 'apps/desktop/src/renderer/src/' },
    { prefix: '@desktop-shared/', target: 'apps/desktop/src/shared/' },
];

export const VITEST_SOURCE_ROOTS = [
    'apps',
    'extensions',
    '.agents/skills',
    'scripts',
    'packages',
] as const;

interface SourceImportResolution {
    barrelContents: ReadonlyMap<string, string>;
    workspaceEntries: ReadonlyMap<string, string>;
}

const EMPTY_RESOLUTION: SourceImportResolution = {
    barrelContents: new Map(),
    workspaceEntries: new Map(),
};

function sourceModuleKey(path: string): string {
    const extension = extname(path);
    return extension ? path.slice(0, -extension.length) : path;
}

function resolveImportPaths(
    importer: string,
    specifier: string,
    workspaceEntries: ReadonlyMap<string, string>,
): string[] {
    if (specifier.startsWith('./') || specifier.startsWith('../'))
        return [posix.normalize(posix.join(posix.dirname(importer), specifier))];
    const workspaceEntry = workspaceEntries.get(specifier);
    if (workspaceEntry) return [workspaceEntry];
    return IMPORT_PATH_ALIASES.filter(({ prefix }) => specifier.startsWith(prefix)).map(
        ({ prefix, target }) => posix.normalize(target + specifier.slice(prefix.length)),
    );
}

/**
 * Splits a Vite query (`?raw`, `?inline`, `?url`) off an import specifier. A queried import loads that exact file,
 * extension included, rather than resolving a module, so it is matched by path instead of by module key.
 */
function splitImportQuery(specifier: string): { path: string; query: boolean } {
    const index = specifier.indexOf('?');
    return index === -1
        ? { path: specifier, query: false }
        : { path: specifier.slice(0, index), query: true };
}

function isModuleSource(path: string): boolean {
    return TEST_EXTENSIONS.some((extension) => path.endsWith(extension)) && !path.endsWith('.d.ts');
}

/**
 * String patterns of every `import.meta.glob(...)` call in a test. Vite resolves `./` and `../` against the importing
 * file and a leading `/` against the project root; a `!` prefix excludes matches
 * (https://vite.dev/guide/features#glob-import).
 */
function importMetaGlobPatterns(parsedTest: ts.SourceFile): string[] {
    const patterns: string[] = [];
    const literalText = (node: ts.Node): string | undefined =>
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            ? node.text
            : undefined;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'glob' &&
            ts.isMetaProperty(node.expression.expression) &&
            node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
        ) {
            const argument = node.arguments.at(0);
            const elements =
                argument && ts.isArrayLiteralExpression(argument) ? argument.elements : [argument];
            for (const element of elements) {
                const text = element ? literalText(element) : undefined;
                if (text !== undefined) patterns.push(text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(parsedTest);
    return patterns;
}

function isMatchedByImportMetaGlob(
    testFile: string,
    patterns: readonly string[],
    sourceFile: string,
    workspaceEntries: ReadonlyMap<string, string>,
): boolean {
    /**
     * A bare negative pattern (Vite documents a globstar exclusion of `bar.js`) is neither relative nor aliased; it
     * applies to the path as written.
     */
    const resolve = (pattern: string) => {
        if (pattern.startsWith('/')) return [pattern.slice(1)];
        const resolved = resolveImportPaths(testFile, pattern, workspaceEntries);
        return resolved.length > 0 ? resolved : [pattern];
    };
    const matches = (pattern: string) =>
        resolve(pattern).some((resolved) => posix.matchesGlob(sourceFile, resolved));
    const included = patterns.filter((pattern) => !pattern.startsWith('!'));
    const excluded = patterns.filter((pattern) => pattern.startsWith('!'));
    return included.some(matches) && excluded.every((pattern) => !matches(pattern.slice(1)));
}

function isSourceModuleMatch(
    imported: string,
    source: string,
    barrelContents: ReadonlyMap<string, string>,
    depth: number,
    visited: ReadonlySet<string>,
): boolean {
    const importedKey = sourceModuleKey(imported);
    const sourceKey = sourceModuleKey(source);
    if (importedKey === sourceKey || `${importedKey}/index` === sourceKey) return true;
    if (depth === 2) return false;
    const barrelFile = barrelContents.has(importedKey) ? importedKey : `${importedKey}/index`;
    if (visited.has(barrelFile)) return false;
    const contents = barrelContents.get(barrelFile);
    if (!contents) return false;
    const parsed = ts.createSourceFile(barrelFile, contents, ts.ScriptTarget.Latest);
    const exports = parsed.statements.filter(
        (statement): statement is ts.ExportDeclaration =>
            ts.isExportDeclaration(statement) &&
            !!statement.moduleSpecifier &&
            ts.isStringLiteral(statement.moduleSpecifier),
    );
    if (exports.length === 0 || exports.length !== parsed.statements.length) return false;
    const nextVisited = new Set([...visited, barrelFile]);
    return exports.some((statement) =>
        resolveImportPaths(
            `${barrelFile}.ts`,
            (statement.moduleSpecifier as ts.StringLiteral).text,
            new Map(),
        ).some((path) => isSourceModuleMatch(path, source, barrelContents, depth + 1, nextVisited)),
    );
}

/**
 * Matches static test imports through workspace entries or at most two pure re-export barrels. Ordinary imported
 * modules are not traversed, keeping a focused check bounded even for widely shared contracts.
 *
 * A test that asserts on a file's text imports it with a Vite query (`theme.css?raw`) or `import.meta.glob` instead of
 * reading it with `fs`, so the dependency is visible here and to Vitest's own module graph. Those match the exact file,
 * which is also the only way a non-module source such as a stylesheet can select a test.
 */
export function hasDirectSourceImport(
    testFile: string,
    testContents: string,
    sourceFile: string,
    resolution: SourceImportResolution = EMPTY_RESOLUTION,
): boolean {
    const normalizedTest = testFile.replaceAll('\\', '/');
    const normalizedSource = sourceFile.replaceAll('\\', '/');
    const isSourceIsModule = isModuleSource(normalizedSource);
    // A non-module file (Markdown, a stylesheet) can only be named by a queried import or a glob, so skip parsing
    // every test for it unless the text could contain one.
    if (
        !isSourceIsModule &&
        !testContents.includes(posix.basename(normalizedSource)) &&
        !testContents.includes('import.meta.glob')
    )
        return false;

    const syntax = testFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const parsedTest = ts.createSourceFile(
        testFile,
        testContents,
        ts.ScriptTarget.Latest,
        false,
        syntax,
    );
    for (const statement of parsedTest.statements) {
        const moduleSpecifier =
            ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
                ? statement.moduleSpecifier
                : undefined;
        if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
        const { path: specifier, query } = splitImportQuery(moduleSpecifier.text);
        if (query) {
            if (
                resolveImportPaths(normalizedTest, specifier, resolution.workspaceEntries).includes(
                    normalizedSource,
                )
            )
                return true;
            continue;
        }
        if (!isSourceIsModule) continue;
        if (
            resolveImportPaths(normalizedTest, specifier, resolution.workspaceEntries).some(
                (imported) =>
                    isSourceModuleMatch(
                        imported,
                        normalizedSource,
                        resolution.barrelContents,
                        0,
                        new Set(),
                    ),
            )
        ) {
            return true;
        }
    }
    return (
        testContents.includes('import.meta.glob') &&
        isMatchedByImportMetaGlob(
            normalizedTest,
            importMetaGlobPatterns(parsedTest),
            normalizedSource,
            resolution.workspaceEntries,
        )
    );
}

async function workspacePackageEntries(root: string): Promise<Map<string, string>> {
    const entries = new Map<string, string>();
    const packages = await readdir(join(root, 'packages'), { withFileTypes: true });
    await Promise.all(
        packages
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
                const manifest = JSON.parse(
                    await readFile(join(root, 'packages', entry.name, 'package.json'), 'utf8'),
                ) as {
                    name?: string;
                    exports?: Record<string, { bun?: string; types?: string }>;
                };
                if (!manifest.name) return;
                const exportedEntries = Object.entries(manifest.exports ?? {});
                for (const [subpath, target] of exportedEntries) {
                    const source = target.bun ?? target.types;
                    if (!source?.startsWith('./src/')) continue;
                    entries.set(
                        manifest.name + (subpath === '.' ? '' : subpath.slice(1)),
                        posix.join('packages', entry.name, source.slice(2)),
                    );
                }
            }),
    );
    return entries;
}

async function sourceBarrelContents(
    root: string,
    sources: readonly string[],
): Promise<Map<string, string>> {
    const candidates = new Set<string>();
    for (const source of sources) {
        let directory = posix.dirname(source);
        while (directory !== '.' && directory !== '') {
            candidates.add(posix.join(directory, 'index.ts'));
            directory = posix.dirname(directory);
        }
    }
    const barrels = new Map<string, string>();
    const candidateFiles = [...candidates];
    await Promise.all(
        candidateFiles.map(async (file) => {
            try {
                barrels.set(sourceModuleKey(file), await readFile(join(root, file), 'utf8'));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }),
    );
    return barrels;
}

async function walkMatchingFiles(
    root: string,
    directory: string,
    pattern: RegExp,
): Promise<string[]> {
    const absoluteDirectory = join(root, directory);
    try {
        const entries = await readdir(absoluteDirectory, { encoding: 'utf8', withFileTypes: true });
        const nested = await Promise.all(
            entries.map(async (entry) => {
                const path = posix.join(directory, entry.name);
                if (entry.isDirectory()) {
                    // Workspace packages vendor their own `node_modules` and build output; only
                    // repository test sources belong in the discovery walk.
                    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
                    return walkMatchingFiles(root, path, pattern);
                }
                return entry.isFile() && pattern.test(path) ? [path] : [];
            }),
        );
        return nested.flat();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

export function walkVitestTestFiles(root: string, directory: string): Promise<string[]> {
    return walkMatchingFiles(root, directory, VITEST_TEST_FILE);
}

async function sourceImportResolution(
    root: string,
    sources: readonly string[],
): Promise<SourceImportResolution> {
    const [workspaceEntries, barrelContents] = await Promise.all([
        workspacePackageEntries(root),
        sourceBarrelContents(root, sources),
    ]);
    return { barrelContents, workspaceEntries };
}

/**
 * Finds only direct static-import tests covered by Vitest's repository include patterns. Dynamic imports and transitive
 * dependency graphs are deliberately excluded so a focused source edit cannot fan out into unrelated integration
 * suites.
 */
export async function directImportTestCandidates(
    root: string,
    sourceFiles: string[],
): Promise<string[]> {
    // Any non-test file can be a dependency: modules through ordinary imports, and every file (stylesheets included)
    // through a `?raw` import or `import.meta.glob`.
    const sources = sourceFiles.filter(
        (file) => !VITEST_TEST_FILE.test(file) && !file.endsWith('.d.ts'),
    );
    if (sources.length === 0) return [];

    const resolution = await sourceImportResolution(root, sources);

    const tests = (
        await Promise.all(
            VITEST_SOURCE_ROOTS.map((directory) => walkVitestTestFiles(root, directory)),
        )
    ).flat();
    const contents = await Promise.all(
        tests.map(async (test) => ({ test, contents: await readFile(join(root, test), 'utf8') })),
    );
    return contents
        .filter(({ test, contents }) =>
            sources.some((source) => hasDirectSourceImport(test, contents, source, resolution)),
        )
        .map(({ test }) => test)
        .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Reports consumer E2E specs for an explicit caller decision; this never schedules Electron.
 */
export async function relatedE2ESpecs(root: string, sourceFiles: string[]): Promise<string[]> {
    const sources = sourceFiles.filter(
        (file) =>
            TEST_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
            !VITEST_TEST_FILE.test(file),
    );
    if (sources.length === 0) return [];
    const resolution = await sourceImportResolution(root, sources);
    const specs = await walkMatchingFiles(root, 'e2e', /\.e2e\.ts$/);
    const contents = await Promise.all(
        specs.map(async (spec) => ({ spec, contents: await readFile(join(root, spec), 'utf8') })),
    );
    return contents
        .filter(({ spec, contents }) =>
            sources.some((source) => hasDirectSourceImport(spec, contents, source, resolution)),
        )
        .map(({ spec }) => spec)
        .toSorted((a, b) => a.localeCompare(b));
}
