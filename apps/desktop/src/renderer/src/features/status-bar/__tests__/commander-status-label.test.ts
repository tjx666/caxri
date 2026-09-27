import { describe, expect, it } from 'vitest';

import { commanderStatusChipCopy } from '../commander-status-label';

describe('commanderStatusChipCopy', () => {
    it('hides the chip while the Commander is stopped', () => {
        expect(commanderStatusChipCopy('stopped')).toBeUndefined();
    });

    it.each([
        ['starting', 'Commander starting'],
        ['working', 'Commander working'],
        ['waiting', 'Commander needs input'],
        ['idle', 'Commander idle'],
    ] as const)('labels a %s Commander and says where to stop it', (state, text) => {
        const copy = commanderStatusChipCopy(state);
        expect(copy?.text).toBe(text);
        expect(copy?.description).toContain('View > Stop Agent Commander');
    });
});
