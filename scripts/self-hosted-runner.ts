#!/usr/bin/env bun

import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';

import {
    assertDesktopLeasesReleased,
    reclaimDesktopLeasesByOwner,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';

const execFileAsync = promisify(execFile);
const ownerPattern = /^caxri-[0-9]+-[0-9]+-[a-z0-9-]+$/u;
const generatedWorkspacePaths = [
    '.cache',
    'logs',
    'out',
    'playwright-report',
    'release',
    'test-results',
];

export interface ProcessRecord {
    command: string;
    pid: number;
    ppid: number;
}

export function parseProcessTable(output: string): ProcessRecord[] {
    return output.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
        if (!match) return [];
        return [{ command: match[3], pid: Number(match[1]), ppid: Number(match[2]) }];
    });
}

export function protectedProcessIds(records: readonly ProcessRecord[], pid: number): Set<number> {
    const byPid = new Map(records.map((record) => [record.pid, record]));
    const protectedIds = new Set<number>();
    let current: number | undefined = pid;
    while (current && !protectedIds.has(current)) {
        protectedIds.add(current);
        current = byPid.get(current)?.ppid;
    }
    return protectedIds;
}

export function ownedProcessIds(
    records: readonly ProcessRecord[],
    owner: string,
    protectedIds: ReadonlySet<number>,
): number[] {
    const marker = `CAXRI_RUNNER_OWNER=${owner}`;
    return records
        .filter(
            ({ command, pid }) =>
                (command.endsWith(marker) || command.includes(`${marker} `)) &&
                !protectedIds.has(pid),
        )
        .map(({ pid }) => pid)
        .sort((left, right) => right - left);
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
    const value = environment[key];
    if (!value || value.includes('\n')) throw new Error(`${key} is required and must be one line`);
    return value;
}

export function validateRunnerOwner(owner: string): string {
    if (!ownerPattern.test(owner)) throw new Error('Invalid CAXRI_RUNNER_OWNER');
    return owner;
}

/**
 * macOS rejects AF_UNIX socket paths longer than 104 bytes (sun_path), and RUNNER_TEMP sits deep
 * inside the runner install, so pointing TMPDIR at the owned run root breaks every Unix-socket
 * consumer under it — the Runtime agent-hook bridge socket and Chromium's singleton socket both
 * live in TMPDIR. Jobs therefore reach the run-owned temp directory through this short
 * /private/tmp symlink; the budget keeps roughly 40 bytes free for socket file names.
 */
export function shortTemporaryLinkPath(owner: string): string {
    const linkPath = join('/private/tmp', owner);
    if (Buffer.byteLength(linkPath, 'utf8') > 60) {
        throw new Error('Short temporary link path exceeds the Unix socket budget');
    }
    return linkPath;
}

async function capture(command: string, args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync(command, args, { cwd, encoding: 'utf8' });
    return stdout.trim();
}

async function appendSummary(lines: string[], environment: NodeJS.ProcessEnv): Promise<void> {
    const summary = environment.GITHUB_STEP_SUMMARY;
    if (summary) await appendFile(summary, `${lines.join('\n')}\n`, 'utf8');
}

async function processTable(cwd: string): Promise<ProcessRecord[]> {
    return parseProcessTable(await capture('ps', ['eww', '-axo', 'pid=,ppid=,command='], cwd));
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function terminateOwnedProcesses(owner: string, cwd: string): Promise<number> {
    const records = await processTable(cwd);
    const owned = ownedProcessIds(records, owner, protectedProcessIds(records, process.pid));
    for (const pid of owned) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
    }
    for (let attempt = 0; attempt < 20 && owned.some(isAlive); attempt += 1) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
    }
    for (const pid of owned.filter(isAlive)) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
    }
    if (owned.some(isAlive)) throw new Error('Owned runner processes survived SIGKILL');
    return owned.length;
}

async function assertCleanWorkspace(workspace: string): Promise<void> {
    const status = await capture(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        workspace,
    );
    if (status) throw new Error('Self-hosted runner workspace is not clean');
}

export async function removeCreatedRunRoot(
    runnerTemp: string,
    runRoot: string,
    owner: string,
): Promise<boolean> {
    const stats = await lstat(runRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    if (!stats) return false;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Created runner job root must remain a real directory');
    }
    const resolvedRunnerTemp = await realpath(runnerTemp);
    const resolvedRunRoot = await realpath(runRoot);
    const relativePath = relative(resolvedRunnerTemp, resolvedRunRoot);
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
    runnerTemp: string,
    runRoot: string,
    owner: string,
    runRootCreated: boolean,
    temporaryLinkCreated: boolean,
): Promise<Error[]> {
    const failures: Error[] = [];
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
            await operation();
        } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
        }
    };

    if (temporaryLinkCreated) await attempt(() => removeShortTemporaryLink(owner, runnerTemp));
    if (runRootCreated) await attempt(() => removeCreatedRunRoot(runnerTemp, runRoot, owner));
    return failures;
}

