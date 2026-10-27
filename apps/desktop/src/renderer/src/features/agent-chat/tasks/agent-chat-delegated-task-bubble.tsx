import { useRef, useState } from 'react';

import type { AgentChatDelegatedTask } from '@caxri/protocol';
import { Forward, MessageSquareShare } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useSessions } from '../../../stores/selectors';
import { resolveSessionCreator } from '../../primary-sidebar/session-creator';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import { useIsAgentChatClamped } from '../hooks/use-is-agent-chat-clamped';

/**
 * "Delegated by" and who: a link to an open Session, Caxri Bot, or an archived Session's title. A source the Workbench
 * cannot show (deleted, or in a hidden Project) reads as a plain delegated task. A hand-off (`/new-session`) reads
 * "Continued from" its Session instead, since this Session carries that one's work on.
 */
function DelegatedTaskSource({ task }: { task: AgentChatDelegatedTask }) {
    const { t } = useTranslation();
    const sessions = useSessions();
    const { source } = task;
    const by = (
        <span className="flex-none text-muted">
            {t(task.handoff ? 'agentChat.handoff.continuedFrom' : 'agentChat.delegated.by')}
        </span>
    );
    if (source?.kind === 'bot')
        return (
            <>
                {by}
                <span>Caxri Bot</span>
            </>
        );
    const creator =
        source &&
        resolveSessionCreator({ createdBySessionId: source.sessionId }, sessions ?? [], undefined);
    if (creator?.kind === 'session') {
        const title = sessionTitleForDisplay(creator.session.title, t);
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
    return (
        <span>
            {t(task.handoff ? 'agentChat.handoff.fromEarlier' : 'agentChat.delegated.task')}
        </span>
    );
}

const TOGGLE_CLASS =
    'mt-1 block cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted hover:text-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent';

/**
 * The task the caller wrote, clamped to six lines with Show more like a long user message.
 */
function DelegatedTaskPrompt({ prompt }: { prompt: string }) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    const textReference = useRef<HTMLDivElement>(null);
    const isCut = useIsAgentChatClamped(textReference, {
        content: prompt,
        isClamped: !isExpanded,
    });
    return (
        <>
            <div
                className={cn(
                    'mt-1 wrap-anywhere whitespace-pre-wrap select-text',
                    !isExpanded && 'line-clamp-6',
                )}
                data-agent-chat-delegated-prompt=""
                ref={textReference}
            >
                {prompt}
            </div>
            {(isCut || isExpanded) && (
                <button
                    aria-expanded={isExpanded}
                    className={TOGGLE_CLASS}
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                >
                    {t(isExpanded ? 'agentChat.message.showLess' : 'agentChat.message.showMore')}
                </button>
            )}
        </>
    );
}

/**
 * The bare pointer, for a task whose delegation record is gone: nothing else says what was asked.
 */
function DelegatedTaskPointer({ text }: { text: string }) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    return (
        <>
            <button
                aria-expanded={isExpanded}
                className={TOGGLE_CLASS}
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
        </>
    );
}

/**
 * A delegated task in place of the user's bubble. Its text is only the pointer to a private task file, which the user
 * never typed and cannot act on, so the bubble names who delegated it (a link to that Session, Caxri Bot, or an
 * archived Session's title) and shows the task the caller wrote, from the delegation record. Only a task whose record
 * is gone falls back to the pointer behind Show instruction. Copy and the message's other actions still take the
 * pointer text. A hand-off wears the `/new-session` card's glyph, so its two ends read as one move.
 */
export function AgentChatDelegatedTaskBubble({
    task,
    text,
}: {
    task: AgentChatDelegatedTask;
    text: string;
}) {
    const Icon = task.handoff ? MessageSquareShare : Forward;
    return (
        <div
            className="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 text-foreground"
            data-agent-chat-delegated-task={task.delegationId}
            data-agent-chat-handoff={task.handoff ? '' : undefined}
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <Icon
                    aria-hidden="true"
                    className={task.handoff ? 'flex-none text-accent' : 'flex-none text-muted'}
                    size={14}
                />
                <DelegatedTaskSource task={task} />
            </div>
            {task.prompt ? (
                <DelegatedTaskPrompt prompt={task.prompt} />
            ) : (
                <DelegatedTaskPointer text={text} />
            )}
        </div>
    );
}
