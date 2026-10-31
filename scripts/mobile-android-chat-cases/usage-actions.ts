import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

const usageActionsCase = {
    desktopProfile: 'managed-by-isolated-e2e',
    media: ['screenshot'],
    recordingOwner: 'scenario',
    scenario: 'agent-chat-usage-actions',
} as const satisfies MobileAndroidCaseDefinition;

/**
 * Acting on usage limits from the phone (#2939). Handlers live in `e2e/support/mobile-chat-cases/usage-actions.ts`:
 * `-01` Continue now on the usage-limit card, `-02` Generate hand-off and Continue anyway on the guard card, `-03` the
 * guard card's disabled buttons offline.
 */
export const cases = {
    'MOB-CHAT-USAGE-ACT-01': usageActionsCase,
    'MOB-CHAT-USAGE-ACT-02': usageActionsCase,
    'MOB-CHAT-USAGE-ACT-03': usageActionsCase,
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
