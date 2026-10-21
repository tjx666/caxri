import type { AgentChatPlan } from '@caxri/protocol';
import { Check, CircleDashed, CircleDot } from 'lucide-react';

import { Spinner } from '../../../components/ui/spinner';
import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { withOccurrenceKeys } from '../transcript/agent-chat-presentation';

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
            return <CircleDashed aria-label={label} className="size-3.5 text-muted" role="img" />;
        }
    }
}

/**
 * The Agent's latest plan as a step list, with the explanation the Agent gave above it. A step not started yet is a
 * dashed ring, an outline still to be filled. A step left in progress after the turn ended (interrupted, failed, or
 * simply never updated) is shown still, so nothing spins while nothing is running.
 */
export function AgentChatPlanSteps({
    isTurnRunning,
    plan,
}: {
    isTurnRunning: boolean;
    plan: AgentChatPlan;
}) {
    const { t } = useTranslation();
    return (
        <>
            {plan.explanation && <p className="m-0 mb-1 text-muted">{plan.explanation}</p>}
            <ol className="m-0 list-none space-y-0.5 p-0">
                {withOccurrenceKeys(plan.steps, (step) => step.step).map(({ item: step, key }) => (
                    <li className="flex items-start gap-2" key={key}>
                        <span className="mt-0.5 shrink-0">
                            {planStepGlyph(step.status, isTurnRunning, t)}
                        </span>
                        <span
                            className={cn(
                                'wrap-anywhere',
                                step.status === 'completed' ? 'text-muted' : 'text-foreground',
                            )}
                        >
                            {step.step}
                        </span>
                    </li>
                ))}
            </ol>
        </>
    );
}
