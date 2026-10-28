import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { MobileUpdateBannerKind, MobileUpdateNoticeView } from './mobile-update-state';
import { mobileUpdateBannerKind, mobileUpdateNoticeView } from './mobile-update-state';
import { useMobileUpdate } from './use-mobile-update';

export interface MobileUpdateNotice extends MobileUpdateNoticeView {
    dismiss: () => void;
    dismissLabel: string;
    kind: MobileUpdateBannerKind;
    /**
     * Runs the notice's action (install, or ask Desktop again); a no-op while `action` is `null`.
     */
    run: () => void;
}

/**
 * The update the paired Desktop offers, as data for Session home's single notice slot. While connected it stays out of
 * the way: dismissible for the app session, and Settings keeps the same action after `Later`. While a newer Desktop
 * refuses this app's version, it is the way back and cannot be dismissed; without a build to offer it only explains the
 * mismatch.
 */
export const useMobileUpdateNotice = (): MobileUpdateNotice | null => {
    const { status } = useMobileClient();
    const { t } = useTranslation();
    const {
        canRetryCheck,
        dismiss,
        install,
        isChecking,
        isDismissed,
        isRecovering,
        phase,
        retryCheck,
        update,
    } = useMobileUpdate();
    const kind = mobileUpdateBannerKind({
        canRetryCheck,
        isChecking,
        isDismissed,
        isRecovering,
        phase,
        status,
        update,
    });
    if (!kind) return null;
    const view = mobileUpdateNoticeView(kind, phase, update, t);
    return {
        ...view,
        dismiss,
        dismissLabel: t('update.later'),
        kind,
        run: view.action === 'retry-check' ? retryCheck : install,
    };
};
