import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Opens the Process Explorer window, or focuses it when it is already open. Shared by the command palette and the
 * resource alert's "View details" follow-up.
 */
export function openProcessExplorer(): void {
    // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
    void tryCommand(translate('processExplorer.openFailed'), () =>
        caxri.request('processExplorer.open'),
    );
}
