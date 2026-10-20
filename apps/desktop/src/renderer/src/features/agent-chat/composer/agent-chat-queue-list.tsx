import type { ReactNode } from 'react';
import { useState } from 'react';

import type { AgentChatQueuedMessage, AgentChatSnapshot } from '@caxri/protocol';
import {
    CircleAlert,
    CornerDownLeft,
    CornerDownRight,
    Pause,
    Pencil,
    Play,
    RotateCw,
    Trash2,
} from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { cn } from '../../../lib/utilities';
import {
    didSaveAgentChatQueuedText,
    editAgentChatQueued,
    removeAgentChatQueued,
    resumeAgentChatQueue,
    sendAgentChatQueuedNow,
} from '../agent-chat-commands';
import type { AgentChatPendingMessage } from '../transcript/agent-chat-pending';
import type { AgentChatQueueEntryView } from './agent-chat-queue';
import {
    agentChatQueueCardLabels,
    agentChatQueuedTextAfterEdit,
    agentChatQueuedTextEdit,
    agentChatQueueEntries,
    agentChatQueueHeader,
} from './agent-chat-queue';

/**
 * The card actions use `aria-disabled` rather than `disabled`, like the composer's Send: a natively disabled button
 * gets no pointer events in Chromium, so the tooltip that says why the action is unavailable would never open. Each
 * click handler refuses an unavailable action itself.
 */
function noop(): void {}

const ACTION_CLASS_NAME = 'text-muted not-aria-disabled:hover:text-foreground';

/**
 * One card action behind its tooltip. An unavailable action stays focusable and pointable (`ACTION_CLASS_NAME`), and
 * its click does nothing; an available one runs, then reports through `onAction`.
 */
function QueueCardAction({
    ariaLabel,
    children,
    className,
    isDisabled,
    onAction,
    onRun,
    size,
    tooltip,
}: {
    ariaLabel: string;
    children: ReactNode;
    className: string;
    isDisabled: boolean;
    onAction: () => void;
    onRun: () => void;
    size: 'icon' | 'sm';
    tooltip: string;
}) {
    return (
        <Tooltip content={tooltip}>
            <Button
                aria-disabled={isDisabled || undefined}
                aria-label={ariaLabel}
                className={cn(ACTION_CLASS_NAME, className)}
                size={size}
                variant="ghost"
                onClick={() => {
                    if (isDisabled) return;
                    onRun();
                    onAction();
                }}
            >
                {children}
            </Button>
        </Tooltip>
    );
}

/**
 * Edits the text of a queued message that carries images, in its own row: the images stay on Server Core and cannot
 * return to the composer, so the message is rewritten where it stands and the row says how many images ride with it.
 * Enter saves and Escape cancels, like the other inline editors.
 */
function QueueTextEditor({
    entry,
    onClose,
    terminalId,
}: {
    entry: AgentChatQueueEntryView;
    onClose: () => void;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const { prefix, body } = agentChatQueuedTextEdit(entry.text);
    const [value, setValue] = useState(body);
    const [isSaving, setIsSaving] = useState(false);
    const imageCount = entry.imageCount;
    const save = async (): Promise<void> => {
        if (isSaving) return;
        setIsSaving(true);
        let isSaved: boolean;
        try {
            isSaved = await didSaveAgentChatQueuedText(
                terminalId,
                entry.id,
                agentChatQueuedTextAfterEdit(prefix, value),
            );
        } finally {
            setIsSaving(false);
        }
        if (isSaved) onClose();
    };
    return (
        <li className="flex min-w-0 flex-col gap-1 rounded-md py-1 pr-1 pl-2 text-[12px] leading-5">
            <Textarea
                autoFocus
                aria-label={t('agentChat.queue.editLabel')}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                    if (isImeComposing(event)) return;
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        onClose();
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
                        void save();
                    }
                }}
            />
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                    {imageCount === 1
                        ? t('agentChat.queue.imagesAttachedOne')
                        : t('agentChat.queue.imagesAttachedOther', { count: imageCount })}
                </span>
                <span className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={onClose}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        aria-disabled={isSaving || (!value.trim() && imageCount === 0) || undefined}
                        size="sm"
                        onClick={() => {
                            // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
                            void save();
                        }}
                    >
                        {t('common.save')}
                    </Button>
                </span>
            </div>
        </li>
    );
}

