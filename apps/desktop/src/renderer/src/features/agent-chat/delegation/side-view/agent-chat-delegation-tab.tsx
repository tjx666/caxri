import { isChatTerminal } from '@caxri/protocol';

import { useTerminal } from '../../../../stores/selectors';
import { PaneViewSessionProvider } from '../../../workbench/pane-view-session';
import { AgentChatTerminalContent } from '../../tasks/agent-chat-terminal-content';

/**
 * A delegated child's Chat in the Side View of the Chat that asked for it (`caxri-agent-delegation://` tabs). It is the
 * child's own live Chat: the user reads its progress, answers its questions, or takes it over without leaving the
 * parent. Scoped to the child's Session so file links and the composer resolve against the child's Project root, and
 * mounted as the `portal` host, which hides the actions that would act on the selected Session (the parent) instead.
 * The Side View drops the tab once the child's Chat closes, so a missing Terminal renders nothing.
 */
export function AgentChatDelegationTab({ terminalId }: { terminalId: string }) {
    const terminal = useTerminal(terminalId);
    if (!terminal || !isChatTerminal(terminal)) return null;
    return (
        <PaneViewSessionProvider value={terminal.sessionId}>
            <AgentChatTerminalContent host="portal" isShown terminal={terminal} />
        </PaneViewSessionProvider>
    );
}
