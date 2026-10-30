import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { CommandError, getProcessIdentity, isProcessIdentityAlive } from './process';
import {
    didWriteJsonExclusive,
    ensureProfile,
    errorCode,
    repoContext,
    unlinkIfExists,
    withRepoLock,
    worktreeIdentity,
    writeJsonAtomic,
} from './repo';

interface DesktopLease {
    acquiredAt: string;
    handoffPending?: boolean;
    identity: string;
    label: string;
    namespace?: string;
    pid: number;
    token: string;
    worktreeId: string;
    worktreePath: string;
}

export interface DesktopLeaseHandle extends DesktopLease {
    leasePath: string;
}

export interface DesktopLeaseOptions {
    /**
     * Test seam for holding the repository lock across a competing acquisition.
     */
    afterLockAcquired?: () => Promise<void>;
    /**
     * Proves a worker namespace is subordinate to the active repository-wide coordinator.
     */
    coordinatorToken?: string;
    /**
     * Explicit sub-lease used only while a repository-wide coordinator owns the desktop.
     */
    namespace?: string;
    /**
     * Bounded active-owner wait; every retry reacquires the repository lock before attempting an atomic claim.
     */
    waitMs?: number;
}

/**
 * A live owner holds the lease. Exported so a caller can recognize contention by type and point at its own wait option.
 */
export class DesktopLeaseBusyError extends CommandError {
    constructor(current: DesktopLease) {
        const elapsedSeconds = (Date.now() - Date.parse(current.acquiredAt)) / 1000;
        const leaseAge = Number.isFinite(elapsedSeconds)
            ? `${Math.max(0, Math.floor(elapsedSeconds))}s`
            : 'an unknown duration';
        super(
            `Desktop is in use by ${current.label} in ${current.worktreePath} ` +
                `(PID ${current.pid}, held for ${leaseAge}). Stop that desktop task or retry after it finishes.`,
        );
    }
}

export interface DesktopLeaseReleaseOptions {
    /**
     * Test seam for proving a competing acquisition waits for release cleanup.
     */
    afterLockAcquired?: () => Promise<void>;
}

export type DesktopLeaseStatus =
    { lease?: undefined; state: 'free' } | { lease: DesktopLease; state: 'active' | 'stale' };

function parseLease(value: string, path: string): DesktopLease {
    let lease: unknown;
    try {
        lease = JSON.parse(value);
    } catch {
        throw new CommandError(`Invalid desktop lease at ${path}; inspect it before continuing`);
    }
    const candidate = lease as Partial<DesktopLease>;
    if (
        typeof candidate.acquiredAt !== 'string' ||
        (candidate.handoffPending !== undefined && typeof candidate.handoffPending !== 'boolean') ||
        typeof candidate.identity !== 'string' ||
        typeof candidate.label !== 'string' ||
        (candidate.namespace !== undefined && typeof candidate.namespace !== 'string') ||
        typeof candidate.pid !== 'number' ||
        typeof candidate.token !== 'string' ||
        typeof candidate.worktreeId !== 'string' ||
        typeof candidate.worktreePath !== 'string'
    ) {
        throw new CommandError(`Invalid desktop lease at ${path}; inspect it before continuing`);
    }
    return candidate as DesktopLease;
}

async function readLease(path: string): Promise<DesktopLease | undefined> {
    try {
        return parseLease(await readFile(path, 'utf8'), path);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
    }
}

function leasePath(stateDirectory: string, namespace?: string): string {
    if (!namespace) return join(stateDirectory, 'desktop-lease.json');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(namespace)) {
        throw new CommandError(`Invalid desktop lease namespace: ${namespace}`);
    }
    return join(stateDirectory, `desktop-lease-${namespace}.json`);
}

