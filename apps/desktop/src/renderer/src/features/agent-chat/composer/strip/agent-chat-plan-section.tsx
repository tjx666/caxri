import { ListTodo } from 'lucide-react';

import { useTranslation } from '../../../../i18n';
import { AgentChatPlanSteps } from '../../tools/agent-chat-plan-steps';
import { AgentChatStripSection } from './agent-chat-strip-section';
import type { AgentChatPlanSection as AgentChatPlanSectionView } from './agent-chat-strip-sections';
import { agentChatPlanProgressLabel } from './agent-chat-strip-sections';

/**
 * The Agent's latest plan as a collapsible list in the composer strip (`agentChatPlanSection`): the header counts the
 * steps done, and once folded also names the step the Agent is on, so a long plan can stay one row without hiding where
 * the turn is.
 */
export function AgentChatPlanSection({
    isTurnRunning,
    section,
    terminalId,
}: {
    isTurnRunning: boolean;
    section: AgentChatPlanSectionView;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const { plan, progress } = section;
    return (
        <AgentChatStripSection
            ariaLabel={agentChatPlanProgressLabel(progress, t)}
            glyph={<ListTodo aria-hidden="true" className="size-3.5 shrink-0" />}
            label={t('agentChat.plan.label')}
            meta={`${progress.completed}/${progress.total}`}
            section="plan"
            summary={progress.current}
            terminalId={terminalId}
        >
            <div className="max-h-48 overflow-y-auto px-2 text-[12px] leading-5">
                <AgentChatPlanSteps isTurnRunning={isTurnRunning} plan={plan} />
            </div>
        </AgentChatStripSection>
    );
}
