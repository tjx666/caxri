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

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    didRemoveAgentChatQueued,
    editAgentChatQueued,
    resumeAgentChatQueue,
    sendAgentChatQueuedNow,
} from './agent-chat-commands';
import type { AgentChatPendingMessage } from './agent-chat-pending';
import type { AgentChatQueueEntryView } from './agent-chat-queue';
import { agentChatQueueEntries, agentChatQueueHeader } from './agent-chat-queue';

/**
 * The card actions use `aria-disabled` rather than `disabled`, like the composer's Send: a natively disabled button
 * gets no pointer events in Chromium, so the tooltip that says why the action is unavailable would never open. Each
 * click handler refuses an unavailable action itself.
 */
const ACTION_CLASS_NAME = 'text-muted not-aria-disabled:hover:text-foreground';

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
    const isSteer = entry.sendNowLabel === 'Steer';
    const isPending = entry.isPending === true;
    const canDelete = !isPending;
    return (
        <li
            aria-busy={isPending}
            className={cn(
                'flex min-w-0 items-center gap-1 rounded py-0.5 pr-0.5 pl-2 text-[12px] leading-5 hover:bg-[var(--selection)]',
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
            <Tooltip
                content={
                    isPending
                        ? t('agentChat.message.sending')
                        : t(entry.canEdit ? 'common.edit' : 'agentChat.edit.imagesUnsupported')
                }
            >
                <Button
                    aria-disabled={!entry.canEdit || undefined}
                    aria-label={t('agentChat.queue.editMessage')}
                    className={cn(ACTION_CLASS_NAME, 'size-6')}
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                        if (!entry.canEdit) return;
                        // eslint-disable-next-line no-void -- the command reports its own failures through tryCommand
                        void editAgentChatQueued(terminalId, entry, onEdit);
                        onAction();
                    }}
                >
                    <Pencil className="size-3.5" />
                </Button>
            </Tooltip>
            <Tooltip content={t(isPending ? 'agentChat.message.sending' : 'common.delete')}>
                <Button
                    aria-disabled={!canDelete || undefined}
                    aria-label={t('agentChat.queue.deleteMessage')}
                    className={cn(ACTION_CLASS_NAME, 'size-6')}
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                        if (!canDelete) return;
                        // eslint-disable-next-line no-void -- the command reports its own failures through tryCommand
                        void didRemoveAgentChatQueued(terminalId, entry.id);
                        onAction();
                    }}
                >
                    <Trash2 className="size-3.5" />
                </Button>
            </Tooltip>
            <Tooltip
                content={
                    isPending
                        ? t('agentChat.message.sending')
                        : entry.canSendNow
                          ? t(isSteer ? 'agentChat.queue.steerTooltip' : 'agentChat.queue.sendNow')
                          : t('agentChat.queue.commandWaits')
                }
            >
                <Button
                    aria-disabled={!entry.canSendNow || undefined}
                    aria-label={t(isSteer ? 'agentChat.queue.steerNow' : 'agentChat.queue.sendNow')}
                    className={cn(ACTION_CLASS_NAME, 'min-h-6 shrink-0 gap-1 px-1.5')}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        if (!entry.canSendNow) return;
                        sendAgentChatQueuedNow(terminalId, entry.id);
                        onAction();
                    }}
                >
                    <CornerDownLeft className="size-3.5" />
                    {t(isSteer ? 'agentChat.queue.steer' : 'agentChat.queue.sendNow')}
                </Button>
            </Tooltip>
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
            className="mb-2 rounded-md border border-border bg-surface p-1"
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
