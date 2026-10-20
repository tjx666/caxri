import { useRef, useState } from 'react';

import type { AgentChatDelegatedTask } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

import { writeToClipboardWithFeedback } from '../../../components/copy-feedback';
import { CopyIconButton } from '../../../components/markdown/copy-icon-button';
import { WebLink } from '../../../components/markdown/web-link';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { linkSummary } from '../../../lib/link-summary';
import { cn } from '../../../lib/utilities';
import { AgentChatImagePill } from '../attachments/agent-chat-image-pill';
import { AgentChatMessageImages } from '../attachments/agent-chat-message-images';
import { AgentChatPathReferenceChips } from '../attachments/agent-chat-path-reference-chips';
import { AgentChatInvocationChip } from '../composer/agent-chat-invocation-chip';
import { agentChatLeadingInvocation } from '../composer-input/agent-chat-slash-commands';
import { useAgentChatEdit } from '../hooks/use-agent-chat-edit';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { useAgentChatUserMessageMenu } from '../hooks/use-agent-chat-user-message-menu';
import { useIsAgentChatClamped } from '../hooks/use-is-agent-chat-clamped';
import { AgentChatDelegatedTaskBubble } from '../tasks/agent-chat-delegated-task-bubble';
import { openAgentChatLink } from '../transcript/agent-chat-links';
import { agentChatDeliveryCaption } from '../transcript/agent-chat-presentation';
import { AgentChatMessageTime } from './agent-chat-message-time';
import { AgentChatReplyFrame } from './agent-chat-reply-frame';
import { AgentChatUserMessageActions } from './agent-chat-user-message-actions';
import {
    agentChatUserMessageSegments,
    hasAgentChatImagePlaceholders,
} from './agent-chat-user-message-text';

/**
 * The user's message, right-aligned. A message steered into a running turn says so in a quiet caption under the bubble
 * (see `agentChatDeliveryCaption`). Under it, a row with the time it was sent and a Copy action mounts while the
 * pointer is over the message or keyboard focus is inside it, exactly as under a reply (`AgentChatReplyFrame`): the row
 * keeps its height, so revealing it never shifts the transcript, and a hidden row is no Tab stop. `Option+ArrowUp` and
 * `Option+ArrowDown` step through user messages and replies alike to reach it from the keyboard. A long message (a
 * pasted log, a spec) clamps to twelve lines with Show more, so one prompt does not push the reply it asked for off
 * screen; Copy still takes the whole text. A message that started a turn also offers "Edit from here", which puts its
 * text back into the composer to send in its place (the message being edited keeps a quiet `--muted` outline until
 * then), "Fork from here", which opens the conversation before it in a new Session with its text in the composer, and,
 * when the provider restores files, "Restore code to here", which reverts the files changed since and keeps the
 * conversation, as Claude Code's `/rewind` "Restore code" does. A right-click offers the same actions in a native menu
 * (`agentChatUserMessageMenu`), so they are reachable without finding the hover row; a message read back from history
 * lists Edit and Fork there disabled with why. Files and folders the message cites (`agentChatTextWithPathReferences`)
 * show as chips under its images rather than as the reference block the provider received; clicking one shows it in
 * Finder.
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
    const { references, skills, text: words } = parseAgentChatPathReferences(text);
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
                    copy={() => writeToClipboardWithFeedback(navigator.clipboard, words)}
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
            {images && images.length > 0 && (
                <AgentChatMessageImages
                    className="max-w-[85%]"
                    images={images}
                    isNumbered={hasAgentChatImagePlaceholders(words, images.length)}
                    message={terminalId === undefined ? undefined : { terminalId, itemId: id }}
                />
            )}
            <AgentChatPathReferenceChips references={references} skills={skills} />
            {delegatedTask ? (
                <AgentChatDelegatedTaskBubble task={delegatedTask} text={text} />
            ) : (
                words && (
                    <AgentChatUserMessageBubble
                        images={images}
                        isEditing={isEditing}
                        text={words}
                        onOpenFile={onOpenFile}
                    />
                )
            )}
            {caption && <span className="-mt-0.5 text-[11px] leading-4 text-muted">{caption}</span>}
        </AgentChatReplyFrame>
    );
}

/**
 * The message bubble, shared with a message still on its way (`AgentChatPendingTimeline`). A long message clamps to
 * twelve lines with Show more; the message being edited keeps a `--muted` outline, which marks it without competing
 * with the edit banner's accent for attention.
 */
