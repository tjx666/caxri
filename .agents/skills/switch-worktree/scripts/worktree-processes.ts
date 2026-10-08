import { createHash } from 'node:crypto';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { getProcessIdentity, runCapture } from './process';

export interface ProcessEntry {
    command: string;
    identity?: string;
    parentPid: number;
    pid: number;
    /**
     * Epoch milliseconds parsed from `ps lstart`, present only when the table carried start times.
     */
    startedAt?: number;
}

export interface StopOperations {
    list: () => Promise<ProcessEntry[]>;
    cwd: (pid: number) => Promise<string | undefined>;
    identity: (pid: number) => Promise<string | undefined>;
    signalProcess: (pid: number, signal: NodeJS.Signals) => SignalOutcome | void;
    wait: (milliseconds: number) => Promise<unknown>;
}

/**
 * Closed reasons a target can fail to receive or act on a signal. `identity-unavailable` and `identity-changed` are
 * caught before the signal call itself; the rest come from classifying `process.kill`'s thrown error. `already-exited`
 * is the expected, benign outcome (the process died between listing and signaling) and is never itself a reason a
 * survivor stays alive. A survivor with no recorded reason was signaled successfully but had not exited by the time the
 * bounded wait gave up (an exit delay, not a signal failure) and needs a manual per-PID check instead of a blind
 * retry.
 */
export type SignalFailureReason =
    | 'identity-unavailable'
    | 'identity-changed'
    | 'already-exited'
    | 'permission-denied'
    | 'signal-error';

interface SignalOutcome {
    ok: boolean;
    reason?: SignalFailureReason;
}

interface StopSurvivor extends ProcessEntry {
    /**
     * Set only when the most recent signal attempt for this PID did not land (never reaches `process.kill`, or
     * `process.kill` itself threw). Absent on a survivor whose signal was actually delivered.
     */
    closedReason?: SignalFailureReason;
}

const TERMINATION_POLL_MS = 250;
const TERMINATION_WAIT_MS = 5000;
const FORCE_WAIT_MS = 2000;

/**
 * Parses the process table with an optional start-time identity captured by the same `ps` invocation. Command lines
 * keep their spaces, so the fixed numeric and start-time columns are split off first. macOS may pad a process title
 * with trailing spaces; normalize those exactly as `getProcessIdentity` does before comparing ownership.
 */
