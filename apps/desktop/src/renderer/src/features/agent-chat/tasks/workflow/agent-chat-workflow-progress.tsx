import type { AgentChatWorkflow } from '@caxri/protocol';
import { agentChatWorkflowProgressLabel } from '@caxri/protocol';

import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';

/**
 * A workflow run's progress where it is listed (the strip entry, its timeline row): the running phase and its count
 * (`Review 2/3`), or the whole run's count once it ended, then failed and interrupted members in their tones, so a
 * failure never reads as a plain finish.
 */
export function AgentChatWorkflowProgress({
    className,
    isRunning,
    workflow,
}: {
    className?: string;
    isRunning: boolean;
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>;
}) {
    const { t } = useTranslation();
    const label = agentChatWorkflowProgressLabel(workflow, isRunning);
    if (!label) return null;
    return (
        <span className={cn('flex shrink-0 items-center gap-1.5 tabular-nums', className)}>
            <span className="max-w-32 truncate">
                {label.phase ? `${label.phase} ` : ''}
                {t('agentChat.workflow.progress', { done: label.done, total: label.total })}
            </span>
            {label.failed > 0 && (
                <span className="text-danger">
                    {t('agentChat.workflow.failed', { count: label.failed })}
                </span>
            )}
            {label.stopped > 0 && (
                <span className="text-warning">
                    {t('agentChat.workflow.stopped', { count: label.stopped })}
                </span>
            )}
        </span>
    );
}
