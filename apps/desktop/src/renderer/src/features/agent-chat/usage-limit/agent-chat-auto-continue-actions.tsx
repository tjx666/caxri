import { useState } from 'react';

import type { AgentChatUsageLimit } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { answerAgentChatUsageLimitWait } from './agent-chat-usage-limit-commands';

type AutoContinue = NonNullable<AgentChatUsageLimit['autoContinue']>;

const BUTTON_CLASS = 'min-h-6 gap-1.5 px-2 text-[12px]';

/**
 * Continue now (or Continue, once missed) and Cancel for a Chat that waits for its limit to reset. Renders nothing for
 * a settled state. The weekly usage guard's card offers Cancel alone: while the guard holds, nothing can continue now.
 */
export function AgentChatAutoContinueActions({
    autoContinue,
    canContinueNow = true,
    terminalId,
    turnId,
}: {
    autoContinue: AutoContinue | undefined;
    canContinueNow?: boolean;
    terminalId: string;
    turnId: string;
}) {
    const { t } = useTranslation();
    const [pending, setPending] = useState<'cancel' | 'continueNow'>();
    if (autoContinue?.status !== 'waiting' && autoContinue?.status !== 'missed') return null;
    const run = (action: 'cancel' | 'continueNow') => {
        if (pending) return;
        setPending(action);
        void answerAgentChatUsageLimitWait(terminalId, turnId, action).finally(() =>
            setPending(undefined),
        );
    };
    return (
        <>
            {canContinueNow && (
                <Button
                    aria-disabled={pending !== undefined || undefined}
                    className={BUTTON_CLASS}
                    data-agent-chat-auto-continue-now=""
                    size="sm"
                    variant="secondary"
                    onClick={() => run('continueNow')}
                >
                    {pending === 'continueNow' && (
                        <Spinner className="size-3.5" role="presentation" />
                    )}
                    {t(
                        autoContinue.status === 'waiting'
                            ? 'agentChat.usageLimit.auto.continueNow'
                            : 'agentChat.usageLimit.auto.continue',
                    )}
                </Button>
            )}
            {autoContinue.status === 'waiting' && (
                <Tooltip content={t('agentChat.usageLimit.auto.cancelTooltip')}>
                    <Button
                        aria-disabled={pending !== undefined || undefined}
                        className={BUTTON_CLASS}
                        data-agent-chat-auto-continue-cancel=""
                        size="sm"
                        variant="ghost"
                        onClick={() => run('cancel')}
                    >
                        {pending === 'cancel' && (
                            <Spinner className="size-3.5" role="presentation" />
                        )}
                        {t('agentChat.usageLimit.auto.cancel')}
                    </Button>
                </Tooltip>
            )}
        </>
    );
}
