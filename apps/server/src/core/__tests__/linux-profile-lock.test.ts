import { mkdtemp, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LinuxLockOptions, LockSquatReport } from '../linux-profile-lock';
import {
    acquireLinuxProcessLock,
    MAX_LOCK_NAMES,
    parseAbstractSockets,
} from '../linux-profile-lock';

const directories: string[] = [];

afterEach(async () => {
    const paths = [...directories];
    directories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-linux-lock-'));
    directories.push(directory);
    return join(directory, 'owner.lock');
}

/**
 * The kernel's abstract namespace as `/proc/net/unix` shows it: every bound name with its socket inode, and which of
 * those inodes a process of this account holds.
 */
function fakeKernel() {
    const holders = new Map<string, { inode: string; isOwn: boolean }>();
    const attempts: string[] = [];
    let nextInode = 100;
    let isProcHidden = false;
    const options = (reports: LockSquatReport[] = []): LinuxLockOptions => ({
        uid: 1000,
        onSquatted: (report) => reports.push(report),
        bind: (path) => {
            const name = path.slice(1);
            attempts.push(name);
            if (holders.has(name))
                return Promise.reject(Object.assign(new Error('in use'), { code: 'EADDRINUSE' }));
            holders.set(name, { inode: String((nextInode += 1)), isOwn: true });
            return Promise.resolve({
                close: (done: () => void) => {
                    holders.delete(name);
                    done();
                },
            } as unknown as Server);
        },
        probe: {
            abstractSockets: () =>
                isProcHidden
                    ? Promise.reject(new Error('EACCES'))
                    : Promise.resolve(
                          new Map([...holders].map(([name, holder]) => [name, [holder.inode]])),
                      ),
            ownSocketInodes: () =>
                Promise.resolve(
                    new Set(
                        holders
                            .values()
                            .filter((holder) => holder.isOwn)
                            .map((holder) => holder.inode),
                    ),
                ),
        },
    });
    return {
        attempts,
        holders,
        options,
        hideProc: () => {
            isProcHidden = true;
        },
        squat: (name: string) =>
            holders.set(name, { inode: String((nextInode += 1)), isOwn: false }),
    };
}

describe('Linux profile lock', () => {
    it('admits one owner and keeps its name secret from other accounts', async () => {
        const path = await lockPath();
        const kernel = fakeKernel();
        // A name another account could predict without reading this profile no longer blocks it.
        kernel.squat('caxri-profile-1000-0123456789abcdef');
        const lock = await acquireLinuxProcessLock(path, kernel.options());
        expect(kernel.attempts[0]).toMatch(/^caxri-profile-1000-[\da-f]{32}$/u);
        expect((await stat(join(path, '..', 'lock-secret'))).mode & 0o777).toBe(0o600);

        await expect(acquireLinuxProcessLock(path, kernel.options())).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'A Host already owns this profile',
        });
        await lock.close();
        await (await acquireLinuxProcessLock(path, kernel.options())).close();
    });

    it('moves past a name another account squatted after observing it', async () => {
        const path = await lockPath();
        const kernel = fakeKernel();
        await (await acquireLinuxProcessLock(path, kernel.options())).close();
        const [observed] = kernel.attempts;
        kernel.squat(observed);

        const reports: LockSquatReport[] = [];
        const lock = await acquireLinuxProcessLock(path, kernel.options(reports));
        expect(reports).toEqual([{ outcome: 'acquired', squattedNames: 1 }]);
        expect(kernel.attempts.at(-1)).not.toBe(observed);
        // Exclusion still holds on the moved name.
        await expect(acquireLinuxProcessLock(path, kernel.options())).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await lock.close();
    });

    it('yields when the squatter frees a lower name while its own Server holds a higher one', async () => {
        const path = await lockPath();
        const kernel = fakeKernel();
        await (await acquireLinuxProcessLock(path, kernel.options())).close();
        const [first] = kernel.attempts;
        kernel.squat(first);
        const running = await acquireLinuxProcessLock(path, kernel.options());
        kernel.holders.delete(first);

        await expect(acquireLinuxProcessLock(path, kernel.options())).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        // The yielding start released the lower name it had bound.
        expect(kernel.holders.has(first)).toBe(false);
        await running.close();
    });

    it('treats an unidentifiable holder as a conflict instead of skipping it', async () => {
        const path = await lockPath();
        const kernel = fakeKernel();
        await (await acquireLinuxProcessLock(path, kernel.options())).close();
        kernel.squat(kernel.attempts[0]);
        kernel.hideProc();

        const reports: LockSquatReport[] = [];
        await expect(acquireLinuxProcessLock(path, kernel.options(reports))).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'A Host already owns this profile',
        });
        expect(reports).toEqual([]);
    });

    it('reports exhaustion when another account holds every name', async () => {
        const path = await lockPath();
        const probe = fakeKernel();
        // Learn the whole series by squatting each name once a start has revealed it.
        for (let index = 0; index < MAX_LOCK_NAMES; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- each start reveals the next name in the series
            const lock = await acquireLinuxProcessLock(path, probe.options());
            const name = probe.attempts.at(-1)!;
            // eslint-disable-next-line no-await-in-loop -- see above
            await lock.close();
            probe.squat(name);
        }

        const reports: LockSquatReport[] = [];
        await expect(acquireLinuxProcessLock(path, probe.options(reports))).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(reports).toEqual([{ outcome: 'exhausted', squattedNames: MAX_LOCK_NAMES }]);
    });

    it('shares one secret between concurrent first starts', async () => {
        const path = await lockPath();
        const kernel = fakeKernel();
        const results = await Promise.allSettled([
            acquireLinuxProcessLock(path, kernel.options()),
            acquireLinuxProcessLock(path, kernel.options()),
        ]);
        expect(
            results
                .map((result) => result.status)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['fulfilled', 'rejected']);
        await Promise.all(
            results
                .filter((result) => result.status === 'fulfilled')
                .map((result) => result.value.close()),
        );
    });

    it('reads abstract names from /proc/net/unix without letting a forged row hide the real holder', () => {
        const table = [
            'Num       RefCount Protocol Flags    Type St Inode Path',
            '0000000000000000: 00000002 00000000 00010000 0001 01 501 @caxri-profile-1000-own',
            '0000000000000000: 00000002 00000000 00010000 0001 01 502 /run/user/1000/bus',
            // Another account bound `caxri-profile-1000-own x`: one column too many, so it names nothing.
            '0000000000000000: 00000002 00000000 00010000 0001 01 503 @caxri-profile-1000-own x',
            // A name with an embedded newline forging a row for this account's name with its own inode.
            '0000000000000000: 00000002 00000000 00010000 0001 01 504 @junk',
            '0000000000000000: 00000002 00000000 00010000 0001 01 504 @caxri-profile-1000-own',
        ].join('\n');
        const sockets = parseAbstractSockets(table);
        expect(sockets.get('caxri-profile-1000-own')).toEqual(['501', '504']);
        expect(sockets.has('/run/user/1000/bus')).toBe(false);
        expect(sockets.has('caxri-profile-1000-own x')).toBe(false);
    });
});
