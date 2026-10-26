import { useEffect, useState } from 'react';

import type { AgentChatUsageGuard } from '@caxri/protocol';

import { NoticeBanner } from '../../components/notice-banner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatUsageGuardBanner } from './agent-chat-model';

const TICK_MS = 60_000;

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
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(timer);
    }, []);
    return (
        <NoticeBanner
            message={agentChatUsageGuardBanner(guard, provider, now, t)}
            testID="agent-chat-usage-guard"
            theme={theme}
            tone="warning"
        />
    );
};
