import { describe, expect, it } from 'vitest';

import { isTurnEnded, isTurnNotSteerable } from '../../../chat-provider';
import { claudeExactTurnRefusal } from '../prompt-queue';

describe('claudeExactTurnRefusal', () => {
    it('refuses a redirect into the running turn because Claude Code may run it as the next turn', () => {
        const error = claudeExactTurnRefusal('turn-1', 'turn-1');
        expect(isTurnNotSteerable(error)).toBe(true);
        expect(isTurnEnded(error)).toBe(false);
    });

    it('reports a finished or replaced turn as ended', () => {
        expect(isTurnEnded(claudeExactTurnRefusal(undefined, 'turn-1'))).toBe(true);
        expect(isTurnEnded(claudeExactTurnRefusal('turn-2', 'turn-1'))).toBe(true);
    });
});
