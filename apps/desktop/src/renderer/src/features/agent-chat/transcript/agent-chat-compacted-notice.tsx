import type { AgentChatItem } from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';
import { ArrowRight, FoldVertical } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { formatCount } from '../../../lib/locale-format';

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
                (
                    {
                        auto: 'agentChat.message.contextCompactedAuto',
                        idle: 'agentChat.message.contextCompactedIdle',
                        manual: 'agentChat.message.contextCompactedManual',
                    } as const
                )[trigger],
            ),
        hasSizes &&
            beforeTokens > 0 &&
            t('agentChat.message.contextCompactedDetail', {
                before: formatCount(beforeTokens),
                after: formatCount(afterTokens),
                percent: `${Math.round((1 - afterTokens / beforeTokens) * 100)}%`,
            }),
    ].filter(Boolean);
    // The detail lives in a tooltip, so a keyboard or screen-reader user reaches it through focus and a label that
    // reads the before and after sizes as words instead of "248k 32k".
    const isFocusable = detail.length > 0;
    const row = (
        <div
            aria-label={
                hasSizes
                    ? t('agentChat.message.contextCompactedLabel', {
                          before: formatTokens(beforeTokens),
                          after: formatTokens(afterTokens),
                      })
                    : t('agentChat.message.contextCompacted')
            }
            className="flex items-center gap-3 rounded-sm py-1 text-[12px] leading-5 text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            data-agent-chat-compacted=""
            role="note"
            tabIndex={isFocusable ? 0 : undefined}
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
