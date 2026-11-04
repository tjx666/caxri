import { RotateCcw } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { useTranslation } from '../../../../i18n';

/**
 * What a task tab or a workflow member view shows when its transcript could not be read: the failure and a Retry that
 * reads it again, so a transient error never leaves the user closing and reopening the tab.
 */
export function AgentChatTaskLoadFailed({ onRetry }: { onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted"
            role="alert"
        >
            <p className="m-0 text-foreground">{t('agentChat.tasks.loadFailed')}</p>
            <Button size="sm" variant="secondary" onClick={onRetry}>
                <RotateCcw className="size-3.5" />
                {t('common.retry')}
            </Button>
        </div>
    );
}
