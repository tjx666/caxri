import type { AgentHeldMessage } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { heldMessageDeadlineLabel } from './agent-message-approval-state';

interface AgentMessageApprovalSummaryProperties {
    message: AgentHeldMessage;
    /**
     * The deadline has passed, so it reads as when the request expired rather than when it will.
     */
    isExpired: boolean;
}

/**
 * Who sent a held peer message and until when it can be answered, as the approval dialog shows it above the body.
 */
export function AgentMessageApprovalSummary({
    message,
    isExpired,
}: AgentMessageApprovalSummaryProperties) {
    const { t } = useTranslation();
    const { hostId, endpointId, generation } = message.from.ref;
    const endpointReference = `${hostId}:${endpointId}:${generation}`;
    return (
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-muted">{t('agentInbox.summary.sender')}</dt>
            <dd className="m-0 truncate">{message.from.name}</dd>
            <dt className="text-muted">{t('agentInbox.summary.project')}</dt>
            <dd className="m-0 truncate">{message.from.projectId}</dd>
            <dt className="text-muted">{t('agentInbox.summary.provider')}</dt>
            <dd className="m-0">{message.from.provider}</dd>
            <dt className="text-muted">{t('agentInbox.summary.permission')}</dt>
            <dd className="m-0">{message.from.permissionClass}</dd>
            <dt className="text-muted">{t('agentInbox.summary.endpoint')}</dt>
            <dd className="m-0 truncate font-mono" title={endpointReference}>
                {endpointReference}
            </dd>
            <dt className="text-muted">
                {t(isExpired ? 'agentInbox.summary.expired' : 'agentInbox.summary.expires')}
            </dt>
            <dd className="m-0">
                <time dateTime={new Date(message.expiresAt).toISOString()}>
                    {heldMessageDeadlineLabel(message.expiresAt)}
                </time>
            </dd>
        </dl>
    );
}
