import { describe, expect, it } from 'vitest';

import { isQueueChordHeldAfter } from './use-is-queue-chord-held';

function keyEvent(type: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean }): Event {
    return Object.assign(new Event(type), { ctrlKey: false, metaKey: false, ...modifiers });
}

describe('isQueueChordHeldAfter', () => {
    it('holds while Cmd or Ctrl is down and releases with the key-up', () => {
        expect(isQueueChordHeldAfter(keyEvent('keydown', { metaKey: true }))).toBe(true);
        expect(isQueueChordHeldAfter(keyEvent('keydown', { ctrlKey: true }))).toBe(true);
        expect(isQueueChordHeldAfter(keyEvent('keyup', {}))).toBe(false);
        expect(isQueueChordHeldAfter(keyEvent('keydown', {}))).toBe(false);
    });

    it('releases when the window loses focus mid-press', () => {
        expect(isQueueChordHeldAfter(new Event('blur'))).toBe(false);
    });
});
