import { useState } from 'react';

import { useTranslation } from '../../i18n';
import type { DesktopUpdateAction } from './desktop-update-model';
import type { useDesktopUpdate } from './use-desktop-update';

/**
 * One phone request to the computer's update at a time, with the failure to show when the computer did not answer.
 * `confirm-install` only opens the confirmation; the install itself runs from it.
 */
export const useDesktopUpdateRequest = (desktopUpdate: ReturnType<typeof useDesktopUpdate>) => {
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
    /**
     * The press handler for a row, or `undefined` while a request is in flight or the row has nothing to do.
     */
    const pressFor = (action: DesktopUpdateAction | null) => {
        if (isRequesting || !action) return;
        if (action === 'confirm-install') return () => setIsConfirming(true);
        return () => run(action === 'check' ? check : download);
    };
    return {
        closeConfirm: () => setIsConfirming(false),
        confirm: ready && isConfirming ? ready : null,
        failure,
        installConfirmed: (version: string) => run(() => install(version)),
        pressFor,
    };
};
