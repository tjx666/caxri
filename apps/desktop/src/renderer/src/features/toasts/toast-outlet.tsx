import { useEffect } from 'react';

import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { Toaster } from 'sonner';

import { useTranslation } from '../../i18n';
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

/**
 * Sonner owns notification timing, stacking, keyboard access, and interaction pauses. The shared stylesheet maps its
 * presentation to Caxri tokens without creating another queue or animation lifecycle.
 */
export function ToastOutlet() {
    const { t } = useTranslation();
    useEffect(
        () =>
            configureReminderPresentation((properties) => <NotificationOptions {...properties} />),
        [],
    );
    return (
        <Toaster
            className="caxri-toaster"
            shouldRestoreFocus={shouldRestoreToastFocus}
            position="bottom-right"
            offset={{ bottom: 40, right: 16, left: 16 }}
            mobileOffset={{ bottom: 40, right: 16, left: 16 }}
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
