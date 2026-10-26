import { describe, expect, it, vi } from 'vitest';

import { notifyListeners } from '../notify-listeners';

describe('notifyListeners', () => {
    it('delivers to a later listener when an earlier one throws', () => {
        const failing = vi.fn(() => {
            throw new Error('listener failure');
        });
        const surviving = vi.fn();

        notifyListeners([failing, surviving], 'value');

        expect(failing).toHaveBeenCalledExactlyOnceWith('value');
        expect(surviving).toHaveBeenCalledExactlyOnceWith('value');
    });

    it('delivers the same value to every listener when none throw', () => {
        const first = vi.fn();
        const second = vi.fn();

        notifyListeners([first, second], 42);

        expect(first).toHaveBeenCalledExactlyOnceWith(42);
        expect(second).toHaveBeenCalledExactlyOnceWith(42);
    });
});
