import type { AgentChatQueuedMessage } from '@caxri/protocol';
import { CornerDownLeft, CornerDownRight, Pause, Pencil, Play, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import {
    didRemoveAgentChatQueued,
    editAgentChatQueued,
    resumeAgentChatQueue,
    sendAgentChatQueuedNow,
} from './agent-chat-commands';
import type { AgentChatQueueEntryView } from './agent-chat-queue';
import { agentChatQueueEntries } from './agent-chat-queue';

const ACTION_CLASS_NAME = 'size-6 text-muted hover:text-foreground';

function QueueCard({
    entry,
    onEdit,
    terminalId,
}: {
    entry: AgentChatQueueEntryView;
    onEdit: (text: string) => void;
    terminalId: string;
}) {
    return (
        <li className="flex min-w-0 items-center gap-1 rounded py-0.5 pr-0.5 pl-2 text-[12px] leading-5 hover:bg-[var(--selection)]">
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
            <Tooltip content={entry.canEdit ? 'Edit' : 'Messages with images cannot be edited'}>
                <Button
                    aria-label="Edit queued message"
                    className={ACTION_CLASS_NAME}
                    disabled={!entry.canEdit}
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- the command reports its own failures through tryCommand
                        void editAgentChatQueued(terminalId, entry, onEdit);
                    }}
                >
                    <Pencil className="size-3.5" />
                </Button>
            </Tooltip>
            <Tooltip content="Delete">
                <Button
                    aria-label="Delete queued message"
                    className={ACTION_CLASS_NAME}
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- the command reports its own failures through tryCommand
                        void didRemoveAgentChatQueued(terminalId, entry.id);
                    }}
                >
                    <Trash2 className="size-3.5" />
                </Button>
            </Tooltip>
            <Tooltip
                content={
                    entry.canSendNow
                        ? entry.sendNowLabel === 'Steer'
                            ? 'Add to the running turn now'
                            : 'Send now'
                        : 'A command waits for the running turn to end'
                }
            >
                <Button
                    aria-label={entry.sendNowLabel === 'Steer' ? 'Steer now' : 'Send now'}
                    className="min-h-6 shrink-0 gap-1 px-1.5 text-muted hover:text-foreground"
                    disabled={!entry.canSendNow}
                    size="sm"
                    variant="ghost"
                    onClick={() => sendAgentChatQueuedNow(terminalId, entry.id)}
                >
                    <CornerDownLeft className="size-3.5" />
                    {entry.sendNowLabel}
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
    onEdit,
    queue,
    terminalId,
}: {
    isTurnRunning: boolean;
    isPaused: boolean;
    /**
     * Puts a queued message's text back into the composer once it left the queue.
     */
    onEdit: (text: string) => void;
    queue: readonly AgentChatQueuedMessage[] | undefined;
    terminalId: string;
}) {
    const entries = agentChatQueueEntries(queue, isTurnRunning);
    if (entries.length === 0) return null;
    return (
        <section
            aria-label="Queued messages"
            className="mb-2 rounded-md border border-border bg-surface p-1"
        >
            <h3 className="m-0 flex min-h-6 items-center gap-2 pr-0.5 pl-2 text-[11px] font-normal text-muted">
                {isPaused ? (
                    <>
                        <Pause aria-hidden="true" className="size-3 shrink-0 text-warning" />
                        <span className="min-w-0 flex-1 truncate">
                            Queue paused · sends nothing until you resume
                        </span>
                        <Button
                            className="min-h-5 shrink-0 gap-1 px-1.5 text-[11px]"
                            size="sm"
                            variant="secondary"
                            onClick={() => resumeAgentChatQueue(terminalId)}
                        >
                            <Play className="size-3" />
                            Resume
                        </Button>
                    </>
                ) : (
                    <span className="min-w-0 flex-1 truncate">
                        {isTurnRunning ? 'Queued · sends after this turn' : 'Queued'}
                    </span>
                )}
            </h3>
            <ol className="m-0 flex max-h-40 list-none flex-col overflow-y-auto p-0">
                {entries.map((entry) => (
                    <QueueCard
                        entry={entry}
                        key={entry.id}
                        terminalId={terminalId}
                        onEdit={onEdit}
                    />
                ))}
            </ol>
        </section>
    );
}
