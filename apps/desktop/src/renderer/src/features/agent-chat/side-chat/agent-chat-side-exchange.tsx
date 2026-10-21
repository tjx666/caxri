import { RotateCcw } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentChatMessage } from '../messages/agent-chat-message';
import { AgentChatUserMessageBubble } from '../messages/agent-chat-user-message';
import type { SideChatExchange } from './agent-chat-side-thread';

/**
 * One question of a side chat and its answer: the question right-aligned like a user message, the answer as Markdown
 * beneath it, a spinner while the answer is pending, and the failure with Retry when it could not be answered. Both
 * sides share the main transcript's renderers, so a path in either one opens in the editor exactly as it does there.
 */
export function AgentChatSideExchange({
    canRetry,
    exchange,
    onOpenFile,
    onRetry,
}: {
    canRetry: boolean;
    exchange: SideChatExchange;
    onOpenFile: (target: string) => void;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    return (
        <li className="flex flex-col gap-2">
            <div className="flex flex-col items-end">
                <AgentChatUserMessageBubble
                    isEditing={false}
                    text={exchange.question}
                    onOpenFile={onOpenFile}
                />
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
                <AgentChatMessage
                    isStreaming={false}
                    text={exchange.response ?? ''}
                    onOpenFile={onOpenFile}
                />
            )}
            {exchange.status === 'failed' && (
                <div
                    className="flex items-center gap-2 text-[13px] leading-5 text-danger"
                    role="alert"
                >
                    <span className="min-w-0 flex-1 wrap-anywhere">{exchange.error}</span>
                    <Tooltip content={t('agentChat.sideChat.waitForAnswer')} disabled={canRetry}>
                        {/* aria-disabled, not disabled: a natively disabled button never opens its tooltip. */}
                        <Button
                            aria-disabled={!canRetry || undefined}
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                if (canRetry) onRetry();
                            }}
                        >
                            <RotateCcw aria-hidden="true" className="size-3" />
                            {t('agentChat.sideChat.retry')}
                        </Button>
                    </Tooltip>
                </div>
            )}
        </li>
    );
}
