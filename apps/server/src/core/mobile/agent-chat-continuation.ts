import type { AgentProvider, MobileContinuationOrigin } from '@caxri/protocol';

/**
 * The `agentChat.continueInAgent` parameters Desktop's same control sends for the phone's entry: the menu's `manual`
 * continuation (which refuses a running turn instead of handing over work still in progress), a usage-limit card's
 * failed `turnId`, or neither for the usage guard's "Open in another Agent".
 */
export const agentChatContinuationParameters = (
    terminalId: string,
    provider: AgentProvider,
    origin: MobileContinuationOrigin | undefined,
) => ({
    terminalId,
    provider,
    ...((origin?.kind ?? 'menu') === 'menu' && { manual: true as const }),
    ...(origin?.kind === 'usageLimit' && { turnId: origin.turnId }),
});
