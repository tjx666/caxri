import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { SettingsRow } from '../settings/settings-rows';
import { useTermuxSetting } from './use-termux-setting';

/**
 * "Termux commands" under THIS DEVICE: whether `caxri device exec` may run commands on this phone. Off by default;
 * Rendered only where `isTermuxSupported`, as the section's last row.
 */
export const TermuxSettingRow = ({ theme }: { theme: MobileTheme }) => {
    const { t } = useTranslation();
    const { isDenied, state, toggle } = useTermuxSetting();
    if (state === 'unsupported') return null;
    const view = {
        missing: {
            value: t('settings.termux.missing'),
            detail: t('settings.termux.missingDetail'),
        },
        off: {
            value: t('settings.termux.off'),
            detail: t(isDenied ? 'settings.termux.permissionDenied' : 'settings.termux.offDetail'),
        },
        on: { value: t('settings.termux.on'), detail: t('settings.termux.onDetail') },
    }[state];
    return (
        <SettingsRow
            accessibilityHint={state === 'missing' ? undefined : t('settings.termux.hint')}
            detail={view.detail}
            detailColor={state === 'off' && isDenied ? theme.danger : undefined}
            isLast
            label={t('settings.termux')}
            onPress={state === 'missing' ? undefined : toggle}
            testID="settings-termux-commands"
            theme={theme}
            value={view.value}
            valueColor={state === 'on' ? theme.success : undefined}
        />
    );
};
