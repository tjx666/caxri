import type { AgentChatSnapshot } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentChatPathReferenceChips } from '../attachments/agent-chat-path-reference-chips';
import type { useAgentChatPending } from '../hooks/use-agent-chat-pending';
import { AgentChatUserMessageBubble } from '../messages/agent-chat-user-message';
import { AgentChatSessionHandoffBubble } from '../session-handoff/agent-chat-session-handoff-bubble';
import type { AgentChatPendingMessage, AgentChatPendingWait } from './agent-chat-pending';
import { agentChatPendingWait } from './agent-chat-pending';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';
import { AgentChatAskingQuestions } from './questions/agent-chat-answered-questions';

const SENDING_HINT_KEYS = {
    delivery: 'agentChat.message.sending',
    start: 'agentChat.message.sendingAfterStart',
    step: 'agentChat.message.sendingAfterStep',
} as const satisfies Record<AgentChatPendingWait, string>;

/**
 * A small clock whose hands turn while the message is in flight, in place of a caption, so a slow provider reads as
 * "still on its way" without a line of text competing with the conversation (`sending-clock` in styles.css). What it
 * waits for is one hover away and is its accessible name.
 */
function AgentChatSendingClock({ wait }: { wait: AgentChatPendingWait }) {
    const { t } = useTranslation();
    const hint = t(SENDING_HINT_KEYS[wait]);
    return (
        <Tooltip content={hint} side="left">
            <span
                aria-label={hint}
                className="-mt-0.5 -mr-1 inline-flex p-1 text-muted"
                data-agent-chat-sending-wait={wait}
                role="status"
            >
                <span className="sending-clock">
                    <span className="sending-clock-hand" data-hand="hour" />
                    <span className="sending-clock-hand" data-hand="minute" />
                </span>
            </span>
        </Tooltip>
    );
}

/**
 * A message on its way, laid out like the user message it becomes but faded, with a turning sending clock and none of
 * its actions, since nothing can act on a message the conversation does not hold yet.
 */
function AgentChatPendingUserMessage({
    message,
    status,
    onOpenFile,
}: {
    message: AgentChatPendingMessage;
    status: AgentChatSnapshot['status'] | undefined;
    onOpenFile: (target: string) => void;
}) {
    const { handoff, references, skills, text } = parseAgentChatPathReferences(message.text);
    return (
        <div
            aria-busy="true"
            className="flex flex-col items-end gap-1.5"
            data-agent-chat-pending=""
            data-agent-chat-pending-id={message.id}
        >
            <div className="flex w-full flex-col items-end gap-1.5 opacity-60">
                <AgentChatPathReferenceChips references={references} />
                {handoff && <AgentChatSessionHandoffBubble note={handoff.note} />}
                <AgentChatUserMessageBubble
                    images={message.images}
                    isEditing={false}
                    skills={skills}
                    text={handoff ? '' : text}
                    onOpenFile={onOpenFile}
                />
            </div>
            <AgentChatSendingClock wait={agentChatPendingWait(message, status)} />
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
    status,
    onOpenFile,
}: {
    pending: Pick<ReturnType<typeof useAgentChatPending>, 'asking' | 'notices' | 'timeline'>;
    /**
     * The Chat's provider status, which says whether a message on its way waits for the Agent to start.
     */
    status: AgentChatSnapshot['status'] | undefined;
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
                    status={status}
                    onOpenFile={onOpenFile}
                />
            ))}
        </>
    );
}
