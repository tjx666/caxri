import {
    executeMobileChatWorkflowFinishedScenario,
    executeMobileChatWorkflowRunningScenario,
} from '../mobile-agent-chat-workflow-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-WORKFLOW-01': executeMobileChatWorkflowFinishedScenario,
    'MOB-CHAT-WORKFLOW-02': executeMobileChatWorkflowRunningScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
