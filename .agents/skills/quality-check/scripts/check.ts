import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const FORMAT_EXTENSIONS = new Set(['.css', '.html', '.json', '.jsonc', '.md', '.yaml', '.yml']);
const TEST_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

export interface CheckOptions {
    files: string[];
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

const usage = `Usage: bun run check [files...] [--lint] [--test] [--type] [--staged]

Selectors:
  --lint     Autofix supported changed files with ESLint and Prettier
  --test     Run changed tests and colocated tests for changed source files
  --type     Run the repository-wide TypeScript check
  --staged   Discover only staged files when no file arguments are supplied

With no selector, --lint and --test are enabled.`;

export function parseCheckArgs(args: string[]): CheckOptions {
    const options: CheckOptions = {
        files: [],
        lint: false,
        staged: false,
        test: false,
        type: false,
    };

    for (const arg of args) {
        switch (arg) {
            case '--help':
            case '-h':
                throw new CheckError(usage, 0);
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

    if (!options.lint && !options.test && !options.type) {
        options.lint = true;
        options.test = true;
    }

    return options;
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
    return TEST_EXTENSIONS.flatMap((testExtension) => [
        posix.join(directory, `${stem}.test${testExtension}`),
        posix.join(directory, '__tests__', `${stem}.test${testExtension}`),
    ]);
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

async function runTests(root: string, files: string[]): Promise<number> {
    const candidates = [...new Set(files.flatMap(testCandidatesForFile))];
    const tests = await existingFiles(root, candidates);
    if (tests.length > 0) {
        await runTool(root, 'vitest', ['run', '--silent=passed-only', ...tests]);
    }
    return tests.length;
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
    const summaries: string[] = [];

    if (options.lint) summaries.push(`lint ${await runLint(root, files)}`);
    if (options.test) summaries.push(`tests ${await runTests(root, files)}`);
    if (options.type) {
        await runCapture('bun', ['run', 'typecheck'], root);
        summaries.push('typecheck');
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
