import { describe, expect, it } from 'vitest';

import {
    TerminalBackpressureRecovery,
    TerminalReplayBuffer,
    TerminalReplayCoordinator,
} from '../terminal-replay';

describe('TerminalReplayBuffer', () => {
    it('waits for each write before applying output received during attach', async () => {
        const writes: string[] = [];
        const completions: Array<() => void> = [];
        const buffer = new TerminalReplayBuffer(
            (value) =>
                new Promise<void>((resolve) => {
                    writes.push(value);
                    completions.push(resolve);
                }),
        );

        buffer.push('live-output');
        const restoration = buffer.restore('older-snapshot');
        buffer.push('during-snapshot');

        expect(writes).toEqual(['older-snapshot']);
        completions.shift()?.();
        await Promise.resolve();
        expect(writes).toEqual(['older-snapshot', 'live-output']);
        completions.shift()?.();
        await Promise.resolve();
        expect(writes).toEqual(['older-snapshot', 'live-output', 'during-snapshot']);
        completions.shift()?.();
        await restoration;

        buffer.push('later-output');
        expect(writes).toEqual([
            'older-snapshot',
            'live-output',
            'during-snapshot',
            'later-output',
        ]);
    });

    it('bounds initial replay output and emits one aggregated marker after the retained prefix', async () => {
        const writes: string[] = [];
        const snapshotWrite = Promise.withResolvers<void>();
        const buffer = new TerminalReplayBuffer(
            (value) => {
                writes.push(value);
                return snapshotWrite.promise;
            },
            { maximumPendingBytes: 5, maximumPendingItems: 2 },
        );

        const restoration = buffer.restore('snapshot');
        buffer.push('ab');
        buffer.push('cd');
        buffer.push('ef');
        buffer.push('gh');

        snapshotWrite.resolve();
        await restoration;

        expect(writes).toEqual([
            'snapshot',
            'ab',
            'cd',
            '\r\n[Caxri dropped 4 bytes while terminal output was replaying]\r\n',
        ]);
    });

    it('counts UTF-8 bytes and preserves only a code point-safe prefix', async () => {
        const writes: string[] = [];
        const snapshotWrite = Promise.withResolvers<void>();
        const buffer = new TerminalReplayBuffer(
            (value) => {
                writes.push(value);
                return snapshotWrite.promise;
            },
            { maximumPendingBytes: 3, maximumPendingItems: 1 },
        );

        const restoration = buffer.restore('snapshot');
        buffer.push('éé');

        snapshotWrite.resolve();
        await restoration;

        expect(writes).toEqual([
            'snapshot',
            'é',
            '\r\n[Caxri dropped 2 bytes while terminal output was replaying]\r\n',
        ]);
    });

    it('drops all later output after the retained prefix reaches its first gap', async () => {
        const writes: string[] = [];
        const snapshotWrite = Promise.withResolvers<void>();
        const buffer = new TerminalReplayBuffer(
            (value) => {
                writes.push(value);
                return snapshotWrite.promise;
            },
            { maximumPendingBytes: 8, maximumPendingItems: 3 },
        );

        const restoration = buffer.restore('snapshot');
        buffer.push('\u{1B}[31mA');
        buffer.push('🙂');
        buffer.push('z');
        snapshotWrite.resolve();
        await restoration;

        expect(writes).toEqual([
            'snapshot',
            '\u{1B}[31mA',
            '\r\n[Caxri dropped 5 bytes while terminal output was replaying]\r\n',
        ]);
    });

    it('requests screen recovery instead of rendering a gap marker when configured', async () => {
        const writes: string[] = [];
        const dropped: number[] = [];
        const snapshotWrite = Promise.withResolvers<void>();
        const buffer = new TerminalReplayBuffer(
            (value) => {
                writes.push(value);
                return snapshotWrite.promise;
            },
            {
                maximumPendingBytes: 4,
                maximumPendingItems: 2,
                onDroppedOutput: (droppedBytes) => dropped.push(droppedBytes),
            },
        );

        const restoration = buffer.restore('snapshot');
        buffer.push('ab');
        buffer.push('cd');
        buffer.push('ef');
        buffer.push('gh');
        snapshotWrite.resolve();
        await restoration;

        expect(writes).toEqual(['snapshot', 'ab', 'cd']);
        expect(dropped).toEqual([4]);
    });
});

