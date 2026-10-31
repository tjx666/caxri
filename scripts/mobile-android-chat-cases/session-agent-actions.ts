import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

const screenshotCase = (scenario: string) =>
    ({
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario,
    }) as const satisfies MobileAndroidCaseDefinition;

/**
 * The Session menu's Agent group (#3238) and Continue in Another Agent from a usage-limit card or the usage guard
 * card (#2940). Handlers live in `e2e/support/mobile-chat-cases/session-agent-actions.ts`.
 */
export const cases = {
    'MOB-CHAT-SESSION-AGENT-ACTIONS-01': screenshotCase('agent-chat-session-agent-actions'),
    'MOB-CHAT-SESSION-AGENT-ACTIONS-02': screenshotCase('agent-chat-session-agent-actions-offline'),
    'MOB-CHAT-CONT-AGENT-USAGE-01': screenshotCase('agent-chat-continue-agent'),
    'MOB-CHAT-CONT-AGENT-USAGE-02': screenshotCase('agent-chat-continue-agent-unavailable'),
    'MOB-CHAT-CONT-AGENT-GUARD-01': screenshotCase('agent-chat-continue-agent-guard'),
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
