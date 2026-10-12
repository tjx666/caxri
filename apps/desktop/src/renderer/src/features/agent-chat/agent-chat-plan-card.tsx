import { useState } from 'react';

import type { AgentChatPlan } from '@caxri/protocol';
import { agentChatPlanProgress } from '@caxri/protocol';
import { Check, ChevronDown, Circle, CircleDot, ListTodo } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { agentChatChevronMotion } from './agent-chat-disclosure';
import { withOccurrenceKeys } from './agent-chat-presentation';

/**
 * Past this many steps the progress segments would shrink to slivers, so the row keeps only the count.
 */
const MAX_PROGRESS_SEGMENTS = 10;

type PlanStepStatus = AgentChatPlan['steps'][number]['status'];

function planStepGlyph(status: PlanStepStatus, isTurnRunning: boolean, t: Translate) {
    const label = t(`agentChat.plan.${status}`);
    switch (status) {
        case 'completed': {
            return <Check aria-label={label} className="size-3.5 text-success" role="img" />;
        }
        case 'inProgress': {
            return isTurnRunning ? (
                <Spinner aria-label={label} className="size-3.5 text-muted" />
            ) : (
                <CircleDot aria-label={label} className="size-3.5 text-muted" role="img" />
            );
        }
        case 'pending': {
            return <Circle aria-label={label} className="size-3.5 text-muted" role="img" />;
        }
    }
}

/**
 * The latest plan the Agent reported, docked above the composer. It stays one row by default (the step the Agent is on,
 * a segment per step, and the count) so a long plan never crowds the transcript, the way T3 Code's task badge and the
 * Codex app fold theirs; the row expands to the full list and keeps that choice while the plan updates. A step left in
 * progress after the turn ended (interrupted, failed, or simply never updated) is shown still, so nothing spins while
 * nothing is running.
 */
export function AgentChatPlanCard({
    plan,
    isTurnRunning,
}: {
    plan: AgentChatPlan;
    isTurnRunning: boolean;
}) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    const { completed, total, current } = agentChatPlanProgress(plan);
    const isDone = total > 0 && completed === total;
    const steps = withOccurrenceKeys(plan.steps, (step) => step.step);
    return (
        <section
            aria-label={t('agentChat.plan.label')}
            className="shrink-0 rounded-lg border border-border bg-surface text-[12px] leading-5"
        >
            <button
                aria-expanded={isExpanded}
                aria-label={
                    current
                        ? t('agentChat.plan.progressWithCurrent', { completed, total, current })
                        : t('agentChat.plan.progress', { completed, total })
                }
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-3 text-left text-muted hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => setExpanded((expanded) => !expanded)}
            >
                <ListTodo aria-hidden className="size-3.5 shrink-0" />
                <span className="shrink-0 font-semibold text-foreground">
                    {t('agentChat.plan.label')}
                </span>
                {!isExpanded && current && <span className="min-w-0 truncate">{current}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-2">
                    {total <= MAX_PROGRESS_SEGMENTS && (
                        <span aria-hidden className="flex items-center gap-0.5">
                            {steps.map(({ item: step, key }) => (
                                <span
                                    className={cn(
                                        'h-1 w-3 rounded-full',
                                        step.status === 'completed'
                                            ? 'bg-success'
                                            : step.status === 'inProgress'
                                              ? 'bg-muted'
                                              : 'bg-border',
                                    )}
                                    key={key}
                                />
                            ))}
                        </span>
                    )}
                    <span className={cn('tabular-nums', isDone && 'text-success')}>
                        {completed}/{total}
                    </span>
                    <ChevronDown
                        aria-hidden
                        className={cn(
                            'size-3.5',
                            agentChatChevronMotion(isExpanded),
                            isExpanded && 'rotate-180',
                        )}
                    />
                </span>
            </button>
            {isExpanded && (
                <div className="max-h-60 overflow-y-auto px-3 pb-2">
                    {plan.explanation && <p className="m-0 mb-1 text-muted">{plan.explanation}</p>}
                    <ol className="m-0 list-none space-y-0.5 p-0">
                        {steps.map(({ item: step, key }) => (
                            <li className="flex items-start gap-2" key={key}>
                                <span className="mt-0.5 shrink-0">
                                    {planStepGlyph(step.status, isTurnRunning, t)}
                                </span>
                                <span
                                    className={cn(
                                        'wrap-anywhere',
                                        step.status === 'completed'
                                            ? 'text-muted'
                                            : 'text-foreground',
                                    )}
                                >
                                    {step.step}
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </section>
    );
}
