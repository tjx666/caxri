import { useState } from 'react';

import type { AgentChatUsage } from '@caxri/protocol';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { AgentChatSessionUsageSheet } from '../agent-chat-session-usage-sheet';
import type { AgentChatController } from '../use-agent-chat';
import { useMinuteClock } from '../use-minute-clock';
import {
    agentChatContextNotice,
    dismissAgentChatCacheNotice,
} from './agent-chat-context-notice-model';
import { useAgentChatCompact } from './use-agent-chat-compact';

/**
 * Desktop's context and prompt cache reminder above the composer (`agentChatContextNotice`): one banner whose countdown
 * moves on a minute clock. While the context is nearly full and the provider reports a compact command, its button
 * compacts the conversation, as Desktop's Compact does; otherwise it opens the Session usage sheet (the usage ring
 * below still opens it). Dismiss hides the cache line until the next reply restarts the cache, while a nearly full
 * context stays.
 */
export const AgentChatContextNotice = ({
    canSend,
    chat,
    terminalId,
    theme,
    usage,
}: {
    /**
     * Whether this phone may send to the Chat; a view-only phone keeps the Usage button.
     */
    canSend: boolean;
    chat: Pick<AgentChatController, 'runCommand' | 'snapshot'>;
    terminalId: string;
    theme: MobileTheme;
    usage: AgentChatUsage | undefined;
}) => {
    const { t } = useTranslation();
    const compaction = useAgentChatCompact(chat, canSend);
    const now = useMinuteClock();
    const [isOpen, setOpen] = useState(false);
    // Bumped on dismissal: the dismissal lives outside React state, so the banner re-reads it.
    const [, setDismissals] = useState(0);
    const notice = agentChatContextNotice(usage, now, terminalId, t);
    const { dismissAt } = notice ?? {};
    const compact = notice?.isContextFull ? compaction.compact : undefined;
    return (
        <>
            {notice ? (
                <NoticeBanner
                    actionLabel={t(compact ? 'chat.notice.compact' : 'chat.notice.usage')}
                    actionTestID={compact ? 'agent-chat-context-notice-compact' : undefined}
                    isBusy={compact ? compaction.isBusy : undefined}
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
