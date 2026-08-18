import { describe, expect, it } from 'vitest';

import { TerminalReplayBuffer, TerminalReplayCoordinator } from '../terminal-replay';

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
});

describe('TerminalReplayCoordinator', () => {
    it('replaces a stale mounted screen and replays output received during reattachment', async () => {
        const events: string[] = [];
        const snapshot = Promise.withResolvers<string>();
        const coordinator = new TerminalReplayCoordinator(
            (value) => {
                events.push(`write:${value}`);
                return Promise.resolve();
            },
            () => {
                events.push('reset');
            },
        );
        await coordinator.restoreInitial('old-screen');

        const reattachment = coordinator.reattach(() => snapshot.promise);
        await Promise.resolve();
        coordinator.push('live-output');
        expect(events).toEqual(['write:old-screen']);

        snapshot.resolve('restored-screen');
        await reattachment;
        expect(events).toEqual([
            'write:old-screen',
            'reset',
            'write:restored-screen',
            'write:live-output',
        ]);
    });

    it('bounds output while a reattachment snapshot is slow', async () => {
        const writes: string[] = [];
        const snapshot = Promise.withResolvers<string>();
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
        await coordinator.restoreInitial('old-screen');

        const reattachment = coordinator.reattach(() => snapshot.promise);
        await Promise.resolve();
        coordinator.push('ab');
        coordinator.push('cd');
        coordinator.push('ef');
        coordinator.push('gh');
        snapshot.resolve('restored-screen');
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
});
