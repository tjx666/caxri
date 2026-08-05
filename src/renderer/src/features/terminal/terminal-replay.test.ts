import { describe, expect, it } from 'vitest';

import { TerminalReplayBuffer } from './terminal-replay';

describe('TerminalReplayBuffer', () => {
    it('writes the restored snapshot before output received during attach', () => {
        const writes: string[] = [];
        const buffer = new TerminalReplayBuffer((value) => writes.push(value));

        buffer.push('live-output');
        buffer.restore('older-snapshot');
        buffer.push('later-output');

        expect(writes).toEqual(['older-snapshot', 'live-output', 'later-output']);
    });
});