function QueueCard({
    entry,
    onAction,
    onEdit,
    terminalId,
}: {
    entry: AgentChatQueueEntryView;
    onAction: () => void;
    onEdit: (text: string) => void;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const isPending = entry.isPending === true;
    const labels = agentChatQueueCardLabels(entry, t);
    const [isEditingText, setIsEditingText] = useState(false);
    if (isEditingText)
        return (
            <QueueTextEditor
                entry={entry}
                terminalId={terminalId}
                onClose={() => {
                    setIsEditingText(false);
                    onAction();
                }}
            />
        );
    return (
        <li
            aria-busy={isPending}
            className={cn(
                'flex min-w-0 items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 text-[12px] leading-5 hover:bg-list-hover-background',
                isPending && 'opacity-60',
            )}
        >
            <span className="flex min-w-0 flex-1 items-center gap-2">
                <CornerDownRight aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                {entry.commandLabel && (
                    <span className="shrink-0 rounded bg-elevated px-1 font-mono text-[11px] text-foreground">
                        {entry.commandLabel}
                    </span>
                )}
                <span className="min-w-0 truncate text-foreground">{entry.preview}</span>
                {entry.imageLabel && (
                    <span className="shrink-0 text-[11px] text-muted">{entry.imageLabel}</span>
                )}
            </span>
            <QueueCardAction
                ariaLabel={t('agentChat.queue.editMessage')}
                className="size-6"
                isDisabled={!entry.canEdit}
                size="icon"
                tooltip={labels.editTooltip}
                // A message with images is edited in its row, which keeps focus there until it closes.
                onAction={entry.imageCount > 0 ? noop : onAction}
                onRun={() => {
                    if (entry.imageCount > 0) {
                        setIsEditingText(true);
                        return;
                    }
                    // eslint-disable-next-line no-void -- the command reports its own failures through tryCommand
                    void editAgentChatQueued(terminalId, entry.id, onEdit);
                }}
            >
                <Pencil className="size-3.5" />
            </QueueCardAction>
            <QueueCardAction
                ariaLabel={t('agentChat.queue.deleteMessage')}
                className="size-6"
                isDisabled={isPending}
                size="icon"
                tooltip={labels.deleteTooltip}
                onAction={onAction}
                onRun={() => removeAgentChatQueued(terminalId, entry.id)}
            >
                <Trash2 className="size-3.5" />
            </QueueCardAction>
            <QueueCardAction
                ariaLabel={labels.sendAriaLabel}
                className="min-h-6 shrink-0 gap-1 px-1.5"
                isDisabled={!entry.canSendNow}
                size="sm"
                tooltip={labels.sendTooltip}
                onAction={onAction}
                onRun={() => sendAgentChatQueuedNow(terminalId, entry.id)}
            >
                <CornerDownLeft className="size-3.5" />
                {labels.sendText}
            </QueueCardAction>
        </li>
    );
}

/**
 * Follow-ups waiting for the running turn, in the order Server Core will send them, as one list just above the
 * composer. Each can be taken back into the composer, deleted, or sent now (steering the running turn). After the user
 * stops a turn the queue pauses instead of firing the next message by surprise, and says so with a Resume action; a
 * pause caused by a failed send says that in `--danger` and offers Retry instead (`agentChatQueueHeader`).
 */
export function AgentChatQueueList({
    isTurnRunning,
    onAction,
    onEdit,
    pending,
    queue,
    snapshot,
    terminalId,
}: {
    isTurnRunning: boolean;
    /**
     * Runs after any queue action. Each one removes the control that was clicked (the card leaves the queue, or the
     * paused header goes away), so the caller moves focus back to the message input instead of losing it to the body.
     */
    onAction: () => void;
    /**
     * Puts a queued message's text back into the composer once it left the queue.
     */
    onEdit: (text: string) => void;
    /**
     * Messages sent to wait here that Server Core does not list yet; they follow its entries with their actions held.
     */
    pending: readonly AgentChatPendingMessage[];
    queue: readonly AgentChatQueuedMessage[] | undefined;
    /**
     * Whether the queue is paused and why (`queuePauseReason`).
     */
    snapshot: Pick<AgentChatSnapshot, 'queuePauseReason' | 'queuePaused'> | undefined;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const entries = agentChatQueueEntries(queue, isTurnRunning, pending);
    if (entries.length === 0) return null;
    const header = agentChatQueueHeader(snapshot, isTurnRunning, entries, t);
    const isFailed = header.tone === 'failed';
    return (
        <section
            aria-label={t('agentChat.queue.label')}
            className="border-0 border-b border-solid border-border p-1"
            data-agent-chat-composer-strip-row=""
        >
            <h3 className="m-0 flex min-h-6 items-center gap-2 pr-0.5 pl-2 text-[11px] font-normal text-muted">
                {header.resumeLabel ? (
                    <>
                        {isFailed ? (
                            <CircleAlert
                                aria-hidden="true"
                                className="size-3 shrink-0 text-danger"
                            />
                        ) : (
                            <Pause aria-hidden="true" className="size-3 shrink-0 text-warning" />
                        )}
                        <span className={cn('min-w-0 flex-1 truncate', isFailed && 'text-danger')}>
                            {header.text}
                        </span>
                        <Button
                            className="min-h-5 shrink-0 gap-1 px-1.5 text-[11px]"
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                resumeAgentChatQueue(terminalId);
                                onAction();
                            }}
                        >
                            {isFailed ? (
                                <RotateCw className="size-3" />
                            ) : (
                                <Play className="size-3" />
                            )}
                            {header.resumeLabel}
                        </Button>
                    </>
                ) : (
                    <span className="min-w-0 flex-1 truncate">{header.text}</span>
                )}
            </h3>
            <ol className="m-0 flex max-h-40 list-none flex-col overflow-y-auto p-0">
                {entries.map((entry) => (
                    <QueueCard
                        entry={entry}
                        key={entry.id}
                        terminalId={terminalId}
                        onAction={onAction}
                        onEdit={onEdit}
                    />
                ))}
            </ol>
        </section>
    );
}
