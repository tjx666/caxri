import { describe, expect, it } from 'vitest';

import { isApprovalClickGuarded } from '../agent-chat-presentation';

describe('isApprovalClickGuarded', () => {
    it('ignores a pointer click inside the arm delay', () => {
        expect(isApprovalClickGuarded({ armDelayMs: 450, detail: 1, elapsedMs: 100 })).toBe(true);
        expect(isApprovalClickGuarded({ armDelayMs: 450, detail: 2, elapsedMs: 449 })).toBe(true);
    });

    it('accepts a pointer click once the delay has passed', () => {
        expect(isApprovalClickGuarded({ armDelayMs: 450, detail: 1, elapsedMs: 450 })).toBe(false);
    });

    it('lets a keyboard-synthesized click through', () => {
        expect(isApprovalClickGuarded({ armDelayMs: 450, detail: 0, elapsedMs: 10 })).toBe(false);
    });

    it('never guards when no delay is configured', () => {
        expect(isApprovalClickGuarded({ armDelayMs: 0, detail: 1, elapsedMs: 0 })).toBe(false);
    });
});
