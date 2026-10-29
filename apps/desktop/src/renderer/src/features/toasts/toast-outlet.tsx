import { useEffect } from 'react';

import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { Toaster } from 'sonner';

import { useTranslation } from '../../i18n';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useDialogStore } from '../../stores/dialogs';
import { configureReminderPresentation } from '../../stores/toasts';
import { NotificationOptions } from './notification-options';

/**
 * Consult the live registry for both blur and list cleanup. Base UI modals do not expose `aria-modal`, and keeping
 * Sonner's remembered element would let a later cleanup steal focus after the opening transition.
 */
function shouldRestoreToastFocus(): boolean {
    return !useDialogStore.getState().isModalOpen();
}

const OFFSET = { bottom: 40, right: 16, left: 16 };

/**
 * Zen Mode centers the composer at the bottom of the window, right where a bottom-right toast would sit on top of its
 * send button. Toasts move to the top right instead, below the 36px drag band that holds the exit button.
 */
const ZEN_OFFSET = { top: 44, right: 16, left: 16 };

/**
 * Sonner owns notification timing, stacking, keyboard access, and interaction pauses. The shared stylesheet maps its
 * presentation to Caxri tokens without creating another queue or animation lifecycle.
 */
export function ToastOutlet() {
    const { t } = useTranslation();
    const isZenMode = useChromeLayoutStore((state) => state.zenMode);
    useEffect(
        () =>
            configureReminderPresentation((properties) => <NotificationOptions {...properties} />),
        [],
    );
    return (
        <Toaster
            className="caxri-toaster"
            shouldRestoreFocus={shouldRestoreToastFocus}
            position={isZenMode ? 'top-right' : 'bottom-right'}
            offset={isZenMode ? ZEN_OFFSET : OFFSET}
            mobileOffset={isZenMode ? ZEN_OFFSET : OFFSET}
            visibleToasts={3}
            gap={8}
            closeButton
            icons={{
                info: <Info size={16} />,
                success: <CircleCheck size={16} />,
                warning: <TriangleAlert size={16} />,
                error: <CircleX size={16} />,
                close: <X size={14} />,
            }}
            containerAriaLabel={t('toasts.outlet.label')}
            toastOptions={{ className: 'toast', closeButtonAriaLabel: t('toasts.outlet.dismiss') }}
        />
    );
}
