import type { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
    acquireDesktopLease,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../../switch-worktree/scripts/desktop-lease';
import { CommandError } from '../../switch-worktree/scripts/process';
import {
    directImportTestCandidates,
    relatedE2ESpecs,
    TEST_EXTENSIONS,
    walkVitestTestFiles,
} from './source-imports';

export {
    directImportTestCandidates,
    hasDirectSourceImport,
    IMPORT_PATH_ALIASES,
    relatedE2ESpecs,
    VITEST_SOURCE_ROOTS,
} from './source-imports';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const CODE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
/**
 * Type-aware linting (oxlint + tsgolint) only understands files that belong to a TypeScript program; plain JS files
 * stay on the syntactic ESLint pipeline alone.
 */
const TYPE_AWARE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const FORMAT_EXTENSIONS = new Set(['.css', '.html', '.json', '.jsonc', '.md', '.yaml', '.yml']);

export interface CheckOptions {
    e2e: boolean;
    e2eGrep?: string;
    e2eWaitSeconds?: number;
    files: string[];
    isStaged: boolean;
    knip: boolean;
    lint: boolean;
    test: boolean;
    type: boolean;
}

export type DirtyLayer =
    | 'Renderer'
    | 'Main'
    | 'Preload'
    | 'Server Core'
    | 'Domains'
    | 'Server'
    | 'Mobile'
    | 'System'
    | 'IPC'
    | 'Shared'
    | 'Mobile Transport'
    | 'CLI'
    | 'e2e'
    | 'skills'
    | 'tooling'
    | 'docs'
    | 'other';

export interface DirtyLayerReport {
    layers: DirtyLayer[];
    suggestedGates: string[];
}

const PROTECTED_E2E_GATES = new Map([
    ['e2e/real-agent-smoke.e2e.ts', 'bun run test:e2e:real-agent'],
    ['e2e/failure-isolation.e2e.ts', 'bun run scripts/run-e2e-failure-isolation.ts'],
]);

const DIRTY_LAYER_ORDER: DirtyLayer[] = [
    'Renderer',
    'Main',
    'Preload',
    'Server Core',
    'Domains',
    'Server',
    'Mobile',
    'System',
    'IPC',
    'Shared',
    'Mobile Transport',
    'CLI',
    'e2e',
    'skills',
    'tooling',
    'docs',
    'other',
];

function dirtyLayerForFile(file: string): DirtyLayer {
    const normalized = file.replaceAll('\\', '/');
    if (normalized.startsWith('apps/desktop/src/renderer/')) return 'Renderer';
    if (normalized.startsWith('apps/desktop/src/main/')) return 'Main';
    if (normalized.startsWith('apps/desktop/src/preload/')) return 'Preload';
    if (normalized.startsWith('apps/server/src/core/')) return 'Server Core';
    if (normalized.startsWith('apps/server/src/domains/')) return 'Domains';
    if (normalized.startsWith('apps/server/')) return 'Server';
    if (normalized.startsWith('apps/mobile/')) return 'Mobile';
    if (normalized.startsWith('apps/cli/')) return 'CLI';
    if (normalized.startsWith('packages/system/')) return 'System';
    if (normalized.startsWith('packages/protocol/')) return 'IPC';
    if (normalized.startsWith('packages/utils/')) return 'Shared';
    if (normalized.startsWith('packages/mobile-transport/')) return 'Mobile Transport';
    if (
        normalized.startsWith('packages/agent-skills/') ||
        normalized.startsWith('packages/client/') ||
        normalized.startsWith('packages/extension-api/')
    )
        return 'Shared';
    if (normalized.startsWith('e2e/')) return 'e2e';
    if (normalized.startsWith('.agents/skills/')) return 'skills';
    if (
        normalized.startsWith('.github/') ||
        normalized.startsWith('build/') ||
        normalized.startsWith('scripts/')
    )
        return 'tooling';
    if (normalized.startsWith('docs/') || extname(normalized).toLowerCase() === '.md')
        return 'docs';
    return 'other';
}

/**
 * Reports affected ownership layers and follow-up gates without executing the suggested gates.
 */
export function dirtyLayerReportForFiles(
    files: string[],
    hasExplicitFiles: boolean,
): DirtyLayerReport {
    const dirtyLayers = new Set(files.map(dirtyLayerForFile));
    const layers = DIRTY_LAYER_ORDER.filter((layer) => dirtyLayers.has(layer));
    const suggestedGates: string[] = [];
    /**
     * React Doctor is not limited to the Renderer. CI runs it over every changed TypeScript file, and rules such as
     * `js-combine-iterations` are plain JavaScript performance rules that a Server-only change trips just as easily.
     * Routing this gate by layer let a Domains change pass the focused check and then stop full platform checks — the
     * one outcome this check exists to prevent.
     */
    if (files.some((file) => TYPE_AWARE_EXTENSIONS.has(extname(file))))
        suggestedGates.push('bun run doctor:changed');
    if (
        dirtyLayers.has('Renderer') ||
        dirtyLayers.has('IPC') ||
        dirtyLayers.has('Shared') ||
        dirtyLayers.has('System') ||
        dirtyLayers.has('Mobile') ||
        dirtyLayers.has('Mobile Transport')
    )
        suggestedGates.push('bun run knip');
    if (hasExplicitFiles) {
        const e2eSpecs = files.filter((file) => /^e2e\/.+\.e2e\.ts$/.test(file));
        if (e2eSpecs.some((file) => !PROTECTED_E2E_GATES.has(file))) suggestedGates.push('--e2e');
        for (const [file, gate] of PROTECTED_E2E_GATES) {
            if (e2eSpecs.includes(file)) suggestedGates.push(gate);
        }
    }
    return { layers, suggestedGates };
}

export function formatCheckSummary(input: {
    changedFileCount: number;
    dirtyLayers: DirtyLayer[];
    executedChecks: string[];
    suggestedGates: string[];
}): string {
    const dirtyLayers = input.dirtyLayers.length > 0 ? input.dirtyLayers.join(', ') : 'none';
    const suggestedGates =
        input.suggestedGates.length > 0 ? input.suggestedGates.join(', ') : 'none';
    const executedChecks =
        input.executedChecks.length > 0 ? input.executedChecks.join(' · ') : 'none';
    return `✓ check · ${input.changedFileCount} changed · dirty layers ${dirtyLayers} · suggested gates ${suggestedGates} · ran ${executedChecks}`;
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

const usage = `Usage: bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--e2e] [--e2e-grep <pattern>] [--e2e-wait <seconds>] [--staged]

Selectors:
  --lint     Autofix supported changed files with ESLint and Prettier
  --test     Run changed tests and colocated tests for changed source files
  --type     Run the repository-wide TypeScript check
  --knip     Run the repository-wide dead code/export check (CI blocking)
  --e2e      Build and run explicitly named e2e/*.e2e.ts Playwright specs
  --e2e-grep Narrow --e2e to a Playwright test-title pattern
  --e2e-wait Wait up to 300 seconds for the repository desktop lease (default: fail immediately)
  --staged   Discover only staged files when no file arguments are supplied

With no selector, --lint and --test are enabled.`;

/**
 * Applies a single CLI argument to `options` and reports whether the following argument in `arguments_` was consumed as
 * its value (e.g. `--e2e-grep <pattern>`). Extracted out of the parsing loop so the `switch` cases can `return` instead
 * of nesting `break` inside a loop.
 */
function didConsumeNextCheckArgument(
    argument: string,
    nextArgument: string | undefined,
    options: CheckOptions,
): boolean {
    switch (argument) {
        case '--help':
        case '-h':
            throw new CheckError(usage, 0);
        case '--knip':
            options.knip = true;
            return false;
        case '--e2e':
            options.e2e = true;
            return false;
        case '--e2e-grep': {
            if (!nextArgument || nextArgument.startsWith('--')) {
                throw new CheckError('--e2e-grep requires a test-title pattern', 2);
            }
            options.e2eGrep = nextArgument;
            return true;
        }
        case '--e2e-wait': {
            const seconds = Number(nextArgument);
            if (!nextArgument || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300)
                throw new CheckError('--e2e-wait requires an integer from 1 to 300 seconds', 2);
            options.e2eWaitSeconds = seconds;
            return true;
        }
        case '--lint':
            options.lint = true;
            return false;
        case '--staged':
            options.isStaged = true;
            return false;
        case '--test':
            options.test = true;
            return false;
        case '--type':
            options.type = true;
            return false;
        default:
            if (argument.startsWith('-')) {
                throw new CheckError(`Unknown option: ${argument}\n\n${usage}`, 2);
            }
            options.files.push(argument);
            return false;
    }
}

export function parseCheckArguments(arguments_: string[]): CheckOptions {
    const options: CheckOptions = {
        e2e: false,
        e2eGrep: undefined,
        e2eWaitSeconds: undefined,
        files: [],
        isStaged: false,
        knip: false,
        lint: false,
        test: false,
        type: false,
    };

    for (let index = 0; index < arguments_.length; index += 1) {
        const isConsumedNext = didConsumeNextCheckArgument(
            arguments_[index],
            arguments_[index + 1],
            options,
        );
        if (isConsumedNext) index += 1;
    }

    if (options.e2eGrep && !options.e2e) {
        throw new CheckError('--e2e-grep requires --e2e', 2);
    }
    if (options.e2eWaitSeconds && !options.e2e)
        throw new CheckError('--e2e-wait requires --e2e', 2);

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

export interface LintBuckets {
    codeFiles: string[];
    markdownFiles: string[];
    otherFormatFiles: string[];
}

const SKILL_INVOCATION_CONTRACT_TEST = 'scripts/__tests__/skill-invocation.test.ts';
const PROJECT_HOOK_CONTRACT_TEST = '.agents/skills/acceptance/scripts/project-hook.test.ts';
/**
 * The product skill is embedded into `@caxri/agent-skills` as a generated bundle; this test fails when
 * `skills/caxri-cli/**` changes without regenerating that bundle.
 */
const BUNDLED_SKILL_CONTRACT_TEST = 'apps/cli/src/__tests__/skills.integration.test.ts';
/**
 * Validates the product skill's command examples and inline command mentions against the CLI registry; the CLI build
 * runs the same validator, so without this route a stale mention would surface only in CI.
 */
const SKILL_COMMAND_CONTRACT_TEST = 'apps/cli/scripts/validate-skill.test.ts';

function repoHarnessTestCandidates(file: string): string[] {
    const candidates: string[] = [];
    const isSkillContractPath =
        /^(?:\.agents|\.claude)\/skills\/[^/]+\/SKILL\.md$/u.test(file) ||
        /^(?:\.agents|\.claude)\/skills\/[^/]+\/agents\/[^/]+\.ya?ml$/u.test(file);
    if (
        file === 'AGENTS.md' ||
        file === 'CLAUDE.md' ||
        file === '.agents/invocation.md' ||
        file === '.claude/skills' ||
        isSkillContractPath
    ) {
        candidates.push(SKILL_INVOCATION_CONTRACT_TEST);
    }
    if (
        file === '.claude/settings.json' ||
        file === '.codex/hooks.json' ||
        file.startsWith('.agents/acceptance/')
    ) {
        candidates.push(PROJECT_HOOK_CONTRACT_TEST);
    }
    if (file.startsWith('skills/caxri-cli/'))
        candidates.push(BUNDLED_SKILL_CONTRACT_TEST, SKILL_COMMAND_CONTRACT_TEST);
    return candidates;
}

/**
 * Splits changed files into the three pipelines this gate runs, so `.md` files match CI's tool ownership split:
 * markdownlint owns Markdown semantics, Prettier owns formatting for every `FORMAT_EXTENSIONS` file (including `.md`),
 * and ESLint + Prettier own `CODE_EXTENSIONS`. ESLint additionally lints the fenced code blocks of the Markdown bucket
 * — see `eslintTargets`.
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

export function testCandidatesForFile(file: string): string[] {
    const normalized = file.replaceAll('\\', '/');
    if (/\.test\.(?:cts|mts|ts|tsx)$/.test(normalized)) return [normalized];
    const harnessCandidates = repoHarnessTestCandidates(normalized);

    const extension = TEST_EXTENSIONS.find((candidate) => normalized.endsWith(candidate));
    if (!extension || normalized.endsWith('.d.ts')) return harnessCandidates;

    const directory = posix.dirname(normalized);
    const stem = posix.basename(normalized, extension);
    const candidates = TEST_EXTENSIONS.flatMap((testExtension) => [
        posix.join(directory, `${stem}.test${testExtension}`),
        posix.join(directory, '__tests__', `${stem}.test${testExtension}`),
        posix.join(directory, `${stem}.integration.test${testExtension}`),
        posix.join(directory, '__tests__', `${stem}.integration.test${testExtension}`),
    ]);

    /**
     * Domain-level integration suites are named after their owning subdirectory rather than an individual source stem
     * (e.g. `apps/server/src/domains/db/*.ts` -> `db.integration.test.ts`). Applying this at the top level would match
     * broad, expensive suites for nearly every source file.
     */
    const directorySegments = directory.split('/').filter(Boolean);
    const sourceRootIndex = directorySegments.lastIndexOf('src');
    if (sourceRootIndex !== -1 && directorySegments.length - sourceRootIndex - 1 >= 2) {
        const domain = directorySegments.at(-1);
        candidates.push(
            ...TEST_EXTENSIONS.flatMap((testExtension) => [
                posix.join(directory, `${domain}.integration.test${testExtension}`),
                posix.join(directory, '__tests__', `${domain}.integration.test${testExtension}`),
            ]),
        );
    }

    return [...new Set([...harnessCandidates, ...candidates])];
}

async function runCapture(
    command: string,
    arguments_: string[],
    cwd: string,
    environment?: NodeJS.ProcessEnv,
): Promise<string> {
    try {
        const { stdout } = await execFileAsync(command, arguments_, {
            cwd,
            encoding: 'utf8',
            maxBuffer: MAX_OUTPUT_BYTES,
            ...(environment && { env: environment }),
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

async function repoRoot(cwd: string): Promise<string> {
    return (await runCapture('git', ['rev-parse', '--show-toplevel'], cwd)).trim();
}

function parseNullSeparated(value: string): string[] {
    return value.split('\0').filter(Boolean);
}

export async function discoverChangedFiles(root: string, isStaged: boolean): Promise<string[]> {
    const trackedArguments = isStaged
        ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--']
        : [
              'diff',
              (await runCapture('git', ['merge-base', 'origin/main', 'HEAD'], root)).trim(),
              '--name-only',
              '-z',
              '--diff-filter=ACMR',
              '--',
          ];
    const tracked = parseNullSeparated(await runCapture('git', trackedArguments, root));
    if (isStaged) return tracked;

    const untracked = parseNullSeparated(
        await runCapture('git', ['ls-files', '--others', '--exclude-standard', '-z', '--'], root),
    );
    return [...new Set([...tracked, ...untracked])].toSorted((a, b) => a.localeCompare(b));
}

function repoRelativePath(root: string, cwd: string, input: string): string {
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
                return;
            }
        }),
    );
    return [...new Set(results.filter((file): file is string => Boolean(file)))].toSorted((a, b) =>
        a.localeCompare(b),
    );
}

async function runTool(
    root: string,
    executable: string,
    arguments_: string[],
    environment?: NodeJS.ProcessEnv,
): Promise<void> {
    await runCapture(join(root, 'node_modules', '.bin', executable), arguments_, root, environment);
}

/**
 * Explicit changed-file lists can include intentionally ignored fixtures or vendored sources. ESLint must skip them
 * silently so one ignored file does not turn a valid focused check into a warning failure under the repository's
 * zero-warning policy.
 *
 * `--max-warnings=0` mirrors the `lint` script, because ESLint otherwise exits 0 on a warning: without it a focused
 * check reports a clean file that the CI gate then fails on, which is the one outcome this check exists to prevent.
 */
export function eslintArguments(files: string[]): string[] {
    return ['--fix', '--no-warn-ignored', '--max-warnings=0', ...files];
}

/**
 * Markdown belongs to the ESLint pass as well, not only to markdownlint and Prettier: `markdownProcessorConfig` in
 * `eslint.config.ts` turns fenced JS/TS blocks into virtual files, so a doc whose snippet breaks a lint rule fails the
 * repository-wide `lint` gate. Leaving `.md` out let a documentation change pass this focused check and then fail CI —
 * the one outcome the gate exists to prevent.
 */
export function eslintTargets({ codeFiles, markdownFiles }: LintBuckets): string[] {
    return [...codeFiles, ...markdownFiles];
}

export async function runLint(root: string, files: string[], run = runTool): Promise<number> {
    const buckets = lintBucketsForFiles(files);
    const { codeFiles, markdownFiles, otherFormatFiles } = buckets;

    const eslintFiles = eslintTargets(buckets);
    if (eslintFiles.length > 0) await run(root, 'eslint', eslintArguments(eslintFiles));
    if (codeFiles.length > 0) {
        // ESLint is syntactic-only in this repository; type-aware rules run through oxlint/tsgolint
        // (see .oxlintrc.json). Run it before Prettier so its autofixes get reformatted.
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
        await run(root, 'prettier', ['--write', ...codeFiles]);
    }
    if (markdownFiles.length > 0) {
        // markdownlint owns Markdown semantics; run its autofix before Prettier reformats the
        // same files, since a semantic fix (e.g. wrapping a bare URL) can change line width that
        // Prettier still needs to reflow.
        await run(root, 'markdownlint-cli2', ['--fix', ...markdownFiles]);
    }
    if (markdownFiles.length > 0 || otherFormatFiles.length > 0) {
        await run(root, 'prettier', [
            '--write',
            '--no-error-on-unmatched-pattern',
            ...markdownFiles,
            ...otherFormatFiles,
        ]);
    }
    /**
     * Formatting can expand a previously valid file past max-lines. Validate the final bytes, not only the pre-format
     * source, so a successful check agrees with the commit gate.
     */
    if (eslintFiles.length > 0)
        await run(root, 'eslint', ['--no-warn-ignored', '--max-warnings=0', ...eslintFiles]);
    return codeFiles.length + markdownFiles.length + otherFormatFiles.length;
}

/**
 * A skill's own tests read its `SKILL.md` as a string and assert the wording of the contracts it publishes, so editing
 * the document breaks them exactly the way editing source breaks a unit test. Import discovery cannot see that
 * dependency: the test reads the file at runtime rather than importing it. Without this route a skill edit reaches CI
 * having run only the repository-wide invocation contract, which is what let a reworded `e2e-testing` procedure pass
 * the focused check and then stop full platform checks.
 */
async function skillContractTestCandidates(root: string, files: string[]): Promise<string[]> {
    const directories = new Set(
        files.flatMap((file) => {
            const match = /^((?:\.agents|\.claude)\/skills\/[^/]+)\/SKILL\.md$/u.exec(
                file.replaceAll('\\', '/'),
            );
            return match ? [match[1]] : [];
        }),
    );
    if (directories.size === 0) return [];
    const nested = await Promise.all(
        [...directories].map((directory) => walkVitestTestFiles(root, directory)),
    );
    return nested.flat();
}

/**
 * Renderer contracts scan source files at runtime, so import-based test discovery cannot find them.
 */
function rendererContractTestCandidates(files: string[]): string[] {
    if (
        files.every((file) => !file.replaceAll('\\', '/').startsWith('apps/desktop/src/renderer/'))
    ) {
        return [];
    }
    return [
        'apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts',
        'apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts',
    ];
}

export async function selectedTestCandidates(root: string, files: string[]): Promise<string[]> {
    const candidates = [
        ...new Set([
            ...files.flatMap(testCandidatesForFile),
            ...(await directImportTestCandidates(root, files)),
            ...(await skillContractTestCandidates(root, files)),
            ...rendererContractTestCandidates(files),
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

async function runE2E(
    root: string,
    specs: string[],
    grep?: string,
    waitSeconds = 0,
): Promise<number> {
    /**
     * A focused Electron run must never exercise stale output. Capturing both successful commands keeps the standard
     * check result compact while runCapture still exposes complete failures.
     */
    const parentToken = process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN;
    if (parentToken) {
        const coordinator = await inspectDesktopLease(root);
        if (
            coordinator.state !== 'active' ||
            coordinator.lease.token !== parentToken ||
            coordinator.lease.worktreePath !== root
        )
            throw new CheckError('The inherited desktop coordinator is no longer active');
    }
    let lease: Awaited<ReturnType<typeof acquireDesktopLease>> | undefined;
    if (!parentToken) {
        try {
            lease = await acquireDesktopLease(root, 'check --e2e', process.pid, {
                waitMs: waitSeconds * 1000,
            });
        } catch (error) {
            if (error instanceof CommandError) throw new CheckError(error.message, error.exitCode);
            throw error;
        }
    }
    const environment = {
        ...process.env,
        CAXRI_DESKTOP_COORDINATOR_TOKEN: parentToken ?? lease!.token,
    };
    try {
        await runCapture('bun', ['run', 'build'], root, environment);
        await runTool(root, 'playwright', playwrightArguments(specs, grep), environment);
        return specs.length;
    } finally {
        if (lease) await releaseDesktopLease(lease);
    }
}

async function main(): Promise<void> {
    const options = parseCheckArguments(process.argv.slice(2));
    const cwd = process.cwd();
    const root = await repoRoot(cwd);
    const requestedFiles =
        options.files.length > 0
            ? options.files.map((file) => repoRelativePath(root, cwd, file))
            : await discoverChangedFiles(root, options.isStaged);
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
        summaries.push(
            `e2e ${await runE2E(root, e2eSpecs, options.e2eGrep, options.e2eWaitSeconds)}`,
        );
    }

    const dirtyLayerReport = dirtyLayerReportForFiles(files, options.files.length > 0);
    const consumerE2ESpecs = await relatedE2ESpecs(root, files);
    console.log(
        formatCheckSummary({
            changedFileCount: files.length,
            dirtyLayers: dirtyLayerReport.layers,
            executedChecks: summaries,
            suggestedGates: dirtyLayerReport.suggestedGates,
        }),
    );
    if (consumerE2ESpecs.length > 0)
        console.log(`Related E2E specs (run explicitly): ${consumerE2ESpecs.join(', ')}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
    try {
        await main();
    } catch (error) {
        if (error instanceof CheckError) {
            const writer = error.exitCode === 0 ? console.log : console.error;
            writer(error.message);
            process.exitCode = error.exitCode;
        } else {
            console.error(error);
            process.exitCode = 1;
        }
    }
}
