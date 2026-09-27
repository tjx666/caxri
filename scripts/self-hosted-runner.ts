#!/usr/bin/env bun

import { Buffer } from 'node:buffer';
import {
    appendFile,
    lstat,
    mkdir,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';

import {
    assertDesktopLeasesReleased,
    reclaimDesktopLeasesByOwner,
    reclaimStaleCiDesktopLeases,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import { execFileAsync } from './exec';
import { recoverRunnerProcesses } from './runner-process-recovery';

const ownerPattern = /^caxri-\d+-\d+-[a-z0-9-]+$/u;
const generatedWorkspacePaths = [
    '.cache',
    'logs',
    'out',
    'playwright-report',
    'release',
    'release.noindex',
    'test-results',
];

interface RunnerAgentEnvironmentPolicy {
    directoryName: string;
    environmentKeys: readonly string[];
}

const RUNNER_AGENT_ENVIRONMENT_POLICIES = {
    claude: { directoryName: 'claude', environmentKeys: ['CLAUDE_CONFIG_DIR'] },
    codex: { directoryName: 'codex', environmentKeys: ['CODEX_HOME'] },
    grok: { directoryName: 'grok', environmentKeys: ['GROK_HOME'] },
} satisfies Record<AgentProvider, RunnerAgentEnvironmentPolicy>;

/**
 * The retry-policy job executes this file before workspace dependencies exist. Derive the runtime provider list from
 * the exhaustive type-checked policy instead of importing the Protocol package at runtime; adding an AgentProvider
 * therefore still fails typecheck until its isolation policy exists.
 */
const runnerAgentProviderIds = Object.keys(RUNNER_AGENT_ENVIRONMENT_POLICIES) as AgentProvider[];

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
    const value = environment[key];
    if (!value || value.includes('\n')) throw new Error(`${key} is required and must be one line`);
    return value;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/self-hosted-runner.test.ts
export function validateRunnerOwner(owner: string): string {
    if (!ownerPattern.test(owner)) throw new Error('Invalid CAXRI_RUNNER_OWNER');
    return owner;
}

/**
 * MacOS rejects AF_UNIX socket paths longer than 104 bytes (sun_path), and RUNNER_TEMP sits deep inside the runner
 * install, so pointing TMPDIR at the owned run root breaks every Unix-socket consumer under it — the Runtime agent-hook
 * bridge socket and Chromium's singleton socket both live in TMPDIR. Jobs therefore reach the run-owned temp directory
 * through this short /private/tmp symlink; the budget keeps roughly 40 bytes free for socket file names.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/self-hosted-runner.test.ts
export function shortTemporaryLinkPath(owner: string): string {
    const linkPath = join('/private/tmp', owner);
    if (Buffer.byteLength(linkPath, 'utf8') > 60) {
        throw new Error('Short temporary link path exceeds the Unix socket budget');
    }
    return linkPath;
}

async function capture(command: string, arguments_: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync(command, arguments_, { cwd, encoding: 'utf8' });
    return stdout.trim();
}

async function appendSummary(lines: string[], environment: NodeJS.ProcessEnv): Promise<void> {
    const summary = environment.GITHUB_STEP_SUMMARY;
    if (summary) await appendFile(summary, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * Returns `undefined` for a missing path instead of throwing, while still failing closed on every other `lstat` error.
 */
async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function assertCleanWorkspace(workspace: string): Promise<void> {
    const status = await capture(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        workspace,
    );
    if (status) throw new Error('Self-hosted runner workspace is not clean');
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/self-hosted-runner.test.ts
export async function didRemoveCreatedRunRoot(
    runnerTemporary: string,
    runRoot: string,
    owner: string,
): Promise<boolean> {
    const stats = await lstatIfExists(runRoot);
    if (!stats) return false;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Created runner job root must remain a real directory');
    }
    const resolvedRunnerTemporary = await realpath(runnerTemporary);
    const resolvedRunRoot = await realpath(runRoot);
    const relativePath = relative(resolvedRunnerTemporary, resolvedRunRoot);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('Refusing to roll back a runner job root outside RUNNER_TEMP');
    }
    const marker = JSON.parse(await readFile(join(resolvedRunRoot, 'owner.json'), 'utf8')) as {
        owner?: string;
    };
    if (marker.owner !== owner) {
        throw new Error('Created runner job root marker does not match');
    }
    await rm(runRoot, { recursive: true });
    return true;
}

async function rollbackPrepare(
    runnerTemporary: string,
    runRoot: string,
    owner: string,
    isRunRootCreated: boolean,
    isTemporaryLinkCreated: boolean,
): Promise<Error[]> {
    const failures: Error[] = [];
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
            await operation();
        } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
        }
    };

    if (isTemporaryLinkCreated) {
        await attempt(() => didRemoveShortTemporaryLink(owner, runnerTemporary));
    }
    if (isRunRootCreated)
        await attempt(() => didRemoveCreatedRunRoot(runnerTemporary, runRoot, owner));
    return failures;
}

