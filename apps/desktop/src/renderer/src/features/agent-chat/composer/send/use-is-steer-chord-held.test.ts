import { describe, expect, it } from 'vitest';

import { isSteerChordHeldAfter } from './use-is-steer-chord-held';

function keyEvent(type: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean }): Event {
    return Object.assign(new Event(type), { ctrlKey: false, metaKey: false, ...modifiers });
}

describe('isSteerChordHeldAfter', () => {
    it('holds while Cmd or Ctrl is down and releases with the key-up', () => {
        expect(isSteerChordHeldAfter(keyEvent('keydown', { metaKey: true }))).toBe(true);
        expect(isSteerChordHeldAfter(keyEvent('keydown', { ctrlKey: true }))).toBe(true);
        expect(isSteerChordHeldAfter(keyEvent('keyup', {}))).toBe(false);
        expect(isSteerChordHeldAfter(keyEvent('keydown', {}))).toBe(false);
    });

    it('releases when the window loses focus mid-press', () => {
        expect(isSteerChordHeldAfter(new Event('blur'))).toBe(false);
    });
});
