import type { TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import type { AgentChatHost } from '../agent-chat-host';
import { agentChatHostCapabilities } from '../agent-chat-host';
import { AgentChatPane } from '../agent-chat-pane';
import { CanContinueInAgentContext } from '../usage-limit/use-can-continue-in-agent';

/**
 * A Terminal opened as Chat, named and capability-gated by its provider's catalog entry. The Workbench pane and the the
 * Caxri Bot window both mount a Chat Terminal through this.
 */
export function AgentChatTerminalContent({
    ariaLabel,
    host = 'workbench',
    isSessionVisible = true,
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
    /**
     * Whether the Session holding the Chat is the one on screen. Defaults to `true` for a host with no hidden Sessions.
     */
    isSessionVisible?: boolean;
    isShown: boolean;
    terminal: TerminalRecord;
}) {
    const provider = terminal.provider ? agentProviderCatalog[terminal.provider] : undefined;
    return (
        <CanContinueInAgentContext value={agentChatHostCapabilities(host).canContinueInAgent}>
            <AgentChatPane
                ariaLabel={ariaLabel ?? terminal.title}
                host={host}
                isSessionVisible={isSessionVisible}
                isShown={isShown}
                providerName={provider?.displayName ?? 'the Agent'}
                supportsImages={provider?.capabilities.chatImages ?? false}
                supportsRewind={provider?.capabilities.chatRewind ?? false}
                supportsRewindFiles={provider?.capabilities.chatRewindFiles ?? false}
                terminalId={terminal.id}
            />
        </CanContinueInAgentContext>
    );
}
