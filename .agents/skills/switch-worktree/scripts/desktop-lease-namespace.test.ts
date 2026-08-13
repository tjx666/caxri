import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    acquireDesktopLease,
    assertDesktopLeasesReleased,
    beginDesktopLeaseHandoff,
    inspectDesktopLease,
    reclaimDesktopLeasesByOwner,
    releaseDesktopLease,
    transferDesktopLease,
    type DesktopLeaseHandle,
} from './desktop-lease';
import { runCapture } from './process';
import { writeJsonAtomic } from './repository';

const temporaryDirectories: string[] = [];
const activeLeases: DesktopLeaseHandle[] = [];

async function createRepository(): Promise<string> {
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
    for (const lease of activeLeases.splice(0).reverse()) await releaseDesktopLease(lease);
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('desktop lease worker namespaces', () => {
    it('persists a CI owner and reclaims only its verified-dead leases', async () => {
        const root = await createRepository();
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

    it('isolates namespaced leases under one repository-wide coordinator', async () => {
        const root = await createRepository();
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
        const root = await createRepository();
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
        const root = await createRepository();
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
        const root = await createRepository();
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
