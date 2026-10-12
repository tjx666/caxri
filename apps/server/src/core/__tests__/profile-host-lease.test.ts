import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostIdentity, HostLease } from '../profile-host-lease';
import { claimHostLease, HOST_LEASE_TTL_MS } from '../profile-host-lease';

const login1: HostIdentity = { hostId: 'login-1/aaaa', hostname: 'login-1' };
const login2: HostIdentity = { hostId: 'login-2/bbbb', hostname: 'login-2' };

const directories: string[] = [];
const leases: HostLease[] = [];

afterEach(async () => {
    const pendingLeases = [...leases];
    leases.length = 0;
    await Promise.all(pendingLeases.map((lease) => lease.release()));
    const pendingDirectories = [...directories];
    directories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function profileDirectory(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-host-lease-'));
    const directory = await realpath(temporary);
    directories.push(directory);
    return directory;
}

async function claim(
    directory: string,
    identity: HostIdentity,
    options: { now?: number; onLost?: (holder: string) => void; renewIntervalMs?: number } = {},
): Promise<HostLease> {
    const lease = await claimHostLease({
        directory,
        identity,
        ...(options.now !== undefined && { now: () => options.now! }),
        onLost: options.onLost ?? (() => {}),
        path: join(directory, 'host-lease.json'),
        processIdentity: `${identity.hostname}-process`,
        ...(options.renewIntervalMs !== undefined && { renewIntervalMs: options.renewIntervalMs }),
    });
    leases.push(lease);
    return lease;
}

describe('claimHostLease', () => {
    it('refuses while another host renewed the lease within the TTL, naming that host', async () => {
        const directory = await profileDirectory();
        await claim(directory, login1, { now: 1_000_000 });
        await expect(
            claim(directory, login2, { now: 1_000_000 + HOST_LEASE_TTL_MS - 1 }),
        ).rejects.toMatchObject({
            code: 'CONFLICT',
            details: { reason: 'profileInUse', hostname: 'login-1' },
        });
    });

    it('takes over a lease another host stopped renewing', async () => {
        const directory = await profileDirectory();
        await claim(directory, login1, { now: 1_000_000 });
        await claim(directory, login2, { now: 1_000_000 + HOST_LEASE_TTL_MS });
        const record = JSON.parse(
            await readFile(join(directory, 'host-lease.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(record).toMatchObject({ hostname: 'login-2', processIdentity: 'login-2-process' });
    });

    it('takes over a fresh lease left by a Server on the same host', async () => {
        const directory = await profileDirectory();
        await claim(directory, login1, { now: 1_000_000 });
        await expect(claim(directory, { ...login1 }, { now: 1_000_001 })).resolves.toBeDefined();
    });

    it('lets another host start right after the owner releases', async () => {
        const directory = await profileDirectory();
        const owner = await claim(directory, login1, { now: 1_000_000 });
        await owner.release();
        await expect(claim(directory, login2, { now: 1_000_001 })).resolves.toBeDefined();
    });

    it('treats an unreadable lease as absent', async () => {
        const directory = await profileDirectory();
        await writeFile(join(directory, 'host-lease.json'), 'not json', { mode: 0o600 });
        await expect(claim(directory, login2)).resolves.toBeDefined();
    });

    it('stops renewing and reports the new holder when another host overwrote the lease', async () => {
        const directory = await profileDirectory();
        const onLost = vi.fn<(holder: string) => void>();
        await claim(directory, login1, { onLost, renewIntervalMs: 20 });
        // Both hosts passed the empty-lease check in the same instant; login-2 wrote last.
        await writeFile(
            join(directory, 'host-lease.json'),
            JSON.stringify({
                hostId: login2.hostId,
                hostname: login2.hostname,
                processIdentity: 'login-2-process',
                renewedAt: Date.now(),
            }),
            { mode: 0o600 },
        );
        await vi.waitFor(() => expect(onLost).toHaveBeenCalledWith('login-2'));
        const record = JSON.parse(
            await readFile(join(directory, 'host-lease.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(record).toMatchObject({ hostname: 'login-2' });
    });
});
