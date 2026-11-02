import { executeMobileChatQuoteCopyScenario } from '../mobile-agent-chat-quote-copy-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-QUOTE-COPY-01': executeMobileChatQuoteCopyScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
