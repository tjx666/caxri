import { describe, expect, it } from 'vitest';

import { ChatTurnInterruption } from '../chat-turn-interruption';

describe('ChatTurnInterruption', () => {
    it('removes a rejected Stop without losing another accepted attempt', () => {
        const interruption = new ChatTurnInterruption();
        const rejectFirst = interruption.request('turn-one');
        const rejectSecond = interruption.request('turn-one');
        rejectFirst();
        expect(interruption.reason('turn-one')).toBe('user');
        rejectSecond();
        expect(interruption.reason('turn-one')).toBeUndefined();
    });

    it('does not clear a new turn from an old rejection or completion', () => {
        const interruption = new ChatTurnInterruption();
        const rejectOld = interruption.request('turn-one');
        interruption.request('turn-two');
        rejectOld();
        interruption.clear('turn-one');
        expect(interruption.reason('turn-one')).toBeUndefined();
        expect(interruption.reason('turn-two')).toBe('user');
        interruption.clear('turn-two');
        expect(interruption.reason('turn-two')).toBeUndefined();
        expect(interruption.reason(undefined)).toBeUndefined();
    });
});
