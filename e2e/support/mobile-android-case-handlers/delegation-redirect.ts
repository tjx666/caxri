import { executeMobileDelegatedRedirectScenario } from '../mobile-agent-chat-delegated-redirect-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-DELEGATION-REDIRECT-01': executeMobileDelegatedRedirectScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
