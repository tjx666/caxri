import { History } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { useTranslation } from '../../../i18n';

/**
 * Closes the transcript while an earlier version is on screen, right above the composer: that version is read-only, and
 * a message sent now goes to the current version, which "Show current version" brings back.
 */
export function AgentChatEarlierVersionNotice({ onShowCurrent }: { onShowCurrent: () => void }) {
    const { t } = useTranslation();
    return (
        <div
            className="flex items-center gap-2 rounded-lg border border-solid border-border px-3 py-2 text-[12px] text-muted"
            data-agent-chat-earlier-version=""
            role="status"
        >
            <History aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{t('agentChat.version.earlierNotice')}</span>
            <Button className="shrink-0" size="sm" variant="secondary" onClick={onShowCurrent}>
                {t('agentChat.version.showCurrent')}
            </Button>
        </div>
    );
}