export function AgentChatUserMessageBubble({
    images,
    isEditing,
    text,
    onOpenFile,
}: {
    /**
     * The message's images, which its `[Image #N]` placeholders show as pills.
     */
    images?: ReadonlyArray<{ thumbnail?: string }>;
    isEditing: boolean;
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const { t } = useTranslation();
    const invocation = agentChatLeadingInvocation(text);
    const [isExpanded, setExpanded] = useState(false);
    const textReference = useRef<HTMLDivElement>(null);
    const isCut = useIsAgentChatClamped(textReference, { content: text, isClamped: !isExpanded });
    return (
        <div
            className={cn(
                'max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground select-text',
                isEditing && 'outline outline-1 outline-muted',
            )}
        >
            <div className={cn(!isExpanded && 'line-clamp-12')} ref={textReference}>
                {invocation ? (
                    <>
                        <AgentChatInvocationChip invocation={invocation.invocation} />
                        <UserMessageText
                            images={images}
                            text={invocation.rest}
                            onOpenFile={onOpenFile}
                        />
                    </>
                ) : (
                    <UserMessageText images={images} text={text} onOpenFile={onOpenFile} />
                )}
            </div>
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
        </div>
    );
}

/**
 * The user's own words, verbatim. A path they typed or dropped in (`src/app.ts:12`, an absolute path) opens in the
 * editor, and a URL they pasted gets the same site icon and hover card as a link in a reply. Both take the reply's link
 * treatment (the full accent with no underline until hover), so a link reads the same on both sides of the transcript.
 * An image's placeholder reads as the pill it was in the composer.
 */
function UserMessageText({
    images,
    text,
    onOpenFile,
}: {
    images: ReadonlyArray<{ thumbnail?: string }> | undefined;
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const terminalId = useAgentChatTerminal();
    const { t } = useTranslation();
    const segments = agentChatUserMessageSegments(text, {
        withFiles: onOpenFile !== undefined,
        imageCount: images?.length,
    });
    return segments.map((segment, position) => {
        if (segment.kind === 'text') return segment.text;
        if (segment.kind === 'image')
            return (
                <AgentChatImagePill
                    key={position}
                    number={segment.number}
                    thumbnail={images?.[segment.number - 1]?.thumbnail}
                />
            );
        if (segment.kind === 'file')
            /*
             * An anchor rather than a `<button>`: a button is an atomic inline block, so a long path that does not fit the
             * line moves whole to the next one and leaves the quotes around it on lines of their own, while an anchor
             * wraps with the surrounding text. Main denies every window navigation, so `href` is semantic only (it makes
             * the anchor focusable and Enter-activated); the click opens the file instead.
             */
            return (
                <Tooltip
                    content={t('agentChat.timeline.openNamed', { name: segment.file })}
                    key={position}
                >
                    <a
                        className="cursor-pointer text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                        href={segment.file}
                        onClick={(event) => {
                            event.preventDefault();
                            onOpenFile?.(segment.file);
                        }}
                    >
                        {segment.text}
                    </a>
                </Tooltip>
            );
        const summary = linkSummary(segment.url);
        if (!summary) return segment.text;
        return (
            <WebLink
                className="text-accent hover:underline"
                href={segment.url}
                key={position}
                referenceTerminalId={terminalId}
                // The message's hover action row sits right under the bubble; a card opening below would cover it.
                side="top"
                summary={summary}
                onOpen={openAgentChatLink}
            >
                {segment.text}
            </WebLink>
        );
    });
}
