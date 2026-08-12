import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CommandError, getProcessIdentity, isProcessIdentityAlive } from './process';
import {
    ensureProfile,
    errorCode,
    repositoryContext,
    unlinkIfExists,
    withRepositoryLock,
    worktreeIdentity,
    writeJsonAtomic,
} from './repository';

interface DesktopLease {
    acquiredAt: string;
    handoffPending?: boolean;
    identity: string;
    label: string;
    pid: number;
    token: string;
    worktreeId: string;
    worktreePath: string;
}

export interface DesktopLeaseHandle extends DesktopLease {
    leasePath: string;
}

export interface DesktopLeaseOptions {
    /** Test seam for holding the repository lock across a competing acquisition. */
    afterLockAcquired?: () => Promise<void>;
    /** Proves a worker namespace is subordinate to the active repository-wide coordinator. */
    coordinatorToken?: string;
    /** Explicit sub-lease used only while a repository-wide coordinator owns the desktop. */
    namespace?: string;
}

export interface DesktopLeaseReleaseOptions {
    /** Test seam for proving a competing acquisition waits for release cleanup. */
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
    for (const name of names.filter((value) => /^desktop-lease-[a-z0-9-]+\.json$/u.test(value))) {
        const path = join(stateDirectory, name);
        const worker = await readLease(path);
        if (!worker) continue;
        if (worker.handoffPending || (await isProcessIdentityAlive(worker.pid, worker.identity))) {
            throw new CommandError(
                `Desktop worker ${worker.label} is still active; inspect ${path} before releasing its coordinator`,
            );
        }
        await unlinkIfExists(path);
    }
}

export async function inspectDesktopLease(
    cwd: string,
    options: Pick<DesktopLeaseOptions, 'namespace'> = {},
): Promise<DesktopLeaseStatus> {
    const context = await repositoryContext(cwd);
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

/** Acquire the repository-wide macOS desktop surface before starting Electron. */
export async function acquireDesktopLease(
    cwd: string,
    label: string,
    ownerPid = process.pid,
    options: DesktopLeaseOptions = {},
): Promise<DesktopLeaseHandle> {
    const context = await repositoryContext(cwd);
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
        pid: ownerPid,
        token: randomUUID(),
        worktreeId,
        worktreePath: context.root,
    };

    return await withRepositoryLock(context, async () => {
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
            /** A crashed coordinator may leave only worker leases. Reclaim verified-dead workers,
             *  but never let a new desktop owner overlap a surviving Electron child. */
            await cleanWorkerLeases(context.stateDir);
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const handle = await open(path, 'wx');
                try {
                    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, 'utf8');
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                return { ...lease, leasePath: path };
            } catch (error) {
                if (errorCode(error) !== 'EEXIST') throw error;
                const current = await readLease(path);
                if (!current) continue;
                if (await isProcessIdentityAlive(current.pid, current.identity)) {
                    throw new CommandError(
                        `Desktop is in use by ${current.label} in ${current.worktreePath} (PID ${current.pid})`,
                    );
                }
                if (current.handoffPending)
                    throw new CommandError(
                        `Desktop handoff from ${current.label} did not complete; inspect ${path} before continuing`,
                    );
                if (!options.namespace) await cleanWorkerLeases(context.stateDir);
                /** The repository lock keeps another contender from replacing this stale path
                 *  between the identity check and unlink. */
                await unlinkIfExists(path);
            }
        }
        throw new CommandError('Could not acquire the repository desktop lease');
    });
}

/** Mark the lease fail-closed before spawning a child that will take ownership. */
export async function beginDesktopLeaseHandoff(
    handle: DesktopLeaseHandle,
): Promise<DesktopLeaseHandle> {
    const context = await repositoryContext(handle.worktreePath);
    return await withRepositoryLock(context, async () => {
        const current = await readLease(handle.leasePath);
        if (!current || current.token !== handle.token)
            throw new CommandError('Desktop lease ownership changed before handoff');
        const pending = { ...current, handoffPending: true };
        await writeJsonAtomic(handle.leasePath, pending);
        return { ...pending, leasePath: handle.leasePath };
    });
}

/** Transfer ownership after Electron starts so a surviving app keeps the lease fail-closed. */
export async function transferDesktopLease(
    handle: DesktopLeaseHandle,
    ownerPid: number,
): Promise<DesktopLeaseHandle> {
    const identity = await getProcessIdentity(ownerPid);
    if (!identity) throw new CommandError(`Could not establish Electron PID ${ownerPid} identity`);
    const context = await repositoryContext(handle.worktreePath);
    return await withRepositoryLock(context, async () => {
        const current = await readLease(handle.leasePath);
        if (!current || current.token !== handle.token)
            throw new CommandError('Desktop lease ownership changed before transfer');
        const transferred = { ...current, handoffPending: undefined, identity, pid: ownerPid };
        await writeJsonAtomic(handle.leasePath, transferred);
        return { ...transferred, leasePath: handle.leasePath };
    });
}

export async function releaseDesktopLease(
    handle: DesktopLeaseHandle,
    options: DesktopLeaseReleaseOptions = {},
): Promise<void> {
    const context = await repositoryContext(handle.worktreePath);
    await withRepositoryLock(context, async () => {
        await options.afterLockAcquired?.();
        const current = await readLease(handle.leasePath);
        if (!current) return;
        if (current.token !== handle.token) {
            throw new CommandError('Refusing to release a desktop lease owned by another process');
        }
        if (handle.leasePath === leasePath(context.stateDir)) {
            /** The coordinator remains fail-closed until every worker child is gone. */
            await cleanWorkerLeases(context.stateDir);
        }
        await unlinkIfExists(handle.leasePath);
    });
}
