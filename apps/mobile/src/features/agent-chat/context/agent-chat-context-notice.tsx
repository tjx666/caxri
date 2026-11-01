import { useState } from 'react';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { AgentChatSessionUsageSheet } from '../agent-chat-session-usage-sheet';
import type { AgentChatController } from '../use-agent-chat';
import { useMinuteClock } from '../use-minute-clock';
import {
    agentChatContextNotice,
    dismissAgentChatCacheNotice,
    dismissAgentChatPressureNotice,
} from './agent-chat-context-notice-model';
import { useAgentChatCompact } from './use-agent-chat-compact';

/**
 * Desktop's context and prompt cache reminder above the composer (`agentChatContextNotice`): one banner whose countdown
 * moves on a minute clock. While the context is nearly full and the provider reports a compact command, its button
 * compacts the conversation, as Desktop's Compact does; otherwise it opens the Session usage sheet (the usage ring
 * below still opens it). Dismiss hides the cache line until the next reply restarts the cache, and the nearly full line
 * until the context grows past the size it was dismissed at.
 */
export const AgentChatContextNotice = ({
    canSend,
    chat,
    theme,
}: {
    /**
     * Whether this phone may send to the Chat; a view-only phone keeps the Usage button.
     */
    canSend: boolean;
    /**
     * The Chat whose usage the notice reads and whose `/compact` it runs. The composer mounts the notice only once the
     * Chat has a Terminal.
     */
    chat: Pick<AgentChatController, 'runCommand' | 'snapshot'>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const terminalId = chat.snapshot?.terminalId ?? '';
    const usage = chat.snapshot?.usage;
    const compaction = useAgentChatCompact(chat, canSend);
    const now = useMinuteClock();
    const [isOpen, setOpen] = useState(false);
    // Bumped on dismissal: the dismissal lives outside React state, so the banner re-reads it.
    const [, setDismissals] = useState(0);
    const notice = agentChatContextNotice(usage, now, terminalId, t);
    const compact = notice?.isContextFull ? compaction.compact : undefined;
    const action = compact
        ? {
              actionLabel: t('chat.notice.compact'),
              actionTestID: 'agent-chat-context-notice-compact',
              isBusy: compaction.isBusy,
              onAction: compact,
          }
        : { actionLabel: t('chat.notice.usage'), onAction: () => setOpen(true) };
    const dismissAt = notice?.dismissAt;
    const dismissPressureAt = notice?.dismissPressureAt;
    const dismiss =
        dismissAt === undefined && dismissPressureAt === undefined
            ? {}
            : {
                  onSecondaryAction: () => {
                      if (dismissAt !== undefined)
                          dismissAgentChatCacheNotice(terminalId, dismissAt);
                      if (dismissPressureAt !== undefined)
                          dismissAgentChatPressureNotice(terminalId, dismissPressureAt);
                      setDismissals((count) => count + 1);
                  },
                  secondaryActionLabel: t('chat.notice.dismiss'),
              };
    return (
        <>
            {notice ? (
                <NoticeBanner
                    {...action}
                    {...dismiss}
                    message={notice.lines.join('\n')}
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
