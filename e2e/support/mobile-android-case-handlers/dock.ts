import {
    executeMobileChatDockFoldScenario,
    executeMobileChatDockKeyboardScenario,
} from '../mobile-agent-chat-dock-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-DOCK-FOLD-01': executeMobileChatDockFoldScenario,
    'MOB-CHAT-DOCK-KEYBOARD-01': executeMobileChatDockKeyboardScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