describe('TerminalBackpressureRecovery', () => {
    it('serializes recovery and coalesces repeated drops into one follow-up snapshot', async () => {
        const attempts: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
        const failures: unknown[] = [];
        const recovery = new TerminalBackpressureRecovery(
            () => {
                const attempt = Promise.withResolvers<void>();
                attempts.push(attempt);
                return attempt.promise;
            },
            (error) => failures.push(error),
        );

        recovery.request();
        recovery.request();
        recovery.request();
        expect(attempts).toHaveLength(1);

        attempts[0]?.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(attempts).toHaveLength(2);

        attempts[1]?.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(attempts).toHaveLength(2);
        expect(failures).toEqual([]);
    });

    it('reports one failed attachment without retrying when no later drop is observed', async () => {
        const failures: unknown[] = [];
        let attempts = 0;
        const recovery = new TerminalBackpressureRecovery(
            () => {
                attempts += 1;
                return Promise.reject(new Error('offline'));
            },
            (error) => failures.push(error),
        );

        recovery.request();
        await Promise.resolve();
        await Promise.resolve();

        expect(attempts).toBe(1);
        expect(failures).toHaveLength(1);
    });

    it('retries once when another drop is observed during a failed attachment', async () => {
        const attempts: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
        const failures: unknown[] = [];
        const recovery = new TerminalBackpressureRecovery(
            () => {
                const attempt = Promise.withResolvers<void>();
                attempts.push(attempt);
                return attempt.promise;
            },
            (error) => failures.push(error),
        );

        recovery.request();
        recovery.request();
        attempts[0]?.reject(new Error('offline'));
        await Promise.resolve();
        await Promise.resolve();
        expect(attempts).toHaveLength(2);
        expect(failures).toHaveLength(1);

        attempts[1]?.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(attempts).toHaveLength(2);
    });

    it('suppresses attachment failures after disposal', async () => {
        const attempt = Promise.withResolvers<void>();
        const failures: unknown[] = [];
        const recovery = new TerminalBackpressureRecovery(
            () => attempt.promise,
            (error) => failures.push(error),
        );

        recovery.request();
        recovery.dispose();
        attempt.reject(new Error('disposed'));
        await Promise.resolve();
        await Promise.resolve();

        expect(failures).toEqual([]);
    });
});

