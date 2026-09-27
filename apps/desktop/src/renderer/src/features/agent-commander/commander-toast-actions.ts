import { configureToastActions } from '../../stores/toast-actions';
import { terminalToastActionHandlers } from '../terminal/terminal-toast-actions';

/**
 * Installs the follow-ups a notification in this window can run. The window shows only the Commander Terminal, so its
 * pane's Retry and Refresh are all it raises; the Workbench's other follow-ups open surfaces this window does not have,
 * and they keep the fail-closed answer instead of a button that does nothing.
 */
export function configureCommanderToastActions(): void {
    configureToastActions(terminalToastActionHandlers);
}
