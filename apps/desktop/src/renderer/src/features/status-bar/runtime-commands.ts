import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Relaunches the whole app through Main, which still answers when Server Core has stopped (the "Caxri stopped" chip).
 */
export function relaunchCaxri(): void {
    void tryCommand(translate('statusBar.runtime.relaunchFailed'), () =>
        caxri.request('app.relaunch'),
    );
}
