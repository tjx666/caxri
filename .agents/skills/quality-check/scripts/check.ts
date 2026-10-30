import type { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { INSTALL_MISMATCH_HINT, verifyBuildReceipt } from '../../../../scripts/build-receipt';
import { affectedTestArguments } from '../../../../scripts/run-ci-unit-tests';
import {
    acquireDesktopLease,
    DesktopLeaseBusyError,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../../switch-worktree/scripts/desktop-lease';
import { CommandError } from '../../switch-worktree/scripts/process';
import { runChangedFileGuardrails } from './changed-file-guardrails';
import type { DirtyLayer } from './changed-file-layers';
import { dirtyLayerReportForFiles } from './changed-file-layers';
import { CheckError, MAX_E2E_WAIT_SECONDS, parseCheckArguments } from './check-arguments';
import { contractTestCandidates } from './contract-test-candidates';
import { shouldRunKnip, shouldTypecheck } from './default-gates';
import { lintDirectorySiblings } from './directory-siblings';
import { assertExplicitFiles } from './explicit-files';
import { CODE_EXTENSIONS, lintBucketsForFiles, runLint } from './lint-passes';
import { reportStaleLocaleCopy } from './locale-e2e-assertions';
import {
    directImportTestCandidates,
    githubConfigReaderTestCandidates,
    relatedE2ESpecs,
    TEST_EXTENSIONS,
    walkVitestTestFiles,
} from './source-imports';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

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

interface ProcessFailure extends Error {
    stderr?: Buffer | string;
    stdout?: Buffer | string;
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
    return ['test', ...specs, ...(grep ? ['-g', grep] : [])];
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

/**
 * Lists changed paths, reporting a rename as its removed source plus its added destination (`--no-renames`). Rename
 * detection would otherwise hide the old path, and the old path is what a stale path-string reference still names.
 */
export async function discoverChangedFiles(root: string, isStaged: boolean): Promise<string[]> {
    const trackedArguments = isStaged
        ? ['diff', '--cached', '--no-renames', '--name-only', '-z', '--diff-filter=ACMRD', '--']
        : [
              'diff',
              (await runCapture('git', ['merge-base', 'origin/main', 'HEAD'], root)).trim(),
              '--no-renames',
              '--name-only',
              '-z',
              '--diff-filter=ACMRD',
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
    const command =
        executable === 'bun' ? process.execPath : join(root, 'node_modules', '.bin', executable);
    await runCapture(command, arguments_, root, environment);
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

export async function selectedTestCandidates(
    root: string,
    files: string[],
    removedFiles: readonly string[] = [],
): Promise<string[]> {
    const candidates = [
        ...new Set([
            ...files.flatMap(testCandidatesForFile),
            ...(await directImportTestCandidates(root, files)),
            ...(await skillContractTestCandidates(root, files)),
            ...(await githubConfigReaderTestCandidates(root, files)),
            ...contractTestCandidates(files, removedFiles),
        ]),
    ];
    return existingFiles(root, candidates);
}

async function runTests(
    root: string,
    files: string[],
    removedFiles: readonly string[],
): Promise<number> {
    const tests = await selectedTestCandidates(root, files, removedFiles);
    if (tests.length > 0) {
        await runTool(root, 'vitest', ['run', '--silent=passed-only', ...tests]);
    }
    return tests.length;
}

/**
 * `--test` selects only direct importers, so a test reaching a change through another module stays unrun. This reuses
 * the hosted `affected` scope's argv so the local run and CI select the same suites. Passing paths as argv also
 * replaces the hand-written `vitest related $files` an agent used to compose, which zsh never word-splits.
 */
async function runRelatedTests(root: string, files: string[]): Promise<number> {
    const related = affectedTestArguments(files);
    if (!related) return 0;
    await runTool(root, 'vitest', related.slice(1));
    return files.filter((file) => CODE_EXTENSIONS.has(extname(file))).length;
}

/**
 * Turns a failed desktop lease acquisition into the check's own error. A busy lease without `--e2e-wait` also names
 * that option: the error is all an Agent reads at that moment, and without the hint it writes a shell retry loop whose
 * own matching can miss the failure. A bounded wait that ran out arrives as a plain `CommandError`, so it gets no
 * hint.
 */
export function checkErrorForDesktopLease(error: unknown): unknown {
    if (error instanceof DesktopLeaseBusyError)
        return new CheckError(
            `${error.message}\nTo wait for it to finish, rerun with --e2e-wait <seconds> (1-${MAX_E2E_WAIT_SECONDS}) ` +
                'instead of retrying in a shell loop.',
            error.exitCode,
        );
    if (error instanceof CommandError) return new CheckError(error.message, error.exitCode);
    return error;
}

async function runE2E(
    root: string,
    specs: string[],
    grep?: string,
    waitSeconds = 0,
): Promise<string> {
    /**
     * A focused Electron run must never exercise stale output, and it rebuilds only when the build receipt no longer
     * matches the current inputs and output trees (`scripts/build-receipt.ts`). Capturing both successful commands
     * keeps the standard check result compact while runCapture still exposes complete failures.
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
            throw checkErrorForDesktopLease(error);
        }
    }
    const environment = {
        ...process.env,
        CAXRI_DESKTOP_COORDINATOR_TOKEN: parentToken ?? lease!.token,
    };
    try {
        // Checked under the lease, so no sibling `check --e2e` in this worktree rewrites the output between the receipt
        // check and the Playwright launch.
        const receipt = await verifyBuildReceipt(root, { purpose: 'reuse' });
        // A build would succeed yet record no receipt, so every launch would still refuse it as stale.
        if (!receipt.isValid && receipt.reason === 'install-mismatch')
            throw new CheckError(INSTALL_MISMATCH_HINT);
        if (!receipt.isValid) await runCapture('bun', ['run', 'build'], root, environment);
        await runTool(root, 'playwright', playwrightArguments(specs, grep), environment);
        return receipt.isValid ? `${specs.length} (build reused)` : `${specs.length}`;
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
    if (options.files.length > 0) {
        await assertExplicitFiles(
            root,
            options.files.map((argument, index) => ({ argument, path: requestedFiles[index] })),
            (arguments_) => runCapture('git', arguments_, root),
        );
    }
    const files = await existingFiles(root, requestedFiles);
    const removedFiles = requestedFiles.filter((file) => !files.includes(file));
    const e2eSpecs = options.e2e ? selectE2ESpecs(files, options.files.length > 0) : [];
    const summaries: string[] = [];

    if (options.lint) {
        const { fileCount, autofixedFiles } = await runLint(root, files, runTool);
        summaries.push(`lint ${fileCount}`);
        const siblingCount = await lintDirectorySiblings({
            base: options.isStaged
                ? 'HEAD'
                : (await runCapture('git', ['merge-base', 'origin/main', 'HEAD'], root)).trim(),
            files,
            removedFiles,
            root,
            capture: runCapture,
            run: runTool,
        });
        if (siblingCount > 0) summaries.push(`directory siblings ${siblingCount}`);
        if (autofixedFiles.length > 0) summaries.push(`autofixed ${autofixedFiles.join(', ')}`);
        const { codeFiles, markdownFiles } = lintBucketsForFiles(files);
        summaries.push(
            ...(await runChangedFileGuardrails({
                hasChangedMarkdown: markdownFiles.length > 0,
                hasChangedSourceCode: codeFiles.length > 0,
                root,
                runCapture,
            })),
        );
    }
    if (options.test) summaries.push(`tests ${await runTests(root, files, removedFiles)}`);
    if (options.related) summaries.push(`related sources ${await runRelatedTests(root, files)}`);
    if (shouldTypecheck(options, requestedFiles)) {
        await runCapture('bun', ['run', 'typecheck'], root);
        summaries.push('typecheck');
    }
    if (shouldRunKnip(options, requestedFiles)) {
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
    await reportStaleLocaleCopy(root, files, options.isStaged);
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
