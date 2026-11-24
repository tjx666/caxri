import { History, Square } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Spinner } from '../../../../components/ui/spinner';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import {
    agentChatTaskKey,
    stopAgentChatTasks,
    useAgentChatTaskStopStore,
} from '../../agent-chat-commands';

/**
 * Hidden until the pointer or focus is on the header (its `group`), so the header reads as status rather than a
 * toolbar; a hidden action keeps its place and stays in the tab order, so nothing after it shifts when it appears.
 */
const HOVER_ACTION_CLASS_NAME =
    'h-6 shrink-0 px-1.5 text-[11px] text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground';

/**
 * Stops every running background task that can be stopped. No confirmation, the same as each task's Stop. While every
 * stop is pending it spins, stays visible, and refuses clicks; `aria-disabled` rather than `disabled` keeps a keyboard
 * user's focus on it.
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
            className={cn(
                HOVER_ACTION_CLASS_NAME,
                'gap-1 aria-busy:cursor-progress aria-busy:opacity-100',
            )}
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
 * `N interrupted earlier`: the header's count of delegations interrupted before this window opened, which also shows or
 * hides their rows. Always visible and last before the fold chevron, so it holds the header's right edge.
 */
function EarlierInterruptionsToggle({
    count,
    isOpen,
    listId,
    onToggle,
}: {
    count: number;
    isOpen: boolean;
    listId: string;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip
            content={t(
                isOpen
                    ? 'agentChat.tasks.hideInterruptedEarlier'
                    : 'agentChat.tasks.showInterruptedEarlier',
            )}
        >
            <button
                aria-controls={listId}
                aria-expanded={isOpen}
                className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-1.5 text-[12px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                data-agent-chat-background-earlier=""
                type="button"
                onClick={onToggle}
            >
                <History aria-hidden="true" className="size-3.5 shrink-0" />
                {t('agentChat.tasks.interruptedEarlier', { count })}
            </button>
        </Tooltip>
    );
}

/**
 * What the Background work header carries after its toggle, in this order so the always-visible count holds the right
 * edge: Clear (dismisses every earlier interruption, as each row's own dismiss would) and Stop all (two or more running
 * tasks can be stopped), both shown on hover or focus, then the `N interrupted earlier` toggle.
 */
export function AgentChatBackgroundHeaderActions({
    earlierCount,
    isEarlierShown,
    listId,
    stoppableTaskIds,
    terminalId,
    onClearEarlier,
    onToggleEarlier,
}: {
    earlierCount: number;
    isEarlierShown: boolean;
    listId: string;
    stoppableTaskIds: readonly string[];
    terminalId: string;
    onClearEarlier: () => void;
    onToggleEarlier: () => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            {earlierCount > 0 && (
                <Button
                    aria-label={t('agentChat.tasks.clearInterruptedEarlier')}
                    className={HOVER_ACTION_CLASS_NAME}
                    size="sm"
                    variant="ghost"
                    onClick={onClearEarlier}
                >
                    {t('agentChat.tasks.clear')}
                </Button>
            )}
            {stoppableTaskIds.length >= 2 && (
                <StopAllTasksButton taskIds={stoppableTaskIds} terminalId={terminalId} />
            )}
            {earlierCount > 0 && (
                <EarlierInterruptionsToggle
                    count={earlierCount}
                    isOpen={isEarlierShown}
                    listId={listId}
                    onToggle={onToggleEarlier}
                />
            )}
        </>
    );
}
