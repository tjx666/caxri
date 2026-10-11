import { describe, expect, it } from 'vitest';

import {
    COMMANDER_INBOX_DEFAULT_WIDTH,
    COMMANDER_INBOX_MAX_WIDTH,
    COMMANDER_INBOX_MIN_WIDTH,
    commanderInboxWidth,
} from '../commander-inbox-store';

describe('commanderInboxWidth', () => {
    it('restores a stored width inside the bounds', () => {
        expect(commanderInboxWidth('400')).toBe(400);
    });

    it('falls back to the default for a missing or malformed value', () => {
        expect(commanderInboxWidth(null)).toBe(COMMANDER_INBOX_DEFAULT_WIDTH);
        expect(commanderInboxWidth('wide')).toBe(COMMANDER_INBOX_DEFAULT_WIDTH);
    });

    it('clamps a width from an older bound back into range', () => {
        expect(commanderInboxWidth('90')).toBe(COMMANDER_INBOX_MIN_WIDTH);
        expect(commanderInboxWidth('2000')).toBe(COMMANDER_INBOX_MAX_WIDTH);
    });
});