async function prepare(environment: NodeJS.ProcessEnv): Promise<void> {
    const workspace = resolve(requiredEnvironment(environment, 'GITHUB_WORKSPACE'));
    const runnerTemp = resolve(requiredEnvironment(environment, 'RUNNER_TEMP'));
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
    await assertDesktopLeasesReleased(workspace);

    const runRoot = join(runnerTemp, owner);
    if (!isAbsolute(runRoot) || relative(runnerTemp, runRoot).startsWith('..')) {
        throw new Error('Owned runner job root escaped RUNNER_TEMP');
    }
    let runRootCreated = false;
    let temporaryLinkCreated = false;
    try {
        await mkdir(runRoot, { mode: 0o700 });
        runRootCreated = true;
        await writeFile(join(runRoot, 'owner.json'), `${JSON.stringify({ owner })}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        const temporaryDirectory = join(runRoot, 'tmp');
        const codexHome = join(runRoot, 'providers', 'codex');
        const claudeConfig = join(runRoot, 'providers', 'claude');
        await Promise.all([
            mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
            mkdir(codexHome, { recursive: true, mode: 0o700 }),
            mkdir(claudeConfig, { recursive: true, mode: 0o700 }),
        ]);
        // Fails closed on EEXIST, mirroring the non-recursive mkdir of the run root above.
        const temporaryLink = shortTemporaryLinkPath(owner);
        await symlink(temporaryDirectory, temporaryLink);
        temporaryLinkCreated = true;
        const githubEnvironment = requiredEnvironment(environment, 'GITHUB_ENV');
        await appendFile(
            githubEnvironment,
            [
                `CAXRI_RUNNER_ROOT=${runRoot}`,
                `CODEX_HOME=${codexHome}`,
                `CLAUDE_CONFIG_DIR=${claudeConfig}`,
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
            runnerTemp,
            runRoot,
            owner,
            runRootCreated,
            temporaryLinkCreated,
        );
        if (rollbackFailures.length > 0) {
            await appendSummary(
                [
                    '## Self-hosted runner preflight rollback',
                    '',
                    `| Rollback failures | \`${rollbackFailures.length}\` |`,
                    '',
                ],
                environment,
            ).catch(() => undefined);
        }
        throw error;
    }
}

async function removeOwnedRunRoot(environment: NodeJS.ProcessEnv, owner: string): Promise<boolean> {
    const runnerTemp = await realpath(resolve(requiredEnvironment(environment, 'RUNNER_TEMP')));
    const runRootSource = environment.CAXRI_RUNNER_ROOT ?? join(runnerTemp, owner);
    const stats = await lstat(runRootSource).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    if (!stats) return false;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Owned runner job root must be a real directory');
    }
    const runRoot = await realpath(runRootSource);
    const relativePath = relative(runnerTemp, runRoot);
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

async function removeShortTemporaryLink(owner: string, runnerTemp: string): Promise<boolean> {
    const linkPath = shortTemporaryLinkPath(owner);
    const stats = await lstat(linkPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    if (!stats) return false;
    if (!stats.isSymbolicLink()) {
        throw new Error('Owned short temporary path must be a symlink');
    }
    const expectedTarget = await realpath(join(resolve(runnerTemp), owner, 'tmp'));
    const actualTarget = await realpath(linkPath);
    if (actualTarget !== expectedTarget) {
        throw new Error(
            'Owned short temporary path must target the current runner job temporary directory',
        );
    }
    await rm(linkPath);
    return true;
}

export interface CleanupOperations {
    terminateOwnedProcesses?: (owner: string, workspace: string) => Promise<number>;
}

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
        () => (operations.terminateOwnedProcesses ?? terminateOwnedProcesses)(owner, workspace),
        0,
    );
    const leases = await attempt('leases', () => reclaimDesktopLeasesByOwner(workspace, owner), 0);
    const desktopLeaseReleased = await attempt(
        'lease verification',
        async () => {
            await assertDesktopLeasesReleased(workspace);
            return true;
        },
        false,
    );
    const removedTemporaryLink = await attempt(
        'temporary link',
        () => removeShortTemporaryLink(owner, requiredEnvironment(environment, 'RUNNER_TEMP')),
        false,
    );
    const removedRunRoot = await attempt(
        'run root',
        () => removeOwnedRunRoot(environment, owner),
        false,
    );
    const generatedOutputsRemoved = await attempt(
        'workspace outputs',
        async () => {
            await Promise.all(
                generatedWorkspacePaths.map((path) =>
                    rm(join(workspace, path), { recursive: true, force: true }),
                ),
            );
            return true;
        },
        false,
    );
    const workspaceClean = await attempt(
        'workspace verification',
        async () => {
            await assertCleanWorkspace(workspace);
            return true;
        },
        false,
    );
    const summaryFailure = await appendSummary(
        [
            '## Self-hosted runner teardown',
            '',
            '| Check | Result |',
            '| --- | --- |',
            `| Owned processes terminated | \`${processes}\` |`,
            `| Stale owned leases reclaimed | \`${leases}\` |`,
            `| Desktop lease | \`${desktopLeaseReleased ? 'free' : 'not verified'}\` |`,
            `| Temporary profile | \`${removedRunRoot ? 'removed' : 'not created'}\` |`,
            `| Short TMPDIR link | \`${removedTemporaryLink ? 'removed' : 'not created'}\` |`,
            `| Generated workspace outputs | \`${generatedOutputsRemoved ? 'removed' : 'not verified'}\` |`,
            `| Workspace | \`${workspaceClean ? 'clean' : 'not verified'}\` |`,
            `| Cleanup stage failures | \`${failures.length}\` |`,
            `| Failed stages | \`${failedStages.join(', ') || 'none'}\` |`,
            '',
        ],
        environment,
    ).catch((error) => (error instanceof Error ? error : new Error(String(error))));
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
        await appendSummary(
            [
                `## Self-hosted runner ${command}`,
                '',
                `**Failed closed:** ${error instanceof Error ? error.message : String(error)}`,
                '',
            ],
            process.env,
        ).catch(() => undefined);
        throw error;
    }
}

if (import.meta.main) await main();
