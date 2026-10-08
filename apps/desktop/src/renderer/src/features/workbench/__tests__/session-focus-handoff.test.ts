import { describe, expect, it } from 'vitest';

import { shouldHandOffSessionFocus } from '../session-focus-handoff';

/**
 * Renderer unit tests run without a DOM, and every lookup this policy makes goes through the duck-typed `closest` that
 * `isEditableEventTarget` already relies on, so a focused element is faithfully modelled by the selectors it answers.
 */
function focused(...matches: string[]): HTMLElement {
    return {
        closest: (selector: string) =>
            matches.some((match) =>
                selector.split(',').some((part) => part.trim() === match.trim()),
            )
                ? {}
                : null,
    } as unknown as HTMLElement;
}

describe('shouldHandOffSessionFocus', () => {
    it('hands focus over when nothing holds it', () => {
        expect(shouldHandOffSessionFocus(null, false)).toBe(true);
    });

    it('hands focus over from a control that is not editable', () => {
        expect(shouldHandOffSessionFocus(focused('.session-card'), false)).toBe(true);
    });

    it('leaves focus where the user is typing', () => {
        expect(shouldHandOffSessionFocus(focused('input'), false)).toBe(false);
    });

    it('leaves focus to an open modal', () => {
        expect(shouldHandOffSessionFocus(null, true)).toBe(false);
    });

    it('takes focus back out of the Session that just went off screen', () => {
        // The retained Session's helper textarea still reads as editable, but the user cannot see it any more.
        expect(
            shouldHandOffSessionFocus(focused('.workbench-session[hidden]', 'textarea'), false),
        ).toBe(true);
    });

    it('leaves focus inside the Terminal of the Session that is on screen', () => {
        expect(shouldHandOffSessionFocus(focused('.xterm'), false)).toBe(false);
    });
});
