import { useState } from 'react';

import type { AgentChatUsage } from '@caxri/protocol';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { AgentChatSessionUsageSheet } from '../agent-chat-session-usage-sheet';
import { useMinuteClock } from '../use-minute-clock';
import {
    agentChatContextNotice,
    dismissAgentChatCacheNotice,
} from './agent-chat-context-notice-model';

/**
 * Desktop's context and prompt cache reminder above the composer (`agentChatContextNotice`): one banner whose countdown
 * moves on a minute clock. While the context is nearly full and the provider reports a compact command, its button
 * compacts the conversation, as Desktop's Compact does; otherwise it opens the Session usage sheet (the usage ring
 * below still opens it). Dismiss hides the cache line until the next reply restarts the cache, while a nearly full
 * context stays.
 */
export const AgentChatContextNotice = ({
    isCompactBusy,
    onCompact,
    terminalId,
    theme,
    usage,
}: {
    /**
     * True while the compact command is on its way to Server Core.
     */
    isCompactBusy: boolean;
    /**
     * Runs the provider's compact command; omitted when the provider reports none or the phone cannot send.
     */
    onCompact: (() => void) | undefined;
    terminalId: string;
    theme: MobileTheme;
    usage: AgentChatUsage | undefined;
}) => {
    const { t } = useTranslation();
    const now = useMinuteClock();
    const [isOpen, setOpen] = useState(false);
    // Bumped on dismissal: the dismissal lives outside React state, so the banner re-reads it.
    const [, setDismissals] = useState(0);
    const notice = agentChatContextNotice(usage, now, terminalId, t);
    const { dismissAt } = notice ?? {};
    const compact = notice?.isContextFull ? onCompact : undefined;
    return (
        <>
            {notice ? (
                <NoticeBanner
                    actionLabel={t(compact ? 'chat.notice.compact' : 'chat.notice.usage')}
                    actionTestID={compact ? 'agent-chat-context-notice-compact' : undefined}
                    isBusy={compact ? isCompactBusy : undefined}
                    message={notice.lines.join('\n')}
                    onAction={compact ?? (() => setOpen(true))}
                    onSecondaryAction={
                        dismissAt === undefined
                            ? undefined
                            : () => {
                                  dismissAgentChatCacheNotice(terminalId, dismissAt);
                                  setDismissals((count) => count + 1);
                              }
                    }
                    secondaryActionLabel={
                        dismissAt === undefined ? undefined : t('chat.notice.dismiss')
                    }
                    testID="agent-chat-context-notice"
                    theme={theme}
                    tone={notice.tone}
                />
            ) : null}
            {isOpen ? (
                <AgentChatSessionUsageSheet
                    onClose={() => setOpen(false)}
                    terminalId={terminalId}
                    theme={theme}
                    usage={usage}
                />
            ) : null}
        </>
    );
};
