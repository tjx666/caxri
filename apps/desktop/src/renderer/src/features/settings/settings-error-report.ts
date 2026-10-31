import { translate } from '../../i18n';
import { describeFailure, isCancelledRequest, pushToast } from '../../stores/toasts';

/**
 * Main answers every queued Renderer request with `CANCELLED` once quit starts, so a debounced write or reload still in
 * flight at quit must not raise a notification over a window that is already going away (same rule as `tryCommand`).
 */
export function reportSettingsError(error: unknown, label: string): void {
    if (isCancelledRequest(error)) return;
    pushToast('error', describeFailure(error, label, translate));
}
