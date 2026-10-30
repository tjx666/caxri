import { useRef, useState } from 'react';

import type { AgentChatDelegatedTask, AgentChatSkillReference } from '@caxri/protocol';
import { agentChatTextWithSessionMentions, parseAgentChatPathReferences } from '@caxri/protocol';
import { CornerDownRight } from 'lucide-react';

import { writeToClipboardWithFeedback } from '../../../components/copy-feedback';
import { CopyIconButton } from '../../../components/markdown/copy-icon-button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { textClipboard } from '../../../lib/clipboard';
import { cn } from '../../../lib/utilities';
import { AgentChatMessageImages } from '../attachments/agent-chat-message-images';
import { AgentChatMessageVideos } from '../attachments/agent-chat-message-videos';
import { AgentChatPathReferenceChips } from '../attachments/agent-chat-path-reference-chips';
import { AgentChatInvocationChip } from '../composer/agent-chat-invocation-chip';
import { agentChatLeadingInvocation } from '../composer-input/agent-chat-slash-commands';
import { useAgentChatEdit } from '../hooks/use-agent-chat-edit';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { useAgentChatUserMessageMenu } from '../hooks/use-agent-chat-user-message-menu';
import { useIsAgentChatClamped } from '../hooks/use-is-agent-chat-clamped';
import { AgentChatSessionHandoffBubble } from '../session-handoff/agent-chat-session-handoff-bubble';
import { AgentChatDelegatedTaskBubble } from '../tasks/agent-chat-delegated-task-bubble';
import { AgentChatSkillPill } from '../tools/agent-chat-skill-card';
import { agentChatDeliveryCaption } from '../transcript/agent-chat-presentation';
import { AgentChatMessageTime } from './agent-chat-message-time';
import { AgentChatReplyFrame } from './agent-chat-reply-frame';
import { AgentChatUserMessageActions } from './agent-chat-user-message-actions';
import { agentChatFirstImageNumber } from './agent-chat-user-message-text';
import { AgentChatUserMessageBody } from './bubble-text/agent-chat-user-message-body';

/**
 * The user's message, right-aligned. A message steered into a running turn says so with a quiet ↳ beside the bubble,
 * named on hover (see `agentChatDeliveryCaption`), so the mark adds no line under the message. Under it, a row with the
 * time it was sent and a Copy action mounts while the pointer is over the message or keyboard focus is inside it,
 * exactly as under a reply (`AgentChatReplyFrame`): the row keeps its height, so revealing it never shifts the
 * transcript, and a hidden row is no Tab stop. `Option+ArrowUp` and `Option+ArrowDown` step through user messages and
 * replies alike to reach it from the keyboard. A long message (a pasted log, a spec) clamps to twelve lines with Show
 * more, so one prompt does not push the reply it asked for off screen; Copy still takes the whole text. A message that
 * started a turn also offers "Edit from here", which puts its text back into the composer to send in its place (the
 * message being edited keeps a quiet `--muted` outline until then), "Fork from here", which opens the conversation
 * before it in a new Session with its text in the composer, and, when the provider restores files, "Restore code to
 * here", which reverts the files changed since and keeps the conversation, as Claude Code's `/rewind` "Restore code"
 * does. A right-click offers the same actions in a native menu (`agentChatUserMessageMenu`), so they are reachable
 * without finding the hover row; a message read back from history lists Edit and Fork there disabled with why. Files
 * and folders the message cites (`agentChatTextWithPathReferences`) show as chips above its bubble rather than as the
 * reference block the provider received; clicking one shows it in Finder. Skills it asked for lead the bubble's text as
 * inline chips, so the message reads as one. A `/new-session` hand-off shows as its own card
 * (`AgentChatSessionHandoffBubble`).
 */
