#!/usr/bin/env bun

/**
 * Runs gitleaks against this repository with `.gitleaks.toml`, in one of three modes:
 *
 * - `--staged` (pre-commit hook): scans the Git index, the same diff a commit is about to create.
 * - Default, `GITLEAKS_BASE_REVISION`/`GITLEAKS_HEAD_REVISION` set (all push and pull-request CI checks): scans only the
 *   commits the triggering push or pull request actually introduced.
 * - Default, manual CI dispatch (`GITHUB_EVENT_NAME=workflow_dispatch`) with no base revision: scans the commits the
 *   dispatched ref adds beyond `origin/main`, as a pull request would. The optimized `e2e` job's checks checkout has no
 *   `origin/main`, so it passes its verified base revision instead (`scripts/ci-child-environment.ts`).
 * - Default, no base revision outside a dispatch (a bare local invocation): scans the entire commit history as an
 *   intentional audit. History is never rewritten, so that audit still reports the identifying values earlier commits
 *   carry (see `.gitleaks.toml`) and cannot gate CI.
 */

import { resolve } from 'node:path';
import process from 'node:process';

import { runChildProcess } from './exec';
import { resolveGitleaksBinary } from './prepare-gitleaks';

const projectRoot = resolve(import.meta.dirname, '..');
const ALL_ZERO_REVISION = '0000000000000000000000000000000000000000';
const DISPATCH_BASE_REVISION = 'origin/main';

