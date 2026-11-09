import { executeMobileChatWorkflowScenario } from '../mobile-agent-chat-workflow-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-WORKFLOW-01': executeMobileChatWorkflowScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
