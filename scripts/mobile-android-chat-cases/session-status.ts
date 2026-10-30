import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

const sessionStatusCase = {
    desktopProfile: 'managed-by-isolated-e2e',
    media: ['screenshot', 'video'],
    motion: 'live',
    recordingOwner: 'scenario',
    scenario: 'session-status-background-and-phase',
} as const satisfies MobileAndroidCaseDefinition;

/**
 * Session list status glyph cases. Handlers live in `e2e/support/mobile-chat-cases/session-status.ts`. Both run the
 * same scenario: `-01` judges the background ring beside a live spinner, `-02` judges that spinners share one angle.
 */
export const cases = {
    'MOB-CHAT-SESSION-STATUS-01': sessionStatusCase,
    'MOB-CHAT-SESSION-STATUS-02': sessionStatusCase,
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
