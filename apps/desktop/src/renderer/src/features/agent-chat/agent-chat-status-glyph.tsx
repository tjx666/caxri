import type { AgentChatItemStatus, AgentChatPlan } from '@caxri/protocol';
import { Check, Circle, CircleSlash, CircleX } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import type { AgentChatStatusTone } from './agent-chat-presentation';
import {
    agentChatItemStatusLabel,
    agentChatItemStatusTone,
    withOccurrenceKeys,
} from './agent-chat-presentation';

const toneClassName: Record<AgentChatStatusTone, string> = {
    danger: 'text-danger',
    muted: 'text-muted',
    running: 'text-muted',
    success: 'text-success',
    warning: 'text-warning',
};

/**
 * Status glyph for an activity row. The accessible name carries the state, so the glyph never stands alone.
 */
export function AgentChatStatusGlyph({ status }: { status: AgentChatItemStatus }) {
    const label = agentChatItemStatusLabel(status);
    const className = cn('size-3.5 shrink-0', toneClassName[agentChatItemStatusTone(status)]);
    switch (status) {
        case 'running': {
            return <Spinner aria-label={label} className={className} />;
        }
        case 'completed': {
            return <Check aria-label={label} className={className} role="img" />;
        }
        case 'failed': {
            return <CircleX aria-label={label} className={className} role="img" />;
        }
        case 'declined': {
            return <CircleSlash aria-label={label} className={className} role="img" />;
        }
        case 'interrupted': {
            return <Circle aria-label={label} className={className} role="img" />;
        }
    }
}

type PlanStepStatus = AgentChatPlan['steps'][number]['status'];

function planStepGlyph(status: PlanStepStatus) {
    switch (status) {
        case 'completed': {
            return <Check aria-label="Completed" className="size-3.5 text-success" role="img" />;
        }
        case 'inProgress': {
            return <Spinner aria-label="In progress" className="size-3.5 text-muted" />;
        }
        case 'pending': {
            return <Circle aria-label="Pending" className="size-3.5 text-muted" role="img" />;
        }
    }
}

export function AgentChatPlanCard({ plan }: { plan: AgentChatPlan }) {
    return (
        <section
            aria-label="Plan"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-5"
        >
            <h3 className="m-0 mb-1 text-[12px] font-semibold text-foreground">Plan</h3>
            {plan.explanation && <p className="m-0 mb-1 text-muted">{plan.explanation}</p>}
            <ol className="m-0 list-none space-y-0.5 p-0">
                {withOccurrenceKeys(plan.steps, (step) => step.step).map(({ item: step, key }) => (
                    <li className="flex items-start gap-2" key={key}>
                        <span className="mt-0.5 shrink-0">{planStepGlyph(step.status)}</span>
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
        </section>
    );
}
