import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import ts from 'typescript';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const FORMAT_EXTENSIONS = new Set(['.css', '.html', '.json', '.jsonc', '.md', '.yaml', '.yml']);
const TEST_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
const VITEST_TEST_FILE = /\.test\.(?:cts|mts|ts|tsx)$/;

export interface CheckOptions {
    e2e: boolean;
    e2eGrep?: string;
    files: string[];
    knip: boolean;
    lint: boolean;
    staged: boolean;
    test: boolean;
    type: boolean;
}

class CheckError extends Error {
    constructor(
        message: string,
        readonly exitCode = 1,
    ) {
        super(message);
    }
}

interface ProcessFailure extends Error {
    stderr?: Buffer | string;
    stdout?: Buffer | string;
}

const usage = `Usage: bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--e2e] [--e2e-grep <pattern>] [--staged]

Selectors:
  --lint     Autofix supported changed files with ESLint and Prettier
  --test     Run changed tests and colocated tests for changed source files
  --type     Run the repository-wide TypeScript check
  --knip     Run the repository-wide dead code/export check (CI blocking)
  --e2e      Build and run explicitly named e2e/*.e2e.ts Playwright specs
  --e2e-grep Narrow --e2e to a Playwright test-title pattern
  --staged   Discover only staged files when no file arguments are supplied

With no selector, --lint and --test are enabled.`;

export function parseCheckArgs(args: string[]): CheckOptions {
    const options: CheckOptions = {
        e2e: false,
        e2eGrep: undefined,
        files: [],
        knip: false,
        lint: false,
        staged: false,
        test: false,
        type: false,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        switch (arg) {
            case '--help':
            case '-h':
                throw new CheckError(usage, 0);
            case '--knip':
                options.knip = true;
                break;
            case '--e2e':
                options.e2e = true;
                break;
            case '--e2e-grep': {
                const pattern = args[index + 1];
                if (!pattern || pattern.startsWith('--')) {
                    throw new CheckError('--e2e-grep requires a test-title pattern', 2);
                }
                options.e2eGrep = pattern;
                index += 1;
                break;
            }
            case '--lint':
                options.lint = true;
                break;
            case '--staged':
                options.staged = true;
                break;
            case '--test':
                options.test = true;
                break;
            case '--type':
                options.type = true;
                break;
            default:
                if (arg.startsWith('-')) {
                    throw new CheckError(`Unknown option: ${arg}\n\n${usage}`, 2);
                }
                options.files.push(arg);
        }
    }

    if (options.e2eGrep && !options.e2e) {
        throw new CheckError('--e2e-grep requires --e2e', 2);
    }

    if (!options.e2e && !options.knip && !options.lint && !options.test && !options.type) {
        options.lint = true;
        options.test = true;
    }

    return options;
}

export function selectE2ESpecs(files: string[], hasExplicitFiles: boolean): string[] {
    const specs = files.filter((file) => /^e2e\/.+\.e2e\.ts$/.test(file));
    if (!hasExplicitFiles || specs.length === 0) {
        throw new CheckError('--e2e requires an explicit e2e/*.e2e.ts file', 2);
    }
    if (specs.includes('e2e/real-agent-smoke.e2e.ts')) {
        throw new CheckError('Use bun run test:e2e:real-agent for the manual real-Agent smoke', 2);
    }
    if (specs.includes('e2e/failure-isolation.e2e.ts')) {
        throw new CheckError('Use bun run scripts/run-e2e-failure-isolation.ts', 2);
    }
    return specs;
}

export function playwrightArguments(specs: string[], grep?: string): string[] {
    return ['test', ...specs, '--reporter=line', ...(grep ? ['-g', grep] : [])];
}

export function lintPipelineForFile(file: string): 'code' | 'format' | undefined {
    const extension = extname(file).toLowerCase();
    if (CODE_EXTENSIONS.has(extension)) return 'code';
    if (FORMAT_EXTENSIONS.has(extension)) return 'format';
    return undefined;
}

