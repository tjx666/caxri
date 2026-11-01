import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Archive with Undo from the Session list (#3414). Handlers live in
 * `e2e/support/mobile-android-case-handlers/session-archive.ts`.
 */
const screenshotCase = (scenario: string) =>
    ({
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario,
    }) as const satisfies MobileAndroidCaseDefinition;

export const cases = {
    'MOB-SESSION-ARCHIVE-UNDO-01': screenshotCase('session-archive-undo'),
    'MOB-SESSION-ARCHIVE-UNDO-02': screenshotCase('session-archive-timeout'),
    'MOB-SESSION-ARCHIVE-UNDO-03': screenshotCase('session-archive-undo-offline'),
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
