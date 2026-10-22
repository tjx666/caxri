import type { ReactNode } from 'react';
import { useState } from 'react';

import type { AgentChatQueuedMessage, AgentChatSnapshot } from '@caxri/protocol';
import {
    ArrowUpToLine,
    CircleAlert,
    CornerDownLeft,
    Pause,
    Pencil,
    Play,
    RotateCw,
    Trash2,
} from 'lucide-react';

import { ShortcutBadge } from '../../../components/shortcut-badge';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { awaitThenCleanup } from '../../../lib/await-then-cleanup';
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

/**
 * Row actions stay out of sight until the row is hovered or holds focus, so a queue reads as the messages themselves.
 * They are only transparent, never removed, so Tab still reaches them and reveals them.
 */
const ACTION_CLASS_NAME =
    'size-6 text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 not-aria-disabled:hover:text-foreground';

/**
 * One card action behind its tooltip. An unavailable action stays focusable and pointable (`ACTION_CLASS_NAME`), and
 * its click does nothing; an available one runs, then reports through `onAction`.
 */
function QueueCardAction({
    ariaLabel,
    children,
    isDisabled,
    onAction,
    onRun,
    tooltip,
}: {
    ariaLabel: string;
    children: ReactNode;
    isDisabled: boolean;
    onAction: () => void;
    onRun: () => void;
    tooltip: string;
}) {
    return (
        <Tooltip content={tooltip}>
            <Button
                aria-disabled={isDisabled || undefined}
                aria-label={ariaLabel}
                className={ACTION_CLASS_NAME}
                size="icon"
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
        const isSaved = await awaitThenCleanup(
            didSaveAgentChatQueuedText(
                terminalId,
                entry.id,
                agentChatQueuedTextAfterEdit(prefix, value),
            ),
            () => setIsSaving(false),
        );
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
    isEnterTarget,
    isTurnRunning,
    onAction,
    onEdit,
    terminalId,
}: {
    entry: AgentChatQueueEntryView;
    /**
     * Whether Enter in the empty composer steers this message now, which the row shows as a keycap chip.
     */
    isEnterTarget: boolean;
    isTurnRunning: boolean;
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
                'group relative flex min-w-0 items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 text-[12px] leading-5 focus-within:pr-21 hover:bg-list-hover-background hover:pr-21',
                isPending && 'opacity-60',
            )}
        >
            <span className="flex min-w-0 flex-1 items-center gap-2">
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
            {isEnterTarget && (
                // Stays while the composer is focused (the caller passes `enterQueuedId` only then), hover included.
                <span
                    aria-hidden="true"
                    className="flex shrink-0 items-center gap-1 pr-1.5 text-[11px] text-muted"
                    data-agent-chat-queue-enter-hint=""
                >
                    <ShortcutBadge compact shortcut="enter" />
                    {t('agentChat.queue.steer')}
                </span>
            )}
            {/*
             * The actions float over the row's end instead of holding their width in the flow, so while they are hidden
             * the Enter hint sits flush with the row's end. Hover or focus pads the row by their width (`pr-21`), so they
             * never cover the message or the hint. They stay full size and in place, so a pointer or Tab reaches them.
             */}
            <span className="absolute inset-y-0 right-0.5 flex items-center gap-1">
                <QueueCardAction
                    ariaLabel={t('agentChat.queue.editMessage')}
                    isDisabled={!entry.canEdit}
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
                    isDisabled={isPending}
                    tooltip={labels.deleteTooltip}
                    onAction={onAction}
                    onRun={() => removeAgentChatQueued(terminalId, entry.id)}
                >
                    <Trash2 className="size-3.5" />
                </QueueCardAction>
                <QueueCardAction
                    ariaLabel={labels.sendAriaLabel}
                    isDisabled={!entry.canSendNow}
                    tooltip={labels.sendTooltip}
                    onAction={onAction}
                    onRun={() => sendAgentChatQueuedNow(terminalId, entry.id)}
                >
                    {isTurnRunning ? (
                        <ArrowUpToLine className="size-3.5" />
                    ) : (
                        <CornerDownLeft className="size-3.5" />
                    )}
                </QueueCardAction>
            </span>
        </li>
    );
}

/**
 * Follow-ups waiting for the running turn, in the order Server Core will send them, as one list just above the
 * composer. Each row shows only the message until hovered or focused, then offers taking it back into the composer,
 * deleting it, or sending it now (steering the running turn). While the composer is focused and empty, the row Enter
 * would steer carries an `Enter Steer` chip, kept on hover, so that shortcut is visible where its effect lands. After
 * the user stops a turn the queue pauses instead of firing the next message by surprise, and says so with a Resume
 * action; a pause caused by a failed send says that in `--danger` and offers Retry instead (`agentChatQueueHeader`).
 */
export function AgentChatQueueList({
    enterQueuedId,
    isTurnRunning,
    onAction,
    onEdit,
    pending,
    queue,
    snapshot,
    terminalId,
}: {
    /**
     * The queued message Enter in the empty composer steers now, or `undefined` while a draft is typed or no turn runs.
     */
    enterQueuedId: string | undefined;
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
                        isEnterTarget={entry.id === enterQueuedId}
                        isTurnRunning={isTurnRunning}
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
