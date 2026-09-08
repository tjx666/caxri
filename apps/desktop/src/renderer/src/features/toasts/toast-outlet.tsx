import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { Toaster } from 'sonner';

/**
 * Sonner owns notification timing, stacking, keyboard access, and interaction pauses. The shared stylesheet maps its
 * presentation to Caxri tokens without creating another queue or animation lifecycle.
 */
export function ToastOutlet() {
    return (
        <Toaster
            className="caxri-toaster"
            position="bottom-right"
            offset={{ bottom: 40, right: 16, left: 16 }}
            mobileOffset={{ bottom: 40, right: 16, left: 16 }}
            visibleToasts={3}
            gap={8}
            closeButton
            icons={{
                info: <Info size={16} />,
                success: <CircleCheck size={16} />,
                error: <CircleX size={16} />,
                close: <X size={14} />,
            }}
            toastOptions={{ className: 'toast', closeButtonAriaLabel: 'Dismiss notification' }}
        />
    );
}
