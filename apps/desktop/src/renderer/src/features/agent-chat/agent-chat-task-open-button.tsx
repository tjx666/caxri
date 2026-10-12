import type { AgentChatTask } from '@caxri/protocol';
import { PanelRight } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';

/**
 * Opens a work row's subagent or background shell in the side split.
 */
export function AgentChatTaskOpenButton({
    onOpen,
    task,
}: {
    onOpen: () => void;
    task: AgentChatTask | undefined;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip
            content={
                task
                    ? t('agentChat.timeline.openNamed', {
                          name: task.title || t('agentChat.workGroup.task'),
                      })
                    : t('agentChat.workGroup.openSubagent')
            }
        >
            <Button
                aria-label={t(
                    task?.kind === 'shell'
                        ? 'agentChat.workGroup.openShell'
                        : 'agentChat.workGroup.openSubagent',
                )}
                className="min-h-6 shrink-0 gap-1 px-1.5 text-muted"
                size="sm"
                variant="ghost"
                onClick={onOpen}
            >
                <PanelRight aria-hidden="true" className="size-3.5" />
                {t('common.open')}
            </Button>
        </Tooltip>
    );
}
