import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { runCapture } from './process';

export interface ProcessEntry {
    command: string;
    parentPid: number;
    pid: number;
}

export interface StopOperations {
    list: () => Promise<ProcessEntry[]>;
    signalProcess: (pid: number, signal: NodeJS.Signals) => void;
    wait: (milliseconds: number) => Promise<unknown>;
}

const TERMINATION_POLL_MS = 250;
const TERMINATION_WAIT_MS = 5000;
const FORCE_WAIT_MS = 2000;

/**
 * Parses `ps -axo pid=,ppid=,command=`. Command lines keep their spaces — macOS helper executables live under paths
 * like `Electron Helper (Renderer).app` — so only the two leading numeric columns are split off.
 */
export function parseProcessTable(stdout: string): ProcessEntry[] {
    return stdout.split('\n').flatMap((line) => {
        const match = /^\s*(?<pid>\d+)\s+(?<parentPid>\d+)\s+(?<command>\S.*)$/u.exec(line);
        const groups = match?.groups;
        if (!groups?.command) return [];
        return [
            {
                command: groups.command,
                parentPid: Number(groups.parentPid),
                pid: Number(groups.pid),
            },
        ];
    });
}

/**
 * Ownership is decided by this worktree's absolute path, never by the app's name. A name or bundle pattern (`pkill -f
 * "Caxri.app"`, `pkill -f Electron`) matches the installed `/Applications/Caxri.app`, a sibling worktree, and every
 * unrelated Electron app on the machine; an absolute path cannot.
 *
 * Three shapes count as owned: an executable inside the worktree (the dev and E2E Electron binaries), a build artifact
 * of this checkout passed to an external runtime (`node <worktree>/apps/server/dist/...`, `bun
 * <worktree>/node_modules/...`), and nothing else. Only artifact directories qualify, so an editor or a search holding
 * a source path open is never mistaken for a process this checkout started.
 *
 * @see https://github.com/tjx666/caxri/issues/802
 */
export function isWorktreeOwnedCommand(command: string, worktreePath: string): boolean {
    const root = worktreePath.replace(/\/+$/u, '');
    if (root.length <= 1) return false;
    return (
        command.startsWith(`${root}/`) ||
        command.includes(`${root}/node_modules/`) ||
        command.includes(`${root}/apps/server/dist/`)
    );
}

/**
 * Walks the parent chain so the stop command can never signal the shell, the agent session, or the `bun` process that
 * invoked it — all of which run inside the worktree and would otherwise look owned.
 */
function ancestorProcessIds(entries: readonly ProcessEntry[], pid: number): Set<number> {
    const parents = new Map(entries.map((entry) => [entry.pid, entry.parentPid]));
    const ancestors = new Set<number>();
    let current = parents.get(pid);
    while (current !== undefined && current > 0 && !ancestors.has(current)) {
        ancestors.add(current);
        current = parents.get(current);
    }
    return ancestors;
}

/**
 * The Electron window process reports its command as the app name (`Caxri Dev`), not as a path, so it is unreachable by
 * path matching. It is reachable as a descendant of the recorded launcher, which is why the roots come from
 * `switch-worktree dev`'s own process record instead of from a search.
 */
function descendantProcessIds(
    entries: readonly ProcessEntry[],
    roots: Iterable<number>,
): Set<number> {
    const children = new Map<number, number[]>();
    for (const entry of entries) {
        const siblings = children.get(entry.parentPid);
        if (siblings) siblings.push(entry.pid);
        else children.set(entry.parentPid, [entry.pid]);
    }
    const found = new Set<number>();
    const queue = [...roots];
    while (queue.length > 0) {
        const pid = queue.pop()!;
        const unseen = (children.get(pid) ?? []).filter((child) => !found.has(child));
        for (const child of unseen) found.add(child);
        queue.push(...unseen);
    }
    return found;
}

/**
 * Resolves every process this worktree owns: the recorded development launcher with its whole subtree, plus anything
 * still executing out of the worktree after an interrupted run (a detached Server Core, an abandoned Playwright
 * Electron). Nothing outside the worktree's own path can enter this set.
 */
export function worktreeProcessesToStop({
    entries,
    launcherPid,
    selfPid,
    worktreePath,
}: {
    entries: readonly ProcessEntry[];
    launcherPid?: number;
    selfPid: number;
    worktreePath: string;
}): ProcessEntry[] {
    const protectedIds = new Set([selfPid, ...ancestorProcessIds(entries, selfPid)]);
    const seeds = new Set(
        entries
            .filter(
                (entry) =>
                    !protectedIds.has(entry.pid) &&
                    (entry.pid === launcherPid ||
                        isWorktreeOwnedCommand(entry.command, worktreePath)),
            )
            .map((entry) => entry.pid),
    );
    const targets = new Set([...seeds, ...descendantProcessIds(entries, seeds)]);
    return entries.filter((entry) => targets.has(entry.pid) && !protectedIds.has(entry.pid));
}

async function listProcesses(): Promise<ProcessEntry[]> {
    return parseProcessTable(
        await runCapture('ps', ['-axo', 'pid=,ppid=,command='], process.cwd()),
    );
}

export const defaultStopOperations: StopOperations = {
    list: listProcesses,
    signalProcess: (pid, signal) => {
        try {
            process.kill(pid, signal);
        } catch {
            // The process exited between the listing and the signal; that is the outcome we wanted.
        }
    },
    wait: (milliseconds) => sleep(milliseconds),
};

export interface StopProcessesResult {
    stopped: ProcessEntry[];
    survivors: ProcessEntry[];
}

async function survivingTargets(
    operations: StopOperations,
    targetIds: ReadonlySet<number>,
): Promise<ProcessEntry[]> {
    return (await operations.list()).filter((entry) => targetIds.has(entry.pid));
}

/**
 * SIGTERM first so Desktop persists window state and Server Core closes SQLite cleanly, then SIGKILL whatever is still
 * alive after the bounded wait. Every signal goes to a PID resolved from this worktree's own path or process record.
 */
export async function stopProcesses(
    targets: readonly ProcessEntry[],
    operations: StopOperations = defaultStopOperations,
): Promise<StopProcessesResult> {
    if (targets.length === 0) return { stopped: [], survivors: [] };
    const targetIds = new Set(targets.map((entry) => entry.pid));
    for (const { pid } of targets) operations.signalProcess(pid, 'SIGTERM');
    let remaining: ProcessEntry[] = targets as ProcessEntry[];
    for (let waited = 0; waited < TERMINATION_WAIT_MS; waited += TERMINATION_POLL_MS) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        await operations.wait(TERMINATION_POLL_MS);
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        remaining = await survivingTargets(operations, targetIds);
        if (remaining.length === 0) return { stopped: [...targets], survivors: [] };
    }
    for (const { pid } of remaining) operations.signalProcess(pid, 'SIGKILL');
    for (let waited = 0; waited < FORCE_WAIT_MS; waited += TERMINATION_POLL_MS) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for force-terminated processes to exit
        await operations.wait(TERMINATION_POLL_MS);
        // eslint-disable-next-line no-await-in-loop -- bounded wait for force-terminated processes to exit
        remaining = await survivingTargets(operations, targetIds);
        if (remaining.length === 0) break;
    }
    return {
        stopped: targets.filter((entry) => remaining.every((alive) => alive.pid !== entry.pid)),
        survivors: remaining,
    };
}