export function testCandidatesForFile(file: string): string[] {
    const normalized = file.replaceAll('\\', '/');
    if (/\.test\.(?:cts|mts|ts|tsx)$/.test(normalized)) return [normalized];

    const extension = TEST_EXTENSIONS.find((candidate) => normalized.endsWith(candidate));
    if (!extension || normalized.endsWith('.d.ts')) return [];

    const directory = posix.dirname(normalized);
    const stem = posix.basename(normalized, extension);
    const candidates = TEST_EXTENSIONS.flatMap((testExtension) => [
        posix.join(directory, `${stem}.test${testExtension}`),
        posix.join(directory, '__tests__', `${stem}.test${testExtension}`),
        posix.join(directory, `${stem}.integration.test${testExtension}`),
        posix.join(directory, '__tests__', `${stem}.integration.test${testExtension}`),
    ]);

    // Domain-level integration suites are named after their owning subdirectory rather than an
    // individual source stem (e.g. `src/runtime/db/*.ts` -> `db.integration.test.ts`,
    // `src/runtime/files/*.ts` -> `files.integration.test.ts`), because they exercise a whole
    // module composed of several sibling files. Only generate this candidate for directories
    // nested at least one level below a top-level domain directory (3+ path segments before the
    // filename); applying it at the top level would match broad, expensive suites like
    // `runtime.integration.test.ts` for nearly every file directly under `src/runtime/`.
    const directorySegments = directory.split('/').filter(Boolean);
    if (directorySegments.length >= 3) {
        const domain = directorySegments[directorySegments.length - 1];
        candidates.push(
            ...TEST_EXTENSIONS.flatMap((testExtension) => [
                posix.join(directory, `${domain}.integration.test${testExtension}`),
                posix.join(directory, '__tests__', `${domain}.integration.test${testExtension}`),
            ]),
        );
    }

    return candidates;
}

/**
 * Returns whether a test directly imports or re-exports a source file through a relative static
 * specifier. This intentionally does not walk transitive imports: broad runtime suites are much
 * less useful than the tests that name the changed module at their boundary.
 */
export function testDirectlyImportsSource(
    testFile: string,
    testContents: string,
    sourceFile: string,
): boolean {
    const normalizedTest = testFile.replaceAll('\\', '/');
    const normalizedSource = sourceFile.replaceAll('\\', '/');
    const sourceWithoutExtension = normalizedSource.slice(0, -extname(normalizedSource).length);

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
        const specifier = moduleSpecifier.text;
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        const imported = posix.normalize(posix.join(posix.dirname(normalizedTest), specifier));
        const importedExtension = extname(imported);
        const importedWithoutExtension = importedExtension
            ? imported.slice(0, -importedExtension.length)
            : imported;
        if (
            imported === normalizedSource ||
            importedWithoutExtension === sourceWithoutExtension ||
            importedWithoutExtension === `${sourceWithoutExtension}/index`
        ) {
            return true;
        }
    }
    return false;
}

async function walkVitestTestFiles(root: string, directory: string): Promise<string[]> {
    const absoluteDirectory = join(root, directory);
    try {
        const entries = await readdir(absoluteDirectory, { encoding: 'utf8', withFileTypes: true });
        const nested = await Promise.all(
            entries.map(async (entry) => {
                const path = posix.join(directory, entry.name);
                if (entry.isDirectory()) return walkVitestTestFiles(root, path);
                return entry.isFile() && VITEST_TEST_FILE.test(path) ? [path] : [];
            }),
        );
        return nested.flat();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

/**
 * Finds only direct static-import tests covered by Vitest's repository include patterns. Dynamic
 * imports and transitive dependency graphs are deliberately excluded so a focused source edit
 * cannot fan out into unrelated integration suites.
 */
export async function directImportTestCandidates(
    root: string,
    sourceFiles: string[],
): Promise<string[]> {
    const sources = sourceFiles.filter(
        (file) =>
            !VITEST_TEST_FILE.test(file) &&
            TEST_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
            !file.endsWith('.d.ts'),
    );
    if (sources.length === 0) return [];

    const tests = (
        await Promise.all(
            ['src', '.agents/skills', 'scripts'].map((directory) =>
                walkVitestTestFiles(root, directory),
            ),
        )
    ).flat();
    const contents = await Promise.all(
        tests.map(async (test) => ({ test, contents: await readFile(join(root, test), 'utf8') })),
    );
    return contents
        .filter(({ test, contents }) =>
            sources.some((source) => testDirectlyImportsSource(test, contents, source)),
        )
        .map(({ test }) => test)
        .sort();
}

async function runCapture(command: string, args: string[], cwd: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync(command, args, {
            cwd,
            encoding: 'utf8',
            maxBuffer: MAX_OUTPUT_BYTES,
        });
        return stdout;
    } catch (error) {
        const failure = error as ProcessFailure;
        const details = [failure.stdout, failure.stderr]
            .map((value) => value?.toString().trim())
            .filter(Boolean)
            .join('\n');
        throw new CheckError(details || failure.message);
    }
}

async function repositoryRoot(cwd: string): Promise<string> {
    return (await runCapture('git', ['rev-parse', '--show-toplevel'], cwd)).trim();
}

function parseNullSeparated(value: string): string[] {
    return value.split('\0').filter(Boolean);
}

async function discoverChangedFiles(root: string, staged: boolean): Promise<string[]> {
    const trackedArgs = staged
        ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--']
        : ['diff', 'HEAD', '--name-only', '-z', '--diff-filter=ACMR', '--'];
    const tracked = parseNullSeparated(await runCapture('git', trackedArgs, root));
    if (staged) return tracked;

    const untracked = parseNullSeparated(
        await runCapture('git', ['ls-files', '--others', '--exclude-standard', '-z', '--'], root),
    );
    return [...new Set([...tracked, ...untracked])].sort();
}

function repositoryRelativePath(root: string, cwd: string, input: string): string {
    const absolute = resolve(cwd, input);
    const result = relative(root, absolute);
    if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
        throw new CheckError(`File must be inside the repository: ${input}`, 2);
    }
    return result.split(sep).join('/');
}

