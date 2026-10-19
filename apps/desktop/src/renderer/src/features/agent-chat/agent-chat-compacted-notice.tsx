import type { AgentChatItem } from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';
import { ArrowRight, FoldVertical } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';

const NUMBER_FORMAT = new Intl.NumberFormat();

/**
 * A compaction is a boundary in the conversation: everything above it now reaches the model only as a summary. It reads
 * as a quiet divider rather than a message, so it never outweighs the reply that follows, and names how far the context
 * shrank (`248k → 32k`) when the provider reports it. The tooltip gives the exact counts and who started it.
 */
export function AgentChatCompactedNotice({
    item,
}: {
    item: Extract<AgentChatItem, { type: 'notice' }>;
}) {
    const { t } = useTranslation();
    const { afterTokens, beforeTokens, trigger } = item.compaction ?? {};
    const hasSizes = beforeTokens !== undefined && afterTokens !== undefined;
    const detail = [
        trigger &&
            t(
                trigger === 'auto'
                    ? 'agentChat.message.contextCompactedAuto'
                    : 'agentChat.message.contextCompactedManual',
            ),
        hasSizes &&
            beforeTokens > 0 &&
            t('agentChat.message.contextCompactedDetail', {
                before: NUMBER_FORMAT.format(beforeTokens),
                after: NUMBER_FORMAT.format(afterTokens),
                percent: `${Math.round((1 - afterTokens / beforeTokens) * 100)}%`,
            }),
    ].filter(Boolean);
    const row = (
        <div
            className="flex items-center gap-3 py-1 text-[12px] leading-5 text-muted"
            data-agent-chat-compacted=""
        >
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
            <span className="flex shrink-0 items-center gap-1.5">
                <FoldVertical aria-hidden="true" className="size-3.5" />
                <span>{t('agentChat.message.contextCompacted')}</span>
                {hasSizes && (
                    <span className="flex items-center gap-1 tabular-nums">
                        <span aria-hidden="true">·</span>
                        <span>{formatTokens(beforeTokens)}</span>
                        <ArrowRight aria-hidden="true" className="size-3" />
                        <span className="text-foreground">{formatTokens(afterTokens)}</span>
                    </span>
                )}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
    );
    return detail.length > 0 ? (
        <Tooltip
            content={<span className="whitespace-pre-line">{detail.join('\n')}</span>}
            side="top"
        >
            {row}
        </Tooltip>
    ) : (
        row
    );
}
