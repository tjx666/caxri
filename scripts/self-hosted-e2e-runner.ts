#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
    assertDesktopLeasesReleased,
    reclaimDesktopLeasesByOwner,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';

const execFileAsync = promisify(execFile);
const ownerPattern = /^caxri-[0-9]+-[0-9]+-[a-z0-9-]+$/u;
const generatedWorkspacePaths = ['logs', 'out', 'playwright-report', 'release', 'test-results'];

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
    const marker = `CAXRI_E2E_RUN_OWNER=${owner}`;
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
    if (!ownerPattern.test(owner)) throw new Error('Invalid CAXRI_E2E_RUN_OWNER');
    return owner;
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
    if (owned.some(isAlive)) throw new Error('Owned E2E processes survived SIGKILL');
    return owned.length;
}

async function assertCleanWorkspace(workspace: string): Promise<void> {
    const status = await capture(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        workspace,
    );
    if (status) throw new Error('Self-hosted E2E workspace is not clean');
}

async function prepare(environment: NodeJS.ProcessEnv): Promise<void> {
    const workspace = resolve(requiredEnvironment(environment, 'GITHUB_WORKSPACE'));
    const runnerTemp = resolve(requiredEnvironment(environment, 'RUNNER_TEMP'));
    const owner = validateRunnerOwner(requiredEnvironment(environment, 'CAXRI_E2E_RUN_OWNER'));
    if (environment.CAXRI_DESKTOP_LEASE_OWNER !== owner) {
        throw new Error('Desktop lease owner must match the E2E run owner');
    }
    if (
        environment.RUNNER_ENVIRONMENT !== 'self-hosted' ||
        environment.RUNNER_OS !== 'macOS' ||
        environment.RUNNER_ARCH !== 'ARM64'
    ) {
        throw new Error('The Caxri self-hosted E2E boundary requires macOS ARM64');
    }
    if (
        environment.CAXRI_E2E_AGENT_MODE !== 'blocked' ||
        environment.CAXRI_REAL_AGENT_E2E === '1'
    ) {
        throw new Error('Self-hosted E2E must block ambient real Agent discovery');
    }
    const expectedHead = requiredEnvironment(environment, 'CAXRI_EXPECTED_HEAD');
    if (!/^[0-9a-f]{40}$/u.test(expectedHead)) throw new Error('Invalid expected E2E head');
    if ((await capture('git', ['rev-parse', 'HEAD'], workspace)) !== expectedHead) {
        throw new Error('Self-hosted E2E checkout does not match the exact expected head');
    }
    await assertCleanWorkspace(workspace);
    await assertDesktopLeasesReleased(workspace);

    const runRoot = join(runnerTemp, owner);
    if (!isAbsolute(runRoot) || relative(runnerTemp, runRoot).startsWith('..')) {
        throw new Error('Owned E2E run root escaped RUNNER_TEMP');
    }
    await mkdir(runRoot, { mode: 0o700 });
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
    const githubEnvironment = requiredEnvironment(environment, 'GITHUB_ENV');
    await appendFile(
        githubEnvironment,
        [
            `CAXRI_E2E_RUN_ROOT=${runRoot}`,
            `CODEX_HOME=${codexHome}`,
            `CLAUDE_CONFIG_DIR=${claudeConfig}`,
            `TEMP=${temporaryDirectory}`,
            `TMP=${temporaryDirectory}`,
            `TMPDIR=${temporaryDirectory}`,
            '',
        ].join('\n'),
        'utf8',
    );
    await appendSummary(
        [
            '## Self-hosted E2E preflight',
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
}

async function removeOwnedRunRoot(environment: NodeJS.ProcessEnv, owner: string): Promise<boolean> {
    const runnerTemp = await realpath(resolve(requiredEnvironment(environment, 'RUNNER_TEMP')));
    const runRootSource = environment.CAXRI_E2E_RUN_ROOT ?? join(runnerTemp, owner);
    const stats = await lstat(runRootSource).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    if (!stats) return false;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Owned E2E run root must be a real directory');
    }
    const runRoot = await realpath(runRootSource);
    const relativePath = relative(runnerTemp, runRoot);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('Refusing to clean an E2E run root outside RUNNER_TEMP');
    }
    const marker = JSON.parse(await readFile(join(runRoot, 'owner.json'), 'utf8')) as {
        owner?: string;
    };
    if (marker.owner !== owner) throw new Error('Owned E2E run root marker does not match');
    await rm(runRoot, { recursive: true });
    return true;
}

async function cleanup(environment: NodeJS.ProcessEnv): Promise<void> {
    const workspace = resolve(requiredEnvironment(environment, 'GITHUB_WORKSPACE'));
    const owner = validateRunnerOwner(requiredEnvironment(environment, 'CAXRI_E2E_RUN_OWNER'));
    const processes = await terminateOwnedProcesses(owner, workspace);
    const leases = await reclaimDesktopLeasesByOwner(workspace, owner);
    await assertDesktopLeasesReleased(workspace);
    const removedRunRoot = await removeOwnedRunRoot(environment, owner);
    await Promise.all(
        generatedWorkspacePaths.map((path) =>
            rm(join(workspace, path), { recursive: true, force: true }),
        ),
    );
    await assertCleanWorkspace(workspace);
    await appendSummary(
        [
            '## Self-hosted E2E teardown',
            '',
            '| Check | Result |',
            '| --- | --- |',
            `| Owned processes terminated | \`${processes}\` |`,
            `| Stale owned leases reclaimed | \`${leases}\` |`,
            '| Desktop lease | `free` |',
            `| Temporary profile | \`${removedRunRoot ? 'removed' : 'not created'}\` |`,
            '| Generated workspace outputs | `removed` |',
            '| Workspace | `clean` |',
            '',
        ],
        environment,
    );
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command !== 'prepare' && command !== 'cleanup') {
        throw new Error('Usage: self-hosted-e2e-runner.ts <prepare|cleanup>');
    }
    try {
        if (command === 'prepare') await prepare(process.env);
        else await cleanup(process.env);
    } catch (error) {
        await appendSummary(
            [
                `## Self-hosted E2E ${command}`,
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
