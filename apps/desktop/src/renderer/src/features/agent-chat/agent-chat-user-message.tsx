import { useRef, useState } from 'react';

import { writeToClipboardWithFeedback } from '../../components/copy-feedback';
import { CopyIconButton } from '../../components/markdown/copy-icon-button';
import { WebLink } from '../../components/markdown/web-link';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { linkSummary } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { AgentChatInvocationChip } from './agent-chat-invocation-chip';
import { openAgentChatLink } from './agent-chat-links';
import { AgentChatMessageImages } from './agent-chat-message-images';
import { AgentChatMessageTime } from './agent-chat-message-time';
import { agentChatDeliveryCaption } from './agent-chat-presentation';
import { agentChatLeadingInvocation } from './agent-chat-slash-commands';
import { AgentChatUserMessageActions } from './agent-chat-user-message-actions';
import { agentChatUserMessageSegments } from './agent-chat-user-message-text';
import { useAgentChatEdit } from './hooks/use-agent-chat-edit';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';
import { useAgentChatUserMessageMenu } from './hooks/use-agent-chat-user-message-menu';
import { useIsAgentChatClamped } from './hooks/use-is-agent-chat-clamped';

/**
 * The user's message, right-aligned. A message steered into a running turn says so in a quiet caption under the bubble
 * (see `agentChatDeliveryCaption`). Under it, a row with the time it was sent and a Copy action appears while the
 * pointer is over the message or keyboard focus reaches it, as under an earlier reply; the row keeps its height, so
 * revealing it never shifts the transcript. A long message (a pasted log, a spec) clamps to twelve lines with Show
 * more, so one prompt does not push the reply it asked for off screen; Copy still takes the whole text. A message that
 * started a turn also offers "Edit from here", which puts its text back into the composer to send in its place (the
 * message being edited keeps a quiet `--muted` outline until then), "Fork from here", which opens the conversation
 * before it in a new Session with its text in the composer, and, when the provider restores files, "Restore code to
 * here", which reverts the files changed since and keeps the conversation, as Claude Code's `/rewind` "Restore code"
 * does. A right-click offers the same actions in a native menu (`agentChatUserMessageMenu`), so they are reachable
 * without finding the hover row.
 */
export function AgentChatUserMessage({
    createdAt,
    delivery,
    id,
    images,
    text,
    onOpenFile,
}: {
    createdAt?: number;
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
    const hasActions =
        text !== '' ||
        createdAt !== undefined ||
        edit?.availability(id) !== undefined ||
        edit?.restore?.availability(id) !== undefined;
    return (
        <div
            className="group/user-message flex flex-col items-end gap-1.5"
            data-agent-chat-user-message={id}
            ref={container}
            onContextMenu={menu.onContextMenu}
        >
            {images && images.length > 0 && (
                <AgentChatMessageImages
                    className="max-w-[85%]"
                    images={images}
                    message={terminalId === undefined ? undefined : { terminalId, itemId: id }}
                />
            )}
            {text && (
                <AgentChatUserMessageBubble
                    isEditing={isEditing}
                    text={text}
                    onOpenFile={onOpenFile}
                />
            )}
            {caption && <span className="-mt-0.5 text-[11px] leading-4 text-muted">{caption}</span>}
            {hasActions && (
                <div
                    className="-mt-1 flex h-6 items-center gap-1 opacity-0 group-hover/user-message:opacity-100 focus-within:opacity-100 has-[[aria-busy]]:opacity-100"
                    data-agent-chat-find-ignore=""
                >
                    {createdAt !== undefined && <AgentChatMessageTime timestamp={createdAt} />}
                    <AgentChatUserMessageActions
                        id={id}
                        isForking={menu.isForking}
                        isRestoring={menu.isRestoring}
                        text={text}
                        onFork={menu.fork}
                    />
                    {text && (
                        <CopyIconButton
                            className="-mr-1"
                            copy={() => writeToClipboardWithFeedback(navigator.clipboard, text)}
                            label={t('agentChat.message.copy')}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * The message bubble, shared with a message still on its way (`AgentChatPendingTimeline`). A long message clamps to
 * twelve lines with Show more; the message being edited keeps a `--muted` outline, which marks it without competing
 * with the edit banner's accent for attention.
 */
export function AgentChatUserMessageBubble({
    isEditing,
    text,
    onOpenFile,
}: {
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
                        <UserMessageText text={invocation.rest} onOpenFile={onOpenFile} />
                    </>
                ) : (
                    <UserMessageText text={text} onOpenFile={onOpenFile} />
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
 * editor, and a URL they pasted gets the same site icon and hover card as a link in a reply. Both stay in the bubble's
 * text color with a dotted underline, so a message full of links still reads as the user's message rather than a list
 * of links.
 */
function UserMessageText({
    text,
    onOpenFile,
}: {
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const terminalId = useAgentChatTerminal();
    const { t } = useTranslation();
    const segments = agentChatUserMessageSegments(text, { withFiles: onOpenFile !== undefined });
    return segments.map((segment, position) => {
        if (segment.kind === 'text') return segment.text;
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
                        className="cursor-pointer underline decoration-muted decoration-dotted underline-offset-3 transition-colors hover:text-accent hover:decoration-solid focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
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
                className="decoration-muted hover:text-accent"
                href={segment.url}
                key={position}
                referenceTerminalId={terminalId}
                summary={summary}
                onOpen={openAgentChatLink}
            >
                {segment.text}
            </WebLink>
        );
    });
}
