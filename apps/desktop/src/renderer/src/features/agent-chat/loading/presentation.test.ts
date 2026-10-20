import type { AgentChatActivity, AgentToolKind } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    BUDDY_TIRED_AFTER_MS,
    buddyMood,
    buddyTiredAt,
    isBuddyPartyTurn,
    stripIndicator,
} from './presentation';

type BusyActivity = Exclude<AgentChatActivity, { kind: 'waiting' }>;

const working = (kind?: AgentToolKind, startedAt?: number): BusyActivity => ({
    kind: 'working',
    text: 'Working…',
    startedAt: 0,
    ...(kind && { work: { kind, startedAt } }),
});
const compacting: BusyActivity = {
    kind: 'compacting',
    text: 'Compacting…',
    isStoppable: true,
};

describe('buddyMood', () => {
    it('acts out the running tool and thinks between tools', () => {
        expect(buddyMood(working('read'))).toBe('read');
        expect(buddyMood(working('list'))).toBe('search');
        expect(buddyMood(working('command'))).toBe('run');
        expect(buddyMood(working('wait'))).toBe('wait');
        expect(buddyMood(working('mcp'))).toBe('think');
        expect(buddyMood(working())).toBe('think');
        expect(buddyMood(compacting)).toBe('compact');
        expect(buddyMood(undefined)).toBe('think');
    });
});

describe('buddyTiredAt', () => {
    it('tires of a long tool but not of thinking or waiting', () => {
        expect(buddyTiredAt(working('command', 1000))).toBe(1000 + BUDDY_TIRED_AFTER_MS);
        expect(buddyTiredAt(working('thought', 1000))).toBeUndefined();
        expect(buddyTiredAt(working('wait', 1000))).toBeUndefined();
        expect(buddyTiredAt(working('command'))).toBeUndefined();
        expect(buddyTiredAt(compacting)).toBeUndefined();
    });
});

describe('isBuddyPartyTurn', () => {
    it('is stable per turn and rare across turns', () => {
        const turns = Array.from({ length: 5000 }, (_, index) => `turn-${index}`);
        const parties = turns.filter((turn) => isBuddyPartyTurn(turn));
        expect(parties.length).toBeGreaterThan(50);
        expect(parties.length).toBeLessThan(200);
        expect(parties.every((turn) => isBuddyPartyTurn(turn))).toBe(true);
        expect(isBuddyPartyTurn(undefined)).toBe(false);
    });
});

describe('stripIndicator', () => {
    const playful = { workingIndicator: 'dots', animatesToolIcons: true } as const;

    it('lets Buddy lead when chosen', () => {
        expect(
            stripIndicator(working('search'), { ...playful, workingIndicator: 'buddy' }),
        ).toEqual({ kind: 'buddy', mood: 'search' });
    });

    it('shows the running tool, compaction, or the spinner between tools', () => {
        expect(stripIndicator(working('edit'), playful)).toEqual({ kind: 'glyph', glyph: 'edit' });
        expect(stripIndicator(compacting, playful)).toEqual({ kind: 'glyph', glyph: 'compact' });
        expect(stripIndicator(working(), playful)).toEqual({ kind: 'spinner' });
        expect(stripIndicator(working('edit'), { ...playful, animatesToolIcons: false })).toEqual({
            kind: 'spinner',
        });
    });
});
