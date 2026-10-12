import { describe, expect, it } from 'vitest';

import { commanderInboxChipCopy, commanderStatusChipCopy } from '../commander-status-label';

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

describe('commanderInboxChipCopy', () => {
    it('holds no slot for an empty Inbox', () => {
        expect(commanderInboxChipCopy(0)).toBeUndefined();
    });

    it('counts open items with singular and plural agreement', () => {
        expect(commanderInboxChipCopy(1)?.text).toBe('1 needs you');
        expect(commanderInboxChipCopy(3)?.text).toBe('3 need you');
        expect(commanderInboxChipCopy(3)?.description).toMatch(/^Open Agent Commander: 3 items/);
    });
});
