import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';

export interface RunnerProcess {
    command: string;
    pid: number;
    ppid: number;
    startedAt: string;
    state: string;
}

export interface RunnerRecoveryScope {
    owner: string;
    runnerTemporary: string;
    workspace: string;
}

export interface RunnerRecoveryAdapter {
    list: () => Promise<RunnerProcess[]>;
    resolvePath: (path: string) => Promise<string>;
    signal: (record: RunnerProcess, signal: NodeJS.Signals) => Promise<void>;
    wait: () => Promise<void>;
}

const ownerPattern = /^caxri-(\d+)-\d+-[a-z0-9-]+$/u;

/**
 * Keeps process environments in memory only; callers report counts, never the captured command.
 */
export function parseRunnerProcesses(output: string): RunnerProcess[] {
    return output.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S.*)$/u.exec(
            line,
        );
        return match
            ? [
                  {
                      pid: Number(match[1]),
                      ppid: Number(match[2]),
                      state: match[3],
                      startedAt: match[4].replaceAll(/\s+/gu, ' '),
                      command: match[5],
                  },
              ]
            : [];
    });
}

function environmentValue(command: string, key: string): string | undefined {
    return new RegExp(`(?:^| )${key}=(.*?)(?= [A-Za-z_][A-Za-z_0-9]*=|$)`, 'u').exec(command)?.[1];
}

function protectedAncestors(records: readonly RunnerProcess[]): Set<number> {
    const recordsByPid = new Map(records.map((record) => [record.pid, record]));
    const protectedIds = new Set<number>();
    let pid = process.pid;
    while (pid && !protectedIds.has(pid)) {
        protectedIds.add(pid);
        pid = recordsByPid.get(pid)?.ppid ?? 0;
    }
    return protectedIds;
}

function isSelectedOwner(candidate: string | undefined, owner: string, isStale: boolean): boolean {
    const currentRun = ownerPattern.exec(owner)?.[1];
    const candidateRun = candidate && ownerPattern.exec(candidate)?.[1];
    if (!currentRun || !candidateRun) return false;
    // Jobs on this repository runner are serial. Never sweep another job from the current or a newer run.
    return isStale ? BigInt(candidateRun) < BigInt(currentRun) : candidate === owner;
}

/**
 * Legacy Servers lost their owner variable. Their exact runner executable plus a canonical CI temporary profile
 * establish ownership instead; an installed app, a worktree, and a normal developer profile cannot qualify.
 */
async function profileOwner(
    record: RunnerProcess,
    scope: RunnerRecoveryScope,
    resolvePath: RunnerRecoveryAdapter['resolvePath'],
): Promise<string | undefined> {
    const artifact = join(scope.workspace, 'apps/server/dist/server');
    if (
        !record.command.startsWith(`${join(artifact, 'runtime/bin/node')} `) ||
        !record.command.includes(` ${join(artifact, 'bundles/server-core.js')} `)
    )
        return undefined;
    const profile = environmentValue(record.command, 'CAXRI_USER_DATA_PATH');
    if (!profile || !isAbsolute(profile) || profile.includes('\n')) return undefined;
    let canonical: string;
    try {
        canonical = await resolvePath(profile);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        // eslint-disable-next-line preserve-caught-error -- filesystem errors expose the captured profile environment value
        throw new Error('Could not resolve runner recovery profile');
    }
    const parts = relative(scope.runnerTemporary, canonical).split('/');
    if (parts.length < 3 || parts[1] !== 'tmp' || !ownerPattern.test(parts[0])) return undefined;
    return parts[0];
}

export async function selectRunnerProcesses(
    records: readonly RunnerProcess[],
    scope: RunnerRecoveryScope,
    isStale: boolean,
    resolvePath: RunnerRecoveryAdapter['resolvePath'],
): Promise<RunnerProcess[]> {
    const protectedIds = protectedAncestors(records);
    const eligible = records.filter(
        (record) => !protectedIds.has(record.pid) && !record.state.startsWith('Z'),
    );
    const roots = await Promise.all(
        eligible.map(async (record) => {
            const marker = environmentValue(record.command, 'CAXRI_RUNNER_OWNER');
            // A stale marker alone cannot authorize killing a process outside this runner checkout.
            if (!isStale && isSelectedOwner(marker, scope.owner, false)) return record.pid;
            const owner = await profileOwner(record, scope, resolvePath);
            return isSelectedOwner(owner, scope.owner, isStale) ? record.pid : undefined;
        }),
    );
    return withDescendants(eligible, new Set(roots.filter((pid) => pid !== undefined)));
}

