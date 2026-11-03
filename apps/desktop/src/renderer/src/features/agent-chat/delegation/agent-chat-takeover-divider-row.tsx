import { useTranslation } from '../../../i18n';

/**
 * The marker in a delegated child's timeline where the user took the Session over from the Session that delegated it: a
 * hairline with the words centered on it, like the day break's quiet weight but ruled so it reads as a boundary between
 * the delegated work and the user's own.
 */
export function AgentChatTakeoverDividerRow() {
    const { t } = useTranslation();
    return (
        <div
            className="flex items-center gap-2 text-[11px] leading-4 text-muted"
            data-agent-chat-takeover-divider=""
            role="separator"
        >
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
            <span>{t('delegation.divider.takenOver')}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
    );
}
