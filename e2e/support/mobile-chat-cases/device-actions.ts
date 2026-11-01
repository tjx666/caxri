import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';
import { executeMobileDeviceActionsScenario } from '../mobile-device-actions-scenario';

export const handlers = {
    'MOB-CHAT-DEVICE-ACTIONS-01': executeMobileDeviceActionsScenario,
} satisfies Record<string, MobileChatCaseHandler>;
