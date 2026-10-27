import { useId, useState } from 'react';

import { History, X } from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatTaskEntry } from '../../tasks/agent-chat-task-entry';
import { AgentChatTaskGlyph } from '../../tasks/agent-chat-task-glyph';
import { markAgentChatFailuresSeen } from './agent-chat-seen-failures';
import {
    toggleAgentChatStripFold,
    useIsAgentChatStripSectionCollapsed,
} from './agent-chat-strip-folds';
import { AgentChatStripSection } from './agent-chat-strip-section';
import type { AgentChatBackgroundWork, AgentChatRunningKind } from './agent-chat-strip-sections';
import { agentChatBackgroundWorkCounts } from './agent-chat-strip-sections';

/**
 * One glyph per running task kind (subagents, then background shells), each with its count when several kinds run, so a
 * shell running beside a subagent is never hidden behind the first task's glyph.
 */
function RunningKindGlyphs({ kinds }: { kinds: readonly AgentChatRunningKind[] }) {
    if (kinds.length === 0) return <AgentChatTaskGlyph kind="agent" />;
    return (
        <span className="inline-flex shrink-0 items-center gap-1.5">
            {kinds.map(({ kind, count }) => (
                <span className="inline-flex items-center gap-0.5" data-task-kind={kind} key={kind}>
                    <AgentChatTaskGlyph kind={kind} />
                    {kinds.length > 1 && count}
                </span>
            ))}
        </span>
    );
}

/**
 * The header's `N ended` disclosure: a history glyph with the count, so ended work costs no row of its own until the
 * user asks for it. Opening it also unfolds a collapsed section, since the list it reveals lives in the section body.
 */
function EndedTasksToggle({
    count,
    isShowing,
    listId,
    terminalId,
    onToggle,
}: {
    count: number;
    isShowing: boolean;
    listId: string;
    terminalId: string;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    const isCollapsed = useIsAgentChatStripSectionCollapsed(terminalId, 'tasks');
    const label = t('agentChat.tasks.endedCount', { count });
    return (
        <Tooltip content={label}>
            <Button
                aria-controls={listId}
                aria-expanded={isShowing && !isCollapsed}
                aria-label={label}
                className={cn(
                    'h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted tabular-nums hover:text-foreground',
                    isShowing && !isCollapsed && 'text-foreground',
                )}
                size="sm"
                variant="ghost"
                onClick={() => {
                    if (isCollapsed) {
                        toggleAgentChatStripFold(terminalId, 'tasks');
                        if (!isShowing) onToggle();
                        return;
                    }
                    onToggle();
                }}
            >
                <History aria-hidden="true" className="size-3.5" />
                {count}
            </Button>
        </Tooltip>
    );
}

/**
 * Background work as a collapsible list in the composer strip (`agentChatBackgroundWork`): failures from the latest
 * turn first so one is never buried, then each running subagent and background shell with its elapsed time, opened in
 * its side tab on click where the host can open one and stoppable on its own. Ended work is counted by a header control
 * that reveals it. Failures stay until the user dismisses them, which files them under the ended tasks; the section
 * leaves once nothing runs and no failure waits.
 */
export function AgentChatBackgroundWorkSection({
    terminalId,
    work,
    onOpenTask,
}: {
    terminalId: string;
    work: AgentChatBackgroundWork;
    /**
     * Opens a task's tab beside the Chat; absent where the host cannot, which leaves each task a plain row.
     */
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const { running, failed, ended } = work;
    const counts = agentChatBackgroundWorkCounts(work, t);
    const [isShowingEnded, setShowingEnded] = useState(false);
    const endedListId = useId();
    return (
        <AgentChatStripSection
            actions={
                <>
                    {ended.length > 0 && (
                        <EndedTasksToggle
                            count={ended.length}
                            isShowing={isShowingEnded}
                            listId={endedListId}
                            terminalId={terminalId}
                            onToggle={() => setShowingEnded((value) => !value)}
                        />
                    )}
                    {failed.length > 0 && (
                        <Tooltip content={t('agentChat.tasks.dismissFailures')}>
                            <Button
                                aria-label={t('agentChat.tasks.dismissFailures')}
                                className="size-6 shrink-0 text-muted hover:text-foreground"
                                size="icon"
                                variant="ghost"
                                onClick={() =>
                                    markAgentChatFailuresSeen(
                                        terminalId,
                                        failed.map(({ id }) => id),
                                    )
                                }
                            >
                                <X aria-hidden="true" className="size-3.5" />
                            </Button>
                        </Tooltip>
                    )}
                </>
            }
            glyph={<RunningKindGlyphs kinds={work.runningKinds} />}
            label={t('agentChat.tasks.backgroundWork')}
            meta={
                <>
                    {running.length > 0 && counts[0]}
                    {failed.length > 0 && (
                        <span className="text-danger">
                            {running.length > 0 && ' · '}
                            {counts.at(-1)}
                        </span>
                    )}
                </>
            }
            section="tasks"
            terminalId={terminalId}
        >
            <ul className="m-0 flex max-h-48 list-none flex-col overflow-y-auto p-0">
                {[...failed, ...running].map((task) => (
                    <AgentChatTaskEntry
                        key={task.id}
                        task={task}
                        terminalId={terminalId}
                        onOpenTask={onOpenTask}
                    />
                ))}
            </ul>
            {ended.length > 0 && (
                <DisclosureMotion
                    animate
                    expanded={isShowingEnded}
                    id={endedListId}
                    kind="agent-chat-ended-tasks"
                >
                    <ul
                        aria-label={t('agentChat.tasks.endedList')}
                        className="m-0 mt-1 flex max-h-32 list-none flex-col overflow-y-auto border-0 border-t border-solid border-border p-0 pt-1"
                    >
                        {ended.map((task) => (
                            <AgentChatTaskEntry
                                key={task.id}
                                task={task}
                                terminalId={terminalId}
                                onOpenTask={onOpenTask}
                            />
                        ))}
                    </ul>
                </DisclosureMotion>
            )}
        </AgentChatStripSection>
    );
}