/**
 * The base revision to scan from. A manual dispatch carries no push or pull-request base, and treating that as a
 * full-history audit failed every `hosted-full` run on historical findings before E2E could start (#3293), so it scans
 * from `origin/main` instead. A dispatch on `main` itself then scans no commits, which the push run already did.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export function resolveGitleaksBaseRevision(
    baseRevision: string | undefined,
    eventName: string | undefined,
): string | undefined {
    if (baseRevision?.trim()) return baseRevision;
    return eventName === 'workflow_dispatch' ? DISPATCH_BASE_REVISION : undefined;
}

/**
 * Resolves the `--log-opts` git-log range gitleaks should scan. A PR or push carries a real base revision; the very
 * first push to a branch reports the all-zero sentinel SHA (not a resolvable commit), and a manual dispatch on `main`
 * may carry no base boundary at all. Both fall back to `undefined`, which omits `--log-opts` and scans the full history
 * instead of failing the job or silently narrowing the scan to nothing.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export function gitleaksLogOptions(
    baseRevision: string | undefined,
    headRevision: string,
): string | undefined {
    const base = baseRevision?.trim();
    if (!base || base === ALL_ZERO_REVISION || base === headRevision) return undefined;
    return `${base}..${headRevision}`;
}

/**
 * Verifies an explicit revision range before handing it to gitleaks. Gitleaks 8.30.1 logs Git's invalid-range error but
 * still exits successfully after scanning zero commits, so the wrapper must fail closed on Git's own result.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export async function isGitleaksRevisionRangeValid(
    repoRoot: string,
    logOptions: string | undefined,
    run: typeof runChildProcess = runChildProcess,
): Promise<boolean> {
    if (!logOptions) return true;
    const result = await run('git', ['rev-list', '--max-count=0', logOptions, '--'], {
        cwd: repoRoot,
        stdio: 'ignore',
    });
    return result === 0;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export interface GitleaksScanArguments {
    binaryPath: string;
    configPath: string;
    logOptions?: string;
    repoRoot: string;
    staged: boolean;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export interface GitleaksScanOptions {
    baseRevision?: string;
    cacheRoot: string;
    headRevision: string;
    repoRoot: string;
    staged: boolean;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export interface GitleaksScanDependencies {
    resolveBinary?: typeof resolveGitleaksBinary;
    run?: typeof runChildProcess;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export type GitleaksScanResult =
    | { exitCode: 0; status: 'passed' }
    | { exitCode: 1; status: 'invalid-revision-range' }
    | { exitCode: number; status: 'scan-failed' };

/**
 * Builds the full gitleaks argv. `--redact` keeps a real secret out of CI logs and terminal scrollback even when the
 * gate fails; the contributor still gets file/line context to act on.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export function gitleaksArguments({
    configPath,
    logOptions,
    repoRoot,
    staged,
}: Omit<GitleaksScanArguments, 'binaryPath'>): string[] {
    return [
        'git',
        repoRoot,
        '--config',
        configPath,
        '--redact',
        '--exit-code',
        '1',
        ...(staged ? ['--staged'] : []),
        ...(logOptions ? [`--log-opts=${logOptions}`] : []),
    ];
}

/**
 * Runs the complete scan orchestration so tests can prove an invalid range stops before binary resolution or launch.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export async function runGitleaksScan(
    options: GitleaksScanOptions,
    dependencies: GitleaksScanDependencies = {},
): Promise<GitleaksScanResult> {
    const run = dependencies.run ?? runChildProcess;
    const logOptions = options.staged
        ? undefined
        : gitleaksLogOptions(options.baseRevision, options.headRevision);
    if (!(await isGitleaksRevisionRangeValid(options.repoRoot, logOptions, run))) {
        return { exitCode: 1, status: 'invalid-revision-range' };
    }

    const resolveBinary = dependencies.resolveBinary ?? resolveGitleaksBinary;
    const binaryPath = await resolveBinary({ cacheRoot: options.cacheRoot });
    const arguments_ = gitleaksArguments({
        configPath: resolve(options.repoRoot, '.gitleaks.toml'),
        logOptions,
        repoRoot: options.repoRoot,
        staged: options.staged,
    });
    const exitCode = await run(binaryPath, arguments_, {
        cwd: options.repoRoot,
        stdio: 'inherit',
    });
    return exitCode === 0 ? { exitCode: 0, status: 'passed' } : { exitCode, status: 'scan-failed' };
}

/**
 * Command-line arguments the scan cannot honor. The range comes only from `GITLEAKS_BASE_REVISION` and
 * `GITLEAKS_HEAD_REVISION`, so `gitleaks-scan.ts origin/main HEAD` used to ignore both revisions and scan the full
 * history, burying a branch check under every historical finding.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/gitleaks-scan.test.ts
export function unsupportedGitleaksArguments(argv: readonly string[]): string[] {
    return argv.filter((argument) => argument !== '--staged' && argument !== '--');
}

async function main(): Promise<void> {
    const unsupported = unsupportedGitleaksArguments(process.argv.slice(2));
    if (unsupported.length > 0) {
        console.error(
            `Unsupported argument ${unsupported.join(' ')}. Pass --staged, or scan a range with` +
                ' GITLEAKS_BASE_REVISION=<base> [GITLEAKS_HEAD_REVISION=<head>]; no range outside a CI dispatch scans the full history.',
        );
        process.exitCode = 2;
        return;
    }
    const cacheRoot = process.env.RUNNER_TOOL_CACHE
        ? resolve(process.env.RUNNER_TOOL_CACHE, 'caxri')
        : resolve(projectRoot, '.cache', 'tool-cache');
    const result = await runGitleaksScan({
        baseRevision: resolveGitleaksBaseRevision(
            process.env.GITLEAKS_BASE_REVISION,
            process.env.GITHUB_EVENT_NAME,
        ),
        cacheRoot,
        headRevision: process.env.GITLEAKS_HEAD_REVISION ?? 'HEAD',
        repoRoot: projectRoot,
        staged: process.argv.includes('--staged'),
    });
    if (result.status === 'invalid-revision-range') {
        console.error(
            'The configured gitleaks revision range cannot be resolved. Fetch both revisions or fix' +
                ' GITLEAKS_BASE_REVISION/GITLEAKS_HEAD_REVISION before retrying.',
        );
    } else if (result.status === 'scan-failed') {
        console.error(
            'gitleaks reported a potential secret above (values redacted). Fix or, for a verified' +
                ' false positive, extend .gitleaks.toml with a narrowly scoped allowlist entry.',
        );
    }
    process.exitCode = result.exitCode;
}

if (import.meta.main) await main();
