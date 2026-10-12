import { useTranslation } from '../../i18n';
import { AgentChatAskingQuestions } from './agent-chat-answered-questions';
import { AgentChatMessageImages } from './agent-chat-message-images';
import type { AgentChatPendingMessage } from './agent-chat-pending';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';
import { AgentChatUserMessageBubble } from './agent-chat-user-message';
import type { useAgentChatPending } from './hooks/use-agent-chat-pending';

/**
 * A message on its way, laid out like the user message it becomes but faded, with a Sending caption and none of its
 * actions, since nothing can act on a message the conversation does not hold yet.
 */
function AgentChatPendingUserMessage({
    message,
    onOpenFile,
}: {
    message: AgentChatPendingMessage;
    onOpenFile: (target: string) => void;
}) {
    const { t } = useTranslation();
    return (
        <div
            aria-busy="true"
            className="flex flex-col items-end gap-1.5 opacity-60"
            data-agent-chat-pending=""
        >
            {message.images.length > 0 && (
                <AgentChatMessageImages className="max-w-[85%]" images={message.images} />
            )}
            {message.text && (
                <AgentChatUserMessageBubble
                    isEditing={false}
                    text={message.text}
                    onOpenFile={onOpenFile}
                />
            )}
            <span className="-mt-0.5 text-[11px] leading-4 text-muted">
                {t('agentChat.message.sending')}
            </span>
        </div>
    );
}

/**
 * The end of the timeline ahead of the projection: questions still waiting on their card, answers whose record has not
 * arrived, then messages on their way that start or steer a turn. Each gives way to the real row once the snapshot
 * shows it (`useAgentChatPending`); an asking row gives way to its answer as soon as the card is answered.
 */
export function AgentChatPendingTimeline({
    pending,
    onOpenFile,
}: {
    pending: Pick<ReturnType<typeof useAgentChatPending>, 'asking' | 'notices' | 'timeline'>;
    onOpenFile: (target: string) => void;
}) {
    return (
        <>
            {pending.asking.map((request) =>
                request.kind === 'question' ? (
                    <AgentChatAskingQuestions count={request.questions.length} key={request.id} />
                ) : null,
            )}
            {pending.notices.map((notice) =>
                notice.type === 'notice' ? (
                    <AgentChatTimelineEntryView
                        entry={{ kind: 'item', item: notice }}
                        key={notice.id}
                        onOpenFile={onOpenFile}
                    />
                ) : null,
            )}
            {pending.timeline.map((message) => (
                <AgentChatPendingUserMessage
                    key={message.id}
                    message={message}
                    onOpenFile={onOpenFile}
                />
            ))}
        </>
    );
}
