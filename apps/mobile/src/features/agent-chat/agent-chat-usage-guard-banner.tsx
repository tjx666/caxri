import type { AgentChatUsageGuard } from '@caxri/protocol';

import { NoticeBanner } from '../../components/notice-banner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatUsageGuardBanner } from './agent-chat-model';
import { agentChatAutoContinueLabel } from './agent-chat-usage-limit';
import { useMinuteClock } from './use-minute-clock';

/**
 * The weekly usage guard's banner (`agentChatUsageGuardBanner`), whose time to the reset moves on a minute clock while
 * it shows.
 */
export const AgentChatUsageGuardBanner = ({
    guard,
    provider,
    theme,
}: {
    guard: AgentChatUsageGuard;
    provider: string;
    theme: MobileTheme;
}) => {
    const { locale, t } = useTranslation();
    const now = useMinuteClock();
    return (
        <NoticeBanner
            message={[
                agentChatUsageGuardBanner(guard, provider, now, t),
                guard.autoContinue &&
                    agentChatAutoContinueLabel(guard.autoContinue, now, locale, t),
            ]
                .filter(Boolean)
                .join('\n')}
            testID="agent-chat-usage-guard"
            theme={theme}
            tone="warning"
        />
    );
};
