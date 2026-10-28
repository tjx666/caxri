import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { TYPE_AWARE_EXTENSIONS } from './changed-file-layers';

/**
 * Runs one repository tool binary against the checkout; `check.ts` passes its real runner and tests pass a fake.
 */
export type RunTool = (root: string, executable: string, arguments_: string[]) => Promise<void>;

export const CODE_EXTENSIONS = new Set([
    '.cjs',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.mts',
    '.ts',
    '.tsx',
]);
const FORMAT_EXTENSIONS = new Set([
    '.css',
    '.html',
    '.json',
    '.jsonc',
    '.md',
    '.toml',
    '.yaml',
    '.yml',
]);

export function lintPipelineForFile(file: string): 'code' | 'format' | undefined {
    const extension = extname(file).toLowerCase();
    if (CODE_EXTENSIONS.has(extension)) return 'code';
    if (FORMAT_EXTENSIONS.has(extension)) return 'format';
    return undefined;
}

export interface LintBuckets {
    codeFiles: string[];
    markdownFiles: string[];
    otherFormatFiles: string[];
}

/**
 * Splits changed files into the three pipelines this gate runs, so `.md` files match CI's tool ownership split:
 * markdownlint owns Markdown semantics, `bun fmt` owns formatting for every `FORMAT_EXTENSIONS` file (including `.md`),
 * and ESLint + `bun fmt` own `CODE_EXTENSIONS`. ESLint additionally lints the fenced code blocks of the Markdown bucket
 * (see `eslintTargets`).
 */
export function lintBucketsForFiles(files: string[]): LintBuckets {
    const codeFiles: string[] = [];
    const markdownFiles: string[] = [];
    const otherFormatFiles: string[] = [];

    for (const file of files) {
        const pipeline = lintPipelineForFile(file);
        if (pipeline === 'code') {
            codeFiles.push(file);
        } else if (pipeline === 'format') {
            if (extname(file).toLowerCase() === '.md') {
                markdownFiles.push(file);
            } else {
                otherFormatFiles.push(file);
            }
        }
    }

    return { codeFiles, markdownFiles, otherFormatFiles };
}

/**
 * The same cache the `lint` script writes. `runLint` lints every file twice (autofix, then the post-format
 * verification), and parallel Agent sessions re-run the check after each edit, so an uncached pass re-lints unchanged
 * files every time. The content strategy keys entries on file bytes rather than mtime, which a checkout or formatter
 * rewrite would otherwise invalidate.
 */
export const ESLINT_CACHE_ARGUMENTS = [
    '--cache',
    '--cache-strategy',
    'content',
    '--cache-location',
    '.cache/eslint/.eslintcache',
];

/**
 * Explicit changed-file lists can include intentionally ignored fixtures or vendored sources. ESLint must skip them
 * silently so one ignored file does not turn a valid focused check into a warning failure under the repository's
 * zero-warning policy.
 *
 * `--max-warnings=0` mirrors the `lint` script, because ESLint otherwise exits 0 on a warning: without it a focused
 * check reports a clean file that the CI gate then fails on, which is the one outcome this check exists to prevent.
 */
export function eslintArguments(files: string[]): string[] {
    return ['--fix', ...ESLINT_CACHE_ARGUMENTS, '--no-warn-ignored', '--max-warnings=0', ...files];
}

/**
 * Markdown belongs to the ESLint pass as well, not only to markdownlint and the formatter: `markdownProcessorConfig` in
 * `eslint.config.ts` turns fenced JS/TS blocks into virtual files, so a doc whose snippet breaks a lint rule fails the
 * repository-wide `lint` gate. Leaving `.md` out let a documentation change pass this focused check and then fail CI:
 * the one outcome the gate exists to prevent.
 */
export function eslintTargets({ codeFiles, markdownFiles }: LintBuckets): string[] {
    return [...codeFiles, ...markdownFiles];
}