export function parseProcessTable(stdout: string, hasIdentity = false): ProcessEntry[] {
    return stdout.split('\n').flatMap((line) => {
        const match = (
            hasIdentity
                ? /^\s*(?<pid>\d+)\s+(?<parentPid>\d+)\s+(?<identityText>(?<startedText>[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(?<command>\S.*))$/u
                : /^\s*(?<pid>\d+)\s+(?<parentPid>\d+)\s+(?<command>\S.*)$/u
        ).exec(line);
        const groups = match?.groups;
        if (!groups?.command) return [];
        return [
            {
                command: groups.command.trimEnd(),
                ...(groups.identityText && {
                    identity: createHash('sha256').update(groups.identityText.trim()).digest('hex'),
                }),
                parentPid: Number(groups.parentPid),
                pid: Number(groups.pid),
                ...(groups.startedText && { startedAt: Date.parse(groups.startedText) }),
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
 * invoked it, all of which run inside the worktree and would otherwise look owned.
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
    orphanMainPids = [],
    selfPid,
    worktreePath,
}: {
    entries: readonly ProcessEntry[];
    launcherPid?: number;
    orphanMainPids?: readonly number[];
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
    for (const pid of orphanMainPids) if (!protectedIds.has(pid)) seeds.add(pid);
    const targets = new Set([...seeds, ...descendantProcessIds(entries, seeds)]);
    return entries.filter((entry) => targets.has(entry.pid) && !protectedIds.has(entry.pid));
}

/**
 * The longest registered root wins, so a checkout nested inside another (`<primary>/.claude/worktrees/<name>`) is not
 * also attributed to its parent.
 */
function owningWorktree(command: string, worktreePaths: readonly string[]): string | undefined {
    return worktreePaths
        .filter((path) => isWorktreeOwnedCommand(command, path))
        .toSorted((left, right) => right.length - left.length)[0];
}

/**
 * Finds worktree-owned processes that nothing is supervising any more, grouped by owning worktree path.
 *
 * A process counts only when the top of its parent chain (the ancestor launchd adopted, PPID 1) is itself
 * worktree-owned or is an orphaned `Caxri Dev` window. A live `switch-worktree dev` launcher, a Playwright run, or an
 * agent shell sits at that position for every supervised run, so those subtrees never qualify, including a backgrounded
 * launcher that launchd has already adopted.
 *
 * Server Core is spawned detached (`packages/client/src/supervise/launch.ts`) so a restarted Desktop can adopt it;
 * after a dev main-process restart it legitimately runs under PPID 1 beside a live window. A worktree that still has
 * any supervised owned process therefore reports nothing: its detached Server is presumed adopted.
 *
 * This is a read-only report: an orphan may still belong to a sibling session, so callers print it and leave
 * termination to `stop` in the owning worktree.
 *
 * @see https://github.com/tjx666/caxri/issues/1231
 */
export function findOrphanedProcesses(
    entries: readonly ProcessEntry[],
    worktreePaths: readonly string[],
): Map<string, ProcessEntry[]> {
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    const topOfChain = (entry: ProcessEntry): ProcessEntry => {
        const seen = new Set<number>();
        let current = entry;
        while (current.parentPid > 1 && !seen.has(current.pid)) {
            seen.add(current.pid);
            const parent = byPid.get(current.parentPid);
            if (!parent) break;
            current = parent;
        }
        return current;
    };
    const orphans = new Map<string, Map<number, ProcessEntry>>();
    const supervised = new Set<string>();
    for (const entry of entries) {
        const worktreePath = owningWorktree(entry.command, worktreePaths);
        if (!worktreePath) continue;
        const top = topOfChain(entry);
        const isOrphanWindow = top.parentPid === 1 && top.command === 'Caxri Dev';
        const isUnsupervised =
            top.parentPid === 1 &&
            (isOrphanWindow || Boolean(owningWorktree(top.command, worktreePaths)));
        if (!isUnsupervised) {
            supervised.add(worktreePath);
            continue;
        }
        const group = orphans.get(worktreePath) ?? new Map<number, ProcessEntry>();
        group.set(entry.pid, entry);
        if (isOrphanWindow) group.set(top.pid, top);
        orphans.set(worktreePath, group);
    }
    return new Map(
        orphans
            .entries()
            .filter(([path]) => !supervised.has(path))
            .map(([path, group]) => [
                path,
                group
                    .values()
                    .toArray()
                    .toSorted((left, right) => left.pid - right.pid),
            ]),
    );
}

/**
 * Only a worktree-owned child can nominate an orphaned dev window, and its cwd must confirm the exact checkout.
 */
async function orphanedMainProcesses(
    entries: readonly ProcessEntry[],
    worktreePath: string,
    operations: StopOperations,
): Promise<{ verified: number[]; unresolved: number[] }> {
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    const candidates = new Map(
        entries
            .filter((entry) => isWorktreeOwnedCommand(entry.command, worktreePath))
            .map((entry) => byPid.get(entry.parentPid))
            .filter((parent) => parent?.parentPid === 1 && parent.command === 'Caxri Dev')
            .map((parent) => [parent!.pid, parent!] as const),
    );
    const verified: number[] = [];
    const unresolved: number[] = [];
    for (const [pid, candidate] of candidates) {
        // eslint-disable-next-line no-await-in-loop -- bounded candidate set; identity and cwd are checked before signaling.
        const identity = await operations.identity(pid);
        // eslint-disable-next-line no-await-in-loop -- an orphan is not owned until its cwd is confirmed.
        const cwd = await operations.cwd(pid);
        // eslint-disable-next-line no-await-in-loop -- detect PID reuse during the cwd lookup.
        const currentIdentity = await operations.identity(pid);
        const isSameProcess = Boolean(
            candidate.identity &&
            identity === candidate.identity &&
            // eslint-disable-next-line unicorn/prefer-simple-condition-first -- compare the initial snapshot before the final identity read.
            currentIdentity === identity,
        );
        if (isSameProcess && cwd === worktreePath) verified.push(pid);
        else if (!isSameProcess || cwd === undefined) unresolved.push(pid);
    }
    return { verified, unresolved };
}

export async function listProcesses(): Promise<ProcessEntry[]> {
    return parseProcessTable(
        await runCapture('ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command='], process.cwd()),
        true,
    );
}

export const defaultStopOperations: StopOperations = {
    list: listProcesses,
    identity: getProcessIdentity,
    cwd: async (pid) => {
        try {
            const output = await runCapture(
                'lsof',
                ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
                process.cwd(),
            );
            return output
                .split('\n')
                .find((line) => line.startsWith('n'))
                ?.slice(1);
        } catch {
            return;
        }
    },
    signalProcess: (pid, signal) => {
        try {
            process.kill(pid, signal);
            return { ok: true };
        } catch (error) {
            /**
             * `process.kill` throws a Node errno error; classify it instead of swallowing it, so a genuine failure (the
             * signal was refused) is never indistinguishable from the benign case (the process already exited) or from
             * a survivor that is simply slow to exit after a signal that landed fine.
             *
             * @see https://github.com/tjx666/caxri/issues/1179
             */
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ESRCH') return { ok: false, reason: 'already-exited' };
            if (code === 'EPERM') return { ok: false, reason: 'permission-denied' };
            return { ok: false, reason: 'signal-error' };
        }
    },
    wait: (milliseconds) => sleep(milliseconds),
};

export interface StopProcessesResult {
    stopped: ProcessEntry[];
    survivors: StopSurvivor[];
}

/**
 * Read-only ownership snapshot used by stop and by worktree removal's live-profile guard.
 */
export async function inspectWorktreeProcesses(
    input: { launcherPid?: number; selfPid: number; worktreePath: string },
    operations: StopOperations = defaultStopOperations,
): Promise<{ entries: ProcessEntry[]; owned: ProcessEntry[]; unresolved: ProcessEntry[] }> {
    const entries = await operations.list();
    const orphaned = await orphanedMainProcesses(entries, input.worktreePath, operations);
    return {
        entries,
        owned: worktreeProcessesToStop({ entries, ...input, orphanMainPids: orphaned.verified }),
        unresolved: entries.filter((entry) => orphaned.unresolved.includes(entry.pid)),
    };
}

async function survivingTargets(
    operations: StopOperations,
    targetsByPid: ReadonlyMap<number, ProcessEntry>,
): Promise<ProcessEntry[]> {
    return (await operations.list()).filter((entry) => {
        const target = targetsByPid.get(entry.pid);
        return Boolean(target?.identity && entry.identity === target.identity);
    });
}

/**
 * A PID is never signal authority after its captured process start identity changes. Every target that does not end in
 * a delivered signal gets a closed reason recorded instead of being silently skipped, so a caller can tell a refused
 * signal apart from a stale identity or a process that simply has not exited yet.
 */
async function signalMatchingTargets(
    targets: readonly ProcessEntry[],
    operations: StopOperations,
    signal: NodeJS.Signals,
): Promise<Map<number, SignalFailureReason>> {
    const failures = new Map<number, SignalFailureReason>();
    for (const target of targets) {
        if (!target.identity) {
            failures.set(target.pid, 'identity-unavailable');
            continue;
        }
        // eslint-disable-next-line no-await-in-loop -- each target needs its own current identity before signaling.
        const currentIdentity = await operations.identity(target.pid);
        if (currentIdentity !== target.identity) {
            failures.set(target.pid, 'identity-changed');
            continue;
        }
        const outcome = operations.signalProcess(target.pid, signal);
        if (outcome && !outcome.ok) failures.set(target.pid, outcome.reason ?? 'signal-error');
    }
    return failures;
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
    const targetsByPid = new Map(targets.map((entry) => [entry.pid, entry]));
    const signalFailures = new Map<number, SignalFailureReason>();
    const recordFailures = (round: Map<number, SignalFailureReason>): void => {
        for (const [pid, reason] of round) signalFailures.set(pid, reason);
    };
    recordFailures(await signalMatchingTargets(targets, operations, 'SIGTERM'));
    let remaining: ProcessEntry[] = targets as ProcessEntry[];
    for (let waited = 0; waited < TERMINATION_WAIT_MS; waited += TERMINATION_POLL_MS) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        await operations.wait(TERMINATION_POLL_MS);
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        remaining = await survivingTargets(operations, targetsByPid);
        if (remaining.length === 0) return { stopped: [...targets], survivors: [] };
    }
    recordFailures(await signalMatchingTargets(remaining, operations, 'SIGKILL'));
    for (let waited = 0; waited < FORCE_WAIT_MS; waited += TERMINATION_POLL_MS) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for force-terminated processes to exit
        await operations.wait(TERMINATION_POLL_MS);
        // eslint-disable-next-line no-await-in-loop -- bounded wait for force-terminated processes to exit
        remaining = await survivingTargets(operations, targetsByPid);
        if (remaining.length === 0) break;
    }
    return {
        stopped: targets.filter((entry) => remaining.every((alive) => alive.pid !== entry.pid)),
        // A reason only ever describes the final round it was recorded in: once a target exits, its earlier
        // SIGTERM-round reason (e.g. a transient identity race) must not be attributed to a later survivor read.
        survivors: remaining.map((entry) => {
            const closedReason = signalFailures.get(entry.pid);
            return closedReason ? { ...entry, closedReason } : entry;
        }),
    };
}

/**
 * A worktree-owned process discovered only after an earlier round's targets are gone gets at most this many of its own
 * stop rounds. A genuine dev-session tree (a detached Server Core chained through Extension Host and a PTY shell)
 * settles within one or two extra rounds; the bound exists only so a process that kept spawning fresh owned descendants
 * forever could not turn `stop` into an unbounded loop.
 */
const MAX_STOP_ROUNDS = 4;

/**
 * Repeatedly re-enumerates ownership and stops whatever is newly found, instead of stopping only the processes visible
 * in the very first snapshot. A process that had not finished forking yet, or that only becomes independently
 * path-owned once its supervisor exits (a detached Server Core's PTY shell, reparented to launchd), is invisible to
 * that first snapshot; without another round, `stop` would confirm it is worktree-owned and then simply report it as an
 * unexplained survivor without ever having signaled it. A round stops early once it produces a genuine survivor (a
 * signal that failed or a process that would not exit); retrying further rounds cannot help a target that already
 * resisted both signals in this one.
 *
 * A trailing read-only re-enumeration re-confirms the settled state afterward so a process that restarted mid-stop, or
 * one this bounded loop never got to, is still reported accurately rather than assumed clean.
 *
 * @see https://github.com/tjx666/caxri/issues/1179
 */
export async function stopWorktreeProcesses(
    input: { launcherPid?: number; selfPid: number; worktreePath: string },
    operations: StopOperations = defaultStopOperations,
): Promise<StopProcessesResult> {
    const stopped = new Map<number, ProcessEntry>();
    const attempted = new Set<number>();
    let lastRoundSurvivors: StopSurvivor[] = [];
    for (let round = 0; round < MAX_STOP_ROUNDS; round += 1) {
        // eslint-disable-next-line no-await-in-loop -- each round must observe the previous round's effect first.
        const snapshot = await inspectWorktreeProcesses(input, operations);
        const targets = snapshot.owned.filter((entry) => !attempted.has(entry.pid));
        if (targets.length === 0) {
            lastRoundSurvivors = [];
            break;
        }
        for (const entry of targets) attempted.add(entry.pid);
        // eslint-disable-next-line no-await-in-loop -- bounded, sequential rounds by design; see MAX_STOP_ROUNDS.
        const result = await stopProcesses(targets, operations);
        for (const entry of result.stopped) stopped.set(entry.pid, entry);
        lastRoundSurvivors = result.survivors;
        if (result.survivors.length > 0) break;
        // eslint-disable-next-line no-await-in-loop -- let a freshly-exited descendant settle before the next scan.
        await operations.wait(TERMINATION_POLL_MS);
    }
    const final = await inspectWorktreeProcesses(input, operations);
    // `lastRoundSurvivors` carries each PID's closed reason; list it last so a duplicate PID re-discovered by the
    // fresh `final` ownership scan (which has no signal-failure information of its own) never overwrites that reason.
    const survivors = new Map(
        [...final.owned, ...final.unresolved, ...lastRoundSurvivors].map((entry) => [
            entry.pid,
            entry,
        ]),
    );
    return {
        stopped: stopped
            .values()
            .filter((entry) => !survivors.has(entry.pid))
            .toArray(),
        survivors: survivors.values().toArray(),
    };
}
