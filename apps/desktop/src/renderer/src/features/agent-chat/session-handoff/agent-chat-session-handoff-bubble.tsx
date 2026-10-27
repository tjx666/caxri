import { MessageSquareShare } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { useSessions, useTerminal } from '../../../stores/selectors';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { agentChatSessionHandoffTarget } from './agent-chat-session-handoff-target';

/**
 * Where the hand-off went, once the Agent created the new Session: a link to it, or an archived Session's title.
 * Nothing while it does not exist yet; the Agent's reply says what it is doing meanwhile.
 */
function HandoffTargetRow({ sentAt }: { sentAt: number | undefined }) {
    const { t } = useTranslation();
    const terminalId = useAgentChatTerminal();
    const sourceSessionId = useTerminal(terminalId ?? '')?.sessionId;
    const target = agentChatSessionHandoffTarget(useSessions(), sourceSessionId, sentAt);
    if (!target) return null;
    const title = sessionTitleForDisplay(target.title, t);
    return (
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 border-t border-border pt-1.5 text-[12px] leading-4">
            <span className="flex-none text-muted">{t('agentChat.handoff.continuedIn')}</span>
            {target.archivedAt === undefined ? (
                <button
                    className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    data-agent-chat-handoff-target={target.id}
                    type="button"
                    onClick={() => openSession(target.id)}
                >
                    {title}
                </button>
            ) : (
                <span className="min-w-0 truncate">
                    {t('agentChat.delegated.archived', { title })}
                </span>
            )}
        </div>
    );
}

/**
 * A `/new-session` message in place of the user's bubble: the command as a chip with what the user said the next task
 * is, never the instructions the composer wrote for the Agent. Once the Agent created the new Session, a row under it
 * links there, so leaving this Session for the next one is one click. The new Session's first message is the other end
 * (`AgentChatDelegatedTaskBubble` with `handoff`), wearing the same glyph.
 */
export function AgentChatSessionHandoffBubble({
    note,
    sentAt,
}: {
    note: string;
    /**
     * When the message entered the conversation; absent while it is still on its way.
     */
    sentAt?: number;
}) {
    const { t } = useTranslation();
    return (
        <div
            className="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 text-foreground"
            data-agent-chat-session-handoff=""
        >
            <div className="wrap-anywhere whitespace-pre-wrap select-text">
                <span className="mr-1 inline-flex max-w-full items-center gap-1 rounded-md bg-accent/15 px-1.5 align-top font-medium text-accent">
                    <MessageSquareShare aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">{t('agentChat.handoff.command')}</span>
                </span>
                {note || <span className="text-muted">{t('agentChat.handoff.noNote')}</span>}
            </div>
            <HandoffTargetRow sentAt={sentAt} />
        </div>
    );
}
