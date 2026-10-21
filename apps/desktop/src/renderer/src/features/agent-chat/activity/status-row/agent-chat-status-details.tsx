import type { ReactNode } from 'react';
import { useId, useLayoutEffect, useRef, useState } from 'react';

import { ChevronRight, ListTodo } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatTaskEntry } from '../../tasks/agent-chat-task-entry';
import { AgentChatTaskGlyph } from '../../tasks/agent-chat-task-glyph';
import { AgentChatPlanSteps } from '../../tools/agent-chat-plan-steps';
import { agentChatChevronMotion } from '../../transcript/agent-chat-disclosure';
import { STATUS_ROW_SPRING, STATUS_ROW_SWAP } from './agent-chat-status-row-motion';
import type {
    AgentChatStatusRowSection,
    AgentChatStatusRowView,
} from './agent-chat-status-row-view';

/**
 * Springs its own height to whatever its content measures, so the popover resizes smoothly when it swaps sections or
 * reveals the ended tasks instead of jumping.
 */
function AnimatedHeight({ children }: { children: ReactNode }) {
    const innerReference = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState<number | 'auto'>('auto');
    useLayoutEffect(() => {
        const element = innerReference.current;
        if (!element) return;
        const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return (
        <m.div
            animate={{ height }}
            className="relative overflow-hidden"
            initial={false}
            transition={STATUS_ROW_SPRING}
        >
            <div ref={innerReference}>{children}</div>
        </m.div>
    );
}

/**
 * The popover's background work: failed tasks first so a failure is never buried, then the running ones, each opened in
 * its side tab on click where the host can open one and stoppable on its own. Completed and stopped tasks are counted,
 * and the count reveals them most recent first.
 */
function TaskSection({
    isTurnRunning,
    terminalId,
    view,
    onOpenTask,
}: {
    isTurnRunning: boolean;
    terminalId: string;
    view: AgentChatStatusRowView;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const [isShowingEnded, setShowingEnded] = useState(false);
    const endedListId = useId();
    const { running, failed, ended } = view;
    const live = [...failed, ...running];
    const meta = [
        running.length > 0 && t('agentChat.tasks.runningCount', { count: running.length }),
        failed.length > 0 && t('agentChat.tasks.failedCount', { count: failed.length }),
    ]
        .filter(Boolean)
        .join(' · ');
    return (
        <section aria-label={t('agentChat.tasks.backgroundWork')} className="px-1 py-2">
            <h4 className="m-0 mb-1 flex items-center gap-2 px-2 text-[11px] font-normal text-muted">
                <AgentChatTaskGlyph kind={running[0]?.kind ?? 'agent'} />
                <span className="min-w-0 flex-1 truncate">
                    {t('agentChat.tasks.backgroundWork')}
                </span>
                {meta && <span className="shrink-0 tabular-nums">{meta}</span>}
            </h4>
            {live.length > 0 && (
                <ul className="m-0 flex max-h-48 list-none flex-col overflow-y-auto p-0">
                    {live.map((task) => (
                        <AgentChatTaskEntry
                            key={task.id}
                            task={task}
                            terminalId={terminalId}
                            onOpenTask={onOpenTask}
                        />
                    ))}
                </ul>
            )}
            {isTurnRunning && running.length > 0 && (
                <p className="m-0 mt-1 px-2 text-[11px] text-muted">
                    {t('agentChat.tasks.stopTurnKeepsTasks')}
                </p>
            )}
            {ended.length > 0 && (
                <>
                    <button
                        aria-controls={endedListId}
                        aria-expanded={isShowingEnded}
                        className="mx-2 mt-1 inline-flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 text-[11px] text-muted tabular-nums hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                        type="button"
                        onClick={() => setShowingEnded((value) => !value)}
                    >
                        {t('agentChat.tasks.endedCount', { count: ended.length })}
                        <ChevronRight
                            aria-hidden="true"
                            className={cn(
                                'size-3 shrink-0',
                                agentChatChevronMotion(isShowingEnded),
                                isShowingEnded && 'rotate-90',
                            )}
                        />
                    </button>
                    <DisclosureMotion
                        animate
                        expanded={isShowingEnded}
                        id={endedListId}
                        kind="agent-chat-ended-tasks"
                    >
                        <ul
                            aria-label={t('agentChat.tasks.endedList')}
                            className="m-0 mt-1 flex max-h-32 list-none flex-col overflow-y-auto p-0"
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
                </>
            )}
        </section>
    );
}

/**
 * The status row's popover body: exactly what was clicked, the plan from the plan badge, background work from the task
 * badge or the task lead. Switching sections while it is open swaps the content in place and springs the height.
 */
export function AgentChatStatusDetails({
    isTurnRunning,
    section,
    terminalId,
    view,
    onOpenTask,
}: {
    isTurnRunning: boolean;
    section: AgentChatStatusRowSection;
    terminalId: string;
    view: AgentChatStatusRowView;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const { plan } = view;
    return (
        <AnimatedHeight>
            <AnimatePresence initial={false} mode="popLayout">
                <m.div
                    animate={STATUS_ROW_SWAP.shown}
                    className="max-h-[min(440px,60vh)] overflow-y-auto"
                    exit={STATUS_ROW_SWAP.exit}
                    initial={STATUS_ROW_SWAP.enter}
                    key={section}
                    transition={STATUS_ROW_SWAP.transition}
                >
                    {section === 'plan' && plan && (
                        <section
                            aria-label={t('agentChat.plan.label')}
                            className="px-3 py-2 leading-5"
                        >
                            <h4 className="m-0 mb-1 flex items-center gap-2 text-[11px] font-normal text-muted">
                                <ListTodo aria-hidden="true" className="size-3.5 shrink-0" />
                                <span className="min-w-0 flex-1 truncate">
                                    {t('agentChat.plan.label')}
                                </span>
                                <span className="shrink-0 tabular-nums">
                                    {plan.progress.completed}/{plan.progress.total}
                                </span>
                            </h4>
                            <AgentChatPlanSteps isTurnRunning={isTurnRunning} plan={plan.plan} />
                        </section>
                    )}
                    {section === 'tasks' && (
                        <TaskSection
                            isTurnRunning={isTurnRunning}
                            terminalId={terminalId}
                            view={view}
                            onOpenTask={onOpenTask}
                        />
                    )}
                </m.div>
            </AnimatePresence>
        </AnimatedHeight>
    );
}
