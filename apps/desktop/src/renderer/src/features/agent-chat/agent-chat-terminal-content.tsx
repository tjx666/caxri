import type { TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import type { AgentChatHost } from './agent-chat-host';
import { AgentChatPane } from './agent-chat-pane';

/**
 * A Terminal opened as Chat, named and capability-gated by its provider's catalog entry. The Workbench pane and the
 * Agent Commander window both mount a Chat Terminal through this.
 */
export function AgentChatTerminalContent({
    ariaLabel,
    host = 'workbench',
    isShown,
    terminal,
}: {
    /**
     * Defaults to the Terminal's title.
     */
    ariaLabel?: string;
    /**
     * The window mounting the Chat, which gates the actions it cannot carry out (`agentChatHostCapabilities`).
     */
    host?: AgentChatHost;
    isShown: boolean;
    terminal: TerminalRecord;
}) {
    const provider = terminal.provider ? agentProviderCatalog[terminal.provider] : undefined;
    return (
        <AgentChatPane
            ariaLabel={ariaLabel ?? terminal.title}
            host={host}
            isShown={isShown}
            providerName={provider?.displayName ?? 'the Agent'}
            supportsImages={provider?.capabilities.chatImages ?? false}
            supportsRewindFiles={provider?.capabilities.chatRewindFiles ?? false}
            terminalId={terminal.id}
        />
    );
}
