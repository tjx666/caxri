import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';

/**
 * A Panels read that has no data yet is either in flight or held back because the phone is offline or backgrounded.
 * TanStack reports the second as a pending query with an idle fetch, which would otherwise spin forever. The spinner
 * waits `LOADING_REVEAL_DELAY_MS`, so a folder or tree item that answers at once swaps straight to its entries.
 */
export const PendingPanelState = ({
    fetchStatus,
    theme,
}: {
    fetchStatus: 'fetching' | 'idle' | 'paused';
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return fetchStatus === 'fetching' ? (
        <ScreenState
            kind="loading"
            testID="panels-loading"
            theme={theme}
            title={t('panels.loading')}
        />
    ) : (
        <ScreenState
            kind="offline"
            testID="panels-offline"
            theme={theme}
            title={t('panels.offline')}
        />
    );
};
