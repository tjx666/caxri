import type { TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import type { AgentChatHost } from '../agent-chat-host';
import { agentChatHostCapabilities } from '../agent-chat-host';
import type { AgentChatPaneCapabilities } from '../agent-chat-pane';
import { AgentChatPane } from '../agent-chat-pane';
import { CanContinueInAgentContext } from '../usage-limit/use-can-continue-in-agent';

/**
 * What a Terminal with no catalogued provider offers in Chat: text only, no rewind.
 */
const NO_CAPABILITIES: AgentChatPaneCapabilities = {
    chatImages: false,
    chatRewind: false,
    chatRewindFiles: false,
};

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
                capabilities={provider?.capabilities ?? NO_CAPABILITIES}
                host={host}
                isSessionVisible={isSessionVisible}
                isShown={isShown}
                providerName={provider?.displayName ?? 'the Agent'}
                terminalId={terminal.id}
            />
        </CanContinueInAgentContext>
    );
}
