import { describe, expect, it } from 'vitest';

import { attachLogFields } from '../attach-log';

describe('attachLogFields', () => {
    it('reports a sized live attachment with byte counts only', () => {
        expect(
            attachLogFields({
                payloadBytes: 1234,
                size: { cols: 90, rows: 25 },
                source: 'live',
                terminalId: 'terminal-1',
                wasAttached: false,
            }),
        ).toEqual({
            terminalId: 'terminal-1',
            source: 'live',
            wasAttached: false,
            payloadBytes: 1234,
            cols: 90,
            rows: 25,
        });
    });

    it('omits grid fields for an unsized persisted attachment', () => {
        expect(
            attachLogFields({
                payloadBytes: 0,
                source: 'persisted',
                terminalId: 'terminal-2',
                wasAttached: true,
            }),
        ).toEqual({
            terminalId: 'terminal-2',
            source: 'persisted',
            wasAttached: true,
            payloadBytes: 0,
        });
    });
});
