import { caxri } from '../../lib/caxri';
import { openSettings } from '../../stores/dialogs';
import { pushToast, tryCommand } from '../../stores/toasts';

const GPU_RECOVERY_MESSAGE =
    'GPU rendering failed. Caxri switched the Terminal to software rendering.';
const GPU_SAFE_MODE_MESSAGE = 'Caxri disabled hardware acceleration after repeated GPU crashes.';

export function showGpuRecoveryToast(): void {
    pushToast('info', GPU_RECOVERY_MESSAGE, {
        persist: true,
        action: {
            label: 'Restart in GPU Safe Mode',
            onSelect: () => {
                // The shared command funnel turns a failed Desktop restart request into one actionable toast.
                // eslint-disable-next-line no-void -- the action is synchronous by the Toast contract
                void tryCommand('Unable to restart in GPU Safe Mode', () =>
                    caxri.request('gpu.restartInSafeMode'),
                );
            },
        },
    });
}

export function showAutomaticGpuSafeModeToast(): void {
    pushToast('info', GPU_SAFE_MODE_MESSAGE, {
        persist: true,
        action: {
            label: 'Open Settings',
            onSelect: () => openSettings('hardware-acceleration'),
        },
    });
}
