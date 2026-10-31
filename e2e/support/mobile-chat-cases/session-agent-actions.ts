import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';
import {
    executeMobileContinueAgentGuardScenario,
    executeMobileContinueAgentScenario,
    executeMobileContinueAgentUnavailableScenario,
} from '../mobile-continue-agent-scenario';
import {
    executeMobileSessionAgentActionsOfflineScenario,
    executeMobileSessionAgentActionsScenario,
} from '../mobile-session-agent-actions-scenario';

export const handlers = {
    'MOB-CHAT-SESSION-AGENT-ACTIONS-01': executeMobileSessionAgentActionsScenario,
    'MOB-CHAT-SESSION-AGENT-ACTIONS-02': executeMobileSessionAgentActionsOfflineScenario,
    'MOB-CHAT-CONT-AGENT-USAGE-01': executeMobileContinueAgentScenario,
    'MOB-CHAT-CONT-AGENT-USAGE-02': executeMobileContinueAgentUnavailableScenario,
    'MOB-CHAT-CONT-AGENT-GUARD-01': executeMobileContinueAgentGuardScenario,
} satisfies Record<string, MobileChatCaseHandler>;
