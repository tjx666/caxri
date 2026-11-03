/**
 * Route param that marks a Session detail opened by replacing the New Session sheet.
 */
export const SESSION_ENTRY_PARAM = 'entry';
export const NEW_SESSION_ENTRY = 'new';

type SessionScreenAnimation = 'fade' | 'ios_from_right' | 'none';

/**
 * The New Session sheet rises from the bottom, so a Session that replaces it fades in place. Pushing it in from the
 * right right after the sheet rose would add a second, sideways motion the user reads as a jolt.
 */
export const sessionScreenAnimation = (
    parameters: Readonly<Record<string, unknown>> | undefined,
    layoutAnimation: 'ios_from_right' | 'none',
): SessionScreenAnimation =>
    layoutAnimation !== 'none' && parameters?.[SESSION_ENTRY_PARAM] === NEW_SESSION_ENTRY
        ? 'fade'
        : layoutAnimation;
