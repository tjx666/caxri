import { useState } from 'react';

import type { AgentChatDelegatedTask } from '@caxri/protocol';
import { Forward } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { useSessions } from '../../../stores/selectors';
import { resolveSessionCreator } from '../../primary-sidebar/session-creator';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';

/**
 * "Delegated by" and who: a link to an open Session, Agent Commander, or an archived Session's title. A source the
 * Workbench cannot show (deleted, or in a hidden Project) reads as a plain delegated task.
 */
function DelegatedTaskSource({ task }: { task: AgentChatDelegatedTask }) {
    const { t } = useTranslation();
    const sessions = useSessions();
    const { source } = task;
    const by = <span className="flex-none text-muted">{t('agentChat.delegated.by')}</span>;
    if (source?.kind === 'commander')
        return (
            <>
                {by}
                <span>Agent Commander</span>
            </>
        );
    const creator =
        source &&
        resolveSessionCreator({ createdBySessionId: source.sessionId }, sessions ?? [], undefined);
    if (creator?.kind === 'session') {
        const title = sessionTitleForDisplay(creator.session.displayTitle, t);
        return (
            <>
                {by}
                <button
                    className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[13px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={() => openSession(creator.session.id)}
                >
                    {title}
                </button>
            </>
        );
    }
    if (creator?.kind === 'archived')
        return (
            <>
                {by}
                <span className="min-w-0 truncate">
                    {t('agentChat.delegated.archived', {
                        title: sessionTitleForDisplay(creator.title, t),
                    })}
                </span>
            </>
        );
    return <span>{t('agentChat.delegated.task')}</span>;
}

/**
 * A delegated task in place of the user's bubble. Its text is only the pointer to a private task file, which the user
 * never typed and cannot act on, so the bubble names who delegated it (a link to that Session, Agent Commander, or an
 * archived Session's title) and keeps the pointer behind Show instruction. Copy and the message's other actions still
 * take the pointer text.
 */
export function AgentChatDelegatedTaskBubble({
    task,
    text,
}: {
    task: AgentChatDelegatedTask;
    text: string;
}) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    return (
        <div
            className="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 text-foreground"
            data-agent-chat-delegated-task={task.delegationId}
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <Forward aria-hidden="true" className="flex-none text-muted" size={14} />
                <DelegatedTaskSource task={task} />
            </div>
            <button
                aria-expanded={isExpanded}
                className="mt-1 block cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted hover:text-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => setExpanded((value) => !value)}
            >
                {t(
                    isExpanded
                        ? 'agentChat.delegated.hideInstruction'
                        : 'agentChat.delegated.showInstruction',
                )}
            </button>
            {isExpanded && (
                <div className="mt-1 text-[12px] leading-4 wrap-anywhere whitespace-pre-wrap text-muted select-text">
                    {text}
                </div>
            )}
        </div>
    );
}
