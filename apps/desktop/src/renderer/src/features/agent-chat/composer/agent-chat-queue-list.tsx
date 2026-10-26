import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';

import type { AgentChatQueuedMessage, AgentChatSnapshot } from '@caxri/protocol';
import { agentChatQueuedTextAfterEdit, agentChatQueuedTextEdit } from '@caxri/protocol';
import {
    CircleAlert,
    CornerDownRight,
    ListEnd,
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
import {
    readAgentChatDraft,
    subscribeAgentChatDraftChanges,
} from '../composer-input/agent-chat-drafts';
import type { AgentChatPendingMessage } from '../transcript/agent-chat-pending';
import type { AgentChatQueueEntryView } from './agent-chat-queue';
import {
    agentChatQueueCardLabels,
    agentChatQueueDeleteOutcome,
    agentChatQueueEntries,
    agentChatQueueHeader,
} from './agent-chat-queue';

/**
 * Row actions always show, as the Codex app's queue does, so what a queued message offers is visible without hunting
 * for it with the pointer.
 */
const ACTION_CLASS_NAME = 'min-h-6 text-muted not-aria-disabled:hover:text-foreground';

/**
 * One card action behind its tooltip. It uses `aria-disabled` rather than `disabled`, like the composer's Send: a
 * natively disabled button gets no pointer events in Chromium, so the tooltip that says why the action is unavailable
 * would never open. An unavailable action stays focusable and pointable, and its click does nothing; an available one
 * runs, then reports through `onAction`. With a `label` it shows its glyph and that word, otherwise the glyph alone.
 */
function QueueCardAction({
    ariaLabel,
    children,
    isDisabled,
    label,
    onAction,
    onRun,
    tooltip,
}: {
    ariaLabel: string;
    children: ReactNode;
    isDisabled: boolean;
    label?: string;
    onAction: () => void;
    onRun: () => void;
    tooltip: string;
}) {
    return (
        <Tooltip content={tooltip}>
            <Button
                aria-disabled={isDisabled || undefined}
                aria-label={ariaLabel}
                className={cn(ACTION_CLASS_NAME, label ? 'gap-1 px-1.5 text-[12px]' : 'size-6')}
                size={label ? 'sm' : 'icon'}
                variant="ghost"
                onClick={() => {
                    if (isDisabled) return;
                    onRun();
                    onAction();
                }}
            >
                {children}
                {label}
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

/**
 * One queued message as the Codex app lays it out: a queue glyph, the message, then its actions, always shown: Steer
 * (Send now with no turn running) as a labeled button, then Edit and Delete as icons. Edit is a button of its own
 * rather than a More menu, since a menu holding one item costs a click and hides nothing.
 */
function QueueCard({
    entry,
    isTurnRunning,
    onAction,
    onEdit,
    terminalId,
}: {
    entry: AgentChatQueueEntryView;
    isTurnRunning: boolean;
    onAction: () => void;
    onEdit: (text: string) => void;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const isPending = entry.isPending === true;
    // Subscribes to whether the draft is empty, not to its text, so typing re-renders the card only when that flips.
    const isDraftEmpty = useSyncExternalStore(
        (listener) => subscribeAgentChatDraftChanges(terminalId, listener),
        () => readAgentChatDraft(terminalId).trim() === '',
    );
    const labels = agentChatQueueCardLabels(
        entry,
        t,
        agentChatQueueDeleteOutcome(isDraftEmpty, entry),
    );
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
                'flex min-h-8 min-w-0 items-center gap-2 rounded-md py-0.5 pr-0.5 pl-2 text-[13px] leading-5',
                isPending && 'opacity-60',
            )}
        >
            <ListEnd aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
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
            <span className="flex shrink-0 items-center gap-0.5">
                <QueueCardAction
                    ariaLabel={labels.sendAriaLabel}
                    isDisabled={!entry.canSendNow}
                    label={t(isTurnRunning ? 'agentChat.queue.steer' : 'agentChat.queue.sendNow')}
                    tooltip={labels.sendTooltip}
                    onAction={onAction}
                    onRun={() => sendAgentChatQueuedNow(terminalId, entry.id)}
                >
                    <CornerDownRight aria-hidden="true" className="size-3.5" />
                </QueueCardAction>
                <QueueCardAction
                    ariaLabel={t('agentChat.queue.editMessage')}
                    isDisabled={!entry.canEdit || isPending}
                    tooltip={labels.editTooltip}
                    onAction={() => {
                        // A message with images is edited in its row, which keeps focus there until it closes.
                        if (entry.imageCount === 0) onAction();
                    }}
                    onRun={() => {
                        if (entry.imageCount > 0) setIsEditingText(true);
                        else void editAgentChatQueued(terminalId, entry.id, onEdit);
                    }}
                >
                    <Pencil aria-hidden="true" className="size-3.5" />
                </QueueCardAction>
                <QueueCardAction
                    ariaLabel={labels.deleteAriaLabel}
                    isDisabled={isPending}
                    tooltip={labels.deleteTooltip}
                    onAction={onAction}
                    onRun={() => {
                        // Read the draft at click time: the composer may have changed since the card last rendered.
                        const isEmpty = readAgentChatDraft(terminalId).trim() === '';
                        if (agentChatQueueDeleteOutcome(isEmpty, entry) === 'restore')
                            void editAgentChatQueued(
                                terminalId,
                                entry.id,
                                onEdit,
                                'agentChat.commands.removeQueuedFailed',
                            );
                        else removeAgentChatQueued(terminalId, entry.id);
                    }}
                >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                </QueueCardAction>
            </span>
        </li>
    );
}

/**
 * Follow-ups waiting for the running turn, in the order Server Core will send them, as one list just above the
 * composer. Each row offers sending it now (steering the running turn), deleting it, and taking it back into the
 * composer. After the user stops a turn the queue pauses instead of firing the next message by surprise, and says so
 * with a Resume action; a pause caused by a failed send says that in `--danger` and offers Retry instead
 * (`agentChatQueueHeader`).
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
    const header = agentChatQueueHeader(snapshot, t);
    const isFailed = header?.tone === 'failed';
    return (
        <section
            aria-label={t('agentChat.queue.label')}
            className="border-0 border-b border-solid border-border p-1"
            data-agent-chat-composer-strip-row=""
        >
            {header && (
                <h3 className="m-0 flex min-h-6 items-center gap-2 pr-0.5 pl-2 text-[11px] font-normal text-muted">
                    {isFailed ? (
                        <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-danger" />
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
                        {isFailed ? <RotateCw className="size-3" /> : <Play className="size-3" />}
                        {header.resumeLabel}
                    </Button>
                </h3>
            )}
            <ol className="m-0 flex max-h-40 list-none flex-col overflow-y-auto p-0">
                {entries.map((entry) => (
                    <QueueCard
                        entry={entry}
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