function withDescendants(
    records: readonly RunnerProcess[],
    seeds: ReadonlySet<number>,
): RunnerProcess[] {
    const selected = new Set(seeds);
    let frontier = new Set(seeds);
    while (frontier.size > 0) {
        const children = records.filter(
            (record) => frontier.has(record.ppid) && !selected.has(record.pid),
        );
        frontier = new Set(children.map((record) => record.pid));
        for (const record of children) selected.add(record.pid);
    }
    return records.filter((record) => selected.has(record.pid));
}

async function listProcesses(): Promise<RunnerProcess[]> {
    try {
        const { stdout } = await execFileAsync(
            'ps',
            ['eww', '-axo', 'pid=,ppid=,state=,lstart=,command='],
            {
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
            },
        );
        return parseRunnerProcesses(stdout);
    } catch {
        // execFile errors retain captured stdout, which here contains other processes' environments.
        throw new Error('Could not inspect runner process identities');
    }
}

async function signalSameProcess(record: RunnerProcess, signal: NodeJS.Signals): Promise<void> {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync('ps', ['-p', String(record.pid), '-o', 'lstart='], {
            encoding: 'utf8',
        }));
    } catch (error) {
        if ((error as { code?: number }).code === 1) return;
        throw error;
    }
    if (stdout.trim().replaceAll(/\s+/gu, ' ') !== record.startedAt) return;
    try {
        process.kill(record.pid, signal);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
}

const defaultAdapter: RunnerRecoveryAdapter = {
    list: listProcesses,
    resolvePath: realpath,
    signal: signalSameProcess,
    wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
};

/**
 * Keeps the original identity of reparented children, discovers late descendants on every pass, and checks after
 * SIGKILL as well as SIGTERM. A successful signal or an empty first selection is not proof of successful teardown.
 */
export async function recoverRunnerProcesses(
    input: RunnerRecoveryScope,
    isStale: boolean,
    adapter: RunnerRecoveryAdapter = defaultAdapter,
): Promise<number> {
    if (!ownerPattern.test(input.owner)) throw new Error('Invalid runner recovery owner');
    const scope = {
        ...input,
        workspace: resolve(input.workspace),
        runnerTemporary: await adapter.resolvePath(input.runnerTemporary),
    };
    const tracked = new Map<number, RunnerProcess>();
    const signalled = new Set<string>();
    for (let attempt = 0; attempt < 32; attempt += 1) {
        // Sequential snapshots are the synchronization boundary for new and reparented descendants.
        // eslint-disable-next-line no-await-in-loop -- process ownership changes after each signal wave
        const records = await adapter.list();
        // Historical recovery freezes its initial roots. A queued older run can start after this snapshot;
        // numeric run order is not execution order and cannot authorize broadening an in-flight cleanup.

        // eslint-disable-next-line no-await-in-loop -- ownership is evaluated against this sequential snapshot
        const selected = await (attempt === 0 || !isStale
            ? selectRunnerProcesses(records, scope, isStale, adapter.resolvePath)
            : Promise.resolve([]));
        for (const record of selected) tracked.set(record.pid, record);
        const living = records.filter((record) => !record.state.startsWith('Z'));
        const existing = new Set(
            living
                .filter((record) => tracked.get(record.pid)?.startedAt === record.startedAt)
                .map((record) => record.pid),
        );
        const surviving = withDescendants(living, existing);
        for (const record of surviving) tracked.set(record.pid, record);
        if (surviving.length === 0) return tracked.size;
        if (attempt === 31) break;
        const signal = attempt < 20 ? 'SIGTERM' : 'SIGKILL';
        // eslint-disable-next-line no-await-in-loop -- finish this signal wave before checking liveness again
        await Promise.all(
            surviving
                .filter((record) => attempt >= 8 || !existing.has(record.ppid))
                .map(async (record) => {
                    const key = `${record.pid}:${record.startedAt}:${signal}`;
                    if (signalled.has(key)) return;
                    await adapter.signal(record, signal);
                    signalled.add(key);
                }),
        );
        // eslint-disable-next-line no-await-in-loop -- bounded process-exit observation interval
        await adapter.wait();
    }
    throw new Error('Owned runner processes survived bounded teardown');
}