async function prepare(environment: NodeJS.ProcessEnv): Promise<void> {
    const workspace = resolve(requiredEnvironment(environment, 'GITHUB_WORKSPACE'));
    const runnerTemporary = resolve(requiredEnvironment(environment, 'RUNNER_TEMP'));
    const owner = validateRunnerOwner(requiredEnvironment(environment, 'CAXRI_RUNNER_OWNER'));
    if (environment.CAXRI_DESKTOP_LEASE_OWNER !== owner) {
        throw new Error('Desktop lease owner must match the runner job owner');
    }
    if (
        environment.RUNNER_ENVIRONMENT !== 'self-hosted' ||
        environment.RUNNER_OS !== 'macOS' ||
        environment.RUNNER_ARCH !== 'ARM64'
    ) {
        throw new Error('The Caxri self-hosted runner boundary requires macOS ARM64');
    }
    if (
        environment.CAXRI_RUNNER_AGENT_DISCOVERY !== 'blocked' ||
        environment.CAXRI_REAL_AGENT_E2E === '1'
    ) {
        throw new Error('Self-hosted jobs must block ambient Agent discovery');
    }
    const expectedHead = requiredEnvironment(environment, 'CAXRI_EXPECTED_HEAD');
    if (!/^[0-9a-f]{40}$/u.test(expectedHead)) throw new Error('Invalid expected runner head');
    if ((await capture('git', ['rev-parse', 'HEAD'], workspace)) !== expectedHead) {
        throw new Error('Self-hosted checkout does not match the exact expected head');
    }
    await assertCleanWorkspace(workspace);
    const staleProcesses = await recoverRunnerProcesses(
        { owner, runnerTemporary, workspace },
        true,
    );
    await appendSummary([`Previous CI processes recovered: ${staleProcesses}`], environment);
    await reclaimStaleCiDesktopLeases(workspace);
    await assertDesktopLeasesReleased(workspace);

    const runRoot = join(runnerTemporary, owner);
    if (!isAbsolute(runRoot) || relative(runnerTemporary, runRoot).startsWith('..')) {
        throw new Error('Owned runner job root escaped RUNNER_TEMP');
    }
    let isRunRootCreated = false;
    let isTemporaryLinkCreated = false;
    try {
        await mkdir(runRoot, { mode: 0o700 });
        isRunRootCreated = true;
        await writeFile(join(runRoot, 'owner.json'), `${JSON.stringify({ owner })}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        const temporaryDirectory = join(runRoot, 'tmp');
        const providerDirectories = Object.fromEntries(
            runnerAgentProviderIds.map((provider) => [
                provider,
                join(
                    runRoot,
                    'providers',
                    RUNNER_AGENT_ENVIRONMENT_POLICIES[provider].directoryName,
                ),
            ]),
        ) as Record<AgentProvider, string>;
        await Promise.all([
            mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
            ...runnerAgentProviderIds.map((provider) =>
                mkdir(providerDirectories[provider], { recursive: true, mode: 0o700 }),
            ),
        ]);
        // Fails closed on EEXIST, mirroring the non-recursive mkdir of the run root above.
        const temporaryLink = shortTemporaryLinkPath(owner);
        await symlink(temporaryDirectory, temporaryLink);
        isTemporaryLinkCreated = true;
        const githubEnvironment = requiredEnvironment(environment, 'GITHUB_ENV');
        await appendFile(
            githubEnvironment,
            [
                `CAXRI_RUNNER_ROOT=${runRoot}`,
                ...runnerAgentProviderIds.flatMap((provider) =>
                    RUNNER_AGENT_ENVIRONMENT_POLICIES[provider].environmentKeys.map(
                        (key) => `${key}=${providerDirectories[provider]}`,
                    ),
                ),
                `TEMP=${temporaryLink}`,
                `TMP=${temporaryLink}`,
                `TMPDIR=${temporaryLink}`,
                '',
            ].join('\n'),
            'utf8',
        );
        await appendSummary(
            [
                '## Self-hosted runner preflight',
                '',
                '| Boundary | Value |',
                '| --- | --- |',
                `| Runner | \`${requiredEnvironment(environment, 'RUNNER_NAME')}\` |`,
                '| Platform | `macOS / ARM64` |',
                `| Exact head | \`${expectedHead}\` |`,
                `| Run owner | \`${owner}\` |`,
                '| Desktop lease | `free` |',
                '| Agent discovery | `blocked` with profile-scoped fake fixtures only |',
                '',
            ],
            environment,
        );
    } catch (error) {
        const rollbackFailures = await rollbackPrepare(
            runnerTemporary,
            runRoot,
            owner,
            isRunRootCreated,
            isTemporaryLinkCreated,
        );
        if (rollbackFailures.length > 0) {
            try {
                await appendSummary(
                    [
                        '## Self-hosted runner preflight rollback',
                        '',
                        `| Rollback failures | \`${rollbackFailures.length}\` |`,
                        '',
                    ],
                    environment,
                );
            } catch {
                // Best-effort summary write; the rollback failures themselves already surface
                // through the thrown `error` below.
            }
        }
        throw error;
    }
}