/**
 * The repository formatter, as `bun run format` invokes it. `--no-config` keeps a Prettier config in a parent directory
 * of the checkout from switching `bun fmt` away from `bunfig.toml`; `--no-script` keeps it from running a package
 * script of the same name.
 */
export const FORMATTER_ARGUMENTS = ['fmt', '--no-config', '--no-script'];

export interface LintResult {
    fileCount: number;
    /**
     * Inputs whose bytes the autofix passes changed. A green summary hides them otherwise, so a fix applied after the
     * commit (for example after a hookless `git rebase --continue`) stays uncommitted while the branch is pushed.
     */
    autofixedFiles: string[];
}

async function readContent(root: string, file: string): Promise<string | undefined> {
    try {
        return await readFile(join(root, file), 'utf8');
    } catch {
        return undefined;
    }
}

export async function runLint(
    root: string,
    files: string[],
    run: RunTool,
    read = readContent,
): Promise<LintResult> {
    const before = await Promise.all(files.map((file) => read(root, file)));
    const fileCount = await runLintPasses(root, files, run);
    const after = await Promise.all(files.map((file) => read(root, file)));
    return {
        fileCount,
        autofixedFiles: files.filter((_file, index) => before[index] !== after[index]),
    };
}

async function runLintPasses(root: string, files: string[], run: RunTool): Promise<number> {
    const buckets = lintBucketsForFiles(files);
    const { codeFiles, markdownFiles, otherFormatFiles } = buckets;

    /**
     * Format code before ESLint: `caxri/jsdoc-format` wraps comments against their final indentation, so linting
     * unformatted code could wrap a comment for an indentation the formatter then changes.
     */
    if (codeFiles.length > 0) await run(root, 'bun', [...FORMATTER_ARGUMENTS, ...codeFiles]);
    const eslintFiles = eslintTargets(buckets);
    if (eslintFiles.length > 0) await run(root, 'eslint', eslintArguments(eslintFiles));
    if (codeFiles.length > 0) {
        // ESLint is syntactic-only in this repository; type-aware rules run through oxlint/tsgolint
        // (see .oxlintrc.json). Run it before the formatter so its autofixes get reformatted.
        const typeAwareFiles = codeFiles.filter((file) =>
            TYPE_AWARE_EXTENSIONS.has(extname(file).toLowerCase()),
        );
        if (typeAwareFiles.length > 0) {
            // --no-error-on-unmatched-pattern: every named file may fall inside .oxlintrc.json's
            // ignorePatterns (e.g. scripts/fixtures/eslint/**), which oxlint otherwise treats as
            // "no files found" and exits 1.
            await run(root, 'oxlint', [
                '-c',
                '.oxlintrc.json',
                '--type-aware',
                '--fix',
                '--no-error-on-unmatched-pattern',
                ...typeAwareFiles,
            ]);
        }
        await run(root, 'bun', [...FORMATTER_ARGUMENTS, ...codeFiles]);
    }
    if (markdownFiles.length > 0) {
        // markdownlint owns Markdown semantics; run its autofix before the formatter reformats the
        // same files, since a semantic fix (e.g. wrapping a bare URL) can change line width that
        // the formatter still needs to reflow.
        await run(root, 'markdownlint-cli2', ['--fix', ...markdownFiles]);
    }
    if (markdownFiles.length > 0 || otherFormatFiles.length > 0) {
        await run(root, 'bun', [...FORMATTER_ARGUMENTS, ...markdownFiles, ...otherFormatFiles]);
    }
    /**
     * Formatting can expand a previously valid file past max-lines. Validate the final bytes, not only the pre-format
     * source, so a successful check agrees with the commit gate.
     */
    if (eslintFiles.length > 0)
        await run(root, 'eslint', [
            ...ESLINT_CACHE_ARGUMENTS,
            '--no-warn-ignored',
            '--max-warnings=0',
            ...eslintFiles,
        ]);
    return codeFiles.length + markdownFiles.length + otherFormatFiles.length;
}
