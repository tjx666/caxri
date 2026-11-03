import { Square } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Spinner } from '../../../../components/ui/spinner';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import {
    agentChatTaskKey,
    stopAgentChatTask,
    useAgentChatTaskStopStore,
} from '../../agent-chat-commands';

/**
 * A task tab header's Stop, busy from the click until the task leaves `running`, like the composer strip's.
 */
export function AgentChatTaskHeaderStopButton({
    label: stopLabel,
    taskId,
    terminalId,
    tooltip,
}: {
    /**
     * What the button says instead of `Stop`, such as `Stop workflow`.
     */
    label?: string;
    taskId: string;
    terminalId: string;
    /**
     * What stopping does, shown on hover in place of the label.
     */
    tooltip?: string;
}) {
    const { t } = useTranslation();
    const isStopping = useAgentChatTaskStopStore(({ stopping }) =>
        stopping.has(agentChatTaskKey(terminalId, taskId)),
    );
    const label = isStopping
        ? t('agentChat.tasks.stopping')
        : (stopLabel ?? t('agentChat.tasks.stop'));
    return (
        <Tooltip content={isStopping ? label : (tooltip ?? label)}>
            <Button
                aria-busy={isStopping || undefined}
                aria-disabled={isStopping || undefined}
                className="min-h-6 gap-1 px-1.5 aria-busy:cursor-progress aria-busy:opacity-100"
                size="sm"
                variant="secondary"
                onClick={() => {
                    if (!isStopping) stopAgentChatTask(terminalId, taskId);
                }}
            >
                {isStopping ? (
                    <Spinner className="size-3.5" role="presentation" />
                ) : (
                    <Square aria-hidden="true" className="size-2.5 fill-current" />
                )}
                {label}
            </Button>
        </Tooltip>
    );
}
