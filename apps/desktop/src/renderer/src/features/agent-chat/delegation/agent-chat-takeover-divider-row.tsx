import type { DelegationControlChange } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';

/**
 * The marker in a delegated child's timeline where the Session changed hands: where the user took it over from the
 * Session that delegated it, or where it went back to that Session, by the user or automatically after they left it
 * alone. A hairline with the words centered on it, like the day break's quiet weight but ruled so it reads as a
 * boundary between the delegated work and the user's own.
 */
export function AgentChatTakeoverDividerRow({
    change,
    parentTitle,
}: {
    change: DelegationControlChange;
    /**
     * The delegating Session a hand-back names.
     */
    parentTitle: string;
}) {
    const { t } = useTranslation();
    const label =
        change.kind === 'taken_over'
            ? t('delegation.divider.takenOver')
            : t(
                  change.trigger === 'auto'
                      ? 'delegation.divider.handedBackAuto'
                      : 'delegation.divider.handedBack',
                  { title: parentTitle },
              );
    return (
        <div
            className="flex items-center gap-2 text-[11px] leading-4 text-muted"
            data-agent-chat-takeover-divider=""
            role="separator"
        >
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
            <span className="max-w-[80%] truncate">{label}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
    );
}
