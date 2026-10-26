import type { AgentChatWaitingChat } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { ChevronUp, SquareArrowOutUpRight } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { useProjectById, useSessionById, useTerminal } from '../../../stores/selectors';
import { sessionTitleForDisplay } from '../../session/session-title';
import { AGENT_CHAT_APPROVAL_ARM_DELAY_MS } from '../transcript/agent-chat-presentation';
import { AgentChatRequestCard } from '../transcript/agent-chat-request-card';
import { openAgentChatWaiting } from './agent-chat-waiting-commands';

/**
 * The popup's card: which Chat asks (provider, Session, Project), what the user last asked it, and the request itself,
 * answered in place through the same card the Chat's pane docks above its composer. Only the Chat's first request
 * shows; the next one takes its place once this one is answered.
 */
export function AgentChatWaitingCard({
    chat,
    moreCount,
    onAnswered,
    onCollapse,
}: {
    chat: AgentChatWaitingChat;
    /**
     * Requests waiting behind this one, in this Chat and others.
     */
    moreCount: number;
    /**
     * Runs as an answer given from inside the card takes the request away, so focus can move on to the next one.
     */
    onAnswered: () => void;
    onCollapse: () => void;
}) {
    const { t } = useTranslation();
    const session = useSessionById(chat.sessionId);
    const project = useProjectById(session?.projectId);
    const terminal = useTerminal(chat.terminalId);
    const provider = terminal?.provider ? agentProviderCatalog[terminal.provider] : undefined;
    // The read lists only Chats with at least one request (`agentChatWaitingChatSchema`).
    const request = chat.requests[0];
    const open = (): void => {
        void openAgentChatWaiting(chat.sessionId, chat.terminalId);
    };
    return (
        <div className="space-y-2">
            <header className="flex items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                    <AgentIdentityIcon identity={terminal?.provider} size={14} />
                </span>
                <div className="min-w-0 flex-1 leading-4">
                    <p className="m-0 flex min-w-0 items-baseline gap-1.5 text-[13px]">
                        <span className="truncate font-semibold text-foreground">
                            {session ? sessionTitleForDisplay(session.displayTitle, t) : ''}
                        </span>
                        {project && (
                            <span className="shrink-0 truncate text-muted">
                                {project.displayTitle}
                            </span>
                        )}
                    </p>
                    {/* What the user last asked, as the header's second line: set apart with a quote bar above the
                        request's divider, it read as an empty text field. */}
                    {chat.prompt && (
                        <p className="m-0 mt-0.5 truncate text-[12px] text-muted">{chat.prompt}</p>
                    )}
                </div>
                <Button size="sm" variant="secondary" onClick={open}>
                    <SquareArrowOutUpRight className="size-3.5" />
                    {t('agentChat.waiting.openSession')}
                </Button>
                <Tooltip content={t('agentChat.waiting.collapse')}>
                    <Button
                        aria-label={t('agentChat.waiting.collapse')}
                        size="icon"
                        variant="ghost"
                        onClick={onCollapse}
                    >
                        <ChevronUp className="size-3.5" />
                    </Button>
                </Tooltip>
            </header>
            <div className="border-t border-border pt-2.5">
                {/* The question form's rows bleed 8px outward (`-mx-2`) so their highlight lines up with the text in the
                    docked card's padding. `overflow-y: auto` clips the x axis too, so the scroll area claims that 8px
                    back from the card's own padding instead. */}
                <div className="-mx-2 max-h-[min(480px,60vh)] overflow-y-auto px-2">
                    <AgentChatRequestCard
                        key={request.id}
                        approvalArmDelayMs={AGENT_CHAT_APPROVAL_ARM_DELAY_MS}
                        isFramed={false}
                        isWindowWide
                        reviewHint={
                            request.kind === 'fileChange'
                                ? t('agentChat.waiting.reviewChanges')
                                : undefined
                        }
                        onEscape={onCollapse}
                        linkedItem={undefined}
                        onAnswered={onAnswered}
                        projectRoot={session?.rootPath}
                        providerName={provider?.displayName ?? t('agentChat.waiting.agent')}
                        request={request}
                        terminalId={chat.terminalId}
                    />
                </div>
            </div>
            {moreCount > 0 && (
                <p className="m-0 text-[11px] text-muted">
                    {moreCount === 1
                        ? t('agentChat.waiting.moreOne')
                        : t('agentChat.waiting.moreOther', { count: moreCount })}
                </p>
            )}
        </div>
    );
}
