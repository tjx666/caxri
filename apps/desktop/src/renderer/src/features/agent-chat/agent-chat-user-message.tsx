import { useState } from 'react';

import { GitFork, History, Undo2 } from 'lucide-react';

import { writeToClipboardWithFeedback } from '../../components/copy-feedback';
import { CopyIconButton } from '../../components/markdown/copy-icon-button';
import { WebLink } from '../../components/markdown/web-link';
import { Tooltip } from '../../components/ui/tooltip';
import { linkSummary } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { AgentChatInvocationChip } from './agent-chat-invocation-chip';
import { openAgentChatLink } from './agent-chat-links';
import { AgentChatMessageImages } from './agent-chat-message-images';
import { AgentChatMessageTime } from './agent-chat-message-time';
import { agentChatDeliveryCaption } from './agent-chat-presentation';
import { agentChatLeadingInvocation } from './agent-chat-slash-commands';
import { agentChatUserMessageSegments } from './agent-chat-user-message-text';
import { useAgentChatEdit } from './hooks/use-agent-chat-edit';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';

/**
 * The user's message, right-aligned. A message steered into a running turn says so in a quiet caption under the bubble
 * (see `agentChatDeliveryCaption`). Under it, a row with the time it was sent and a Copy action appears while the
 * pointer is over the message or keyboard focus reaches it, as under a final reply; the row keeps its height, so
 * revealing it never shifts the transcript. A message that started a turn also offers "Edit from here", which puts its
 * text back into the composer to send in its place (the message being edited keeps an accent outline until then), "Fork
 * from here", which opens the conversation before it in a new Session with its text in the composer, and, when the
 * provider restores files, "Restore code to here", which reverts the files changed since and keeps the conversation, as
 * Claude Code's `/rewind` "Restore code" does.
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
    const terminalId = useAgentChatTerminal();
    const invocation = agentChatLeadingInvocation(text);
    const caption = agentChatDeliveryCaption(delivery);
    const edit = useAgentChatEdit();
    const isEditing = edit?.editingId === id;
    const hasActions =
        text !== '' ||
        createdAt !== undefined ||
        edit?.availability(id) !== undefined ||
        edit?.restore?.availability(id) !== undefined;
    return (
        <div
            className="group/user-message flex flex-col items-end gap-1.5"
            data-agent-chat-user-message={id}
        >
            {images && images.length > 0 && (
                <AgentChatMessageImages
                    className="max-w-[85%]"
                    images={images}
                    message={terminalId === undefined ? undefined : { terminalId, itemId: id }}
                />
            )}
            {text && (
                <div
                    className={cn(
                        'max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground select-text',
                        isEditing && 'outline outline-1 outline-accent',
                    )}
                >
                    {invocation ? (
                        <>
                            <AgentChatInvocationChip invocation={invocation.invocation} />
                            <UserMessageText text={invocation.rest} onOpenFile={onOpenFile} />
                        </>
                    ) : (
                        <UserMessageText text={text} onOpenFile={onOpenFile} />
                    )}
                </div>
            )}
            {caption && <span className="-mt-0.5 text-[11px] leading-4 text-muted">{caption}</span>}
            {hasActions && (
                <div className="-mt-1 flex h-6 items-center gap-1 opacity-0 group-hover/user-message:opacity-100 focus-within:opacity-100">
                    {createdAt !== undefined && <AgentChatMessageTime timestamp={createdAt} />}
                    <EditFromHereButton id={id} text={text} />
                    <ForkFromHereButton id={id} text={text} />
                    <RestoreCodeButton id={id} />
                    {text && (
                        <CopyIconButton
                            className="-mr-1"
                            copy={() => writeToClipboardWithFeedback(navigator.clipboard, text)}
                            label="Copy message"
                        />
                    )}
                </div>
            )}
        </div>
    );
}

const ACTION_BUTTON_CLASS =
    'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted';

/**
 * "Edit from here" in a user message's action row, when the Chat offers it for this message; disabled with the reason
 * on hover while it cannot run.
 */
function EditFromHereButton({ id, text }: { id: string; text: string }) {
    const edit = useAgentChatEdit();
    const availability = edit?.availability(id);
    if (!edit || availability === undefined) return null;
    return (
        <Tooltip content={availability ?? 'Edit from here'}>
            <button
                aria-label="Edit from here"
                className={ACTION_BUTTON_CLASS}
                disabled={availability !== null}
                type="button"
                onClick={() => edit.startEdit(id, text)}
            >
                <Undo2 className="size-3.5" />
            </button>
        </Tooltip>
    );
}

/**
 * "Fork from here" in a user message's action row, beside "Edit from here"; disabled with the reason on hover while it
 * cannot run, and while a fork it started is in flight so a second click cannot open two Sessions.
 */
function ForkFromHereButton({ id, text }: { id: string; text: string }) {
    const edit = useAgentChatEdit();
    const [isForking, setIsForking] = useState(false);
    const availability = edit?.forkAvailability(id);
    if (!edit || availability === undefined) return null;
    return (
        <Tooltip content={availability ?? 'Fork from here'}>
            <button
                aria-label="Fork from here"
                className={ACTION_BUTTON_CLASS}
                disabled={availability !== null || isForking}
                type="button"
                onClick={() => {
                    setIsForking(true);
                    // eslint-disable-next-line no-void -- `forkAgentChat` reports its own failure through a toast
                    void edit.fork(id, text).finally(() => setIsForking(false));
                }}
            >
                <GitFork className="size-3.5" />
            </button>
        </Tooltip>
    );
}

/**
 * "Restore code to here" in a user message's action row, when the provider restores files; disabled with the reason on
 * hover while it cannot run.
 */
function RestoreCodeButton({ id }: { id: string }) {
    const restore = useAgentChatEdit()?.restore;
    const availability = restore?.availability(id);
    if (!restore || availability === undefined) return null;
    return (
        <Tooltip content={availability ?? 'Restore code to here'}>
            <button
                aria-label="Restore code to here"
                className={ACTION_BUTTON_CLASS}
                disabled={availability !== null}
                type="button"
                onClick={() => restore.run(id)}
            >
                <History className={ACTION_BUTTON_CLASS} />
            </button>
        </Tooltip>
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
    const segments = agentChatUserMessageSegments(text, { withFiles: onOpenFile !== undefined });
    return segments.map((segment, position) => {
        if (segment.kind === 'text') return segment.text;
        if (segment.kind === 'file')
            return (
                <button
                    className="cursor-pointer border-0 bg-transparent p-0 text-left underline decoration-muted decoration-dotted underline-offset-3 transition-colors hover:text-accent hover:decoration-solid focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    key={position}
                    title={`Open ${segment.file}`}
                    type="button"
                    onClick={() => onOpenFile?.(segment.file)}
                >
                    {segment.text}
                </button>
            );
        const summary = linkSummary(segment.url);
        if (!summary) return segment.text;
        return (
            <WebLink
                className="decoration-muted hover:text-accent"
                href={segment.url}
                key={position}
                summary={summary}
                onOpen={openAgentChatLink}
            >
                {segment.text}
            </WebLink>
        );
    });
}