async function existingFiles(root: string, files: string[]): Promise<string[]> {
    const results = await Promise.all(
        files.map(async (file) => {
            try {
                return (await lstat(join(root, file))).isFile() ? file : undefined;
            } catch {
                return undefined;
            }
        }),
    );
    return [...new Set(results.filter((file): file is string => Boolean(file)))].sort();
}

async function runTool(root: string, executable: string, args: string[]): Promise<void> {
    await runCapture(join(root, 'node_modules', '.bin', executable), args, root);
}

async function runLint(root: string, files: string[]): Promise<number> {
    const codeFiles = files.filter((file) => lintPipelineForFile(file) === 'code');
    const formatFiles = files.filter((file) => lintPipelineForFile(file) === 'format');

    if (codeFiles.length > 0) {
        await runTool(root, 'eslint', ['--fix', ...codeFiles]);
        await runTool(root, 'prettier', ['--write', ...codeFiles]);
    }
    if (formatFiles.length > 0) {
        await runTool(root, 'prettier', [
            '--write',
            '--no-error-on-unmatched-pattern',
            ...formatFiles,
        ]);
    }
    return codeFiles.length + formatFiles.length;
}

export async function selectedTestCandidates(root: string, files: string[]): Promise<string[]> {
    const candidates = [
        ...new Set([
            ...files.flatMap(testCandidatesForFile),
            ...(await directImportTestCandidates(root, files)),
        ]),
    ];
    return existingFiles(root, candidates);
}

async function runTests(root: string, files: string[]): Promise<number> {
    const tests = await selectedTestCandidates(root, files);
    if (tests.length > 0) {
        await runTool(root, 'vitest', ['run', '--silent=passed-only', ...tests]);
    }
    return tests.length;
}

async function runE2E(root: string, specs: string[], grep?: string): Promise<number> {
    /**
     * A focused Electron run must never exercise stale output. Capturing both successful commands
     * keeps the standard check result compact while runCapture still exposes complete failures.
     */
    await runCapture('bun', ['run', 'build'], root);
    await runTool(root, 'playwright', playwrightArguments(specs, grep));
    return specs.length;
}

async function main(): Promise<void> {
    const options = parseCheckArgs(process.argv.slice(2));
    const cwd = process.cwd();
    const root = await repositoryRoot(cwd);
    const requestedFiles =
        options.files.length > 0
            ? options.files.map((file) => repositoryRelativePath(root, cwd, file))
            : await discoverChangedFiles(root, options.staged);
    const files = await existingFiles(root, requestedFiles);
    const e2eSpecs = options.e2e ? selectE2ESpecs(files, options.files.length > 0) : [];
    const summaries: string[] = [];

    if (options.lint) summaries.push(`lint ${await runLint(root, files)}`);
    if (options.test) summaries.push(`tests ${await runTests(root, files)}`);
    if (options.type) {
        await runCapture('bun', ['run', 'typecheck'], root);
        summaries.push('typecheck');
    }
    if (options.knip) {
        await runTool(root, 'knip', []);
        summaries.push('knip');
    }
    if (options.e2e) {
        summaries.push(`e2e ${await runE2E(root, e2eSpecs, options.e2eGrep)}`);
    }

    console.log(`✓ check · ${files.length} changed · ${summaries.join(' · ')}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
    void main().catch((error: unknown) => {
        if (error instanceof CheckError) {
            const writer = error.exitCode === 0 ? console.log : console.error;
            writer(error.message);
            process.exitCode = error.exitCode;
            return;
        }
        console.error(error);
        process.exitCode = 1;
    });
}
