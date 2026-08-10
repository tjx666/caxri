import { describe, expect, it } from 'vitest';

import { TerminalReplayBuffer, TerminalReplayCoordinator } from './terminal-replay';

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
            () => events.push('reset'),
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
});
