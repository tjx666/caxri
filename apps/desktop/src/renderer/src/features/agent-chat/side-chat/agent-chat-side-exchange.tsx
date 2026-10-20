import { RotateCcw } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { useTranslation } from '../../../i18n';
import { AgentChatMessage } from '../messages/agent-chat-message';
import type { SideChatExchange } from './agent-chat-side-thread';

/**
 * One question of a side chat and its answer: the question right-aligned like a user message, the answer as Markdown
 * beneath it, a spinner while the answer is pending, and the failure with Retry when it could not be answered.
 */
export function AgentChatSideExchange({
    canRetry,
    exchange,
    onRetry,
}: {
    canRetry: boolean;
    exchange: SideChatExchange;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    return (
        <li className="flex flex-col gap-2">
            <div className="max-w-[85%] self-end rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground select-text">
                {exchange.question}
            </div>
            {exchange.status === 'pending' && (
                <div
                    className="flex items-center gap-2 text-[12px] text-muted"
                    role="status"
                    aria-label={t('agentChat.sideChat.pending')}
                >
                    <Spinner className="size-3.5" role="presentation" />
                    {t('agentChat.sideChat.pending')}
                </div>
            )}
            {exchange.status === 'answered' && (
                <AgentChatMessage isStreaming={false} text={exchange.response ?? ''} />
            )}
            {exchange.status === 'failed' && (
                <div
                    className="flex items-center gap-2 text-[13px] leading-5 text-danger"
                    role="alert"
                >
                    <span className="min-w-0 flex-1 wrap-anywhere">{exchange.error}</span>
                    <Button disabled={!canRetry} size="sm" variant="secondary" onClick={onRetry}>
                        <RotateCcw aria-hidden="true" className="size-3" />
                        {t('agentChat.sideChat.retry')}
                    </Button>
                </div>
            )}
        </li>
    );
}