export function AgentChatUserMessage({
    createdAt,
    delegatedTask,
    delivery,
    id,
    images,
    text,
    onOpenFile,
}: {
    createdAt?: number;
    /**
     * Set when the message is a delegated task pointer; it then shows who delegated it instead of the pointer.
     */
    delegatedTask?: AgentChatDelegatedTask;
    delivery?: 'queued' | 'steered';
    /**
     * The message's item id, which names it when an image without a thumbnail is read back from the provider's record,
     * and marks it for the message rail.
     */
    id: string;
    images?: ReadonlyArray<{ thumbnail?: string }>;
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const { t } = useTranslation();
    const terminalId = useAgentChatTerminal();
    const caption = agentChatDeliveryCaption(delivery, t);
    const edit = useAgentChatEdit();
    const isEditing = edit?.editingId === id;
    const container = useRef<HTMLDivElement>(null);
    const menu = useAgentChatUserMessageMenu({ container, id, text });
    const { handoff, references, skills, text: words } = parseAgentChatPathReferences(text);
    const hasActions =
        words !== '' ||
        createdAt !== undefined ||
        edit?.availability(id) !== undefined ||
        edit?.restore?.availability(id) !== undefined;
    const actions = hasActions ? (
        <>
            {createdAt !== undefined && <AgentChatMessageTime timestamp={createdAt} />}
            <AgentChatUserMessageActions
                id={id}
                isForking={menu.isForking}
                isRestoring={menu.isRestoring}
                text={text}
                onFork={menu.fork}
            />
            {words && (
                <CopyIconButton
                    className="-mr-1"
                    copy={() =>
                        writeToClipboardWithFeedback(
                            textClipboard,
                            agentChatTextWithSessionMentions(words),
                        )
                    }
                    label={t('agentChat.message.copy')}
                />
            )}
        </>
    ) : null;
    return (
        <AgentChatReplyFrame
            actions={actions}
            actionsClassName="-mt-1"
            className="flex flex-col items-end gap-1.5"
            data-agent-chat-user-message={id}
            isPinned={menu.isForking || menu.isRestoring}
            ref={container}
            onContextMenu={menu.onContextMenu}
        >
            <AgentChatPathReferenceChips references={references} />
            {delegatedTask ? (
                <AgentChatDelegatedTaskBubble task={delegatedTask} text={text} />
            ) : (
                <>
                    {handoff && (
                        <AgentChatSessionHandoffBubble note={handoff.note} sentAt={createdAt} />
                    )}
                    <div className="flex w-full items-start justify-end gap-1.5">
                        {caption && (
                            <Tooltip content={caption}>
                                <span
                                    aria-label={caption}
                                    className="mt-2.5 inline-flex text-muted"
                                    data-agent-chat-steered=""
                                    role="img"
                                >
                                    <CornerDownRight aria-hidden="true" className="size-3.5" />
                                </span>
                            </Tooltip>
                        )}
                        {/* A hand-off's words are on its card; the images and skills it carried stay in a bubble. */}
                        <AgentChatUserMessageBubble
                            images={images}
                            imageRecord={
                                terminalId === undefined ? undefined : { terminalId, itemId: id }
                            }
                            isEditing={isEditing}
                            skills={skills}
                            text={handoff ? '' : words}
                            onOpenFile={onOpenFile}
                        />
                    </div>
                </>
            )}
        </AgentChatReplyFrame>
    );
}

/**
 * The message bubble, shared with a message still on its way (`AgentChatPendingTimeline`): the text, then the images it
 * carried and the videos its text cites, in one bubble as LobeHub's chat lays a message out. A long message clamps to
 * twelve lines with Show more (the images stay visible under it); the message being edited keeps a `--muted` outline,
 * which marks it without competing with the edit banner's accent for attention. With no text, skills, or images it
 * renders nothing.
 */
export function AgentChatUserMessageBubble({
    images,
    imageRecord,
    isEditing,
    skills = [],
    text,
    onOpenFile,
}: {
    /**
     * The message's images, shown under its text; its `[Image #N]` placeholders show them as pills.
     */
    images?: ReadonlyArray<{ thumbnail?: string }>;
    /**
     * Where the sent message lives, so an image without a thumbnail is read back from the provider's record.
     */
    imageRecord?: { terminalId: string; itemId: string };
    isEditing: boolean;
    /**
     * The skills the message asked the Agent to load, as chips ahead of its text.
     */
    skills?: readonly AgentChatSkillReference[];
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const { t } = useTranslation();
    const invocation = agentChatLeadingInvocation(text);
    const [isExpanded, setExpanded] = useState(false);
    const textReference = useRef<HTMLDivElement>(null);
    const isCut = useIsAgentChatClamped(textReference, { content: text, isClamped: !isExpanded });
    if (!text && skills.length === 0 && !images?.length) return null;
    return (
        <div
            className={cn(
                'max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground select-text',
                isEditing && 'outline outline-1 outline-muted',
            )}
            data-agent-chat-user-bubble=""
        >
            {(text || skills.length > 0) && (
                <div className={cn(!isExpanded && 'line-clamp-12')} ref={textReference}>
                    {skills.map(({ name }) => (
                        <AgentChatSkillPill key={name} name={name} />
                    ))}
                    {invocation ? (
                        <>
                            <AgentChatInvocationChip invocation={invocation.invocation} />
                            <AgentChatUserMessageBody
                                images={images}
                                text={invocation.rest}
                                onOpenFile={onOpenFile}
                            />
                        </>
                    ) : (
                        <AgentChatUserMessageBody
                            images={images}
                            text={text}
                            onOpenFile={onOpenFile}
                        />
                    )}
                </div>
            )}
            {isCut && (
                <button
                    aria-expanded={isExpanded}
                    className="mt-1 block cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted hover:text-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                >
                    {t(isExpanded ? 'agentChat.message.showLess' : 'agentChat.message.showMore')}
                </button>
            )}
            {images && images.length > 0 && (
                <AgentChatMessageImages
                    className={cn((text || skills.length > 0) && 'mt-2')}
                    firstNumber={agentChatFirstImageNumber(text, images.length)}
                    images={images}
                    message={imageRecord}
                />
            )}
            <AgentChatMessageVideos className="mt-2 first:mt-0" text={text} />
        </div>
    );
}
