import { X } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';

/**
 * Dismisses one failed or interrupted row from the Background work list once the user has seen it. Its tooltip says
 * where the work still is, since the row leaves the strip.
 */
export function AgentChatStripDismissButton({
    detail,
    title,
    onDismiss,
}: {
    /**
     * Where the work still is after it leaves the list; defaults to the conversation, where a task's record stays.
     */
    detail?: string;
    title: string;
    onDismiss: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip content={detail ?? t('agentChat.tasks.dismissDetail')}>
            <Button
                aria-label={t('agentChat.tasks.dismissTask', { title })}
                className="size-6 shrink-0 text-muted hover:text-foreground"
                size="icon"
                variant="ghost"
                onClick={onDismiss}
            >
                <X aria-hidden="true" className="size-3.5" />
            </Button>
        </Tooltip>
    );
}
