import { describe, expect, it } from 'vitest';

import { shouldCloseSettingsForSelection } from '../settings-page-selection';

describe('shouldCloseSettingsForSelection', () => {
    const live = new Set(['session-a', 'session-b']);

    it('closes Settings when the user picks another Session', () => {
        expect(shouldCloseSettingsForSelection('session-a', 'session-b', live)).toBe(true);
    });

    it('keeps Settings open when the covered Session was deleted and selection fell back', () => {
        expect(
            shouldCloseSettingsForSelection('session-gone', 'session-a', new Set(['session-a'])),
        ).toBe(false);
    });

    it('keeps Settings open when the selection did not move or one side is empty', () => {
        expect(shouldCloseSettingsForSelection('session-a', 'session-a', live)).toBe(false);
        expect(shouldCloseSettingsForSelection(undefined, 'session-a', live)).toBe(false);
        expect(shouldCloseSettingsForSelection('session-a', undefined, live)).toBe(false);
    });
});
