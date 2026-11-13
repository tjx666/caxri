/**
 * Route param that marks how a Session detail was opened when it replaced another screen instead of being pushed.
 */
export const SESSION_ENTRY_PARAM = 'entry';
/**
 * The Session replaced the New Session sheet.
 */
export const NEW_SESSION_ENTRY = 'new';
/**
 * The Session replaced another Session's detail through "Previous Session".
 */
export const SWITCH_SESSION_ENTRY = 'switch';

type SessionScreenAnimation = 'fade' | 'ios_from_right' | 'none';

const FADING_ENTRIES: ReadonlySet<unknown> = new Set([NEW_SESSION_ENTRY, SWITCH_SESSION_ENTRY]);

/**
 * A Session that replaces another screen fades in place. After the New Session sheet rose from the bottom, a sideways
 * push would add a second motion the user reads as a jolt; after "Previous Session", it would read as drilling one
 * level deeper although Back still returns to the list.
 */
export const sessionScreenAnimation = (
    parameters: Readonly<Record<string, unknown>> | undefined,
    layoutAnimation: 'ios_from_right' | 'none',
): SessionScreenAnimation =>
    layoutAnimation !== 'none' && FADING_ENTRIES.has(parameters?.[SESSION_ENTRY_PARAM])
        ? 'fade'
        : layoutAnimation;
