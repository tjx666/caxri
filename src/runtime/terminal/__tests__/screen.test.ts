import { describe, expect, it } from 'vitest';

import { TerminalScreenState } from '../screen';

describe('TerminalScreenState', () => {
    it('keeps writes and coalesced resizes ordered before a snapshot barrier', async () => {
        const screen = new TerminalScreenState('', 20, 4);

        screen.write('first');
        for (let columns = 21; columns <= 200; columns += 1) screen.resize(columns, 4);
        screen.write('\r\nlatest');
        const snapshot = await screen.snapshot();

        expect(snapshot.payload).toContain('first');
        expect(snapshot.payload).toContain('latest');
        screen.dispose();
    });
});
