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
 * moves on a minute clock. Its Usage button opens the Session usage sheet; Dismiss hides the cache line until the next
 * reply restarts the cache, while a nearly full context stays.
 */
export const AgentChatContextNotice = ({
    terminalId,
    theme,
    usage,
}: {
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
    return (
        <>
            {notice ? (
                <NoticeBanner
                    actionLabel={t('chat.notice.usage')}
                    message={notice.lines.join('\n')}
                    onAction={() => setOpen(true)}
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
