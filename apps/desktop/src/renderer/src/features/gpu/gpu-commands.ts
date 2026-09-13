import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Relaunches the app with GPU acceleration disabled. Fire-and-forget by the Toast contract: the recovery toast's action
 * is synchronous, and the shared command funnel turns a failed Desktop restart request into one actionable toast.
 */
export function restartInGpuSafeMode(): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Unable to restart in GPU Safe Mode', () =>
        caxri.request('gpu.restartInSafeMode'),
    );
}
