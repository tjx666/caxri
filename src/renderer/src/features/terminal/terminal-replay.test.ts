import { describe, expect, it } from 'vitest';

import { TerminalReplayBuffer } from './terminal-replay';

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
