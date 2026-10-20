import type { AgentChatItem } from '@caxri/protocol';
import { agentChatNoticeMessage } from '@caxri/protocol';
import { CircleAlert, SquareTerminal, TriangleAlert } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';

const FEEDBACK_TONES = {
    error: {
        Icon: CircleAlert,
        color: 'text-danger',
        card: 'border-danger/30 bg-danger/5',
        size: 'size-3.5',
    },
    warning: {
        Icon: TriangleAlert,
        color: 'text-warning',
        card: 'border-warning/30 bg-warning/5',
        size: 'size-4',
    },
    /**
     * Command and provider output, such as `/rename` confirming the new title: informative, not a problem, so it stays
     * neutral like the Terminal's own plain output.
     */
    output: {
        Icon: SquareTerminal,
        color: 'text-muted',
        card: 'border-border bg-surface',
        size: 'size-4',
    },
};

/**
 * Provider feedback has its own source and tone so it cannot be mistaken for a model reply.
 */
export function AgentChatFeedback({ item }: { item: Extract<AgentChatItem, { type: 'notice' }> }) {
    const { t } = useTranslation();
    const tone =
        item.kind === 'error'
            ? FEEDBACK_TONES.error
            : item.kind === 'warning'
              ? FEEDBACK_TONES.warning
              : FEEDBACK_TONES.output;
    const { Icon } = tone;
    return (
        <div
            className={cn(
                'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12px] leading-5',
                tone.color,
                tone.card,
            )}
        >
            <Icon className={cn('mt-0.5 shrink-0', tone.size)} />
            <div className="min-w-0 flex-1 select-text">
                {item.title && <div className="mb-1 font-medium">{item.title}</div>}
                <div className="wrap-anywhere whitespace-pre-wrap">
                    {agentChatNoticeMessage(item, t)}
                </div>
            </div>
        </div>
    );
}
