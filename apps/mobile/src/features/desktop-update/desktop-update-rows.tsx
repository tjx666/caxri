import { ConfirmSheet } from '../../components/confirm-sheet';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { SettingsRow } from '../settings/settings-rows';
import type { DesktopUpdateView } from './desktop-update-model';
import { desktopUpdateConfirmDetail } from './desktop-update-model';
import type { useDesktopUpdate } from './use-desktop-update';
import { useDesktopUpdateRequest } from './use-desktop-update-request';

/**
 * The Computer section's `Caxri` row and, when a newer version exists, the row that updates the computer. The restart
 * is confirmed here on the phone, naming what it stops, because nobody may be at the computer to answer a prompt.
 */
export const DesktopUpdateRows = ({
    desktopUpdate,
    theme,
    view,
    workingSessionTitles,
}: {
    desktopUpdate: ReturnType<typeof useDesktopUpdate>;
    theme: MobileTheme;
    view: DesktopUpdateView;
    workingSessionTitles: readonly string[];
}) => {
    const { t } = useTranslation();
    const { closeConfirm, confirm, failure, installConfirmed, pressFor } =
        useDesktopUpdateRequest(desktopUpdate);
    const { update, version } = view;
    const versionFailure = update ? null : failure;
    const versionCheck = pressFor(version.canCheck ? 'check' : null);
    return (
        <>
            <SettingsRow
                accessibilityHint={version.canCheck ? t('desktopUpdate.checkHint') : undefined}
                isLast={!update}
                label={t('desktopUpdate.label')}
                onPress={versionCheck}
                testID="settings-desktop-version"
                theme={theme}
                value={versionFailure ?? version.value}
                valueColor={versionFailure || version.isFailure ? theme.danger : undefined}
            />
            {update ? (
                <SettingsRow
                    accessibilityHint={update.action ? t('desktopUpdate.updateHint') : undefined}
                    detail={failure ?? update.detail}
                    detailColor={failure || update.isFailure ? theme.danger : undefined}
                    isLast
                    label={update.label}
                    onPress={pressFor(update.action)}
                    testID="settings-desktop-update"
                    theme={theme}
                    value=""
                />
            ) : null}
            {confirm ? (
                <ConfirmSheet
                    confirmLabel={t('desktopUpdate.confirm.action')}
                    detail={desktopUpdateConfirmDetail(
                        confirm.version,
                        confirm.impact,
                        workingSessionTitles,
                        t,
                    )}
                    onClose={closeConfirm}
                    onConfirm={() => installConfirmed(confirm.version)}
                    testID="desktop-update-confirm-sheet"
                    theme={theme}
                    title={t('desktopUpdate.confirm.title')}
                    tone="primary"
                />
            ) : null}
        </>
    );
};