async function cleanWorkerLeases(stateDirectory: string): Promise<void> {
    let names: string[];
    try {
        names = await readdir(stateDirectory);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }
    const workerNames = names.filter((value) => /^desktop-lease-[a-z0-9-]+\.json$/u.test(value));
    const workerPaths = workerNames.map((name) => join(stateDirectory, name));
    const workers = await Promise.all(workerPaths.map((path) => readLease(path)));
    // Check every worker for activity before unlinking any of them, so a lease found active
    // partway through leaves no workers deleted (fail-closed rather than partially cleaned).
    const activeFlags = await Promise.all(
        workers.map(async (worker) => {
            if (!worker) return false;
            // Intentional `||`: `false` must also fall through to the aliveness check, not just
            // `undefined`. `??` would treat a non-pending (`false`) worker as inactive without
            // ever probing its process, which is not the intended semantics.
            return (
                // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- see comment above
                worker.handoffPending || (await isProcessIdentityAlive(worker.pid, worker.identity))
            );
        }),
    );
    const activeIndex = activeFlags.indexOf(true);
    if (activeIndex !== -1) {
        const worker = workers[activeIndex]!;
        const path = workerPaths[activeIndex];
        throw new CommandError(
            `Desktop worker ${worker.label} is still active; inspect ${path} before releasing its coordinator`,
        );
    }
    const livingWorkerPaths = workerPaths.filter((_path, index) => workers[index]);
    await Promise.all(livingWorkerPaths.map((path) => unlinkIfExists(path)));
}

export async function inspectDesktopLease(
    cwd: string,
    options: Pick<DesktopLeaseOptions, 'namespace'> = {},
): Promise<DesktopLeaseStatus> {
    const context = await repoContext(cwd);
    const lease = await readLease(leasePath(context.stateDir, options.namespace));
    if (!lease) return { state: 'free' };
    return {
        lease,
        state:
            lease.handoffPending || (await isProcessIdentityAlive(lease.pid, lease.identity))
                ? 'active'
                : 'stale',
    };
}

/**
 * Acquire the repository-wide macOS desktop surface before starting Electron.
 */
export async function acquireDesktopLease(
    cwd: string,
    label: string,
    ownerPid = process.pid,
    options: DesktopLeaseOptions = {},
): Promise<DesktopLeaseHandle> {
    const context = await repoContext(cwd);
    const worktreeId = await worktreeIdentity(context.root, true);
    const identity = await getProcessIdentity(ownerPid);
    if (!worktreeId || !identity)
        throw new CommandError('Could not establish the desktop lease owner identity');
    await ensureProfile(context, worktreeId);
    const path = leasePath(context.stateDir, options.namespace);
    await mkdir(context.stateDir, { recursive: true });
    const lease: DesktopLease = {
        acquiredAt: new Date().toISOString(),
        identity,
        label,
        ...(options.namespace && { namespace: options.namespace }),
        pid: ownerPid,
        token: randomUUID(),
        worktreeId,
        worktreePath: context.root,
    };

    const waitMs = options.waitMs ?? 0;
    if (!Number.isFinite(waitMs) || waitMs < 0)
        throw new CommandError('Desktop lease wait must be a nonnegative finite duration');
    const deadline = Date.now() + waitMs;
    const acquireOnce = (): Promise<DesktopLeaseHandle> =>
        withRepoLock(
            context,
            async () => {
                await options.afterLockAcquired?.();
                if (options.namespace) {
                    const coordinator = await readLease(leasePath(context.stateDir));
                    if (
                        !coordinator ||
                        coordinator.token !== options.coordinatorToken ||
                        !(await isProcessIdentityAlive(coordinator.pid, coordinator.identity))
                    ) {
                        throw new CommandError(
                            'Namespaced desktop leases require the active repository-wide coordinator',
                        );
                    }
                }
                if (!options.namespace && !(await readLease(path))) {
                    /**
                     * A crashed coordinator may leave only worker leases. Reclaim verified-dead workers, but never let
                     * a new desktop owner overlap a surviving Electron child.
                     */
                    await cleanWorkerLeases(context.stateDir);
                }
                // Each retry attempt depends on the outcome of the previous one (open, then inspect and
                // possibly clear a stale lease before retrying), so the awaits below cannot run in parallel.
                /* eslint-disable no-await-in-loop -- sequential retry: each attempt depends on the prior one */
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    /**
                     * The lease must appear atomically: `inspectDesktopLease` deliberately polls without the repository
                     * lock, so an `open('wx')` followed by a separate write would expose a partially written file and
                     * fail parsing mid-acquisition.
                     */
                    const pendingLease = { ...lease, acquiredAt: new Date().toISOString() };
                    if (await didWriteJsonExclusive(path, pendingLease))
                        return { ...pendingLease, leasePath: path };
                    const current = await readLease(path);
                    if (!current) continue;
                    if (await isProcessIdentityAlive(current.pid, current.identity)) {
                        throw new DesktopLeaseBusyError(current);
                    }
                    if (current.handoffPending)
                        throw new CommandError(
                            `Desktop handoff from ${current.label} did not complete; inspect ${path} before continuing`,
                        );
                    if (!options.namespace) await cleanWorkerLeases(context.stateDir);
                    /**
                     * The resource-scoped repository lock keeps another contender from replacing this stale path
                     * between the identity check and unlink.
                     */
                    await unlinkIfExists(path);
                }
                /* eslint-enable no-await-in-loop */
                throw new CommandError('Could not acquire the repository desktop lease');
            },
            {
                namespace: options.namespace,
                /**
                 * A caller willing to wait for a busy lease also waits out a sibling's slow repository operation, such
                 * as `switch-worktree create` fetching under load, instead of failing after the lock's default 10s
                 * after an Android Acceptance round had already spent minutes building its APK.
                 */
                ...(waitMs > 0 && { timeoutMs: Math.max(10_000, deadline - Date.now()) }),
            },
        );
    /* eslint-disable no-await-in-loop -- each retry must acquire the repository lock and attempt atomic creation. */
    for (;;) {
        try {
            return await acquireOnce();
        } catch (error) {
            if (waitMs === 0 || !(error instanceof DesktopLeaseBusyError)) throw error;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                throw new CommandError(`${error.message} Waited ${waitMs / 1000}s.`);
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
        }
    }
    /* eslint-enable no-await-in-loop */
}

