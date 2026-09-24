import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import type { DesktopLeaseHandle } from './desktop-lease';
import {
    acquireDesktopLease,
    assertDesktopLeasesReleased,
    beginDesktopLeaseHandoff,
    inspectDesktopLease,
    reclaimDesktopLeasesByOwner,
    reclaimStaleCiDesktopLeases,
    releaseDesktopLease,
    transferDesktopLease,
} from './desktop-lease';
import { runCapture } from './process';
import { writeJsonAtomic } from './repo';

const temporaryDirectories: string[] = [];
const activeLeases: DesktopLeaseHandle[] = [];

async function createRepo(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-desktop-namespace-'));
    temporaryDirectories.push(temporary);
    const root = join(temporary, 'repository');
    await mkdir(root);
    await runCapture('git', ['init', '-b', 'main'], root);
    await runCapture('git', ['config', 'user.email', 'caxri@example.invalid'], root);
    await runCapture('git', ['config', 'user.name', 'Caxri Test'], root);
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await runCapture('git', ['add', 'README.md'], root);
    await runCapture('git', ['commit', '-m', 'initial'], root);
    return root;
}

afterEach(async () => {
    const leasesToRelease = activeLeases.toReversed();
    activeLeases.length = 0;
    // Leases must release in reverse acquisition order: releasing a coordinator
    // while its worker leases are still held throws, so this loop cannot run in parallel.
    // eslint-disable-next-line no-await-in-loop -- sequential LIFO release order is required
    for (const lease of leasesToRelease) await releaseDesktopLease(lease);

    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('desktop lease worker namespaces', () => {
    it('waits through atomic attempts and times out without taking an active desktop', async () => {
        const root = await createRepo();
        const first = await acquireDesktopLease(root, 'first owner');
        activeLeases.push(first);
        await expect(
            acquireDesktopLease(root, 'short waiter', process.pid, { waitMs: 50 }),
        ).rejects.toThrow(/first owner.*PID \d+, held for \d+s.*Waited 0\.05s/u);

        const firstAttempt = Promise.withResolvers<void>();
        const waiting = acquireDesktopLease(root, 'patient waiter', process.pid, {
            waitMs: 1_000,
            afterLockAcquired: () => {
                firstAttempt.resolve();
                return Promise.resolve();
            },
        });
        await firstAttempt.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await releaseDesktopLease(first);
        activeLeases.splice(activeLeases.indexOf(first), 1);

        const acquired = await waiting;
        activeLeases.push(acquired);
        expect(acquired.worktreePath).toBe(first.worktreePath);
        expect((await readFile(acquired.leasePath, 'utf8')).length).toBeGreaterThan(0);
    });

    it('persists a CI owner and reclaims only its verified-dead leases', async () => {
        const root = await createRepo();
        const previousOwner = process.env.CAXRI_DESKTOP_LEASE_OWNER;
        process.env.CAXRI_DESKTOP_LEASE_OWNER = 'caxri-42-1-control';
        try {
            const lease = await acquireDesktopLease(root, 'owned CI desktop');
            const stored = JSON.parse(
                await readFile(lease.leasePath, 'utf8'),
            ) as DesktopLeaseHandle;
            expect(stored.owner).toBe('caxri-42-1-control');
            await writeJsonAtomic(lease.leasePath, { ...stored, identity: 'dead-owner-identity' });

            await expect(reclaimDesktopLeasesByOwner(root, 'caxri-41-1-control')).resolves.toBe(0);
            await expect(assertDesktopLeasesReleased(root)).rejects.toThrow('is stale');
            await expect(reclaimDesktopLeasesByOwner(root, 'caxri-42-1-control')).resolves.toBe(1);
            await expect(assertDesktopLeasesReleased(root)).resolves.toBeUndefined();
        } finally {
            if (previousOwner === undefined) delete process.env.CAXRI_DESKTOP_LEASE_OWNER;
            else process.env.CAXRI_DESKTOP_LEASE_OWNER = previousOwner;
        }
    });

    it('reclaims only dead leases from a previous checked-in CI job owner', async () => {
        const root = await createRepo();
        const previousOwner = process.env.CAXRI_DESKTOP_LEASE_OWNER;
        process.env.CAXRI_DESKTOP_LEASE_OWNER = 'caxri-42-1-e2e';
        try {
            const coordinator = await acquireDesktopLease(root, 'stale CI coordinator');
            const worker = await acquireDesktopLease(root, 'stale CI worker', process.pid, {
                coordinatorToken: coordinator.token,
                namespace: 'e2e-worker-0',
            });
            const storedCoordinator = JSON.parse(
                await readFile(coordinator.leasePath, 'utf8'),
            ) as DesktopLeaseHandle;
            const storedWorker = JSON.parse(
                await readFile(worker.leasePath, 'utf8'),
            ) as DesktopLeaseHandle;
            await Promise.all([
                writeJsonAtomic(coordinator.leasePath, {
                    ...storedCoordinator,
                    identity: 'dead-coordinator-identity',
                }),
                writeJsonAtomic(worker.leasePath, {
                    ...storedWorker,
                    identity: 'dead-worker-identity',
                }),
            ]);

            await expect(reclaimStaleCiDesktopLeases(root)).resolves.toBe(2);
            await expect(assertDesktopLeasesReleased(root)).resolves.toBeUndefined();
        } finally {
            if (previousOwner === undefined) delete process.env.CAXRI_DESKTOP_LEASE_OWNER;
            else process.env.CAXRI_DESKTOP_LEASE_OWNER = previousOwner;
        }
    });

    it('keeps a stale manual lease fail-closed during CI recovery', async () => {
        const root = await createRepo();
        const previousOwner = process.env.CAXRI_DESKTOP_LEASE_OWNER;
        delete process.env.CAXRI_DESKTOP_LEASE_OWNER;
        try {
            const lease = await acquireDesktopLease(root, 'manual desktop');
            const stored = JSON.parse(
                await readFile(lease.leasePath, 'utf8'),
            ) as DesktopLeaseHandle;
            await writeJsonAtomic(lease.leasePath, {
                ...stored,
                identity: 'dead-manual-identity',
            });

            await expect(reclaimStaleCiDesktopLeases(root)).resolves.toBe(0);
            await expect(assertDesktopLeasesReleased(root)).rejects.toThrow('is stale');
        } finally {
            if (previousOwner !== undefined) process.env.CAXRI_DESKTOP_LEASE_OWNER = previousOwner;
        }
    });

    it('refuses to reclaim a live lease from a checked-in CI job owner', async () => {
        const root = await createRepo();
        const previousOwner = process.env.CAXRI_DESKTOP_LEASE_OWNER;
        process.env.CAXRI_DESKTOP_LEASE_OWNER = 'caxri-42-1-checks';
        try {
            const lease = await acquireDesktopLease(root, 'live CI desktop');
            activeLeases.push(lease);
            await expect(reclaimStaleCiDesktopLeases(root)).rejects.toThrow(
                'Refusing to reclaim live desktop lease live CI desktop',
            );
        } finally {
            if (previousOwner === undefined) delete process.env.CAXRI_DESKTOP_LEASE_OWNER;
            else process.env.CAXRI_DESKTOP_LEASE_OWNER = previousOwner;
        }
    });

    it('isolates namespaced leases under one repository-wide coordinator', async () => {
        const root = await createRepo();
        const coordinator = await acquireDesktopLease(root, 'repository desktop');
        activeLeases.push(coordinator);
        const first = await acquireDesktopLease(root, 'parallel worker 0', process.pid, {
            coordinatorToken: coordinator.token,
            namespace: 'e2e-worker-0',
        });
        activeLeases.push(first);
        const second = await acquireDesktopLease(root, 'parallel worker 1', process.pid, {
            coordinatorToken: coordinator.token,
            namespace: 'e2e-worker-1',
        });
        activeLeases.push(second);

        expect(first.leasePath).toContain('desktop-lease-e2e-worker-0.json');
        expect(second.leasePath).toContain('desktop-lease-e2e-worker-1.json');
        await expect(
            acquireDesktopLease(root, 'uncoordinated worker', process.pid, {
                namespace: 'e2e-worker-2',
            }),
        ).rejects.toThrow('active repository-wide coordinator');
    });

    it('reclaims a dead worker namespace without disturbing its coordinator', async () => {
        const root = await createRepo();
        const coordinator = await acquireDesktopLease(root, 'parallel pool coordinator');
        activeLeases.push(coordinator);
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
            stdio: 'ignore',
        });
        await once(child, 'spawn');
        const childPid = child.pid;
        if (!childPid) throw new Error('Test child process has no PID');
        let worker = await acquireDesktopLease(root, 'parallel worker 0', process.pid, {
            coordinatorToken: coordinator.token,
            namespace: 'e2e-worker-0',
        });
        worker = await beginDesktopLeaseHandoff(worker);
        worker = await transferDesktopLease(worker, childPid);

        child.kill('SIGTERM');
        await once(child, 'exit');
        const replacement = await acquireDesktopLease(root, 'replacement worker 0', process.pid, {
            coordinatorToken: coordinator.token,
            namespace: 'e2e-worker-0',
        });
        activeLeases.push(replacement);
        expect(replacement.token).not.toBe(worker.token);
        expect(await inspectDesktopLease(root)).toMatchObject({
            lease: { token: coordinator.token },
            state: 'active',
        });
    });

    it('refuses to release a coordinator while a worker child still owns the desktop', async () => {
        const root = await createRepo();
        const coordinator = await acquireDesktopLease(root, 'parallel pool coordinator');
        activeLeases.push(coordinator);
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
            stdio: 'ignore',
        });
        await once(child, 'spawn');
        const childPid = child.pid;
        if (!childPid) throw new Error('Test child process has no PID');
        let worker = await acquireDesktopLease(root, 'parallel worker 0', process.pid, {
            coordinatorToken: coordinator.token,
            namespace: 'e2e-worker-0',
        });
        activeLeases.push(worker);
        worker = await beginDesktopLeaseHandoff(worker);
        worker = await transferDesktopLease(worker, childPid);
        activeLeases[activeLeases.length - 1] = worker;

        await expect(releaseDesktopLease(coordinator)).rejects.toThrow('is still active');
        child.kill('SIGTERM');
        await once(child, 'exit');
    });

    it('reclaims dead worker leases before a new repository-wide owner starts', async () => {
        const root = await createRepo();
        const coordinator = await acquireDesktopLease(root, 'old coordinator');
        const worker = await acquireDesktopLease(root, 'old worker', process.pid, {
            coordinatorToken: coordinator.token,
            namespace: 'e2e-worker-0',
        });
        const stored = JSON.parse(await readFile(worker.leasePath, 'utf8')) as DesktopLeaseHandle;
        await writeJsonAtomic(worker.leasePath, { ...stored, identity: 'dead-worker-identity' });
        await unlink(coordinator.leasePath);
        const replacement = await acquireDesktopLease(root, 'new coordinator');
        activeLeases.push(replacement);
        expect(await inspectDesktopLease(root, { namespace: 'e2e-worker-0' })).toEqual({
            state: 'free',
        });
    });
});
