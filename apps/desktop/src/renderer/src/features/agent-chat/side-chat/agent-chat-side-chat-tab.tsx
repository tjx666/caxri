import { useEffect, useRef, useState } from 'react';

import { agentProviderCatalog } from '@caxri/protocol';
import { ArrowUp, SquareArrowOutUpRight } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { useTerminal } from '../../../stores/selectors';
import {
    askAgentChatSideQuestion,
    convertAgentChatSideChatToSession,
    discardAgentChatSideChatIfClosed,
    isAgentChatSideChatBusy,
    retryAgentChatSideQuestion,
    useAgentChatSideChatStore,
} from './agent-chat-side-chat-commands';
import { isAgentChatSideSendKey } from './agent-chat-side-chat-composer-keys';
import { AgentChatSideExchange } from './agent-chat-side-exchange';
import type { SideChatExchange } from './agent-chat-side-thread';
import { agentChatSideHistory } from './agent-chat-side-thread';

const STATE_CLASS_NAME =
    'flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted';

const NO_EXCHANGES: readonly SideChatExchange[] = [];

/**
 * Title and "Convert to Session", which moves the answered Q&A into a new Chat in a new Session.
 */
function SideChatHeader({
    exchanges,
    terminalId,
}: {
    exchanges: readonly SideChatExchange[];
    terminalId: string;
}) {
    const { t } = useTranslation();
    const canConvert = agentChatSideHistory(exchanges).length > 0;
    return (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
            <h2 className="m-0 min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold text-foreground">
                {t('agentChat.sideChat.title')}
            </h2>
            <Tooltip content={t('agentChat.sideChat.convertTooltip')}>
                <Button
                    disabled={!canConvert}
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- convertAgentChatSideChatToSession reports its own failures through tryCommand
                        void convertAgentChatSideChatToSession(terminalId);
                    }}
                >
                    <SquareArrowOutUpRight aria-hidden="true" className="size-3" />
                    {t('agentChat.sideChat.convert')}
                </Button>
            </Tooltip>
        </header>
    );
}

/**
 * The side chat's own input. Enter asks, Shift+Enter breaks the line, and Ask is held while an earlier question is
 * still pending so each follow-up carries the answer before it.
 */
function SideChatComposer({ isBusy, terminalId }: { isBusy: boolean; terminalId: string }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const input = useRef<HTMLTextAreaElement>(null);
    useEffect(() => input.current?.focus(), []);
    const canSend = draft.trim().length > 0 && !isBusy;
    const send = (): void => {
        if (!canSend) return;
        // eslint-disable-next-line no-void -- the answer or its failure is recorded on the thread
        void askAgentChatSideQuestion(terminalId, draft);
        setDraft('');
    };
    return (
        <div className="relative mx-auto w-full max-w-3xl shrink-0 px-4 pt-1 pb-3">
            <Textarea
                aria-label={t('agentChat.sideChat.placeholder')}
                className="min-h-[72px] pr-11"
                placeholder={t('agentChat.sideChat.placeholder')}
                ref={input}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (
                        !isAgentChatSideSendKey({
                            ...event,
                            isComposing: event.nativeEvent.isComposing,
                        })
                    )
                        return;
                    event.preventDefault();
                    send();
                }}
            />
            <Button
                aria-label={t('agentChat.sideChat.send')}
                className="absolute right-6 bottom-5 size-6"
                disabled={!canSend}
                size="icon"
                variant="default"
                onClick={send}
            >
                <ArrowUp aria-hidden="true" className="size-3.5" />
            </Button>
        </div>
    );
}

/**
 * A Chat's side chat: quick questions answered from its context without joining its conversation, opened beside the
 * Chat as a tab. Everything lives in Renderer memory; closing the tab discards the thread.
 */
export function AgentChatSideChatTab({ tab }: { tab: { terminalId: string } }) {
    const { terminalId } = tab;
    const { t } = useTranslation();
    const terminal = useTerminal(terminalId);
    const exchanges = useAgentChatSideChatStore(
        (state) => state.threads[terminalId] ?? NO_EXCHANGES,
    );
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => () => discardAgentChatSideChatIfClosed(terminalId), [terminalId]);
    useEffect(() => {
        list.current?.scrollTo({ top: list.current.scrollHeight });
    }, [exchanges]);
    const provider = terminal && terminal.kind !== 'shell' ? terminal.kind : undefined;
    if (!provider)
        return <div className={STATE_CLASS_NAME}>{t('agentChat.sideChat.unavailable')}</div>;
    const catalog = agentProviderCatalog[provider];
    if (!catalog.capabilities.chatSideQuestion)
        return (
            <div className={STATE_CLASS_NAME}>
                {t('agentChat.sideChat.unsupported', { agent: catalog.displayName })}
            </div>
        );
    const isBusy = isAgentChatSideChatBusy(exchanges);
    return (
        <div className="flex h-full min-h-0 flex-col">
            <SideChatHeader exchanges={exchanges} terminalId={terminalId} />
            <div className="min-h-0 flex-1 overflow-y-auto" ref={list}>
                {exchanges.length === 0 ? (
                    <p className="m-0 mx-auto max-w-md px-6 py-10 text-center text-[13px] leading-5 text-muted">
                        {t('agentChat.sideChat.hint')}
                    </p>
                ) : (
                    <ul className="m-0 mx-auto flex w-full max-w-3xl list-none flex-col gap-5 p-4">
                        {exchanges.map((exchange) => (
                            <AgentChatSideExchange
                                canRetry={!isBusy}
                                exchange={exchange}
                                key={exchange.id}
                                onRetry={() => {
                                    // eslint-disable-next-line no-void -- the outcome is recorded on the exchange
                                    void retryAgentChatSideQuestion(terminalId, exchange.id);
                                }}
                            />
                        ))}
                    </ul>
                )}
            </div>
            <SideChatComposer isBusy={isBusy} terminalId={terminalId} />
        </div>
    );
}