/**
 * Mark the lease fail-closed before spawning a child that will take ownership.
 */
export async function beginDesktopLeaseHandoff(
    handle: DesktopLeaseHandle,
): Promise<DesktopLeaseHandle> {
    const context = await repoContext(handle.worktreePath);
    return withRepoLock(
        context,
        async () => {
            const current = await readLease(handle.leasePath);
            if (!current || current.token !== handle.token)
                throw new CommandError('Desktop lease ownership changed before handoff');
            const pending = { ...current, handoffPending: true };
            await writeJsonAtomic(handle.leasePath, pending);
            return { ...pending, leasePath: handle.leasePath };
        },
        { namespace: handle.namespace },
    );
}

/**
 * Transfer ownership after Electron starts so a surviving app keeps the lease fail-closed.
 */
export async function transferDesktopLease(
    handle: DesktopLeaseHandle,
    ownerPid: number,
): Promise<DesktopLeaseHandle> {
    const identity = await getProcessIdentity(ownerPid);
    if (!identity) throw new CommandError(`Could not establish Electron PID ${ownerPid} identity`);
    const context = await repoContext(handle.worktreePath);
    return withRepoLock(
        context,
        async () => {
            const current = await readLease(handle.leasePath);
            if (!current || current.token !== handle.token)
                throw new CommandError('Desktop lease ownership changed before transfer');
            const transferred = { ...current, handoffPending: undefined, identity, pid: ownerPid };
            await writeJsonAtomic(handle.leasePath, transferred);
            return { ...transferred, leasePath: handle.leasePath };
        },
        { namespace: handle.namespace },
    );
}

export async function releaseDesktopLease(
    handle: DesktopLeaseHandle,
    options: DesktopLeaseReleaseOptions = {},
): Promise<void> {
    const context = await repoContext(handle.worktreePath);
    await withRepoLock(
        context,
        async () => {
            await options.afterLockAcquired?.();
            const current = await readLease(handle.leasePath);
            if (!current) return;
            if (current.token !== handle.token) {
                throw new CommandError(
                    'Refusing to release a desktop lease owned by another process',
                );
            }
            if (handle.leasePath === leasePath(context.stateDir)) {
                /**
                 * The coordinator remains fail-closed until every worker child is gone.
                 */
                await cleanWorkerLeases(context.stateDir);
            }
            await unlinkIfExists(handle.leasePath);
        },
        { namespace: handle.namespace },
    );
}
