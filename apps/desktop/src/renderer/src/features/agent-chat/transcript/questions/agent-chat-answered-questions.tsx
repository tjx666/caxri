import { useId } from 'react';

import type { AgentChatItem } from '@caxri/protocol';
import { ChevronRight, CircleQuestionMark } from 'lucide-react';

import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { useAgentChatExpansion } from '../../hooks/use-agent-chat-expansion';
import { AgentChatNotice } from '../../messages/agent-chat-message';
import { agentChatChevronMotion } from '../agent-chat-disclosure';
import { agentChatItemExpansionKey } from '../agent-chat-expansion';

const ROW_CLASS_NAME =
    'flex min-w-0 items-center gap-2 px-1 py-0.5 text-[12px] leading-5 text-muted';

/**
 * The timeline's row while the Agent waits on its question card, the way the Codex app marks a question being asked:
 * the question glyph and a sweeping highlight, so the transcript shows the turn is live and blocked on the card below.
 */
export function AgentChatAskingQuestions({ count }: { count: number }) {
    const { t } = useTranslation();
    return (
        <div className={ROW_CLASS_NAME} data-agent-chat-asking="">
            <CircleQuestionMark aria-hidden className="size-3.5 shrink-0" />
            <span className="activity-shimmer min-w-0 truncate">
                {count === 1
                    ? t('agentChat.questions.askingOne')
                    : t('agentChat.questions.askingOther', { count })}
            </span>
        </div>
    );
}

/**
 * An answered question request in the transcript: `Asked 3 questions` over each question and the answer given, the way
 * the Codex app records one. It starts expanded, since the answers are what the next reply acts on, and collapses like
 * any other timeline disclosure. A record without structured answers falls back to the plain notice.
 */
export function AgentChatAnsweredQuestions({
    item,
}: {
    item: Extract<AgentChatItem, { type: 'notice' }>;
}) {
    const { t } = useTranslation();
    const detailId = useId();
    const { isExpanded, toggle } = useAgentChatExpansion(agentChatItemExpansionKey(item.id), {
        isDefaultExpanded: true,
    });
    const answers = item.answers ?? [];
    if (answers.length === 0) return <AgentChatNotice item={item} />;
    return (
        <div data-agent-chat-answered="">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                className={cn(
                    ROW_CLASS_NAME,
                    'group/row cursor-pointer rounded border-0 bg-transparent text-left outline-none hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:outline focus-visible:outline-accent',
                )}
                type="button"
                onClick={(event) => toggle(event.currentTarget)}
            >
                <CircleQuestionMark aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                    {answers.length === 1
                        ? t('agentChat.questions.askedOne')
                        : t('agentChat.questions.askedOther', { count: answers.length })}
                </span>
                <ChevronRight
                    aria-hidden
                    className={cn(
                        'size-3.5 shrink-0',
                        agentChatChevronMotion(isExpanded),
                        isExpanded && 'rotate-90',
                    )}
                />
            </button>
            {isExpanded && (
                <dl className="m-0 mt-1 space-y-2 px-1 text-[12px] leading-5" id={detailId}>
                    {answers.map(({ answer, question }, index) => (
                        <div key={index}>
                            <dt className="wrap-anywhere text-muted select-text">{question}</dt>
                            <dd
                                className={cn(
                                    'm-0 wrap-anywhere text-foreground select-text',
                                    !answer && 'italic',
                                )}
                            >
                                {answer || t('agentChat.questions.skipped')}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    );
}