describe('TerminalReplayCoordinator', () => {
    it('settles an early reattachment when disposed before the initial snapshot returns', async () => {
        let snapshotLoads = 0;
        const coordinator = new TerminalReplayCoordinator(
            () => Promise.resolve(),
            () => {},
        );
        const reattachment = coordinator.reattach(() => {
            snapshotLoads += 1;
            return Promise.resolve(null);
        });

        coordinator.dispose();
        await reattachment;

        expect(snapshotLoads).toBe(0);
    });

    it('does not replace the screen when disposed during an in-flight snapshot request', async () => {
        const events: string[] = [];
        const snapshot = Promise.withResolvers<{
            cols: number;
            payload: string;
            rows: number;
        }>();
        const coordinator = new TerminalReplayCoordinator(
            (value) => {
                events.push(`write:${value}`);
                return Promise.resolve();
            },
            () => events.push('reset'),
        );
        await coordinator.restoreInitial(null);

        const reattachment = coordinator.reattach(() => snapshot.promise);
        await Promise.resolve();
        coordinator.dispose();
        snapshot.resolve({ cols: 80, payload: 'late-screen', rows: 24 });
        await reattachment;

        expect(events).toEqual([]);
    });

    it('keeps an early reattachment separate from the still-pending initial snapshot', async () => {
        const events: string[] = [];
        const freshSnapshot = Promise.withResolvers<{
            cols: number;
            payload: string;
            rows: number;
        }>();
        const coordinator = new TerminalReplayCoordinator(
            (value) => {
                events.push(`write:${value}`);
                return Promise.resolve();
            },
            () => events.push('reset'),
        );

        const reattachment = coordinator.reattach(() => freshSnapshot.promise);
        coordinator.push('post-gap-output');
        await coordinator.restoreInitial({ cols: 80, payload: 'initial-screen', rows: 24 });
        freshSnapshot.resolve({ cols: 80, payload: 'fresh-screen', rows: 24 });
        await reattachment;

        expect(events).toEqual([
            'write:initial-screen',
            'reset',
            'write:fresh-screen',
            'write:post-gap-output',
        ]);
    });

    it('replaces a stale mounted screen and replays output received during reattachment', async () => {
        const events: string[] = [];
        const snapshot = Promise.withResolvers<{ cols: number; payload: string; rows: number }>();
        const coordinator = new TerminalReplayCoordinator(
            (value) => {
                events.push(`write:${value}`);
                return Promise.resolve();
            },
            () => {
                events.push('reset');
            },
            {
                beginSnapshot: () => events.push('begin'),
                finishSnapshot: () => events.push('finish'),
                prepareSnapshot: ({ cols, rows }) => events.push(`prepare:${cols}x${rows}`),
            },
        );
        await coordinator.restoreInitial({ cols: 80, payload: 'old-screen', rows: 24 });

        const reattachment = coordinator.reattach(() => snapshot.promise);
        await Promise.resolve();
        coordinator.push('live-output');
        expect(events).toEqual(['begin', 'prepare:80x24', 'write:old-screen', 'finish', 'begin']);

        snapshot.resolve({ cols: 40, payload: 'restored-screen', rows: 12 });
        await reattachment;
        expect(events).toEqual([
            'begin',
            'prepare:80x24',
            'write:old-screen',
            'finish',
            'begin',
            'prepare:40x12',
            'reset',
            'write:restored-screen',
            'write:live-output',
            'finish',
        ]);
    });

    it('finishes the snapshot lifecycle when a reattachment request fails', async () => {
        const events: string[] = [];
        const coordinator = new TerminalReplayCoordinator(
            () => Promise.resolve(),
            () => events.push('reset'),
            {
                beginSnapshot: () => events.push('begin'),
                finishSnapshot: () => events.push('finish'),
            },
        );
        await coordinator.restoreInitial(null);

        await expect(
            coordinator.reattach(() => Promise.reject(new Error('offline'))),
        ).rejects.toThrow('offline');

        expect(events).toEqual(['begin', 'finish', 'begin', 'finish']);
    });

    it('bounds output while a reattachment snapshot is slow', async () => {
        const writes: string[] = [];
        const snapshot = Promise.withResolvers<{ cols: number; payload: string; rows: number }>();
        const coordinator = new TerminalReplayCoordinator(
            (value) => {
                writes.push(`write:${value}`);
                return Promise.resolve();
            },
            () => {
                writes.push('reset');
            },
            { maximumPendingBytes: 5, maximumPendingItems: 2 },
        );
        await coordinator.restoreInitial({ cols: 80, payload: 'old-screen', rows: 24 });

        const reattachment = coordinator.reattach(() => snapshot.promise);
        await Promise.resolve();
        coordinator.push('ab');
        coordinator.push('cd');
        coordinator.push('ef');
        coordinator.push('gh');
        snapshot.resolve({ cols: 80, payload: 'restored-screen', rows: 24 });
        await reattachment;

        expect(writes).toEqual([
            'write:old-screen',
            'reset',
            'write:restored-screen',
            'write:ab',
            'write:cd',
            'write:\r\n[Caxri dropped 4 bytes while terminal output was replaying]\r\n',
        ]);
    });

    it('routes output behind the newest snapshot as soon as reattachment is requested', async () => {
        const events: string[] = [];
        const firstSnapshot = Promise.withResolvers<{
            cols: number;
            payload: string;
            rows: number;
        }>();
        const secondSnapshot = Promise.withResolvers<{
            cols: number;
            payload: string;
            rows: number;
        }>();
        const coordinator = new TerminalReplayCoordinator(
            (value) => {
                events.push(`write:${value}`);
                return Promise.resolve();
            },
            () => events.push('reset'),
        );
        await coordinator.restoreInitial({ cols: 80, payload: 'initial-screen', rows: 24 });

        const firstReattachment = coordinator.reattach(() => firstSnapshot.promise);
        await Promise.resolve();
        const secondReattachment = coordinator.reattach(() => secondSnapshot.promise);
        coordinator.push('newest-live-output');

        firstSnapshot.resolve({ cols: 80, payload: 'first-screen', rows: 24 });
        await firstReattachment;
        expect(events).toEqual(['write:initial-screen', 'reset', 'write:first-screen']);

        secondSnapshot.resolve({ cols: 80, payload: 'second-screen', rows: 24 });
        await secondReattachment;
        expect(events).toEqual([
            'write:initial-screen',
            'reset',
            'write:first-screen',
            'reset',
            'write:second-screen',
            'write:newest-live-output',
        ]);
    });
});
