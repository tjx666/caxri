import { describe, expect, it } from 'vitest';

import { botInboxChipCopy, botStatusChipCopy } from '../bot-status-label';

describe('botStatusChipCopy', () => {
    it('hides the chip while Caxri Bot is stopped', () => {
        expect(botStatusChipCopy('stopped')).toBeUndefined();
    });

    it.each([
        ['starting', 'Caxri Bot starting'],
        ['working', 'Caxri Bot working'],
        ['waiting', 'Caxri Bot needs input'],
        ['idle', 'Caxri Bot idle'],
    ] as const)('labels a %s Caxri Bot and says where to stop it', (state, text) => {
        const copy = botStatusChipCopy(state);
        expect(copy?.text).toBe(text);
        expect(copy?.description).toContain('View > Stop Caxri Bot');
    });
});

describe('botInboxChipCopy', () => {
    it('holds no slot for an empty Inbox', () => {
        expect(botInboxChipCopy(0)).toBeUndefined();
    });

    it('counts open items with singular and plural agreement', () => {
        expect(botInboxChipCopy(1)?.text).toBe('1 needs you');
        expect(botInboxChipCopy(3)?.text).toBe('3 need you');
        expect(botInboxChipCopy(3)?.description).toMatch(/^Open Inbox: 3 Caxri Bot items/);
    });
});
