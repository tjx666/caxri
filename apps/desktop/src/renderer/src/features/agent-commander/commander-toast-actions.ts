import { configureToastActions } from '../../stores/toast-actions';
import { terminalToastActionHandlers } from '../terminal/terminal-toast-actions';
import { openWorkbenchSettings } from './commander-commands';

/**
 * Installs the follow-ups a notification in this window can run. The window shows only the Commander Terminal, so it
 * raises its pane's Retry and Refresh, and the Open Settings of the notice that pins it to software rendering, which
 * the Workbench opens because this window has no Settings. The Workbench's other follow-ups open surfaces this window
 * does not have, and they keep the fail-closed answer instead of a button that does nothing.
 */
export function configureCommanderToastActions(): void {
    configureToastActions({
        ...terminalToastActionHandlers,
        'settings.openHardwareAcceleration': { run: openWorkbenchSettings },
    });
}
