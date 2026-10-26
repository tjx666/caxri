import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import { reapGroup } from '../../process-group';
import { chatStateStore } from '../chat-state-store';
import { ProviderProcess } from '../provider-process';
import type { ProcessTableEntry, ProviderGroupLedger } from '../provider-process-groups';
import { reapStaleProviderGroups } from '../provider-process-groups';

const STARTED = 'Tue Oct 20 10:00:00 2026';

function memoryLedger(
    groups: Array<{ pgid: number; leaderStartedAt: string }>,
): ProviderGroupLedger & { remaining(): number[] } {
    const rows = new Map<number, ReturnType<ProviderGroupLedger['list']>[number]>(
        groups.map((group) => [group.pgid, { ...group, terminalId: 'terminal' }]),
    );
    return {
        record: (group) => {
            rows.set(group.pgid, group);
        },
        forget: (pgid, leaderStartedAt) => {
            if (
                leaderStartedAt === undefined ||
                rows.get(pgid)?.leaderStartedAt === leaderStartedAt
            )
                rows.delete(pgid);
        },
        list: () => Array.from(rows.values()),
        remaining: () => Array.from(rows.keys()),
    };
}

async function sweep(table: ProcessTableEntry[], ledger: ProviderGroupLedger) {
    const reap = vi.fn<(pgid: number) => Promise<void>>(() => Promise.resolve());
    const write = vi.fn<StructuredLogger['write']>();
    await reapStaleProviderGroups({
        ledger: () => ledger,
        logger: { write } as unknown as StructuredLogger,
        reapGroup: reap,
        readTable: () => Promise.resolve(table),
    });
    return { reap, write };
}

describe('reapStaleProviderGroups with a fake process table', () => {
    it('stops a group whose leader is alive with the recorded start time', async () => {
        const ledger = memoryLedger([{ pgid: 500, leaderStartedAt: STARTED }]);
        const { reap, write } = await sweep(
            [
                { pid: 500, pgid: 500, startedAt: STARTED },
                { pid: 501, pgid: 500, startedAt: STARTED },
            ],
            ledger,
        );
        expect(reap).toHaveBeenCalledExactlyOnceWith(500);
        expect(ledger.remaining()).toEqual([]);
        expect(write.mock.calls[0][2]?.fields).toMatchObject({ recorded: 1, reaped: 1, reused: 0 });
    });

    it('stops the survivors of a group whose leader already exited', async () => {
        const ledger = memoryLedger([{ pgid: 500, leaderStartedAt: STARTED }]);
        const { reap } = await sweep(
            [{ pid: 777, pgid: 500, startedAt: 'Tue Oct 20 10:00:05 2026' }],
            ledger,
        );
        expect(reap).toHaveBeenCalledExactlyOnceWith(500);
    });

    it('never signals a reused group ID, whose leader started at another time', async () => {
        const ledger = memoryLedger([{ pgid: 500, leaderStartedAt: STARTED }]);
        const { reap, write } = await sweep(
            [{ pid: 500, pgid: 500, startedAt: 'Tue Oct 20 11:30:00 2026' }],
            ledger,
        );
        expect(reap).not.toHaveBeenCalled();
        expect(ledger.remaining()).toEqual([]);
        expect(write.mock.calls[0][2]?.fields).toMatchObject({ reaped: 0, reused: 1 });
    });

    it('never signals members older than the recorded leader', async () => {
        const ledger = memoryLedger([{ pgid: 500, leaderStartedAt: STARTED }]);
        const { reap } = await sweep(
            [{ pid: 800, pgid: 500, startedAt: 'Tue Oct 20 09:00:00 2026' }],
            ledger,
        );
        expect(reap).not.toHaveBeenCalled();
    });

    it('only forgets a group that is already empty', async () => {
        const ledger = memoryLedger([{ pgid: 500, leaderStartedAt: STARTED }]);
        const { reap, write } = await sweep([{ pid: 1, pgid: 1, startedAt: STARTED }], ledger);
        expect(reap).not.toHaveBeenCalled();
        expect(ledger.remaining()).toEqual([]);
        expect(write.mock.calls[0][2]?.fields).toMatchObject({ gone: 1 });
    });

    it('keeps the records when the process table cannot be read', async () => {
        const ledger = memoryLedger([{ pgid: 500, leaderStartedAt: STARTED }]);
        const reap = vi.fn<(pgid: number) => Promise<void>>(() => Promise.resolve());
        await reapStaleProviderGroups({
            ledger: () => ledger,
            logger: { write: vi.fn() } as unknown as StructuredLogger,
            reapGroup: reap,
            readTable: () => Promise.reject(new Error('ps missing')),
        });
        expect(reap).not.toHaveBeenCalled();
        expect(ledger.remaining()).toEqual([500]);
    });
});

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

describe.skipIf(process.platform === 'win32')(
    'stale provider groups after a killed Server Core',
    () => {
        async function spawnLeftover() {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-provider-groups-'));
            const database = new CaxriDatabase(join(directory, 'state.db'));
            onTestFinished(async () => {
                database.close();
                await rm(directory, { recursive: true, force: true });
            });
            // A provider whose background tool shares its process group, the way an Agent's dev server does.
            const provider = new ProviderProcess({
                executable: 'sh',
                args: ['-c', 'sleep 60 & wait'],
                cwd: directory,
                environment: process.env,
                processGroups: {
                    terminalId: 'terminal',
                    ledger: chatStateStore(database).processGroups,
                },
            });
            const pgid = provider.pid!;
            onTestFinished(async () => {
                try {
                    process.kill(-pgid, 'SIGKILL');
                } catch {
                    // Already gone.
                }
                await reapGroup(pgid);
            });
            await vi.waitFor(
                () => expect(chatStateStore(database).processGroups.list()).toHaveLength(1),
                {
                    timeout: 5_000,
                },
            );
            return { database, pgid };
        }

        it('stops the group a previous lifetime recorded and forgets the record', async () => {
            const { database, pgid } = await spawnLeftover();
            // The previous Server Core was SIGKILLed here: nothing reaped the group, and the next start sweeps it.
            const write = vi.fn<StructuredLogger['write']>();
            await reapStaleProviderGroups({
                ledger: () => chatStateStore(database).processGroups,
                logger: { write } as unknown as StructuredLogger,
                reapGroup,
            });
            await vi.waitFor(() => expect(isAlive(pgid)).toBe(false), { timeout: 5_000 });
            expect(chatStateStore(database).processGroups.list()).toEqual([]);
            expect(write.mock.calls[0][2]?.fields).toMatchObject({ recorded: 1, reaped: 1 });
        });

        it('leaves a live group alone when its recorded start time does not match', async () => {
            const { database, pgid } = await spawnLeftover();
            // The same ID, recorded by a lifetime whose group ended: the live group is a stranger's.
            chatStateStore(database).processGroups.record({
                pgid,
                terminalId: 'terminal',
                leaderStartedAt: 'Mon Jan  1 00:00:00 2024',
            });
            await reapStaleProviderGroups({
                ledger: () => chatStateStore(database).processGroups,
                logger: { write: vi.fn() } as unknown as StructuredLogger,
                reapGroup,
            });
            expect(isAlive(pgid)).toBe(true);
            expect(chatStateStore(database).processGroups.list()).toEqual([]);
        });
    },
);