async function didRemoveOwnedRunRoot(
    environment: NodeJS.ProcessEnv,
    owner: string,
): Promise<boolean> {
    const runnerTemporary = await realpath(
        resolve(requiredEnvironment(environment, 'RUNNER_TEMP')),
    );
    const runRootSource = environment.CAXRI_RUNNER_ROOT ?? join(runnerTemporary, owner);
    const stats = await lstatIfExists(runRootSource);
    if (!stats) return false;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Owned runner job root must be a real directory');
    }
    const runRoot = await realpath(runRootSource);
    const relativePath = relative(runnerTemporary, runRoot);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('Refusing to clean a runner job root outside RUNNER_TEMP');
    }
    const marker = JSON.parse(await readFile(join(runRoot, 'owner.json'), 'utf8')) as {
        owner?: string;
    };
    if (marker.owner !== owner) throw new Error('Owned runner job root marker does not match');
    await rm(runRoot, { recursive: true });
    return true;
}

async function didRemoveShortTemporaryLink(
    owner: string,
    runnerTemporary: string,
): Promise<boolean> {
    const linkPath = shortTemporaryLinkPath(owner);
    const stats = await lstatIfExists(linkPath);
    if (!stats) return false;
    if (!stats.isSymbolicLink()) {
        throw new Error('Owned short temporary path must be a symlink');
    }
    const expectedTarget = await realpath(join(resolve(runnerTemporary), owner, 'tmp'));
    const actualTarget = await realpath(linkPath);
    if (actualTarget !== expectedTarget) {
        throw new Error(
            'Owned short temporary path must target the current runner job temporary directory',
        );
    }
    await rm(linkPath);
    return true;
}

