import { ChevronDown, ChevronUp, Square } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Spinner } from '../../../../components/ui/spinner';
import { useTranslation } from '../../../../i18n';
import {
    agentChatTaskKey,
    stopAgentChatTasks,
    useAgentChatTaskStopStore,
} from '../../agent-chat-commands';

/**
 * Stops every running background task that can be stopped. No confirmation, the same as each task's Stop. While every
 * stop is pending it spins and refuses clicks; `aria-disabled` rather than `disabled` keeps a keyboard user's focus on
 * it. Hidden until the pointer or focus is in the list (`group/background`), so the folded list reads as status, not as
 * a toolbar; it stays in the tab order while hidden.
 */
function StopAllTasksButton({
    taskIds,
    terminalId,
}: {
    taskIds: readonly string[];
    terminalId: string;
}) {
    const { t } = useTranslation();
    const isStopping = useAgentChatTaskStopStore(({ stopping }) =>
        taskIds.every((taskId) => stopping.has(agentChatTaskKey(terminalId, taskId))),
    );
    return (
        <Button
            aria-busy={isStopping || undefined}
            aria-disabled={isStopping || undefined}
            className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted opacity-0 group-focus-within/background:opacity-100 group-hover/background:opacity-100 hover:text-foreground aria-busy:cursor-progress aria-busy:opacity-100"
            size="sm"
            variant="ghost"
            onClick={() => {
                if (!isStopping) stopAgentChatTasks(terminalId, taskIds);
            }}
        >
            {isStopping ? (
                <Spinner className="size-3" role="presentation" />
            ) : (
                <Square aria-hidden="true" className="size-2 fill-current" />
            )}
            {t('agentChat.tasks.stopAll')}
        </Button>
    );
}

/**
 * The quiet last line of a Background work list longer than its folded rows: `N more` folded, `Show less` unfolded,
 * muted text in the rows' grid (its glyph sits where a row's kind icon does) rather than a header, so the list never
 * reads as a titled section. Carries Stop all when two or more running tasks can be stopped.
 */
export function AgentChatBackgroundMoreRow({
    hiddenCount,
    isExpanded,
    listId,
    stoppableTaskIds,
    terminalId,
    onToggle,
}: {
    hiddenCount: number;
    isExpanded: boolean;
    listId: string;
    stoppableTaskIds: readonly string[];
    terminalId: string;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    const Glyph = isExpanded ? ChevronUp : ChevronDown;
    return (
        <div className="flex h-7 min-w-0 items-center gap-1 text-[12px] leading-5">
            <button
                aria-controls={listId}
                aria-expanded={isExpanded}
                data-agent-chat-background-more=""
                className="flex h-full min-w-0 cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-muted hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={onToggle}
            >
                <Glyph aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">
                    {isExpanded
                        ? t('agentChat.tasks.showLess')
                        : t('agentChat.tasks.moreCount', { count: hiddenCount })}
                </span>
            </button>
            {stoppableTaskIds.length >= 2 && (
                <StopAllTasksButton taskIds={stoppableTaskIds} terminalId={terminalId} />
            )}
        </div>
    );
}
