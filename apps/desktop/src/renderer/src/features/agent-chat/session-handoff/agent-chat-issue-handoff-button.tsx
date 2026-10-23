import { useState } from 'react';

import { MessageSquareShare } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { awaitThenCleanup } from '../../../lib/await-then-cleanup';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { agentChatIssueHandoffDraft, startAgentChatHandoff } from './agent-chat-issue-handoff';

/**
 * Starts an issue the Agent created or edited in a new Session: one click sends `/new-session Work on <issue>` from
 * this Chat, which hands off as the typed command does, card and all. It sits beside the issue's card rather than
 * inside it, since the card itself is the button that opens the issue.
 */
export function AgentChatIssueHandoffButton({
    reference,
    url,
}: {
    reference: string;
    url: string;
}) {
    const { t } = useTranslation();
    const terminalId = useAgentChatTerminal();
    const [isSending, setSending] = useState(false);
    if (terminalId === undefined) return null;
    const label = t('agentChat.handoff.startIssue', { reference });
    const start = () => {
        setSending(true);
        void awaitThenCleanup(
            startAgentChatHandoff(terminalId, agentChatIssueHandoffDraft({ reference, url })),
            () => setSending(false),
        );
    };
    return (
        <Tooltip content={label}>
            <Button
                aria-label={label}
                className="mr-2 size-8 shrink-0 rounded-md text-muted enabled:hover:text-accent"
                data-agent-chat-issue-handoff=""
                disabled={isSending}
                size="icon"
                variant="ghost"
                onClick={start}
            >
                <MessageSquareShare aria-hidden="true" className="size-4" />
            </Button>
        </Tooltip>
    );
}