interface CleanupOperations {
    terminateOwnedProcesses?: (owner: string, workspace: string) => Promise<number>;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/self-hosted-runner.test.ts
export async function cleanup(
    environment: NodeJS.ProcessEnv,
    operations: CleanupOperations = {},
): Promise<void> {
    const workspace = resolve(requiredEnvironment(environment, 'GITHUB_WORKSPACE'));
    const owner = validateRunnerOwner(requiredEnvironment(environment, 'CAXRI_RUNNER_OWNER'));
    const failures: Error[] = [];
    const failedStages: string[] = [];
    const attempt = async <Value>(
        stage: string,
        operation: () => Promise<Value>,
        fallback: Value,
    ): Promise<Value> => {
        try {
            return await operation();
        } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
            failedStages.push(stage);
            return fallback;
        }
    };
    const processes = await attempt(
        'processes',
        () =>
            operations.terminateOwnedProcesses
                ? operations.terminateOwnedProcesses(owner, workspace)
                : recoverRunnerProcesses(
                      {
                          owner,
                          runnerTemporary: requiredEnvironment(environment, 'RUNNER_TEMP'),
                          workspace,
                      },
                      false,
                  ),
        undefined,
    );
    const leases = await attempt('leases', () => reclaimDesktopLeasesByOwner(workspace, owner), 0);
    const isDesktopLeaseReleased = await attempt(
        'lease verification',
        async () => {
            await assertDesktopLeasesReleased(workspace);
            return true;
        },
        false,
    );
    const isRemovedTemporaryLink = await attempt(
        'temporary link',
        () =>
            processes === undefined
                ? Promise.resolve(false)
                : didRemoveShortTemporaryLink(
                      owner,
                      requiredEnvironment(environment, 'RUNNER_TEMP'),
                  ),
        false,
    );
    const isRemovedRunRoot = await attempt(
        'run root',
        () =>
            processes === undefined
                ? Promise.resolve(false)
                : didRemoveOwnedRunRoot(environment, owner),
        false,
    );
    const isGeneratedOutputsRemoved = await attempt(
        'workspace outputs',
        async () => {
            if (processes === undefined) return false;
            await Promise.all(
                generatedWorkspacePaths.map((path) =>
                    rm(join(workspace, path), { recursive: true, force: true }),
                ),
            );
            return true;
        },
        false,
    );
    const isWorkspaceClean = await attempt(
        'workspace verification',
        async () => {
            await assertCleanWorkspace(workspace);
            return true;
        },
        false,
    );
    let summaryFailure: Error | undefined;
    try {
        await appendSummary(
            [
                '## Self-hosted runner teardown',
                '',
                '| Check | Result |',
                '| --- | --- |',
                `| Owned processes terminated | \`${processes ?? 'not verified'}\` |`,
                `| Stale owned leases reclaimed | \`${leases}\` |`,
                `| Desktop lease | \`${isDesktopLeaseReleased ? 'free' : 'not verified'}\` |`,
                `| Temporary profile | \`${isRemovedRunRoot ? 'removed' : 'not created'}\` |`,
                `| Short TMPDIR link | \`${isRemovedTemporaryLink ? 'removed' : 'not created'}\` |`,
                `| Generated workspace outputs | \`${isGeneratedOutputsRemoved ? 'removed' : 'not verified'}\` |`,
                `| Workspace | \`${isWorkspaceClean ? 'clean' : 'not verified'}\` |`,
                `| Cleanup stage failures | \`${failures.length}\` |`,
                `| Failed stages | \`${failedStages.join(', ') || 'none'}\` |`,
                '',
            ],
            environment,
        );
    } catch (error) {
        summaryFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (failures.length > 0) throw failures[0];
    if (summaryFailure) throw summaryFailure;
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command !== 'prepare' && command !== 'cleanup') {
        throw new Error('Usage: self-hosted-runner.ts <prepare|cleanup>');
    }
    try {
        if (command === 'prepare') await prepare(process.env);
        else await cleanup(process.env);
    } catch (error) {
        try {
            await appendSummary(
                [
                    `## Self-hosted runner ${command}`,
                    '',
                    `**Failed closed:** ${error instanceof Error ? error.message : String(error)}`,
                    '',
                ],
                process.env,
            );
        } catch {
            // Best-effort summary write; the original failure is rethrown below regardless.
        }
        throw error;
    }
}

if (import.meta.main) await main();
