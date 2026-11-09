import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Claude Code workflow runs in Chat. Handlers live in `e2e/support/mobile-android-case-handlers/workflow.ts`.
 */
export const cases = {
    'MOB-CHAT-WORKFLOW-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-workflow',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
