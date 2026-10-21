import type { AgentChatItem } from '@caxri/protocol';
import { agentChatNoticeMessage, agentChatRetryHeadline } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { Hourglass, RotateCw, ServerCrash, WifiOff } from 'lucide-react';

import { useTranslation } from '../../../i18n';

type RetryNotice = Extract<AgentChatItem, { type: 'notice' }>;

const RETRY_ICONS: Record<NonNullable<RetryNotice['retry']>['cause'], LucideIcon> = {
    connection: WifiOff,
    rateLimit: Hourglass,
    overloaded: ServerCrash,
    server: ServerCrash,
    other: RotateCw,
};

/**
 * A provider retrying a failed request: a `--warning` headline led by its cause's icon (a dropped connection shows
 * Wi-Fi off), with the attempt against the provider's limit, and the provider's own detail muted beneath it. A muted
 * line read as routine progress while the Agent was in fact stalled on a failing request.
 */
export function AgentChatRetryNotice({ item }: { item: RetryNotice }) {
    const { t } = useTranslation();
    const Icon = item.retry ? RETRY_ICONS[item.retry.cause] : RotateCw;
    const headline = item.retry
        ? agentChatRetryHeadline(item.retry, t)
        : agentChatNoticeMessage(item, t);
    const detail = item.retry ? item.message : undefined;
    return (
        <div className="flex items-start gap-2 text-[12px] leading-5" role="status">
            <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <div className="min-w-0 select-text">
                <div className="text-warning">{headline}</div>
                {detail && (
                    <div className="wrap-anywhere whitespace-pre-line text-muted">{detail}</div>
                )}
            </div>
        </div>
    );
}
