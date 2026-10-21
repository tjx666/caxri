import { describe, expect, it } from 'vitest';

import { initialEnteringKeys, nextEnteringKeys } from './use-entering-keys';

describe('nextEnteringKeys', () => {
    it('treats the keys at mount as seen and a later new key as entering', () => {
        const initial = initialEnteringKeys(['command', 'edit']);
        expect(initial.entering.size).toBe(0);
        expect([...nextEnteringKeys(initial, ['command', 'edit', 'agent']).entering]).toEqual([
            'agent',
        ]);
    });

    it('keeps its state while the list holds and does not enter a key that left and came back', () => {
        const initial = initialEnteringKeys(['command']);
        expect(nextEnteringKeys(initial, ['command'])).toBe(initial);
        const running = nextEnteringKeys(initial, ['active']);
        expect(nextEnteringKeys(running, ['command']).entering.size).toBe(0);
    });
});
