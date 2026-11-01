import { executeMobileChatDockFoldScenario } from '../mobile-agent-chat-dock-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-DOCK-FOLD-01': executeMobileChatDockFoldScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
