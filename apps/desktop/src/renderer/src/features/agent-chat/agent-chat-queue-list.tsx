import type { AgentChatQueuedMessage } from '@caxri/protocol';
import { CornerDownLeft, CornerDownRight, Pause, Pencil, Play, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    editAgentChatQueued,
    removeAgentChatQueued,
    resumeAgentChatQueue,
    sendAgentChatQueuedNow,
} from './agent-chat-commands';
import type { AgentChatPendingMessage } from './agent-chat-pending';
import type { AgentChatQueueEntryView } from './agent-chat-queue';
import { agentChatQueueEntries } from './agent-chat-queue';

const ACTION_CLASS_NAME = 'size-6 text-muted hover:text-foreground';

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
                    aria-label={t('agentChat.queue.editMessage')}
                    className={ACTION_CLASS_NAME}
                    disabled={!entry.canEdit}
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- the command reports its own failures through tryCommand
                        void editAgentChatQueued(terminalId, entry.id, onEdit);
                        onAction();
                    }}
                >
                    <Pencil className="size-3.5" />
                </Button>
            </Tooltip>
            <Tooltip content={t(isPending ? 'agentChat.message.sending' : 'common.delete')}>
                <Button
                    aria-label={t('agentChat.queue.deleteMessage')}
                    className={ACTION_CLASS_NAME}
                    disabled={isPending}
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                        removeAgentChatQueued(terminalId, entry.id);
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
                    aria-label={t(isSteer ? 'agentChat.queue.steerNow' : 'agentChat.queue.sendNow')}
                    className="min-h-6 shrink-0 gap-1 px-1.5 text-muted hover:text-foreground"
                    disabled={!entry.canSendNow}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
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
 * stops a turn the queue pauses instead of firing the next message by surprise, and says so with a Resume action.
 */
export function AgentChatQueueList({
    isTurnRunning,
    isPaused,
    onAction,
    onEdit,
    pending,
    queue,
    terminalId,
}: {
    isTurnRunning: boolean;
    isPaused: boolean;
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
    terminalId: string;
}) {
    const { t } = useTranslation();
    const entries = agentChatQueueEntries(queue, isTurnRunning, pending);
    if (entries.length === 0) return null;
    return (
        <section
            aria-label={t('agentChat.queue.label')}
            className="mb-2 rounded-md border border-border bg-surface p-1"
        >
            <h3 className="m-0 flex min-h-6 items-center gap-2 pr-0.5 pl-2 text-[11px] font-normal text-muted">
                {isPaused ? (
                    <>
                        <Pause aria-hidden="true" className="size-3 shrink-0 text-warning" />
                        <span className="min-w-0 flex-1 truncate">
                            {t('agentChat.queue.paused')}
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
                            <Play className="size-3" />
                            {t('agentChat.queue.resume')}
                        </Button>
                    </>
                ) : (
                    <span className="min-w-0 flex-1 truncate">
                        {t(
                            isTurnRunning
                                ? 'agentChat.queue.queuedAfterTurn'
                                : 'agentChat.queue.queued',
                        )}
                    </span>
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
