import type { AgentChatUsageGuard } from '@caxri/protocol';

import { NoticeBanner } from '../../components/notice-banner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatUsageGuardBanner } from './agent-chat-model';
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
    const { t } = useTranslation();
    const now = useMinuteClock();
    return (
        <NoticeBanner
            message={agentChatUsageGuardBanner(guard, provider, now, t)}
            testID="agent-chat-usage-guard"
            theme={theme}
            tone="warning"
        />
    );
};
