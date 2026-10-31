import { useState } from 'react';

import { ConfirmSheet } from '../../components/confirm-sheet';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { SettingsRow } from '../settings/settings-rows';
import type { DesktopUpdateAction, DesktopUpdateView } from './desktop-update-model';
import { desktopUpdateConfirmDetail } from './desktop-update-model';
import type { useDesktopUpdate } from './use-desktop-update';

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
    const { check, download, install, result } = desktopUpdate;
    const [isConfirming, setIsConfirming] = useState(false);
    const [isRequesting, setIsRequesting] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const ready =
        result?.desktop === 'online' && result.state.status === 'ready'
            ? { impact: result.impact, version: result.state.version }
            : null;
    const run = async (operation: () => Promise<void>) => {
        setFailure(null);
        setIsRequesting(true);
        try {
            await operation();
        } catch {
            setFailure(t('update.unreachable'));
        } finally {
            setIsRequesting(false);
        }
    };
    const act = (action: DesktopUpdateAction | null) => {
        if (action === 'confirm-install') setIsConfirming(true);
        else if (action) void run(action === 'check' ? check : download);
    };
    const update = view.update;
    const versionFailure = !update ? failure : null;
    return (
        <>
            <SettingsRow
                accessibilityHint={view.version.canCheck ? t('desktopUpdate.checkHint') : undefined}
                isLast={!update}
                label={t('desktopUpdate.label')}
                onPress={!isRequesting && view.version.canCheck ? () => act('check') : undefined}
                testID="settings-desktop-version"
                theme={theme}
                value={versionFailure ?? view.version.value}
                valueColor={versionFailure || view.version.isFailure ? theme.danger : undefined}
            />
            {update ? (
                <SettingsRow
                    accessibilityHint={update.action ? t('desktopUpdate.updateHint') : undefined}
                    detail={failure ?? update.detail}
                    detailColor={failure || update.isFailure ? theme.danger : undefined}
                    isLast
                    label={update.label}
                    onPress={!isRequesting && update.action ? () => act(update.action) : undefined}
                    testID="settings-desktop-update"
                    theme={theme}
                    value=""
                />
            ) : null}
            {isConfirming && ready ? (
                <ConfirmSheet
                    confirmLabel={t('desktopUpdate.confirm.action')}
                    detail={desktopUpdateConfirmDetail(
                        ready.version,
                        ready.impact,
                        workingSessionTitles,
                        t,
                    )}
                    onClose={() => setIsConfirming(false)}
                    onConfirm={() => run(() => install(ready.version))}
                    testID="desktop-update-confirm-sheet"
                    theme={theme}
                    title={t('desktopUpdate.confirm.title')}
                    tone="primary"
                />
            ) : null}
        </>
    );
};
